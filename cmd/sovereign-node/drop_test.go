package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"slices"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/drop"
)

func TestTheMailboxIsAdvertisedOnlyWhenItRuns(t *testing.T) {
	base := capability(false, "IT", 0)
	if got := withDrop(base, false); slices.Contains(got.Capabilities, drop.Capability) {
		t.Fatalf("advertised without a mailbox: %v", got.Capabilities)
	}
	got := withDrop(base, true)
	if !slices.Contains(got.Capabilities, drop.Capability) {
		t.Fatalf("not advertised with a mailbox: %v", got.Capabilities)
	}
	if slices.Contains(base.Capabilities, drop.Capability) {
		t.Fatal("withDrop changed the caller's slice")
	}
}

func TestDropKeySourceAsksTheControlPlaneOnceAndRetriesAfterAFailure(t *testing.T) {
	var priv [32]byte
	copy(priv[:], bytes.Repeat([]byte{0x22}, 32))
	calls := 0
	fail := true
	fetch := func(context.Context) (*control.ChallengeResponse, error) {
		calls++
		if fail {
			return nil, errors.New("control plane down")
		}
		return &control.ChallengeResponse{ControlPlanePubHex: "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13"}, nil
	}
	key := dropKeySource(priv, fetch)
	if _, err := key(); err == nil {
		t.Fatal("a failed fetch produced a key")
	}
	fail = false
	k, err := key()
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(k) != "68a74ead287e671031c31bdb568da900eeb1d5e58a47a5434e76eccf56c91e53" {
		t.Fatalf("key %x is not the one the console derives", k)
	}
	if _, err := key(); err != nil || calls != 2 {
		t.Fatalf("the key was not cached: %d calls, %v", calls, err)
	}
}

func TestCurrentNodeIDFollowsReEnrolment(t *testing.T) {
	var id currentNodeID
	if id.Get() != "" {
		t.Fatal("not empty before registration")
	}
	id.Set("node-a")
	id.Set("node-b")
	if id.Get() != "node-b" {
		t.Fatalf("got %q", id.Get())
	}
}
