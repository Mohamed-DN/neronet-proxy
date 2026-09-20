#!/bin/sh
# Usage: measure.sh <project> [--matrix] [--count N] [--plan file] [--json file]
#
# Measures the round trip between every pair of fleet entities (ICMP from a sidecar in
# each container's network namespace) and prints it next to the planned one. Fails when
# any pair deviates by more than max(3 ms, 15% of the plan). The full result is written
# to scripts/sim/out/measure.json.
#
# Needs Node 22 or later on the host.
set -eu
. "$(dirname "$0")/../dev/engine.sh"

[ $# -ge 1 ] || { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
project=$1
shift
export NERONET_ENGINE=$ENGINE
exec node "$(dirname "$0")/measure.mjs" --project "$project" "$@"
