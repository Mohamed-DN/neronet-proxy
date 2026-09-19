package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// readVersionIDFromHost reads VERSION_ID out of the running container's own
// /etc/os-release, so the expectation is the machine's value rather than a literal
// copied into the test.
func readVersionIDFromHost(t *testing.T) string {
	t.Helper()

	raw, err := os.ReadFile("/etc/os-release")
	if err != nil {
		t.Skipf("no /etc/os-release on this platform: %v", err)
	}

	id := parseOSReleaseVersionID(string(raw))
	if id == "" {
		t.Skip("this host's /etc/os-release declares no VERSION_ID")
	}
	return id
}

// TestAttestationReportsOnlyMeasuredValues pins the JSON a node puts on the wire.
//
// The node used to send OSVersion "14.5.0", ASN 7018 and disk_encrypted /
// firewall_active true from every host, whatever the host was. The control plane
// stored the result and the console reported the fleet as compliant.
func TestAttestationReportsOnlyMeasuredValues(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skipf("the node's OS version source is /etc/os-release; this is %s", runtime.GOOS)
	}

	wantVersion := readVersionIDFromHost(t)

	att := buildAttestation("pk_0011223344556677", "IT", true, time.Now().UTC())

	encoded, err := json.Marshal(att)
	if err != nil {
		t.Fatalf("marshalling the attestation failed: %v", err)
	}

	// Decoded as a generic document, because what matters is the JSON the control
	// plane receives, not the Go types on this side.
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatalf("the attestation is not valid JSON: %v", err)
	}

	for _, field := range []string{"disk_encrypted", "firewall_active"} {
		value, present := wire[field]
		if !present {
			t.Fatalf("%s is absent from the wire format; the contract requires the field with a null value", field)
		}
		if value != nil {
			t.Fatalf("%s is %v, expected null: nothing on the node measures it", field, value)
		}
	}

	if got := wire["os_version"]; got != wantVersion {
		t.Fatalf("os_version is %v, expected this host's VERSION_ID %q", got, wantVersion)
	}

	if got := wire["os_name"]; got != "linux" {
		t.Fatalf("os_name is %v, expected %q from runtime.GOOS", got, "linux")
	}

	// json.Unmarshal into any gives float64 for numbers.
	if got := wire["asn"]; got != float64(0) {
		t.Fatalf("asn is %v, expected 0: the node does not resolve its own ASN", got)
	}

	if got := wire["is_rootless"]; got != true {
		t.Fatalf("is_rootless is %v, expected the measured value that was passed in", got)
	}
}

// TestAttestationOSVersionIsEmptyWhenUnreadable checks the failure path: a host
// without a readable os-release reports nothing rather than a placeholder.
func TestAttestationOSVersionIsEmptyWhenUnreadable(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skipf("detectOSVersion only reads a file on linux; this is %s", runtime.GOOS)
	}

	original := osReleasePath
	t.Cleanup(func() { osReleasePath = original })

	osReleasePath = filepath.Join(t.TempDir(), "absent-os-release")

	if got := detectOSVersion(); got != "" {
		t.Fatalf("detectOSVersion() = %q with no os-release present, expected the empty not-measured value", got)
	}
}

func TestParseOSReleaseVersionID(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    string
	}{
		{"quoted", "NAME=\"Debian GNU/Linux\"\nVERSION_ID=\"12\"\nID=debian\n", "12"},
		{"unquoted", "ID=alpine\nVERSION_ID=3.20.3\n", "3.20.3"},
		{"single quoted", "VERSION_ID='24.04'\n", "24.04"},
		{"absent", "ID=arch\nNAME=\"Arch Linux\"\n", ""},
		{"empty value", "VERSION_ID=\n", ""},
		{"not a prefix match", "IMAGE_VERSION_ID=99\n", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseOSReleaseVersionID(tc.content); got != tc.want {
				t.Fatalf("parseOSReleaseVersionID() = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestCapabilityDeclaresNothingItCannotMeasure covers the registration side, which
// carried "RESIDENTIAL" and 50,000 kbps as constants.
func TestCapabilityDeclaresNothingItCannotMeasure(t *testing.T) {
	cap := capability(true, "IT", 0)

	if cap.IPClass != "UNKNOWN" {
		t.Fatalf("IPClass = %q, expected UNKNOWN: the node cannot classify its own uplink", cap.IPClass)
	}
	if cap.ASN != 0 {
		t.Fatalf("ASN = %d, expected 0", cap.ASN)
	}
	if cap.MaxBandwidthKbps != 0 {
		t.Fatalf("MaxBandwidthKbps = %d, expected 0 when the operator declared nothing", cap.MaxBandwidthKbps)
	}
	if cap.CountryCode != "IT" {
		t.Fatalf("CountryCode = %q, expected the operator's declaration to pass through", cap.CountryCode)
	}

	declared := capability(false, "DE", 25000)
	if declared.MaxBandwidthKbps != 25000 {
		t.Fatalf("MaxBandwidthKbps = %d, expected the declared 25000", declared.MaxBandwidthKbps)
	}
}
