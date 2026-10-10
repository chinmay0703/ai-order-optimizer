import { Fragment, useEffect, useMemo, useState } from 'react';
import { Box, Collapse, Dialog, IconButton, Stack, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import CloseIcon from '@mui/icons-material/Close';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { useOeParams, pct } from '../../shared/OeParams';
import { downloadXlsxMulti, ExportXlsxButton } from '../../shared/exportXlsx';
import { isTracked, trackedRowSxFor, TRACK_STAR } from '../../demo';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';

// small inline chip style for the "Used as" column (filler / sub / original)
const usedTag = (bg: string, fg: string) => ({ fontSize: 10, fontWeight: 800, letterSpacing: '.02em', px: 0.7, py: 0.2,
  borderRadius: '5px', bgcolor: bg, color: fg, fontFamily: MONO, whiteSpace: 'nowrap' as const, display: 'inline-block' });
// parse a "<reg-zsku>:qty; …" donor string into [reg-zsku, qty] pairs — the reg-zsku whose MATERIAL is lent, and how much.
const parseDonors = (s: string | undefined): [string, number][] =>
  (s || '').split(';').map((p) => { const [z, q] = p.split(':').map((x) => x.trim()); return [z, Number(q) || 0] as [string, number]; })
    .filter(([z]) => z);

/* ---------------------------------------------------------------------------
   Cluster Primary — the POST-CASCADE transshipment cluster primary-truck pass.
   After every channel run, each cluster's DBs are combined ACROSS channels; the load ships on
   the FEWEST primary trucks that hold it with EACH ≥65% of cap. When it can't split into
   all-≥65% trucks, the <65% remainder is trimmed CROSS-DB and TRUCK-AWARE — every DB×reg-zsku in
   the cluster pooled and cut ALL fillers → ALL subs → ALL originals (each by S/N = SOH÷norm,
   least-needy first), taking the cases off the secondary truck(s) each reg-zsku actually rides on,
   every truck stopping at its 65% floor (the pre-built sec trucks are NEVER rebuilt); if the floors
   block the full trim, the leftover ships as a partial primary truck. A cluster that can't fill even
   ONE primary truck to 65% is DROPPED WHOLE (CLUSTER_DROP_<65%). Expand a DB to see the full
   "show your work": its secondary trucks BEFORE→AFTER and every reg-zsku ranked by S/N with the
   filler→sub→original cut + which truck each rides on. Live from /api/v1/cluster_primary — no client math.
--------------------------------------------------------------------------- */
interface TruckBA { truck_no: number; planned: number; shipped: number; planned_fill: number; fill: number; }
interface CalcRow {
  reg_zsku: string; stock: number; allocated_before: number; norm: number; sn_ratio: number | null; sn_rank: number;
  filler_before: number; sub_before: number; orig_before: number;
  cut_total: number; cut_filler: number; cut_sub: number; cut_orig: number; allocated_after: number;
  trucks_on?: string; cut_by_truck?: string;   // "truck_no:cases; …" — which sec truck(s) it rides + cases cut off each
  filler_donors?: string; sub_donors?: string; // "<reg-zsku>:qty; …" — reg-zsku(s) whose material is used AS this filler / sub
}
interface Member {
  db: string; channel: string; soq: number; shipped_before: number; trimmed: number; shipped_after: number;
  combined_stock: number; combined_original: number; combined_norm: number; sn_ratio: number | null;
  trucks: TruckBA[]; trim_calc: CalcRow[];
}
interface TrimRow extends CalcRow { db: string; }   // a cross-DB trim line = a CalcRow that also carries its DB
interface TruckBuild {   // the Step-3 65% truck-build math, engine-served (no client math)
  cap: number; keep: number; max65: number; minhold: number; n_ship: number; shipped: number; trim: number;
  fills: { cases: number; pct: number }[];
}
interface Cluster {
  cfa: string; cluster_code: string; primary_max: number; cluster_load: number;
  primary_trucks: number; trim_total: number; status: string; n_dbs: number; members: Member[];
  trim_rows: TrimRow[];   // ONE cross-DB list for the whole cluster (every DB×reg-zsku), cut filler→sub→original
  truck_build: TruckBuild;
}
interface Payload { date?: string; clusters: Cluster[]; }

const nf = (n: number) => Math.round(Number(n) || 0).toLocaleString();
const num = { textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums', fontFamily: MONO, fontSize: 12.5, whiteSpace: 'nowrap' as const };
const fillClr = (p: number, keepPct: number, targetPct: number) => (p >= targetPct ? C.success : p >= keepPct ? C.warnText : '#A32020');

// "1:83; 2:14" -> { 1: 83, 2: 14 } — the per-secondary-truck breakdown the backend records for each reg-zsku
const parseTrucks = (s?: string): Record<number, number> => {
  const out: Record<number, number> = {};
  (s || '').split(';').forEach((p) => { const [t, c] = p.split(':').map((x) => x.trim()); if (t) out[Number(t)] = Number(c) || 0; });
  return out;
};

// which secondary truck(s) a reg-zsku rides on + the cases the trim cut off each — one chip per truck. Shows the
// truck number, how many cases WERE on that truck (before the trim = remaining + cut), and, in red, the cut.
function TruckChips({ on, cut }: { on?: string; cut?: string }) {
  const onm = parseTrucks(on), cutm = parseTrucks(cut);
  const trucks = Array.from(new Set([...Object.keys(onm), ...Object.keys(cutm)].map(Number))).sort((a, b) => a - b);
  if (!trucks.length) return <span style={{ color: C.muted }}>—</span>;
  return (
    <Box sx={{ display: 'flex', gap: 0.4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {trucks.map((t) => (
        <Box key={t} sx={{ px: 0.65, py: 0.15, borderRadius: `${RADIUS.sm}px`, border: `1px solid ${cutm[t] ? '#E7C6C0' : C.rule}`, bgcolor: cutm[t] ? '#FDEFE6' : '#F4EFEC', fontFamily: MONO, fontSize: 11, whiteSpace: 'nowrap' }}>
          <b style={{ color: C.navy }}>T{t}</b>·{(onm[t] ?? 0) + (cutm[t] ?? 0)}{cutm[t] ? <span style={{ color: '#A32020', fontWeight: 800 }}> −{cutm[t]}</span> : ''}
        </Box>
      ))}
    </Box>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) => {
  const P = useOeParams();
  const [helpOpen, setHelpOpen] = useState(false);   // the "how it works" help modal (was the big PageIntro block)
  return (
  <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
    <Box sx={{ maxWidth: 1320, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
      <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>
        Transshipment · cluster primary truck
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: '6px 0 8px' }}>
          Cluster Primary — combine → fewest ≥{pct(P.TRUCK_KEEP_PCT)} trucks (Step-3 rule) → cross-DB trim
        </Box>
        <IconButton size="small" onClick={() => setHelpOpen(true)} title="How this page works"
          sx={{ color: C.gold, border: `1px solid ${C.goldLight}`, bgcolor: '#FCF4EE', '&:hover': { bgcolor: '#FBE8DC', borderColor: C.gold } }}>
          <HelpOutlineIcon sx={{ fontSize: 19 }} />
        </IconButton>
        <Box component="span" sx={{ fontSize: 11.5, color: C.muted }}>how it works</Box>
      </Box>
      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: `${RADIUS.md}px`, overflow: 'hidden', border: `1px solid ${C.goldLight}` } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2.5, py: 1.5, background: 'linear-gradient(135deg, #EB8C00 0%, #D04A02 55%, #B33F02 100%)', borderBottom: '1px solid rgba(0,0,0,0.10)', color: '#fff' }}>
          <HelpOutlineIcon sx={{ fontSize: 20 }} />
          <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 17 }}>How this page works</Box>
          <Box sx={{ flex: 1 }} />
          <IconButton onClick={() => setHelpOpen(false)} size="small" aria-label="close" sx={{ color: '#fff', '&:hover': { bgcolor: 'rgba(255,255,255,0.18)' } }}><CloseIcon sx={{ fontSize: 20 }} /></IconButton>
        </Box>
        <Box sx={{ p: 2.75, color: C.slate, bgcolor: '#FCF7F4', display: 'flex', flexDirection: 'column', gap: 2.75 }}>
          {/* the goal */}
          <Box sx={{ p: '10px 12px', borderRadius: `${RADIUS.sm}px`, bgcolor: '#FCF4EE', border: `1px solid ${C.goldLight}`, borderLeft: `3px solid ${C.gold}` }}>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.gold, mb: 0.4 }}>🎯 The goal</Box>
            <Box sx={{ fontSize: 13, lineHeight: 1.55 }}>Combine each transshipment cluster's DBs <b>across channels</b> and ship them on the <b>fewest primary trucks</b> — each one <b>≥{pct(P.TRUCK_KEEP_PCT)} of cap</b>.</Box>
          </Box>

          {/* when it runs */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.7 }}>When it runs</Box>
            <Box sx={{ fontSize: 12.5, lineHeight: 1.55 }}>Once, <b>after every channel run</b> — a cluster's DBs finish in different channels, so the combine can only happen here.</Box>
          </Box>

          {/* per cluster — 3 moves */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.7 }}>Per cluster · 3 moves</Box>
            {([
              ['1', 'Combine', <>the DBs' <b>shipped cases across channels</b> into one cluster load</>, C.navy],
              ['2', 'Fewest trucks', <>the <b>fewest primary trucks</b> that are EACH ≥{pct(P.TRUCK_KEEP_PCT)} of cap — the <b>same rule as Step 3</b></>, C.gold],
              ['3', 'Balance & trim', <><b>balance the load</b> across them (each ≥{pct(P.TRUCK_KEEP_PCT)}) and <b>trim the overflow</b> — e.g. 120 / cap 100 → 1 full + trim 20; 130 → 2 @65; 50 → whole cluster dropped</>, C.success],
            ] as const).map(([n, t, d, col]) => (
              <Box key={n} sx={{ display: 'flex', gap: 1, mb: 0.85 }}>
                <Box sx={{ flexShrink: 0, width: 20, height: 20, borderRadius: '50%', bgcolor: col, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, mt: 0.1 }}>{n}</Box>
                <Box sx={{ fontSize: 12.5, lineHeight: 1.5 }}><b style={{ color: col }}>{t}</b> — {d}</Box>
              </Box>
            ))}
            <Box sx={{ p: '9px 11px', borderRadius: `${RADIUS.sm}px`, bgcolor: '#fff', border: `1px solid ${C.rule}` }}>
              <Box sx={{ fontFamily: MONO, fontSize: 12, color: C.slate }}>n = min( ⌊load ÷ {P.TRUCK_KEEP_PCT}·cap⌋ , ⌈load ÷ cap⌉ )</Box>
              <Box sx={{ fontSize: 11, color: C.muted, mt: 0.4 }}>the count of primary trucks the cluster ships on.</Box>
            </Box>
          </Box>

          {/* the trim */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.5 }}>The trim · cross-DB &amp; truck-aware</Box>
            <Box sx={{ fontSize: 12.5, lineHeight: 1.55, mb: 0.7 }}>Pool <b>every DB×reg-zsku</b> in the cluster and cut in this order:</Box>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 0.9 }}>
              {([['1 · ALL fillers', C.success], ['2 · ALL subs', C.gold], ['3 · ALL originals', C.navy]] as const).map(([lab, col]) => (
                <Box key={lab} component="span" sx={{ px: 0.85, py: '3px', borderRadius: 999, border: `1px solid ${col}`, color: col, fontSize: 11, fontWeight: 700 }}>{lab}</Box>
              ))}
            </Box>
            <Box sx={{ fontSize: 12.5, lineHeight: 1.55, mb: 0.7 }}>Within each group: <b>only-filler / only-sub donor lines first</b>, then by <b>S/N (SOH ÷ norm), least-needy first</b>.</Box>
            <Box sx={{ p: '9px 11px', mb: 1, borderRadius: `${RADIUS.sm}px`, bgcolor: '#fff', border: `1px solid ${C.rule}` }}>
              <Box sx={{ fontFamily: MONO, fontSize: 12, color: C.slate }}>S/N = SOH ÷ norm&nbsp;&nbsp;(on-hand stock ÷ norm)</Box>
            </Box>
            <Box sx={{ fontSize: 12.5, lineHeight: 1.55, mb: 0.9 }}>Cases come off the <b>secondary truck(s) each reg-zsku actually rides on</b> — every truck <b>stops at its {pct(P.TRUCK_KEEP_PCT)} floor</b> and the pre-built secondary trucks are <b>never rebuilt</b> (none drops below {pct(P.TRUCK_KEEP_PCT)}).</Box>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              <Box component="span" sx={{ px: 0.85, py: '3px', borderRadius: 999, border: `1px solid ${C.warnText}`, color: C.warnText, fontSize: 11, fontWeight: 700 }}>≥1 truck, floors block the trim → leftover ships as a PARTIAL primary truck</Box>
              <Box component="span" sx={{ px: 0.85, py: '3px', borderRadius: 999, border: `1px solid ${C.alertRed}`, color: C.alertRed, fontSize: 11, fontWeight: 700 }}>can&apos;t fill even ONE ≥{pct(P.TRUCK_KEEP_PCT)} primary truck → whole cluster DROPPED</Box>
            </Box>
          </Box>

          {/* the two ways a cluster is dropped */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.6 }}>A cluster is dropped in two cases</Box>
            {([
              ['1', 'Too few distributors', <><b>earlier</b>, at the demand gate — a cluster with <b>&lt;2 distributors</b> kept in the run can&apos;t transship, so its lone DB is dropped (see the Filtered SOQ page)</>, C.alertRed],
              ['2', `Can't fill one ≥${pct(P.TRUCK_KEEP_PCT)} truck`, <><b>here</b> — the combined load can&apos;t fill even ONE primary truck to {pct(P.TRUCK_KEEP_PCT)}, so the whole cluster is dropped (CLUSTER_DROP_&lt;{pct(P.TRUCK_KEEP_PCT)})</>, C.alertRed],
            ] as const).map(([n, t, d, col], i, arr) => (
              <Box key={n} sx={{ display: 'flex', gap: 1, mb: i < arr.length - 1 ? 0.7 : 0 }}>
                <Box sx={{ flexShrink: 0, width: 20, height: 20, borderRadius: '50%', bgcolor: col, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, mt: 0.1 }}>{n}</Box>
                <Box sx={{ fontSize: 12.5, lineHeight: 1.5 }}><b style={{ color: col }}>{t}</b> — {d}</Box>
              </Box>
            ))}
            <Box sx={{ fontSize: 11, color: C.muted, mt: 0.5 }}>Gate 1 removes singleton clusters BEFORE the cascade, so every cluster reaching this page already has ≥2 distributors — case 2 is the only drop you see here.</Box>
          </Box>

          <Box sx={{ pt: 1, borderTop: `1px solid ${C.rule}`, fontSize: 11, color: C.muted }}><b style={{ color: C.slate }}>Expand a DB</b> to see its secondary trucks before→after and each reg-zsku's truck placement + where its cut came from — live from the engine, nothing recomputed.</Box>
        </Box>
      </Dialog>
      {children}
    </Box>
  </Box>
  );
};

const Arrow = () => <Box sx={{ color: C.muted, fontWeight: 800, px: 0.25 }}>→</Box>;
const Calc = ({ label, val, fg, big }: { label: string; val: string; fg: string; big?: boolean }) => (
  <Box sx={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.15 }}>
    <Box sx={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.muted, fontFamily: SANS }}>{label}</Box>
    <Box sx={{ fontWeight: 800, fontSize: big ? 18 : 13.5, color: fg }}>{val}</Box>
  </Box>
);

// OWNER-centric trim view. The cluster trim removes FILLERS first, then SUBSTITUTES, then ORIGINALS — where "filler" /
// "substitute" mean the reg-zsku whose MATERIAL is used as that filler / sub (the provider), NOT the demand line that
// received it. The engine already removes exactly this material in this order; it just records each filler / sub against
// the receiving demand line. So we attribute each received filler / sub (and its CUT) back onto the PROVIDER reg-zsku
// (from the "<rz>:qty" donor strings); original stays on the reg-zsku's own row. Cluster totals are preserved — only the
// per-row split moves. Returned in the real cut sequence: used-as-filler → used-as-sub → original (the ONE order in
// domain.calculations.cluster_trim._seq_rank), cut rows first, least-needy (highest S/N) within each tier.
function ownerTrimRows<T extends CalcRow>(rows: T[]) {
  const subLent = new Map<string, number>(), filLent = new Map<string, number>();
  const subLentCut = new Map<string, number>(), filLentCut = new Map<string, number>();
  const bump = (m: Map<string, number>, z: string, v: number) => m.set(z, (m.get(z) || 0) + v);
  for (const r of rows) {
    const subs = parseDonors(r.sub_donors), fils = parseDonors(r.filler_donors);
    const subTot = subs.reduce((a, [, q]) => a + q, 0), filTot = fils.reduce((a, [, q]) => a + q, 0);
    subs.forEach(([z, q]) => { bump(subLent, z, q); if (r.cut_sub > 0 && subTot > 0) bump(subLentCut, z, r.cut_sub * (q / subTot)); });
    fils.forEach(([z, q]) => { bump(filLent, z, q); if (r.cut_filler > 0 && filTot > 0) bump(filLentCut, z, r.cut_filler * (q / filTot)); });
  }
  const orows = rows.map((r) => {
    const asFil = filLent.get(r.reg_zsku) || 0, asSub = subLent.get(r.reg_zsku) || 0, asOrg = r.orig_before;
    const cutFil = Math.round(filLentCut.get(r.reg_zsku) || 0), cutSub = Math.round(subLentCut.get(r.reg_zsku) || 0), cutOrg = r.cut_orig;
    const material = asOrg + asSub + asFil, cutTot = cutOrg + cutSub + cutFil;
    return { r, asFil, asSub, asOrg, cutFil, cutSub, cutOrg, material, cutTot, after: material - cutTot };
  });
  const rank = (o: typeof orows[number]) => {
    const hf = o.asFil > 0, hs = o.asSub > 0, ho = o.asOrg > 0;
    if (hf && !hs && !ho) return 0;   // only used as filler — most expendable
    if (hs && !hf && !ho) return 1;   // only used as substitute
    if (hf) return 2;                 // used as filler (+ own original)
    if (hs) return 3;                 // used as substitute (no filler)
    return 4;                         // its own original only — real demand, last
  };
  return orows.sort((a, b) =>
    ((a.cutTot > 0 ? 0 : 1) - (b.cutTot > 0 ? 0 : 1)) ||   // cut rows first, untouched rows at the bottom
    (rank(a) - rank(b)) || ((b.r.sn_ratio ?? -1) - (a.r.sn_ratio ?? -1)));
}

// per-trimmed-DB drilldown: secondary trucks before→after + the S/N ranking that decided the cut
function DbDrill({ m, keepPct, targetPct }: { m: Member; keepPct: number; targetPct: number }) {
  const P = useOeParams();
  const descOf = useRegZskuDesc();
  return (
    <Box sx={{ px: 2, py: 1.5, bgcolor: '#FBF9F7', borderTop: `1px dashed ${C.rule}` }}>
      {/* secondary trucks: planned (before) → shipped (after) */}
      {m.trucks.length > 0 && (
        <>
          <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.6 }}>
            Secondary trucks · before (planned) → after (shipped)
          </Box>
          <Box sx={{ display: 'flex', gap: 0.6, flexWrap: 'wrap', mb: 1.5 }}>
            {m.trucks.map((t) => {
              const cut = t.planned !== t.shipped;
              return (
                <Box key={t.truck_no} sx={{ px: 1.1, py: 0.6, borderRadius: `${RADIUS.sm}px`, border: `1px solid ${cut ? '#E7C6C0' : C.rule}`, bgcolor: cut ? '#FDF4EE' : '#fff', ...num, textAlign: 'left', fontSize: 12 }}>
                  <b>Truck {t.truck_no}</b> · {t.planned}
                  <Box component="span" sx={{ color: fillClr(t.planned_fill, keepPct, targetPct) }}> ({t.planned_fill}%)</Box>
                  {cut ? <>
                    <Box component="span" sx={{ color: C.muted }}> → </Box>
                    <b style={{ color: C.slate }}>{t.shipped}</b>
                    <Box component="span" sx={{ color: fillClr(t.fill, keepPct, targetPct) }}> ({t.fill}%)</Box>
                  </> : <Box component="span" sx={{ color: C.muted }}> · unchanged</Box>}
                </Box>
              );
            })}
            <Box sx={{ alignSelf: 'center', fontSize: 11.5, color: C.success, ml: 0.5 }}>
              the cut is taken off the trucks each reg-zsku <b>actually rides on</b> — every truck <b>stops at its {pct(P.TRUCK_KEEP_PCT)} floor</b>,
              so none is rebuilt or dropped below {pct(P.TRUCK_KEEP_PCT)} (only when a cluster can't be trimmed enough does the leftover ship as a partial primary truck).
            </Box>
          </Box>
        </>
      )}
      {/* the S/N ranking that chose which reg-zskus to cut */}
      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.warnText, mb: 0.4 }}>
        This DB's slice of the cross-DB trim · its reg-zskus ranked by S/N = SOH ÷ norm (on-hand stock, least needy)
      </Box>
      <Box sx={{ overflowX: 'auto', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px` }}>
        <Table size="small" sx={{ minWidth: 'max-content' }}>
          <TableHead><TableRow>
            {['S/N rk', 'Reg-ZSKU', 'Description', 'Used as', 'Stock', 'Material', 'Norm', 'S/N', 'Cut total', 'As filler', 'As substitute', 'As original', 'On truck(s) · cut', 'Before → After'].map((h, i) =>
              <TableCell key={h} align={i <= 3 ? 'left' : 'right'} sx={{ fontFamily: SANS, whiteSpace: 'nowrap', fontSize: 11 }}>{h}</TableCell>)}
          </TableRow></TableHead>
          <TableBody>
            {ownerTrimRows(m.trim_calc).map((o) => {
              const r = o.r;
              const cut = o.cutTot > 0;
              return (
                <TableRow key={r.reg_zsku} sx={{ bgcolor: cut ? '#FDEFE6' : undefined }}>
                  <TableCell sx={{ ...num, textAlign: 'left', color: cut ? C.warnText : C.muted, fontWeight: cut ? 800 : 400 }}>{r.sn_rank}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: C.navy, fontWeight: cut ? 800 : 600 }}>{r.reg_zsku}</TableCell>
                  <TableCell sx={{ whiteSpace: 'normal' }} title={descOf(r.reg_zsku)}>{descOf(r.reg_zsku) || '—'}</TableCell>
                  <TableCell>
                    {(o.asOrg === 0 && o.asSub === 0 && o.asFil === 0)
                      ? <Box component="span" sx={{ color: C.muted }}>—</Box>
                      : (
                        <Box sx={{ display: 'flex', gap: 0.4, flexWrap: 'wrap' }}>
                          {o.asOrg > 0 && <Box component="span" sx={usedTag('#EEEEEE', '#2D2D2D')}>original</Box>}
                          {o.asSub > 0 && <Box component="span" sx={usedTag('#E6F3EC', '#1E8E5A')}>substitute · {nf(o.asSub)}</Box>}
                          {o.asFil > 0 && <Box component="span" sx={usedTag('#FDEDE3', '#D04A02')}>filler · {nf(o.asFil)}</Box>}
                        </Box>
                      )}
                  </TableCell>
                  <TableCell sx={{ ...num, color: C.muted }}>{nf(r.stock)}</TableCell>
                  <TableCell sx={{ ...num, color: C.slate }} title="cases of THIS reg-zsku's material shipped — its own demand (original) + what it lends as substitute / filler">{nf(o.material)}</TableCell>
                  <TableCell sx={{ ...num, color: C.muted }}>{nf(r.norm)}</TableCell>
                  <TableCell sx={{ ...num, fontWeight: 800, color: cut ? C.warnText : C.slate }} title={`SOH ${Math.max(r.stock, 1)} ÷ norm ${r.norm}`}>{r.sn_ratio != null ? r.sn_ratio.toFixed(3) : '∞'}</TableCell>
                  <TableCell sx={{ ...num, fontWeight: 800, color: cut ? '#A32020' : C.muted }}>{cut ? `− ${nf(o.cutTot)}` : '—'}</TableCell>
                  <TableCell sx={num}>{o.asFil === 0 ? <span style={{ color: C.muted }}>0</span> : <b style={{ color: C.slate }}>{nf(o.asFil)}</b>}{o.cutFil > 0 && <span style={{ color: '#A32020', fontWeight: 800 }}> −{nf(o.cutFil)}</span>}</TableCell>
                  <TableCell sx={num}>{o.asSub === 0 ? <span style={{ color: C.muted }}>0</span> : <b style={{ color: C.slate }}>{nf(o.asSub)}</b>}{o.cutSub > 0 && <span style={{ color: '#A32020', fontWeight: 800 }}> −{nf(o.cutSub)}</span>}</TableCell>
                  <TableCell sx={num}>{o.asOrg === 0 ? <span style={{ color: C.muted }}>0</span> : <b style={{ color: C.slate }}>{nf(o.asOrg)}</b>}{o.cutOrg > 0 && <span style={{ color: '#A32020', fontWeight: 800 }}> −{nf(o.cutOrg)}</span>}</TableCell>
                  <TableCell sx={num}><TruckChips on={r.trucks_on} cut={r.cut_by_truck} /></TableCell>
                  <TableCell sx={{ ...num, color: cut ? C.slate : C.muted }}>{cut ? <><b>{nf(o.material)}</b> → <b style={{ color: C.success }}>{nf(o.after)}</b></> : nf(o.after)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>
      <Box sx={{ fontSize: 11, color: C.muted, mt: 0.6 }}>
        <b>As filler / As substitute / As original</b> = cases of THIS reg-zsku's material used as that role (filler / sub are what it LENT to any DB; original is its own demand); <b>Material</b> = the three summed. <b style={{ color: '#A32020' }}>−X</b> = how much was trimmed. Cut order: <b>reg-zskus used as filler first, then used as substitute, then originals</b>, least-needy (highest S/N) within each.
        <br /><b>On truck(s) · cut</b> = the secondary truck(s) this reg-zsku sits on — <b style={{ color: C.navy }}>T#·cases</b> (how many were on that truck) — and, in <b style={{ color: '#A32020' }}>red</b>, the cases the trim took off it. The cut is taken from the trucks a reg-zsku actually sits on, and <b>each truck stops at its {pct(P.TRUCK_KEEP_PCT)} floor</b> before the cut moves on, so no secondary truck is rebuilt or dropped below {pct(P.TRUCK_KEEP_PCT)}.
      </Box>
    </Box>
  );
}

// CLUSTER-LEVEL cross-DB trim: every DB×reg-zsku in the cluster, in the ACTUAL cut sequence (ALL fillers → ALL subs →
// ALL originals, least-needy S/N first within each group). This IS the new trim basis — no single DB is chosen; the cut
// spans DB×reg-zsku across the whole cluster, bounded by each DB's secondary-truck 65% floor.
function ClusterCrossTrim({ c }: { c: Cluster }) {
  const P = useOeParams();
  const descOf = useRegZskuDesc();
  const ordered = ownerTrimRows(c.trim_rows);   // owner-centric: each filler / sub attributed to the reg-zsku that lent it
  if (!ordered.some((o) => o.cutTot > 0)) return null;         // no trim on this cluster → no cross-DB table
  let cutSeq = 0;
  return (
    <Box sx={{ px: 2, pb: 1.75, borderTop: `1px solid ${C.rule}`, pt: 1.25, bgcolor: '#FBF9F7' }}>
      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.warnText, mb: 0.5 }}>
        Cross-DB trim · every DB×reg-zsku in the cluster, in cut order — the reg-zskus used AS filler → used AS substitute → their own original (least-needy S/N first)
      </Box>
      <Box sx={{ overflowX: 'auto', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px` }}>
        <Table size="small" sx={{ minWidth: 'max-content' }}>
          <TableHead><TableRow>
            {['Cut #', 'DB', 'Reg-ZSKU', 'Description', 'Used as', 'Stock', 'Material', 'Norm', 'S/N', 'Cut total', 'As filler', 'As substitute', 'As original', 'On truck(s) · cut', 'Before → After'].map((h, i) =>
              <TableCell key={h} align={i <= 4 ? 'left' : 'right'} sx={{ fontFamily: SANS, whiteSpace: 'nowrap', fontSize: 11 }}>{h}</TableCell>)}
          </TableRow></TableHead>
          <TableBody>
            {ordered.map((o) => {
              const r = o.r;
              const cut = o.cutTot > 0;
              if (cut) cutSeq += 1;
              return (
                <TableRow key={`${r.db}-${r.reg_zsku}`} sx={{ bgcolor: cut ? '#FDEFE6' : undefined, ...trackedRowSxFor(r.db) }}>
                  <TableCell sx={{ ...num, textAlign: 'left', color: cut ? C.warnText : C.muted, fontWeight: 800 }}>{cut ? cutSeq : '—'}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: C.navy, fontWeight: 700 }}>{isTracked(r.db) ? TRACK_STAR + ' ' : ''}{r.db}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: C.navy, fontWeight: cut ? 800 : 600 }}>{r.reg_zsku}</TableCell>
                  <TableCell sx={{ whiteSpace: 'normal' }} title={descOf(r.reg_zsku)}>{descOf(r.reg_zsku) || '—'}</TableCell>
                  <TableCell>
                    {(o.asOrg === 0 && o.asSub === 0 && o.asFil === 0)
                      ? <Box component="span" sx={{ color: C.muted }}>—</Box>
                      : (
                        <Box sx={{ display: 'flex', gap: 0.4, flexWrap: 'wrap' }}>
                          {o.asOrg > 0 && <Box component="span" sx={usedTag('#EEEEEE', '#2D2D2D')}>original</Box>}
                          {o.asSub > 0 && <Box component="span" sx={usedTag('#E6F3EC', '#1E8E5A')}>substitute · {nf(o.asSub)}</Box>}
                          {o.asFil > 0 && <Box component="span" sx={usedTag('#FDEDE3', '#D04A02')}>filler · {nf(o.asFil)}</Box>}
                        </Box>
                      )}
                  </TableCell>
                  <TableCell sx={{ ...num, color: C.muted }}>{nf(r.stock)}</TableCell>
                  <TableCell sx={{ ...num, color: C.slate }} title="cases of THIS reg-zsku's material shipped in the cluster — its own demand (original) + what it lends as substitute / filler">{nf(o.material)}</TableCell>
                  <TableCell sx={{ ...num, color: C.muted }}>{nf(r.norm)}</TableCell>
                  <TableCell sx={{ ...num, fontWeight: 800, color: cut ? C.warnText : C.slate }} title={`SOH ${Math.max(r.stock, 1)} ÷ norm ${r.norm}`}>{r.sn_ratio != null ? r.sn_ratio.toFixed(3) : '∞'}</TableCell>
                  <TableCell sx={{ ...num, fontWeight: 800, color: cut ? '#A32020' : C.muted }}>{cut ? `− ${nf(o.cutTot)}` : '—'}</TableCell>
                  <TableCell sx={num}>{o.asFil === 0 ? <span style={{ color: C.muted }}>0</span> : <b style={{ color: C.slate }}>{nf(o.asFil)}</b>}{o.cutFil > 0 && <span style={{ color: '#A32020', fontWeight: 800 }}> −{nf(o.cutFil)}</span>}</TableCell>
                  <TableCell sx={num}>{o.asSub === 0 ? <span style={{ color: C.muted }}>0</span> : <b style={{ color: C.slate }}>{nf(o.asSub)}</b>}{o.cutSub > 0 && <span style={{ color: '#A32020', fontWeight: 800 }}> −{nf(o.cutSub)}</span>}</TableCell>
                  <TableCell sx={num}>{o.asOrg === 0 ? <span style={{ color: C.muted }}>0</span> : <b style={{ color: C.slate }}>{nf(o.asOrg)}</b>}{o.cutOrg > 0 && <span style={{ color: '#A32020', fontWeight: 800 }}> −{nf(o.cutOrg)}</span>}</TableCell>
                  <TableCell sx={num}><TruckChips on={r.trucks_on} cut={r.cut_by_truck} /></TableCell>
                  <TableCell sx={{ ...num, color: cut ? C.slate : C.muted }}>{cut ? <><b>{nf(o.material)}</b> → <b style={{ color: C.success }}>{nf(o.after)}</b></> : nf(o.after)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>
      <Box sx={{ fontSize: 11, color: C.muted, mt: 0.6 }}>
        <b>Cut #</b> = the order cases were removed across the cluster. Every row is shown from the <b>material-owner's</b> side: <b>As filler</b> / <b>As substitute</b>
        are the cases of THIS reg-zsku's material lent to fill a truck / stand in for another reg-zsku (not what it received), and <b>As original</b> is its own demand;
        <b>Material</b> = the three summed. The cut spans <b>DB×reg-zsku</b>: ALL reg-zskus used as filler first (any DB), then all used as substitute, then all originals —
        within each group the <b>only-filler / only-sub lines first</b>, then least-needy (highest S/N). <b>On truck(s) · cut</b> shows which secondary truck(s) each
        reg-zsku sits on (<b style={{ color: C.navy }}>T#·cases</b> = cases that were on that truck) and, in <b style={{ color: '#A32020' }}>red</b>, the cases taken
        off each — the cut comes off the truck a reg-zsku actually sits on and <b>each truck stops at its {pct(P.TRUCK_KEEP_PCT)} floor</b>,
        so no secondary truck is rebuilt or dropped below {pct(P.TRUCK_KEEP_PCT)}.
      </Box>
    </Box>
  );
}

export default function ClusterPrimaryPage({ date, cfa = '' }: { date?: string; cfa?: string }) {
  const P = useOeParams();   // engine thresholds (oe_parameters) — never hardcode 90 / 65
  const keepPct = P.TRUCK_KEEP_PCT * 100, targetPct = P.TRUCK_FILL_TARGET_PCT * 100;
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from data===null: an empty payload,
  const [err, setErr] = useState<string | null>(null);   // or a failure, would then spin forever
  const [nonce, setNonce] = useState(0);            // bumped by the error Retry to re-run the effect
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null); setLoading(true);
    api.clusterPrimary(date).then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, nonce]);

  const needle = q.trim().toLowerCase();
  const clusters = useMemo(() => (data?.clusters ?? []).filter((c) =>
    (!cfa || String(c.cfa).trim() === cfa) &&        // scope to the GLOBAL header CFA (not a per-page dropdown)
    (!needle || `${c.cfa} ${c.cluster_code} ${c.members.map((m) => m.db).join(' ')}`.toLowerCase().includes(needle))
  ), [data, needle, cfa]);

  const kpi = useMemo(() => {
    let ship = 0, drop = 0, trimmed = 0;
    for (const c of clusters) { (c.primary_trucks > 0 ? ship++ : drop++); trimmed += c.trim_total; }
    return { total: clusters.length, ship, drop, trimmed };
  }, [clusters]);

  const exportRows = () => downloadXlsxMulti('cluster_primary', [
    { name: 'Clusters (per DB)',
      headers: ['CFA', 'Cluster', 'DB', 'Channel', 'SOQ', 'Primary max', 'Combined load', 'Primary trucks', 'Shipped before', 'Trimmed', 'Shipped after', 'Status'],
      rows: clusters.flatMap((c) => c.members.map((m) => [c.cfa, c.cluster_code, m.db, m.channel, m.soq, c.primary_max, c.cluster_load, c.primary_trucks, m.shipped_before, m.trimmed, m.shipped_after, c.status])) },
    { name: 'Trim calc (per reg-zsku)',
      headers: ['CFA', 'Cluster', 'DB', 'Reg-ZSKU', 'S/N rank', 'Stock', 'Allocated before', 'Norm', 'S/N', 'Cut total', 'Cut filler', 'Cut sub', 'Cut orig', 'Allocated after', 'On truck(s)', 'Cut by truck'],
      rows: clusters.flatMap((c) => c.members.flatMap((m) => m.trim_calc.map((t) => [c.cfa, c.cluster_code, m.db, t.reg_zsku, t.sn_rank, t.stock, t.allocated_before, t.norm, t.sn_ratio ?? '', t.cut_total, t.cut_filler, t.cut_sub, t.cut_orig, t.allocated_after, t.trucks_on ?? '', t.cut_by_truck ?? '']))) },
  ]);

  if (err) return <Shell><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (loading) return <Shell><PageSkeleton kpis={4} rows={7} /></Shell>;
  if (!data) return <Shell><EmptyState title="No cluster plan for this run"
    hint="Nothing was returned for this run date. Try another run date, or run the pipeline first." /></Shell>;
  // Loaded, but the run built no clusters at all — an empty payload, not a filtered view (the "No transshipment
  // clusters for this date." line below stays for when the CFA / search filter empties the list).
  if ((data.clusters?.length ?? 0) === 0) return <Shell><EmptyState title="No transshipment clusters in this run"
    hint="This run date produced no cluster primary trucks — either no DB in the run transships, or the pipeline has not run yet." /></Shell>;

  const Kpi = ({ label, val, suffix, fg, bar }: { label: string; val: number; suffix?: string; fg: string; bar: string }) => (
    <Box sx={{ flex: 1, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${bar}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, p: 1.5, bgcolor: C.white }}>
      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted }}>{label}</Box>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 26, color: fg, lineHeight: 1.1 }}>{nf(val)}{suffix}</Box>
    </Box>
  );

  return (
    <Shell>
      <Box sx={{ display: 'flex', gap: 1.5, mb: 2 }}>
        <Kpi label="Clusters" val={kpi.total} fg={C.navy} bar={C.navy} />
        <Kpi label="Shipping (≥1 primary truck)" val={kpi.ship} fg={C.success} bar={C.success} />
        <Kpi label="Nothing to ship" val={kpi.drop} fg={C.alertRed} bar={C.alertRed} />
        <Kpi label="Cases trimmed" val={kpi.trimmed} suffix=" cs" fg={C.warnText} bar={C.gold} />
      </Box>

      <Box sx={{ display: 'flex', gap: 1.25, mb: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <Box sx={{ position: 'relative', flex: 1, minWidth: 240, maxWidth: 420 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by cluster, CFA or DB…"
            style={{ width: '100%', padding: '8px 30px 8px 12px', fontSize: 13, fontFamily: MONO, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm, boxSizing: 'border-box' }} />
          {q && <span onClick={() => setQ('')} title="Clear"
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', color: C.muted, fontWeight: 800, fontSize: 15 }}>×</span>}
        </Box>
        <Box sx={{ flex: 1 }} />
        <ExportXlsxButton label="Export Excel" onClick={exportRows} />
      </Box>
      <Box sx={{ fontSize: 12, color: C.muted, mb: 1 }}>{nf(clusters.length)} clusters{q ? ` matching “${q}”` : ''}{cfa ? ` · CFA ${cfa}` : ''}</Box>

      {clusters.length === 0 && <Box sx={{ color: C.muted, py: 4, textAlign: 'center' }}>No transshipment clusters for this date.</Box>}

      <Stack spacing={2}>
        {clusters.map((c) => {
          const ships = c.primary_trucks > 0;
          return (
            <Box key={`${c.cfa}-${c.cluster_code}`} sx={{ border: `1px solid ${C.rule}`, borderLeft: `4px solid ${ships ? C.success : C.alertRed}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, bgcolor: C.white, overflow: 'hidden' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1.25, borderBottom: `1px solid ${C.rule}`, bgcolor: '#FBF7F4', flexWrap: 'wrap' }}>
                <LocalShippingIcon sx={{ color: ships ? C.success : C.alertRed, fontSize: 20 }} />
                <Box sx={{ fontFamily: MONO, fontWeight: 800, fontSize: 15, color: C.navy }}>{c.cluster_code}</Box>
                <Box sx={{ fontFamily: MONO, fontSize: 12, color: C.muted }}>CFA {c.cfa} · {c.n_dbs} DB{c.n_dbs !== 1 ? 's' : ''}</Box>
                <Box component="span" sx={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 800, color: C.navy, bgcolor: '#F3F3F3', border: `1px solid ${C.rule}`, px: 0.9, py: 0.3, borderRadius: `${RADIUS.sm}px` }}
                  title="the MAX cases one PRIMARY (transshipment) truck can carry — the cap in ⌈load ÷ cap⌉ below">
                  PRIMARY TRUCK CAP · {nf(c.truck_build.cap)} cs
                </Box>
                <Box sx={{ flex: 1 }} />
                <Box component="span" sx={{ px: 1, py: 0.3, borderRadius: 1, fontWeight: 800, fontSize: 11.5, bgcolor: ships ? '#E9F4EC' : '#F8E9E6', color: ships ? C.success : C.alertRed }}>
                  {ships ? `SHIPS ${c.primary_trucks} PRIMARY TRUCK${c.primary_trucks !== 1 ? 'S' : ''}` : 'NOTHING TO SHIP'}
                </Box>
              </Box>
              <Box sx={{ px: 2, py: 1.25 }}>
                {/* STEP-3 65% truck-build math: keep = 65%·cap → ⌊load/keep⌋ (max ≥65%) vs ⌈load/cap⌉ (to hold) → min */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', fontFamily: MONO, fontSize: 13, mb: 0.85 }}>
                  <Calc label="Combined load" val={`${nf(c.cluster_load)} cs`} fg={C.navy} />
                  <Arrow />
                  <Calc label={`keep = ${pct(P.TRUCK_KEEP_PCT)} × cap`} val={`${nf(c.truck_build.keep)} cs`} fg={C.slate} />
                  <Arrow />
                  <Box sx={{ fontSize: 12.5, color: C.slate, whiteSpace: 'nowrap' }} title={`most trucks that each stay ≥${pct(P.TRUCK_KEEP_PCT)} AND fewest that physically hold the load → the min is the fewest-that-are-each-≥${pct(P.TRUCK_KEEP_PCT)}`}>
                    ⌊{nf(c.cluster_load)}÷{nf(c.truck_build.keep)}⌋=<b>{c.truck_build.max65}</b> <span style={{ color: C.muted }}>max≥{pct(P.TRUCK_KEEP_PCT)}</span>{'  '}·{'  '}
                    ⌈{nf(c.cluster_load)}÷{nf(c.truck_build.cap)}⌉=<b>{c.truck_build.minhold}</b> <span style={{ color: C.muted }}>to&nbsp;hold</span>
                  </Box>
                  <Arrow />
                  {c.truck_build.max65 >= 1
                    ? <Calc label="= min → trucks" val={`${c.primary_trucks}`} fg={ships ? C.success : C.alertRed} big />
                    : <Calc label="fits 1 truck → partial" val={`${c.primary_trucks}`} fg={C.warnText} big />}
                  <Box sx={{ flex: 1 }} />
                  <Calc label="trim (overflow)" val={`${nf(c.trim_total)} cs`} fg={c.trim_total > 0 ? C.warnText : C.muted} />
                </Box>
                {/* per-truck BALANCED fills — every truck must be ≥65% (a whole-cluster-<65% partial shown red) */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, flexWrap: 'wrap' }}>
                  <Box sx={{ fontSize: 10.5, fontWeight: 800, color: C.muted, textTransform: 'uppercase', letterSpacing: '.05em', mr: 0.4 }}>Primary trucks (balanced ≥{pct(P.TRUCK_KEEP_PCT)}):</Box>
                  {c.truck_build.fills.map((f, i) => (
                    <Box key={i} sx={{ px: 1, py: 0.35, borderRadius: `${RADIUS.sm}px`, border: `1px solid ${f.pct >= keepPct ? '#BFE3C9' : '#E7C6C0'}`, bgcolor: f.pct >= keepPct ? '#EEF7F0' : '#FDEFE6', fontFamily: MONO, fontSize: 12.5 }}>
                      <b>T{i + 1}</b> · {nf(f.cases)} cs<span style={{ color: fillClr(f.pct, keepPct, targetPct), fontWeight: 800 }}> ({f.pct}%)</span>
                    </Box>
                  ))}
                  {c.truck_build.fills.some((f) => f.pct < keepPct)
                    ? (c.truck_build.max65 === 0
                        ? <Box sx={{ fontSize: 11.5, color: C.alertRed, ml: 0.5 }}>can’t fill even one ≥{pct(P.TRUCK_KEEP_PCT)} primary truck → the <b>whole cluster is DROPPED</b> (no primary truck may ship &lt;{pct(P.TRUCK_KEEP_PCT)}); its load cascades to the next run</Box>
                        : <Box sx={{ fontSize: 11.5, color: C.warnText, ml: 0.5 }}>partial — the sec-floor blocked the full trim, so the overflow ships as a partial truck</Box>)
                    : <Box sx={{ fontSize: 11.5, color: C.success, ml: 0.5 }}>every primary truck ≥{pct(P.TRUCK_KEEP_PCT)} ✓</Box>}
                </Box>
              </Box>
              <Box sx={{ px: 2, pb: 1.5, overflowX: 'auto' }}>
                <Table size="small" sx={{ minWidth: 'max-content' }}>
                  <TableHead><TableRow>
                    {['', 'DB', 'Channel', 'SOQ', 'Comb. Stock', 'Comb. Orig · S1', 'Comb. Norm', '(Stock+Orig)/Norm', 'AOQ · before', 'Trimmed', 'Shipped after'].map((h, i) =>
                      <TableCell key={h || 'exp'} align={i > 2 ? 'right' : 'left'} sx={{ fontFamily: SANS, whiteSpace: 'nowrap' }}>{h}</TableCell>)}
                  </TableRow></TableHead>
                  <TableBody>
                    {c.members.map((m) => {
                      const key = `${c.cfa}-${c.cluster_code}-${m.db}`;
                      const cut = m.trimmed > 0;
                      const expandable = m.trim_calc.length > 0 || m.trucks.length > 0;
                      const isOpen = open[key] ?? false;
                      return (
                        <Fragment key={key}>
                          <TableRow onClick={() => expandable && setOpen((p) => ({ ...p, [key]: !isOpen }))}
                            sx={{ bgcolor: cut ? '#FDF4EE' : undefined, cursor: expandable ? 'pointer' : 'default', '& td': { borderBottom: isOpen ? 'none' : undefined }, ...trackedRowSxFor(m.db) }}>
                            <TableCell sx={{ width: 26, color: C.muted }}>{expandable ? <ChevronRightIcon sx={{ fontSize: 17, transition: 'transform .15s', transform: isOpen ? 'rotate(90deg)' : 'none' }} /> : ''}</TableCell>
                            <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: C.navy, fontWeight: 700 }}>{isTracked(m.db) ? TRACK_STAR + ' ' : ''}{m.db}</TableCell>
                            <TableCell sx={{ fontFamily: MONO, fontSize: 11.5, color: C.muted }}>{m.channel || '—'}</TableCell>
                            <TableCell sx={num} title="Suggested Order Qty (demand)">{nf(m.soq)}</TableCell>
                            <TableCell sx={{ ...num, color: C.slate }} title="Σ DB on-hand stock over the DB's demanded reg-zskus">{nf(m.combined_stock)}</TableCell>
                            <TableCell sx={{ ...num, color: C.slate }} title="Σ Step-1 Original allocated over the DB's demanded reg-zskus">{nf(m.combined_original)}</TableCell>
                            <TableCell sx={{ ...num, color: C.slate }} title="Σ stock-norm over the DB's demanded reg-zskus">{nf(m.combined_norm)}</TableCell>
                            <TableCell sx={{ ...num, color: C.navy, fontWeight: 800 }} title="(combined Stock + combined Step-1 Original) ÷ combined Norm — informational (the trim is now CROSS-DB at the DB×reg-zsku level, no longer DB-selected)">{m.sn_ratio != null ? m.sn_ratio.toFixed(3) : '—'}</TableCell>
                            <TableCell sx={{ ...num, color: C.muted }} title="Combined AOQ on the truck before the primary trim">{nf(m.shipped_before)}</TableCell>
                            <TableCell sx={{ ...num, color: cut ? C.warnText : C.muted, fontWeight: cut ? 800 : 400 }}>{cut ? `− ${nf(m.trimmed)}` : '—'}</TableCell>
                            <TableCell sx={{ ...num, fontWeight: 800, color: m.shipped_after > 0 ? C.success : C.muted }}>{nf(m.shipped_after)}</TableCell>
                          </TableRow>
                          {expandable && (
                            <TableRow>
                              <TableCell colSpan={11} sx={{ p: 0, borderBottom: `1px solid ${C.rule}` }}>
                                <Collapse in={isOpen} unmountOnExit><DbDrill m={m} keepPct={keepPct} targetPct={targetPct} /></Collapse>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </Box>
              <ClusterCrossTrim c={c} />
            </Box>
          );
        })}
      </Stack>

      <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.rule}`, mt: 3, pt: 1, fontSize: 9, color: C.muted }}>
        <span>AI Order Optimizer · Transshipment cluster primary-truck pass · sample data (or_cluster_primary)</span>
        <span>combine across channels → fewest ≥{pct(P.TRUCK_KEEP_PCT)} primary trucks → cross-DB trim (filler→sub→original by S/N), sec-truck {pct(P.TRUCK_KEEP_PCT)} floor</span>
      </Box>
    </Shell>
  );
}
