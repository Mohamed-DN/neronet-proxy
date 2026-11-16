package drop

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"
)

// Ticket is what the console allows for one transfer. Field names are short because
// the ticket travels in a header on every request.
type Ticket struct {
	V        int    `json:"v"`
	Op       string `json:"op"`   // OpPut or OpGet
	ID       string `json:"id"`   // transfer id, 32 lowercase hex digits
	Gateway  string `json:"gw"`   // the node id of the gateway that may honour it
	Size     int64  `json:"n"`    // ciphertext bytes (exact for an upload)
	Exp      int64  `json:"exp"`  // Unix seconds after which the ticket is void
	DeleteAt int64  `json:"del"`  // upload only: when the ciphertext must be gone
	Once     bool   `json:"once"` // upload only: delete after the first complete download
}

var errTicket = errors.New("drop: invalid ticket")

// ticketInfo is the HKDF label; the console uses the same string.
const ticketInfo = "neronet/v4/drop-ticket"

// TicketKey derives the HMAC key tickets are signed with:
// HKDF-SHA-256(X25519(node private, control plane public), info "neronet/v4/drop-ticket").
// The console computes the same value from its private key and this node's public key.
func TicketKey(nodePriv [32]byte, cpPub []byte) ([]byte, error) {
	if len(cpPub) != 32 {
		return nil, fmt.Errorf("drop: control plane key is %d bytes, want 32", len(cpPub))
	}
	shared, err := curve25519.X25519(nodePriv[:], cpPub)
	if err != nil {
		return nil, fmt.Errorf("drop: X25519 with the control plane key: %w", err)
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, shared, nil, []byte(ticketInfo)), key); err != nil {
		return nil, err
	}
	return key, nil
}

// ParseTicket checks the signature and decodes the payload. It does not check what the
// ticket allows; the server does that against the request.
func ParseTicket(token string, key []byte) (Ticket, error) {
	if len(key) != 32 {
		return Ticket{}, errTicket
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return Ticket{}, errTicket
	}
	mac, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Ticket{}, errTicket
	}
	m := hmac.New(sha256.New, key)
	m.Write([]byte(ticketDomain + parts[0]))
	if !hmac.Equal(mac, m.Sum(nil)) {
		return Ticket{}, errTicket
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Ticket{}, errTicket
	}
	var tk Ticket
	if err := json.Unmarshal(raw, &tk); err != nil {
		return Ticket{}, errTicket
	}
	return tk, nil
}
