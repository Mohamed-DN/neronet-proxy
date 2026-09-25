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
EXPOSE 8443
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8443/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
