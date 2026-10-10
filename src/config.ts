// config.ts — the ONE place the app reads environment config, the way the application team's frontend does it:
// at RUNTIME. The deployed container's entrypoint writes /config.js from the container env vars at start
// (window.__APP_CONFIG__), so a single build is configured per-environment at runtime — no rebuild, no baked URL.
// For local `npm run dev` (no entrypoint), window.__APP_CONFIG__ is empty and we fall back to the build-time
// import.meta.env values from .env.
type RuntimeConfig = { VITE_API_BASE?: string; VITE_REALLOCATION_URL?: string };

// the Run-2 reallocation app opens in a NEW TAB from this URL. Env-overridable per environment (QA vs prod) the same
// runtime way as VITE_API_BASE; this QA default lets it work out-of-the-box without a rebuild.
const REALLOCATION_URL_DEFAULT =
  'https://oe-reallocation-demo-frontend-qa.aisp.gw01.eks01.aps1.nonprod.aws.intra.pepsico.com';

const runtime: RuntimeConfig =
  (typeof window !== 'undefined' && (window as unknown as { __APP_CONFIG__?: RuntimeConfig }).__APP_CONFIG__) || {};

// runtime value (from /config.js) wins; otherwise the build-time .env value; otherwise empty.
function read(key: keyof RuntimeConfig): string {
  const rt = runtime[key];
  const bt = import.meta.env[key] as string | undefined;
  return String(rt ?? bt ?? '').trim();
}

export const config = {
  /** backend base URL; '' → same-origin '/api/v1' (nginx/vite proxies it) */
  apiBase: read('VITE_API_BASE'),
  /** Run-2 reallocation app — opened in a new tab; env-overridable, QA default */
  reallocationUrl: read('VITE_REALLOCATION_URL') || REALLOCATION_URL_DEFAULT,
};
