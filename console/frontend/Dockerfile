# Multi-Stage Dockerfile for NeroNet Enterprise Management Console Frontend
# Stage 1: Build Vite React SPA
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Production Nginx Server
FROM nginx:1.27-alpine AS runner
COPY --from=builder /app/dist /usr/share/nginx/html
# Rendered at start by the image's envsubst step into /etc/nginx/conf.d/default.conf.
# Only variables defined in the environment are substituted, so nginx's own
# $request_uri and friends pass through unchanged.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Where the certificate comes from (NERONET_TLS_MODE=internal|acme): writes the files the
# template includes and, in acme mode, reloads nginx when a renewed certificate arrives.
# The build writes the internal-mode files once so that `nginx -t` passes on the bare
# image; the entrypoint step rewrites them for the mode the container runs in.
COPY tls/neronet-tls.sh /usr/local/lib/neronet/neronet-tls.sh
COPY tls/acme-http.conf.template /usr/local/lib/neronet/acme-http.conf.template
COPY tls/40-neronet-tls.sh /docker-entrypoint.d/40-neronet-tls.sh
RUN chmod 755 /usr/local/lib/neronet/neronet-tls.sh /docker-entrypoint.d/40-neronet-tls.sh \
 && /usr/local/lib/neronet/neronet-tls.sh setup
ENV NERONET_TLS_MODE=internal
EXPOSE 8443
# 8443 is TLS-only; the probe uses the loopback health listener in the template.
# In acme mode it answers 503 until the first certificate has been published.
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8090/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
