# Console and node certificates

NeroNet supports an internal CA and ACME HTTP-01. Both serve the console and the
node control API over HTTPS. Internal mode remains the default. ACME keeps its
account key in a private volume; nginx receives only the serving certificate/key
and the HTTP-01 webroot.

## Internal CA

Run `sh scripts/dev/stack.sh up`. A new checkout creates a development CA in
`certs/`; nodes pin `certs/ca.crt`. For an installation, replace `server.crt` and
`server.key` with a pair issued by your CA, and `ca.crt` with its trust chain.
The certificate must cover `frontend`, or configure the node's `-control-url` to
use a name it does cover. Keep private keys and `.env` out of version control.

## Public domain with ACME

HTTP-01 requires a real public domain with A/AAAA records reaching this host and
inbound TCP port 80. A reverse proxy may forward port 80 to nginx's HTTP-01
listener, but must preserve `/.well-known/acme-challenge/`. This does not support
wildcards or DNS-01. First use the CA's staging directory to check DNS and firewall
configuration before requesting a trusted certificate.

From Git Bash on Windows, or a POSIX shell elsewhere:

```sh
export COMPOSE_PROJECT_NAME=my-neronet
export NERONET_TLS_MODE=acme
export NERONET_PUBLIC_DOMAIN=vpn.example.org
export NERONET_ACME_EMAIL=admin@example.org
export NERONET_ACME_AGREE_TOS=true
export NERONET_CONSOLE_BIND=0.0.0.0
export NERONET_HTTP_PORT=80
export NERONET_CONSOLE_PORT=443
export NERONET_CONSOLE_PUBLIC_PORT=443
export NERONET_ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory
sh scripts/dev/stack.sh up
```

Rootless Podman usually cannot publish host ports 80 or 443. In that case keep
the defaults (HTTP 8080 and HTTPS 8443, plus any test offset), set
`NERONET_CONSOLE_PUBLIC_PORT=443`, and forward public ports 80/443 to those
listeners with a host reverse proxy or port forwarding. HTTP-01 still has to be
reachable from the CA on public port 80.

`NERONET_ACME_AGREE_TOS=true` records the operator's acceptance of the selected
CA's terms. The default directory is Let's Encrypt production. Its staging
certificates are deliberately untrusted by browsers; do not disable client
verification to deploy them. Use a separate staging project and its account/state
volumes, then production with a fresh project after staging succeeds.

The certificate's domain becomes a DNS alias for the frontend on the Compose
network, so the development nodes verify that name rather than `frontend`.
Publicly trusted certificates use the node image's system roots. For a private
ACME CA, set `NERONET_CONTROL_PLANE_CA_FILE` to its issuance root, and configure
the separate ACME directory trust using `NERONET_ACME_DIRECTORY_CA_FILE` plus
`NERONET_ACME_CA_CERTIFICATES=/run/secrets/acme_directory_ca`.

Before issuance, nginx refuses TLS handshakes and its health probe is unhealthy;
HTTP-01 is already available. The ACME service checks twice daily by default
(`NERONET_ACME_CHECK_INTERVAL`, seconds). Lego decides when renewal is due. Nginx
checks for a new certificate every 30 seconds (`NERONET_TLS_WATCH_INTERVAL`) and
reloads its workers. A failed CA request preserves the last certificate and retries
with backoff; watch service logs and certificate expiry in your monitoring.

The image builds pinned lego v5.5.2 with a small recovery patch: if a first CA
outage saved an account locally before registration, the next attempt registers
that same key after the CA confirms the account does not exist. Other ACME errors
remain failures; an existing registered account is not replaced.

Keep both `acme_state` and `acme_public` volumes in your backup plan. The former
contains the account key. Do not delete them to troubleshoot renewal. To force a
renewal after changing CA configuration, use the same Compose environment:

```sh
podman compose -f docker-compose.yml -f docker-compose.acme.yml exec -T acme \
  /usr/local/bin/acme-loop once --force
```

## Repeatable local verification

```sh
COMPOSE_PROJECT_NAME=neronet-acme-check NERONET_PORT_OFFSET=500 \
  sh scripts/dev/test-acme.sh
```

Use a fresh dedicated project and free ports. The test runs two real nodes with
the internal CA, exchanges TCP in the overlay, then uses Pebble for real HTTP-01,
verifies the certificate nginx serves, forces and observes a renewal, checks a
failed renewal and malformed publication across restart/recreation, recovers from
a first CA outage without replacing the account key, and exchanges overlay TCP
through nodes using the private ACME CA.
No validation or TLS trust check is skipped. It leaves its test stack running;
`test-acme.sh renew` repeats the served-renewal checks. Pebble is a local test CA,
not a public Let's Encrypt issuance. CI runs this same scenario.
