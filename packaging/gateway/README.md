# neronet-gateway

A NeroNet profile gateway for a Linux server with systemd and no containers: VLESS + REALITY,
sharing TCP 443 with the TLS service already on the host. Design and threat model:
ADR 0043. Packages are built for `amd64` and `arm64`.

Installing the package starts nothing, enables nothing, opens no port and changes no other
service or firewall. Everything below is an explicit step.

## One page: what it opens, what the host sees, how to remove it

| | |
|---|---|
| Opens | Nothing by itself. With the router (step 4): TCP 443 owned by nginx instead of the other service. Xray listens on `127.0.0.1:8445` only; the device SOCKS on `127.0.0.1:1081`. The node binds UDP 51820 on every address for the mesh data plane: leave it closed on the host firewall unless you want direct WireGuard peers. |
| Processes | `neronet-gateway-node` (user `neronet-gw`), `neronet-gateway-xray` (user `neronet-xray`), `neronet-443-router` (user `neronet-router`, only after the swap). No root, no capabilities, except `CAP_NET_BIND_SERVICE` for the router. |
| Limits | node 384 MiB / 50 % CPU, Xray 512 MiB / 100 % CPU, router 128 MiB / 50 % CPU; all with low CPU weight and idle IO class, so the host's other services come first. |
| The host sees | A gateway: after Xray decrypts a device's connection its traffic leaves from this host, so a root user here can read it, and can read Xray's REALITY key and the per-device secrets. It does not hold the fleet token, other nodes' keys or the console's data. |
| The router sees | The SNI of each connection, nothing else. |
| The other service sees | `127.0.0.1` as the client address once the router is in front. Use PROXY protocol on its side if it supports it. |
| Remove | `neronet-443-swap rollback`, then `systemctl disable --now neronet-gateway-xray.path neronet-gateway-xray neronet-gateway-node`, then `apt remove neronet-gateway`. `apt purge` also deletes `/var/lib/neronet-gateway`, `/etc/neronet-gateway` and the three users. |

## Install

```sh
sudo apt install ./neronet-gateway_<version>_<arch>.deb
```

## 1. Enrol the node (no fleet token)

In the console, create a pre-auth key for this gateway. Put it in a file the node removes after use:

```sh
sudo install -d -o neronet-gw -g neronet-gw -m 0700 /var/lib/neronet-gateway
printf '%s\n' 'PASTE-THE-KEY' | sudo install -o neronet-gw -g neronet-gw -m 0600 /dev/stdin /var/lib/neronet-gateway/enrol.key
sudo install -m 0644 control-ca.pem /etc/neronet-gateway/control-ca.pem
```

Edit `/etc/neronet-gateway/node.env`: `SOVEREIGN_CONTROL_PLANE_URL` (https), `SOVEREIGN_CONTROL_PLANE_CA`,
`SOVEREIGN_VLESS_PORT=443`. The control plane is reached over TLS verified against that CA; there is
no way to turn verification off. Never put the fleet token on this host.

## 2. Start

```sh
sudo systemctl enable --now neronet-gateway-node.service
sudo systemctl enable --now neronet-gateway-xray.path neronet-gateway-xray.service
```

Xray runs only while the node has written its configuration (the organisation allows the method and
this gateway has REALITY parameters); when the node removes the file, Xray stops.

## 3. Prepare the other service (you do this, we do not)

Give the service that owns 443 a second listener on loopback, for example `127.0.0.1:8444`, while it
keeps its public 443. Write two commands: one that makes it stop listening on public 443 (a reload with
the public listener removed) and one that gives it back. Test both by hand.

## 4. Share 443

```sh
sudo install -m 0600 /usr/share/doc/neronet-gateway/examples/swap.conf /etc/neronet-gateway/swap.conf
sudoedit /etc/neronet-gateway/swap.conf
sudo neronet-443-swap plan
sudo neronet-443-swap apply          # dry run
sudo neronet-443-swap apply --yes    # does it; rolls back by itself if a probe fails
sudo neronet-443-swap status
sudo neronet-443-swap rollback       # the way back, at any time
```

`/usr/share/doc/neronet-gateway/examples/nginx-sni-router.conf` shows the shape of the router
configuration the tool writes. nginx with the stream module is needed (Debian: `nginx` and
`libnginx-mod-stream`); the package does not install it for you.

## Logs

```sh
journalctl -u neronet-gateway-node -u neronet-gateway-xray -u neronet-443-router
```
