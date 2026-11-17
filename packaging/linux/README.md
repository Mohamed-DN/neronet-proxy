# neronet for Linux

`neronet` brings a NeroNet profile up as a WireGuard tunnel on Linux. It creates the TUN
interface, sets its addresses and routes, points DNS at systemd-resolved and, with the kill
switch, blocks all traffic that does not go through the tunnel or to the tunnel's own peer
endpoints. A systemd template unit, `neronet@.service`, runs one tunnel per profile.

Requirements: a Linux distribution with systemd, `nftables`, `/dev/net/tun`, and
systemd-resolved for DNS (recommended; without it the tunnel comes up but DNS is not set).
Packages are built for `amd64` and `arm64`.

## Install (Debian, Ubuntu and derivatives)

```sh
sudo apt install ./neronet_<version>_<arch>.deb
```

The package installs `/usr/bin/neronet` and `/usr/lib/systemd/system/neronet@.service`. It
does not start anything and does not enable anything.

## Install from the tarball

```sh
tar xzf neronet-<version>-linux-<arch>.tar.gz
cd neronet-<version>-linux-<arch>
sudo install -m 0755 neronet /usr/local/bin/neronet
sudo install -m 0644 neronet@.service /etc/systemd/system/neronet@.service
sudo systemctl daemon-reload
```

The unit runs `/usr/bin/neronet`. If you install the binary to `/usr/local/bin`, edit the
`ExecStart` and `ExecStop` lines in `/etc/systemd/system/neronet@.service` to match.

## Connect a profile

1. Download the profile for this device from the NeroNet portal. It is a WireGuard
   configuration with NeroNet comment lines (`# NeroNet-Profile: 1`).
2. Copy it into `/etc/neronet/` under a name of your choice, for example `home`. The file
   holds a private key, so keep it readable by root only:

   ```sh
   sudo install -d -m 0700 /etc/neronet
   sudo install -m 0600 -o root -g root ~/Downloads/profile.conf /etc/neronet/home.conf
   ```

3. Start the tunnel now and at every boot:

   ```sh
   sudo systemctl enable --now neronet@home
   ```

4. Check it:

   ```sh
   sudo neronet status
   systemctl status neronet@home
   ```

   `status` shows the interface, the peer, the time of the last handshake and the traffic
   counters. A handshake that never happened means the tunnel is not carrying traffic.

To stop the tunnel: `sudo systemctl disable --now neronet@home`. Stopping the unit runs
`neronet down`, which removes the interface, the routes, the DNS settings and the kill-switch
table.

## Kill switch

The unit always starts `neronet up --kill-switch`. While the tunnel is up, the nftables table
`inet neronet` drops outgoing traffic except loopback, the tunnel interface and the WireGuard
packets to the peer endpoint. If the tunnel process crashes, the table can stay in place until
the unit restarts (it restarts on failure, after 5 seconds) or until `sudo neronet down` runs.
While it stays, the machine has no network except the tunnel endpoint.

## Logs

```sh
journalctl -u neronet@home
```

## Uninstall

```sh
sudo systemctl disable --now 'neronet@*'
sudo apt remove neronet          # or: sudo apt purge neronet
```

`apt remove` keeps your profiles in `/etc/neronet/`. Delete that directory yourself if you no
longer need the profiles; they contain private keys. For the tarball install, remove
`/usr/local/bin/neronet` and `/etc/systemd/system/neronet@.service`, then run
`sudo systemctl daemon-reload`.

## Notes

- The service runs as root. Its capabilities are limited to `CAP_NET_ADMIN` and `CAP_NET_RAW`,
  and it can use `/dev/net/tun` only.
- The tunnel uses a userspace WireGuard implementation; no kernel module is needed.
- Version 0 of the client. Options are limited to `up [--kill-switch] <profile>`, `down`,
  `status` and `version`.
- The maintainer address in the package (`DarkNero <packages@neronet.invalid>`) is a placeholder; replace it before publishing a package to users.
