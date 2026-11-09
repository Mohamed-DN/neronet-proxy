#!/bin/sh
# Usage: scripts/dev/test-install.sh
#
# Runs scripts/install.sh as root inside a throw-away container, against a fake
# container engine, and checks what the installer promises: a rerun keeps the
# existing .env (secrets and the database password the data volume was created with),
# a stack that never becomes healthy is a failed install, no secret reaches the
# terminal, unsupported options are refused, and the console is announced on https.
# Nothing on the host is touched; no real container is started by the installer.
set -eu
. "$(dirname "$0")/engine.sh"

IMAGE=${NERONET_TEST_INSTALL_IMAGE:-docker.io/library/golang:1.26.10}
SRC=$(HOST_PATH "$REPO_ROOT/scripts")

$ENGINE run --rm -v "$SRC:/src/scripts:ro" "$IMAGE" bash -c '
set -u
fail=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }

mkdir -p /fake/bin /work
# A fake engine: "compose ps" prints FAKE_HEALTHY lines saying healthy, anything else
# succeeds and is logged.
cat > /fake/bin/podman <<"EOF"
#!/bin/bash
echo "$*" >> /work/engine.log
if [[ "$*" == *" ps"* ]]; then
  for _ in $(seq 1 "${FAKE_HEALTHY:-0}"); do echo "svc  Up (healthy)"; done
fi
exit 0
EOF
chmod +x /fake/bin/podman
export PATH=/fake/bin:$PATH

layout() { rm -rf /inst /data /pkg; mkdir -p /pkg/scripts; cp /src/scripts/install.sh /pkg/scripts/; echo "services: {}" > /pkg/docker-compose.yml; }
run() { NERONET_INSTALL_DIR=/inst NERONET_DATA_DIR=/data NERONET_INSTALL_HEALTH_TIMEOUT=3 bash /pkg/scripts/install.sh "$@" > /work/out 2>&1; echo $? > /work/rc; }

layout
FAKE_HEALTHY=2 run
check "a healthy install succeeds" "[ \"\$(cat /work/rc)\" = 0 ]"
check ".env is written with mode 600" "[ \"\$(stat -c %a /inst/.env 2>/dev/null)\" = 600 ]"
pass=$(sed -n "s/^SOVEREIGN_ADMIN_PASS=//p" /inst/.env 2>/dev/null)
check "the admin password is not printed" "[ -n \"\$pass\" ] && ! grep -qF -- \"\$pass\" /work/out"
check "no generated secret is printed" "! grep -qE \"^(POSTGRES_PASSWORD|SOVEREIGN_[A-Z_]*SECRET)=\" /work/out"
check "the console is announced on https" "grep -q \"https://127.0.0.1:8443\" /work/out && ! grep -q \"http://127.0.0.1:8443\" /work/out"

before=$(sha256sum /inst/.env | cut -d" " -f1)
FAKE_HEALTHY=2 run
check "a rerun succeeds" "[ \"\$(cat /work/rc)\" = 0 ]"
check "a rerun keeps the existing .env byte for byte" "[ \"\$(sha256sum /inst/.env | cut -d\" \" -f1)\" = \"\$before\" ]"

layout
FAKE_HEALTHY=0 run
check "a stack that never becomes healthy is a failed install" "[ \"\$(cat /work/rc)\" != 0 ] && ! grep -q \"installed!\" /work/out"

layout
FAKE_HEALTHY=2 run --control-url https://example.test
check "an unsupported --control-url is refused, not ignored" "[ \"\$(cat /work/rc)\" != 0 ] && [ ! -e /inst/.env ]"

layout
rm /pkg/docker-compose.yml
FAKE_HEALTHY=2 run
check "no compose file next to the installer is a failed install" "[ \"\$(cat /work/rc)\" != 0 ]"

exit $fail
'
