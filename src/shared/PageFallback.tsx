import { Box, CircularProgress } from '@mui/material';

/* The Suspense fallback shown while a code-split page's JS chunk downloads on first open.
   Kept intentionally light (navy + gold, P-DART house style) so it reads as "loading this page",
   not "app is broken". Appears only the FIRST time a page is opened; after that its chunk is cached. */
export default function PageFallback() {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1.2,
      minHeight: '45vh', color: '#4C5056' }}>
      <CircularProgress size={22} thickness={5} sx={{ color: '#FE7C39' }} />
      <Box sx={{ fontSize: 13, fontWeight: 700, letterSpacing: '.02em',
        fontFamily: 'Calibri, "Segoe UI", system-ui, sans-serif' }}>Loading…</Box>
    </Box>
  );
}
