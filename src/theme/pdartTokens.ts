/* =====================================================================
   P-DART visual theme — TypeScript tokens (skill: pdart-theme)
   Single source of truth for inline-styled pages (EvalPage, MastersPage,
   StoryPage, …). MUI pages get the identical values via theme/muiTheme.ts.
   Mirrors html/tokens.css — keep them in sync.
   ===================================================================== */

export const C = {
  // ── structure (reference palette — navy #10365A + warm neutrals) ──
  navy: '#10365A', navyDark: '#0C1D33',
  gold: '#D98A00', goldLight: '#FDD666',            // "golden" now the palette amber
  cream: '#F4F3F1', panelBg: '#EDEBE6', white: '#FFFFFF',
  canvas: '#F5F5F5',                                 // page background — white cards pop on this gray
  ink: '#1C1C1C', slate: '#1C1C1C', muted: '#7A756D',
  rule: '#E5E2DB', border: '#E5E2DB', rowLine: '#EFEEEB', headBg: '#F1F1F0',   // rowLine=divider · headBg=faint-grey table header
  // ── semantic ───────────────────────────────────────────────
  success: '#21A366', green: '#21A366', successLight: '#E7F3E7', greenP: '#E7F3E7',
  warnText: '#D98A00', amber: '#D98A00', warnLight: '#FBF4E1', amberP: '#FBF4E1',   // soft warm amber (was harsh #FEF3C7)
  alertRed: '#DC2C25', red: '#DC2C25', redP: '#FBEAEA',
  // ── dashboard reference palette (from the OFR dashboard — the color + font reference) ──
  pepsiRed: '#DC2C25', crimson: '#DC2C25', amberBright: '#D98A00', orange: '#D98A00',
  deepRed: '#DC2C25', teal: '#21A366',
  inkWarm: '#1C1C1C', mutedWarm: '#7A756D', pageWarm: '#F4F3F1', track: '#EDEBE6', allocGray: '#726E68',
  // ── back-compat aliases (old pdart-ui keys → new theme) ─────
  navyP: '#F4F3F1',   // navy/neutral callouts now read as warm panels
  grayP: '#EDEBE6',   // neutral panel → panelBg
  codeBg: '#0F1E33',  // dark "show-your-work" block
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
