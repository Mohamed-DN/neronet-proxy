# The ACME client that keeps the console's certificate (NERONET_TLS_MODE=acme).
#
# lego v5.5.2 saves a new local account before reaching the CA, then only tries
# recovery on the next run. If the first CA call failed, recovery returns
# accountDoesNotExist forever. Build its checksum-verified module with the narrow
# patch below: register the SAME key when the CA confirms it was never registered.
# Upstream source: v5.5.2, commit 452dc82113609488fb680acf8fc72712b1794f8d.
FROM docker.io/library/golang:1.26-alpine AS builder
RUN apk add --no-cache patch
WORKDIR /src
RUN go mod download github.com/go-acme/lego/v5@v5.5.2 \
    && cp -a /go/pkg/mod/github.com/go-acme/lego/v5@v5.5.2/. /src/ \
    && chmod -R u+w /src
COPY recover-unregistered-account.patch /tmp/recover.patch
RUN patch -p1 < /tmp/recover.patch \
    && CGO_ENABLED=0 go build -trimpath -ldflags '-s -w -X main.version=5.5.2-neronet1' -o /out/lego .

FROM docker.io/goacme/lego:v5.5.2
COPY --from=builder /out/lego /lego
COPY --from=builder /src/LICENSE /usr/share/licenses/lego/LICENSE

COPY acme-loop.sh /usr/local/bin/acme-loop

# No user is created: the volumes are shared with nginx, which reads them as root, and
# the compose service drops every capability and mounts the root filesystem read-only.
ENTRYPOINT ["/bin/sh", "/usr/local/bin/acme-loop"]
