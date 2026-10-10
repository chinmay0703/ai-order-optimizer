#!/bin/sh
# Generate the runtime client config /config.js from the container's env vars — build-once, configure-at-runtime
# (the application team's /config.js pattern, adapted for the nginx-static SPA). The stock nginx image runs every
# /docker-entrypoint.d/*.sh at container start, BEFORE nginx serves, so /config.js is always fresh per deploy and
# the browser reads the config at runtime (window.__APP_CONFIG__) — no rebuild, no baked backend URL.
set -e

CONFIG_JS="/usr/share/nginx/html/config.js"
cat > "$CONFIG_JS" <<EOF
window.__APP_CONFIG__ = {
  VITE_API_BASE: "${VITE_API_BASE:-}",
  VITE_REALLOCATION_URL: "${VITE_REALLOCATION_URL:-}"
};
EOF
echo "app-config: wrote $CONFIG_JS (VITE_API_BASE='${VITE_API_BASE:-}', VITE_REALLOCATION_URL='${VITE_REALLOCATION_URL:-}')"
