import { Box } from '@mui/material';
import { C, RADIUS } from '../theme/pdartTokens';

/* Which date's sub-channel reservation % a page is showing. The % is stored DATE-WISE (it can change day to day); when
   the run date has no stored % (e.g. a run from before date-wise storage) the backend shows the LATEST stored date
   instead of nothing — this line says so, so a reader never mistakes a fallback % for the one the run used.
   Fields come straight from the API (reservation_pct_date / _fallback / _source_run_date / _requested_date). */
export interface ReservationPctMeta {
  reservation_pct_date?: string | null;
  reservation_pct_fallback?: boolean;
  reservation_pct_source_run_date?: string | null;
  reservation_pct_requested_date?: string | null;
}

export default function ReservationPctDate({ meta }: { meta: ReservationPctMeta | null | undefined }) {
  if (!meta || meta.reservation_pct_fallback === undefined) return null;
  const used = meta.reservation_pct_date;
  const src = meta.reservation_pct_source_run_date ? ` · S3 snapshot ${meta.reservation_pct_source_run_date}` : '';
  const fallback = !!meta.reservation_pct_fallback;
  const text = !fallback
    ? <>Reservation % as of run date <b>{used}</b>{src}</>
    : used
      ? <>No reservation % stored for <b>{meta.reservation_pct_requested_date}</b> — showing the <b>latest stored %</b> (run date <b>{used}</b>{src}).</>
      : <>No date-wise reservation % stored yet — showing the <b>last loaded</b> sub-channel reservation %.</>;
  return (
    <Box sx={{
      display: 'inline-flex', alignItems: 'center', gap: 0.75, px: 1.25, py: 0.5, mb: 1, fontSize: 12, lineHeight: 1.4,
      borderRadius: `${RADIUS.sm}px`, border: `1px solid ${fallback ? C.gold : C.border}`,
      bgcolor: fallback ? C.warnLight : C.panelBg, color: C.slate,
    }}>
      {fallback && <Box component="span" sx={{ color: C.warnText, fontWeight: 800 }}>⚠</Box>}
      <span>{text}</span>
    </Box>
  );
}
