#!/bin/sh
# Runs Xray exactly while the gateway's configuration file exists, and restarts it when the
# file's content changes. The gateway (sovereign-node) writes the file from the netmap and
# removes it when the organisation switches the method off or no longer has parameters, so
# a revoked device and a switched-off method both end at the next check, at most
# POLL_SECONDS later. Xray itself reads the file only at start, which is why a change means
# a restart; a restart ends every VLESS session, which the apps re-establish on their own.
set -u
CFG=${XRAY_CONFIG:-/etc/neronet-xray/config.json}
POLL=${POLL_SECONDS:-2}
pid=""
last=""

stop() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  fi
  pid=""
}
trap 'stop; exit 0' TERM INT

while :; do
  if [ -f "$CFG" ]; then
    cur=$(sha256sum "$CFG" | cut -d' ' -f1)
  else
    cur=""
  fi
  if [ "$cur" != "$last" ]; then
    stop
    last=$cur
    if [ -n "$cur" ]; then
      /usr/local/bin/xray run -c "$CFG" &
      pid=$!
    fi
  elif [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    # Xray exited by itself (a configuration it refused): try again at the next change,
    # and meanwhile do not spin.
    pid=""
  fi
  sleep "$POLL" &
  wait $!
done
