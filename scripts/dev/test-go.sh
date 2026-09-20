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
    echo "== go test ./... -race"
    go test ./... -race -count=1 || rc=1
    echo "== cmd/sovereign-security-daemon (own module)"
    (cd cmd/sovereign-security-daemon && go test ./... -count=1) || rc=1
    exit $rc'
