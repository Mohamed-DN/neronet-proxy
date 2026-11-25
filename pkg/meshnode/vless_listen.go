package meshnode

import (
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"

	"github.com/sovereign/proxy/v4/pkg/xrayconf"
)

// Where Xray listens, apart from the port the console is told (ADR 0043).
//
// SOVEREIGN_VLESS_PORT is the public port: it goes into every VLESS link. A gateway on a
// host whose TCP 443 belongs to an SNI router needs Xray on loopback, behind it.
// SOVEREIGN_VLESS_LISTEN (host:port, host an IP address) moves only the socket. Unset, the
// rendered configuration is what every gateway has always had.
//
// SOVEREIGN_VLESS_ACCEPT_PROXY=true makes Xray read a PROXY protocol header, so the per
// address limits see the client and not the router. Anyone who can reach the socket can
// write that header, so it is accepted only with an explicit listen address on loopback.

type vlessListen struct {
	Host        string
	Port        uint16
	AcceptProxy bool
}

func (l vlessListen) set() bool { return l.Host != "" }

// apply overrides the socket of a spec; the zero value changes nothing.
func (l vlessListen) apply(s *xrayconf.Spec) {
	if !l.set() {
		return
	}
	s.ListenHost = l.Host
	s.ListenPort = l.Port
	s.AcceptProxyProtocol = l.AcceptProxy
}

// parseVlessListen validates the two settings. Errors name the setting, never its value.
func parseVlessListen(listen string, acceptProxy bool) (vlessListen, error) {
	listen = strings.TrimSpace(listen)
	if listen == "" {
		if acceptProxy {
			return vlessListen{}, errors.New("SOVEREIGN_VLESS_ACCEPT_PROXY needs SOVEREIGN_VLESS_LISTEN on a loopback address")
		}
		return vlessListen{}, nil
	}
	host, portStr, err := net.SplitHostPort(listen)
	if err != nil {
		return vlessListen{}, errors.New("SOVEREIGN_VLESS_LISTEN must be host:port")
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return vlessListen{}, errors.New("SOVEREIGN_VLESS_LISTEN host must be an IP address")
	}
	port, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil || port == 0 {
		return vlessListen{}, errors.New("SOVEREIGN_VLESS_LISTEN port must be 1 to 65535")
	}
	if acceptProxy && !addr.IsLoopback() {
		return vlessListen{}, errors.New("SOVEREIGN_VLESS_ACCEPT_PROXY is accepted only when SOVEREIGN_VLESS_LISTEN is on loopback")
	}
	return vlessListen{Host: addr.String(), Port: uint16(port), AcceptProxy: acceptProxy}, nil
}

// SetVLESSListen validates the operator's Xray listen settings and records them. Called before
// startVLESS, so a refused setting stops the node before any listener opens. Empty settings keep
// the rendered configuration as it has always been.
func (m *netmapManager) SetVLESSListen(listen string, acceptProxy bool) error {
	vl, err := parseVlessListen(listen, acceptProxy)
	if err != nil {
		return err
	}
	m.applyMu.Lock()
	defer m.applyMu.Unlock()
	m.vless.listen = vl
	return nil
}
