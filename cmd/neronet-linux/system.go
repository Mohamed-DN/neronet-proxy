package main

// Host services the tunnel depends on: systemd-resolved (DNS) and nftables (kill switch).
// Both are driven through their own command-line tools, as the ADR allows for the kill switch.

import (
	"fmt"
	"net/netip"
	"os/exec"
	"strings"
)

// applyDNS points the tunnel's DNS servers at the system resolver. It returns false, with no
// error, when resolvectl is not installed: the caller reports that DNS was not set.
func applyDNS(iface string, servers []netip.Addr) (bool, error) {
	if _, err := exec.LookPath("resolvectl"); err != nil {
		return false, nil
	}
	for _, args := range dnsCommands(iface, servers) {
		if err := runCommand("resolvectl", args...); err != nil {
			_ = revertDNS(iface)
			return false, err
		}
	}
	return true, nil
}

// revertDNS undoes applyDNS for the interface.
func revertDNS(iface string) error {
	if _, err := exec.LookPath("resolvectl"); err != nil {
		return nil
	}
	return runCommand("resolvectl", "revert", iface)
}

// killSwitchPresent reports whether the kill-switch table exists.
func killSwitchPresent() bool {
	return exec.Command("nft", "list", "table", "inet", nftTable).Run() == nil
}

// applyKillSwitch installs the kill-switch table, replacing one left behind by an earlier run.
func applyKillSwitch(iface string, endpoints []netip.AddrPort) error {
	script, err := killSwitchRuleset(iface, endpoints)
	if err != nil {
		return err
	}
	if killSwitchPresent() {
		if err := removeKillSwitch(); err != nil {
			return err
		}
	}
	cmd := exec.Command("nft", "-f", "-")
	cmd.Stdin = strings.NewReader(script)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("loading the kill switch with nft: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// removeKillSwitch deletes the kill-switch table; an absent table is not an error.
func removeKillSwitch() error {
	if !killSwitchPresent() {
		return nil
	}
	return runCommand("nft", "delete", "table", "inet", nftTable)
}

func runCommand(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
