/* =====================================================================
   PwC visual theme — TypeScript tokens
   Single source of truth for inline-styled pages (EvalPage, MastersPage,
   StoryPage, …). MUI pages get the identical values via theme/muiTheme.ts.
   Mirrors html/tokens.css — keep them in sync.
   ===================================================================== */

export const C = {
  // ── structure — PwC palette: charcoal greys + PwC Orange / Tangerine / Yellow accents ──
  navy: '#2D2D2D', navyDark: '#1A1A1A',              // (token names kept for back-compat: "navy" is now PwC charcoal)
  gold: '#D04A02', goldLight: '#FFB600',             // PwC Orange · PwC Yellow
  tangerine: '#EB8C00', rose: '#D93954', burgundy: '#A32020', maroon: '#602320',
  cream: '#F6F6F6', panelBg: '#EDEDED', white: '#FFFFFF',
  canvas: '#F5F5F5',                                 // page background — white cards pop on this gray
  ink: '#2D2D2D', slate: '#2D2D2D', muted: '#6B6B6B',
  rule: '#DEDEDE', border: '#DEDEDE', rowLine: '#EEEEEE', headBg: '#F2F2F2',   // rowLine=divider · headBg=faint-grey table header
  // ── semantic (text-safe inks: every one ≥ 4.5:1 on white AND on its own pale tint) ──
  success: '#1B7346', green: '#1B7346', successLight: '#E7F3E7', greenP: '#E7F3E7',
  warnText: '#A33A02', amber: '#A33A02', warnLight: '#FBEBE1', amberP: '#FBEBE1',   // dark PwC orange on a peach tint
  alertRed: '#C02A1A', red: '#C02A1A', redP: '#FCEAE8',
  // ── brand solids (fills, bars, markers — not small text) ──
  brandRed: '#E0301E', crimson: '#E0301E', amberBright: '#EB8C00', orange: '#D04A02',
  deepRed: '#A32020', teal: '#1B7346',
  inkWarm: '#2D2D2D', mutedWarm: '#6B6B6B', pageWarm: '#F6F6F6', track: '#EDEDED', allocGray: '#6B6B6B',
  // ── back-compat aliases (old pdart-ui keys → new theme) ─────
  navyP: '#F6F6F6',   // neutral callouts → light panels
  grayP: '#EDEDED',   // neutral panel → panelBg
  codeBg: '#1E1E1E',  // dark "show-your-work" block
};

// Cambria serif heads · Inter body/UI (matches the product's other screens) · Consolas mono
// heading font — now the closest free match to Google Sans (Poppins), with the real Google/Product Sans used where present.
// (token name kept as SERIF for back-compat; it is used everywhere for page/section headings.)
// Headings only — Google Sans (Poppins fallback). Body/UI stays Inter; mono stays Consolas.
export const SERIF = "'Google Sans', 'Product Sans', 'Poppins', 'Segoe UI', system-ui, sans-serif";
export const SANS = "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif";
export const MONO = "'Consolas', 'JetBrains Mono', ui-monospace, monospace";

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
  warning: { bg: C.warnLight, fg: C.warnText, solid: C.gold, border: C.rule },
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
