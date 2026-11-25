//go:build awg

package meshnode

import (
	"encoding/hex"
	"fmt"
	"net"
	"net/netip"
	"path/filepath"
	"testing"
	"time"

	awgconn "github.com/amnezia-vpn/amneziawg-go/conn"
	awgdevice "github.com/amnezia-vpn/amneziawg-go/device"
	"github.com/amnezia-vpn/amneziawg-go/tun/tuntest"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// The whole path on the node: a netmap that carries the organisation's parameters and puts a
// profile device on AmneziaWG makes the manager start the device on the operator's port,
// carry that device on it, and an amneziawg-go client built from the same values handshake.

func freeUDPPort(t *testing.T) uint16 {
	t.Helper()
	c, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return uint16(c.LocalAddr().(*net.UDPAddr).Port)
}

func TestNetmapStartsTheRealAmneziaWGDeviceAndAClientHandshakes(t *testing.T) {
	gwKeys, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	dev, err := dataplane.New(dataplane.Config{
		Mode:       dataplane.ModeNetstack,
		PrivateKey: gwKeys.PrivateKey,
		Addresses:  []netip.Prefix{netip.MustParsePrefix("100.64.40.1/10")},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dev.Close() })

	port := freeUDPPort(t)
	m := newNetmapManager(nil, dev, acl.NewNetstackFilter(), filepath.Join(t.TempDir(), "identity"), 51820, "", [32]byte{}, nil)
	m.SetAWG(port, nil)

	clientKeys, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	clientPub := hex.EncodeToString(clientKeys.PublicKey[:])
	doc := []control.NetmapPeer{{
		NodeID: "dev-awg", PublicKeyHex: clientPub, AllowedIPs: []string{"100.64.40.9/32"}, KeepaliveSeconds: 25,
		Profile: true, PresharedKeyHex: staticPSKHex, AccessMethod: "amneziawg",
	}}
	awg := netmapAWG()
	if err := m.Apply(&control.NetmapResponse{Version: 1, Peers: doc, Self: control.NetmapSelf{Awg: awg}}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if !dev.AWGRunning() {
		t.Fatal("the netmap carried parameters and the operator a port, but no AmneziaWG device runs")
	}
	if got, _ := dev.AWGPort(); got != port {
		t.Fatalf("AmneziaWG device on port %d, the operator asked for %d", got, port)
	}

	params := awgParamsFromNetmap(awg.Params)
	ch := tuntest.NewChannelTUN()
	<-ch.TUN().Events() // the test TUN's up event would start the device before it is configured
	client := awgdevice.NewDevice(ch.TUN(), awgconn.NewDefaultBind(), awgdevice.NewLogger(awgdevice.LogLevelSilent, ""))
	t.Cleanup(client.Close)
	uapi := fmt.Sprintf("private_key=%s\njc=%d\njmin=%d\njmax=%d\ns1=%d\ns2=%d\ns3=%d\ns4=%d\nh1=%s\nh2=%s\nh3=%s\nh4=%s\n",
		hex.EncodeToString(clientKeys.PrivateKey[:]), params.Jc, params.Jmin, params.Jmax,
		params.S1, params.S2, params.S3, params.S4, params.H1, params.H2, params.H3, params.H4) +
		fmt.Sprintf("public_key=%s\npreshared_key=%s\nendpoint=127.0.0.1:%d\nreplace_allowed_ips=true\nallowed_ip=100.64.0.0/10\n",
			hex.EncodeToString(gwKeys.PublicKey[:]), staticPSKHex, port)
	if err := client.IpcSet(uapi); err != nil {
		t.Fatal(err)
	}
	if err := client.Up(); err != nil {
		t.Fatal(err)
	}

	// Any packet makes the client handshake; whether the gateway's own policy answers it is
	// not what is asked here.
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case ch.Outbound <- awgPing(netip.MustParseAddr("100.64.40.9"), netip.MustParseAddr("100.64.40.1")):
		case <-time.After(time.Second):
		}
		peers, err := dev.Peers()
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range peers {
			if p.PublicKey == clientPub && !p.LastHandshake.IsZero() {
				return
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("an amneziawg-go client with the netmap's parameters did not handshake with the gateway")
}

// awgPing is a minimal IPv4 ICMP echo request; its checksums are not checked here.
func awgPing(src, dst netip.Addr) []byte {
	pkt := make([]byte, 28)
	pkt[0], pkt[3], pkt[8], pkt[9] = 0x45, byte(len(pkt)), 64, 1
	copy(pkt[12:], src.AsSlice())
	copy(pkt[16:], dst.AsSlice())
	pkt[20] = 8
	return pkt
}
