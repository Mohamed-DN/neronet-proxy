// Package drop is the NeroDrop mailbox (ADR 0033).
//
// A transfer is ciphertext: the browser encrypts the file with a key that never leaves
// the two browsers (it travels in the URL fragment of the share link). This package
// stores that ciphertext on the profile gateway's volume, for a bounded time and within
// a quota, and hands it out again. It never sees a file name, a size other than the
// ciphertext length, or a key.
//
// Every request carries a ticket the console signed for one transfer, one direction and
// one size; nothing is written or read without one. The ticket key is derived from the
// X25519 exchange between this node's identity key and the control plane's key, the
// same pair the node proves possession with at registration, so no new secret has to
// be distributed and a ticket made for one gateway is useless on another.
package drop

const (
	// Capability is what a node that runs the mailbox reports at registration; the
	// console offers NeroDrop only when the organisation's default gateway reports it.
	Capability = "drop-v1"
	// PathPrefix is where the console's reverse proxy forwards mailbox requests.
	PathPrefix = "/drop-blob/"
	// AuthScheme names the ticket in the Authorization header: "NeroDrop <ticket>".
	AuthScheme = "NeroDrop"

	OpPut = "put"
	OpGet = "get"

	ticketDomain = "nerodrop-ticket-v1."
	blobSuffix   = ".blob"
	metaSuffix   = ".json"
	partSuffix   = ".part"
	servingTag   = ".serving"
)
