#!/bin/sh
# Usage: gen-relay-certs.sh <certs-dir> <relay-name> [<relay-name> ...]
#
# A certificate for each derp-v2 relay, signed by the development CA gen-certs.sh
# wrote. Nodes verify a relay with the CA they pin for the control plane and never
# disable verification, so each relay needs a certificate whose name is the host in
# the relay URL the control plane hands out (https://<relay-name>:8443/derp).
# Existing certificates are kept; the CA must already exist.
set -eu
. "$(dirname "$0")/engine.sh"

DIR=${1:?usage: gen-relay-certs.sh <certs-dir> <relay-name> ...}
shift
[ "$#" -gt 0 ] || die "name at least one relay"
[ -f "$DIR/ca.crt" ] && [ -f "$DIR/ca.key" ] || die "no development CA in $DIR; run gen-certs.sh first"

umask 077
D=$(HOST_PATH "$DIR")
for name in "$@"; do
  case "$name" in
    *[!a-z0-9-]* | '') die "invalid relay name: $name" ;;
  esac
  out="$DIR/relays/$name"
  mkdir -p "$out"
  # The relay runs as uid 10001, which on a Linux host (rootful Docker or rootless
  # Podman alike) is "other" for files the developer owns. So the directory mounted
  # into the relay and its files are world-readable, and the host-side protection is
  # $DIR/relays itself, which only the developer can enter.
  chmod 700 "$DIR/relays" 2>/dev/null || true
  chmod 755 "$out" 2>/dev/null || true
  O=$(HOST_PATH "$out")
  if [ -f "$out/tls.crt" ] && [ -f "$out/tls.key" ] &&
    openssl verify -CAfile "$D/ca.crt" "$O/tls.crt" >/dev/null 2>&1; then
    continue
  fi
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$O/tls.key" -out "$O/tls.csr" -subj "/CN=$name" 2>"$out/openssl.log" ||
    die "creating the key for $name failed: $(cat "$out/openssl.log")"
  cat > "$out/tls.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:$name
EOF
  openssl x509 -req -in "$O/tls.csr" -CA "$D/ca.crt" -CAkey "$D/ca.key" \
    -CAcreateserial -out "$O/tls.crt" -days 825 -extfile "$O/tls.ext" 2>"$out/openssl.log" ||
    die "signing the certificate for $name failed: $(cat "$out/openssl.log")"
  rm -f "$out/tls.csr" "$out/tls.ext" "$out/openssl.log" "$DIR/ca.srl"
  chmod 644 "$out/tls.crt" "$out/tls.key" 2>/dev/null || true
  openssl verify -CAfile "$D/ca.crt" "$O/tls.crt" >/dev/null || die "the $name certificate does not verify"
  echo "wrote $out (relay certificate for DNS:$name)"
done
