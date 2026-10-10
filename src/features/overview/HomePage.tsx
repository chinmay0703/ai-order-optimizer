import { Box } from '@mui/material';
import { MENU_SECTIONS, SHOWCASE_SECTIONS, type Page } from '../../shared/layout/Sidebar';
import { C, SERIF, SANS, RADIUS, SHADOW } from '../../theme/pdartTokens';

/* ---------------------------------------------------------------------------
   Home — the landing/menu page (first item, above Run). A directory of every
   page in the allocation pipeline, grouped in run order, each with its one-line
   description. Cards reuse the SAME {label, sub, icon} the sidebar defines
   (imported from Sidebar's MENU_SECTIONS), so the descriptions never drift.
   Clicking a card navigates to that page via onNav.
--------------------------------------------------------------------------- */
export default function HomePage({ onNav }: { onNav: (p: Page) => void }) {
  const totalPages = MENU_SECTIONS.reduce((n, s) => n + s.items.length, 0);
  return (
    <Box sx={{ background: C.canvas, minHeight: '100%', fontFamily: SANS, color: C.slate }}>
      <Box sx={{ maxWidth: 1200, mx: 'auto', px: { xs: 2.5, md: 4 }, py: 4, pb: 8 }}>

        {/* hero */}
        <Box sx={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase', color: C.gold }}>
          PwC · AI Order Optimizer
        </Box>
        <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: { xs: 27, md: 34 }, m: '6px 0 8px', letterSpacing: '-.4px' }}>
          Order Engine — every page, in run order
        </Box>
        <Box sx={{ fontSize: 14.5, color: C.slate, maxWidth: 780, lineHeight: 1.55 }}>
          The full allocation pipeline, top to bottom — from the demand gate through Steps&nbsp;1–3, the truck build, and the
          SAP hand-off, plus the validation views. Pick any card to open it. <b style={{ color: C.navy }}>{totalPages}</b> pages.
        </Box>

        {/* sections */}
        {MENU_SECTIONS.map((sec, si) => (
          <Box key={sec.title} sx={{ mt: si === 0 ? 3.5 : 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 1.25 }}>
              <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 18, color: C.navy, whiteSpace: { xs: 'normal', sm: 'nowrap' }, minWidth: 0 }}>{sec.title}</Box>
              <Box sx={{ flex: 1, height: 1, bgcolor: C.rule }} />
              {/* supplementary caption — nowrap here plus a nowrap title made the row wider than a phone,
                  which forced the browser to zoom out and pushed the fixed bottom nav off-screen */}
              <Box sx={{ fontSize: 11.5, color: C.muted, whiteSpace: 'nowrap', display: { xs: 'none', sm: 'block' } }}>{sec.blurb}</Box>
            </Box>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(255px, 1fr))', gap: 1.5 }}>
              {sec.items.map((it) => (
                <Box
                  key={it.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => onNav(it.key)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNav(it.key); } }}
                  sx={{
                    cursor: 'pointer', bgcolor: C.white, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.navy}`,
                    borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, p: 1.75, display: 'flex', gap: 1.25, alignItems: 'flex-start',
                    transition: 'transform .12s ease, box-shadow .12s ease, border-color .12s ease',
                    '&:hover': { borderLeftColor: C.gold, boxShadow: SHADOW.md, transform: 'translateY(-2px)' },
                    '&:focus-visible': { outline: `2px solid ${C.gold}`, outlineOffset: 2 },
                  }}>
                  <Box sx={{ color: C.navy, display: 'flex', mt: '1px', '& svg': { fontSize: 25 } }}>{it.icon}</Box>
                  <Box sx={{ minWidth: 0 }}>
                    <Box sx={{ fontWeight: 800, fontSize: 14.5, color: C.navy, lineHeight: 1.2 }}>{it.label}</Box>
                    <Box sx={{ fontSize: 12, color: C.muted, mt: 0.35, lineHeight: 1.35 }}>{it.sub}</Box>
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
        ))}

        {/* planned phases — non-clickable showcase cards (below Reports), same list the sidebar renders */}
        {SHOWCASE_SECTIONS.map((sec) => (
          <Box key={sec.title} sx={{ mt: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 1.25 }}>
              <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 18, color: C.navy, whiteSpace: { xs: 'normal', sm: 'nowrap' }, minWidth: 0 }}>{sec.title}</Box>
              <Box sx={{ flex: 1, height: 1, bgcolor: C.rule }} />
              {/* supplementary caption — nowrap here plus a nowrap title made the row wider than a phone,
                  which forced the browser to zoom out and pushed the fixed bottom nav off-screen */}
              <Box sx={{ fontSize: 11.5, color: C.muted, whiteSpace: 'nowrap', display: { xs: 'none', sm: 'block' } }}>{sec.blurb}</Box>
            </Box>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(255px, 1fr))', gap: 1.5 }}>
              {sec.items.map((it) => {
                const linked = !!it.href;   // a real app to open (new tab) vs a greyed "SOON" placeholder
                return (
                <Box key={it.label} aria-disabled={!linked}
                  onClick={linked ? () => window.open(it.href, '_blank', 'noopener,noreferrer') : undefined}
                  sx={{
                    bgcolor: C.canvas, border: `1px ${linked ? 'solid' : 'dashed'} ${C.border}`,
                    borderLeft: `3px solid ${linked ? C.gold : C.muted}`,
                    borderRadius: `${RADIUS.md}px`, p: 1.75, display: 'flex', gap: 1.25, alignItems: 'flex-start',
                    opacity: linked ? 1 : 0.72,
                    ...(linked ? { cursor: 'pointer', transition: 'box-shadow .12s, border-color .12s',
                      '&:hover': { boxShadow: SHADOW.sm, borderColor: C.gold } } : {}),
                  }}>
                  <Box sx={{ color: linked ? C.gold : C.muted, display: 'flex', mt: '1px', '& svg': { fontSize: 25 } }}>{it.icon}</Box>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                      <Box sx={{ fontWeight: 800, fontSize: 14.5, color: linked ? C.navy : C.muted, lineHeight: 1.2 }}>{it.label}</Box>
                      <Box component="span" sx={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', color: C.gold, border: `1px solid ${C.gold}`, borderRadius: '4px', px: 0.5, py: '1px' }}>{linked ? 'OPEN ↗' : 'SOON'}</Box>
                    </Box>
                    <Box sx={{ fontSize: 12, color: linked ? C.slate : C.muted, mt: 0.35, lineHeight: 1.35 }}>{it.sub}</Box>
                  </Box>
                </Box>
                );
              })}
            </Box>
          </Box>
        ))}

        <Box sx={{ borderTop: `1px solid ${C.rule}`, mt: 4, pt: 1.25, fontSize: 10.5, color: C.muted }}>
          AI Order Optimizer · pages in pipeline order · click a card to open
        </Box>
      </Box>
    </Box>
  );
}
