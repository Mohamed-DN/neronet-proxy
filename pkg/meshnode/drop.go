package meshnode

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/drop"
)

// The NeroDrop mailbox (ADR 0033) on a profile gateway: an HTTP listener on the
// container network that the console's reverse proxy forwards /drop-blob/ to. It
// accepts only requests that carry a ticket the console signed for this node.

// withDrop adds the mailbox capability when the mailbox runs, so the console knows this
// gateway can hold transfers. The caller's slice is left alone.
func withDrop(c control.CapabilityDesc, enabled bool) control.CapabilityDesc {
	if !enabled {
		return c
	}
	c.Capabilities = append(slices.Clone(c.Capabilities), drop.Capability)
	return c
}

// dropKeySource answers the ticket key, asking the control plane for its public key the
// first time it is needed and again after a failure, never after a success.
func dropKeySource(priv [32]byte, fetch func(context.Context) (*control.ChallengeResponse, error)) func() ([]byte, error) {
	var mu sync.Mutex
	var key []byte
	return func() ([]byte, error) {
		mu.Lock()
		defer mu.Unlock()
		if key != nil {
			return key, nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		ch, err := fetch(ctx)
		if err != nil {
			return nil, fmt.Errorf("control plane key: %w", err)
		}
		cpPub, err := hex.DecodeString(ch.ControlPlanePubHex)
		if err != nil {
			return nil, errors.New("control plane key is not hex")
		}
		k, err := drop.TicketKey(priv, cpPub)
		if err != nil {
			return nil, err
		}
		key = k
		return key, nil
	}
}

// currentNodeID is the node id the control plane knows this node by; registration and
// re-enrolment set it, the mailbox reads it for every ticket.
type currentNodeID struct{ v atomic.Value }

func (c *currentNodeID) Get() string {
	s, _ := c.v.Load().(string)
	return s
}

func (c *currentNodeID) Set(id string) { c.v.Store(id) }

type dropOptions struct {
	Listen     string
	Dir        string
	MaxBytes   int64
	QuotaBytes int64
	MaxTTL     time.Duration
	Key        func() ([]byte, error)
	NodeID     *currentNodeID
}

// startDrop starts the mailbox listener and its sweeper; the returned function stops
// both.
func startDrop(ctx context.Context, o dropOptions) (func(), error) {
	srv, err := drop.NewServer(drop.Config{
		Dir:        o.Dir,
		MaxBytes:   o.MaxBytes,
		QuotaBytes: o.QuotaBytes,
		MaxTTL:     o.MaxTTL,
		Key:        o.Key,
		NodeID:     o.NodeID.Get,
	})
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", o.Listen)
	if err != nil {
		return nil, err
	}
	httpSrv := &http.Server{
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	sweepCtx, stopSweep := context.WithCancel(ctx)
	go srv.Run(sweepCtx, time.Minute)
	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("[DROP] listener stopped: %v", err)
		}
	}()
	log.Printf("[DROP] mailbox on %s, store %s", ln.Addr(), o.Dir)
	return func() {
		stopSweep()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}, nil
}
