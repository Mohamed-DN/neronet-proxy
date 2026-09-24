package control

import (
	"encoding/json"
	"testing"
)

func FuzzNetmapResponse(f *testing.F) {
	valid := NetmapResponse{
		Version:   42,
		Unchanged: false,
		Self: NetmapSelf{
			OverlayIPv4: "100.64.0.1",
			OverlayIPv6: "fd7a:115c:a1e0::1",
			MTU:         1380,
			ListenPort:  51820,
			Transport:   "wireguard",
		},
		Peers: []NetmapPeer{
			{
				NodeID:       "node-peer-1",
				PublicKeyHex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				AllowedIPs:   []string{"100.64.0.2/32"},
				Transport:    "wireguard",
			},
		},
	}

	raw, err := json.Marshal(valid)
	if err == nil {
		f.Add(raw)
	}

	f.Add([]byte("{}"))
	f.Add([]byte("[]"))
	f.Add([]byte("null"))
	f.Add([]byte("{\"version\": \"not-a-number\"}"))
	f.Add([]byte("{\"peers\": [null, 123, \"invalid\"]}"))

	f.Fuzz(func(t *testing.T, data []byte) {
		var resp NetmapResponse
		_ = json.Unmarshal(data, &resp)
	})
}
