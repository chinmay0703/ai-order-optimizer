/* =====================================================================
   PwC visual theme — TypeScript tokens
   Single source of truth for inline-styled pages (EvalPage, MastersPage,
   StoryPage, …). MUI pages get the identical values via theme/muiTheme.ts.
   Mirrors html/tokens.css — keep them in sync.
   ===================================================================== */

export const C = {
  // ── PwC palette — taken from pwc.com's live design tokens (--syc-*), 2025 "So You Can" identity ──
  // structure: charcoal ink + black; accent: PwC orange (solid #FD5108 for fills / large type, #CC3D07 for small text)
  navy: '#2D2D2D', navyDark: '#000000',              // (token names kept for back-compat: "navy" = PwC body-text charcoal)
  gold: '#CC3D07', goldLight: '#FFAA72',             // bright PwC orange-red (text-safe accent, 4.6:1 on the canvas) · orange300 (accent on dark)
  orange: '#FD5108', orange50: '#FFF5ED', orange100: '#FFE8D4', orange200: '#FFCDA8', orange300: '#FFAA72',
  orange400: '#FE7C39', orange700: '#CC3D07', orangeGradient: 'linear-gradient(90deg, #FE8303, #FD5108)',
  grey50: '#F5F7F8', grey100: '#EEEFF1', grey200: '#DFE3E6', grey300: '#CBD1D6', grey500: '#A1A8B3', grey700: '#787E8A',
  grey800: '#4C5056', grey900: '#303236',
  tangerine: '#FE7C39', rose: '#D93954', burgundy: '#D02818', maroon: '#602320',   // extended PwC hues for data series
  cream: '#F5F7F8', panelBg: '#EEEFF1', white: '#FFFFFF',
  canvas: '#F5F7F8',                                 // page background — PwC off-white (grey-50) so white cards stand out
  ink: '#2D2D2D', slate: '#2D2D2D', muted: '#5C616A',
  rule: '#DFE3E6', border: '#DFE3E6', rowLine: '#EEEFF1', headBg: '#F5F7F8',   // rowLine=divider · headBg=table header
  // ── semantic (text-safe inks: each ≥ 4.5:1 on white AND on its own tint) ──
  success: '#017E35', green: '#017E35', successLight: '#E6F7EC', greenP: '#E6F7EC',
  warnText: '#8A5A00', amber: '#8A5A00', warnLight: '#FFF6CC', amberP: '#FFF6CC',   // PwC yellow family: dark gold on pale yellow (5.6:1)
  alertRed: '#D02818', red: '#D02818', redP: '#FCEAE8',                              // bright PwC red on a pink tint (4.5:1)
  // ── brand solids (fills, bars, markers, large type — not small text) ──
  brandRed: '#E0301E', crimson: '#E0301E', amberBright: '#FFB600',
  deepRed: '#D02818', teal: '#017E35',
  inkWarm: '#2D2D2D', mutedWarm: '#5C616A', pageWarm: '#F5F7F8', track: '#EEEFF1', allocGray: '#5C616A',
  // ── back-compat aliases ─────
  navyP: '#F5F7F8', grayP: '#EEEFF1', codeBg: '#303236',
};

// PwC typography (pwc.com): ITC Charter serif for headlines, Helvetica Neue for everything else. Both are licensed, so the
// stacks fall back to the closest system fonts (Charter ships with macOS; Georgia / Arial elsewhere) — no web-font download.
export const SERIF = "'ITC Charter', Charter, 'Bitstream Charter', Georgia, 'Times New Roman', serif";
export const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";
export const MONO = "'Consolas', 'JetBrains Mono', ui-monospace, Menlo, monospace";

// Rounded corners + soft shadows (the new theme is no longer sharp/flat)
export const RADIUS = { sm: 4, md: 8, lg: 12 };
export const SHADOW = {
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  md: '0 2px 4px 0 rgb(0 0 0 / 0.06), 0 1px 2px 0 rgb(0 0 0 / 0.04)',
  lg: '0 4px 8px 0 rgb(0 0 0 / 0.08), 0 2px 4px 0 rgb(0 0 0 / 0.04)',
};

/** Status tint-pairs — pale bg + saturated fg, plus a solid marker + hairline border. */
export const status = {
  success: { bg: C.successLight, fg: C.success, solid: C.success, border: C.rule },
  warning: { bg: C.warnLight, fg: C.warnText, solid: C.amberBright, border: C.rule },
  error: { bg: C.redP, fg: C.alertRed, solid: C.alertRed, border: C.rule },
};

/** fill % → tone (>=target good, >=65 warn, else cut). The green gate rounds the fill to the nearest whole % (matches
 *  the backend so_flag: a truck ≥89.5% rounds up to 90 → green/SO). `target` defaults to 90 but callers with the live
 *  oe_parameters value (SO_CREATION_TRUCK_FILL_PCT × 100) should pass it so the gate is never hardcoded. */
export const fillTone = (p: number, target = 90) => (Math.round(p) >= target ? status.success : p >= 65 ? status.warning : status.error);

/** DB tier chips — pale tints on the pdart palette. */
export const tierTone: Record<number, { bg: string; fg: string }> = {
  1: { bg: C.warnLight, fg: C.warnText }, // Platinum — amber
  2: { bg: C.cream, fg: C.navy },         // Gold — navy on cream
  3: { bg: C.successLight, fg: C.success },// Silver — green
  4: { bg: C.panelBg, fg: C.muted },      // Bronze — slate/panel
};
