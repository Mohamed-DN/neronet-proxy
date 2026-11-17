#!/bin/sh
# Usage: scripts/dev/test-honest-infra.sh
#
# Guards against infrastructure files that claim more than the repository delivers:
#   - a Dockerfile that hides a failed Go build behind `|| echo` or `|| true`;
#   - the Helm chart shipping the `honeypot` sidecar, whose image is built nowhere,
#     in its default render;
#   - the relay manifests passing DECOY_DOMAIN, which no relay binary reads.
set -eu
cd "$(dirname "$0")/../.."
fail=0

for f in $(git ls-files 'docker/Dockerfile*' 'docker/**/Dockerfile*' '*/Dockerfile' 'Dockerfile*'); do
  if grep -nE 'go build.*\|\|[[:space:]]*(true|:|echo)' "$f"; then
    echo "FAIL  $f hides a failed go build"; fail=1
  fi
done

sts=charts/sovereign-mesh/templates/relay-statefulset.yaml
if grep -n 'name: honeypot' -B2 "$sts" | grep -q 'if .Values.relay.honeypot.enabled'; then
  :
else
  echo "FAIL  $sts ships the honeypot sidecar without a values flag"; fail=1
fi
if awk '/^[[:space:]]*honeypot:/{f=1;next} f&&/enabled:/{print;exit}' charts/sovereign-mesh/values.yaml | grep -q true; then
  echo "FAIL  charts/sovereign-mesh/values.yaml enables the honeypot by default"; fail=1
fi

for f in "$sts" k8s/base/relay-statefulset.yaml; do
  if grep -n 'DECOY_DOMAIN' "$f"; then
    echo "FAIL  $f passes DECOY_DOMAIN, which no relay binary reads"; fail=1
  fi
done

[ "$fail" = 0 ] && echo "PASS  infrastructure files make no claim the repository does not back"
exit "$fail"
