#!/bin/sh
# Tests for neronet-ddns.sh against a fake Cloudflare API and fake IP services.
# A stub `curl` is put first on PATH: it serves canned JSON and records requests.
# Usage: sh scripts/ops/cloudflare-ddns/test.sh   (needs curl and jq installed)
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT=$HERE/neronet-ddns.sh
TOKEN='cfT0ken_SECRET-9f8e7d6c5b4a'
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT INT TERM
PASS=0
FAILS=0
LEAKS=0
RUNS=0
N=0
FAKE=
CONF=
RC=0
SERVER_TOKEN=$TOKEN

mkdir -p "$ROOT/bin"
cat >"$ROOT/bin/curl" <<'STUB'
#!/bin/sh
# Fake curl. Records argv; for `-K -` reads the config from stdin and routes
# by its url/request/data lines. Never stores the Authorization value.
printf '%s\n' "$*" >>"$FAKE_DIR/argv.log"
use_cfg=0
last=
for a in "$@"; do
  [ "$a" = "-K" ] && use_cfg=1
  last=$a
done
if [ "$use_cfg" = 0 ]; then
  case $last in
    https://ip-one.test/*|https://api.ipify.org*) f=ip1 ;;
    https://ip-two.test/*|https://ifconfig.co/ip*) f=ip2 ;;
    *) exit 6 ;;
  esac
  [ -e "$FAKE_DIR/$f.fail" ] && exit 6
  cat "$FAKE_DIR/$f"
  exit 0
fi
cfg=$(cat)
unq() { sed 's/\\"/"/g; s/\\\\/\\/g'; }
url=$(printf '%s\n' "$cfg" | sed -n 's/^url = "\(.*\)"$/\1/p')
req=$(printf '%s\n' "$cfg" | sed -n 's/^request = "\(.*\)"$/\1/p')
data=$(printf '%s\n' "$cfg" | sed -n 's/^data = "\(.*\)"$/\1/p' | unq)
[ -n "$req" ] || req=GET
if ! printf '%s\n' "$cfg" | grep -qxF "header = \"Authorization: Bearer $SERVER_TOKEN\""; then
  echo '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}'
  exit 22
fi
printf '%s %s %s\n' "$req" "$url" "$data" >>"$FAKE_DIR/requests.log"
case "$req $url" in
  "GET https://api.cloudflare.com/client/v4/zones?name=darknero.com")
    echo '{"success":true,"result":[{"id":"zone123","name":"darknero.com"}]}' ;;
  "GET https://api.cloudflare.com/client/v4/zones/zone123/dns_records?type=A&name="*)
    name=${url##*name=}
    if [ -e "$FAKE_DIR/rec_$name.json" ]; then cat "$FAKE_DIR/rec_$name.json"
    else echo '{"success":true,"result":[]}'; fi ;;
  "PATCH https://api.cloudflare.com/client/v4/zones/zone123/dns_records/rid_"*)
    echo '{"success":true,"result":{}}' ;;
  *) echo '{"success":false,"errors":[{"code":7003,"message":"no route"}]}'; exit 22 ;;
esac
STUB
chmod +x "$ROOT/bin/curl"

mkrec() { # name ip
  printf '{"success":true,"result":[{"id":"rid_%s","type":"A","name":"%s","content":"%s","proxied":false,"ttl":1}]}\n' \
    "$1" "$1" "$2" >"$FAKE/rec_$1.json"
}

setup() { # [ip1 [ip2 [record_ip]]]
  N=$((N + 1))
  FAKE=$ROOT/case$N/fake
  CONF=$ROOT/case$N/conf
  SERVER_TOKEN=$TOKEN
  mkdir -p "$FAKE" "$CONF"
  : >"$FAKE/requests.log"
  : >"$FAKE/argv.log"
  printf '%s\n' "${1:-203.0.114.9}" >"$FAKE/ip1"
  printf '%s\n' "${2:-${1:-203.0.114.9}}" >"$FAKE/ip2"
  printf '%s\n' "$TOKEN" >"$CONF/cloudflare-token"
  chmod 600 "$CONF/cloudflare-token"
  cat >"$CONF/ddns.env" <<ENV
ZONE_NAME=darknero.com
RECORD_NAMES="neronet.darknero.com gw.neronet.darknero.com"
IP_SOURCES="https://ip-one.test/ip https://ip-two.test/ip"
ENV
  chmod 644 "$CONF/ddns.env"
  mkrec neronet.darknero.com "${3:-198.51.100.7}"
  mkrec gw.neronet.darknero.com "${3:-198.51.100.7}"
}

run_ddns() {
  PATH="$ROOT/bin:$PATH" FAKE_DIR="$FAKE" SERVER_TOKEN="$SERVER_TOKEN" \
    NERONET_DDNS_CONF_DIR="$CONF" sh "$SCRIPT" "$@" >"$FAKE/out" 2>"$FAKE/err"
  RC=$?
  RUNS=$((RUNS + 1))
  if grep -rqF -- "$TOKEN" "$FAKE/out" "$FAKE/err" "$FAKE/argv.log" "$FAKE/requests.log"; then
    LEAKS=$((LEAKS + 1))
    echo "  LEAK: token found in output or recorded requests (case $N)"
  fi
}

patches() {
  n=$(grep -c '^PATCH ' "$FAKE/requests.log" 2>/dev/null)
  echo "${n:-0}"
}

check() { # description, then a command
  desc=$1
  shift
  if "$@"; then
    PASS=$((PASS + 1))
    echo "ok   - $desc"
  else
    FAILS=$((FAILS + 1))
    echo "FAIL - $desc"
    echo "  rc=$RC out: $(head -c 300 "$FAKE/out" 2>/dev/null) err: $(head -c 300 "$FAKE/err" 2>/dev/null)"
  fi
}

rc_is() { [ "$RC" -eq "$1" ]; }
rc_nonzero() { [ "$RC" -ne 0 ]; }
no_patch() { [ "$(patches)" -eq 0 ]; }
patch_count_is() { [ "$(patches)" -eq "$1" ]; }
err_has() { grep -qF -- "$1" "$FAKE/err" "$FAKE/out"; }
no_api_calls() { [ ! -s "$FAKE/requests.log" ]; }
no_curl_calls() { [ ! -s "$FAKE/argv.log" ]; }
no_post() { ! grep -q '^POST ' "$FAKE/requests.log"; }
argv_has() { grep -qF -- "$1" "$FAKE/argv.log"; }
err_single_line() { [ "$(wc -l <"$FAKE/err")" -eq 1 ]; }

body_ok() { # record name
  line=$(grep "^PATCH .*dns_records/rid_$1 " "$FAKE/requests.log")
  body=${line#PATCH * }
  [ "$(printf '%s' "$body" | jq -cS .)" = \
    "{\"content\":\"203.0.114.9\",\"name\":\"$1\",\"proxied\":false,\"ttl\":1,\"type\":\"A\"}" ]
}

# 1. unchanged IP -> no PATCH
setup 203.0.114.9 203.0.114.9 203.0.114.9
run_ddns
check "unchanged IP exits 0" rc_is 0
check "unchanged IP sends no PATCH" no_patch

# 2. changed IP -> exactly one PATCH per record, right body
setup 203.0.114.9
run_ddns
check "changed IP exits 0" rc_is 0
check "changed IP sends exactly two PATCH (one per record)" patch_count_is 2
check "PATCH body for neronet.darknero.com is right" body_ok neronet.darknero.com
check "PATCH body for gw.neronet.darknero.com is right" body_ok gw.neronet.darknero.com

# 3. only the record that differs is patched
setup 203.0.114.9
mkrec gw.neronet.darknero.com 203.0.114.9
run_ddns
check "one stale record -> exactly one PATCH" patch_count_is 1

# 4. sources disagree
setup 203.0.114.9 203.0.114.10
run_ddns
check "disagreeing sources fail" rc_nonzero
check "disagreeing sources send no PATCH" no_patch
check "disagreeing sources make no API call" no_api_calls
check "disagreeing sources print one error line" err_single_line

# 5. private / reserved / malformed answers
for bad in 192.168.1.5 10.0.0.1 127.0.0.1 100.64.0.1 169.254.1.1 172.16.0.1 172.31.255.255 \
  0.1.2.3 224.0.0.1 255.255.255.255 192.0.2.1 198.18.0.1 256.1.1.1 1.2.3 01.2.3.4 '<html>' 'x'; do
  setup "$bad"
  run_ddns
  check "rejects '$bad' as public IP" rc_nonzero
  check "'$bad' sends no PATCH" no_patch
done

# 6. a source is unreachable
setup 203.0.114.9
: >"$FAKE/ip2.fail"
run_ddns
check "unreachable IP source fails" rc_nonzero
check "unreachable IP source sends no PATCH" no_patch

# 7. token file and config permissions
setup 203.0.114.9
chmod 644 "$CONF/cloudflare-token"
run_ddns
check "token mode 644 is refused" rc_nonzero
check "token mode 644 message mentions the file" err_has "cloudflare-token"
check "token mode 644 makes no curl call at all" no_curl_calls

setup 203.0.114.9
chmod 640 "$CONF/cloudflare-token"
run_ddns
check "token mode 640 is refused" rc_nonzero

setup 203.0.114.9
rm "$CONF/cloudflare-token"
run_ddns
check "missing token file is refused" rc_nonzero

if [ "$(id -u)" -eq 0 ]; then
  setup 203.0.114.9
  chown 65534 "$CONF/cloudflare-token"
  run_ddns
  check "token owned by another user is refused" rc_nonzero
  check "token owned by another user makes no curl call" no_curl_calls
fi

setup 203.0.114.9
chmod 664 "$CONF/ddns.env"
run_ddns
check "group-writable ddns.env is refused" rc_nonzero

# 8. missing record is named, never created
setup 203.0.114.9
rm "$FAKE/rec_gw.neronet.darknero.com.json"
run_ddns
check "missing record fails" rc_nonzero
check "missing record is named in the message" err_has "gw.neronet.darknero.com"
check "missing record: nothing is patched" no_patch
check "missing record is never created (no POST)" no_post

# 9. API rejects the token
setup 203.0.114.9
SERVER_TOKEN=some-other-token
run_ddns
check "rejected API token fails" rc_nonzero
check "rejected API token sends no PATCH" no_patch

# 10. dry run
setup 203.0.114.9
run_ddns --dry-run
check "dry-run exits 0" rc_is 0
check "dry-run sends no PATCH" no_patch
check "dry-run says what it would change" err_has "would update"
check "dry-run names the new IP" err_has "203.0.114.9"

# 11. default IP sources
setup 203.0.114.9
sed -i '/^IP_SOURCES=/d' "$CONF/ddns.env"
run_ddns
check "default sources: exits 0" rc_is 0
check "default sources include api.ipify.org" argv_has "https://api.ipify.org"
check "default sources include ifconfig.co" argv_has "https://ifconfig.co/ip"

# 12. token is never on a command line
setup 203.0.114.9
run_ddns
check "Authorization goes through curl -K -, not argv" argv_has "-K -"

# 13. unsafe record name is rejected
setup 203.0.114.9
sed -i 's/^RECORD_NAMES=.*/RECORD_NAMES="a.darknero.com;b"/' "$CONF/ddns.env"
run_ddns
check "unsafe record name is refused" rc_nonzero

check "token never appeared in any output or recorded request ($RUNS runs)" test "$LEAKS" -eq 0

echo "passed: $PASS, failed: $FAILS"
[ "$FAILS" -eq 0 ]
