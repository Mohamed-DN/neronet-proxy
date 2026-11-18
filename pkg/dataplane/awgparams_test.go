package dataplane

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func validAWGParams() AWGParams {
	return AWGParams{
		Jc: 5, Jmin: 40, Jmax: 120,
		S1: 37, S2: 71, S3: 23, S4: 11,
		H1: "1177943521-1177943999",
		H2: "2218841063-2218841590",
		H3: "3302115709",
		H4: "412345678-412346133",
	}
}

func TestAWGParamsAcceptAValidSet(t *testing.T) {
	if err := validAWGParams().Validate(); err != nil {
		t.Fatalf("a valid set was refused: %v", err)
	}
}

// There is no default set: a gateway whose organisation has none must not start the device
// with something that is the same everywhere.
func TestAWGParamsZeroValueIsRefused(t *testing.T) {
	err := AWGParams{}.Validate()
	if !errors.Is(err, ErrAWGParams) {
		t.Fatalf("the zero value was not refused: %v", err)
	}
}

func TestAWGParamsRefuseWhatTheSpecOrTheWireForbids(t *testing.T) {
	cases := map[string]func(*AWGParams){
		"Jc zero":                 func(p *AWGParams) { p.Jc = 0 },
		"Jc above 128":            func(p *AWGParams) { p.Jc = 129 },
		"Jmin zero":               func(p *AWGParams) { p.Jmin = 0 },
		"Jmax below Jmin":         func(p *AWGParams) { p.Jmax = p.Jmin - 1 },
		"Jmax above the MTU":      func(p *AWGParams) { p.Jmax = 1281 },
		"S1 zero":                 func(p *AWGParams) { p.S1 = 0 },
		"S1 above its bound":      func(p *AWGParams) { p.S1 = 1133 },
		"S2 zero":                 func(p *AWGParams) { p.S2 = 0 },
		"S2 above its bound":      func(p *AWGParams) { p.S2 = 1189 },
		"S2 = S1+56":              func(p *AWGParams) { p.S2 = p.S1 + 56 },
		"S3 negative":             func(p *AWGParams) { p.S3 = -1 },
		"S3 above its ceiling":    func(p *AWGParams) { p.S3 = 65 },
		"S4 negative":             func(p *AWGParams) { p.S4 = -1 },
		"S4 above its ceiling":    func(p *AWGParams) { p.S4 = 33 },
		"H1 missing":              func(p *AWGParams) { p.H1 = "" },
		"H2 not a number":         func(p *AWGParams) { p.H2 = "abc" },
		"H3 three parts":          func(p *AWGParams) { p.H3 = "10-20-30" },
		"H4 reversed range":       func(p *AWGParams) { p.H4 = "412346133-412345678" },
		"H1 is WireGuard's own":   func(p *AWGParams) { p.H1 = "1" },
		"H2 range touches 1-4":    func(p *AWGParams) { p.H2 = "4-9000" },
		"H3 above 32 bits":        func(p *AWGParams) { p.H3 = "4294967296" },
		"H2 overlaps H1":          func(p *AWGParams) { p.H2 = "1177943900-1177944100" },
		"H4 equals H3":            func(p *AWGParams) { p.H4 = p.H3 },
		"H1 inside H4's range":    func(p *AWGParams) { p.H1 = "412345700" },
		"H3 inside H2 as a point": func(p *AWGParams) { p.H3 = "2218841100" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			p := validAWGParams()
			mutate(&p)
			err := p.Validate()
			if !errors.Is(err, ErrAWGParams) {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
}

func TestAWGParamsEdgesOfTheValidRangeAreAccepted(t *testing.T) {
	p := validAWGParams()
	p.Jc, p.Jmin, p.Jmax = 128, 1280, 1280
	p.S1, p.S2, p.S3, p.S4 = 1132, 1187, 64, 32
	p.H1, p.H2, p.H3, p.H4 = "5", "6-4294967294", "4294967295", "4294967295"
	if err := p.Validate(); err == nil {
		t.Fatal("H3 and H4 share 4294967295 and must overlap")
	}
	p.H4 = "7-8"
	p.H2 = "9-4294967294"
	if err := p.Validate(); err != nil {
		t.Fatalf("the edges of the valid range were refused: %v", err)
	}
}

// The values are treated like keys: an error or a log line must not carry them.
func TestAWGParamsNeverAppearInText(t *testing.T) {
	p := validAWGParams()
	p.H1 = "1177943521-1177943999"
	for _, text := range []string{fmt.Sprint(p), fmt.Sprintf("%v %+v %#v %s", p, p, p, p)} {
		if strings.Contains(text, "1177943521") || strings.Contains(text, "412345678") {
			t.Fatalf("a header value appears in %q", text)
		}
	}
	p.H4 = "412345678-1"
	err := p.Validate()
	if err == nil || strings.Contains(err.Error(), "412345678") {
		t.Fatalf("a validation error carried a value: %v", err)
	}
}

func TestAWGParamsRenderAsAnUAPIRequest(t *testing.T) {
	got := validAWGParams().uapi()
	for _, want := range []string{"jc=5\n", "jmin=40\n", "jmax=120\n", "s1=37\n", "s2=71\n", "s3=23\n", "s4=11\n",
		"h1=1177943521-1177943999\n", "h3=3302115709\n"} {
		if !strings.Contains(got, want) {
			t.Fatalf("UAPI request lacks %q:\n%s", want, got)
		}
	}
}
