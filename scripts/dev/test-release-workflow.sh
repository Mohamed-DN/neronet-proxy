#!/bin/sh
# Usage: scripts/dev/test-release-workflow.sh
#
# The release workflow runs only on tags, so a regression in it shows up when a release
# is cut. This checks, on every push, that it cannot report success for a build or a
# signature that did not happen: no step swallows a failure with `|| true` or ends a
# chain of attempts in a message, and a binary it lists must exist.
set -eu
cd "$(dirname "$0")/../.."
f=.github/workflows/release.yml
fail=0
if grep -nE '\|\|[[:space:]]*(true|:)([[:space:]]|$)' "$f"; then
  echo "FAIL  $f swallows a failure with || true"; fail=1
fi
if grep -nE '\|\|[[:space:]]*echo' "$f"; then
  echo "FAIL  $f turns a failure into a message"; fail=1
fi
for bin in $(sed -n '/BINARIES=(/,/)/p' "$f" | grep -o '"[a-z-]*"' | tr -d '"'); do
  [ -d "cmd/$bin" ] || { echo "FAIL  $f lists cmd/$bin, which does not exist"; fail=1; }
done
[ "$fail" = 0 ] && echo "PASS  $f reports every failed build and signature"
exit "$fail"
