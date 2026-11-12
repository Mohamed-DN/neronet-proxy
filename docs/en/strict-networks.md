# Networks that block VPNs: WireGuard over port 443

Some networks (hotels, offices, guest Wi-Fi, some mobile carriers) drop every UDP packet and
let only the web through. WireGuard is UDP, so on those networks a laptop never connects.
NeroNet can carry the same WireGuard packets inside one WebSocket on TCP 443, the port every
website uses. This is the `wg-wss` method of the multi-protocol plan (ADR 0032, draft).

Versione italiana dei passi per Nginx Proxy Manager: [reti-che-bloccano-le-vpn.md](../it/reti-che-bloccano-le-vpn.md).

## How it works

```
laptop                               your network                          NeroNet host
WireGuard app ─UDP─> wstunnel client ══ TLS 443 ══> reverse proxy ─ws─> wstunnel server ─UDP─> gateway :51820
  (127.0.0.1:51820)                                 (NPM, holds the      (docker-compose.wss.yml)
                                                     certificate)
```

- The laptop runs the upstream **wstunnel** client (BSD-3-Clause,
  <https://github.com/erebe/wstunnel>, version **11.1.0**). The WireGuard app talks to it on
  `127.0.0.1:51820` instead of the gateway.
- The client opens `wss://<console name>/<secret>/events`. The reverse proxy that already holds
  the certificate for the console's name forwards that one location to the wstunnel server.
- The wstunnel server unwraps the packets and sends them, unchanged, to the profile gateway's
  UDP 51820. It may send to that address only (`--restrict-to gateway:51820`), and only for a
  request whose path starts with the installation's secret prefix.
- The gateway authenticates the device by its WireGuard key and applies the same policy as
  for a device on plain UDP. The tunnel decides nothing about who reaches what: an ACL rule,
  quarantine or deleting the device work the same way, and the tests below measure it.

It is a fallback, not a default: TCP inside TCP slows down when packets are lost, and the
MTU is 1380 instead of 1420. Use it when the normal profile does not connect.

## What the tests measured

Scenario `wss443` in `scripts/dev/scenarios/overlay.sh`, on a dedicated stack (console, the
`gateway` service, one mesh node, the tunnel), with an nginx in front configured as Nginx
Proxy Manager writes a custom location with "Websockets support" (same headers, default
timeouts) and everything else sent to the console. The device is a stock `wg-quick` in its
own container; iptables in its network namespace drops **every** UDP packet on its network
interface. Two consecutive runs on 12 November 2026, commit `9c54d91`, all named tests green
(logs `wss443-run1.log`, `wss443-run2.log`):

| Test | Measured |
|---|---|
| Negative control: normal profile, UDP dropped | no handshake in 20 s; iptables dropped 4 UDP packets |
| Same device, wstunnel through the proxy | first 64 KiB echo (random bytes, SHA-256 compared) within 1 s, handshake included; later echoes 10-12 ms |
| Mesh node opens TCP to the device | 64 KiB echoed back; the first answer came after 39 s and 26 s; the device's own connections worked at once. Not yet explained; the scenario waits up to 45 s and reports the wait |
| What crossed the device's wire | every captured IPv4 packet (1174 and 1020 in the two runs) was TCP with the proxy's 443; the gateway's own capture saw the WireGuard datagrams arrive from the tunnel server |
| ACL DROP for the device | cut after 10 s and 7 s over wss, 4 s and 5 s over UDP for a control device with the same rule; the gateway's forward-dropped counter rose by 8 and 16; both back within 12 s after the rule was deleted |
| Deleting the device | cut 6 s and 10 s after the delete (one netmap fetch is 15 s), still cut 20 s later |
| HTTPS `GET /` through the proxy without the prefix | the console's own page (200, `Server: nginx`); nothing from wstunnel |
| WebSocket upgrade on wstunnel's default path through the proxy | no upgrade (the console answers, the connection closes); no datagram at the gateway |
| The tunnel port directly, wrong prefix | connection closed, 0 bytes, no `Server` header; no datagram at the gateway |
| Right prefix, other destination (the console's API) | refused: no byte back |
| 512 random bytes to the proxy's 443 and to the tunnel port | `400 Bad Request` from both, nothing naming wstunnel; no datagram |
| The prefix in the tunnel server's logs | in none of its log lines (it runs at WARN) |
| Direct TLS mode (`docker-compose.wss-tls.yml`), certificate checked | right prefix delivers, a wrong one does not |
| Mutation: `--restrict-to` removed | the "other destination" test turns red; file restored byte for byte |
| Mutation: the prefix check removed | the "wrong prefix on the tunnel port" test turns red (3 datagrams reach the gateway); file restored byte for byte |

During the wss phase iptables still counted one more dropped UDP packet: the device's kernel
WireGuard retrying the old endpoint once. It never reached the network.

## Set-up behind Nginx Proxy Manager (the usual case)

On the NeroNet host:

1. Add the secret to `.env` once (it is never printed; the value is in the file):

   ```sh
   sh scripts/dev/gen-env.sh --append-missing
   ```

2. Start the tunnel next to the gateway. In the environment you start the stack with:

   ```sh
   NERONET_EXTRA_COMPOSE_FILE="docker-compose.proxy.yml docker-compose.gateway.yml docker-compose.wss.yml"
   NERONET_WSS_BIND=192.168.1.160     # the address Nginx Proxy Manager reaches
   NERONET_WSS_PORT=8444              # any free TCP port on the host
   ```

   then `sh scripts/dev/stack.sh up`. The backend reads the same secret and gives it to signed-in
   users on the "Add a device" result page in `/me`, and nowhere else.

In Nginx Proxy Manager, on the **existing** proxy host for the console's name (for example
`neronet.darknero.com`):

1. Open the host, tab **Custom locations**, **Add location**.
2. **Define location**: `/` followed by the value of `NERONET_WSS_PATH_PREFIX` from `.env`, for
   example `/3f9c…` (the whole value, no trailing slash).
3. **Scheme** `http`, **Forward Hostname / IP** `192.168.1.160`, **Forward Port** `8444`
   (the `NERONET_WSS_PORT` above). It is `http` because NPM already terminated TLS; the
   tunnel listens for plain WebSocket.
4. Turn **Websockets Support** on for the host (Details tab) if it is not on already; the
   console needs it too.
5. Save. Nothing else changes: the SSL tab, the certificate and the console's own location
   stay as they are.

The router needs **no change**: TCP 443 already reaches Nginx Proxy Manager, and the tunnel
rides on it. Do not forward port 8444 on the router: only NPM should reach it.

Check from any machine: `curl -s -o /dev/null -w '%{http_code}\n' https://neronet.darknero.com/`
still answers as before (the console), and a laptop with UDP blocked connects with the
command from `/me`.

## Set-up without a reverse proxy

When nothing else holds 443, let wstunnel terminate TLS itself with
`docker-compose.wss-tls.yml` (after `docker-compose.wss.yml`):

```sh
NERONET_EXTRA_COMPOSE_FILE="docker-compose.gateway.yml docker-compose.wss.yml docker-compose.wss-tls.yml"
NERONET_WSS_BIND=0.0.0.0
NERONET_WSS_PORT=8444
NERONET_WSS_TLS_CERT=/etc/letsencrypt/live/vpn.example.org/fullchain.pem
NERONET_WSS_TLS_KEY=/etc/letsencrypt/live/vpn.example.org/privkey.pem
NERONET_WSS_PUBLIC_URL=wss://vpn.example.org
```

and forward TCP 443 on the router to port 8444 of the host. The certificate must be valid for
the name in `NERONET_WSS_PUBLIC_URL`: the client command checks it. The server runs as the
image's unprivileged user (uid 1000) with no capabilities, so the key file must be readable by
that user (under rootless Podman, mode 0640 or 0644 for a key owned by the host user).

## On the laptop

`/me` shows, after "Add a device", the section "Networks that block VPNs (port 443)" with:

- the command for Linux and macOS, and for Windows (PowerShell), already filled in:

  ```sh
  wstunnel client --tls-verify-certificate -P <secret> \
    -L 'udp://127.0.0.1:51820:gateway:51820?timeout_sec=0' wss://neronet.darknero.com
  ```

- a second WireGuard file, `<name>-443.conf`: the same keys and address, but
  `Endpoint = 127.0.0.1:51820`, `MTU = 1380`, `PersistentKeepalive = 20`.

Download wstunnel 11.1.0 from the release page and check the file against the SHA-256 there
(for example `wstunnel_11.1.0_linux_amd64.tar.gz` is
`512edf4e7bb64fc133522220123514868fae75b5bae4124b53e396787276aa23`, the Windows amd64 archive
`b271d076fbba92fe3d8c9b7612bf17f4ac905d68614a6c40debd73107883d75e`, macOS arm64
`87fc0d68563248729c8c45359e5a7501041990145850c43c23a96e51656c2880`).

`--tls-verify-certificate` matters: without it wstunnel accepts any certificate.

iPhone and Android with the WireGuard app cannot use this method: the app cannot run the
wstunnel client. Our own apps will carry it (phase 1b).

## The secret prefix

- Anyone who knows it can open a WebSocket to the tunnel, but only to the gateway's WireGuard
  port, where the device's key still decides. It keeps scanners and casual probes away; it is
  not what authenticates a device.
- To change it: replace the value in `.env`, restart (`stack.sh up`), and update the custom
  location in NPM. Devices added before keep a command with the old value and need the new one.
- The wstunnel server runs at log level WARN: at INFO it logs every accepted tunnel with the
  name of the rule it matched, and that name contains the prefix. Refusals (wrong prefix,
  wrong destination) are WARN and stay in the log. The scenario checks that the prefix appears
  in none of its log lines.
- The tunnel port itself (8444) answers a wrong prefix by closing the connection, without a
  `Server` header. Keep it reachable only from the proxy anyway.
- `--restrict-to` limits the host and port, not the protocol: a TCP connection to the
  gateway's port 51820 would also be allowed, and nothing listens there. A restriction file
  (`--restrict-config`) could limit it to UDP; that is a follow-up.

## Limits

- TCP-in-TCP: slower under packet loss. Throughput under loss is not yet measured (ADR test 8).
- Phones with the stock WireGuard app: not possible.
- An organisation cannot yet switch the method off by itself: it is on for the whole
  installation when `docker-compose.wss.yml` runs (phase 1b adds the organisation setting).

## Not done yet (phase 1b)

- Our apps (Android, Windows, Linux `neronet`, macOS) carry the wstunnel client and fall back
  to it after the UDP attempt times out.
- `access_methods` on the device record and in `/api/devices`; the result page then shows the
  method a device used last, and the profile file gets `# NeroNet-Alt:` lines.
- The organisation setting `allowed_front_ends`: a method that is off is not started.
- A `via` label on the gateway's forward and drop counters.
- ADR tests 5 to 8 (spoofing over wss, roaming, the organisation ceiling, throughput under
  1 % loss).
- The command again later: today it is shown only on the result page right after a device is
  added.
