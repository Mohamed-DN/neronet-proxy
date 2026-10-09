# ==============================================================================
# Sovereign Proxy v4.0 - Hardened Multi-Stage Rootless Dockerfile
# Location: docker/Dockerfile
# ==============================================================================

# --- Stage 1: Build & Package Binaries ---
FROM golang:1.26.9-alpine AS builder

WORKDIR /build

# Build Sovereign Security Daemon
COPY cmd/sovereign-security-daemon /build/cmd/sovereign-security-daemon
WORKDIR /build/cmd/sovereign-security-daemon
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /build/bin/sovereign-security-daemon . || echo "Daemon Go build stub"

# --- Stage 2: Hardened Rootless Runtime ---
FROM alpine:3.20

LABEL maintainer="Sovereign Proxy Core Team"
LABEL version="4.0.0"
LABEL description="Hardened Rootless Anti-Censorship Edge Node"

# Create non-privileged sovereign user & group (UID 10001)
RUN addgroup -g 10001 sovereign && \
    adduser -u 10001 -G sovereign -s /bin/sh -D sovereign

# Install runtime dependencies & security tools
RUN apk add --no-cache \
    ca-certificates \
    tzdata \
    nginx \
    curl \
    jq \
    python3 \
    sqlite \
    libcap \
    tini

# Set up directory layout with non-root ownership
RUN mkdir -p \
    /etc/sovereign \
    /var/www/decoy \
    /var/log/nginx \
    /var/log/xray \
    /var/lib/nginx/tmp \
    /var/run/nginx \
    /etc/nginx/conf.d \
    /app && \
    chown -R sovereign:sovereign \
    /etc/sovereign \
    /var/www/decoy \
    /var/log/nginx \
    /var/log/xray \
    /var/lib/nginx \
    /var/run/nginx \
    /etc/nginx \
    /app

# Allow non-root sovereign user to bind to privileged ports (<1024 like 443)
RUN setcap 'cap_net_bind_service=+ep' /usr/sbin/nginx 2>/dev/null || true

# Copy configurations and scripts
COPY --chown=sovereign:sovereign configs/nginx/decoy.conf /etc/nginx/conf.d/default.conf
COPY --chown=sovereign:sovereign configs/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --chown=sovereign:sovereign configs/xray/config.json.template /etc/sovereign/config.json.template
COPY --chown=sovereign:sovereign scripts/legacy_refactor/ /app/scripts/
COPY --chown=sovereign:sovereign cmd/sovereign-security-daemon/daemon.py /app/sovereign-security-daemon.py
COPY --chown=sovereign:sovereign docker/entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh /app/scripts/* /app/sovereign-security-daemon.py

# Switch to unprivileged user (UID 10001)
USER 10001:10001
WORKDIR /app

# Expose Ingress (443/tcp, 443/udp), Decoy fallback (8443), and Honeypot (8080)
EXPOSE 443/tcp 443/udp 8443/tcp 8080/tcp

# Healthcheck probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://127.0.0.1:8443/api/status || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
CMD ["start"]
