#!/bin/sh
# Runs the WP-201 data plane spike between two containers and prints the evidence.
#
# Usage: dataplane-spike-lab.sh <worktree> <workdir> [netstack|tun] [seconds]
#
#   worktree  the git worktree holding the code under test
#   workdir   a scratch directory for binaries, keys, documents and the capture
#   mode      netstack (default, no capabilities) or tun (needs /dev/net/tun)
#   seconds   duration of each throughput direction, default 30
#
# netstack mode runs both nodes as uid 10001 with every capability dropped and no
# device node, which is the configuration the staging containers have. tun mode adds
# --device /dev/net/tun and --cap-add NET_ADMIN and is the case the spike has to
# report on rather than assume.
#
# Everything it creates carries the wp201 prefix and is removed on exit, so it can
# run beside other work on the same Podman machine. It never touches the staging
# project.
set -e

export MSYS_NO_PATHCONV=1

WORKTREE=${1:?worktree path}
WORKDIR=${2:?work directory}
MODE=${3:-netstack}
SECONDS_PER_DIRECTION=${4:-30}

PREFIX=wp201
NET=$PREFIX-net
NODE_A=$PREFIX-node-a
NODE_B=$PREFIX-node-b
CAPTURE=$PREFIX-capture
TOOLS_IMAGE=localhost/$PREFIX-tools
SUBNET=10.89.201.0/24
IP_A=10.89.201.11
IP_B=10.89.201.12
WG_PORT=51820
ECHO_PORT=9999
VIP_A=100.64.0.1
VIP_B=100.64.0.2
MARKER=WP201-PLAINTEXT-MARKER-DO-NOT-LEAK

win_path() { (cd "$1" && pwd -W 2>/dev/null || pwd); }

cleanup() {
  podman rm -f -t 2 "$CAPTURE" "$NODE_A" "$NODE_B" >/dev/null 2>&1 || true
  podman network rm -f "$NET" >/dev/null 2>&1 || true
  podman rmi -f "$TOOLS_IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

mkdir -p "$WORKDIR/bin" "$WORKDIR/a" "$WORKDIR/b" "$WORKDIR/out"
WT=$(win_path "$WORKTREE")
WD=$(win_path "$WORKDIR")

echo "== build (static binaries, golang:1.25)"
podman run --rm \
  -v "$WT:/src" -v "$WD:/out" \
  -v neronet-gomod:/go/pkg/mod -v neronet-gocache:/root/.cache/go-build \
  -w /src -e CGO_ENABLED=0 docker.io/library/golang:1.25 \
  sh -c 'go build -o /out/bin/sovereign-node ./cmd/sovereign-node &&
         go build -o /out/bin/overlay-measure ./scripts/dev/overlay-measure &&
         go build -o /out/bin/spike-identity ./scripts/dev/spike-identity'

echo "== identities"
PUB_A=$(podman run --rm -v "$WD:/lab" docker.io/library/debian:bookworm-slim /lab/bin/spike-identity -out /lab/a/node.key)
PUB_B=$(podman run --rm -v "$WD:/lab" docker.io/library/debian:bookworm-slim /lab/bin/spike-identity -out /lab/b/node.key)
echo "node A public key $PUB_A"
echo "node B public key $PUB_B"

write_doc() {
  # write_doc <file> <own vip> <peer pubkey> <peer endpoint ip> <peer vip> <probe>
  cat > "$1" <<EOF
{
  "version": 1,
  "addresses": ["$2/10"],
  "listen_port": $WG_PORT,
  "mtu": 1420,
  "echo_port": $ECHO_PORT,
  "probe_target": "$6",
  "probe_interval_seconds": 5,
  "enforce": false,
  "peers": [
    {
      "public_key": "$3",
      "endpoint": "$4:$WG_PORT",
      "allowed_ips": ["$5/32"]
    }
  ]
}
EOF
}

write_doc "$WORKDIR/a/spike.json" "$VIP_A" "$PUB_B" "$IP_B" "$VIP_B" "$VIP_B"
write_doc "$WORKDIR/b/spike.json" "$VIP_B" "$PUB_A" "$IP_A" "$VIP_A" "$VIP_A"

echo "== tools image (tcpdump for the capture sidecar)"
cat > "$WORKDIR/Containerfile.tools" <<'EOF'
FROM docker.io/library/debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tcpdump iproute2 iputils-ping && rm -rf /var/lib/apt/lists/*
EOF
podman build -q -t "$TOOLS_IMAGE" -f "$WD/Containerfile.tools" "$WD" >/dev/null

echo "== network"
podman network create --subnet "$SUBNET" "$NET" >/dev/null

node_flags=""
NODE_IMAGE=docker.io/library/debian:bookworm-slim
case "$MODE" in
  netstack)
    node_flags="--user 10001:10001 --cap-drop ALL"
    ;;
  tun)
    # Still uid 10001. Podman raises a capability added with --cap-add into the
    # ambient set, so an unprivileged uid holds CAP_NET_ADMIN effectively and can
    # open /dev/net/tun. The device node and the capability both have to be granted
    # explicitly, which is the difference from netstack mode.
    node_flags="--user 10001:10001 --device /dev/net/tun --cap-add NET_ADMIN"
    # The kernel TUN backend configures the interface with iproute2.
    NODE_IMAGE=$TOOLS_IMAGE
    ;;
  *)
    echo "unknown mode $MODE" >&2
    exit 2
    ;;
esac

start_node() {
  # start_node <name> <ip> <dir>
  # shellcheck disable=SC2086
  podman run -d --name "$1" --network "$NET" --ip "$2" \
    $node_flags \
    -v "$WD:/lab" \
    "$NODE_IMAGE" \
    /lab/bin/sovereign-node \
      -dataplane "$MODE" \
      -spike-peers "/lab/$3/spike.json" \
      -identity "/lab/$3/node.key" \
      -control-url http://127.0.0.1:1 >/dev/null
}

echo "== nodes ($MODE mode, uid 10001, $node_flags)"
start_node "$NODE_A" "$IP_A" a
start_node "$NODE_B" "$IP_B" b
sleep 5

echo "-- node A log"
podman logs "$NODE_A" 2>&1 | grep -iE "data plane|socks5|standalone" || true
echo "-- node B log"
podman logs "$NODE_B" 2>&1 | grep -iE "data plane|socks5|standalone" || true

if ! podman logs "$NODE_A" 2>&1 | grep -q "Data plane up"; then
  echo "node A did not bring the data plane up" >&2
  podman logs "$NODE_A" 2>&1 | tail -30 >&2
  exit 1
fi

echo "== capture on node B's network namespace"
# eth0 is the container network, which is what the criterion is about. Capturing on
# "any" would also record the node's own tun interface in tun mode, where the
# traffic is by definition already decrypted, and prove nothing about the wire.
#
# The capture runs over the marker and latency phases only. Under the throughput
# flood tcpdump drops packets, and a capture with gaps cannot show that a string is
# absent from the wire.
podman run -d --name "$CAPTURE" --network "container:$NODE_B" \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  -v "$WD:/lab" "$TOOLS_IMAGE" \
  tcpdump -i eth0 -s 0 -U -w /lab/out/$MODE.pcap >/dev/null
sleep 3

echo "== marker and latency through the overlay, under the capture"
podman exec "$NODE_A" /lab/bin/overlay-measure \
  -socks 127.0.0.1:1080 \
  -target "$VIP_B:$ECHO_PORT" \
  -marker "$MARKER" \
  -duration 0
sleep 2

echo "== stop capture"
podman kill -s INT "$CAPTURE" >/dev/null 2>&1 || true
sleep 2
podman logs "$CAPTURE" 2>&1 | tail -4
podman rm -f -t 2 "$CAPTURE" >/dev/null 2>&1 || true

echo "== what is on the wire"
podman run --rm -v "$WD:/lab" "$TOOLS_IMAGE" sh -c "
  echo '-- protocol breakdown';
  tcpdump -n -r /lab/out/$MODE.pcap 2>/dev/null | awk '{ if (\$0 ~ / UDP,/) u++; else if (\$0 ~ / tcp /) t++; else o++ } END { print \"udp datagrams: \" u+0; print \"tcp segments: \" t+0; print \"other: \" o+0 }';
  echo '-- other, in full';
  tcpdump -n -r /lab/out/$MODE.pcap 2>/dev/null | grep -v ' UDP,' | head -5;
  echo '-- endpoints';
  tcpdump -n -r /lab/out/$MODE.pcap 2>/dev/null | awk '{print \$3, \$5}' | sed 's/:\$//' | sort | uniq -c | sort -rn | head -10;
  echo '-- marker search in the raw capture';
  if grep -a -q '$MARKER' /lab/out/$MODE.pcap; then
    echo 'FAIL: the plaintext marker is in the capture';
  else
    echo 'the plaintext marker does not appear in the capture';
  fi;
  echo '-- capture size';
  ls -l /lab/out/$MODE.pcap"

# cpu_ticks reads the node process's own accumulated user+system time. podman stats
# reports the whole container, and node A's container also runs the measurement
# client, so the container figure would attribute the client's work to the node.
cpu_ticks() { podman exec "$1" cat /proc/1/stat | awk '{print $14 + $15}'; }
rss_kb() { podman exec "$1" grep VmRSS /proc/1/status | awk '{print $2}'; }

echo "== node process resource use, before"
A_CPU0=$(cpu_ticks "$NODE_A"); B_CPU0=$(cpu_ticks "$NODE_B")
T0=$(date +%s)
echo "node A: $A_CPU0 ticks, RSS $(rss_kb "$NODE_A") kB"
echo "node B: $B_CPU0 ticks, RSS $(rss_kb "$NODE_B") kB"

echo "== measurement from node A through its own SOCKS5 proxy"
podman exec "$NODE_A" /lab/bin/overlay-measure \
  -socks 127.0.0.1:1080 \
  -target "$VIP_B:$ECHO_PORT" \
  -marker "$MARKER" \
  -duration "${SECONDS_PER_DIRECTION}s" &
MEASURE_PID=$!

sleep 10
echo "== container totals during the transfer (node A also runs the client)"
podman stats --no-stream --format "table {{.Name}} {{.CPUPerc}} {{.MemUsage}}" "$NODE_A" "$NODE_B"

wait $MEASURE_PID

echo "== node process resource use, after"
A_CPU1=$(cpu_ticks "$NODE_A"); B_CPU1=$(cpu_ticks "$NODE_B")
T1=$(date +%s)
echo "node A: $A_CPU1 ticks, RSS $(rss_kb "$NODE_A") kB"
echo "node B: $B_CPU1 ticks, RSS $(rss_kb "$NODE_B") kB"
echo "$A_CPU0 $A_CPU1 $B_CPU0 $B_CPU1 $T0 $T1" | awk '{
  wall = $6 - $5;
  a = ($2 - $1) / 100; b = ($4 - $3) / 100;
  printf "node A process: %.2f cpu seconds over %d s wall = %.0f%% of one core\n", a, wall, a * 100 / wall;
  printf "node B process: %.2f cpu seconds over %d s wall = %.0f%% of one core\n", b, wall, b * 100 / wall;
}'

echo "== probe (ICMP through the tunnel, from node A's log)"
podman logs "$NODE_A" 2>&1 | grep "probe to" | tail -5 || echo "no probe lines"

if [ "$MODE" = tun ]; then
  # The interface belongs to the kernel here, so it is visible to every process in
  # the namespace and carries an ordinary connected route. ICMP is not measured:
  # ping needs CAP_NET_RAW, which this container is deliberately not given, and the
  # node's own probe is a netstack facility.
  echo "== kernel interface on node A"
  podman exec "$NODE_A" ip -brief addr show 2>&1
  podman exec "$NODE_A" ip route show 2>&1
fi

echo "== done"
