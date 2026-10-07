#!/bin/sh
# Usage: COMPOSE_PROJECT_NAME=neronet-acme-<name> NERONET_PORT_OFFSET=500 sh scripts/dev/test-acme.sh [all|acme|renew|reject|trust]
# Exercises nginx + lego + Pebble, including real HTTP-01, a served renewal,
# failure retention, and two nodes carrying TCP over the overlay in both TLS modes.
# `all` needs a fresh dedicated project. `acme` resumes at the ACME phase after
# internal mode was checked. `renew` repeats only the live renewal checks.
# Leaves this test stack up for independent review. Never removes volumes.
set -eu
# shellcheck source=scripts/dev/engine.sh
. "$(dirname "$0")/engine.sh"
cd "$REPO_ROOT"

case "${COMPOSE_PROJECT_NAME:-}" in
  neronet-acme-*) ;;
  *) die "set a dedicated COMPOSE_PROJECT_NAME beginning with neronet-acme-" ;;
esac
OFFSET=${NERONET_PORT_OFFSET:-500}
export NERONET_PORT_OFFSET="$OFFSET"
export NERONET_CONSOLE_PORT=$((8443 + OFFSET))
export NERONET_API_PORT=$((8081 + OFFSET))
export NERONET_NODE_SERVICES="relay-de client-it"
export NERONET_HTTP_PORT=$((8080 + OFFSET))
export NERONET_ACME_MANAGEMENT_PORT=$((15000 + OFFSET))
export NERONET_PUBLIC_DOMAIN=console.neronet.test
export NERONET_ACME_TEST_CERTS_DIR="certs/acme-test-$COMPOSE_PROJECT_NAME"
TEST_DIR=$NERONET_ACME_TEST_CERTS_DIR
TEST_HOST="$(HOST_PATH "$REPO_ROOT")/$TEST_DIR"
MODE=${1:-all}
TLS_REVOCATION=""
if curl -V 2>/dev/null | grep -qi schannel; then
  TLS_REVOCATION=--ssl-revoke-best-effort
fi

acme_settings() {
  export NERONET_TLS_MODE=acme
  export NERONET_EXTRA_COMPOSE_FILE=docker/acme/docker-compose.test.yml
  export NERONET_ACME_DIRECTORY=https://pebble:14000/dir
  export NERONET_ACME_DIRECTORY_CA_FILE="$TEST_DIR/endpoint-ca.crt"
  export NERONET_ACME_CA_CERTIFICATES=/run/secrets/acme_directory_ca
  export NERONET_CONTROL_PLANE_CA_FILE="$TEST_DIR/issuer-ca.crt"
  export NERONET_ACME_AGREE_TOS=true
  export NERONET_TLS_WATCH_INTERVAL=1
  export NERONET_CONSOLE_PUBLIC_PORT=$NERONET_CONSOLE_PORT
  export NERONET_CONSOLE_ORIGIN="https://$NERONET_PUBLIC_DOMAIN:$NERONET_CONSOLE_PORT"
}

acme_compose() {
  $COMPOSE -f docker-compose.yml -f docker-compose.acme.yml \
    -f docker/acme/docker-compose.test.yml "$@"
}

check_tls() {
  # The requested host name and CA are both checked. No trust-bypass flag is used.
  # shellcheck disable=SC2086
  body=$(curl -fsS --max-time 10 $TLS_REVOCATION --cacert "$TEST_HOST/issuer-ca.crt" \
    --resolve "$NERONET_PUBLIC_DOMAIN:$NERONET_CONSOLE_PORT:127.0.0.1" \
    "https://$NERONET_PUBLIC_DOMAIN:$NERONET_CONSOLE_PORT/api/health") || return 1
  case "$body" in *'"status":"ok"'*) return 0 ;; *) return 1 ;; esac
}

recover_unhealthy_frontend() {
  # Compose --wait fails immediately for an existing unhealthy container. Start
  # issuance without that gate, then measure the watcher's actual TLS recovery.
  # The same frontend process must recover; a restart would hide this regression.
  acme_compose up -d --no-deps acme
  start=$(date +%s)
  # This authenticates Pebble's management endpoint with its distinct endpoint CA.
  # Only a successful response replaces the issuance trust root used below.
  # shellcheck disable=SC2086
  until curl -fsS --max-time 5 $TLS_REVOCATION --cacert "$TEST_HOST/endpoint-ca.crt" \
    "https://127.0.0.1:$NERONET_ACME_MANAGEMENT_PORT/roots/0" > "$TEST_DIR/issuer-ca.crt.tmp"; do
    [ "$(($(date +%s) - start))" -lt 30 ] || die "the verified Pebble management endpoint did not recover"
    sleep 1
  done
  # The redirected response inherits umask 077. This public CA is mounted into
  # unprivileged nodes, so preserve readability when replacing the placeholder.
  chmod 644 "$TEST_DIR/issuer-ca.crt.tmp"
  mv "$TEST_DIR/issuer-ca.crt.tmp" "$TEST_DIR/issuer-ca.crt"
  start=$(date +%s)
  until check_tls; do
    [ "$(($(date +%s) - start))" -lt 60 ] || die "the unhealthy frontend did not recover verified TLS"
    sleep 1
  done
  until [ "$($ENGINE inspect --format '{{.State.Health.Status}}' "$frontend_id")" = healthy ]; do
    [ "$(($(date +%s) - start))" -lt 60 ] || die "the frontend stayed unhealthy after TLS recovered"
    sleep 1
  done
  [ "$(acme_compose ps -q frontend)" = "$frontend_id" ] || die "bootstrap recovery replaced the frontend"
  [ "$($ENGINE inspect --format '{{.State.StartedAt}}' "$frontend_id")" = "$frontend_started" ] ||
    die "bootstrap recovery restarted the frontend"
  echo "PASS  the same unhealthy frontend recovers verified TLS and healthy status without restarting"
}

serial() {
  openssl s_client -connect "127.0.0.1:$NERONET_CONSOLE_PORT" \
    -servername "$NERONET_PUBLIC_DOMAIN" -CAfile "$TEST_HOST/issuer-ca.crt" \
    -verify_return_error < /dev/null 2>/dev/null | openssl x509 -noout -serial
}

wait_overlay() {
  # Registration and health precede endpoint exchange. Readiness is the TCP
  # exchange itself, bounded in time, rather than a guessed startup sleep.
  start=$(date +%s)
  until sh scripts/dev/scenarios/overlay.sh matrix; do
    [ "$(($(date +%s) - start))" -lt 180 ] || die "overlay did not converge within 180s"
    sleep 2
  done
}

renew() {
  check_tls || die "the current ACME certificate does not verify"
  before=$(serial)
  echo "TLS before renewal: $before"
  acme_compose exec -T acme /usr/local/bin/acme-loop once --force
  elapsed=0
  while :; do
    after=$(serial) || after=""
    if [ -n "$after" ] && [ "$after" != "$before" ] && check_tls; then
      break
    fi
    [ "$elapsed" -lt 30 ] || die "nginx did not serve the renewed certificate within 30s"
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "PASS  nginx serves a new verified certificate after ${elapsed}s: $after"
  # A failed CA call must not replace the working certificate or make TLS fail.
  if acme_compose run --rm --no-deps \
    -e NERONET_ACME_DIRECTORY=https://pebble:14000/missing acme once --force; then
    die "an unavailable ACME directory unexpectedly succeeded"
  fi
  check_tls || die "a failed renewal broke the existing certificate"
  [ "$(serial)" = "$after" ] || die "a failed renewal replaced the served certificate"
  echo "PASS  failed renewal retains the last working certificate"
}

reject_bad_certificate() (
  check_tls || die "the current ACME certificate does not verify"
  before=$(serial)
  original=$(acme_compose exec -T acme readlink /acme/live/current | tr -d '\r')
  # shellcheck disable=SC2329 # Called by the EXIT trap.
  restore() {
    # shellcheck disable=SC2016 # Expanded inside the container, not by the host.
    acme_compose exec -T acme sh -c \
      'ln -s "$1" /acme/live/.restore; mv -fT /acme/live/.restore /acme/live/current; rm -rf /acme/live/99991231T235959Z-invalid-test' _ "$original" >/dev/null || true
  }
  trap restore EXIT
  # Corrupt only a new generation in this dedicated test stack. The working
  # pair and its key remain intact; the trap always restores the publication.
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # shellcheck disable=SC2016 # Expanded inside the container, not by the host.
  acme_compose exec -T acme sh -c '
    bad=/acme/live/99991231T235959Z-invalid-test
    mkdir -p "$bad"
    cp /acme/live/current/fullchain.pem "$bad/fullchain.pem"
    printf "invalid private key\n" > "$bad/privkey.pem"
    ln -s 99991231T235959Z-invalid-test /acme/live/.bad
    mv -fT /acme/live/.bad /acme/live/current
  '
  elapsed=0
  until acme_compose logs --no-color --since "$since" frontend | grep -q 'nginx rejects the certificate'; do
    [ "$elapsed" -lt 15 ] || die "nginx did not validate the invalid certificate"
    sleep 1
    elapsed=$((elapsed + 1))
  done
  check_tls || die "an invalid published key broke the running TLS listener"
  [ "$(serial)" = "$before" ] || die "an invalid generation replaced the working certificate"
  acme_compose restart frontend
  elapsed=0
  until check_tls; do
    [ "$elapsed" -lt 30 ] || die "restart lost the last working certificate after a rejected generation"
    sleep 1
    elapsed=$((elapsed + 1))
  done
  [ "$(serial)" = "$before" ] || die "restart did not retain the last working certificate"
  acme_compose up -d --force-recreate --no-deps frontend
  elapsed=0
  until check_tls; do
    [ "$elapsed" -lt 30 ] || die "container recreation lost the last working certificate"
    sleep 1
    elapsed=$((elapsed + 1))
  done
  [ "$(serial)" = "$before" ] || die "container recreation replaced the working certificate"
  echo "PASS  invalid generation is rejected; restart and recreation retain verified TLS"
)

reject_untrusted_ca() {
  # A real node process without the private issuance CA must fail TLS before it
  # enrols. The temporary identity and the process disappear with this container.
  if output=$(acme_compose --profile nodes run --rm --no-deps \
    -e SOVEREIGN_CONTROL_PLANE_CA= -e SOVEREIGN_DATAPLANE=off --entrypoint sh client-it \
    -c 'timeout 15 /bin/sovereign-node -control-url https://console.neronet.test:8443 -identity /tmp/untrusted-node.key -country IT' 2>&1); then
    die "a node unexpectedly completed with an untrusted private CA"
  fi
  echo "$output" | grep -q 'certificate signed by unknown authority' ||
    die "the untrusted node did not report the expected TLS trust failure"
  echo "$output" | grep 'certificate signed by unknown authority' | head -n 1
  echo "PASS  a real node rejects the ACME certificate without its issuance CA"
}

case "$MODE" in
  renew)
    acme_settings
    renew
    exit 0
    ;;
  reject)
    acme_settings
    reject_bad_certificate
    exit 0
    ;;
  trust)
    acme_settings
    reject_untrusted_ca
    exit 0
    ;;
  all | acme) ;;
  *) die "usage: test-acme.sh [all|acme|renew|reject|trust]" ;;
esac

if [ "$MODE" = all ]; then
  existing=$($ENGINE ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" -q)
  [ -z "$existing" ] || die "project $COMPOSE_PROJECT_NAME already has containers; use renew or a fresh test project"
  [ -f .env ] || sh scripts/dev/gen-env.sh

  # Internal mode is the default and must still enrol nodes with their pinned CA.
  export NERONET_TLS_MODE=internal
  unset NERONET_EXTRA_COMPOSE_FILE NERONET_CONTROL_PLANE_CA_FILE NERONET_NODE_CA NERONET_CONTROL_PLANE_URL
  sh scripts/dev/stack.sh up
  sh scripts/dev/stack.sh nodes derp-eu relay-de client-it
  sh scripts/dev/smoke.sh 2 180
  wait_overlay
  echo "PASS  internal CA and overlay traffic"
fi

umask 077
mkdir -p "$TEST_DIR"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
  -subj '/CN=NeroNet ACME test endpoint CA' -addext 'basicConstraints=critical,CA:TRUE' \
  -keyout "$TEST_HOST/endpoint-ca.key" -out "$TEST_HOST/endpoint-ca.crt" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj '/CN=pebble' \
  -keyout "$TEST_HOST/endpoint.key" -out "$TEST_HOST/endpoint.csr" 2>/dev/null
printf '%s\n' 'subjectAltName=DNS:pebble,DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' \
  > "$TEST_DIR/endpoint.ext"
openssl x509 -req -days 2 -in "$TEST_HOST/endpoint.csr" -CA "$TEST_HOST/endpoint-ca.crt" \
  -CAkey "$TEST_HOST/endpoint-ca.key" -CAcreateserial -extfile "$TEST_HOST/endpoint.ext" \
  -out "$TEST_HOST/endpoint.crt" 2>/dev/null
# The issuance CA is random on each Pebble start. Fetch it from the verified
# management endpoint after issuance; this placeholder is never a trust bypass.
: > "$TEST_DIR/issuer-ca.crt"
chmod 644 "$TEST_DIR"/*.crt
acme_settings

# First start only nginx and Pebble. With no certificate, nginx must reject TLS
# and report pending health, while HTTP-01 is already reachable.
acme_compose up -d --build frontend pebble
elapsed=0
until acme_compose exec -T frontend sh -c \
  'wget -S -O /dev/null http://127.0.0.1:8090/healthz 2>&1 | grep -q "503"'; do
  [ "$elapsed" -lt 30 ] || die "nginx did not enter the pending-certificate state"
  sleep 1
  elapsed=$((elapsed + 1))
done
handshake=$(openssl s_client -connect "127.0.0.1:$NERONET_CONSOLE_PORT" \
  -servername "$NERONET_PUBLIC_DOMAIN" < /dev/null 2>&1 || true)
echo "$handshake" | grep -q 'unrecognized name' || die "nginx did not reject the pending TLS handshake"
echo "PASS  pending certificate refuses TLS and reports unhealthy"
frontend_id=$(acme_compose ps -q frontend)
[ -n "$frontend_id" ] || die "the pending frontend container is missing"
frontend_started=$($ENGINE inspect --format '{{.State.StartedAt}}' "$frontend_id")
elapsed=0
until [ "$($ENGINE inspect --format '{{.State.Health.Status}}' "$frontend_id")" = unhealthy ]; do
  [ "$elapsed" -lt 30 ] || die "the pending frontend did not become unhealthy"
  sleep 1
  elapsed=$((elapsed + 1))
done
echo "PASS  frontend is unhealthy before first-issuance recovery"

# Reproduce a first-run CA outage. Lego must later register the existing key,
# rather than strand the saved-but-unregistered account or generate a replacement.
acme_compose build acme
acme_compose stop pebble
if acme_compose run --rm --no-deps acme once; then
  die "issuance unexpectedly succeeded while the CA was stopped"
fi
account_key_hash() {
  acme_compose run --rm --no-deps --entrypoint sh acme -c \
    'find /var/lib/acme/accounts -name "*.key" -type f -exec sha256sum {} \; | cut -d " " -f 1'
}
key_before=$(account_key_hash)
[ -n "$key_before" ] || die "the failed first attempt did not persist its account key"
acme_compose start pebble
recover_unhealthy_frontend
sh scripts/dev/stack.sh up
[ "$(account_key_hash)" = "$key_before" ] || die "bootstrap recovery replaced the account key"
echo "PASS  first CA outage recovers using the same account key"
check_tls || die "nginx's issued certificate did not verify against the Pebble root"
echo "PASS  HTTP-01 issuance and nginx's served certificate"

code=$(curl -sS --max-time 10 -w '\n%{http_code}' \
  "http://127.0.0.1:$NERONET_HTTP_PORT/.well-known/acme-challenge/missing" | tail -n 1)
[ "$code" = 404 ] || die "a missing HTTP-01 token returned $code"
redirect=$(curl -sSI --max-time 10 -H 'Host: attacker.invalid' "http://127.0.0.1:$NERONET_HTTP_PORT/")
echo "$redirect" | grep -qi "location: https://$NERONET_PUBLIC_DOMAIN:$NERONET_CONSOLE_PORT/" ||
  die "HTTP redirect did not use the configured authority"

renew
reject_bad_certificate
reject_untrusted_ca
sh scripts/dev/stack.sh nodes derp-eu relay-de client-it
# These are new containers: old heartbeat rows alone cannot prove that a node
# accepted the new certificate. Require registration in each current process.
elapsed=0
until acme_compose --profile nodes logs --no-color relay-de | grep -Eq 'Registered (with control plane|on attempt)' &&
  acme_compose --profile nodes logs --no-color client-it | grep -Eq 'Registered (with control plane|on attempt)'; do
  [ "$elapsed" -lt 180 ] || die "new node processes did not enrol through the ACME TLS endpoint"
  sleep 5
  elapsed=$((elapsed + 5))
done
sh scripts/dev/smoke.sh 2 180
wait_overlay
echo "PASS  ACME CA and overlay traffic after renewal"
