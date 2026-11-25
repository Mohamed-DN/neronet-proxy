#!/bin/sh
# Usage: test-go.sh
#
# gofmt check, go vet, `go test ./... -race`, and the tests of the separate module in
# cmd/sovereign-security-daemon, all in golang:1.26. Module and build caches are named
# volumes shared between runs; the Go toolchain locks them, so parallel runs are safe.
# Exit status is non-zero if any step failed.
set -eu
. "$(dirname "$0")/engine.sh"

exec $ENGINE run --rm \
  -v "$(HOST_PATH "$REPO_ROOT"):/src" \
  -v neronet-gomod:/go/pkg/mod \
  -v neronet-gocache:/root/.cache/go-build \
  -w /src docker.io/library/golang:1.26 sh -c '
    rc=0
    echo "== gofmt -l (must print nothing)"
    unformatted=$(gofmt -l .)
    if [ -n "$unformatted" ]; then echo "$unformatted"; rc=1; fi
    echo "== go vet"
    go vet ./... || rc=1
    echo "== go test -race (our packages)"
    go test $(go list ./... | grep -v /third_party/) -race -count=1 || rc=1
    # CI runs as an ordinary user and this container as root: tests that branch on the uid pass here and
    # fail there (clientcore did, on 25 November). Run those packages the CI way too.
    echo "== clientcore as an ordinary user"
    go test -race -c -o /usr/local/bin/clientcore.test ./pkg/clientcore/ || rc=1
    mkdir -p /tmp/ordinary && chmod 1777 /tmp/ordinary
    (cd pkg/clientcore && setpriv --reuid=1001 --regid=1001 --clear-groups       env HOME=/tmp/ordinary TMPDIR=/tmp/ordinary /usr/local/bin/clientcore.test -test.count=1) || rc=1

    echo "== awg build tag: vet and the AmneziaWG interop tests (-race)"
    go vet -tags awg ./pkg/dataplane/ ./pkg/meshnode/ ./cmd/sovereign-node/ || rc=1
    go test -tags awg ./pkg/dataplane/ ./pkg/meshnode/ ./cmd/sovereign-node/ -race -count=1 -run "AWG|Awg|SetPeers|Gateway" || rc=1
    echo "== third_party tests (no race detector)"
    go test ./third_party/... -count=1 || rc=1
    echo "== cmd/sovereign-security-daemon (own module)"
    (cd cmd/sovereign-security-daemon && go test ./... -count=1) || rc=1
    exit $rc'
