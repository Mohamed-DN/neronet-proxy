//go:build windows
// +build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/ipc"
	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/windows/tunnel/winipcfg"

	"github.com/sovereign/proxy/v4/pkg/profile"
)

const (
	endpointAttempts = 4
	endpointWait     = 5 * time.Second
)

// NeroNetService implements svc.Handler. It brings the tunnel up from the imported profile.
type NeroNetService struct {
	mu         sync.Mutex
	dev        *device.Device
	tunDev     tun.Device
	uapiSocket net.Listener
	dataDir    string
	logFile    *os.File
}

func newNeroNetService() *NeroNetService {
	return &NeroNetService{dataDir: dataDirectory()}
}

// Execute implements svc.Handler for Windows SCM.
func (s *NeroNetService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const cmdsAccepted = svc.AcceptStop | svc.AcceptShutdown

	changes <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := s.startTunnel(ctx); err != nil {
		log.Printf("[ERROR] failed to start tunnel: %v", err)
		changes <- svc.Status{State: svc.Stopped}
		return false, 1
	}

	changes <- svc.Status{State: svc.Running, Accepts: cmdsAccepted}

	for {
		c := <-r
		switch c.Cmd {
		case svc.Stop, svc.Shutdown:
			changes <- svc.Status{State: svc.StopPending}
			s.stopTunnel()
			changes <- svc.Status{State: svc.Stopped}
			return false, 0
		case svc.Interrogate:
			changes <- c.CurrentStatus
		default:
			log.Printf("[WARN] unexpected SCM command: %d", c.Cmd)
		}
	}
}

// Run runs the tunnel in the foreground (debug mode, no SCM) until Ctrl+C.
func (s *NeroNetService) Run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	if err := s.startTunnel(ctx); err != nil {
		return fmt.Errorf("start tunnel: %w", err)
	}
	log.Printf("[INFO] NeroNet running. Press Ctrl+C to stop.")
	<-ctx.Done()
	s.stopTunnel()
	return nil
}

// startTunnel loads the imported profile and applies it: the wireguard-go device gets the
// profile's keys and peers, the Wintun adapter gets its addresses, routes and DNS.
// On failure everything it created is closed again.
func (s *NeroNetService) startTunnel(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := ensureDataDir(s.dataDir); err != nil {
		return err
	}
	lf, err := os.OpenFile(filepath.Join(s.dataDir, "service.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("open log file: %w", err)
	}
	s.logFile = lf
	log.SetOutput(lf)

	p, err := loadProfile(profilePath(s.dataDir))
	if err != nil {
		s.teardownLocked()
		return fmt.Errorf("load profile (import one with: neronet-windows import <profile.conf>): %w", err)
	}
	plan, err := planNetwork(p)
	if err != nil {
		s.teardownLocked()
		return err
	}
	log.Printf("[INFO] %s", p.String()) // p.String carries no key material

	endpoints, err := resolveEndpointsWithRetry(ctx, p.Peers)
	if err != nil {
		s.teardownLocked()
		return err
	}

	mtu := plan.MTU
	if mtu <= 0 {
		mtu = device.DefaultMTU
	}
	tunDev, err := tun.CreateTUN("NeroNet", mtu)
	if err != nil {
		s.teardownLocked()
		return fmt.Errorf("create wintun adapter (is wintun.dll next to the executable?): %w", err)
	}
	s.tunDev = tunDev

	// Only errors are logged: wireguard-go's verbose output is not needed for v0.
	logger := &device.Logger{
		Errorf: func(format string, args ...any) { log.Printf("[ERROR] wireguard: "+format, args...) },
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), logger)
	s.dev = dev

	if err := dev.IpcSet(p.UAPI(endpoints...)); err != nil {
		s.teardownLocked()
		return fmt.Errorf("apply profile to the device: %w", err)
	}
	if err := dev.Up(); err != nil {
		s.teardownLocked()
		return fmt.Errorf("bring the device up: %w", err)
	}

	native, ok := tunDev.(*tun.NativeTun)
	if !ok {
		s.teardownLocked()
		return errors.New("wintun device has an unexpected type; cannot configure the adapter")
	}
	if err := applyNetwork(winipcfg.LUID(native.LUID()), plan); err != nil {
		s.teardownLocked()
		return err
	}

	uapiListener, err := ipc.UAPIListen("NeroNet")
	if err != nil {
		s.teardownLocked()
		return fmt.Errorf("UAPI listen: %w", err)
	}
	s.uapiSocket = uapiListener
	go func() {
		for {
			conn, err := uapiListener.Accept()
			if err != nil {
				return
			}
			go dev.IpcHandle(conn)
		}
	}()

	log.Printf("[INFO] tunnel up: adapter NeroNet, %d address(es), %d route(s), %d DNS server(s)",
		len(plan.Addresses), len(plan.Routes), len(plan.DNS))
	return nil
}

func (s *NeroNetService) stopTunnel() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.teardownLocked()
	if s.logFile != nil {
		log.Printf("[INFO] Tunnel stopped")
		log.SetOutput(os.Stderr)
		s.logFile.Close()
		s.logFile = nil
	}
}

// teardownLocked closes the UAPI socket, the device and the adapter. Closing the adapter
// also removes its addresses, routes and DNS. The caller must hold s.mu. The log stays
// open so that the reason for a failed start reaches service.log.
func (s *NeroNetService) teardownLocked() {
	if s.uapiSocket != nil {
		s.uapiSocket.Close()
		s.uapiSocket = nil
	}
	if s.dev != nil {
		s.dev.Close()
		s.dev = nil
	}
	if s.tunDev != nil {
		s.tunDev.Close()
		s.tunDev = nil
	}
}

// resolveEndpointsWithRetry retries name resolution: at boot the service can start before
// DNS works.
func resolveEndpointsWithRetry(ctx context.Context, peers []profile.Peer) ([]string, error) {
	lookup := func(ctx context.Context, host string) ([]netip.Addr, error) {
		return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	}
	var lastErr error
	for attempt := 1; attempt <= endpointAttempts; attempt++ {
		endpoints, err := resolveEndpoints(ctx, lookup, peers)
		if err == nil {
			return endpoints, nil
		}
		lastErr = err
		log.Printf("[WARN] endpoint resolution attempt %d of %d: %v", attempt, endpointAttempts, err)
		if attempt == endpointAttempts {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(endpointWait):
		}
	}
	return nil, lastErr
}

func runAsService() {
	if err := svc.Run(serviceName, newNeroNetService()); err != nil {
		log.Fatalf("service run failed: %v", err)
	}
}
