package clientcore

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dns"
	"github.com/sovereign/proxy/v4/pkg/meshnode"
)

// Mesh names for the whole computer (ADR 0034). The service answers them itself at the mesh resolver
// address on the tunnel interface, from the names of the netmap in force, and points the system at that
// address for the mesh domains only. A mesh name the netmap does not have is answered NXDOMAIN by the same
// resolver: it is never relayed to any other one. Everything else is refused (REFUSED), so the other
// resolvers of the system keep answering it.

// MeshResolverAddr is where the service answers mesh names. It is the address the gateway answers on for
// stock WireGuard devices, so a name means the same thing on every device.
const MeshResolverAddr = "100.100.100.100"

// Names states.
const (
	NamesOff      = "off"
	NamesOK       = "ok"
	NamesNotSetUp = "not_set_up"
)

// NamesState is what the person is told about mesh names on this computer.
type NamesState struct {
	Status string `json:"status"`
	Method string `json:"method,omitempty"`
	Reason string `json:"reason,omitempty"`
}

var defaultDomains = []string{"mesh", "neronet"}

// osNames sets the resolver of the system up and takes it down. Every step is a command of the host's own
// tools, so that a test can see exactly what would be done.
type osNames struct {
	run               func(stdin, name string, args ...string) error
	have              func(name string) bool
	resolvedRunning   func() bool
	resolvconfManaged func() bool
}

func newOSNames() *osNames {
	return &osNames{
		run: func(stdin, name string, args ...string) error {
			cmd := exec.Command(name, args...)
			if stdin != "" {
				cmd.Stdin = strings.NewReader(stdin)
			}
			var out bytes.Buffer
			cmd.Stdout, cmd.Stderr = &out, &out
			if err := cmd.Start(); err != nil {
				return err
			}
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case err := <-done:
				if err != nil {
					return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(out.String()))
				}
				return nil
			case <-time.After(15 * time.Second):
				_ = cmd.Process.Kill()
				return fmt.Errorf("%s %s: timed out", name, strings.Join(args, " "))
			}
		},
		have: func(name string) bool { _, err := exec.LookPath(name); return err == nil },
		resolvedRunning: func() bool {
			_, err := os.Stat("/run/systemd/resolve/io.systemd.Resolve")
			return err == nil
		},
		resolvconfManaged: func() bool {
			if target, err := os.Readlink("/etc/resolv.conf"); err == nil {
				return strings.Contains(target, "resolvconf")
			}
			b, err := os.ReadFile("/etc/resolv.conf")
			return err == nil && bytes.Contains(bytes.ToLower(b), []byte("resolvconf"))
		},
	}
}

// linkEntry is the name of our entry in resolvconf. It is a local resolver's name ("lo." first), because
// resolvconf puts local resolvers ahead of the interfaces of the network, and that order is what keeps a
// mesh name from reaching the network's resolver before ours has answered it.
func linkEntry(string) string { return "lo.neronet" }

// apply points the system at server for domains, on link only. systemd-resolved first (per link, the mesh
// domains only, never the default route), then resolvconf when it owns /etc/resolv.conf. With neither it
// touches nothing and says why.
func (o *osNames) apply(link, server string, domains []string) NamesState {
	if len(domains) == 0 {
		domains = defaultDomains
	}
	switch {
	case o.have("resolvectl") && o.resolvedRunning():
		route := []string{domains[0]}
		for _, d := range domains[1:] {
			route = append(route, "~"+d)
		}
		steps := [][]string{
			{"dns", link, server},
			append([]string{"domain", link}, route...),
			{"default-route", link, "no"},
		}
		for _, s := range steps {
			if err := o.run("", "resolvectl", s...); err != nil {
				_ = o.run("", "resolvectl", "revert", link)
				return NamesState{Status: NamesNotSetUp, Method: "systemd-resolved", Reason: err.Error()}
			}
		}
		return NamesState{Status: NamesOK, Method: "systemd-resolved"}
	case o.have("resolvconf"):
		if !o.resolvconfManaged() {
			return NamesState{Status: NamesNotSetUp, Method: "resolvconf",
				Reason: "resolvconf is installed but /etc/resolv.conf is not managed by it, so changing it would replace the resolvers the system already has"}
		}
		// An entry left by a service that was killed is replaced, not stacked.
		_ = o.run("", "resolvconf", "-d", linkEntry(link))
		conf := "nameserver " + server + "\nsearch " + strings.Join(domains, " ") + "\n"
		if err := o.run(conf, "resolvconf", "-a", linkEntry(link)); err != nil {
			return NamesState{Status: NamesNotSetUp, Method: "resolvconf", Reason: err.Error()}
		}
		return NamesState{Status: NamesOK, Method: "resolvconf"}
	}
	return NamesState{Status: NamesNotSetUp, Reason: "neither systemd-resolved nor resolvconf was found; mesh names resolve through the app's own proxy only"}
}

// remove takes back what apply set, and only that: other settings are not read, let alone written.
func (o *osNames) remove(link string) error {
	switch {
	case o.have("resolvectl") && o.resolvedRunning():
		return o.run("", "resolvectl", "revert", link)
	case o.have("resolvconf"):
		return o.run("", "resolvconf", "-d", linkEntry(link))
	}
	return nil
}

// NameService answers mesh names and keeps the system pointed at itself while the tunnel is up.
type NameService struct {
	os     *osNames
	listen func(addr string) (net.PacketConn, error)
	srv    *dns.Server

	mu      sync.Mutex
	conn    net.PacketConn
	link    string
	domains []string
	applied bool
	state   NamesState
}

// NewHostNameService builds the service for the real machine.
func NewHostNameService() *NameService { return NewNameService(newOSNames()) }

// NewNameService builds the service on a given way of configuring the system.
func NewNameService(o *osNames) *NameService {
	return &NameService{
		os:      o,
		listen:  func(addr string) (net.PacketConn, error) { return net.ListenPacket("udp4", addr) },
		srv:     dns.NewServer(dns.Config{SingleAnswer: true}),
		domains: append([]string(nil), defaultDomains...),
		state:   NamesState{Status: NamesOff},
	}
}

// Sink is what the node calls with the names of every netmap it applies.
func (n *NameService) Sink() meshnode.NamesSink {
	return func(doc *control.NetmapResponse, peers []control.NetmapPeer) {
		if doc == nil {
			// Nothing holds: every mesh name is unknown, and an unknown one is refused.
			n.srv.UpdateNetmap(control.NetmapSelf{}, nil, nil)
			return
		}
		n.srv.UpdateNetmap(doc.Self, peers, doc.DNS)
		var domains []string
		if doc.DNS != nil {
			for _, d := range doc.DNS.SearchDomains {
				if d = strings.ToLower(strings.Trim(d, ".")); d != "" {
					domains = append(domains, d)
				}
			}
		}
		if len(domains) == 0 {
			domains = defaultDomains
		}
		n.mu.Lock()
		defer n.mu.Unlock()
		if strings.Join(domains, " ") == strings.Join(n.domains, " ") {
			return
		}
		n.domains = domains
		if n.applied {
			n.state = n.os.apply(n.link, MeshResolverAddr, domains)
		}
	}
}

// Start gives link the resolver address, serves on it and points the system at it. A failure is not an
// error: the tunnel does not depend on names, so it is reported in State instead.
func (n *NameService) Start(link string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.conn != nil {
		return nil
	}
	notSetUp := func(reason string) error {
		n.state = NamesState{Status: NamesNotSetUp, Reason: reason}
		return nil
	}
	if err := n.os.run("", "ip", "addr", "add", MeshResolverAddr+"/32", "dev", link); err != nil {
		return notSetUp(err.Error())
	}
	conn, err := n.listen(net.JoinHostPort(MeshResolverAddr, "53"))
	if err != nil {
		return notSetUp("the mesh resolver cannot listen on " + MeshResolverAddr + ":53: " + err.Error())
	}
	st := n.os.apply(link, MeshResolverAddr, n.domains)
	if st.Status != NamesOK {
		_ = conn.Close()
		n.state = st
		return nil
	}
	n.conn, n.link, n.applied, n.state = conn, link, true, st
	go n.serve(conn)
	return nil
}

// Stop takes the settings of the system back and closes the resolver. It can be called any number of times.
func (n *NameService) Stop() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.conn == nil {
		return
	}
	if n.applied {
		_ = n.os.remove(n.link)
	}
	_ = n.conn.Close()
	n.conn, n.applied = nil, false
	n.state = NamesState{Status: NamesOff}
}

// ClearStale removes what an earlier service of ours left behind on link when it was killed: a resolver
// entry that points at an address which is gone. Nothing is reported; there is usually nothing to remove.
func (n *NameService) ClearStale(link string) { _ = n.os.remove(link) }

// State is what the person is told.
func (n *NameService) State() NamesState {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.state
}

func (n *NameService) addr() net.Addr {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.conn == nil {
		return nil
	}
	return n.conn.LocalAddr()
}

func (n *NameService) serve(conn net.PacketConn) {
	buf := make([]byte, 4096)
	for {
		k, from, err := conn.ReadFrom(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		query := append([]byte(nil), buf[:k]...)
		reply, forward := n.srv.AnswerFor(query, nil)
		switch {
		case reply == nil:
			continue
		case forward:
			// Not a name of the mesh, so not ours to answer, and never ours to relay.
			if reply = refusedReply(query); reply == nil {
				continue
			}
		}
		_, _ = conn.WriteTo(reply, from)
	}
}

func refusedReply(query []byte) []byte {
	var m dnsmessage.Message
	if err := m.Unpack(query); err != nil || len(m.Questions) == 0 {
		return nil
	}
	out, err := (&dnsmessage.Message{
		Header:    dnsmessage.Header{ID: m.ID, Response: true, OpCode: m.OpCode, RecursionDesired: m.RecursionDesired, RCode: dnsmessage.RCodeRefused},
		Questions: m.Questions[:1],
	}).Pack()
	if err != nil {
		return nil
	}
	return out
}
