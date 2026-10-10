// DBs tracked END-TO-END across every screen — for the demo walkthrough. Each is highlighted in its OWN color so
// two distributors (here the SAME name under two channel codes) can be followed side by side. To retrack, edit
// TRACKED_DBS below — every page picks it up via isTracked() (the ★ marker) and trackedSxFor()/trackedRowSxFor()
// (the per-DB color). Nothing is recomputed on the frontend; this is presentation only.
//
// NOTE on run tabs: the Filler/Substitution Sequence + Reservation Runs pages show ONE cascade run at a time.
// The Non-PACE code lives on the Non-PACE run, the Retail code on the Retail run — so on any given run tab you'll
// see whichever tracked DB belongs to that run (CFA×DB and Final Order have no run tabs and show BOTH at once).
export interface Tracked { id: string; name: string; channel: string; bg: string; accent: string; }
// DISABLED — the demo highlight is OFF (empty list), so no DB is colored/starred on any page. isTracked() returns
// false and trackedSxFor()/trackedRowSxFor() return {} everywhere. To re-enable the walkthrough, add entries here:
//   { id: '0000121880', name: '…', channel: 'Non-PACE', bg: '#FFE6A7', accent: '#D98A00' }
export const TRACKED_DBS: Tracked[] = [];

const bare = (s: unknown): string => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '');
// the tracked entry for a db id (zero-padding-agnostic: '0000121880', '121880', 121880 all match), or null
export const trackedOf = (dbid: unknown): Tracked | null =>
  TRACKED_DBS.find((t) => bare(t.id) === bare(dbid)) ?? null;
export const isTracked = (dbid: unknown): boolean => trackedOf(dbid) !== null;

// per-DB highlight for a card/accordion: color tint + a 2px full border + a thick left rail, in that DB's accent
export const trackedSxFor = (dbid: unknown) => {
  const t = trackedOf(dbid);
  return t ? {
    backgroundColor: t.bg,
    border: `2px solid ${t.accent} !important`,
    boxShadow: `inset 5px 0 0 0 ${t.accent}`,
  } : {};
};
// per-DB highlight for a MUI <TableRow>: tint the row AND its cells (a cell bg can override the row) + boxed outline
export const trackedRowSxFor = (dbid: unknown) => {
  const t = trackedOf(dbid);
  return t ? {
    backgroundColor: `${t.bg} !important`,
    boxShadow: `inset 5px 0 0 0 ${t.accent}`,
    '& td': {
      backgroundColor: `${t.bg} !important`,
      borderTop: `2px solid ${t.accent}`,
      borderBottom: `2px solid ${t.accent}`,
    },
  } : {};
};
export const TRACK_STAR = '★';   // prefix the tracked DB's id so it's spottable at a glance
