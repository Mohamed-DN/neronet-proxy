// Package xrayconf renders the Xray-core configuration of the gateway's VLESS + REALITY
// terminator (ADR 0036).
//
// The gateway, not a person, writes this file. It holds the organisation's REALITY
// parameters and one client per NeroNet device. The attribution rule is built into the
// shape of the file: every client's UUID is routed by its email (the device id) to a
// SOCKS5 outbound that authenticates to the gateway as that device and no other, and
// whatever matches no rule goes to a blackhole. There is no freedom outbound, so nothing
// leaves Xray except through a per-device hop into the gateway's forwarding point.
//
// Output is deterministic, so an unchanged netmap yields identical bytes and does not
// make the terminator restart. The file contains secrets (REALITY private key, SOCKS
// passwords): write it 0600 and never log it. Errors name fields, never values.
package xrayconf

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
)

// Client is one NeroNet device allowed to connect.
type Client struct {
	DeviceID      string // the SOCKS username and the Xray user email
	UUID          string // the VLESS user id the device's app holds
	SocksPassword string // random, known only to the gateway and this file
}

// Spec is everything the file depends on.
type Spec struct {
	ListenPort  uint16
	Dest        string   // REALITY fallback target, host:port
	ServerNames []string // SNI values REALITY accepts
	PrivateKey  string   // REALITY private key, 43 base64url characters
	ShortIDs    []string // even-length hex, at most 16 characters
	SocksHost   string   // where the gateway's device SOCKS listens, as seen from Xray
	SocksPort   uint16
	Clients     []Client
}

var (
	reUUID  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	reKey   = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	reShort = regexp.MustCompile(`^([0-9a-f]{2}){1,8}$`)
	reDev   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

func (s Spec) validate() error {
	switch {
	case s.ListenPort == 0:
		return errors.New("xrayconf: listen port is not set")
	case !reKey.MatchString(s.PrivateKey):
		return errors.New("xrayconf: the REALITY private key is missing or malformed")
	case len(s.ServerNames) == 0:
		return errors.New("xrayconf: no server name")
	case len(s.ShortIDs) == 0:
		return errors.New("xrayconf: no short id")
	case s.SocksHost == "" || s.SocksPort == 0:
		return errors.New("xrayconf: the gateway's SOCKS address is not set")
	}
	if _, port, err := net.SplitHostPort(s.Dest); err != nil || port == "" {
		return errors.New("xrayconf: dest must be host:port")
	}
	for i, sn := range s.ServerNames {
		if sn == "" {
			return fmt.Errorf("xrayconf: server name %d is empty", i)
		}
	}
	for i, id := range s.ShortIDs {
		if !reShort.MatchString(id) {
			return fmt.Errorf("xrayconf: short id %d is not 1 to 8 bytes of hex", i)
		}
	}
	uuids := map[string]bool{}
	devs := map[string]bool{}
	for i, c := range s.Clients {
		switch {
		case !reDev.MatchString(c.DeviceID):
			return fmt.Errorf("xrayconf: client %d has an invalid device id", i)
		case !reUUID.MatchString(c.UUID):
			return fmt.Errorf("xrayconf: client %d has an invalid uuid", i)
		case c.SocksPassword == "":
			return fmt.Errorf("xrayconf: client %d has no SOCKS password", i)
		case uuids[c.UUID]:
			return fmt.Errorf("xrayconf: client %d repeats another client's uuid", i)
		case devs[c.DeviceID]:
			return fmt.Errorf("xrayconf: client %d repeats another client's device id", i)
		}
		uuids[c.UUID] = true
		devs[c.DeviceID] = true
	}
	return nil
}

type obj = map[string]any

// Render returns the configuration as JSON.
func Render(s Spec) ([]byte, error) {
	if err := s.validate(); err != nil {
		return nil, err
	}
	clients := append([]Client(nil), s.Clients...)
	sort.Slice(clients, func(i, j int) bool { return clients[i].DeviceID < clients[j].DeviceID })

	vclients := make([]any, 0, len(clients))
	// The blackhole is first: Xray sends a connection no rule matches to the first
	// outbound, so the default is to refuse.
	outbounds := []any{obj{"tag": "block", "protocol": "blackhole"}}
	rules := make([]any, 0, len(clients)+1)
	for _, c := range clients {
		vclients = append(vclients, obj{"id": c.UUID, "email": c.DeviceID, "flow": "xtls-rprx-vision"})
		tag := "dev-" + c.DeviceID
		outbounds = append(outbounds, obj{
			"tag":      tag,
			"protocol": "socks",
			"settings": obj{"servers": []any{obj{
				"address": s.SocksHost,
				"port":    int(s.SocksPort),
				"users":   []any{obj{"user": c.DeviceID, "pass": c.SocksPassword}},
			}}},
		})
		rules = append(rules, obj{"type": "field", "user": []string{c.DeviceID}, "outboundTag": tag})
	}
	rules = append(rules, obj{"type": "field", "inboundTag": []string{"reality-in"}, "outboundTag": "block"})

	cfg := obj{
		"log": obj{"loglevel": "warning"},
		"inbounds": []any{obj{
			"tag":      "reality-in",
			"listen":   "0.0.0.0",
			"port":     int(s.ListenPort),
			"protocol": "vless",
			"settings": obj{"clients": vclients, "decryption": "none"},
			"streamSettings": obj{
				"network":  "tcp",
				"security": "reality",
				"realitySettings": obj{
					"show":        false,
					"dest":        s.Dest,
					"xver":        0,
					"serverNames": s.ServerNames,
					"privateKey":  s.PrivateKey,
					"shortIds":    s.ShortIDs,
				},
			},
			"sniffing": obj{"enabled": false},
		}},
		"outbounds": outbounds,
		"routing":   obj{"domainStrategy": "AsIs", "rules": rules},
	}
	return json.MarshalIndent(cfg, "", "  ")
}
