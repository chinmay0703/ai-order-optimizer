import { createTheme } from '@mui/material/styles';
import { C, SERIF, SANS, RADIUS, SHADOW } from './pdartTokens';

// P-DART house style (skill: pdart-theme) — navy + gold + cream on white, Cambria serif heads,
// Inter body. Tables get a CREAM header with NAVY text; rounded corners + soft shadows (no longer
// sharp/flat). One theme so EVERY MUI page inherits the look; EvalPage/MastersPage/StoryPage are the
// inline twins that pull the same tokens from ./pdartTokens.
const NAVY = C.navy;
const GOLD = C.gold;
const GREEN = C.success;
const CREAM = C.cream;
const RULE = C.rule;
export { SERIF, SANS } from './pdartTokens';

export const theme = createTheme({
  palette: {
    primary: { main: NAVY, dark: C.navyDark },
    secondary: { main: GOLD, light: C.goldLight },
    success: { main: GREEN },
    warning: { main: C.warnText },
    error: { main: C.alertRed },
    background: { default: C.canvas, paper: C.white },
    text: { primary: C.ink, secondary: C.muted },
    divider: RULE,
  },
  typography: {
    fontFamily: SANS,
    h1: { fontFamily: SERIF, fontWeight: 400, color: '#000', fontSize: '2.25rem', letterSpacing: '-1px' },
    h2: { fontFamily: SERIF, fontWeight: 400, color: '#000', fontSize: '1.625rem', letterSpacing: '-.5px' },
    h3: { fontFamily: SERIF, fontWeight: 700, color: NAVY, fontSize: '1.375rem' },
    h4: { fontFamily: SERIF, fontWeight: 700, color: NAVY, fontSize: '1.2rem' },
    h5: { fontFamily: SERIF, fontWeight: 700, color: NAVY, fontSize: '1.1rem' },
    h6: { fontFamily: SERIF, fontWeight: 700, color: NAVY, fontSize: '1rem' },
    subtitle1: { fontWeight: 600 },
    subtitle2: { fontWeight: 700, letterSpacing: '.02em' },
    body1: { fontSize: '0.95rem', lineHeight: 1.5 },
    body2: { fontSize: '0.875rem', lineHeight: 1.5 },
    button: { textTransform: 'none', fontWeight: 700 },
  },
  shape: { borderRadius: RADIUS.md },   // rounded corners (md = 8px) — the new pdart-theme
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        ':focus-visible': { outline: `2px solid ${C.orange}`, outlineOffset: '2px' },   // PwC orange focus ring
        '@media (prefers-reduced-motion: reduce)': {
          '*, *::before, *::after': { transition: 'none !important', animation: 'none !important' },
        },
      },
    },
    // cards: 1px rule border + a soft shadow (not flat, not heavy)
    MuiPaper: { styleOverrides: { root: { border: `1px solid ${RULE}`, boxShadow: SHADOW.sm, backgroundImage: 'none' } },
      defaultProps: { elevation: 0 } },
    // contained buttons stay PwC charcoal + white (pages set their own bg on some buttons — a theme text-colour override
    // would collide with those); the soft-orange pwc.com CTA is applied explicitly where wanted (login, Run).
    MuiButton: { styleOverrides: { root: { textTransform: 'none', fontWeight: 700, borderRadius: RADIUS.sm } } },
    // clean data-table header: WHITE bg + GRAY UPPERCASE labels + thin dividers (reference table format)
    MuiTableHead: {
      styleOverrides: {
        root: {
          backgroundColor: C.headBg,
          '& .MuiTableCell-root, & .MuiTableCell-head': {
            color: C.muted, fontWeight: 700, fontFamily: SANS, fontSize: 11, letterSpacing: '.04em',
            textTransform: 'uppercase', borderBottom: `1px solid ${RULE}`, whiteSpace: 'nowrap', lineHeight: 1.35,
          },
        },
      },
    },
    MuiTableCell: { styleOverrides: {
      root: { borderBottom: `1px solid ${C.rowLine}`, fontFamily: SANS, fontSize: 13, color: C.ink },
      head: { backgroundColor: C.headBg, color: C.muted } } },
    MuiTableContainer: { styleOverrides: { root: { border: `1px solid ${RULE}`, borderRadius: RADIUS.md, backgroundColor: C.white } } },
    MuiTab: { styleOverrides: { root: { textTransform: 'none', fontWeight: 600, fontFamily: SANS,
      '&.Mui-selected': { color: NAVY } } } },
    MuiTabs: { styleOverrides: { indicator: { backgroundColor: C.orange, height: 3 } } },
    // chips read as small pills (the pdart badge shape)
    MuiChip: { styleOverrides: { root: { fontWeight: 700, fontSize: 11, letterSpacing: '.02em', fontFamily: SANS, borderRadius: 999 },
      colorPrimary: { backgroundColor: NAVY }, colorSuccess: { backgroundColor: C.successLight, color: GREEN } } },
    MuiAppBar: { styleOverrides: { root: { backgroundColor: NAVY, color: '#fff', boxShadow: 'none' } } },
    MuiTextField: { styleOverrides: { root: { '& .MuiOutlinedInput-root': { '&:hover fieldset': { borderColor: NAVY }, '&.Mui-focused fieldset': { borderColor: C.orange } } } } },
    MuiLinearProgress: { styleOverrides: { bar: { backgroundColor: C.orange } } },
  },
});

/** Status tint-pairs — pale bg + saturated fg (re-exported from tokens for MUI pages). */
export { status, tierTone, fillTone } from './pdartTokens';
