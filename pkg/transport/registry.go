package transport

import (
	"fmt"
	"strings"
	"sync"
)

var (
	registryMu sync.RWMutex
	registry   = map[string]Spec{}
)

// Register adds a transport. Each transport package calls it from init, so linking the
// package is what builds the transport in. It panics on a name outside Order, a
// duplicate, or an incomplete Spec: all three are programming errors and the right time
// to find them is process start.
func Register(spec Spec) {
	if Rank(spec.Name) == len(Order) {
		panic(fmt.Sprintf("transport: %q is not one of %v", spec.Name, Order))
	}
	if spec.New == nil || spec.ParseEndpoint == nil || spec.BatchSize < 1 {
		panic(fmt.Sprintf("transport: incomplete spec for %q", spec.Name))
	}

	registryMu.Lock()
	defer registryMu.Unlock()
	if _, dup := registry[spec.Name]; dup {
		panic(fmt.Sprintf("transport: %q registered twice", spec.Name))
	}
	registry[spec.Name] = spec
}

// lookup returns the Spec of a built transport.
func lookup(name string) (Spec, bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	spec, ok := registry[name]
	return spec, ok
}

// Built lists the transports linked into this binary, in preference order. It is what
// the node reports to the control plane: the transports it was built with and can
// listen on.
func Built() []string {
	registryMu.RLock()
	defer registryMu.RUnlock()

	out := make([]string, 0, len(registry))
	for _, name := range Order {
		if _, ok := registry[name]; ok {
			out = append(out, name)
		}
	}
	return out
}

// IsBuilt reports whether a transport is linked in.
func IsBuilt(name string) bool {
	_, ok := lookup(name)
	return ok
}

// maxBatch is the largest BatchSize of any built transport. The Mux reports it for
// every state, so wireguard-go sizes its buffers once and a transport enabled later
// never meets a batch it was not sized for.
func maxBatch() int {
	registryMu.RLock()
	defer registryMu.RUnlock()

	n := 1
	for _, spec := range registry {
		if spec.BatchSize > n {
			n = spec.BatchSize
		}
	}
	return n
}

// Canonical lowercases, trims and de-duplicates names, drops anything that is not a
// known transport name, and returns the rest in preference order. A name this build
// has never heard of is dropped, not an error: a control plane newer than the node may
// offer a transport the node cannot use, and the node's answer is to not use it.
func Canonical(names []string) []string {
	have := make(map[string]bool, len(names))
	for _, n := range names {
		have[strings.ToLower(strings.TrimSpace(n))] = true
	}

	out := make([]string, 0, len(have))
	for _, n := range Order {
		if have[n] {
			out = append(out, n)
		}
	}
	return out
}

// Intersect is the set of names present in every list, in preference order. With no
// lists it is empty: nothing is allowed unless something allows it. A nil list is an
// empty list, so an absent policy allows nothing; callers that want "no policy means
// the default" say so before calling.
func Intersect(lists ...[]string) []string {
	if len(lists) == 0 {
		return []string{}
	}

	result := Canonical(lists[0])
	for _, l := range lists[1:] {
		in := make(map[string]bool, len(l))
		for _, n := range Canonical(l) {
			in[n] = true
		}
		kept := result[:0:0]
		for _, n := range result {
			if in[n] {
				kept = append(kept, n)
			}
		}
		result = kept
	}
	return result
}

// Contains reports whether name is in list.
func Contains(list []string, name string) bool {
	for _, n := range list {
		if strings.EqualFold(strings.TrimSpace(n), name) {
			return true
		}
	}
	return false
}
