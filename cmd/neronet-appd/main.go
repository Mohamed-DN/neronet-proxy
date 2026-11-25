// neronet-appd is the NeroNet app's service on Linux, headless: the core of ADR 0040 (pkg/clientcore) with a
// local API on a private unix socket and the node agent's own tunnel (pkg/meshnode). An interface, or
// neronet-appctl, drives it over that socket; nothing else listens.
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/sovereign/proxy/v4/pkg/clientcore"
	"github.com/sovereign/proxy/v4/pkg/config"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/keystore"
)

func platform() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos"
	default:
		return runtime.GOOS
	}
}

func main() {
	_ = config.LoadDotEnv()
	controlURL := config.BindStringFlag(flag.CommandLine, "control-url", "NERONET_APP_CONTROL_URL", "", "Address of the console, e.g. https://console.example.com")
	controlCA := config.BindStringFlag(flag.CommandLine, "control-ca", "NERONET_APP_CONTROL_CA", "", "PEM file of the only CA trusted for the console; empty uses the system roots")
	stateDir := config.BindStringFlag(flag.CommandLine, "state-dir", "NERONET_APP_STATE_DIR", "/var/lib/neronet-app", "Where the app keeps its keys and its stored netmap")
	runDir := config.BindStringFlag(flag.CommandLine, "run-dir", "NERONET_APP_RUN_DIR", "/run/neronet", "Existing directory, owned by this user and not writable by others, that holds the owner socket directory")
	ownerUID := config.BindIntFlag(flag.CommandLine, "owner-uid", "NERONET_APP_OWNER_UID", -1, "The user the installation belongs to; only that user may control it. Default: the user running this service")
	admitRoot := config.BindBoolFlag(flag.CommandLine, "admit-root", "NERONET_APP_ADMIT_ROOT", false, "Also admit root to the local API")
	deviceName := config.BindStringFlag(flag.CommandLine, "name", "NERONET_APP_DEVICE_NAME", "", "Device name shown to the person who approves the sign-in (stated by the app, not checked)")
	dataplane := config.BindStringFlag(flag.CommandLine, "dataplane", "NERONET_APP_DATAPLANE", "netstack", "netstack (userspace, no privilege) or tun")
	socks := config.BindStringFlag(flag.CommandLine, "socks", "NERONET_APP_SOCKS", "127.0.0.1:1080", "Loopback SOCKS5 that carries a program's traffic into the mesh (netstack); empty starts none")
	flag.Parse()

	if *controlURL == "" {
		log.Fatal("neronet-appd: -control-url is required")
	}
	owner := uint32(os.Geteuid())
	if *ownerUID >= 0 {
		owner = uint32(*ownerUID)
	}
	name := *deviceName
	if name == "" {
		name, _ = os.Hostname()
	}

	var caPEM []byte
	if *controlCA != "" {
		var err error
		if caPEM, err = os.ReadFile(*controlCA); err != nil {
			log.Fatalf("neronet-appd: cannot read the console CA: %v", err)
		}
	}
	console, err := clientcore.NewHTTPConsole(*controlURL, caPEM)
	if err != nil {
		log.Fatalf("neronet-appd: %v", err)
	}
	var ctl *control.Client
	if len(caPEM) > 0 {
		ctl, err = control.NewClientWithCA(*controlURL, caPEM)
		if err != nil {
			log.Fatalf("neronet-appd: %v", err)
		}
	} else {
		ctl = control.NewClient(*controlURL)
	}
	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		log.Fatalf("neronet-appd: %v", err)
	}
	store, err := keystore.NewDefaultKeyStore(filepath.Join(*stateDir, "keys"))
	if err != nil {
		log.Fatalf("neronet-appd: key store: %v", err)
	}
	tunnel, err := clientcore.NewMeshTunnel(clientcore.MeshConfig{
		ControlURL: *controlURL, ControlCAPath: *controlCA, StateDir: *stateDir, DataplaneMode: *dataplane, SocksAddr: *socks,
	})
	if err != nil {
		log.Fatalf("neronet-appd: %v", err)
	}
	core, err := clientcore.New(clientcore.Config{
		Platform: platform(), DeviceName: name, Console: console, Enroller: clientcore.ControlEnroller{Client: ctl},
		Tunnel: tunnel, Store: store,
	})
	if err != nil {
		log.Fatalf("neronet-appd: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go core.Run(ctx)
	tr := clientcore.UnixTransport{RunDir: *runDir, OwnerUID: owner, AdmitRoot: *admitRoot}
	log.Printf("neronet-appd: local API on %s for uid %d", tr.SocketPath(), owner)
	if err := clientcore.NewServer(core, tr).Serve(ctx); err != nil {
		log.Fatalf("neronet-appd: %v", err)
	}
	_ = tunnel.Down(context.Background())
}
