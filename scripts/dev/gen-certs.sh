#!/bin/sh
# Usage: gen-certs.sh [dir]
#
# Writes a development certificate authority and a console certificate signed by it.
# Default dir: <repo>/certs. Refuses to overwrite an existing CA, so the nodes already
# pinned to it keep working.
#
#   ca.crt      the CA the nodes pin (SOVEREIGN_CONTROL_PLANE_CA) and a browser can trust
#   ca.key      its private key; only this script uses it
#   server.crt  the console's certificate: frontend (the compose service the nodes
#   server.key  dial), localhost, 127.0.0.1 and ::1
#
# Local development only. A deployment brings its own certificate and CA; nothing in
# the stack depends on this script beyond the file names above.
set -eu
. "$(dirname "$0")/engine.sh"

DIR=${1:-$REPO_ROOT/certs}
command -v openssl >/dev/null 2>&1 || die "openssl is not installed"

if [ -e "$DIR/ca.crt" ] || [ -e "$DIR/ca.key" ]; then
  die "$DIR already holds a CA; remove the directory first if you want new certificates"
fi

umask 077
mkdir -p "$DIR"

# engine.sh turns Git Bash's path rewriting off (it would mangle "/CN=..."), so the
# paths openssl sees are given in the platform's own notation.
D=$(HOST_PATH "$DIR")

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout "$D/ca.key" -out "$D/ca.crt" -days 825 \
  -subj "/CN=NeroNet development CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>"$DIR/openssl.log" ||
  die "creating the CA failed: $(cat "$DIR/openssl.log")"

openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout "$D/server.key" -out "$D/server.csr" \
  -subj "/CN=frontend" 2>"$DIR/openssl.log" ||
  die "creating the console key failed: $(cat "$DIR/openssl.log")"

cat > "$DIR/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:frontend,DNS:localhost,IP:127.0.0.1,IP:::1
EOF

openssl x509 -req -in "$D/server.csr" -CA "$D/ca.crt" -CAkey "$D/ca.key" \
  -CAcreateserial -out "$D/server.crt" -days 825 -extfile "$D/server.ext" 2>"$DIR/openssl.log" ||
  die "signing the console certificate failed: $(cat "$DIR/openssl.log")"

rm -f "$DIR/server.csr" "$DIR/server.ext" "$DIR/ca.srl" "$DIR/openssl.log"

# The containers read these through bind mounts as their own users; the keys stay
# unreadable to other users of this machine. No effect on NTFS through Git Bash.
chmod 644 "$DIR/ca.crt" "$DIR/server.crt" 2>/dev/null || true
chmod 640 "$DIR/server.key" 2>/dev/null || true

openssl verify -CAfile "$D/ca.crt" "$D/server.crt" >/dev/null || die "the console certificate does not verify against the CA"
echo "wrote $DIR (development CA and console certificate)"
