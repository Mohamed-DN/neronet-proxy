package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
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
	countryCode := config.BindStringFlag(flag.CommandLine, "country", "SOVEREIGN_COUNTRY_CODE", "US", "ISO Country Code for bridge registration")
	identityPath := config.BindStringFlag(flag.CommandLine, "identity", "SOVEREIGN_NODE_KEY_PATH", "/var/lib/neronet/node_identity.key", "Path to this node's persistent identity key")
	flag.Parse()

	log.Printf("[SOVEREIGN-NODE] Initializing SovereignMesh client daemon (%s)...", ClientVersion)

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

	// Register with Control Plane
	ctrlClient := control.NewClient(*controlURL)
	ctrlClient.SetAuthToken(os.Getenv("SOVEREIGN_REGISTRATION_TOKEN"))
	role := "CLIENT_ORIGIN"
	if *enableExit {
		role = "EXIT_BRIDGE"
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	regCtx, regCancel := context.WithTimeout(ctx, 5*time.Second)
	regResp, err := ctrlClient.Register(regCtx, keypair.PublicKey, role, nil, control.CapabilityDesc{
		Enabled:          *enableExit,
		CountryCode:      *countryCode,
		IPClass:          "RESIDENTIAL",
		MaxBandwidthKbps: 50000,
	})
	regCancel()

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
					att := &posture.PeerAttestation{
						NodeID:         nodeID,
						OSName:         runtime.GOOS,
						OSVersion:      "14.5.0",
						ClientVersion:  ClientVersion,
						CountryCode:    *countryCode,
						ASN:            7018,
						DiskEncrypted:  true,
						FirewallActive: true,
						IsRootless:     isRootless,
						TimestampUTC:   time.Now().UTC(),
					}

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

					hbCtx, hbCancel := context.WithTimeout(ctx, 5*time.Second)
					hbResp, hbErr := ctrlClient.SendHeartbeatWithPosture(
						hbCtx, nodeID, nil, 0, cpuPctUnmeasured, memoryMB, batteryPctUnmeasured, false, att,
					)
					hbCancel()

					if hbErr != nil {
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
							log.Printf("[SOVEREIGN-NODE] Updated ACL policy to epoch %d", policyEpoch)
						}
					}

					// Update routes if epoch advanced
					if hbResp.RouteEpoch > routeEpoch {
						rCtx, rCancel := context.WithTimeout(ctx, 5*time.Second)
						newRoutes, newEp, rErr := ctrlClient.SyncRoutes(rCtx, nodeID, routeEpoch)
						rCancel()
						if rErr == nil {
							routeEpoch = newEp
							log.Printf("[SOVEREIGN-NODE] Updated subnet routes to epoch %d (count: %d)", routeEpoch, len(newRoutes))
						}
					}

				case <-ctx.Done():
					return
				}
			}
		}()
	}

	// Unused listener warning suppression
	_ = net.ParseIP("127.0.0.1")

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	<-sigChan

	log.Println("[SOVEREIGN-NODE] Shutting down mesh node...")
	_ = socksSrv.Close()
	_ = httpSrv.Close()
	fmt.Println("Sovereign node stopped cleanly.")
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
