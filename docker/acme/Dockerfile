# The ACME client that keeps the console's certificate (NERONET_TLS_MODE=acme).
#
# lego is a single static Go binary and a maintained ACME client; this image only adds
# the loop around it. Pinned by tag, like the other base images: a new lego release is
# read before it is adopted, because this container holds the ACME account key.
FROM docker.io/goacme/lego:v5.5.2

COPY acme-loop.sh /usr/local/bin/acme-loop

# No user is created: the volumes are shared with nginx, which reads them as root, and
# the compose service drops every capability and mounts the root filesystem read-only.
ENTRYPOINT ["/bin/sh", "/usr/local/bin/acme-loop"]
