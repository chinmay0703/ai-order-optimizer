# oe-demo-frontend — PepsiCo allocation/re-allocation UI (Vite + React 19 + MUI).
#
# Multi-stage: build the static bundle with Node, then serve it with nginx. Two runtime knobs, so ONE image works
# in every environment (like the app team's frontend — build once, configure at runtime):
#   • CLIENT config (VITE_API_BASE, VITE_REALLOCATION_URL) — the entrypoint writes /config.js from the container env at
#     start; the app reads it at RUNTIME (window.__APP_CONFIG__). The build is ENV-AGNOSTIC — nothing baked into JS.
#   • BACKEND location (BACKEND_UPSTREAM) — nginx reverse-proxies same-origin /api -> the backend (no CORS).

# ---- build stage (env-agnostic: NO VITE_* baked; config is injected at runtime via /config.js) ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- serve stage ----
FROM nginx:alpine
# The nginx image renders /etc/nginx/templates/*.template with envsubst at startup -> /etc/nginx/conf.d/.
# BACKEND_UPSTREAM is the ONLY var substituted (NGINX_ENVSUBST_FILTER keeps nginx's own $vars safe).
# DEFAULT = the backend k8s Service (atom-oer-qa:8000), so /api works on the QA deploy WITHOUT setting any
# deployment env. It resolves in-cluster (backend + frontend in the same namespace); local `docker compose`
# still OVERRIDES it to host.docker.internal:8000. For a different env/namespace, override BACKEND_UPSTREAM
# (k8s env / compose) with that backend Service:port — or its FQDN atom-oer-qa.<namespace>.svc.cluster.local:8000.
ENV BACKEND_UPSTREAM=atom-oer:8000 \
    NGINX_ENVSUBST_FILTER=BACKEND_UPSTREAM
# CLIENT runtime config defaults (overridable per environment via k8s env / compose). The entrypoint script below
# writes these into /config.js at container start; the SPA reads them at runtime. "" API base = same-origin /api.
ENV VITE_API_BASE="" \
    VITE_REALLOCATION_URL=""
COPY default.conf.template /etc/nginx/templates/default.conf.template
# runs at start (before nginx serves): writes /usr/share/nginx/html/config.js from the env vars above
COPY docker-entrypoint.d/40-app-config.sh /docker-entrypoint.d/40-app-config.sh
RUN chmod +x /docker-entrypoint.d/40-app-config.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
