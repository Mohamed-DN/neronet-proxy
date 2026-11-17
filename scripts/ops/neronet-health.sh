#!/bin/sh
# neronet-health.sh - periodic health check for a single-host NeroNet install
# (Debian 13, rootless Podman, compose project in COMPOSE_PROJECT_NAME).
#
# Prints one line per check: "<UTC timestamp> OK <check>" or
# "<UTC timestamp> FAIL <check> <reason>". Exit 0 if every check is OK, 1 otherwise.
# Run every 5 minutes by neronet-health.timer; output goes to the user journal.
#
# Optional environment (never printed):
#   COMPOSE_PROJECT_NAME  compose project name (default neronet-gw)
#   NERONET_CONSOLE_URL   console base URL (default https://127.0.0.1:8443)
#   NERONET_PUBLIC_URL    public URL; enables the public HTTP and TLS checks
#   NERONET_PUBLIC_CONNECT_TO  address to connect to for the public HTTP and TLS checks,
#                         keeping the public name for Host and SNI: for a router without
#                         hairpin NAT, point it at the LAN reverse proxy
#   NERONET_DNS_NAMES     space-separated public names; enables the DNS check (each A
#                         record must equal this line's public IPv4, asked of two sources)
#   NERONET_MEMINFO       meminfo file (default /proc/meminfo; for tests)
set -u

PROJECT=${COMPOSE_PROJECT_NAME:-neronet-gw}
CONSOLE_URL=${NERONET_CONSOLE_URL:-https://127.0.0.1:8443}
PUBLIC_URL=${NERONET_PUBLIC_URL:-}
DNS_NAMES=${NERONET_DNS_NAMES:-}
CONNECT_TO=${NERONET_PUBLIC_CONNECT_TO:-}
case $CONNECT_TO in *[!0-9A-Za-z.:-]*) echo "invalid NERONET_PUBLIC_CONNECT_TO" >&2; exit 1 ;; esac
MEMINFO=${NERONET_MEMINFO:-/proc/meminfo}
GATEWAY="${PROJECT}-gateway-1"
FAILS=0

case $PROJECT in *[!A-Za-z0-9_-]* | '') echo "invalid COMPOSE_PROJECT_NAME" >&2; exit 1 ;; esac

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ok <check>  /  fail <check> <reason>
ok() { printf '%s OK %s\n' "$(ts)" "$1"; }
fail() {
  printf '%s FAIL %s %s\n' "$(ts)" "$1" "$2"
  FAILS=$((FAILS + 1))
}

# 1. Console health: status ok, database and valkey connected.
check_console() {
  body=$(curl -sk --max-time 10 "${CONSOLE_URL}/api/health" 2>/dev/null)
  if [ -z "$body" ]; then
    fail console "no response from /api/health"
    return
  fi
  if ! printf '%s' "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    fail console "status is not ok"
    return
  fi
  if ! printf '%s' "$body" | grep -Eq '"database"[[:space:]]*:[[:space:]]*"connected"'; then
    fail console "database not connected"
    return
  fi
  if ! printf '%s' "$body" | grep -Eq '"valkey"[[:space:]]*:[[:space:]]*"connected"'; then
    fail console "valkey not connected"
    return
  fi
  ok console
}

# 2. Project containers: all running, none unhealthy, gateway present.
check_containers() {
  if [ -z "$CONTAINERS" ]; then
    fail containers "no containers found for project"
    return
  fi
  not_running=$(printf '%s\n' "$CONTAINERS" | awk -F'|' '$2 != "running" { printf "%s ", $1 }')
  unhealthy=$(printf '%s\n' "$CONTAINERS" | awk -F'|' 'index($3, "unhealthy") { printf "%s ", $1 }')
  if [ -n "$not_running" ]; then
    fail containers "not running: ${not_running% }"
    return
  fi
  if [ -n "$unhealthy" ]; then
    fail containers "unhealthy: ${unhealthy% }"
    return
  fi
  ok containers
}

check_gateway() {
  if printf '%s\n' "$CONTAINERS" | awk -F'|' -v n="$GATEWAY" '$1 == n && $2 == "running" { found = 1 } END { exit !found }'; then
    ok gateway
  else
    fail gateway "not running"
  fi
}

# 3. Gateway publishes UDP 51820.
check_wireguard_port() {
  ports=$(podman port "$GATEWAY" 2>/dev/null)
  if printf '%s\n' "$ports" | grep -Eq '^51820/udp[[:space:]]'; then
    ok wireguard-port
  else
    fail wireguard-port "UDP 51820 not published by ${GATEWAY}"
  fi
}

# 4. Optional public HTTP check.
check_public_http() {
  if [ -n "$CONNECT_TO" ]; then
    hp=${PUBLIC_URL#*://}
    hp=${hp%%/*}
    case $hp in *:*) port=${hp##*:} ;; *) port=443 ;; esac
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      --resolve "${hp%%:*}:${port}:${CONNECT_TO}" "${PUBLIC_URL}/api/health" 2>/dev/null)
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${PUBLIC_URL}/api/health" 2>/dev/null)
  fi
  if [ "$code" = 200 ]; then
    ok public-http
  else
    fail public-http "HTTP status ${code:-none}"
  fi
}

# 5. Optional TLS certificate check: must be valid for more than 14 days.
check_tls() {
  hostport=${PUBLIC_URL#*://}
  hostport=${hostport%%/*}
  case $hostport in
    *:*) : ;;
    *) hostport="${hostport}:443" ;;
  esac
  host=${hostport%%:*}
  if [ -n "$CONNECT_TO" ]; then
    hostport="${CONNECT_TO}:${hostport##*:}"
  fi
  if openssl s_client -servername "$host" -connect "$hostport" </dev/null 2>/dev/null \
    | openssl x509 -checkend 1209600 -noout >/dev/null 2>&1; then
    ok tls-expiry
  else
    fail tls-expiry "certificate missing, unreadable or expires within 14 days"
  fi
}

# 5b. Optional DNS check: every public name must point at this line's current public
# IPv4. A home line can be given a new address (after a power cut, a router restart);
# then everything still looks healthy from inside while nobody outside can connect.
# The public IP comes from two independent sources that must agree; the records are
# asked of Cloudflare's DNS-over-HTTPS, so a local resolver's rewrites cannot hide it.
public_ipv4() {
  a=$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null | tr -d '[:space:]')
  b=$(curl -s --max-time 8 https://ifconfig.co/ip 2>/dev/null | tr -d '[:space:]')
  case $a in '' | *[!0-9.]*) return 1 ;; esac
  [ "$a" = "$b" ] || return 1
  printf '%s' "$a"
}

check_public_dns() {
  if ! mine=$(public_ipv4); then
    fail public-dns "could not learn this line's public IPv4 from two agreeing sources"
    return
  fi
  bad=0
  for name in $DNS_NAMES; do
    case $name in *[!A-Za-z0-9.-]* | '') fail public-dns "invalid name in NERONET_DNS_NAMES"; bad=1; continue ;; esac
    answer=$(curl -s --max-time 8 -H 'accept: application/dns-json' \
      "https://1.1.1.1/dns-query?name=${name}&type=A" 2>/dev/null)
    got=$(printf '%s' "$answer" | tr ',{}' '\n\n\n' | sed -n 's/^"data":"\([0-9.]*\)"$/\1/p' | head -n 1)
    if [ -z "$got" ]; then
      fail public-dns "$name has no A record"
      bad=1
    elif [ "$got" != "$mine" ]; then
      fail public-dns "$name points to $got, this line is $mine"
      bad=1
    fi
  done
  [ "$bad" -eq 0 ] && ok public-dns
}

# 6. Disk free on / above 10%.
check_disk() {
  free=$(df -P / 2>/dev/null | awk 'NR == 2 && $2 > 0 { printf "%d", $4 * 100 / $2 }')
  if [ -z "$free" ]; then
    fail disk "cannot read free space on /"
  elif [ "$free" -gt 10 ]; then
    ok disk
  else
    fail disk "free space ${free}% (threshold 10%)"
  fi
}

# 7. Memory available above 5%.
check_memory() {
  avail=$(awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } END { if (t > 0 && a != "") printf "%d", a * 100 / t }' "$MEMINFO" 2>/dev/null)
  if [ -z "$avail" ]; then
    fail memory "cannot read MemAvailable"
  elif [ "$avail" -gt 5 ]; then
    ok memory
  else
    fail memory "available ${avail}% (threshold 5%)"
  fi
}

CONTAINERS=$(podman ps --all --filter "label=com.docker.compose.project=${PROJECT}" \
  --format '{{.Names}}|{{.State}}|{{.Status}}' 2>/dev/null)

check_console
check_containers
check_gateway
check_wireguard_port

if [ -n "$PUBLIC_URL" ]; then
  check_public_http
  check_tls
fi
if [ -n "$DNS_NAMES" ]; then
  check_public_dns
fi

check_disk
check_memory

if [ "$FAILS" -eq 0 ]; then
  exit 0
fi
exit 1
