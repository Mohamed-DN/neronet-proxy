package main

import (
	"flag"
	"log"
	"os"

	"github.com/sovereign/proxy/v4/pkg/config"
	"github.com/sovereign/proxy/v4/pkg/meshnode"
)

func main() {
	_ = config.LoadDotEnv()

	socksAddr := config.BindStringFlag(flag.CommandLine, "socks-addr", "SOVEREIGN_SOCKS5_LISTEN_ADDR", "127.0.0.1:1080", "Local SOCKS5 proxy inbound listen address")
	httpAddr := config.BindStringFlag(flag.CommandLine, "http-addr", "SOVEREIGN_HTTP_LISTEN_ADDR", "127.0.0.1:8080", "Local HTTP CONNECT proxy inbound listen address")
	controlURL := config.BindStringFlag(flag.CommandLine, "control-url", "SOVEREIGN_CONTROL_PLANE_URL", "http://127.0.0.1:8443", "SovereignMesh Control Plane URL")
	controlCA := config.BindStringFlag(flag.CommandLine, "control-ca", "SOVEREIGN_CONTROL_PLANE_CA", "", "PEM file of the CA that signs the control plane's TLS certificate; only that CA is trusted. Empty uses the system roots")
	enableExit := config.BindBoolFlag(flag.CommandLine, "enable-exit", "SOVEREIGN_ENABLE_EXIT_BRIDGE", false, "Enable sandboxed egress exit node bridge")
	countryCode := config.BindStringFlag(flag.CommandLine, "country", "SOVEREIGN_COUNTRY_CODE", "", "Self-declared ISO country code for bridge registration (not measured); empty means the location is unknown and nothing is reported")
	declaredLocationOf := meshnode.BindLocationFlags(flag.CommandLine)
	identityPath := config.BindStringFlag(flag.CommandLine, "identity", "SOVEREIGN_NODE_KEY_PATH", "/var/lib/neronet/node_identity.key", "Path to this node's persistent identity key")
	maxBandwidthKbps := config.BindIntFlag(flag.CommandLine, "max-bandwidth-kbps", "SOVEREIGN_MAX_BANDWIDTH_KBPS", 0, "Self-declared uplink capacity in kbps; 0 means not declared")
	dataplaneMode := config.BindStringFlag(flag.CommandLine, "dataplane", "SOVEREIGN_DATAPLANE", "off", "WireGuard data plane mode: off, netstack or tun")
	awgListen := config.BindStringFlag(flag.CommandLine, "awg-listen", "SOVEREIGN_AWG_LISTEN", "", "UDP port of the profile gateway's AmneziaWG device (e.g. 51821); empty keeps AmneziaWG off. The parameters come from the netmap, never from the binary")
	vlessPort := config.BindIntFlag(flag.CommandLine, "vless-port", "SOVEREIGN_VLESS_PORT", 0, "Public TCP port of the gateway's VLESS + REALITY terminator (Xray); 0 keeps the method off. The REALITY parameters come from the netmap")
	vlessSocksListen := config.BindStringFlag(flag.CommandLine, "vless-socks-listen", "SOVEREIGN_VLESS_SOCKS_LISTEN", "", "Listen address of the per-device SOCKS5 the Xray terminator connects to (e.g. :1081); empty keeps VLESS off")
	vlessSocksAddr := config.BindStringFlag(flag.CommandLine, "vless-socks-addr", "SOVEREIGN_VLESS_SOCKS_ADDR", "", "host:port at which the Xray container reaches the device SOCKS5 (e.g. gateway:1081)")
	vlessListen := config.BindStringFlag(flag.CommandLine, "vless-listen", "SOVEREIGN_VLESS_LISTEN", "", "host:port Xray binds, e.g. 127.0.0.1:8445 behind an SNI router; empty binds the public port on every interface. -vless-port stays the port reported to the console")
	vlessAcceptProxy := config.BindBoolFlag(flag.CommandLine, "vless-accept-proxy", "SOVEREIGN_VLESS_ACCEPT_PROXY", false, "Xray reads a PROXY protocol header from the router so per-address limits see the client; only with -vless-listen on loopback")
	xrayConfig := config.BindStringFlag(flag.CommandLine, "xray-config", "SOVEREIGN_XRAY_CONFIG", "", "Path of the Xray configuration the node writes for the terminator; empty keeps VLESS off")
	spikePeers := config.BindStringFlag(flag.CommandLine, "spike-peers", "SOVEREIGN_SPIKE_PEERS", "", "Path to the WP-201 spike peers document")
	overlayEchoPort := config.BindIntFlag(flag.CommandLine, "overlay-echo-port", "SOVEREIGN_OVERLAY_ECHO_PORT", 0, "TCP port answering on this node's overlay address; 0 disables it")
	stunServer := config.BindStringFlag(flag.CommandLine, "stun-server", "SOVEREIGN_STUN_SERVER", "", "STUN server (host:port) asked for this node's reflexive address; empty disables it")
	metricsAddr := config.BindStringFlag(flag.CommandLine, "metrics-addr", "SOVEREIGN_METRICS_LISTEN_ADDR", "", "HTTP metrics listen address (e.g. 127.0.0.1:9090); empty disables metrics")
	dropListen := config.BindStringFlag(flag.CommandLine, "drop-listen", "SOVEREIGN_DROP_LISTEN", "", "NeroDrop mailbox listen address for the console's reverse proxy (e.g. :8788); empty disables the mailbox")
	dropDir := config.BindStringFlag(flag.CommandLine, "drop-dir", "SOVEREIGN_DROP_DIR", "/var/lib/neronet-drop", "Directory that holds NeroDrop ciphertext (a persistent volume)")
	dropMaxMiB := config.BindIntFlag(flag.CommandLine, "drop-max-mib", "SOVEREIGN_DROP_MAX_MIB", 256, "Largest NeroDrop transfer accepted, in MiB of ciphertext")
	dropQuotaMiB := config.BindIntFlag(flag.CommandLine, "drop-quota-mib", "SOVEREIGN_DROP_QUOTA_MIB", 2048, "All stored NeroDrop transfers together, in MiB")
	dropMaxAge := config.BindStringFlag(flag.CommandLine, "drop-max-age", "SOVEREIGN_DROP_MAX_AGE", "168h", "Longest a NeroDrop transfer is kept, whatever the console asks (Go duration, e.g. 24h)")
	flag.Parse()

	location, err := declaredLocationOf()
	if err != nil {
		log.Fatalf("Invalid declared location: %v", err)
	}

	// The environment is read here and only here: the node takes what it needs in Params.
	awgParams, err := meshnode.AWGParamsFromEnv()
	if err != nil {
		log.Fatalf("Failed to start data plane: %v", err)
	}

	enrolmentKey, onEnrolled, err := meshnode.EnrolmentKeyFromEnv()
	if err != nil {
		log.Fatalf("Cannot use the enrolment key: %v", err)
	}

	meshnode.Run(meshnode.Params{
		SocksAddr:        *socksAddr,
		HTTPAddr:         *httpAddr,
		ControlURL:       *controlURL,
		ControlCA:        *controlCA,
		EnableExit:       *enableExit,
		CountryCode:      *countryCode,
		IdentityPath:     *identityPath,
		MaxBandwidthKbps: *maxBandwidthKbps,
		DataplaneMode:    *dataplaneMode,
		AWGListen:        *awgListen,
		VLESSPort:        *vlessPort,
		VLESSSocksListen: *vlessSocksListen,
		VLESSSocksAddr:   *vlessSocksAddr,
		VLESSListen:      *vlessListen,
		VLESSAcceptProxy: *vlessAcceptProxy,
		XrayConfig:       *xrayConfig,
		SpikePeers:       *spikePeers,
		OverlayEchoPort:  *overlayEchoPort,
		StunServer:       *stunServer,
		MetricsAddr:      *metricsAddr,
		DropListen:       *dropListen,
		DropDir:          *dropDir,
		DropMaxMiB:       *dropMaxMiB,
		DropQuotaMiB:     *dropQuotaMiB,
		DropMaxAge:       *dropMaxAge,
		Location:         location,

		ExitDNS:                   meshnode.ExitDNSFromEnv(),
		AWGParams:                 awgParams,
		MeshDNS:                   meshnode.MeshDNSFromEnv(),
		ProxyUsername:             os.Getenv("SOVEREIGN_PROXY_USERNAME"),
		ProxyPassword:             os.Getenv("SOVEREIGN_PROXY_PASSWORD"),
		ProxyAllowUnauthenticated: os.Getenv("SOVEREIGN_PROXY_ALLOW_UNAUTHENTICATED") == "true",
		RegistrationToken:         os.Getenv("SOVEREIGN_REGISTRATION_TOKEN"),
		EnrolmentKey:              enrolmentKey,
		OnEnrolled:                onEnrolled,
	})
}
