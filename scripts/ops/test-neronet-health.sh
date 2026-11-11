#!/bin/sh
# Dry test for neronet-health.sh: fake curl, podman, openssl and df are put first in PATH.
# Runs one all-OK case (expects exit 0) and one failing case (expects exit 1 and a FAIL line).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
CHECK="$HERE/neronet-health.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/neronet-health-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

STUBS="$WORK/bin"
mkdir -p "$STUBS"

cat >"$STUBS/curl" <<'EOF'
#!/bin/sh
# Public check passes -w; console check does not.
case " $* " in
  *" -w "*) printf '%s' "${FAKE_PUBLIC_CODE:-200}" ;;
  *) printf '%s' '{"status":"ok","version":"4.0.0","database":"connected","valkey":"connected"}' ;;
esac
EOF

cat >"$STUBS/podman" <<'EOF'
#!/bin/sh
case "$1" in
  ps) printf '%s\n' "${FAKE_PS:-neronet-gw-gateway-1|running|Up 2 hours
neronet-gw-console-1|running|Up 2 hours (healthy)
neronet-gw-db-1|running|Up 2 hours (healthy)}" ;;
  port) printf '%s\n' '51820/udp -> 0.0.0.0:51820' ;;
  *) exit 1 ;;
esac
EOF

cat >"$STUBS/openssl" <<'EOF'
#!/bin/sh
# s_client prints nothing; x509 -checkend exits with FAKE_CERT_RC (0 = more than 14 days left).
case "$1" in
  x509) exit "${FAKE_CERT_RC:-0}" ;;
  *) exit 0 ;;
esac
EOF

cat >"$STUBS/df" <<'EOF'
#!/bin/sh
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/fake 1000 500 %s 50%% /\n' "${FAKE_DF_AVAIL:-500}"
EOF

chmod +x "$STUBS"/curl "$STUBS"/podman "$STUBS"/openssl "$STUBS"/df

MEMINFO="$WORK/meminfo"
printf 'MemTotal:       1000 kB\nMemAvailable:    500 kB\n' >"$MEMINFO"

status=0

# Case 1: everything healthy, public checks enabled -> exit 0, no FAIL lines.
out1="$WORK/ok.out"
set +e
PATH="$STUBS:$PATH" NERONET_MEMINFO="$MEMINFO" NERONET_PUBLIC_URL="https://neronet.example.test" \
  COMPOSE_PROJECT_NAME=neronet-gw sh "$CHECK" >"$out1" 2>&1
rc1=$?
set -e
cat "$out1"
if [ "$rc1" -ne 0 ]; then
  echo "FAIL case 1: expected exit 0, got $rc1" >&2; status=1
elif grep -q ' FAIL ' "$out1"; then
  echo "FAIL case 1: unexpected FAIL line" >&2; status=1
else
  echo "PASS case 1: all OK, exit 0"
fi

# Case 2: gateway exited, no public URL -> exit 1 and a gateway FAIL line.
out2="$WORK/fail.out"
FAILING_PS='neronet-gw-gateway-1|exited|Exited (1) 3 minutes ago
neronet-gw-console-1|running|Up 2 hours (healthy)
neronet-gw-db-1|running|Up 2 hours (healthy)'
set +e
PATH="$STUBS:$PATH" NERONET_MEMINFO="$MEMINFO" NERONET_PUBLIC_URL='' \
  FAKE_PS="$FAILING_PS" COMPOSE_PROJECT_NAME=neronet-gw sh "$CHECK" >"$out2" 2>&1
rc2=$?
set -e
cat "$out2"
if [ "$rc2" -ne 1 ]; then
  echo "FAIL case 2: expected exit 1, got $rc2" >&2; status=1
elif ! grep -q ' FAIL gateway not running' "$out2"; then
  echo "FAIL case 2: missing gateway FAIL line" >&2; status=1
else
  echo "PASS case 2: gateway down, exit 1 with FAIL line"
fi

exit "$status"
