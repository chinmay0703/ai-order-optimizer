import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so a production build can be served from any path.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Same-origin dev: with VITE_API_BASE empty, the app calls /api/... and Vite proxies it to the local backend —
  // exactly how nginx proxies /api in prod. Target is env-driven (VITE_DEV_API), default the local FastAPI on :8000,
  // so there is NO hardcoded backend URL in the app itself.
  const devApi = env.VITE_DEV_API || 'http://localhost:8000';
  return {
    plugins: [react()],
    base: './',
    server: { port: 5188, open: true, proxy: { '/api': devApi } },
    build: {
      // pages are code-split (React.lazy), so the biggest remaining files are shared vendors — bumped so the
      // build log stays quiet unless something genuinely regresses.
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          // Split the big, rarely-changing shared libraries into their own long-cached chunks so (a) they download
          // in parallel with app code and (b) a normal app-code deploy doesn't bust the React/MUI cache — repeat
          // visits re-fetch only the small changed chunks. mermaid + xlsx are deliberately NOT listed here: mermaid
          // does its OWN per-diagram dynamic-import splitting (coalescing it would force ~1 MB to load at once), and
          // xlsx is already an on-click dynamic import — both get Rollup's default (correct) splitting.
          manualChunks(id) {
            if (/node_modules\/(react|react-dom|react-is|scheduler)\//.test(id)) return 'react-vendor';
            if (/node_modules\/(@mui|@emotion)\//.test(id)) return 'mui-vendor';
            return undefined;
          },
        },
      },
    },
  };
});
