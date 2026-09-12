# Dockerfile for NeroNet Enterprise Management Console Backend API
FROM node:22-slim
WORKDIR /app

# Install dependencies as root, before dropping privileges.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Run unprivileged.
#
# The README claimed this was already true; it was not, and a false claim about a
# security property is worse than no claim, because it stops anyone from checking.
# The service ran as root with a writable root filesystem.
#
# 10001 is a fixed uid so that a host bind-mount has a stable owner to match, and
# /app/data is the one path the process needs to write: the SQLite file and the
# mesh's Ed25519 federation identity.
RUN groupadd --gid 10001 neronet \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin neronet \
 && mkdir -p /app/data \
 && chown -R 10001:10001 /app/data

USER 10001:10001

ENV NODE_ENV=production
ENV PORT=8081
ENV HOST=0.0.0.0
ENV SOVEREIGN_DATA_DIR=/app/data

EXPOSE 8081
HEALTHCHECK --interval=5s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:8081/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
