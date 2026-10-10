import { Box, Tooltip } from '@mui/material';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import { C, SERIF } from '../theme/pdartTokens';

/* Reusable "stunning summary" primitives — replace walls-of-chips / dense caption text on every page with a clean
   KPI-card row + an optional composition bar. Keeps ALL the same numbers, just scannable. */

export function Stat({ label, value, sub, tone = C.navy, strong, help }:
  { label: string; value: number | string; sub?: string; tone?: string; strong?: boolean; help?: React.ReactNode }) {
  return (
    <Box sx={{ position: 'relative', minWidth: 150, border: `1px solid ${strong ? tone : C.border}`, borderLeft: `3px solid ${tone}`,
      borderRadius: '12px', boxShadow: '0 1px 3px rgba(45,45,45,0.07)', px: 1.9, py: 1.15, bgcolor: '#fff' }}>
      {help && (
        <Tooltip arrow placement="top" title={<Box sx={{ p: 0.5, fontSize: 12, lineHeight: 1.5 }}>{help}</Box>}>
          <HelpOutlineIcon sx={{ position: 'absolute', top: 6, right: 6, fontSize: 15, color: C.muted, cursor: 'help' }} />
        </Tooltip>
      )}
      <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.muted }}>{label}</Box>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 27, color: tone, lineHeight: 1.12 }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </Box>
      {sub && <Box sx={{ fontSize: 10.5, color: C.muted, mt: 0.1 }}>{sub}</Box>}
    </Box>
  );
}

export function SplitBar({ segments, height = 24 }:
  { segments: { label: string; value: number; color: string }[]; height?: number }) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <Box>
      <Box sx={{ display: 'flex', height, borderRadius: '8px', overflow: 'hidden', border: `1px solid ${C.border}` }}>
        {segments.filter((s) => s.value > 0).map((s, i) => (
          <Box key={i} title={`${s.label}: ${s.value.toLocaleString()}`}
            sx={{ width: `${(s.value / total) * 100}%`, bgcolor: s.color, display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 24 }}>
            {/* always show the count — a small segment (e.g. Donor only 2) is given enough min-width to fit its number */}
            <span style={{ color: '#fff', fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}>{s.value.toLocaleString()}</span>
          </Box>
        ))}
      </Box>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 0.85 }}>
        {segments.map((s, i) => (
          <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: s.color }} />
            <span style={{ fontSize: 11.5, color: C.muted }}>{s.label} <b style={{ color: C.slate }}>{s.value.toLocaleString()}</b></span>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
