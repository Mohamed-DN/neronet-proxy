package main

import (
	"fmt"
	"path"
)

// Paths used by the macOS client. The daemon runs as root under launchd; everything it reads
// lives in supportDir, which only root can write.
const (
	daemonLabel = "com.darknero.neronet"
	plistPath   = "/Library/LaunchDaemons/" + daemonLabel + ".plist"
	supportDir  = "/Library/Application Support/NeroNet"
	binaryFile  = supportDir + "/neronet"
	profileFile = supportDir + "/profile.conf"
	logFile     = "/var/log/neronet.log"
	// statePath records the running tunnel for `neronet status` and `neronet down`. It holds no keys.
	statePath   = "/var/run/neronet.json"
	resolverDir = "/etc/resolver"
)

// resolverPath is the macOS per-domain resolver file for domain: queries for *.domain go to
// the nameservers listed in it, and every other query keeps using the system resolver.
func resolverPath(domain string) (string, error) {
	if !validDomain(domain) {
		return "", fmt.Errorf("%q is not a domain name", domain)
	}
	return path.Join(resolverDir, domain), nil
}
