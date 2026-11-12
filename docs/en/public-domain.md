# Reaching NeroNet from the Internet: domain and DNS

To connect phones and computers from outside your local network, NeroNet needs a public name
(for example `vpn.example.org`) that points to the IP address of the machine it runs on. This
guide covers two ways: **your own domain** (recommended, including on Cloudflare) or **a free
DuckDNS name** if you do not want to pay for a domain.

Versione italiana: [dominio-pubblico.md](../it/dominio-pubblico.md).

## What must be reachable

| Port | Protocol | Used for |
|---|---|---|
| 80 | TCP | getting and renewing the HTTPS certificate (Let's Encrypt, HTTP-01) |
| 443 | TCP | the web console and the `/me` portal |
| 8443 | TCP | NeroNet nodes talking to the control plane |
| 51820 | UDP | WireGuard: the gateway for phones and computers, and the nodes |

Open and forward these ports on your router to the NeroNet machine. Rootless Podman cannot
publish ports below 1024 directly: forward public 80 and 443 to the local listeners (8080 and
8443 by default), as described in [tls-certificates.md](tls-certificates.md).

## Option 1: your own domain (for example on Cloudflare)

1. In the domain's DNS settings create these **A** records (and **AAAA** if you have IPv6):

   | Name | Value | What it is |
   |---|---|---|
   | `vpn` | public IP of the NeroNet machine | console, portal, control plane |
   | `gw.vpn` | IP of the gateway node (often the same) | where phones and computers connect |

   Optional, for DERP relays on other machines: `derp-a.vpn`, `derp-b.vpn`.

2. **On Cloudflare set every record to "DNS only" (grey cloud), not "Proxied" (orange).**
   WireGuard uses UDP, which Cloudflare's proxy does not carry, and nodes check the fingerprint of
   the control plane's certificate: behind the proxy they would see Cloudflare's certificate and
   refuse to connect. TTL: auto.
3. Optional but recommended: a **CAA** record `0 issue "letsencrypt.org"` on the domain, so only
   Let's Encrypt can issue certificates for it.
4. If your connection's IP changes (home line), create a Cloudflare **API token** limited to
   "Zone · DNS · Edit" for that one zone and let a dynamic-DNS client (for example `ddclient`)
   update the record. Never put the token in the repository.

## Option 2: a free DuckDNS name

[DuckDNS](https://www.duckdns.org) gives a free name such as `yourname.duckdns.org`.

1. Sign in on duckdns.org, pick a subdomain (for example `mynet`) and copy the **token** the site
   shows. The token is a password: keep it only on the NeroNet machine.
2. Keep the IP current. Store the token in a file only you can read:

   ```sh
   install -m 600 /dev/null ~/.duckdns-token && printf '%s' 'YOUR_TOKEN' > ~/.duckdns-token
   ```

   and update the IP every 5 minutes (cron):

   ```sh
   */5 * * * * curl -fsS "https://www.duckdns.org/update?domains=mynet&token=$(cat ~/.duckdns-token)&ip=" >/dev/null
   ```

   An empty `ip=` makes DuckDNS use the address the request comes from.
3. Use `mynet.duckdns.org` as the public name. Let's Encrypt issues certificates for DuckDNS names
   over HTTP-01 as long as port 80 is reachable.

Know the limits: a DuckDNS name depends on a free third-party service; a company or public body
should use its own domain. Other free DNS services exist too (for example deSEC).

## Starting NeroNet with the public name

```sh
export NERONET_TLS_MODE=acme
export NERONET_PUBLIC_DOMAIN=vpn.example.org        # or mynet.duckdns.org
export NERONET_ACME_EMAIL=admin@example.org
export NERONET_ACME_AGREE_TOS=true
export NERONET_ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory  # try first
sh scripts/dev/stack.sh up
```

Use Let's Encrypt's **staging** directory first; once the test certificate arrives, remove
`NERONET_ACME_DIRECTORY` and restart for the real one. Details and renewal:
[tls-certificates.md](tls-certificates.md).

## Choosing the gateway for phones and computers

In the console, as an administrator: **Settings → Gateway for phones and computers**, pick the node
and enter the public address, for example `gw.vpn.example.org:51820`. From then on the `/me`
portal makes profiles with that address, to open in the WireGuard app (on iPhone, the official app
from the App Store).

## Checking that it works

From a computer outside your network (for example a phone with Wi-Fi off):

```sh
nslookup vpn.example.org
curl -I https://vpn.example.org/
```

The first must return your public IP; the second an `HTTP/2 200` or a redirect, with no
certificate error.

## Changing public IP: updating Cloudflare

A home line usually changes its public IP now and then. The kit in
`scripts/ops/cloudflare-ddns/` checks the IP every 5 minutes and, only when it changed, fixes
the two Cloudflare A records (`neronet.darknero.com` and `gw.neronet.darknero.com` in the example).
It never creates records: create them once by hand, "DNS only", then let the kit keep them current.

**The token, in plain words.** In Cloudflare, My Profile, API Tokens, create a custom token with a
single permission: **Zone, DNS, Edit**, and under "Zone Resources" choose **only your zone**
(for example `darknero.com`). That token can change DNS records of that one zone and nothing else:
it cannot read your other domains, billing or account. If it ever leaks, delete it on Cloudflare
and create another. Do not paste it in the repository, in chat, or on a command line.

**Install** (as root on the VM, with `curl` and `jq` installed):

```sh
sudo bash scripts/ops/cloudflare-ddns/install.sh
```

The installer copies the script and the systemd timer, creates `/etc/neronet/ddns.env` (check
`ZONE_NAME` and `RECORD_NAMES`) and asks for the token with the input hidden. The token is stored
in `/etc/neronet/cloudflare-token` (mode 600); the script refuses to run if the mode or the owner
is wrong. Check it with:

```sh
sudo /usr/local/sbin/neronet-ddns.sh --dry-run     # shows what it would change, changes nothing
systemctl list-timers neronet-ddns.timer
journalctl -u neronet-ddns -n 20
```

The public IP is asked of two independent services (`https://api.ipify.org` and
`https://ifconfig.co/ip`, changeable with `IP_SOURCES` in `ddns.env`). If they disagree, or the answer
is not a public IPv4 address, nothing is changed. Remove everything with
`sudo bash scripts/ops/cloudflare-ddns/install.sh --uninstall` (add `--purge` to delete the token too).

Tests: `sh scripts/ops/cloudflare-ddns/test.sh` (fake Cloudflare, never the real one).

## Behind an existing reverse proxy (for example Nginx Proxy Manager)

If a reverse proxy already owns ports 80 and 443 on your network, put the console behind it:

1. In the proxy create a **Proxy Host** for your name (for example `neronet.darknero.com`). Forward
   scheme **https** to the VM's address and the **console port** (`NERONET_CONSOLE_PORT`, see
   [tls-certificates.md](tls-certificates.md)). The console uses its own certificate, so tell the
   proxy not to verify the upstream certificate (in Nginx Proxy Manager this is the default for https).
2. Turn on **Websockets Support**. Without it the live pages of the console stay empty.
3. On the SSL tab request the certificate **from the proxy** (Let's Encrypt) and enable Force SSL.
   In this setup the proxy, not NeroNet, answers HTTP-01 on port 80.
4. **Do not send these two through the proxy**: forward them straight from the router to the VM:
   - **TCP 8443**, the control plane: nodes pin the control-plane certificate, so a proxy that
     re-encrypts the traffic with its own certificate makes nodes refuse to connect.
   - **UDP 51820**, WireGuard: a web proxy does not carry UDP. For laptops on networks that
     drop UDP, the proxy can carry WireGuard inside a WebSocket on 443 instead: see
     [strict-networks.md](strict-networks.md).
   Make sure the proxy itself does not use 8443; if it does, move the proxy's admin port.
5. Keep the DNS records "DNS only" and pointing at the public IP (see the section above).

Check: `curl -I https://neronet.darknero.com/` from outside returns a normal answer and a valid
certificate, and a node still connects.
