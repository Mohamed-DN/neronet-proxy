package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/bridge"
	"github.com/sovereign/proxy/v4/pkg/config"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/posture"
)

const ClientVersion = "v4.0.0"

func main() {
	_ = config.LoadDotEnv()

	socksAddr := config.BindStringFlag(flag.CommandLine, "socks-addr", "SOVEREIGN_SOCKS5_LISTEN_ADDR", "127.0.0.1:1080", "Local SOCKS5 proxy inbound listen address")
	httpAddr := config.BindStringFlag(flag.CommandLine, "http-addr", "SOVEREIGN_HTTP_LISTEN_ADDR", "127.0.0.1:8080", "Local HTTP CONNECT proxy inbound listen address")
	controlURL := config.BindStringFlag(flag.CommandLine, "control-url", "SOVEREIGN_CONTROL_PLANE_URL", "http://127.0.0.1:8443", "SovereignMesh Control Plane URL")
	enableExit := config.BindBoolFlag(flag.CommandLine, "enable-exit", "SOVEREIGN_ENABLE_EXIT_BRIDGE", false, "Enable sandboxed egress exit node bridge")
	countryCode := config.BindStringFlag(flag.CommandLine, "country", "SOVEREIGN_COUNTRY_CODE", "US", "Self-declared ISO country code for bridge registration (not measured)")
	declaredLocationOf := bindLocationFlags(flag.CommandLine)
	identityPath := config.BindStringFlag(flag.CommandLine, "identity", "SOVEREIGN_NODE_KEY_PATH", "/var/lib/neronet/node_identity.key", "Path to this node's persistent identity key")
	maxBandwidthKbps := config.BindIntFlag(flag.CommandLine, "max-bandwidth-kbps", "SOVEREIGN_MAX_BANDWIDTH_KBPS", 0, "Self-declared uplink capacity in kbps; 0 means not declared")
	dataplaneMode := config.BindStringFlag(flag.CommandLine, "dataplane", "SOVEREIGN_DATAPLANE", "off", "WireGuard data plane mode: off, netstack or tun")
	spikePeers := config.BindStringFlag(flag.CommandLine, "spike-peers", "SOVEREIGN_SPIKE_PEERS", "", "Path to the WP-201 spike peers document")
	overlayEchoPort := config.BindIntFlag(flag.CommandLine, "overlay-echo-port", "SOVEREIGN_OVERLAY_ECHO_PORT", 0, "TCP port answering on this node's overlay address; 0 disables it")
	stunServer := config.BindStringFlag(flag.CommandLine, "stun-server", "SOVEREIGN_STUN_SERVER", "", "STUN server (host:port) asked for this node's reflexive address; empty disables it")
	metricsAddr := config.BindStringFlag(flag.CommandLine, "metrics-addr", "SOVEREIGN_METRICS_LISTEN_ADDR", "", "HTTP metrics listen address (e.g. 127.0.0.1:9090); empty disables metrics")
	flag.Parse()

	log.Printf("[SOVEREIGN-NODE] Initializing SovereignMesh client daemon (%s)...", ClientVersion)

	location, err := declaredLocationOf()
	if err != nil {
		log.Fatalf("Invalid declared location: %v", err)
	}

	// Load, or create once, this node's identity keypair.
	keypair, err := loadOrCreateIdentity(*identityPath)
	if err != nil {
		log.Fatalf("Failed to establish node identity: %v", err)
	}

	nodeID := control.GenerateNodeID(keypair.PublicKey)
	log.Printf("[SOVEREIGN-NODE] Node ID: %s", nodeID)

	// Initialize Netstack ACL Filter
	netfilter := acl.NewNetstackFilter()

	// Initialize Sandbox & Netstack Bridge
	policy := bridge.NewSandboxPolicyEngine(bridge.SandboxPolicyConfig{
		AllowLAN: false, // Strict RFC 1918 suppression
	})
	doh := bridge.NewDoHResolver(nil)
	guardian := bridge.NewGuardian(0)

	netstackBridge := bridge.NewNetstackBridge(policy, doh, guardian)

	// Start Inbound SOCKS5 Proxy
	socksSrv := bridge.NewSOCKS5Server(*socksAddr, netstackBridge)
	if err := socksSrv.Start(); err != nil {
		log.Fatalf("Failed to start SOCKS5 proxy on %s: %v", *socksAddr, err)
	}
	log.Printf("[SOVEREIGN-NODE] SOCKS5 Inbound ready on %s", *socksAddr)

	// Start Inbound HTTP CONNECT Proxy
	httpSrv := bridge.NewHTTPProxyServer(*httpAddr, netstackBridge)
	if err := httpSrv.Start(); err != nil {
		log.Fatalf("Failed to start HTTP proxy on %s: %v", *httpAddr, err)
	}
	log.Printf("[SOVEREIGN-NODE] HTTP CONNECT Inbound ready on %s", *httpAddr)

	// Start Prometheus Metrics Exporter (if configured)
	metricsSrv, err := startMetricsServer(*metricsAddr)
	if err != nil {
		log.Printf("[SOVEREIGN-NODE] Warning: Failed to start metrics server on %s: %v", *metricsAddr, err)
	}
	if metricsSrv != nil {
		defer metricsSrv.Close()
	}

	// Register with Control Plane
	ctrlClient := control.NewClient(*controlURL)
	ctrlClient.SetAuthToken(os.Getenv("SOVEREIGN_REGISTRATION_TOKEN"))
	role := "CLIENT_ORIGIN"
	if *enableExit {
		role = "EXIT_BRIDGE"
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// The heartbeat loop starts as soon as registration succeeds; the data plane comes
	// up after it, because it needs the overlay addresses registration returned. This
	// is where the loop finds the netmap manager once it exists.
	netmaps := &netmapHolder{}

	log.Printf("[SOVEREIGN-NODE] Country %s is self-declared by the operator, not measured", *countryCode)

	// The identifier the data plane starts with. Empty when registration failed, in
	// which case the node runs on its stored netmap or at default deny.
	dataplaneNodeID := ""

	regResp, err := registerWithRetry(ctx, ctrlClient, keypair.PublicKey, role, withLocation(capability(*enableExit, *countryCode, *maxBandwidthKbps), location))

	if err != nil {
		log.Printf("[SOVEREIGN-NODE] Warning: Initial control plane registration failed: %v (operating in local standalone mode)", err)
	} else {
		// Adopt the identifier the control plane assigned. Keeping the locally derived
		// one meant heartbeats were addressed to a node id the control plane had never
		// stored, so every update matched zero rows while still returning success.
		if regResp.AssignedNodeID != "" && regResp.AssignedNodeID != nodeID {
			log.Printf("[SOVEREIGN-NODE] Control plane assigned node ID %s (local was %s)", regResp.AssignedNodeID, nodeID)
			nodeID = regResp.AssignedNodeID
		}

		if regResp.OverlayIPv4 == "" {
			// A registration that returns no overlay address has not enrolled this node
			// into the mesh, whatever the HTTP status said. Failing loudly here is the
			// difference between a broken deployment and a silently useless one.
			log.Printf("[SOVEREIGN-NODE] ERROR: control plane accepted registration but assigned no overlay VIP; node cannot join the mesh")
		} else {
			log.Printf("[SOVEREIGN-NODE] Registered with control plane as %s. Assigned Overlay VIP: %s / %s", nodeID, regResp.OverlayIPv4, regResp.OverlayIPv6)
		}

		// Initial ACL and Route Sync
		policy, _, syncErr := ctrlClient.SyncACLs(ctx, nodeID, 0)
		if syncErr == nil && policy != nil {
			netfilter.UpdatePolicy(policy)
			log.Printf("[SOVEREIGN-NODE] Zero Trust ACL policy loaded (epoch: %d, outbound rules: %d)", policy.Epoch, len(policy.OutboundRules))
		}

		routesList, routeEpoch, routeErr := ctrlClient.SyncRoutes(ctx, nodeID, 0)
		if routeErr == nil {
			log.Printf("[SOVEREIGN-NODE] Subnet routes synced (epoch: %d, count: %d)", routeEpoch, len(routesList))
		}

		// Snapshot for the data plane's first fetch. The loop below may re-enrol and
		// reassign nodeID, and reading a variable another goroutine writes is a race
		// whatever the value turns out to be; the loop passes its own current id to
		// every later netmap fetch.
		dataplaneNodeID = nodeID

		// Start periodic heartbeat and continuous posture attestation loop
		go func() {
			ticker := time.NewTicker(15 * time.Second)
			defer ticker.Stop()

			isRootless := os.Geteuid() != 0
			var policyEpoch uint64 = regResp.PolicyEpoch
			var routeEpoch uint64 = regResp.RouteEpoch

			// Keys this node must stop talking to. Kept so a repeated delivery does
			// not trigger a re-sync on every heartbeat.
			revokedPeers := make(map[string]bool)

			for {
				select {
				case <-ticker.C:
					att := buildAttestation(nodeID, *countryCode, isRootless, time.Now().UTC())

					// Report measured memory rather than a constant. The previous call
					// passed cpu=5, mem=32, battery=100 on every beat for every node, so
					// the console's resource graphs were drawing the same invented
					// numbers regardless of what the machine was doing.
					var memStats runtime.MemStats
					runtime.ReadMemStats(&memStats)
					memoryMB := uint32(memStats.Sys / (1024 * 1024))

					// CPU and battery are not measured yet. Zero says "unknown"; a
					// plausible-looking constant would not.
					const cpuPctUnmeasured = 0
					const batteryPctUnmeasured = 0

					hbStart := time.Now()
					hbCtx, hbCancel := context.WithTimeout(ctx, 5*time.Second)
					hbResp, hbErr := ctrlClient.SendHeartbeatWithPosture(
						hbCtx, nodeID, netmaps.endpoints(), 0, cpuPctUnmeasured, memoryMB, batteryPctUnmeasured, false, att,
					)
					hbCancel()
					globalNodeMetrics.RecordHeartbeat(time.Since(hbStart), hbErr == nil, hbResp != nil && hbResp.IsQuarantined)

					if hbErr != nil {
						// The control plane has no row for this node: its database was
						// rebuilt, restored from a backup predating this enrolment, or
						// wiped. The identity on disk is still valid, so enrol again
						// rather than beating into the void until someone restarts the
						// process by hand.
						if errors.Is(hbErr, control.ErrNodeUnknown) {
							newID, reErr := reregister(ctx, ctrlClient, keypair.PublicKey, role, withLocation(capability(*enableExit, *countryCode, *maxBandwidthKbps), location))
							if reErr != nil {
								log.Printf("[SOVEREIGN-NODE] Re-enrolment failed: %v", reErr)
								continue
							}

							log.Printf("[SOVEREIGN-NODE] Re-enrolled after the control plane lost this node: %s -> %s", nodeID, newID)
							nodeID = newID

							// The epochs belonged to the registration that no longer
							// exists. Resetting them makes the next sync a full one.
							policyEpoch = 0
							routeEpoch = 0
							continue
						}

						log.Printf("[SOVEREIGN-NODE] Heartbeat failed: %v", hbErr)
						continue
					}

					if !hbResp.Acknowledged {
						log.Printf("[SOVEREIGN-NODE] WARNING: control plane did not acknowledge heartbeat for %s", nodeID)
					}

					// Revoked keys. The control plane has always carried this field and
					// nothing read it, so a revocation reached the database and the
					// console and never the data plane: the tunnel stayed up and the
					// withdrawn device stayed reachable.
					//
					// Applying the same revocation twice is harmless, which is why the
					// control plane sends a window rather than a per-node cursor.
					if len(hbResp.RevokedKeys) > 0 {
						newlyRevoked := 0
						for _, key := range hbResp.RevokedKeys {
							if !revokedPeers[key] {
								revokedPeers[key] = true
								newlyRevoked++
								log.Printf("[SOVEREIGN-NODE] Peer key revoked: %.16s...", key)
							}
						}

						if newlyRevoked > 0 {
							// Force a policy and route re-sync. The control plane already
							// excludes revoked peers when it compiles, so pulling fresh
							// state is what actually removes them here -- and it reuses a
							// path that is already tested rather than mutating the active
							// policy in place.
							log.Printf("[SOVEREIGN-NODE] %d peer key(s) revoked, re-syncing policy and routes", newlyRevoked)
							policyEpoch = 0
							routeEpoch = 0
						}
					}

					if hbResp.IsQuarantined {
						log.Printf("[SOVEREIGN-NODE] ⚠️ WARNING: Node is QUARANTINED by control plane! Reason: %s", hbResp.QuarantineReason)
					}

					// Update ACLs if epoch advanced
					if hbResp.PolicyEpoch > policyEpoch {
						syncCtx, syncCancel := context.WithTimeout(ctx, 5*time.Second)
						newPol, newEp, syncErr := ctrlClient.SyncACLs(syncCtx, nodeID, policyEpoch)
						syncCancel()
						if syncErr == nil && newPol != nil {
							netfilter.UpdatePolicy(newPol)
							policyEpoch = newEp
							globalNodeMetrics.UpdateEpochs(policyEpoch, routeEpoch)
							log.Printf("[SOVEREIGN-NODE] Updated ACL policy to epoch %d", policyEpoch)
						}
					}

					// The data plane's own update path: revocations reach the device at
					// once, and a newer netmap version is fetched and applied whole.
					// The two epoch syncs below stay for a node running without a data
					// plane, which sees no netmap version at all.
					netmaps.onHeartbeat(ctx, nodeID, hbResp)

					// Update routes if epoch advanced
					if hbResp.RouteEpoch > routeEpoch {
						rCtx, rCancel := context.WithTimeout(ctx, 5*time.Second)
						newRoutes, newEp, rErr := ctrlClient.SyncRoutes(rCtx, nodeID, routeEpoch)
						rCancel()
						if rErr == nil {
							routeEpoch = newEp
							globalNodeMetrics.UpdateEpochs(policyEpoch, routeEpoch)
							log.Printf("[SOVEREIGN-NODE] Updated subnet routes to epoch %d (count: %d)", routeEpoch, len(newRoutes))
						}
					}

				case <-ctx.Done():
					return
				}
			}
		}()
	}

	// The WireGuard data plane. Off unless -dataplane names a mode, in which case the
	// SOCKS5 and HTTP proxies start routing overlay destinations through it and the
	// node runs on the netmap the control plane serves.
	stopDataplane, dpErr := startDataplane(ctx, dataplaneOptions{
		Mode:         *dataplaneMode,
		SpikeConfig:  *spikePeers,
		EchoPort:     uint16(*overlayEchoPort),
		StunServer:   *stunServer,
		Keypair:      keypair,
		IdentityPath: *identityPath,
		Control:      ctrlClient,
		NodeID:       dataplaneNodeID,
		Registration: regResp,
		Netfilter:    netfilter,
		Bridge:       netstackBridge,
		Netmaps:      netmaps,
	})
	if dpErr != nil {
		log.Fatalf("Failed to start data plane: %v", dpErr)
	}
	defer stopDataplane()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	<-sigChan

	log.Println("[SOVEREIGN-NODE] Shutting down mesh node...")
	_ = socksSrv.Close()
	_ = httpSrv.Close()
	fmt.Println("Sovereign node stopped cleanly.")
}

// osReleasePath is the file the OS version is read from on Linux. It is a variable
// so a test can point it at a fixture without root.
var osReleasePath = "/etc/os-release"

// capability describes what this node offers the mesh.
//
// Every field here used to be a constant in the binary: IP class "RESIDENTIAL" and an
// uplink of 50,000 kbps were reported by a container in a data centre as readily as by
// a laptop. Nothing on the node measures either, so both are declared or absent.
func capability(enableExit bool, countryCode string, maxBandwidthKbps int) control.CapabilityDesc {
	kbps := 0
	if maxBandwidthKbps > 0 {
		kbps = maxBandwidthKbps
	}

	return control.CapabilityDesc{
		Enabled:     enableExit,
		CountryCode: countryCode,
		// The node cannot tell a residential line from a data centre one. UNKNOWN is
		// in the schema's CHECK constraint precisely for this.
		IPClass:          "UNKNOWN",
		ASN:              0,
		MaxBandwidthKbps: uint32(kbps),
	}
}

// buildAttestation assembles the posture attestation sent with each heartbeat.
//
// It reports only what this process can establish. Host disk encryption and firewall
// state are left nil because nothing measures them yet, and a nil travels to the
// control plane as JSON null; the previous code sent `true` for both on every beat
// from every node, which is what made the console describe the whole fleet as
// hardened without a single measurement.
func buildAttestation(nodeID, countryCode string, isRootless bool, now time.Time) *posture.PeerAttestation {
	return &posture.PeerAttestation{
		NodeID:        nodeID,
		OSName:        runtime.GOOS,
		OSVersion:     detectOSVersion(),
		ClientVersion: ClientVersion,
		CountryCode:   countryCode,
		// Not measured: the node does not resolve its own ASN.
		ASN:            0,
		DiskEncrypted:  nil,
		FirewallActive: nil,
		IsRootless:     isRootless,
		TimestampUTC:   now,
	}
}

// detectOSVersion returns the host OS version, or "" when it cannot be established.
//
// Linux is the only platform with a location worth reading; elsewhere, and on any
// read or parse failure, the answer is "not measured" rather than a guess.
func detectOSVersion() string {
	if runtime.GOOS != "linux" {
		return ""
	}

	raw, err := os.ReadFile(osReleasePath)
	if err != nil {
		return ""
	}
	return parseOSReleaseVersionID(string(raw))
}

// parseOSReleaseVersionID extracts VERSION_ID from os-release content.
//
// The format is defined by os-release(5): KEY=VALUE per line, the value optionally
// quoted. An absent or empty VERSION_ID yields "", which means not measured.
func parseOSReleaseVersionID(content string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "VERSION_ID=") {
			continue
		}

		value := strings.TrimSpace(strings.TrimPrefix(line, "VERSION_ID="))
		value = strings.Trim(value, `"'`)
		return value
	}
	return ""
}

// loadOrCreateIdentity reads this node's keypair from disk, creating it on first run.
//
// The identity used to be generated on every start. A node's id and public key derive
// from it, so each restart enrolled as a brand new node: the control plane accumulated
// one dead row per restart, each holding an overlay address that was never released,
// and none of them could be correlated with the device they actually came from.
//
// An identity that changes is not an identity. A path that cannot be written is a
// fatal error rather than a silent fall back to an ephemeral key, because that would
// reintroduce the same problem while looking like it worked.
func loadOrCreateIdentity(path string) (*crypto.Keypair, error) {
	if path == "" {
		return nil, errors.New("no identity path configured")
	}

	raw, err := os.ReadFile(path)
	if err == nil {
		if len(raw) != crypto.KeySize {
			return nil, fmt.Errorf("identity at %s is %d bytes, expected %d", path, len(raw), crypto.KeySize)
		}

		var priv [crypto.KeySize]byte
		copy(priv[:], raw)

		pub, dhErr := crypto.DH(priv, curve25519Basepoint)
		if dhErr != nil {
			return nil, fmt.Errorf("identity at %s is not a usable key: %w", path, dhErr)
		}

		log.Printf("[SOVEREIGN-NODE] Loaded identity from %s", path)
		return &crypto.Keypair{PrivateKey: priv, PublicKey: pub}, nil
	}

	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("cannot read identity at %s: %w", path, err)
	}

	generated, err := crypto.GenerateKeypair()
	if err != nil {
		return nil, err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("cannot create directory for %s: %w", path, err)
	}
	if err := os.WriteFile(path, generated.PrivateKey[:], 0o600); err != nil {
		return nil, fmt.Errorf("cannot write identity to %s: %w", path, err)
	}

	log.Printf("[SOVEREIGN-NODE] Generated a new identity at %s", path)
	return generated, nil
}

// curve25519Basepoint is the generator, used to recover a public key from a stored
// private one.
var curve25519Basepoint = [crypto.KeySize]byte{9}

// registerWithRetry enrols the node, retrying while the control plane is not answering
// yet.
//
// One attempt was not enough. A failed registration leaves the node standalone for the
// rest of its life -- the heartbeat loop only starts once it has succeeded -- so a
// control plane that was still warming up, or six nodes enrolling into it at the same
// instant, cost the node every update the control plane would ever have sent it. The
// whole fleet came up on whatever it had stored and never heard from the control plane
// again.
//
// The per-attempt deadline is unchanged; what was missing was the second attempt.
func registerWithRetry(
	ctx context.Context,
	client *control.Client,
	publicKey [crypto.KeySize]byte,
	role string,
	cap control.CapabilityDesc,
) (*control.RegisterResponse, error) {
	const attempts = 6

	delay := time.Second
	var lastErr error

	for attempt := 1; attempt <= attempts; attempt++ {
		regCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		resp, err := client.Register(regCtx, publicKey, role, nil, cap)
		cancel()
		if err == nil {
			if attempt > 1 {
				log.Printf("[SOVEREIGN-NODE] Registered on attempt %d", attempt)
			}
			return resp, nil
		}

		lastErr = err
		if attempt == attempts {
			break
		}
		log.Printf("[SOVEREIGN-NODE] Registration attempt %d/%d failed: %v (retrying in %s)", attempt, attempts, err, delay)

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}

		delay *= 2
		if delay > 15*time.Second {
			delay = 15 * time.Second
		}
	}

	return nil, lastErr
}

// reregister enrols this node again using the identity it already holds.
//
// The keypair is unchanged, so the control plane recognises the same device and
// assigns it a fresh overlay address. It is the same call made at startup, kept
// separate so the heartbeat loop can reach it.
func reregister(
	ctx context.Context,
	client *control.Client,
	publicKey [crypto.KeySize]byte,
	role string,
	cap control.CapabilityDesc,
) (string, error) {
	regCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := client.Register(regCtx, publicKey, role, nil, cap)
	if err != nil {
		return "", err
	}

	if resp.AssignedNodeID == "" {
		return "", errors.New("control plane assigned no node id")
	}
	if resp.OverlayIPv4 == "" {
		return "", errors.New("control plane assigned no overlay address")
	}

	return resp.AssignedNodeID, nil
}
