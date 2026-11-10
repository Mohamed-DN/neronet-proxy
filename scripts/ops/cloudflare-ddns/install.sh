#!/bin/bash
# Install (or remove) the NeroNet Cloudflare dynamic-DNS updater on a Debian VM.
#
#   sudo bash install.sh              install script, units, config dir; ask for the token
#   sudo bash install.sh --uninstall  stop and remove the timer, units and script
#   sudo bash install.sh --uninstall --purge   also delete /etc/neronet/ddns.env and the token
#
# The token is read from the terminal with `read -s`: it is never an argument,
# never echoed, never written anywhere except /etc/neronet/cloudflare-token (mode 600).
set -eu
umask 077

HERE=$(cd "$(dirname "$0")" && pwd)
CONF_DIR=/etc/neronet
BIN=/usr/local/sbin/neronet-ddns.sh
UNIT_DIR=/etc/systemd/system
MODE=install
PURGE=0

for arg in "$@"; do
  case $arg in
    --uninstall) MODE=uninstall ;;
    --purge) PURGE=1 ;;
    -h | --help)
      sed -n "2,10p" "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "usage: install.sh [--uninstall [--purge]]" >&2
      exit 2
      ;;
  esac
done

[ "$(id -u)" -eq 0 ] || {
  echo "install.sh: run as root (sudo)" >&2
  exit 1
}

if [ "$MODE" = uninstall ]; then
  systemctl disable --now neronet-ddns.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/neronet-ddns.service" "$UNIT_DIR/neronet-ddns.timer" "$BIN"
  systemctl daemon-reload 2>/dev/null || true
  if [ "$PURGE" -eq 1 ]; then
    rm -f "$CONF_DIR/cloudflare-token" "$CONF_DIR/ddns.env"
    rmdir "$CONF_DIR" 2>/dev/null || true
    echo "removed timer, units, script, and the config and token in $CONF_DIR"
  else
    echo "removed timer, units and script; kept $CONF_DIR (use --purge to delete the token too)"
  fi
  exit 0
fi

for c in curl jq systemctl; do
  command -v "$c" >/dev/null 2>&1 || {
    echo "install.sh: '$c' is required (apt install curl jq)" >&2
    exit 1
  }
done

install -m 0755 -o root -g root "$HERE/neronet-ddns.sh" "$BIN"
install -m 0644 -o root -g root "$HERE/neronet-ddns.service" "$UNIT_DIR/neronet-ddns.service"
install -m 0644 -o root -g root "$HERE/neronet-ddns.timer" "$UNIT_DIR/neronet-ddns.timer"

install -d -m 0750 -o root -g root "$CONF_DIR"
if [ ! -e "$CONF_DIR/ddns.env" ]; then
  cat >"$CONF_DIR/ddns.env" <<'ENV'
# NeroNet dynamic DNS. The API token is NOT here: see /etc/neronet/cloudflare-token.
ZONE_NAME=darknero.com
RECORD_NAMES="neronet.darknero.com gw.neronet.darknero.com"
# Optional, two independent HTTPS sources that must agree:
# IP_SOURCES="https://api.ipify.org https://ifconfig.co/ip"
ENV
  chmod 0640 "$CONF_DIR/ddns.env"
  echo "created $CONF_DIR/ddns.env (check the names)"
fi

if [ -e "$CONF_DIR/cloudflare-token" ]; then
  chmod 0600 "$CONF_DIR/cloudflare-token"
  chown root:root "$CONF_DIR/cloudflare-token"
  echo "kept existing $CONF_DIR/cloudflare-token"
else
  [ -r /dev/tty ] || {
    echo "install.sh: no terminal to read the token from" >&2
    exit 1
  }
  printf 'Cloudflare API token (Zone:DNS:Edit, input hidden): ' >/dev/tty
  IFS= read -r -s TOKEN </dev/tty
  printf '\n' >/dev/tty
  case $TOKEN in
    '' | *[!A-Za-z0-9_-]*)
      echo "install.sh: that does not look like a Cloudflare token; nothing saved" >&2
      exit 1
      ;;
  esac
  printf '%s\n' "$TOKEN" >"$CONF_DIR/cloudflare-token"
  chmod 0600 "$CONF_DIR/cloudflare-token"
  chown root:root "$CONF_DIR/cloudflare-token"
  TOKEN=
  echo "saved $CONF_DIR/cloudflare-token (mode 600)"
fi

systemctl daemon-reload
echo "dry run:"
"$BIN" --dry-run || echo "dry run failed: fix the message above, the timer will retry every 5 minutes"
systemctl enable --now neronet-ddns.timer
echo "timer enabled: systemctl list-timers neronet-ddns.timer; journalctl -u neronet-ddns"
