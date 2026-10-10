import { Box } from '@mui/material';
import { C, SANS, RADIUS, SHADOW } from '../theme/pdartTokens';

/* Reusable CFA scope selector — a dropdown (NOT a pill row), so pages stay usable and light with up to ~33 CFAs in a
   single run. Pages fetch ONE CFA's slice (pass the value to a `cfa`-scoped API) instead of loading every CFA at once.
   Optionally allows an "All CFAs" choice for the small/aggregate pages (value=''). */
export default function CfaSelect({
  cfas, value, onChange, label = 'CFA', allowAll = false, allLabel = 'All CFAs',
}: {
  cfas: string[]; value: string; onChange: (cfa: string) => void;
  label?: string; allowAll?: boolean; allLabel?: string;
}) {
  if (!cfas.length) return null;
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, bgcolor: C.cream, border: `1px solid ${C.border}`,
      borderRadius: `${RADIUS.md}px`, px: 1.25, py: 0.6, boxShadow: SHADOW.sm }}>
      <Box component="span" sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.muted }}>{label}</Box>
      <Box component="select" value={value} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
        title="Scope this page to one CFA"
        sx={{ fontSize: 14, fontWeight: 800, color: '#10365A', background: C.white, border: `1.5px solid ${C.navy}`,
          borderRadius: '8px', px: 1.25, py: 0.6, cursor: 'pointer', fontFamily: SANS, outline: 'none' }}>
        {allowAll && <option value="">{allLabel}</option>}
        {cfas.map((c) => <option key={c} value={c}>CFA {c}</option>)}
      </Box>
    </Box>
  );
}
