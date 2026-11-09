package main

// Pure planning and parsing: nothing here touches the kernel, so it is unit-tested without root.

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/sovereign/proxy/v4/pkg/profile"
)

// tunName is the TUN interface the client creates. One tunnel runs per host.
const tunName = "neronet0"

// nftTable is the nftables table the kill switch lives in (inet family, so IPv4 and IPv6).
const nftTable = "neronet"

// tunnelRoutes returns one route per AllowedIPs prefix, masked and de-duplicated, in profile
// order. A prefix equal to one of the interface's own addresses is left out: adding the
// address already installs that connected route, and a second one would only fail.
func tunnelRoutes(p *profile.Profile) []netip.Prefix {
	own := make(map[netip.Prefix]bool, len(p.Addresses))
	for _, a := range p.Addresses {
		own[a.Masked()] = true
	}
	seen := make(map[netip.Prefix]bool)
	var out []netip.Prefix
	for _, peer := range p.Peers {
		for _, a := range peer.AllowedIPs {
			m := a.Masked()
			if seen[m] || own[m] {
				continue
			}
			seen[m] = true
			out = append(out, m)
		}
	}
	return out
}

// routeEntry is one unicast route of the main table, as the kernel reports it.
type routeEntry struct {
	Dst      netip.Prefix
	Gateway  netip.Addr // invalid when the route is on-link
	OutIf    uint32
	Priority uint32
}

// bypassFor picks the route an endpoint uses outside the tunnel: the longest prefix that
// contains it, ignoring routes through the tunnel interface. Equal prefixes go to the lower
// priority. It reports false when the endpoint has no route at all.
func bypassFor(endpoint netip.Addr, routes []routeEntry, tunIf uint32) (routeEntry, bool) {
	var best routeEntry
	found := false
	for _, r := range routes {
		if r.OutIf == tunIf || r.Dst.Addr().BitLen() != endpoint.BitLen() || !r.Dst.Contains(endpoint) {
			continue
		}
		if !found || r.Dst.Bits() > best.Dst.Bits() ||
			(r.Dst.Bits() == best.Dst.Bits() && r.Priority < best.Priority) {
			best = r
			found = true
		}
	}
	return best, found
}

// validIfaceName reports whether name is usable as a Linux interface name in an nft rule.
func validIfaceName(name string) bool {
	if name == "" || len(name) > 15 {
		return false
	}
	for _, c := range name {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// killSwitchRuleset returns the nft script for the kill switch. Output is dropped unless it
// goes to loopback, to the tunnel interface, or to a peer endpoint over UDP (WireGuard's
// transport). Input is not filtered: the device's replies come in on the physical link.
func killSwitchRuleset(iface string, endpoints []netip.AddrPort) (string, error) {
	if !validIfaceName(iface) {
		return "", fmt.Errorf("interface name %q cannot be used in a firewall rule", iface)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "table inet %s {\n", nftTable)
	b.WriteString("\tchain output {\n")
	b.WriteString("\t\ttype filter hook output priority filter; policy drop;\n")
	b.WriteString("\t\toifname \"lo\" accept\n")
	fmt.Fprintf(&b, "\t\toifname \"%s\" accept\n", iface)
	for _, ep := range endpoints {
		family := "ip"
		if ep.Addr().Is6() {
			family = "ip6"
		}
		fmt.Fprintf(&b, "\t\t%s daddr %s udp dport %d accept\n", family, ep.Addr(), ep.Port())
	}
	b.WriteString("\t}\n}\n")
	return b.String(), nil
}

// dnsCommands returns the resolvectl arguments that send all DNS queries to the tunnel's
// servers: the servers on the link, and the routing domain "~." (every name).
func dnsCommands(iface string, servers []netip.Addr) [][]string {
	dns := []string{"dns", iface}
	for _, s := range servers {
		dns = append(dns, s.String())
	}
	return [][]string{dns, {"domain", iface, "~."}}
}

// resolveEndpoints turns each peer's Endpoint host into an address. It returns the UAPI
// endpoint strings in peer order (empty for a peer without an endpoint) and the resolved
// endpoints that exist.
func resolveEndpoints(ctx context.Context, p *profile.Profile) ([]string, []netip.AddrPort, error) {
	uapi := make([]string, len(p.Peers))
	var resolved []netip.AddrPort
	for i, peer := range p.Peers {
		if peer.Endpoint == "" {
			continue
		}
		host, portStr, err := net.SplitHostPort(peer.Endpoint)
		if err != nil {
			return nil, nil, fmt.Errorf("endpoint %q: %w", peer.Endpoint, err)
		}
		port, err := strconv.ParseUint(portStr, 10, 16)
		if err != nil || port == 0 {
			return nil, nil, fmt.Errorf("endpoint %q: bad port", peer.Endpoint)
		}
		addr, err := resolveHost(ctx, host)
		if err != nil {
			return nil, nil, err
		}
		ap := netip.AddrPortFrom(addr, uint16(port))
		uapi[i] = ap.String()
		resolved = append(resolved, ap)
	}
	return uapi, resolved, nil
}

// resolveHost returns an IP for host. IP literals are used as they are; names are looked up
// with the platform resolver, preferring IPv4.
func resolveHost(ctx context.Context, host string) (netip.Addr, error) {
	if a, err := netip.ParseAddr(host); err == nil {
		return a.Unmap(), nil
	}
	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return netip.Addr{}, fmt.Errorf("resolving peer endpoint %s: %w", host, err)
	}
	if len(addrs) == 0 {
		return netip.Addr{}, fmt.Errorf("resolving peer endpoint %s: no addresses", host)
	}
	for _, a := range addrs {
		if a.Unmap().Is4() {
			return a.Unmap(), nil
		}
	}
	return addrs[0].Unmap(), nil
}

// peerStatus is one peer as the device reports it through UAPI "get". No key that is secret
// is kept: the private key and the preshared key are dropped while parsing.
type peerStatus struct {
	PublicKey     string // base64
	Endpoint      string
	LastHandshake time.Time // zero when there has been no handshake
	RxBytes       uint64
	TxBytes       uint64
	Keepalive     int
	AllowedIPs    []string
}

// deviceStatus is the device-level part of a UAPI "get" reply.
type deviceStatus struct {
	ListenPort int
	Peers      []peerStatus
}

// parseUAPIGet parses a wireguard-go UAPI "get=1" reply: key=value lines, a blank line ends it.
func parseUAPIGet(r io.Reader) (deviceStatus, error) {
	var ds deviceStatus
	var (
		cur           peerStatus
		inPeer        bool
		hsSec, hsNsec int64
	)
	finish := func() {
		if !inPeer {
			return
		}
		if hsSec != 0 || hsNsec != 0 {
			cur.LastHandshake = time.Unix(hsSec, hsNsec)
		}
		ds.Peers = append(ds.Peers, cur)
		cur, inPeer, hsSec, hsNsec = peerStatus{}, false, 0, 0
	}

	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			break
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return ds, fmt.Errorf("uapi: malformed line %q", line)
		}
		var err error
		switch k {
		case "errno":
			if v != "0" {
				return ds, fmt.Errorf("uapi: device reported errno %s", v)
			}
		case "listen_port":
			ds.ListenPort, err = strconv.Atoi(v)
		case "public_key":
			finish()
			inPeer = true
			var raw []byte
			raw, err = hex.DecodeString(v)
			cur.PublicKey = base64.StdEncoding.EncodeToString(raw)
		case "endpoint":
			cur.Endpoint = v
		case "last_handshake_time_sec":
			hsSec, err = strconv.ParseInt(v, 10, 64)
		case "last_handshake_time_nsec":
			hsNsec, err = strconv.ParseInt(v, 10, 64)
		case "rx_bytes":
			cur.RxBytes, err = strconv.ParseUint(v, 10, 64)
		case "tx_bytes":
			cur.TxBytes, err = strconv.ParseUint(v, 10, 64)
		case "persistent_keepalive_interval":
			cur.Keepalive, err = strconv.Atoi(v)
		case "allowed_ip":
			cur.AllowedIPs = append(cur.AllowedIPs, v)
		case "private_key", "preshared_key":
			// Secrets: read past them, never stored.
		default:
			// Keys from newer wireguard-go versions are ignored.
		}
		if err != nil {
			return ds, fmt.Errorf("uapi: %s: %w", k, err)
		}
	}
	if err := sc.Err(); err != nil {
		return ds, err
	}
	finish()
	return ds, nil
}
