package meshnode

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// ADR 0042: the gateway measures a real round trip to each profile device it serves. A
// reply is a number; no reply is a null value with its time; a peer without a recent
// handshake is not pinged; closing the device while a ping is in flight records nothing.

type fakePinger struct {
	mu       sync.Mutex
	calls    map[netip.Addr]int
	reply    func(ctx context.Context, dst netip.Addr) (time.Duration, error)
	inflight atomic.Int32
	maxSeen  atomic.Int32
}

func (f *fakePinger) Ping(ctx context.Context, dst netip.Addr) (time.Duration, error) {
	n := f.inflight.Add(1)
	defer f.inflight.Add(-1)
	for {
		old := f.maxSeen.Load()
		if n <= old || f.maxSeen.CompareAndSwap(old, n) {
			break
		}
	}
	f.mu.Lock()
	if f.calls == nil {
		f.calls = map[netip.Addr]int{}
	}
	f.calls[dst]++
	f.mu.Unlock()
	return f.reply(ctx, dst)
}

func (f *fakePinger) count(dst netip.Addr) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[dst]
}

var testNow = time.Unix(1_800_000_000, 0)

func target(id string, host byte, handshakeAgo time.Duration) probeTarget {
	t := probeTarget{PeerID: id, Addr: netip.AddrFrom4([4]byte{100, 64, 40, host})}
	if handshakeAgo >= 0 {
		t.LastHandshake = testNow.Add(-handshakeAgo)
	}
	return t
}

func prober(p pinger) *peerProber {
	pr := newPeerProber(p)
	pr.now = func() time.Time { return testNow }
	pr.timeout = 80 * time.Millisecond
	return pr
}

func answers(d time.Duration) func(context.Context, netip.Addr) (time.Duration, error) {
	return func(context.Context, netip.Addr) (time.Duration, error) { return d, nil }
}

func TestAReplyIsAMeasuredNumberWithItsTime(t *testing.T) {
	pr := prober(&fakePinger{reply: answers(12500 * time.Microsecond)})
	pr.sweep(context.Background(), []probeTarget{target("dev-a", 9, 20*time.Second)})
	s, ok := pr.Sample("dev-a")
	if !ok || s.RTTMillis == nil || *s.RTTMillis != 12.5 {
		t.Fatalf("sample = %+v, want 12.5 ms", s)
	}
	if !s.At.Equal(testNow) {
		t.Fatalf("sample time = %v, want %v", s.At, testNow)
	}
}

func TestATimeoutKeepsTheValueUnknownAndNeverBecomesANumber(t *testing.T) {
	silent := &fakePinger{reply: func(ctx context.Context, _ netip.Addr) (time.Duration, error) {
		<-ctx.Done()
		return 0, ctx.Err()
	}}
	pr := prober(silent)
	pr.sweep(context.Background(), []probeTarget{target("dev-a", 9, 20*time.Second)})
	s, ok := pr.Sample("dev-a")
	if !ok {
		t.Fatal("a ping that was tried and got no reply must leave a sample: the time it was tried")
	}
	if s.RTTMillis != nil {
		t.Fatalf("a timeout recorded %v ms; no reply is not a number", *s.RTTMillis)
	}
	if s.At.IsZero() {
		t.Fatal("no reply must carry the time of the attempt")
	}
}

func TestNoProbeGoesToAPeerWithoutARecentHandshake(t *testing.T) {
	f := &fakePinger{reply: answers(time.Millisecond)}
	pr := prober(f)
	fresh := target("fresh", 1, 30*time.Second)
	stale := target("stale", 2, 10*time.Minute)
	never := target("never", 3, -1)
	// A stale peer that was pinged once while it was connected must not keep that value.
	pr.samples["stale"] = rttSample{At: testNow.Add(-time.Hour)}
	pr.sweep(context.Background(), []probeTarget{fresh, stale, never})
	if f.count(fresh.Addr) != 1 {
		t.Fatalf("fresh peer pinged %d times, want 1", f.count(fresh.Addr))
	}
	if f.count(stale.Addr) != 0 || f.count(never.Addr) != 0 {
		t.Fatalf("a peer without a recent handshake was pinged (stale %d, never %d)", f.count(stale.Addr), f.count(never.Addr))
	}
	if _, ok := pr.Sample("stale"); ok {
		t.Fatal("the value from before the connection ended was kept")
	}
	if _, ok := pr.Sample("never"); ok {
		t.Fatal("a peer that never handshook has a sample")
	}
}

func TestConcurrencyIsBounded(t *testing.T) {
	f := &fakePinger{reply: func(ctx context.Context, _ netip.Addr) (time.Duration, error) {
		time.Sleep(20 * time.Millisecond)
		return time.Millisecond, nil
	}}
	pr := prober(f)
	pr.concurrency = 3
	var targets []probeTarget
	for i := 1; i <= 24; i++ {
		targets = append(targets, target(fmt.Sprintf("dev-%d", i), byte(i), 10*time.Second))
	}
	pr.sweep(context.Background(), targets)
	if got := f.maxSeen.Load(); got > 3 || got < 2 {
		t.Fatalf("max pings in flight = %d, want between 2 and 3", got)
	}
	for _, tg := range targets {
		if _, ok := pr.Sample(tg.PeerID); !ok {
			t.Fatalf("%s was never measured", tg.PeerID)
		}
	}
}

func TestClosingTheDeviceWhileProbingRecordsNothingAndDoesNotBlock(t *testing.T) {
	started := make(chan struct{}, 1)
	f := &fakePinger{reply: func(ctx context.Context, _ netip.Addr) (time.Duration, error) {
		select {
		case started <- struct{}{}:
		default:
		}
		<-ctx.Done()
		return 0, dataplane.ErrClosed
	}}
	pr := prober(f)
	pr.timeout = 5 * time.Second
	done := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		pr.sweep(ctx, []probeTarget{target("dev-a", 9, 10*time.Second)})
		close(done)
	}()
	<-started
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("sweep did not return after the node began shutting down")
	}
	if _, ok := pr.Sample("dev-a"); ok {
		t.Fatal("a ping interrupted by shutdown was recorded; it says nothing about the device")
	}

	closed := &fakePinger{reply: func(context.Context, netip.Addr) (time.Duration, error) { return 0, dataplane.ErrClosed }}
	pr2 := prober(closed)
	pr2.sweep(context.Background(), []probeTarget{target("dev-b", 9, 10*time.Second)})
	if _, ok := pr2.Sample("dev-b"); ok {
		t.Fatal("a closed device was recorded as a peer that did not reply")
	}
}

func TestAModeThatCannotPingIsNotMeasuredRatherThanNoReply(t *testing.T) {
	pr := prober(&fakePinger{reply: func(context.Context, netip.Addr) (time.Duration, error) {
		return 0, fmt.Errorf("%w: tun", dataplane.ErrPingUnsupported)
	}})
	pr.sweep(context.Background(), []probeTarget{target("dev-a", 9, 10*time.Second)})
	if _, ok := pr.Sample("dev-a"); ok {
		t.Fatal("a mode that cannot ping reported a 'no reply'")
	}
}

func TestRunSweepsRepeatedlyWithJitterAndStopsWithItsContext(t *testing.T) {
	f := &fakePinger{reply: answers(time.Millisecond)}
	pr := prober(f)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		pr.Run(ctx, func() []probeTarget { return []probeTarget{target("dev-a", 9, 5*time.Second)} }, 20*time.Millisecond)
		close(done)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for f.count(netip.AddrFrom4([4]byte{100, 64, 40, 9})) < 3 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not stop")
	}
	if got := f.count(netip.AddrFrom4([4]byte{100, 64, 40, 9})); got < 3 {
		t.Fatalf("pinged %d times, want at least 3", got)
	}
	for _, r := range []float64{0, 0.5, 0.999} {
		d := jittered(probeInterval, func() float64 { return r })
		if d < time.Duration(0.79*float64(probeInterval)) || d > time.Duration(1.21*float64(probeInterval)) {
			t.Fatalf("jittered(%v) = %v outside +-20%%", probeInterval, d)
		}
	}
	if jittered(probeInterval, func() float64 { return 0 }) == jittered(probeInterval, func() float64 { return 1 }) {
		t.Fatal("jitter does nothing")
	}
}

func TestTargetsAreTheProfileDevicesThisGatewayCanReach(t *testing.T) {
	peers := []control.NetmapPeer{
		{NodeID: "mesh", PublicKeyHex: meshKeyHex, AllowedIPs: []string{"100.64.40.2/32"}},
		{NodeID: "dev-phone", PublicKeyHex: profileKeyHex, AllowedIPs: []string{"100.64.40.9/32", "fd00::9/128"}, Profile: true},
		{NodeID: "dev-awg", PublicKeyHex: "4444444444444444444444444444444444444444444444444444444444444444",
			AllowedIPs: []string{"100.64.40.10/32"}, Profile: true, AccessMethod: "amneziawg"},
		{NodeID: "dev-subnet", PublicKeyHex: "5555555555555555555555555555555555555555555555555555555555555555",
			AllowedIPs: []string{"10.0.0.0/24"}, Profile: true},
	}
	shake := testNow.Add(-10 * time.Second)
	statuses := []dataplane.PeerStatus{{PublicKey: profileKeyHex, LastHandshake: shake}}
	got := profileProbeTargets(peers, nil, false, statuses)
	if len(got) != 1 || got[0].PeerID != "dev-phone" || got[0].Addr != netip.MustParseAddr("100.64.40.9") || !got[0].LastHandshake.Equal(shake) {
		t.Fatalf("targets = %+v, want only dev-phone at 100.64.40.9 (mesh peers, AmneziaWG devices and addressless peers are not pinged)", got)
	}
	if revoked := profileProbeTargets(peers, map[string]uint64{profileKeyHex: 1}, false, statuses); len(revoked) != 0 {
		t.Fatalf("a revoked device is a target: %+v", revoked)
	}
	if closed := profileProbeTargets(peers, nil, true, statuses); len(closed) != 0 {
		t.Fatalf("a fail-closed node has targets: %+v", closed)
	}
}

func TestTheHeartbeatReportCarriesTheSampleOnlyForProfileDevices(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	statuses := []dataplane.PathStatus{
		{PeerStatus: dataplane.PeerStatus{PublicKey: profileKeyHex, LastHandshake: now.Add(-20 * time.Second)}},
		{PeerStatus: dataplane.PeerStatus{PublicKey: meshKeyHex}},
	}
	ms := 7.5
	view := stubRTT{"dev-phone": {RTTMillis: &ms, At: now.Add(-2 * time.Second)}, "node-mesh": {RTTMillis: &ms, At: now}}
	got := peerPathReport(profileDoc(), nil, false, statuses, noPaths{}, view, now)
	byID := map[string]control.PeerPathObservation{}
	for _, o := range got {
		byID[o.PeerID] = o
	}
	phone := byID["dev-phone"]
	if phone.RTTMillis == nil || *phone.RTTMillis != 7.5 || phone.RTTObservedAtUnix == nil || *phone.RTTObservedAtUnix != now.Add(-2*time.Second).Unix() {
		t.Fatalf("profile observation = %+v, want 7.5 ms at now-2s", phone)
	}
	if mesh := byID["node-mesh"]; mesh.RTTMillis != nil || mesh.RTTObservedAtUnix != nil {
		t.Fatalf("a mesh peer reported a round trip this gateway did not measure: %+v", mesh)
	}

	view["dev-phone"] = rttSample{At: now.Add(-1 * time.Second)}
	phone = func() control.PeerPathObservation {
		for _, o := range peerPathReport(profileDoc(), nil, false, statuses, noPaths{}, view, now) {
			if o.PeerID == "dev-phone" {
				return o
			}
		}
		return control.PeerPathObservation{}
	}()
	if phone.RTTMillis != nil || phone.RTTObservedAtUnix == nil {
		t.Fatalf("no reply = %+v, want a null value with a sample time", phone)
	}
	none := peerPathReport(profileDoc(), nil, false, statuses, noPaths{}, stubRTT{}, now)
	for _, o := range none {
		if o.RTTObservedAtUnix != nil {
			t.Fatalf("%s carries a sample time though nothing was pinged", o.PeerID)
		}
	}
}

type stubRTT map[string]rttSample

func (s stubRTT) Sample(id string) (rttSample, bool) { v, ok := s[id]; return v, ok }

// The console's connection test: the poll hands over a request, the gateway pings now and
// answers once, and a peer it does not serve, or one without a recent handshake, is
// answered "no reply" without a ping.
type fakeSource struct {
	mu      sync.Mutex
	pending [][]control.ProbeRequest
	results []control.ProbeResult
	polls   int
}

func (f *fakeSource) PollProbes(ctx context.Context) ([]control.ProbeRequest, error) {
	f.mu.Lock()
	f.polls++
	var out []control.ProbeRequest
	if len(f.pending) > 0 {
		out, f.pending = f.pending[0], f.pending[1:]
		f.mu.Unlock()
		return out, nil
	}
	f.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(10 * time.Millisecond):
		return nil, nil
	}
}

func (f *fakeSource) SendProbeResult(_ context.Context, r control.ProbeResult) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.results = append(f.results, r)
	return nil
}

func (f *fakeSource) answered() []control.ProbeResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]control.ProbeResult(nil), f.results...)
}

func TestTheConnectionTestPingsNowAndAnswersOnce(t *testing.T) {
	f := &fakePinger{reply: func(_ context.Context, dst netip.Addr) (time.Duration, error) {
		if dst == netip.MustParseAddr("100.64.40.1") {
			return 4250 * time.Microsecond, nil
		}
		return 0, context.DeadlineExceeded
	}}
	pr := prober(f)
	targets := func() []probeTarget {
		return []probeTarget{target("up", 1, 10*time.Second), target("silent", 2, 10*time.Second), target("stale", 3, 20*time.Minute)}
	}
	src := &fakeSource{pending: [][]control.ProbeRequest{{
		{RequestID: "r1", PeerID: "up"}, {RequestID: "r2", PeerID: "silent"},
		{RequestID: "r3", PeerID: "stale"}, {RequestID: "r4", PeerID: "not-mine"},
	}}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { probePollLoop(ctx, src, pr, targets, 10*time.Millisecond); close(done) }()
	deadline := time.Now().Add(2 * time.Second)
	for len(src.answered()) < 4 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	byID := map[string]control.ProbeResult{}
	for _, r := range src.answered() {
		if _, dup := byID[r.RequestID]; dup {
			t.Fatalf("request %s answered twice", r.RequestID)
		}
		byID[r.RequestID] = r
	}
	if r := byID["r1"]; !r.Replied || r.RTTMillis == nil || *r.RTTMillis != 4.25 {
		t.Fatalf("r1 = %+v, want replied 4.25 ms", r)
	}
	for _, id := range []string{"r2", "r3", "r4"} {
		if r := byID[id]; r.Replied || r.RTTMillis != nil {
			t.Fatalf("%s = %+v, want no reply and no number", id, r)
		}
	}
	if f.count(netip.MustParseAddr("100.64.40.3")) != 0 {
		t.Fatal("the stale peer was pinged for the connection test")
	}
}

func TestThePollLoopIdlesWhenThereIsNoDeviceAndBacksOffAfterAFailure(t *testing.T) {
	src := &fakeSource{}
	pr := prober(&fakePinger{reply: answers(time.Millisecond)})
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	probePollLoop(ctx, src, pr, func() []probeTarget { return nil }, 20*time.Millisecond)
	if src.polls != 0 {
		t.Fatalf("polled %d times with no profile device to serve", src.polls)
	}

	failing := &failingSource{}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel2()
	probePollLoop(ctx2, failing, pr, func() []probeTarget { return []probeTarget{target("a", 1, time.Second)} }, 50*time.Millisecond)
	if n := failing.calls.Load(); n < 2 || n > 6 {
		t.Fatalf("a failing control plane was asked %d times in 200 ms with a 50 ms back-off", n)
	}
}

type failingSource struct{ calls atomic.Int32 }

func (f *failingSource) PollProbes(context.Context) ([]control.ProbeRequest, error) {
	f.calls.Add(1)
	return nil, errors.New("control plane down")
}
func (f *failingSource) SendProbeResult(context.Context, control.ProbeResult) error { return nil }
