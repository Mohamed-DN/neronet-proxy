#!/bin/sh
# Keeps the console's certificate current (NERONET_TLS_MODE=acme).
#
# lego asks the ACME CA for a certificate for NERONET_PUBLIC_DOMAIN and proves control of
# the name with HTTP-01: it writes the challenge token into a webroot, and nginx serves
# that webroot on port 80 at /.well-known/acme-challenge/. Every
# NERONET_ACME_CHECK_INTERVAL seconds it is run again; lego itself decides whether a
# renewal is due (ARI when the CA offers it, otherwise when a third of the certificate's
# lifetime is left, half for certificates of ten days or less). Each certificate it
# produces is published for nginx under a new directory, and the "current" symlink is
# switched to it in one rename. nginx watches that symlink and reloads (see
# console/frontend/tls/neronet-tls.sh); a reload does not drop connections.
#
# Usage: acme-loop [once [--force]]
#   (no argument)  the service: wait for nginx, then check, renew and publish, forever
#   once           a single pass, then exit. --force renews even when it is not due
#
# Environment:
#   NERONET_PUBLIC_DOMAIN       the host name the console answers to (required)
#   NERONET_ACME_AGREE_TOS      must be "true": the operator accepts the CA's terms of service
#   NERONET_ACME_DIRECTORY      ACME directory URL. Default: Let's Encrypt production
#   NERONET_ACME_EMAIL          contact address, optional
#   NERONET_ACME_PROFILE        certificate profile the CA offers (for example "shortlived"), optional
#   NERONET_ACME_CHECK_INTERVAL seconds between checks. Default 43200 (twice a day)
#   NERONET_ACME_RETRY_INTERVAL seconds before the first retry after a failure; it doubles up
#                               to one hour. Default 300. Let's Encrypt allows five failed
#                               validations per hour for one name, so this is not a busy loop
#   NERONET_ACME_SELFCHECK_URL  where nginx's port 80 answers from here. Default http://frontend
#   LEGO_CA_CERTIFICATES        a file of CA certificates to trust when talking to the ACME
#                               directory, for a private ACME CA. Read by lego itself
set -eu

STATE=/var/lib/acme # lego's account key and certificates: never shared with nginx
PUBLIC=/acme        # shared with nginx, which mounts it read-only
WEBROOT=$PUBLIC/webroot
LIVE=$PUBLIC/live

log() { printf '%s acme: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() {
  log "error: $*" >&2
  exit 1
}

DOMAIN=${NERONET_PUBLIC_DOMAIN:-}
DIRECTORY=${NERONET_ACME_DIRECTORY:-https://acme-v02.api.letsencrypt.org/directory}
EMAIL=${NERONET_ACME_EMAIL:-}
PROFILE=${NERONET_ACME_PROFILE:-}
CHECK_INTERVAL=${NERONET_ACME_CHECK_INTERVAL:-43200}
RETRY_INTERVAL=${NERONET_ACME_RETRY_INTERVAL:-300}
SELFCHECK_URL=${NERONET_ACME_SELFCHECK_URL:-http://frontend}

# The domain ends up in a command line and, through nginx, in a configuration file.
case "$DOMAIN" in
  '') die "NERONET_PUBLIC_DOMAIN is not set" ;;
  *[!A-Za-z0-9.-]* | .* | *. | *..*) die "NERONET_PUBLIC_DOMAIN '$DOMAIN' is not a plain host name" ;;
esac
case "$CHECK_INTERVAL$RETRY_INTERVAL" in
  *[!0-9]*) die "NERONET_ACME_CHECK_INTERVAL and NERONET_ACME_RETRY_INTERVAL are whole seconds" ;;
esac
[ "${NERONET_ACME_AGREE_TOS:-}" = "true" ] ||
  die "set NERONET_ACME_AGREE_TOS=true to accept the terms of service of the CA at $DIRECTORY"

# lego names the files after the first domain. Where exactly depends on its release, so
# the lookup is by name rather than by a hard-coded layout.
find_lego_file() { # extension
  find "$STATE" -type f -name "$DOMAIN.$1" 2>/dev/null | head -n 1
}

# Writes lego's current certificate and key under $LIVE/<stamp>/ and points $LIVE/current
# at it, unless that is what is already published.
publish() {
  crt=$(find_lego_file crt)
  key=$(find_lego_file key)
  [ -n "$crt" ] && [ -n "$key" ] || return 1

  if [ -e "$LIVE/current/fullchain.pem" ] && cmp -s "$crt" "$LIVE/current/fullchain.pem" &&
    cmp -s "$key" "$LIVE/current/privkey.pem"; then
    return 0
  fi

  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  dir=$LIVE/$stamp
  n=0
  while [ -e "$dir" ]; do
    n=$((n + 1))
    dir=$LIVE/$stamp-$n
  done
  mkdir -p "$dir"
  # The key is written first and only ever readable by its owner; nginx's master process
  # reads it as root when it loads the configuration.
  (umask 077 && cp "$key" "$dir/privkey.pem")
  cp "$crt" "$dir/fullchain.pem"
  chmod 644 "$dir/fullchain.pem"
  chmod 755 "$dir"

  # Rename over the old link: nginx sees the old pair or the new one, never a gap.
  ln -s "$(basename "$dir")" "$LIVE/.current.new"
  mv -fT "$LIVE/.current.new" "$LIVE/current"
  log "published $(basename "$dir") for $DOMAIN"

  # Keep the three newest. An older directory may still be what a reload in progress read.
  for old in "$LIVE"/*; do
    [ -d "$old" ] && [ ! -L "$old" ] || continue
    printf '%s\n' "${old##*/}"
  done | sort -r | tail -n +4 | while read -r old; do
    rm -rf "${LIVE:?}/$old"
  done
}

# One pass of lego, then publish. $1 may be --force.
run_once() {
  set -- --log.format text run --path "$STATE" --accept-tos --server "$DIRECTORY" \
    -d "$DOMAIN" --http --http.webroot "$WEBROOT" --no-random-sleep "$@"
  [ -z "$EMAIL" ] || set -- "$@" --email "$EMAIL"
  [ -z "$PROFILE" ] || set -- "$@" --profile "$PROFILE"
  if /lego "$@" && publish; then
    return 0
  fi
  return 1
}

prepare() {
  mkdir -p "$STATE" "$WEBROOT/.well-known/acme-challenge" "$LIVE"
  chmod 755 "$PUBLIC" "$WEBROOT" "$WEBROOT/.well-known" "$WEBROOT/.well-known/acme-challenge" "$LIVE"
}

# Before bothering the CA: is the webroot this container writes the one nginx serves on
# port 80? A failed validation counts against the CA's rate limit; a wrong volume does not
# need to.
wait_for_nginx() {
  probe=$WEBROOT/.well-known/acme-challenge/neronet-selfcheck
  echo ok > "$probe"
  chmod 644 "$probe"
  waited=0
  until [ "$(wget -q -O - "$SELFCHECK_URL/.well-known/acme-challenge/neronet-selfcheck" 2>/dev/null || true)" = "ok" ]; do
    if [ "$waited" -ge 300 ]; then
      rm -f "$probe"
      die "nginx does not serve the webroot at $SELFCHECK_URL/.well-known/acme-challenge/ after ${waited}s"
    fi
    [ "$waited" -ne 0 ] || log "waiting for nginx to serve the webroot at $SELFCHECK_URL"
    sleep 2
    waited=$((waited + 2))
  done
  rm -f "$probe"
}

prepare

case "${1:-}" in
  once)
    shift
    case "${1:-}" in
      '') run_once ;;
      --force) run_once --renew-force ;;
      *) die "usage: acme-loop [once [--force]]" ;;
    esac
    exit $?
    ;;
  '') ;;
  *) die "usage: acme-loop [once [--force]]" ;;
esac

log "certificate for $DOMAIN from $DIRECTORY; checking every ${CHECK_INTERVAL}s"
wait_for_nginx

retry=$RETRY_INTERVAL
while :; do
  if run_once; then
    retry=$RETRY_INTERVAL
    wait=$CHECK_INTERVAL
  else
    wait=$retry
    [ "$wait" -le "$CHECK_INTERVAL" ] || wait=$CHECK_INTERVAL
    retry=$((retry * 2))
    [ "$retry" -le 3600 ] || retry=3600
    log "this pass failed; the certificate nginx serves is unchanged. Next attempt in ${wait}s"
  fi
  sleep "$wait"
done
