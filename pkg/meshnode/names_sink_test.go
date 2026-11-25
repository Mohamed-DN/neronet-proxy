package meshnode

import (
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/control"
)

type namesRecorder struct {
	docs  []*control.NetmapResponse
	peers [][]control.NetmapPeer
}

func (r *namesRecorder) sink(doc *control.NetmapResponse, peers []control.NetmapPeer) {
	r.docs = append(r.docs, doc)
	r.peers = append(r.peers, peers)
}

// A node that resolves mesh names for its own computer (the app) is told the names of the netmap whether or
// not it serves a profile device or answers mesh names for other devices.
func TestNamesSinkGetsTheKeptPeersEvenWhenTheNodeServesNoDevice(t *testing.T) {
	m, rec := meshNameManager(t, false)
	rec2 := &namesRecorder{}
	m.SetNamesSink(rec2.sink)
	if err := m.Apply(namedDoc(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if rec.last() != nil {
		t.Fatal("mesh names for other devices were installed although they are off")
	}
	if len(rec2.docs) == 0 || rec2.docs[len(rec2.docs)-1] == nil {
		t.Fatal("the sink was not given the document")
	}
	last := rec2.peers[len(rec2.peers)-1]
	names := map[string]bool{}
	for _, p := range last {
		names[p.Name] = true
	}
	if !names["server"] || !names["phone"] {
		t.Errorf("the sink got peers %v", names)
	}
}

func TestNamesSinkIsClearedWhenTheNetmapGoesStale(t *testing.T) {
	m, _ := meshNameManager(t, true)
	rec := &namesRecorder{}
	m.SetNamesSink(rec.sink)
	if err := m.Apply(namedDoc(), time.Now()); err != nil {
		t.Fatal(err)
	}
	m.applyMu.Lock()
	m.installMeshDNS(nil, nil)
	m.applyMu.Unlock()
	if n := len(rec.docs); n < 2 || rec.docs[n-1] != nil || len(rec.peers[n-1]) != 0 {
		t.Errorf("after the netmap went stale the sink still holds names: %d calls", len(rec.docs))
	}
}
