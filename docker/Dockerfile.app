# The NeroNet app's headless Linux service and its command line (ADR 0040).
#
# neronet-appd is the core (pkg/clientcore) with its local API on a private unix socket and the node
# agent's own tunnel (pkg/meshnode); neronet-appctl drives it. Built like docker/Dockerfile.node.
FROM golang:1.26.11 AS builder

WORKDIR /build
COPY go.mod go.sum ./
COPY third_party/amneziawg-go ./third_party/amneziawg-go
RUN go mod download

COPY internal ./internal
COPY pkg ./pkg
COPY cmd ./cmd
RUN CGO_ENABLED=0 GOOS=linux go build -tags awg -ldflags="-s -w" -o /build/bin/neronet-appd ./cmd/neronet-appd \
 && CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /build/bin/neronet-appctl ./cmd/neronet-appctl

FROM alpine:3.20

RUN apk add --no-cache iproute2 && adduser -D -u 10001 neronet

# The run directory holds one private directory per owner; the service refuses one that other users can
# write. The state directory holds the app's keys and its stored netmap.
RUN mkdir -p /run/neronet /var/lib/neronet-app \
 && chown 10001:10001 /run/neronet /var/lib/neronet-app \
 && chmod 755 /run/neronet \
 && chmod 700 /var/lib/neronet-app

COPY --from=builder /build/bin/neronet-appd /bin/neronet-appd
COPY --from=builder /build/bin/neronet-appctl /bin/neronet-appctl

USER 10001:10001
ENTRYPOINT ["/bin/neronet-appd"]
