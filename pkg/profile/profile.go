// Package profile reads a NeroNet profile: a standard wg-quick configuration with NeroNet
// metadata in comment lines (ADR 0029). Every WireGuard implementation reads the same file;
// our apps also read the metadata, for instance the console address behind their "Open the
// console" button.
//
// The parser is strict on purpose. A profile is applied by a privileged process, so a key
// it does not understand (wg-quick's PostUp, for one, runs a shell command) is an error, not
// something to skip.
package profile

import (
	"bufio"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// SupportedVersion is the newest NeroNet-Profile version this code understands.
const SupportedVersion = 1

// Key is a WireGuard key: 32 bytes.
type Key [32]byte

// Peer is one [Peer] section.
type Peer struct {
	PublicKey           Key
	PresharedKey        *Key
	Endpoint            string
	AllowedIPs          []netip.Prefix
	PersistentKeepalive int
}

// Profile is a parsed NeroNet profile. Version 0 means a plain WireGuard file.
type Profile struct {
	Version    int
	ConsoleURL string
	DeviceID   string

	PrivateKey Key
	Addresses  []netip.Prefix
	DNS        []netip.Addr
	ListenPort int
	MTU        int
	Peers      []Peer
}

func parseKey(field, value string) (Key, error) {
	var k Key
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
	if err != nil || len(raw) != len(k) {
		return k, fmt.Errorf("profile: %s is not a 32-byte base64 key", field)
	}
	copy(k[:], raw)
	return k, nil
}

func parsePrefixes(field, value string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		p, err := netip.ParsePrefix(part)
		if err != nil {
			return nil, fmt.Errorf("profile: %s %q: %v", field, part, err)
		}
		out = append(out, p)
	}
	return out, nil
}

func parseInt(field, value string, max int) (int, error) {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n < 0 || n > max {
		return 0, fmt.Errorf("profile: %s must be an integer from 0 to %d", field, max)
	}
	return n, nil
}

func (p *Profile) metadata(key, value string) error {
	switch key {
	case "NeroNet-Profile":
		v, err := parseInt(key, value, 1<<16)
		if err != nil {
			return err
		}
		if v < 1 || v > SupportedVersion {
			return fmt.Errorf("profile: version %d is not supported (newest: %d); update the app", v, SupportedVersion)
		}
		p.Version = v
	case "NeroNet-Console":
		u, err := url.Parse(value)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return fmt.Errorf("profile: NeroNet-Console must be an https URL")
		}
		p.ConsoleURL = value
	case "NeroNet-Device":
		p.DeviceID = value
	}
	// Other NeroNet-* lines are left for newer apps; plain comments are comments.
	return nil
}

// Parse reads a profile. It refuses anything it would otherwise apply wrongly.
func Parse(r io.Reader) (*Profile, error) {
	p := &Profile{}
	var section string
	var peer *Peer
	sawPrivateKey := false
	peerHasKey := map[int]bool{}

	sc := bufio.NewScanner(r)
	line := 0
	for sc.Scan() {
		line++
		text := strings.TrimSpace(sc.Text())
		if text == "" {
			continue
		}
		if strings.HasPrefix(text, "#") {
			body := strings.TrimSpace(strings.TrimPrefix(text, "#"))
			if k, v, ok := strings.Cut(body, ":"); ok && strings.HasPrefix(k, "NeroNet-") {
				if err := p.metadata(strings.TrimSpace(k), strings.TrimSpace(v)); err != nil {
					return nil, err
				}
			}
			continue
		}
		if strings.HasPrefix(text, "[") {
			switch strings.ToLower(text) {
			case "[interface]":
				section = "interface"
			case "[peer]":
				section = "peer"
				p.Peers = append(p.Peers, Peer{})
				peer = &p.Peers[len(p.Peers)-1]
			default:
				return nil, fmt.Errorf("profile: line %d: unknown section %s", line, text)
			}
			continue
		}
		k, v, ok := strings.Cut(text, "=")
		if !ok {
			return nil, fmt.Errorf("profile: line %d: expected key = value", line)
		}
		key := strings.ToLower(strings.TrimSpace(k))
		value := strings.TrimSpace(v)
		var err error
		switch section + "." + key {
		case "interface.privatekey":
			p.PrivateKey, err = parseKey("PrivateKey", value)
			sawPrivateKey = err == nil
		case "interface.address":
			var ps []netip.Prefix
			ps, err = parsePrefixes("Address", value)
			p.Addresses = append(p.Addresses, ps...)
		case "interface.dns":
			for _, part := range strings.Split(value, ",") {
				a, e := netip.ParseAddr(strings.TrimSpace(part))
				if e != nil {
					// wg-quick also accepts search domains here; NeroNet profiles do not use them.
					return nil, fmt.Errorf("profile: line %d: DNS %q is not an address", line, strings.TrimSpace(part))
				}
				p.DNS = append(p.DNS, a)
			}
		case "interface.listenport":
			p.ListenPort, err = parseInt("ListenPort", value, 65535)
		case "interface.mtu":
			p.MTU, err = parseInt("MTU", value, 65535)
		case "peer.publickey":
			peer.PublicKey, err = parseKey("PublicKey", value)
			peerHasKey[len(p.Peers)-1] = err == nil
		case "peer.presharedkey":
			var k Key
			k, err = parseKey("PresharedKey", value)
			peer.PresharedKey = &k
		case "peer.endpoint":
			if _, _, e := splitHostPort(value); e != nil {
				err = fmt.Errorf("profile: Endpoint %q: %v", value, e)
			}
			peer.Endpoint = value
		case "peer.allowedips":
			var ps []netip.Prefix
			ps, err = parsePrefixes("AllowedIPs", value)
			peer.AllowedIPs = append(peer.AllowedIPs, ps...)
		case "peer.persistentkeepalive":
			if strings.EqualFold(value, "off") {
				peer.PersistentKeepalive = 0
			} else {
				peer.PersistentKeepalive, err = parseInt("PersistentKeepalive", value, 65535)
			}
		default:
			return nil, fmt.Errorf("profile: line %d: %q is not supported in a NeroNet profile", line, strings.TrimSpace(k))
		}
		if err != nil {
			return nil, fmt.Errorf("profile: line %d: %w", line, err)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if !sawPrivateKey {
		return nil, fmt.Errorf("profile: [Interface] has no PrivateKey")
	}
	if len(p.Peers) == 0 {
		return nil, fmt.Errorf("profile: no [Peer]")
	}
	for i := range p.Peers {
		if !peerHasKey[i] {
			return nil, fmt.Errorf("profile: peer %d has no PublicKey", i+1)
		}
	}
	return p, nil
}

func splitHostPort(endpoint string) (string, int, error) {
	i := strings.LastIndex(endpoint, ":")
	if i <= 0 || i == len(endpoint)-1 {
		return "", 0, fmt.Errorf("want host:port")
	}
	port, err := strconv.Atoi(endpoint[i+1:])
	if err != nil || port < 1 || port > 65535 {
		return "", 0, fmt.Errorf("bad port")
	}
	return strings.Trim(endpoint[:i], "[]"), port, nil
}

// UAPI renders the profile as a wireguard-go IPC "set" body. Each peer's endpoint must be
// given already resolved (host names are resolved by the caller, which knows the platform's
// resolver and whether the tunnel's own DNS is up yet); an empty string leaves it unset.
func (p *Profile) UAPI(resolvedEndpoints ...string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "private_key=%s\n", hex.EncodeToString(p.PrivateKey[:]))
	if p.ListenPort > 0 {
		fmt.Fprintf(&b, "listen_port=%d\n", p.ListenPort)
	}
	b.WriteString("replace_peers=true\n")
	for i, peer := range p.Peers {
		fmt.Fprintf(&b, "public_key=%s\n", hex.EncodeToString(peer.PublicKey[:]))
		if peer.PresharedKey != nil {
			fmt.Fprintf(&b, "preshared_key=%s\n", hex.EncodeToString(peer.PresharedKey[:]))
		}
		if i < len(resolvedEndpoints) && resolvedEndpoints[i] != "" {
			fmt.Fprintf(&b, "endpoint=%s\n", resolvedEndpoints[i])
		}
		fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", peer.PersistentKeepalive)
		b.WriteString("replace_allowed_ips=true\n")
		for _, a := range peer.AllowedIPs {
			fmt.Fprintf(&b, "allowed_ip=%s\n", a)
		}
	}
	return b.String()
}

// String describes the profile without any secret, for logs and status output.
func (p *Profile) String() string {
	peers := make([]string, 0, len(p.Peers))
	for _, peer := range p.Peers {
		peers = append(peers, fmt.Sprintf("%s via %s", base64.StdEncoding.EncodeToString(peer.PublicKey[:])[:8]+"…", peer.Endpoint))
	}
	return fmt.Sprintf("NeroNet profile v%d device=%s addresses=%v dns=%v peers=[%s]",
		p.Version, p.DeviceID, p.Addresses, p.DNS, strings.Join(peers, ", "))
}
