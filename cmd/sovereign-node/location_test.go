package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/crypto"
)

func parseLocationFlags(t *testing.T, args ...string) (declaredLocation, error) {
	t.Helper()

	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	read := bindLocationFlags(fs)
	if err := fs.Parse(args); err != nil {
		t.Fatalf("parsing %v: %v", args, err)
	}
	return read()
}

func TestLocationFlagsFromCommandLine(t *testing.T) {
	loc, err := parseLocationFlags(t, "-city", "Sydney", "-lat", "-33.8688", "-lon", "151.2093")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if loc.City != "Sydney" {
		t.Errorf("City = %q, want Sydney", loc.City)
	}
	if loc.Latitude == nil || *loc.Latitude != -33.8688 {
		t.Errorf("Latitude = %v, want -33.8688", loc.Latitude)
	}
	if loc.Longitude == nil || *loc.Longitude != 151.2093 {
		t.Errorf("Longitude = %v, want 151.2093", loc.Longitude)
	}
}

func TestLocationFlagsFromEnvironment(t *testing.T) {
	t.Setenv("SOVEREIGN_CITY", "Reykjavik")
	t.Setenv("SOVEREIGN_LAT", "64.1466")
	t.Setenv("SOVEREIGN_LON", "-21.9426")

	loc, err := parseLocationFlags(t)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if loc.City != "Reykjavik" || loc.Latitude == nil || *loc.Latitude != 64.1466 ||
		loc.Longitude == nil || *loc.Longitude != -21.9426 {
		t.Errorf("environment values were not read: %+v", loc)
	}

	// A flag on the command line wins over the environment, as for every other flag.
	loc, err = parseLocationFlags(t, "-city", "Oslo")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if loc.City != "Oslo" {
		t.Errorf("City = %q, want the command-line value Oslo", loc.City)
	}
}

func TestLocationIsAbsentWhenNotDeclared(t *testing.T) {
	loc, err := parseLocationFlags(t)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if loc.City != "" || loc.Latitude != nil || loc.Longitude != nil {
		t.Errorf("expected nothing declared, got %+v", loc)
	}
}

func TestLocationRejectsWhatCannotBeAPosition(t *testing.T) {
	cases := map[string][]string{
		"latitude without longitude": {"-lat", "10"},
		"longitude without latitude": {"-lon", "10"},
		"latitude out of range":      {"-lat", "91", "-lon", "0"},
		"longitude out of range":     {"-lat", "0", "-lon", "-181"},
		"not a number":               {"-lat", "north", "-lon", "0"},
		"NaN":                        {"-lat", "NaN", "-lon", "0"},
		"infinity":                   {"-lat", "0", "-lon", "Inf"},
	}

	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			if loc, err := parseLocationFlags(t, args...); err == nil {
				t.Errorf("%v was accepted as %+v", args, loc)
			}
		})
	}
}

func TestZeroCoordinatesAreDeclaredNotAbsent(t *testing.T) {
	loc, err := parseLocationFlags(t, "-lat", "0", "-lon", "0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if loc.Latitude == nil || loc.Longitude == nil {
		t.Fatal("0,0 was treated as not declared")
	}
}

// registerAndCapture registers against a stand-in control plane and returns the
// capability object exactly as it arrived on the wire.
func registerAndCapture(t *testing.T, capability control.CapabilityDesc) map[string]any {
	t.Helper()

	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v4/control/challenge" {
			_, _ = w.Write([]byte(`{"nonce":"` + strings.Repeat("ab", 32) + `","cp_public_key":"` + strings.Repeat("09", 32) + `"}`))
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("reading the request body: %v", err)
		}
		if err := json.Unmarshal(body, &received); err != nil {
			t.Errorf("request body is not JSON: %v", err)
		}
		_, _ = w.Write([]byte(`{"assigned_node_id":"n1","overlay_ipv4":"100.64.0.2"}`))
	}))
	defer server.Close()

	keypair, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := enrolmentFor(keypair, "").register(context.Background(), control.NewClient(server.URL), "CLIENT_ORIGIN", capability); err != nil {
		t.Fatalf("register: %v", err)
	}

	sent, ok := received["capability"].(map[string]any)
	if !ok {
		t.Fatalf("no capability object in the request: %v", received)
	}
	return sent
}

func TestRegistrationBodyCarriesDeclaredLocation(t *testing.T) {
	loc, err := parseLocationFlags(t, "-city", "Sao Paulo", "-lat", "-23.5505", "-lon", "-46.6333")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	sent := registerAndCapture(t, withLocation(capability(false, "BR", 0), loc))

	if sent["city"] != "Sao Paulo" {
		t.Errorf("city = %v, want Sao Paulo", sent["city"])
	}
	if sent["latitude"] != -23.5505 {
		t.Errorf("latitude = %v, want -23.5505", sent["latitude"])
	}
	if sent["longitude"] != -46.6333 {
		t.Errorf("longitude = %v, want -46.6333", sent["longitude"])
	}
	if sent["country_code"] != "BR" {
		t.Errorf("country_code = %v, want BR", sent["country_code"])
	}
}

func TestRegistrationBodyOmitsLocationWhenNotDeclared(t *testing.T) {
	sent := registerAndCapture(t, withLocation(capability(false, "IT", 0), declaredLocation{}))

	for _, field := range []string{"city", "latitude", "longitude"} {
		if value, present := sent[field]; present {
			t.Errorf("%s is present (%v); an undeclared position must be absent from the wire", field, value)
		}
	}
}

func TestProxyListenAddressLoopbackCheck(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1:1080": true,
		"[::1]:1080":     true,
		"localhost:8080": true,
		"0.0.0.0:1080":   false,
		":1080":          false,
		"10.0.0.5:1080":  false,
	} {
		if got := isLoopbackListen(addr); got != want {
			t.Errorf("isLoopbackListen(%q) = %v, want %v", addr, got, want)
		}
	}
}
