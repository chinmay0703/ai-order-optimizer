// Runtime app config (build-once, configure-at-runtime — the app team's /config.js pattern).
//
// In a DEPLOYED container the entrypoint (docker-entrypoint.d/40-app-config.sh) OVERWRITES this file from the
// container's env vars at START, so ONE build is configured per environment at runtime — no rebuild, no baked URL.
// In local `npm run dev` this default (empty) is served and the app falls back to the build-time .env values.
window.__APP_CONFIG__ = window.__APP_CONFIG__ || {};
