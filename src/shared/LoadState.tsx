import { Box, Skeleton, Stack } from '@mui/material';
import type { ReactNode } from 'react';
import { C, RADIUS, SANS, SERIF } from '../theme/pdartTokens';

/**
 * The three states every data page must be able to show, so "still loading" can never be confused with
 * "loaded, and there is nothing here".
 *
 *   <PageSkeleton/>  while the request is in flight  — shimmering placeholders, not a bare spinner
 *   <EmptyState/>    the request finished with 0 rows — says WHY, and what to change
 *   <ErrorState/>    the request failed              — shows the message, offers a retry
 *
 * The bug this replaces: pages held `data` as `null` and rendered a spinner for `!data`, so any path that
 * left `data` null — no CFA selected, an empty payload, an early return — span forever.
 */

/** Shimmering placeholder shaped roughly like a data page: heading, KPI strip, then table rows. */
export function PageSkeleton({ rows = 6, kpis = 4 }: { rows?: number; kpis?: number }) {
  return (
    <Box aria-busy="true" aria-live="polite" sx={{ py: 1 }}>
      <Skeleton animation="wave" variant="text" width="42%" height={34} sx={{ mb: 0.5 }} />
      <Skeleton animation="wave" variant="text" width="66%" height={18} sx={{ mb: 2.5 }} />

      {kpis > 0 && (
        <Box sx={{ display: 'grid', gap: 1.5, mb: 2.5,
          gridTemplateColumns: { xs: '1fr 1fr', sm: `repeat(auto-fill, minmax(150px, 1fr))` } }}>
          {Array.from({ length: kpis }).map((_, i) => (
            <Skeleton key={i} animation="wave" variant="rounded" height={72} sx={{ borderRadius: `${RADIUS.md}px` }} />
          ))}
        </Box>
      )}

      <Skeleton animation="wave" variant="rounded" height={40} sx={{ mb: 1, borderRadius: `${RADIUS.sm}px` }} />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} animation="wave" variant="rounded" height={34}
          sx={{ mb: 0.75, borderRadius: `${RADIUS.sm}px`, opacity: 1 - i * 0.1 }} />
      ))}
    </Box>
  );
}

/** Finished, but there is nothing to show. Always says what would change the answer. */
export function EmptyState({ title = 'Nothing to show', hint, icon }: {
  title?: string; hint?: ReactNode; icon?: ReactNode;
}) {
  return (
    <Stack alignItems="center" spacing={1} sx={{ py: 8, px: 2, textAlign: 'center' }}>
      {icon}
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 18, color: C.navy }}>{title}</Box>
      {hint && <Box sx={{ fontFamily: SANS, fontSize: 13.5, color: C.muted, maxWidth: 460 }}>{hint}</Box>}
    </Stack>
  );
}

/** The request failed — show the message rather than an endless spinner. */
export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <Stack alignItems="center" spacing={1.25} sx={{ py: 7, px: 2, textAlign: 'center' }}>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 17, color: C.alertRed }}>Could not load this page</Box>
      <Box sx={{ fontFamily: 'Consolas, monospace', fontSize: 12.5, color: C.muted, maxWidth: 560,
        overflowWrap: 'anywhere' }}>{error}</Box>
      {onRetry && (
        <Box component="button" onClick={onRetry}
          sx={{ mt: 0.5, cursor: 'pointer', fontFamily: SANS, fontSize: 13, fontWeight: 700, color: C.navy,
            bgcolor: C.cream, border: `1px solid ${C.border}`, borderRadius: `${RADIUS.sm}px`, px: 2, py: 0.75,
            '&:hover': { bgcolor: C.goldLight } }}>Try again</Box>
      )}
    </Stack>
  );
}
