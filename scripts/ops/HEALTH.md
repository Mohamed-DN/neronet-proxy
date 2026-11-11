# NeroNet health check

`neronet-health.sh` runs every 5 minutes and logs one line per check:

```
2026-11-11T16:20:00Z OK console
2026-11-11T16:20:00Z FAIL gateway not running
```

Checks: console `/api/health` (status, database, valkey), project containers
(running, none unhealthy), gateway running, UDP 51820 published, optional public
`/api/health` HTTP 200 and TLS certificate valid for more than 14 days (only when
`NERONET_PUBLIC_URL` is set), disk free on `/` above 10%, memory available above 5%.
Exit code 0 when all checks pass, 1 otherwise. No secrets or env values are printed.

## Install

1. Adjust the checkout path in `neronet-health.service` (`ExecStart`) if the repository is not at `~/neronet`.
2. Optional overrides go in `~/.config/neronet/health.env`, for example:
   ```
   COMPOSE_PROJECT_NAME=neronet-gw
   NERONET_PUBLIC_URL=https://example.org
   ```
3. Copy the units and enable the timer:
   ```
   mkdir -p ~/.config/systemd/user
   cp scripts/ops/neronet-health.service scripts/ops/neronet-health.timer ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now neronet-health.timer
   ```
4. Keep the timer running without an active login session:
   `sudo loginctl enable-linger "$USER"`.

## Read the results

```
journalctl --user -u neronet-health
systemctl --user list-timers neronet-health.timer
```

A run with a failing check exits 1, so the service shows as failed in `systemctl --user --failed`.

## Test

`sh scripts/ops/test-neronet-health.sh` runs the script against stubbed `curl`, `podman`,
`openssl` and `df` (no containers or network needed).
