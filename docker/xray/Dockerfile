# The VLESS + REALITY terminator of the profile gateway (ADR 0036, access method
# vless-reality). Xray-core is MPL-2.0, https://github.com/XTLS/Xray-core. The binary is the
# official release asset, pinned by version and checked against the sha256 published on the
# release page ("digest" of Xray-linux-64.zip). Change both together; the same pair is in
# scripts/dev/test-vless.sh, which tests this exact release.
FROM alpine:3.20 AS fetch
ARG XRAY_VERSION=v26.11.9
ARG XRAY_SHA256=b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82
RUN apk add --no-cache curl unzip \
 && curl -fsSL -o /x.zip "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip" \
 && echo "${XRAY_SHA256}  /x.zip" | sha256sum -c - \
 && mkdir /out && unzip -j /x.zip xray LICENSE -d /out

FROM alpine:3.20
# Same uid as the node image: the node writes the configuration (mode 0600) into a shared
# volume and this container reads it.
RUN adduser -D -u 10001 neronet \
 && mkdir -p /var/lib/neronet-xray && chown 10001:10001 /var/lib/neronet-xray
COPY --from=fetch /out/xray /usr/local/bin/xray
COPY --from=fetch /out/LICENSE /usr/share/licenses/xray-core-LICENSE
COPY docker/xray/entrypoint.sh /entrypoint.sh
USER 10001:10001
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
