package clientcore

import "sync"

// Phase is where the app is, in words an interface can map to one screen each.
type Phase string

const (
	PhaseSignedOut    Phase = "signed_out"
	PhaseSigningIn    Phase = "signing_in"
	PhaseEnrolling    Phase = "enrolling"
	PhaseDisconnected Phase = "disconnected"
	PhaseConnecting   Phase = "connecting"
	PhaseConnected    Phase = "connected"
	PhaseFailed       Phase = "failed"
)

// KillSwitchState is reported by the tunnel; the core never claims more than it says.
type KillSwitchState string

const (
	KillSwitchOff      KillSwitchState = "off"
	KillSwitchArmed    KillSwitchState = "armed"
	KillSwitchBlocking KillSwitchState = "blocking"
	KillSwitchUnknown  KillSwitchState = "unsupported"
)

// State is everything an interface shows. It carries no secret: no token, no key, no grant.
type State struct {
	Version    int               `json:"version"`
	Seq        uint64            `json:"seq"`
	Phase      Phase             `json:"phase"`
	Message    string            `json:"message,omitempty"`
	UserCode   string            `json:"user_code,omitempty"`
	VerifyPath string            `json:"verification_uri_complete,omitempty"`
	Method     Method            `json:"method,omitempty"`
	Exit       string            `json:"exit,omitempty"`
	NodeID     string            `json:"node_id,omitempty"`
	Account    string            `json:"account,omitempty"`
	Overlay    string            `json:"overlay_address,omitempty"`
	KillSwitch KillSwitchState   `json:"kill_switch"`
	Names      *NamesState       `json:"names,omitempty"`
	Order      Order             `json:"order"`
	Skipped    map[Method]string `json:"skipped,omitempty"`
	Failed     map[Method]string `json:"failed,omitempty"`
}

// Hub keeps the latest State and fans changes out. A slow watcher never blocks the core: it
// gets the newest state when it next reads, not every intermediate one.
type Hub struct {
	mu    sync.Mutex
	state State
	subs  map[chan State]struct{}
}

// NewHub starts in the signed-out state.
func NewHub(initial State) *Hub {
	initial.Version = APIVersion
	return &Hub{state: initial, subs: map[chan State]struct{}{}}
}

// Get returns a copy of the current state.
func (h *Hub) Get() State {
	h.mu.Lock()
	defer h.mu.Unlock()
	return copyState(h.state)
}

// Update applies fn to the state, bumps the sequence and notifies watchers.
func (h *Hub) Update(fn func(*State)) State {
	h.mu.Lock()
	next := copyState(h.state)
	fn(&next)
	next.Version = APIVersion
	next.Seq = h.state.Seq + 1
	h.state = next
	out := copyState(next)
	for ch := range h.subs {
		select {
		case ch <- out:
		default:
			// Replace the unread older state with the newest.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- out:
			default:
			}
		}
	}
	h.mu.Unlock()
	return out
}

// Subscribe returns a channel that starts with the current state, and a cancel function.
func (h *Hub) Subscribe() (<-chan State, func()) {
	ch := make(chan State, 1)
	h.mu.Lock()
	ch <- copyState(h.state)
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		if _, ok := h.subs[ch]; ok {
			delete(h.subs, ch)
			close(ch)
		}
		h.mu.Unlock()
	}
}

func copyState(s State) State {
	s.Order.Methods = append([]Method(nil), s.Order.Methods...)
	s.Skipped = copyMap(s.Skipped)
	s.Failed = copyMap(s.Failed)
	return s
}

func copyMap(m map[Method]string) map[Method]string {
	if m == nil {
		return nil
	}
	out := make(map[Method]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
