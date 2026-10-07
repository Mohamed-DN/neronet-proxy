#!/bin/sh
# Runs from the nginx image's entrypoint, after the templates are rendered and before
# nginx starts. See neronet-tls.sh for what it does.
exec /usr/local/lib/neronet/neronet-tls.sh setup
