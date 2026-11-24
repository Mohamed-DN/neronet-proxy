package clientcore

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Method is one way of reaching the mesh (ADR 0036, 0037).
type Method string

const (
	MethodWireGuard    Method = "wireguard"
	MethodWireGuardWSS Method = "wireguard-wss"
	MethodAmneziaWG    Method = "amneziawg"
)

var knownMethods = map[Method]bool{MethodWireGuard: true, MethodWireGuardWSS: true, MethodAmneziaWG: true}

// DefaultOrder is Automatico: UDP first, then WireGuard inside a WebSocket on 443.
// AmneziaWG is not wired into the core yet and is never tried unless the tunnel says it can.
var DefaultOrder = []Method{MethodWireGuard, MethodWireGuardWSS}

// ErrNoMethod is returned when no method in the order could be used.
var ErrNoMethod = errors.New("no connection method worked")

// Order is the person's or organisation's order of methods. Forced means "only the first".
type Order struct {
	Methods []Method `json:"methods"`
	Forced  bool     `json:"forced"`
}

// Validate refuses unknown, repeated and empty orders.
func (o Order) Validate() error {
	if len(o.Methods) < 1 || len(o.Methods) > 3 {
		return errors.New("an order has one to three methods")
	}
	seen := map[Method]bool{}
	for _, m := range o.Methods {
		if !knownMethods[m] {
			return fmt.Errorf("unknown connection method %q", m)
		}
		if seen[m] {
			return fmt.Errorf("method %q repeated", m)
		}
		seen[m] = true
	}
	return nil
}

// Attempt is one try of one method. It must return once ctx ends.
type Attempt func(ctx context.Context, m Method) error

// WalkResult says what the walk did, for the interface to show without guessing.
type WalkResult struct {
	Used    Method
	Skipped map[Method]string // method -> why it was not tried
	Failed  map[Method]string // method -> why it failed
}

// Walk tries the methods in order, once each, each bounded by perAttempt, and stops at the
// first that works. It never loops: a method that fails is not retried inside one walk, and
// a method the tunnel cannot do (available returns false) is skipped and reported, not
// silently dropped. With Forced only the first method is tried; there is no fallback from a
// forced choice, because the person or the organisation asked for exactly that path.
func Walk(ctx context.Context, order Order, available func(Method) bool, attempt Attempt, perAttempt time.Duration) (WalkResult, error) {
	res := WalkResult{Skipped: map[Method]string{}, Failed: map[Method]string{}}
	if err := order.Validate(); err != nil {
		return res, err
	}
	methods := order.Methods
	if order.Forced {
		methods = methods[:1]
	}
	for _, m := range methods {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		if available != nil && !available(m) {
			res.Skipped[m] = "not available on this device"
			continue
		}
		actx, cancel := context.WithTimeout(ctx, perAttempt)
		err := attempt(actx, m)
		cancel()
		if err == nil {
			res.Used = m
			return res, nil
		}
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		res.Failed[m] = err.Error()
		// A device the console removed does not try another path: every path leads to the same
		// refusal, and trying them all would only look like an attack.
		if errors.Is(err, ErrRevoked) {
			return res, err
		}
	}
	return res, ErrNoMethod
}
