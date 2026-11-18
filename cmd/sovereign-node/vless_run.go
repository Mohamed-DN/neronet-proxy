package main

import (
	"log"

	"github.com/sovereign/proxy/v4/pkg/bridge"
)

// vlessAdvertisedPort is the public port the gateway reports, or 0 when any of the three
// things that make VLESS runnable is missing.
func vlessAdvertisedPort(port int, socksListen, socksAddr, xrayConfig string) uint16 {
	if port <= 0 || port > 65535 || socksListen == "" || socksAddr == "" || xrayConfig == "" {
		return 0
	}
	return uint16(port)
}

// startVLESS starts the device SOCKS listener and hands the manager its registry. The
// returned function stops the listener.
func startVLESS(m *netmapManager, listen, socksAddr, configPath string) (func(), error) {
	if listen == "" || socksAddr == "" || configPath == "" {
		return func() {}, nil
	}
	reg := bridge.NewDeviceSOCKS()
	srv := bridge.NewSOCKS5Server(listen, nil)
	srv.SetDeviceAuth(reg.Authenticate)
	if err := srv.Start(); err != nil {
		return nil, err
	}
	m.SetVLESS(socksAddr, configPath, reg)
	log.Printf("[SOVEREIGN-NODE] VLESS: device SOCKS5 listening on %s, Xray configuration at %s", srv.Addr(), configPath)
	return func() { _ = srv.Close() }, nil
}
