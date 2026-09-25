//go:build windows
// +build windows

package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/ipc"
	"golang.zx2c4.com/wireguard/tun"
)

// NeroNetService implements svc.Handler and manages the WireGuard tunnel.
type NeroNetService struct {
	mu         sync.Mutex
	dev        *device.Device
	tunDev     tun.Device
	uapiSocket net.Listener
	cancel     context.CancelFunc
	dataDir    string
	controlURL string
	logFile    *os.File
	logger     *device.Logger
}

func newNeroNetService() *NeroNetService {
	dataDir := filepath.Join(os.Getenv("ProgramData"), "NeroNet")
	controlURL := os.Getenv("NERONET_CONTROL_URL")
	if controlURL == "" {
		controlURL = "http://127.0.0.1:8443"
	}
	return &NeroNetService{
		dataDir:    dataDir,
		controlURL: controlURL,
	}
}

// Execute implements svc.Handler for Windows SCM.
func (s *NeroNetService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const cmdsAccepted = svc.AcceptStop | svc.AcceptShutdown

	changes <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel

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
			cancel()
			changes <- svc.Status{State: svc.Stopped}
			return false, 0
		case svc.Interrogate:
			changes <- c.CurrentStatus
		default:
			log.Printf("[WARN] unexpected SCM command: %d", c.Cmd)
		}
	}
}

// Run runs the service directly (debug mode).
func (s *NeroNetService) Run() error {
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	defer cancel()

	if err := s.startTunnel(ctx); err != nil {
		return fmt.Errorf("start tunnel: %w", err)
	}

	log.Printf("[INFO] NeroNet running. Press Ctrl+C to stop.")
	<-ctx.Done()
	s.stopTunnel()
	return nil
}

func (s *NeroNetService) startTunnel(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	os.MkdirAll(s.dataDir, 0700)

	// Setup logging to %ProgramData%\NeroNet\service.log
	logPath := filepath.Join(s.dataDir, "service.log")
	lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("open log file: %w", err)
	}
	s.logFile = lf
	log.SetOutput(lf)

	// Create Wintun adapter
	// NOTE: wintun.dll must be in the same dir as the executable
	tunDev, err := tun.CreateTUN("NeroNet", device.DefaultMTU)
	if err != nil {
		return fmt.Errorf("create wintun adapter: %w", err)
	}
	s.tunDev = tunDev

	// Create WireGuard device
	logger := device.NewLogger(device.LogLevelVerbose, "[NeroNet] ")
	s.logger = logger
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), logger)
	s.dev = dev

	// Create UAPI socket for wireguard-go IPC
	uapiListener, err := ipc.UAPIListen("NeroNet")
	if err != nil {
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

	// Fetch config from control plane
	go s.enrollLoop(ctx)

	log.Printf("[INFO] WireGuard tunnel started (adapter: NeroNet)")
	return nil
}

func (s *NeroNetService) stopTunnel() {
	s.mu.Lock()
	defer s.mu.Unlock()

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
	if s.logFile != nil {
		s.logFile.Close()
		s.logFile = nil
	}
	log.Printf("[INFO] Tunnel stopped")
}

// enrollLoop polls the control plane for configuration updates.
func (s *NeroNetService) enrollLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	// Immediate first attempt
	s.fetchAndApplyConfig()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.fetchAndApplyConfig()
		}
	}
}

func (s *NeroNetService) fetchAndApplyConfig() {
	url := s.controlURL + "/api/v4/control/netmap"
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(url)
	if err != nil {
		log.Printf("[WARN] control plane unreachable: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("[WARN] netmap returned %d", resp.StatusCode)
		return
	}

	log.Printf("[INFO] netmap refreshed from %s", url)
	// TODO: parse netmap JSON and apply via UAPI
}

func runAsService() {
	if err := svc.Run(serviceName, newNeroNetService()); err != nil {
		log.Fatalf("service run failed: %v", err)
	}
}
