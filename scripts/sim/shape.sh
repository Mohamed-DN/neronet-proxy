#!/bin/sh
# Usage: shape.sh <project> [--reset] [--plan file]
#
# Applies the latency plan (scripts/sim/out/fleet.plan.json) to the running fleet of the
# compose project: a prio-like htb tree with one netem leaf per peer and a u32 filter on
# the destination address, on every node, every DERP relay and the control plane's front
# end. Installed from a sidecar that shares each container's network namespace, so the
# node image gains nothing. Idempotent; --reset removes the shaping.
#
# Needs Node 22 or later on the host. Works with podman and docker (scripts/dev/engine.sh).
set -eu
. "$(dirname "$0")/../dev/engine.sh"

[ $# -ge 1 ] || { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
project=$1
shift
export NERONET_ENGINE=$ENGINE
exec node "$(dirname "$0")/shape.mjs" --project "$project" "$@"
