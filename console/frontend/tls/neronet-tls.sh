#!/bin/sh
# Where the console's certificate comes from, and keeping nginx on the newest one.
#
# Usage: neronet-tls.sh setup | watch
#
#   setup  writes the small configuration files nginx.conf.template includes, for the mode
#          NERONET_TLS_MODE selects. Runs once, before nginx starts, from
#          /docker-entrypoint.d/40-neronet-tls.sh. In acme mode it also starts "watch".
#   watch  acme mode only. Every NERONET_TLS_WATCH_INTERVAL seconds, looks at the
#          certificate the acme service published and, when it is a new one, has nginx
#          reload. A reload starts new workers on the new certificate and lets the old
#          ones finish their connections; nothing is refused in between.
#
# NERONET_TLS_MODE
#   internal (default)  the certificate and key are the compose secrets console_tls_cert
#                       and console_tls_key. A deployment mounts its own, issued by its
#                       own CA; scripts/dev/gen-certs.sh writes a development pair.
#   acme                the certificate comes from an ACME CA, through the acme service
#                       (docker-compose.acme.yml). Requires NERONET_PUBLIC_DOMAIN. Port 80
#                       answers ACME HTTP-01 challenges and redirects everything else to
#                       the console. Until the first certificate exists, TLS handshakes are
#                       refused and /healthz answers 503, so nothing is ever served under a
#                       certificate the clients would have to be told to ignore.
#
# The files this writes, all under /etc/nginx/neronet, are included by nginx.conf.template:
#   tls.conf      ssl_certificate directives, or "ssl_reject_handshake on" while there is none
#   healthz.conf  the status of the loopback /healthz: 503 while there is no certificate
#   hsts.conf     Strict-Transport-Security for the console document (acme only)
#   http01.conf   the port 80 server (acme only)
set -u

DIR=/etc/nginx/neronet
LIB=/usr/local/lib/neronet
MODE=${NERONET_TLS_MODE:-internal}
LIVE=${NERONET_ACME_LIVE:-/acme/live/current}
INTERVAL=${NERONET_TLS_WATCH_INTERVAL:-30}
APPLIED=$DIR/.applied

log() { echo "neronet-tls: $*"; }
die() {
  echo "neronet-tls: error: $*" >&2
  exit 1
}

# Writes stdin to $DIR/$1 through a temporary name, so nginx never reads half a file.
put() {
  cat > "$DIR/.$1.tmp" && mv -f "$DIR/.$1.tmp" "$DIR/$1"
}

tls_internal() {
  put tls.conf << 'EOF'
ssl_certificate     /run/secrets/console_tls_cert;
ssl_certificate_key /run/secrets/console_tls_key;
EOF
  put healthz.conf << 'EOF'
return 200 "ok\n";
EOF
  put hsts.conf < /dev/null
  put http01.conf < /dev/null
}

tls_pending() {
  put tls.conf << 'EOF'
# No certificate has been published yet. Refuse the handshake rather than present one the
# client cannot verify; the first certificate switches this file and reloads nginx.
ssl_reject_handshake on;
EOF
  put healthz.conf << 'EOF'
return 503 "no certificate yet\n";
EOF
}

tls_ready() {
  put tls.conf << EOF
ssl_certificate     $LIVE/fullchain.pem;
ssl_certificate_key $LIVE/privkey.pem;
EOF
  put healthz.conf << 'EOF'
return 200 "ok\n";
EOF
}

acme_static() {
  [ -n "${NERONET_PUBLIC_DOMAIN:-}" ] || die "NERONET_TLS_MODE=acme needs NERONET_PUBLIC_DOMAIN"
  # The name and the port are written into nginx's configuration and into a redirect.
  case "$NERONET_PUBLIC_DOMAIN" in
    *[!A-Za-z0-9.-]* | .* | *. | *..*) die "NERONET_PUBLIC_DOMAIN '$NERONET_PUBLIC_DOMAIN' is not a plain host name" ;;
  esac
  port=${NERONET_CONSOLE_PUBLIC_PORT:-8443}
  case "$port" in
    '' | *[!0-9]*) die "NERONET_CONSOLE_PUBLIC_PORT '$port' is not a port number" ;;
  esac
  authority=$NERONET_PUBLIC_DOMAIN
  [ "$port" = 443 ] || authority=$authority:$port

  # Only the authority is substituted: $uri and $request_uri are nginx's.
  NERONET_REDIRECT_AUTHORITY=$authority envsubst '${NERONET_REDIRECT_AUTHORITY}' \
    < "$LIB/acme-http.conf.template" | put http01.conf

  # The domain is a real one and the certificate is trusted by browsers, which is the case
  # HSTS is for. The backend sends the same policy on its API responses when it runs in
  # production, so a browser sees one policy from this host and not two.
  put hsts.conf << 'EOF'
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
EOF
}

# The identity of the published certificate: which directory "current" points at, and
# the size and time of the certificate in it. Fails when there is no usable pair.
cert_id() {
  [ -s "$LIVE/fullchain.pem" ] && [ -s "$LIVE/privkey.pem" ] || return 1
  printf '%s %s\n' "$(readlink "$LIVE" 2> /dev/null || echo "$LIVE")" \
    "$(stat -L -c '%s:%Y' "$LIVE/fullchain.pem")"
}

# Points nginx's configuration at the published certificate, and keeps it only if nginx
# accepts it: a certificate that does not match its key, or one that cannot be parsed,
# must not be what the next reload or the next restart trips over.
apply() {
  was_pending=$(grep -c ssl_reject_handshake "$DIR/tls.conf" || true)
  tls_ready
  if out=$(nginx -t 2>&1); then
    return 0
  fi
  log "nginx rejects the certificate in $LIVE: $out"
  if [ "$was_pending" -gt 0 ]; then
    tls_pending
  fi
  return 1
}

reload() {
  [ -s /run/nginx.pid ] || return 1
  nginx -s reload
}

watch() {
  applied=$(cat "$APPLIED" 2> /dev/null || true)
  refused=""
  log "watching $LIVE every ${INTERVAL}s"
  while :; do
    sleep "$INTERVAL"
    id=$(cert_id) || continue
    [ "$id" != "$applied" ] || continue
    [ "$id" != "$refused" ] || continue
    if apply; then
      if reload; then
        applied=$id
        refused=""
        echo "$id" > "$APPLIED"
        log "nginx reloaded; now serving $id"
      else
        log "reload failed; trying again at the next check"
      fi
    else
      refused=$id
    fi
  done
}

setup() {
  mkdir -p "$DIR"
  case "$MODE" in
    internal)
      tls_internal
      ;;
    acme)
      acme_static
      tls_pending
      : > "$APPLIED"
      if id=$(cert_id) && apply; then
        echo "$id" > "$APPLIED"
        log "serving the certificate published in $LIVE"
      else
        log "no certificate published yet: TLS handshakes are refused until the acme service has one"
      fi
      # Detached from the entrypoint's stdin, which is the list of scripts it is running.
      "$0" watch < /dev/null &
      ;;
    *)
      die "NERONET_TLS_MODE must be internal or acme, not '$MODE'"
      ;;
  esac
}

case "${1:-}" in
  setup) setup ;;
  watch) watch ;;
  *)
    echo "usage: neronet-tls.sh setup | watch" >&2
    exit 2
    ;;
esac
