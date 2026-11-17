package main

import (
	"bufio"
	"bytes"
	"fmt"
	"net/netip"
	"regexp"
	"strings"
)

// searchKey is the metadata comment that names the overlay's search domain. The profile
// parser (pkg/profile) has no field for it and ignores unknown NeroNet-* lines, so the CLI
// reads it itself:
//
//	# NeroNet-Search: corp.example
const searchKey = "NeroNet-Search"

var domainRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

func validDomain(d string) bool {
	return len(d) <= 253 && domainRE.MatchString(d)
}

// searchDomain returns the lower-cased NeroNet-Search domain of a profile, or "" when the
// profile does not name one. A profile that names two different domains is an error.
func searchDomain(profileText []byte) (string, error) {
	found := ""
	sc := bufio.NewScanner(bytes.NewReader(profileText))
	for sc.Scan() {
		text := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(text, "#") {
			continue
		}
		k, v, ok := strings.Cut(strings.TrimSpace(strings.TrimPrefix(text, "#")), ":")
		if !ok || strings.TrimSpace(k) != searchKey {
			continue
		}
		d := strings.ToLower(strings.TrimSpace(v))
		if !validDomain(d) {
			return "", fmt.Errorf("%s %q is not a domain name", searchKey, strings.TrimSpace(v))
		}
		if found != "" && found != d {
			return "", fmt.Errorf("%s is given twice with different domains", searchKey)
		}
		found = d
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	return found, nil
}

// resolverFile is the content of /etc/resolver/<domain>: one nameserver line per overlay DNS server.
func resolverFile(servers []netip.Addr) string {
	var b strings.Builder
	for _, s := range servers {
		fmt.Fprintf(&b, "nameserver %s\n", s)
	}
	return b.String()
}
