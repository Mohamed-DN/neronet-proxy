package drop

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"
)

// The console (console/backend/services/DropService.js) signs tickets; this package
// verifies them. The vector below is computed by the console's code with the same fixed
// keys (tests/drop.test.js holds the same strings), so the two sides cannot drift apart.
const (
	vectorCPPub   = "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13"
	vectorKey     = "68a74ead287e671031c31bdb568da900eeb1d5e58a47a5434e76eccf56c91e53"
	vectorTicket  = "eyJ2IjoxLCJvcCI6InB1dCIsImlkIjoiMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYiLCJndyI6Im5vZGUtZ3ctMSIsIm4iOjUyNDM5MjAsImV4cCI6MjAwMDAwMDAwMCwiZGVsIjoyMDAwMDg2NDAwLCJvbmNlIjp0cnVlfQ.rk1UxFcHW6WxDOAihVhpbZKZY7zXNydUhpBT5piYl4I"
	vectorNodeHex = "2222222222222222222222222222222222222222222222222222222222222222"
)

func vectorNodePriv(t *testing.T) [32]byte {
	t.Helper()
	var priv [32]byte
	raw, err := hex.DecodeString(vectorNodeHex)
	if err != nil {
		t.Fatal(err)
	}
	copy(priv[:], raw)
	return priv
}

func TestTicketKeyMatchesTheConsole(t *testing.T) {
	cpPub, _ := hex.DecodeString(vectorCPPub)
	key, err := TicketKey(vectorNodePriv(t), cpPub)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(key); got != vectorKey {
		t.Fatalf("ticket key %s, the console derives %s", got, vectorKey)
	}
}

func TestTicketKeyRefusesAMalformedControlPlaneKey(t *testing.T) {
	if _, err := TicketKey(vectorNodePriv(t), []byte{1, 2, 3}); err == nil {
		t.Fatal("a 3-byte control plane key was accepted")
	}
	if _, err := TicketKey(vectorNodePriv(t), make([]byte, 32)); err == nil {
		t.Fatal("the all-zero point was accepted (X25519 yields an all-zero secret)")
	}
}

func TestParseTicketReadsTheConsoleVector(t *testing.T) {
	key, _ := hex.DecodeString(vectorKey)
	tk, err := ParseTicket(vectorTicket, key)
	if err != nil {
		t.Fatal(err)
	}
	want := Ticket{V: 1, Op: OpPut, ID: "0123456789abcdef0123456789abcdef", Gateway: "node-gw-1", Size: 5243920, Exp: 2000000000, DeleteAt: 2000086400, Once: true}
	if tk != want {
		t.Fatalf("got %+v, want %+v", tk, want)
	}
}

func TestParseTicketRefusesAnythingNotSignedByTheConsole(t *testing.T) {
	key, _ := hex.DecodeString(vectorKey)
	payload, mac, _ := strings.Cut(vectorTicket, ".")
	other := bytes.Repeat([]byte{7}, 32)
	flip := func(s string) string {
		b := []byte(s)
		if b[3] == 'A' {
			b[3] = 'B'
		} else {
			b[3] = 'A'
		}
		return string(b)
	}
	cases := map[string]struct {
		token string
		key   []byte
	}{
		"empty":            {"", key},
		"no separator":     {payload + mac, key},
		"payload changed":  {flip(payload) + "." + mac, key},
		"signature broken": {payload + "." + flip(mac), key},
		"other key":        {vectorTicket, other},
		"no key":           {vectorTicket, nil},
		"extra part":       {vectorTicket + ".x", key},
	}
	for name, c := range cases {
		if _, err := ParseTicket(c.token, c.key); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
