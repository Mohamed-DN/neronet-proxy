# ADR 0038: Tor as an exit, by country, and onion obfuscation

Status: accepted (design). 18 November 2026.

## Context

Exits (ADR 0032) today are the profile gateway or a mesh node. The owner wants traffic that can
leave through the Tor network, choosing the exit country among those Tor offers, and obfuscation
for networks where Tor itself is blocked. The repository has onion-routing cryptography only in
tests; nothing in production routes over Tor.

## Decision

1. **Exit kind `tor`** next to `gateway` and `node`. The gateway runs a Tor client (official Tor
   package, pinned) in its own container on the internal network, with a SOCKS port, a DNSPort and a
   control port reachable only by the gateway.
2. A device that selects a Tor exit has its TCP traffic carried by the gateway's egress stack to the
   Tor SOCKS port with stream isolation per device (`IsolateSOCKSAuth`, the device id as SOCKS user),
   its DNS answered via the Tor DNSPort, and **everything else refused** (UDP other than DNS, ICMP):
   no clear-text leak, same fail-closed rule as ADR 0032.
3. **Country choice**: the list of countries comes from the live Tor consensus (relays with the Exit
   flag, read through the control port), never a fixed list; a choice maps to `ExitNodes {cc}` with
   `StrictNodes 1` on a per-country Tor circuit pool. If a country has no exit right now, the UI says
   so and the device falls back to "any country" only if the person allowed it.
4. **Honest label**: "via Tor" everywhere it is used, with the limits in one sentence (TCP only,
   slower, some sites block Tor). Never presented as a mesh exit.
5. **Onion obfuscation**: Tor bridges with pluggable transports (obfs4, snowflake, webtunnel) for
   the gateway's Tor client in countries that block Tor; an optional `.onion` address for the console
   (v3 onion service) so it can be reached without the public domain.
6. Tests first: an overlay scenario with a private Tor test network (chutney or a mocked SOCKS
   egress) proving the per-device isolation, DNS via Tor, and UDP refused.

## Consequences

- The gateway image gains a Tor sidecar; resource cost per active country pool.
- Legal and abuse considerations are the operator's: the console states that traffic leaves through
  Tor exits run by third parties.
