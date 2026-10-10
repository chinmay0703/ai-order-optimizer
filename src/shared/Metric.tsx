import { Box } from '@mui/material';
import type { ReactNode } from 'react';

/* A single labeled metric cell — a small uppercase label over a bold value, with a hairline divider on its left.
   Used across the truck / CFA / run-summary headers so every number reads clearly for validation, instead of a
   crowded row of colored chips + run-on text. Lay several out in a flex row; the left dividers separate them. */
export default function Metric({ label, tip, color, children }: {
  label: string; tip?: string; color?: string; children: ReactNode;
}) {
  return (
    <Box title={tip} sx={{ display: 'flex', flexDirection: 'column', px: 1.4, py: 0.1,
      borderLeft: '1px solid #EEEFF1', cursor: tip ? 'help' : 'default' }}>
      <Box sx={{ fontSize: '0.58rem', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
        color: '#5C616A', lineHeight: 1.5, whiteSpace: 'nowrap' }}>{label}</Box>
      <Box sx={{ fontSize: '0.86rem', fontWeight: 700, color: color ?? '#2D2D2D', lineHeight: 1.25,
        whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{children}</Box>
    </Box>
  );
}
