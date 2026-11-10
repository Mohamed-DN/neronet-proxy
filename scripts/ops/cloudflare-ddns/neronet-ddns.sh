#!/bin/sh
# neronet-ddns.sh - keep Cloudflare A records pointed at this line's public IPv4.
#
# Config:  /etc/neronet/ddns.env          ZONE_NAME, RECORD_NAMES, optional IP_SOURCES
# Secret:  /etc/neronet/cloudflare-token  API token, mode 600, owned by root or the running user
# Needs:   curl, jq.  The token only ever travels on curl's stdin (curl -K -), never in argv.
#
# Usage: neronet-ddns.sh [--dry-run]
# Exit:  0 = unchanged or updated, non-zero = any failure (one line on stderr, never the token).
set -u
umask 077

PROG=neronet-ddns
CONF_DIR=${NERONET_DDNS_CONF_DIR:-/etc/neronet}
API=https://api.cloudflare.com/client/v4
DEFAULT_IP_SOURCES="https://api.ipify.org https://ifconfig.co/ip"
DRY=0
TOKEN=
API_OUT=

die() {
  printf '%s: %s\n' "$PROG" "$*" | tr -d '\r' | head -n 1 >&2
  exit 1
}

for arg in "$@"; do
  case $arg in
    --dry-run) DRY=1 ;;
    -h | --help)
      echo "usage: $PROG [--dry-run]"
      exit 0
      ;;
    *)
      echo "usage: $PROG [--dry-run]" >&2
      exit 2
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

# check_owner FILE: owned by root or by the user running this script.
check_owner() {
  owner=$(stat -L -c '%u' "$1" 2>/dev/null) || die "cannot stat $1"
  if [ "$owner" != 0 ] && [ "$owner" != "$(id -u)" ]; then
    die "$1 must be owned by root or by the running user"
  fi
}

# --- token file: exactly mode 600 (or 400), trusted owner -------------------
TOKEN_FILE=$CONF_DIR/cloudflare-token
[ -f "$TOKEN_FILE" ] || die "token file not found: $TOKEN_FILE"
case $(stat -L -c '%a' "$TOKEN_FILE" 2>/dev/null) in
  600 | 400) ;;
  *) die "refusing to run: $TOKEN_FILE must have mode 600" ;;
esac
check_owner "$TOKEN_FILE"

# --- config file: owned by a trusted user and not writable by others --------
ENV_FILE=$CONF_DIR/ddns.env
[ -f "$ENV_FILE" ] || die "config file not found: $ENV_FILE"
check_owner "$ENV_FILE"
case $(stat -L -c '%A' "$ENV_FILE" 2>/dev/null) in
  ?????w???? | ????????w?) die "refusing to run: $ENV_FILE must not be writable by group or others" ;;
esac
ZONE_NAME=
RECORD_NAMES=
IP_SOURCES=
# shellcheck disable=SC1090
. "$ENV_FILE"
[ -n "$IP_SOURCES" ] || IP_SOURCES=$DEFAULT_IP_SOURCES

valid_name() {
  case $1 in
    '' | *[!A-Za-z0-9.-]* | .* | -*) return 1 ;;
  esac
  return 0
}
valid_name "$ZONE_NAME" || die "ZONE_NAME missing or invalid in $ENV_FILE"
[ -n "$RECORD_NAMES" ] || die "RECORD_NAMES missing in $ENV_FILE"
set -f
for n in $RECORD_NAMES; do
  valid_name "$n" || die "invalid record name in RECORD_NAMES"
done
src_count=0
for s in $IP_SOURCES; do
  case $s in
    https://*) src_count=$((src_count + 1)) ;;
    *) die "IP source must be an https:// URL" ;;
  esac
done
set +f
[ "$src_count" -ge 2 ] || die "at least two IP sources are required"

read -r TOKEN <"$TOKEN_FILE" || [ -n "$TOKEN" ] || die "cannot read token file"
case $TOKEN in
  '' | *[!A-Za-z0-9_-]*) die "token file has unexpected content" ;;
esac

# --- public IPv4 validation --------------------------------------------------
valid_public_ipv4() {
  case $1 in
    '' | *[!0-9.]* | .* | *. | *..*) return 1 ;;
  esac
  _oldifs=$IFS
  IFS=.
  # shellcheck disable=SC2086
  set -- $1
  IFS=$_oldifs
  [ $# -eq 4 ] || return 1
  for _o in "$@"; do
    case $_o in
      '' | *[!0-9]* | 0?*) return 1 ;;
    esac
    [ ${#_o} -le 3 ] && [ "$_o" -le 255 ] || return 1
  done
  _a=$1 _b=$2 _c=$3
  [ "$_a" -eq 0 ] && return 1
  [ "$_a" -eq 10 ] && return 1
  [ "$_a" -eq 127 ] && return 1
  [ "$_a" -ge 224 ] && return 1
  [ "$_a" -eq 100 ] && [ "$_b" -ge 64 ] && [ "$_b" -le 127 ] && return 1
  [ "$_a" -eq 169 ] && [ "$_b" -eq 254 ] && return 1
  [ "$_a" -eq 172 ] && [ "$_b" -ge 16 ] && [ "$_b" -le 31 ] && return 1
  [ "$_a" -eq 192 ] && [ "$_b" -eq 168 ] && return 1
  [ "$_a" -eq 192 ] && [ "$_b" -eq 0 ] && [ "$_c" -le 2 ] && return 1
  [ "$_a" -eq 192 ] && [ "$_b" -eq 88 ] && [ "$_c" -eq 99 ] && return 1
  [ "$_a" -eq 198 ] && [ "$_b" -ge 18 ] && [ "$_b" -le 19 ] && return 1
  [ "$_a" -eq 198 ] && [ "$_b" -eq 51 ] && [ "$_c" -eq 100 ] && return 1
  [ "$_a" -eq 203 ] && [ "$_b" -eq 0 ] && [ "$_c" -eq 113 ] && return 1
  return 0
}

IP=
set -f
for s in $IP_SOURCES; do
  raw=$(curl -fsS --max-time 15 --max-filesize 256 --proto '=https' --tlsv1.2 -- "$s" 2>/dev/null) ||
    die "cannot fetch public IP from $s"
  got=$(printf '%s' "$raw" | tr -d ' \t\r\n')
  valid_public_ipv4 "$got" || die "$s did not return a public IPv4 address"
  if [ -z "$IP" ]; then
    IP=$got
    FIRST=$s
  elif [ "$got" != "$IP" ]; then
    die "IP sources disagree: $FIRST says $IP, $s says $got"
  fi
done
set +f

# --- Cloudflare API ----------------------------------------------------------
# cf METHOD PATH [JSON_BODY]: the whole request, token included, goes on curl's stdin.
cf() {
  {
    printf 'silent\nshow-error\nfail-with-body\nmax-time = 30\nproto = "=https"\n'
    printf 'url = "%s%s"\n' "$API" "$2"
    printf 'request = "%s"\n' "$1"
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"
    printf 'header = "Content-Type: application/json"\n'
    if [ -n "${3-}" ]; then
      printf 'data = "%s"\n' "$(printf '%s' "$3" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    fi
  } | curl -K -
}

# api METHOD PATH [BODY]: result JSON in API_OUT; dies on any failure.
api() {
  API_OUT=$(cf "$@")
  _rc=$?
  _ok=$(printf '%s' "$API_OUT" | jq -r '.success' 2>/dev/null)
  if [ "$_rc" -ne 0 ] || [ "$_ok" != true ]; then
    _msg=$(printf '%s' "$API_OUT" | jq -r '.errors[0].message // empty' 2>/dev/null | tr -d '\r\n' | cut -c1-120)
    die "Cloudflare API $1 failed${_msg:+: $_msg}"
  fi
}

api GET "/zones?name=$ZONE_NAME"
ZONE_ID=$(printf '%s' "$API_OUT" | jq -r '.result[0].id // empty')
case $ZONE_ID in
  '' | *[!A-Za-z0-9]*) die "zone $ZONE_NAME not found for this token" ;;
esac

PLAN=
MISSING=
set -f
for n in $RECORD_NAMES; do
  api GET "/zones/$ZONE_ID/dns_records?type=A&name=$n"
  row=$(printf '%s' "$API_OUT" | jq -r '.result[0] // empty | "\(.id) \(.content)"')
  if [ -z "$row" ]; then
    MISSING="$MISSING $n"
  else
    PLAN="$PLAN$n $row
"
  fi
done
set +f
[ -z "$MISSING" ] || die "A record missing in $ZONE_NAME (not created, add it in Cloudflare first):$MISSING"

while read -r n rid old; do
  [ -n "$n" ] || continue
  case $rid in
    *[!A-Za-z0-9_.-]*) die "unexpected record id for $n" ;;
  esac
  if [ "$old" = "$IP" ]; then
    echo "unchanged $n ($IP)"
    continue
  fi
  if [ "$DRY" -eq 1 ]; then
    echo "would update $n: $old -> $IP (proxied=false, ttl=auto)"
    continue
  fi
  body=$(jq -cn --arg n "$n" --arg ip "$IP" '{type:"A",name:$n,content:$ip,ttl:1,proxied:false}')
  api PATCH "/zones/$ZONE_ID/dns_records/$rid" "$body"
  echo "updated $n: $old -> $IP"
done <<EOF
$PLAN
EOF
exit 0
