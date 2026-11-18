package dns

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	"github.com/sovereign/proxy/v4/pkg/control"
)

// Default TTL for MagicDNS responses.
const DefaultTTL = 60

// RecordEntry holds IP addresses for a name.
type RecordEntry struct {
	IPv4 []net.IP
	IPv6 []net.IP
}

// Stats holds operational telemetry for the MagicDNS server.
type Stats struct {
	QueriesTotal   uint64 `json:"queries_total"`
	MeshHits       uint64 `json:"mesh_hits"`
	LeaksPrevented uint64 `json:"leaks_prevented"`
	NXDomainCount  uint64 `json:"nxdomain_count"`
	UpstreamRelays uint64 `json:"upstream_relays"`
}

// Config configures the MagicDNS server.
type Config struct {
	// ListenAddr is the UDP address to listen on (e.g. "127.0.0.1:53" or "100.64.0.1:53" or ":0" for dynamic).
	ListenAddr string

	// UpstreamResolver, if non-empty, handles queries outside the mesh domain.
	UpstreamResolver string

	// DefaultSearchDomain is appended to unqualified names (e.g. "corp.neronet").
	DefaultSearchDomain string

	// SingleAnswer makes a name resolve to exactly one device (ADR 0034). When two
	// nodes in a netmap claim the same name, the one with the lowest node id keeps it
	// (the node itself, listed first, before any peer) and the others do not get that
	// name, so a name is never a multi-address record that sends a client to a
	// different device on every lookup. Off, UpdateNetmap appends every address.
	SingleAnswer bool
}

// Server implements a lightweight, leak-preventing MagicDNS resolver.
type Server struct {
	cfg Config

	mu            sync.RWMutex
	records       map[string]*RecordEntry // name -> IPs (case-insensitive, without trailing dot)
	reversePtr    map[string]string       // ip string -> FQDN
	ptrAddr       map[string]netip.Addr   // reverse name -> the address it stands for
	selfAddrs     map[netip.Addr]bool     // this node's own overlay addresses
	searchDomains []string

	conn   *net.UDPConn
	closed atomic.Bool

	// Telemetry counters
	queriesTotal   atomic.Uint64
	meshHits       atomic.Uint64
	leaksPrevented atomic.Uint64
	nxDomainCount  atomic.Uint64
	upstreamRelays atomic.Uint64
}

// NewServer creates a new MagicDNS server instance.
func NewServer(cfg Config) *Server {
	if cfg.DefaultSearchDomain == "" {
		cfg.DefaultSearchDomain = "mesh"
	}
	s := &Server{
		cfg:           cfg,
		records:       make(map[string]*RecordEntry),
		reversePtr:    make(map[string]string),
		ptrAddr:       make(map[string]netip.Addr),
		selfAddrs:     make(map[netip.Addr]bool),
		searchDomains: []string{"mesh", "neronet", strings.Trim(cfg.DefaultSearchDomain, ".")},
	}
	return s
}

// Start begins listening and serving DNS queries over UDP.
func (s *Server) Start() error {
	addr, err := net.ResolveUDPAddr("udp", s.cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("resolving DNS listen address: %w", err)
	}

	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return fmt.Errorf("listening on UDP: %w", err)
	}
	s.conn = conn

	go s.serve()
	return nil
}

// Addr returns the bound UDP address (useful when dynamic port ":0" was passed).
func (s *Server) Addr() *net.UDPAddr {
	if s.conn == nil {
		return nil
	}
	return s.conn.LocalAddr().(*net.UDPAddr)
}

// Close shuts down the server.
func (s *Server) Close() error {
	s.closed.Store(true)
	if s.conn != nil {
		return s.conn.Close()
	}
	return nil
}

// Stats returns a snapshot of server telemetry.
func (s *Server) Stats() Stats {
	return Stats{
		QueriesTotal:   s.queriesTotal.Load(),
		MeshHits:       s.meshHits.Load(),
		LeaksPrevented: s.leaksPrevented.Load(),
		NXDomainCount:  s.nxDomainCount.Load(),
		UpstreamRelays: s.upstreamRelays.Load(),
	}
}

// serve is the read loop for incoming UDP DNS datagrams.
func (s *Server) serve() {
	buf := make([]byte, 4096)
	for {
		n, remoteAddr, err := s.conn.ReadFrom(buf)
		if err != nil {
			if s.closed.Load() {
				return
			}
			continue
		}

		s.queriesTotal.Add(1)

		reqBuf := make([]byte, n)
		copy(reqBuf, buf[:n])

		go s.handleQuery(reqBuf, remoteAddr)
	}
}

// handleQuery answers a datagram received on the server's own socket.
func (s *Server) handleQuery(reqBytes []byte, remoteAddr net.Addr) {
	reply, forward := s.Answer(reqBytes)
	if reply == nil {
		return
	}
	if forward && s.cfg.UpstreamResolver != "" {
		s.relayUpstream(reqBytes, remoteAddr)
		return
	}
	if forward {
		s.nxDomainCount.Add(1)
	}
	_, _ = s.conn.WriteTo(reply, remoteAddr)
}

// Answer evaluates one DNS query without any socket, so a caller with its own
// transport (the profile gateway's userspace stack, ADR 0034) can serve it.
//
// reply is the packed response, or nil when the bytes are not a query to answer. When
// forward is true the name is not the mesh's: reply is then only the NXDOMAIN to send
// if the caller has nowhere to forward the query, and the caller may relay the
// original query to its resolver instead. A name under a mesh search domain, a
// single-label name and a mesh reverse lookup are never forward: an unknown one is
// NXDOMAIN, so it cannot leak to an upstream resolver.
func (s *Server) Answer(reqBytes []byte) (reply []byte, forward bool) {
	return s.AnswerFor(reqBytes, nil)
}

// AnswerFor is Answer for one asker. visible, when not nil, says whether the asker may
// learn that an address exists (ADR 0034): the dataplane passes the source device's
// policy, and this package stays ignorant of what a policy is. A name none of whose
// addresses is visible, and a reverse lookup of an address that is not, are answered
// with the very NXDOMAIN an unknown name gets, so the answer does not reveal that the
// name exists. This server's own addresses are always visible. A visible name still
// lists only its visible addresses. The filter runs on every query and nothing is
// cached, so a policy change shows on the next one.
func (s *Server) AnswerFor(reqBytes []byte, visible func(target netip.Addr) bool) (reply []byte, forward bool) {
	return s.answerFor(reqBytes, visible, false)
}

// AnswerForExit is AnswerFor for a device that has an exit. The one difference: a
// single-label name that is not a mesh name at all (`printer`) is forwarded, so the caller
// can ask the exit's resolver, which may know the LAN behind the exit. A name the mesh
// has, including one this asker's policy hides, is answered here exactly as AnswerFor
// does, and a dotted name under a mesh domain stays NXDOMAIN: none of those is ever
// forwarded.
func (s *Server) AnswerForExit(reqBytes []byte, visible func(target netip.Addr) bool) (reply []byte, forward bool) {
	return s.answerFor(reqBytes, visible, true)
}

func (s *Server) answerFor(reqBytes []byte, visible func(target netip.Addr) bool, forwardBare bool) (reply []byte, forward bool) {
	var msg dnsmessage.Message
	if err := msg.Unpack(reqBytes); err != nil {
		return nil, false
	}

	if len(msg.Questions) == 0 {
		return nil, false
	}

	question := msg.Questions[0]
	rawQName := question.Name.String()
	qName := strings.ToLower(strings.TrimSuffix(rawQName, "."))
	qType := question.Type

	resp := dnsmessage.Message{
		Header: dnsmessage.Header{
			ID:                 msg.ID,
			Response:           true,
			OpCode:             msg.OpCode,
			Authoritative:      true,
			RecursionDesired:   msg.RecursionDesired,
			RecursionAvailable: false,
			RCode:              dnsmessage.RCodeSuccess,
		},
		Questions: []dnsmessage.Question{question},
	}

	// 1. Check if this is an in-mesh or reverse-lookup query
	isMeshDomain := s.isMeshQuery(qName)
	isReverse := strings.HasSuffix(qName, ".in-addr.arpa") || strings.HasSuffix(qName, ".ip6.arpa")

	if isReverse {
		ptr, found := s.lookupPTR(qName)
		if found && !s.addrVisible(s.ptrTarget(qName), visible) {
			found = false
		}
		if found {
			s.meshHits.Add(1)
			ptrName, err := dnsmessage.NewName(ptr + ".")
			if err == nil {
				resp.Answers = append(resp.Answers, dnsmessage.Resource{
					Header: dnsmessage.ResourceHeader{
						Name:  question.Name,
						Type:  dnsmessage.TypePTR,
						Class: dnsmessage.ClassINET,
						TTL:   DefaultTTL,
					},
					Body: &dnsmessage.PTRResource{PTR: ptrName},
				})
			}
		} else {
			// Anti-leak: In-mesh reverse lookups (100.64.x.x / fd00::) MUST NOT be forwarded to external DNS!
			if s.isMeshIPReverse(qName) {
				s.leaksPrevented.Add(1)
				s.nxDomainCount.Add(1)
				resp.Header.RCode = dnsmessage.RCodeNameError
			} else {
				resp.Header.RCode = dnsmessage.RCodeNameError
				forward = true
			}
		}
	} else if isMeshDomain {
		// In-mesh forward query
		entry, found := s.lookupName(qName)
		exists := found
		if found {
			entry = s.visibleEntry(entry, visible)
			found = entry != nil
		}
		if found {
			s.meshHits.Add(1)
			if qType == dnsmessage.TypeA || qType == dnsmessage.TypeALL {
				for _, ip := range entry.IPv4 {
					if ip4 := ip.To4(); ip4 != nil {
						var b [4]byte
						copy(b[:], ip4)
						resp.Answers = append(resp.Answers, dnsmessage.Resource{
							Header: dnsmessage.ResourceHeader{
								Name:  question.Name,
								Type:  dnsmessage.TypeA,
								Class: dnsmessage.ClassINET,
								TTL:   DefaultTTL,
							},
							Body: &dnsmessage.AResource{A: b},
						})
					}
				}
			}
			if qType == dnsmessage.TypeAAAA || qType == dnsmessage.TypeALL {
				for _, ip := range entry.IPv6 {
					if ip16 := ip.To16(); ip16 != nil && ip.To4() == nil {
						var b [16]byte
						copy(b[:], ip16)
						resp.Answers = append(resp.Answers, dnsmessage.Resource{
							Header: dnsmessage.ResourceHeader{
								Name:  question.Name,
								Type:  dnsmessage.TypeAAAA,
								Class: dnsmessage.ClassINET,
								TTL:   DefaultTTL,
							},
							Body: &dnsmessage.AAAAResource{AAAA: b},
						})
					}
				}
			}
		} else if forwardBare && !exists && !strings.Contains(qName, ".") {
			// A device with an exit asked for a bare name the mesh does not have: the exit's
			// resolver may know it (a printer on the LAN behind the exit). The NXDOMAIN is
			// only the fallback if the query cannot be relayed.
			forward = true
			resp.Header.RCode = dnsmessage.RCodeNameError
		} else {
			// ANTI-DNS LEAK CRITICAL GUARANTEE:
			// If an internal mesh domain (.neronet, .mesh, etc.) is not found,
			// respond with NXDOMAIN directly. NEVER leak it to an upstream ISP resolver!
			s.leaksPrevented.Add(1)
			s.nxDomainCount.Add(1)
			resp.Header.RCode = dnsmessage.RCodeNameError
		}
	} else {
		// External domain query (e.g. google.com). Without an upstream the caller
		// answers NXDOMAIN (split DNS without a forwarder).
		forward = true
		resp.Header.RCode = dnsmessage.RCodeNameError
	}

	packed, err := resp.Pack()
	if err != nil {
		return nil, false
	}
	return packed, forward
}

// relayUpstream forwards an external DNS query to the configured upstream resolver.
func (s *Server) relayUpstream(reqBytes []byte, clientAddr net.Addr) {
	s.upstreamRelays.Add(1)

	upConn, err := net.DialTimeout("udp", s.cfg.UpstreamResolver, 2*time.Second)
	if err != nil {
		return
	}
	defer upConn.Close()

	_ = upConn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := upConn.Write(reqBytes); err != nil {
		return
	}

	reply := make([]byte, 4096)
	n, err := upConn.Read(reply)
	if err != nil {
		return
	}

	_, _ = s.conn.WriteTo(reply[:n], clientAddr)
}

// isMeshQuery checks if the queried name targets an in-mesh domain.
func (s *Server) isMeshQuery(name string) bool {
	lower := strings.ToLower(name)
	s.mu.RLock()
	defer s.mu.RUnlock()

	// If no dot, it's an unqualified short name -> treat as mesh query
	if !strings.Contains(lower, ".") {
		return true
	}

	for _, domain := range s.searchDomains {
		if strings.HasSuffix(lower, "."+domain) || lower == domain {
			return true
		}
	}
	return false
}

// isMeshIPReverse checks if a PTR query is within the mesh CGNAT (100.64.0.0/10) or ULA (fd00::/8).
func (s *Server) isMeshIPReverse(qName string) bool {
	// 100.64.0.0/10 maps to .64.100.in-addr.arpa through .127.100.in-addr.arpa
	if strings.HasSuffix(qName, ".in-addr.arpa") {
		parts := strings.Split(strings.TrimSuffix(qName, ".in-addr.arpa"), ".")
		if len(parts) == 4 {
			// parts[3] is first octet, parts[2] is second octet
			if parts[3] == "100" {
				var secondOctet int
				_, err := fmt.Sscanf(parts[2], "%d", &secondOctet)
				if err == nil && secondOctet >= 64 && secondOctet <= 127 {
					return true
				}
			}
		}
	}
	// IPv6 ULA fd00::/8 ends with d.f.ip6.arpa
	if strings.HasSuffix(qName, "d.f.ip6.arpa") {
		return true
	}
	return false
}

// lookupName looks up an entry by short name or FQDN.
func (s *Server) lookupName(name string) (*RecordEntry, bool) {
	lower := strings.ToLower(name)
	s.mu.RLock()
	defer s.mu.RUnlock()

	if entry, ok := s.records[lower]; ok {
		return entry, true
	}

	// Try stripping known search domains
	for _, domain := range s.searchDomains {
		suffix := "." + domain
		if strings.HasSuffix(lower, suffix) {
			short := strings.TrimSuffix(lower, suffix)
			if entry, ok := s.records[short]; ok {
				return entry, true
			}
		}
	}

	return nil, false
}

// ptrTarget returns the address a reverse name stands for.
func (s *Server) ptrTarget(ptrQuery string) netip.Addr {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ptrAddr[strings.ToLower(ptrQuery)]
}

// addrVisible applies the asker's filter to one address. No filter, or one of this
// server's own addresses, is always visible.
func (s *Server) addrVisible(a netip.Addr, visible func(netip.Addr) bool) bool {
	if visible == nil {
		return true
	}
	s.mu.RLock()
	self := s.selfAddrs[a]
	s.mu.RUnlock()
	return self || visible(a)
}

// visibleEntry returns the entry cut down to the addresses the asker may see, or nil
// when none is left.
func (s *Server) visibleEntry(e *RecordEntry, visible func(netip.Addr) bool) *RecordEntry {
	if visible == nil {
		return e
	}
	out := &RecordEntry{}
	keep := func(ips []net.IP) (kept []net.IP) {
		for _, ip := range ips {
			if a, ok := netip.AddrFromSlice(ip); ok && s.addrVisible(a.Unmap(), visible) {
				kept = append(kept, ip)
			}
		}
		return kept
	}
	out.IPv4, out.IPv6 = keep(e.IPv4), keep(e.IPv6)
	if len(out.IPv4) == 0 && len(out.IPv6) == 0 {
		return nil
	}
	return out
}

// lookupPTR returns the FQDN for a reverse DNS query name.
func (s *Server) lookupPTR(ptrQuery string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	target, ok := s.reversePtr[strings.ToLower(ptrQuery)]
	return target, ok
}

// SetRecord registers or updates a direct DNS record in the server.
func (s *Server) SetRecord(name string, ipv4 net.IP, ipv6 net.IP) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.setRecordLocked(name, ipv4, ipv6)
}

func (s *Server) setRecordLocked(name string, ipv4 net.IP, ipv6 net.IP) {
	lower := strings.ToLower(strings.Trim(name, "."))
	entry, ok := s.records[lower]
	if !ok {
		entry = &RecordEntry{}
		s.records[lower] = entry
	}

	if ipv4 != nil {
		entry.IPv4 = appendUniqueIP(entry.IPv4, ipv4)
		// Register reverse PTR: prefer canonical first name (FQDN)
		ptrName := ipv4ToPTR(ipv4)
		if ptrName != "" {
			if _, exists := s.reversePtr[ptrName]; !exists {
				s.reversePtr[ptrName] = lower
				s.recordPTRAddr(ptrName, ipv4)
			}
		}
	}

	if ipv6 != nil {
		entry.IPv6 = appendUniqueIP(entry.IPv6, ipv6)
		ptrName := ipv6ToPTR(ipv6)
		if ptrName != "" {
			if _, exists := s.reversePtr[ptrName]; !exists {
				s.reversePtr[ptrName] = lower
				s.recordPTRAddr(ptrName, ipv6)
			}
		}
	}
}

// recordPTRAddr remembers which address a reverse name stands for, so a filtered
// reverse lookup can ask about the address.
func (s *Server) recordPTRAddr(ptrName string, ip net.IP) {
	if addr, ok := netip.AddrFromSlice(ip); ok {
		s.ptrAddr[ptrName] = addr.Unmap()
	}
}

// UpdateNetmap updates MagicDNS records with the current mesh peer list and DNS config.
func (s *Server) UpdateNetmap(self control.NetmapSelf, peers []control.NetmapPeer, dnsConfig *control.DNSConfig) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Reset records while preserving structure
	s.records = make(map[string]*RecordEntry)
	s.reversePtr = make(map[string]string)
	s.ptrAddr = make(map[string]netip.Addr)
	s.selfAddrs = make(map[netip.Addr]bool)
	for _, a := range []string{self.OverlayIPv4, self.OverlayIPv6} {
		if addr, err := netip.ParseAddr(a); err == nil {
			s.selfAddrs[addr.Unmap()] = true
		}
	}

	var searchDomains []string
	if dnsConfig != nil && len(dnsConfig.SearchDomains) > 0 {
		for _, d := range dnsConfig.SearchDomains {
			cleaned := strings.ToLower(strings.Trim(d, "."))
			if cleaned != "" {
				searchDomains = append(searchDomains, cleaned)
			}
		}
	}
	if len(searchDomains) == 0 {
		searchDomains = []string{"mesh", "neronet"}
	}
	s.searchDomains = searchDomains

	// Candidates in the order they claim a name. Self is listed first; the peers
	// follow by node id when SingleAnswer is on, so the winner of a duplicate name is
	// the same on every node and across netmap documents.
	type candidate struct {
		owner      string
		short, dns string
		v4, v6     net.IP
	}
	cands := []candidate{{
		owner: "<self>", short: self.Name, dns: self.DNSName,
		v4: net.ParseIP(self.OverlayIPv4), v6: net.ParseIP(self.OverlayIPv6),
	}}
	ordered := peers
	if s.cfg.SingleAnswer {
		ordered = append([]control.NetmapPeer(nil), peers...)
		sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].NodeID < ordered[j].NodeID })
	}
	for _, peer := range ordered {
		peerV4, peerV6 := peerHostAddresses(peer.AllowedIPs)
		cands = append(cands, candidate{owner: peer.NodeID, short: peer.Name, dns: peer.DNSName, v4: peerV4, v6: peerV6})
	}

	claimed := make(map[string]string)
	for _, c := range cands {
		for _, name := range extractNames(c.short, c.dns, searchDomains) {
			if s.cfg.SingleAnswer {
				if holder, taken := claimed[name]; taken && holder != c.owner {
					continue
				}
				claimed[name] = c.owner
			}
			s.setRecordLocked(name, c.v4, c.v6)
		}
	}
}

// Lookup performs in-process name resolution using the MagicDNS database.
func (s *Server) Lookup(ctx context.Context, name string) ([]net.IP, error) {
	entry, ok := s.lookupName(name)
	if !ok {
		return nil, errors.New("name not found in mesh")
	}

	var ips []net.IP
	ips = append(ips, entry.IPv4...)
	ips = append(ips, entry.IPv6...)
	if len(ips) == 0 {
		return nil, errors.New("no IP addresses associated with name")
	}
	return ips, nil
}

// Helpers

func extractNames(shortName, fqdn string, searchDomains []string) []string {
	var names []string
	seen := make(map[string]bool)

	add := func(n string) {
		clean := strings.ToLower(strings.Trim(n, "."))
		if clean != "" && !seen[clean] {
			seen[clean] = true
			names = append(names, clean)
		}
	}

	if fqdn != "" {
		add(fqdn)
		// Extract short name from FQDN if not already present
		parts := strings.SplitN(fqdn, ".", 2)
		if len(parts) > 0 {
			add(parts[0])
			for _, d := range searchDomains {
				add(parts[0] + "." + d)
			}
		}
	}

	if shortName != "" {
		add(shortName)
		for _, d := range searchDomains {
			add(shortName + "." + d)
		}
	}

	return names
}

func appendUniqueIP(existing []net.IP, candidate net.IP) []net.IP {
	for _, ip := range existing {
		if ip.Equal(candidate) {
			return existing
		}
	}
	return append(existing, candidate)
}

func ipv4ToPTR(ip net.IP) string {
	ip4 := ip.To4()
	if ip4 == nil {
		return ""
	}
	return fmt.Sprintf("%d.%d.%d.%d.in-addr.arpa", ip4[3], ip4[2], ip4[1], ip4[0])
}

func ipv6ToPTR(ip net.IP) string {
	ip16 := ip.To16()
	if ip16 == nil || ip.To4() != nil {
		return ""
	}
	var sb strings.Builder
	for i := 15; i >= 0; i-- {
		b := ip16[i]
		fmt.Fprintf(&sb, "%x.%x.", b&0x0F, (b>>4)&0x0F)
	}
	sb.WriteString("ip6.arpa")
	return sb.String()
}

var (
	overlayV4 = netip.MustParsePrefix("100.64.0.0/10")
	overlayV6 = netip.MustParsePrefix("fc00::/7")
)

// peerHostAddresses picks the address a peer's name points at. A subnet router lists
// routed prefixes, host routes among them, next to its own overlay /32, so the host
// address inside the overlay range wins; without one, the first host address listed.
func peerHostAddresses(allowed []string) (v4, v6 net.IP) {
	var firstV4, firstV6 netip.Addr
	var overV4, overV6 netip.Addr
	for _, a := range allowed {
		prefix, err := netip.ParsePrefix(a)
		if err != nil {
			continue
		}
		addr := prefix.Addr()
		switch {
		case addr.Is4() && prefix.Bits() == 32:
			if !firstV4.IsValid() {
				firstV4 = addr
			}
			if !overV4.IsValid() && overlayV4.Contains(addr) {
				overV4 = addr
			}
		case addr.Is6() && prefix.Bits() == 128:
			if !firstV6.IsValid() {
				firstV6 = addr
			}
			if !overV6.IsValid() && overlayV6.Contains(addr) {
				overV6 = addr
			}
		}
	}
	pick := func(over, first netip.Addr) net.IP {
		if over.IsValid() {
			return net.IP(over.AsSlice())
		}
		if first.IsValid() {
			return net.IP(first.AsSlice())
		}
		return nil
	}
	return pick(overV4, firstV4), pick(overV6, firstV6)
}
