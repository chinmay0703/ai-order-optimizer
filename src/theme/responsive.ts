/* =====================================================================
   Responsive layout tokens — the SINGLE source of truth for how the app
   adapts from a phone to a 4K desktop.
   ---------------------------------------------------------------------
   The app has two shells, switched at ONE breakpoint (`MOBILE_BP`):

     · desktop (md and up) — the classic L-shape: masthead on top, a
       permanent 236px navy sidebar on the left, page content to the right.
     · mobile / tablet-portrait (below md) — an app shell: masthead on top,
       page content full-bleed, and the nav as a fixed BOTTOM bar that
       scrolls horizontally (shared/layout/MobileNav).

   Every page uses `pageWrap()` for its outer padding instead of hardcoding
   `px: 4, py: 3.5`, so a padding change lands everywhere at once, and every
   wide table sits in a `scrollX` box so the page itself never scrolls
   sideways. Import from here — never re-derive these numbers in a page.
   ===================================================================== */
import { useMediaQuery, useTheme } from '@mui/material';

/** The one breakpoint that switches sidebar-shell ⇄ bottom-nav-shell. MUI `md` = 900px. */
export const MOBILE_BP = 'md' as const;

/** Height of the fixed mobile bottom nav (px). Content reserves this much room below it. */
export const MOBILE_NAV_H = 64;

/** Left sidebar width when expanded (desktop only). */
export const SIDEBAR_W = 236;

/** true on phones and tablet-portrait — the app renders its mobile shell. */
export function useIsMobile(): boolean {
  const theme = useTheme();
  return useMediaQuery(theme.breakpoints.down(MOBILE_BP), { noSsr: true });
}

/** true on phones only (below `sm` = 600px) — for the tightest compressions (title, logo, hints). */
export function useIsPhone(): boolean {
  const theme = useTheme();
  return useMediaQuery(theme.breakpoints.down('sm'), { noSsr: true });
}

/**
 * The standard page shell: centred column, padding that shrinks with the viewport, and enough
 * bottom room on mobile to clear the fixed bottom nav.
 *
 * @param maxWidth the page's desktop reading width (unchanged from before this file existed)
 */
export const pageWrap = (maxWidth: number | string = 1320) => ({
  maxWidth,
  mx: 'auto',
  width: '100%',
  px: { xs: 1.5, sm: 2.5, md: 4 },
  py: { xs: 2, sm: 2.5, md: 3.5 },
  pb: { xs: `${MOBILE_NAV_H + 28}px`, md: 8 },
});

/** Same as `pageWrap` but for a panel embedded INSIDE another page (no max-width / centring). */
export const panelWrap = () => ({
  px: { xs: 1.5, sm: 2.5, md: 3 },
  py: { xs: 2, md: 3 },
  pb: { xs: `${MOBILE_NAV_H + 28}px`, md: 4 },
});

/**
 * Wrap ANY wide table / chart in this. It confines the sideways scroll to the element instead of
 * letting the whole page scroll horizontally — the single most important rule for small screens.
 */
export const scrollX = {
  width: '100%',
  maxWidth: '100%',
  overflowX: 'auto' as const,
  WebkitOverflowScrolling: 'touch',
};

/** A row of filters / dropdowns / buttons: wraps instead of overflowing, and each control goes
 *  full-width on a phone so it stays tappable. Spread this, then set per-control widths with `ctrl`. */
export const filterRow = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  alignItems: 'center',
  gap: { xs: 1, sm: 1.5 },
};

/** A control inside a `filterRow`: full-width on a phone, its natural width from `sm` up. */
export const ctrl = (width: number | string = 220) => ({
  width: { xs: '100%', sm: width },
  minWidth: { xs: 0, sm: width },
});

/** Card/KPI strips: a real grid that reflows 1 → 2 → auto columns instead of a fixed flex row. */
export const cardGrid = (min = 150) => ({
  display: 'grid',
  gap: { xs: 1, sm: 1.5 },
  gridTemplateColumns: {
    xs: '1fr 1fr',
    sm: `repeat(auto-fill, minmax(${min}px, 1fr))`,
  },
});

/** Hide the horizontal scrollbar chrome on the mobile nav strip (still scrollable by touch/wheel). */
export const hideScrollbar = {
  scrollbarWidth: 'none' as const,
  msOverflowStyle: 'none' as const,
  '&::-webkit-scrollbar': { display: 'none' },
};
