#!/bin/sh
#
# Check the security headers the console serves through nginx.
#
# The SPA document is served by nginx and the API by the backend, so the two header
# sets are set in different places and can disagree. They did: the document carried
# no Content-Security-Policy at all, and /api responses carried two X-Frame-Options
# with different values, one from each side.
#
# This cannot run in the backend test suite, which never goes through nginx.
#
# Usage: check-console-headers.sh [base-url]        (default http://127.0.0.1:8443)
#
# Exits non-zero if any check fails. Prints one line per check.

set -u

BASE=${1:-http://127.0.0.1:8443}

EXPECTED_CSP="default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:"

failures=0

pass() {
  echo "PASS  $1"
}

fail() {
  echo "FAIL  $1"
  failures=$((failures + 1))
}

# Every value of one header, one per line. A header sent twice prints twice, which
# is the point of several of the checks below.
values_of() {
  printf '%s\n' "$1" | tr -d '\r' | grep -i "^$2:" | sed "s/^[^:]*: *//"
}

count_of() {
  values_of "$1" "$2" | grep -c .
}

expect_single() { # headers label header expected-value
  count=$(count_of "$1" "$3")
  value=$(values_of "$1" "$3" | head -1)

  if [ "$count" -ne 1 ]; then
    fail "$2: $3 sent $count times (expected exactly one)"
  elif [ "$value" != "$4" ]; then
    fail "$2: $3 is '$value', expected '$4'"
  else
    pass "$2: $3: $value"
  fi
}

expect_absent() { # headers label header
  count=$(count_of "$1" "$3")

  if [ "$count" -ne 0 ]; then
    fail "$2: $3 is present ($(values_of "$1" "$3" | head -1)) and should not be"
  else
    pass "$2: $3 absent"
  fi
}

expect_contains() { # headers label header substring
  value=$(values_of "$1" "$3" | head -1)

  case "$value" in
    *"$4"*) pass "$2: $3 contains '$4'" ;;
    *) fail "$2: $3 is '$value', which does not contain '$4'" ;;
  esac
}

fetch() { # url -> headers on stdout, non-zero if the request failed
  curl -sS -I --max-time 10 "$1"
}

echo "== SPA document: $BASE/"
doc=$(fetch "$BASE/") || {
  echo "FAIL  the console document could not be fetched from $BASE/"
  exit 1
}

status=$(printf '%s\n' "$doc" | tr -d '\r' | head -1)
echo "      $status"

expect_single "$doc" document 'Content-Security-Policy' "$EXPECTED_CSP"
expect_single "$doc" document 'Referrer-Policy' 'strict-origin-when-cross-origin'
expect_single "$doc" document 'X-Content-Type-Options' 'nosniff'
expect_single "$doc" document 'X-Frame-Options' 'DENY'

for feature in 'camera=()' 'microphone=()' 'geolocation=()' 'payment=()'; do
  expect_contains "$doc" document 'Permissions-Policy' "$feature"
done

# Deprecated, and on some browsers it reintroduced the hole it claimed to close.
expect_absent "$doc" document 'X-XSS-Protection'
# The edge serves plain HTTP. HSTS arrives with TLS.
expect_absent "$doc" document 'Strict-Transport-Security'

echo
echo "== API response: $BASE/api/health"
api=$(fetch "$BASE/api/health") || {
  echo "FAIL  /api/health could not be fetched from $BASE"
  exit 1
}

status=$(printf '%s\n' "$api" | tr -d '\r' | head -1)
echo "      $status"

# One value per header on proxied responses: nginx must not add its own on top of
# the backend's. Two X-Frame-Options with different values is not a stricter policy,
# it is an undefined one.
expect_single "$api" api 'X-Frame-Options' 'DENY'
expect_single "$api" api 'Referrer-Policy' 'strict-origin-when-cross-origin'
expect_single "$api" api 'X-Content-Type-Options' 'nosniff'

csp_count=$(count_of "$api" 'Content-Security-Policy')
if [ "$csp_count" -eq 1 ]; then
  pass "api: Content-Security-Policy sent once"
else
  fail "api: Content-Security-Policy sent $csp_count times (expected exactly one)"
fi

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi

echo "all checks passed"
