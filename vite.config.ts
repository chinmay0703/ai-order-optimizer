import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the static build works from any sub-path — e.g. GitHub Pages at /<repo>/. There is no backend and no
// proxy: every /api call is answered in the browser from the dummy dataset (src/mock).
export default defineConfig(() => {
  return {
    plugins: [react()],
    base: './',
    server: { port: 5199, open: true },
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
