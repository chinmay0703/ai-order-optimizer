import type { ReactNode } from 'react';
import { Box } from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { C, RADIUS } from '../theme/pdartTokens';

/* Reusable page-description callout — the SAME visual treatment for every page's intro/explainer. Pass the existing
   description text as children (unchanged); this just wraps it in a consistent, easy-to-read card: an accent rail, a
   warm panel, an info glyph, and comfortable line-height. Keeps the words, upgrades the look. */
export default function PageIntro({ children, tone = C.gold }: { children: ReactNode; tone?: string }) {
  return (
    <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'flex-start', p: '14px 16px', mb: 2,
      border: `1px solid ${C.border}`, borderLeft: `3px solid ${tone}`, borderRadius: `${RADIUS.md}px`, bgcolor: C.cream }}>
      <InfoOutlinedIcon sx={{ fontSize: 18, color: tone, mt: '2px', flexShrink: 0 }} />
      <Box sx={{ fontSize: 13, color: C.slate, lineHeight: 1.6, '& code': { fontFamily: 'Consolas, monospace', fontSize: 12, background: 'rgba(45,45,45,0.06)', padding: '1px 5px', borderRadius: '4px' } }}>
        {children}
      </Box>
    </Box>
  );
}
