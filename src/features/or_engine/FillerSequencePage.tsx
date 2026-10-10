import { useEffect, useMemo, useState } from 'react';
import {
  Box, Chip, Collapse, Dialog, Drawer, IconButton, MenuItem, Select, Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { downloadXlsx, ExportXlsxButton } from '../../shared/exportXlsx';
import { useOeParams, pct } from '../../shared/OeParams';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';
import FillerTable from '../../shared/tables/FillerTable';
import { isTracked, trackedSxFor, TRACK_STAR } from '../../demo';
import type { FillerCalc } from '../../types';

// owner-centric "Used as" chip (plain inline style; the Step-3 trim table renders <table>/<td>, not MUI sx).
const usedTag = (bg: string, fg: string) => ({ fontSize: 10, fontWeight: 800 as const, letterSpacing: '.02em',
  padding: '1px 6px', borderRadius: 5, background: bg, color: fg, fontFamily: MONO, whiteSpace: 'nowrap' as const,
  display: 'inline-block' });
// parse a "<reg-zsku>:qty; …" donor string into reg-zsku → Σqty (the amount its material was LENT).
const addDonors = (s: string | undefined, m: Map<string, number>) =>
  (s || '').split(';').forEach((p) => { const [z, q] = p.split(':').map((x) => x.trim()); if (z) m.set(z, (m.get(z) || 0) + (Number(q) || 0)); });
// parse a "<reg-zsku>:qty; …" donor string into [reg-zsku, qty] pairs.
const parseDonors = (s: string | undefined): [string, number][] =>
  (s || '').split(';').map((p) => { const [z, q] = p.split(':').map((x) => x.trim()); return [z, Number(q) || 0] as [string, number]; }).filter(([z]) => z);

// a step-3 trim candidate, once attributed to the MATERIAL OWNER.
interface Step3Cand { z: string; name: string; orig: number; sub: number; stock: number; norm: number; held: number; sn: number | null; cut: number; sub_donor?: string; }
// OWNER-centric step-3 trim view. The tail-trim cuts SUBSTITUTE first, then ORIGINAL. Each candidate's received substitute
// belongs to the reg-zsku that LENT it (candidate.sub_donor); we move that sub — and the part of the cut that fell on it
// (cut_sub = min(cut, Σsub), substitute cut first) — onto the donor's row. Original (and its cut) stays on the reg-zsku's
// own row. Filler (from the DB's filler_donors) is shown as a role too, though the step-3 tail-trim never cuts filler.
// Returned in the cut sequence, owner-centric: used-as-substitute first, then own-original, least-needy (highest S/N) within.
function ownerStep3Rows(cands: Step3Cand[], fillerDonors?: string) {
  const filLent = new Map<string, number>(); addDonors(fillerDonors, filLent);
  const subLent = new Map<string, number>(), subLentCut = new Map<string, number>(), ownOrigCut = new Map<string, number>();
  const bump = (m: Map<string, number>, z: string, v: number) => m.set(z, (m.get(z) || 0) + v);
  for (const c of cands) {
    const subs = parseDonors(c.sub_donor); const subTot = subs.reduce((a, [, q]) => a + q, 0);
    const cutSub = Math.min(c.cut || 0, subTot);                    // substitute is cut first
    bump(ownOrigCut, c.z, (c.cut || 0) - cutSub);                   // the remainder of the cut falls on its OWN original
    subs.forEach(([z, q]) => { bump(subLent, z, q); if (subTot > 0) bump(subLentCut, z, cutSub * (q / subTot)); });
  }
  const orows = cands.map((c) => {
    const asSub = subLent.get(c.z) || 0, asFil = filLent.get(c.z) || 0, asOrg = c.orig || 0;
    const cutSub = Math.round(subLentCut.get(c.z) || 0), cutOrg = ownOrigCut.get(c.z) || 0;
    return { c, asSub, asFil, asOrg, cutSub, cutOrg, cutTot: cutSub + cutOrg };
  });
  const rank = (o: typeof orows[number]) => {
    const hs = o.asSub > 0, ho = o.asOrg > 0;
    if (hs && !ho) return 0;   // used as substitute only — cut first
    if (hs) return 1;          // used as substitute (+ its own original)
    return 2;                  // its own original only — real demand, last
  };
  return orows.sort((a, b) =>
    ((a.cutTot > 0 ? 0 : 1) - (b.cutTot > 0 ? 0 : 1)) || (rank(a) - rank(b)) || ((b.c.sn ?? -1) - (a.c.sn ?? -1)));
}

/* ---------------------------------------------------------------------------
   Filler Sequence — Step 3, CFA × DB wise, in the engine's EXACT draw order.
   Fillers top up the spare truck room left after Original (Step 1) + Substitute
   (Step 2). DBs draw the shared CFA filler pool in priority order — rank 1 first.
   Each filler = min( CFA pool, 1.2×Norm room, 35% add-on left, truck room ). A
   lane whose trucks can't each reach ≥65% is DROPPED and cascades to the next run.
   EVERY number here comes straight from the engine (/api/v1/filler_sequence →
   or_filler_sequence · or_output_filler_calc · truck_plan_by_run · or_output_truck_trim).
   Nothing is recomputed on the client.
--------------------------------------------------------------------------- */
interface Truck { truck: number; cases: number; capacity: number; fill_pct: number; so_flag: string; }
interface Drop { reason: string; orig: number; sub: number; fil: number; }
// the EXACT Step-3 truck build the engine recorded (or_filler_sequence) — the NEW min-trucks / pack logic.
// nothing is recomputed here: MIN trucks for the load → the FILL / TRIM / SHIP-AS-IS decision → filler NEEDED
// vs ADDED vs SHIPPED → the packed layout (so_trucks at ≥90% + one remainder truck) → shipped / trimmed.
interface Flow {
  cap: number; hold_load: number; full_trucks: number; leftover: number; min_trucks: number;
  filler_needed: number; filler_added: number; filler_shipped: number; load_l: number;
  so_trucks: number; last_truck_cases: number; truck_count: number; shipped: number; residual: number;
  decision: number; decision_label: string; dropped: boolean;
}
// POST-cascade transshipment CLUSTER primary-truck trim (null for non-transshipment DBs). The engine builds the DB's
// Step-3 secondary trucks, then the cluster pass ships the fewest PRIMARY trucks each ≥65% and trims the <65% remainder
// CROSS-DB (every DB×reg-zsku pooled) — ALL fillers first, then substitutes, then originals (each by S/N), never below
// any DB's secondary-truck 65% floor; if the floor blocks the trim the leftover ships as a partial primary truck.
interface ClusterTrimLine {
  sn_ratio: number; sn_rank: number; stock: number; norm: number;
  allocated_before: number; allocated_after: number;
  cut_total: number; cut_filler: number; cut_sub: number; cut_orig: number;
}
interface ClusterTrim {
  cluster_code: string; primary_cap: number; primary_trucks: number; cluster_load: number;   // cluster_load = Σ member DBs
  shipped_before: number; trimmed: number; shipped_after: number; status: string;
  trims: Record<string, ClusterTrimLine>;   // keyed by reg-zsku
}
// a reg-zsku the truck rule TRIMMED / cascaded to the next run — Substitute and/or Original cases cut, with the S/N
// ratio that decided the order (least-needy = highest S/N cut first, Substitute before Original). S/N = SOH ÷ Norm,
// SOH = on-hand stock only (0-stock → max(stock,1)).
interface TrimLine {
  z: string; name: string; orig: number; sub: number; fil: number; reason: string;
  stock: number; norm: number; held: number; sn: number | null; sub_donor?: string;
}
// a reg-zsku the trim COULD have cut from (any Original/Substitute allocated) — with its available amounts, S/N, and how
// much was actually cut. The full set (in trim order) lets the functional team validate the trim picked the right lines.
// sub_donor = "<reg-zsku>:qty" — the reg-zsku whose material stood in as this candidate's substitute (for owner attribution).
interface TrimCandidate {
  z: string; name: string; orig: number; sub: number; stock: number; norm: number; held: number; sn: number | null; cut: number; sub_donor?: string;
}
interface DbEntry {
  db: string; db_name: string; run: number; channel: string; tier: number; tier_weight: number;
  sum_norm: number; sum_held: number; priority: number; rank: number; n_in_cfa: number;
  stock: number; soq: number; original: number; substitute: number; filler: number; total: number;
  flow: Flow; trucks: Truck[]; dropped: Drop | null; filler_calc: FillerCalc[]; cfa?: string;
  sub_donors?: string; filler_donors?: string;   // "<reg-zsku>:qty; …" — reg-zsku(s) used AS a substitute / filler for this DB
  trims: TrimLine[]; trim_candidates: TrimCandidate[]; cluster_trim: ClusterTrim | null;
}
interface Payload { date: string; cfas: { cfa: string; dbs: DbEntry[] }[]; }

const mono = { fontFamily: MONO, fontVariantNumeric: 'tabular-nums' as const };
const plural = (n: number) => (n === 1 ? '' : 's');

// one step of the Hold → Filler → ≥65%-ship flow — all values are the engine's, shown verbatim.
// `hue` is the accent (border); `numColor` (defaults to hue) is the big-number colour so we can keep a light
// accent bar while the number stays high-contrast on white.
function FlowStep({ n, label, big, hue, sub, numColor, icon }: { n: number; label: string; big: string; hue: string; sub: string; numColor?: string; icon?: string }) {
  return (
    <Box sx={{ flex: '1 1 205px', minWidth: 186, position: 'relative', p: 1.35, bgcolor: '#fff', border: `1px solid ${C.rule}`,
      borderRadius: `${RADIUS.md}px`, borderTop: `3px solid ${hue}`, boxShadow: SHADOW.sm, overflow: 'hidden' }}>
      <Box sx={{ position: 'absolute', top: -26, right: -26, width: 74, height: 74, borderRadius: '50%', bgcolor: hue, opacity: 0.07 }} />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.7, position: 'relative' }}>
        <Box sx={{ width: 19, height: 19, borderRadius: '50%', bgcolor: hue, color: '#fff', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, lineHeight: 1, flexShrink: 0 }}>{n}</Box>
        <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted }}>{label}</Box>
        <Box sx={{ flex: 1 }} />
        {icon && <span style={{ fontSize: 15, opacity: 0.9, lineHeight: 1 }}>{icon}</span>}
      </Box>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 22, color: numColor ?? hue, lineHeight: 1.12, mt: 0.5, position: 'relative' }}>{big}</Box>
      <Box sx={{ fontSize: 11.5, color: C.slate, ...mono, mt: 0.3, position: 'relative' }}>{sub}</Box>
    </Box>
  );
}

// a glossy truck-fill GAUGE — the bar fills to the truck's load with dashed markers at the 65% ship floor and the 90%
// SO line (so the reader SEES how full it is). Bar COLOUR = the truck's disposition: green SO · amber RLM · red below
// floor — a transshipment truck ships SO via its cluster primary even below 90%, so it reads green, not amber.
function TruckBar({ truck, cases, capacity, fillPct, soFlag, keep, fill, belowOk = false }:
  { truck: number; cases: number; capacity: number; fillPct: number; soFlag: string; keep: number; fill: number; belowOk?: boolean }) {
  const fr = Math.round(fillPct);
  const isSo = (soFlag || '').startsWith('SO');
  const isRlm = (soFlag || '').startsWith('RLM');
  // colour by the truck's DISPOSITION (the outcome), not the raw fill band: a transshipment SO truck ships as SO even
  // at, say, 80% (its cluster PRIMARY truck is what clears ≥90%), so it must read GREEN, not amber. Only when there is
  // no decided flag do we fall back to the fill band. The % + the 65/90 markers still show how full it actually is.
  const hue = isSo ? C.success : isRlm ? C.warnText : (fr >= fill * 100 ? C.success : fr >= keep * 100 ? C.warnText : (belowOk ? C.warnText : C.alertRed));
  const badge = soFlag || (fr >= keep * 100 ? 'ships' : 'below floor');
  return (
    <Box sx={{ flex: '1 1 320px', minWidth: 284, p: 1.15, bgcolor: '#fff', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.7, mb: 0.55 }}>
        <span style={{ fontSize: 16, lineHeight: 1 }}>🚛</span>
        <Box sx={{ ...mono, fontSize: 12.5, fontWeight: 800, color: C.navy }}>Truck {truck}</Box>
        <Box component="span" sx={{ ...mono, fontSize: 12, color: C.muted }}><b style={{ color: C.slate }}>{cases}</b>/{capacity} cs</Box>
        <Box sx={{ flex: 1 }} />
        <Box sx={{ px: 0.9, py: 0.2, borderRadius: 999, bgcolor: isSo ? C.successLight : hue === C.alertRed ? C.redP : C.warnLight,
          color: isSo ? C.success : hue, fontSize: 9.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{badge}</Box>
      </Box>
      <Box sx={{ position: 'relative', height: 26, bgcolor: '#F2F2F2', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px`,
        overflow: 'hidden', boxShadow: 'inset 0 1px 2px rgb(0 0 0 / 0.06)' }}>
        <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${Math.min(100, Math.max(0, fr))}%`,
          background: `linear-gradient(180deg, ${hue}, ${hue}CC)`, borderRight: fr < 100 ? `2px solid ${hue}` : 'none', transition: 'width .45s ease' }}>
          <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, height: '46%', background: 'linear-gradient(180deg, rgba(255,255,255,.30), rgba(255,255,255,0))' }} />
        </Box>
        <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: `${keep * 100}%`, borderLeft: `1.5px dashed ${C.muted}`, opacity: 0.6 }} />
        <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: `${fill * 100}%`, borderLeft: `1.5px dashed ${C.navy}`, opacity: 0.5 }} />
        <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', pl: 1, ...mono, fontSize: 12, fontWeight: 800,
          color: fr >= 20 ? '#fff' : C.slate, textShadow: fr >= 20 ? '0 1px 1.5px rgba(0,0,0,.3)' : 'none' }}>{fr}%</Box>
      </Box>
    </Box>
  );
}

// top-right lane filter — every lane in the selected CFA + run falls in exactly one of the three outcome buckets
type LaneFilter = 'all' | 'dropped' | 'filler' | 'nofiller';
const laneBucket = (d: { dropped: unknown; filler: number; total: number }): LaneFilter =>
  d.dropped ? 'dropped' : d.filler > 0 ? 'filler' : 'nofiller';
const LANE_FILTERS: { key: LaneFilter; label: string }[] = [
  { key: 'all', label: 'All lanes' },
  { key: 'dropped', label: 'Dropped' },
  { key: 'filler', label: 'With filler' },
  { key: 'nofiller', label: 'Shipped without filler' },
];

export default function FillerSequencePage({ date, cfa = '' }: { date?: string; cfa?: string }) {
  // CFA is scoped GLOBALLY from the run-context header (Step 3 runs CFA-wise) — no per-page CFA picker.
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from data===null: a run with no
  const [err, setErr] = useState<string | null>(null);   // filler lanes, or a failure, would then spin forever
  const [nonce, setNonce] = useState(0);           // bumped by the error Retry to re-run the effect
  const [run, setRun] = useState<number | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);           // the DB whose detail drawer is open (right side)
  const [helpOpen, setHelpOpen] = useState(false);                               // the "how it works" help modal (was the big intro block)
  const [clusterOpen, setClusterOpen] = useState<Record<string, boolean>>({});   // transshipment cluster section — closed by default
  const [trimOpen, setTrimOpen] = useState<Record<string, boolean>>({});         // cascaded/trimmed section — closed by default
  const [laneFilter, setLaneFilter] = useState<LaneFilter>('all');   // top-right dropdown: dropped / with filler / shipped w/o filler
  const [q, setQ] = useState('');   // free-text filter over the rendered DB list (DB code / name / reg-zsku / channel / brand)
  const P = useOeParams();   // engine thresholds from oe_parameters (never hardcode 0.35 / 0.65 / 0.90 etc.)
  const descOf = useRegZskuDesc();   // reg-zsku → product description (served lookup, single source)

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null); setLoading(true);
    api.fillerSequence(date).then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, nonce]);

  const allDbs = useMemo(
    () => (data?.cfas ?? []).flatMap((c) => c.dbs.map((d) => ({ ...d, cfa: c.cfa }))),
    [data],
  );
  const cfaDbs = useMemo(() => allDbs.filter((d) => d.cfa === cfa), [allDbs, cfa]);
  const runs = useMemo(() => {
    const m = new Map<number, string>();
    cfaDbs.forEach((d) => { if (!m.has(d.run)) m.set(d.run, d.channel); });
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [cfaDbs]);
  useEffect(() => {   // default to the run with the most SHIPPED lanes for THIS CFA (re-pick when CFA changes / run invalid)
    if (!cfaDbs.length) return;
    if (run !== null && runs.some((r) => r[0] === run)) return;
    const score = new Map<number, number>();
    cfaDbs.forEach((d) => score.set(d.run, (score.get(d.run) ?? 0) + (d.total > 0 && !d.dropped ? 1 : 0)));
    let best = runs[0]?.[0] ?? 1, bestN = -1;
    score.forEach((n, r) => { if (n > bestN) { bestN = n; best = r; } });
    setRun(best);
  }, [cfaDbs, runs, run]);

  const dbs = useMemo(
    () => cfaDbs.filter((d) => d.run === run).sort((a, b) => (a.rank === 0 ? 1e9 : a.rank) - (b.rank === 0 ? 1e9 : b.rank)),
    [cfaDbs, run],
  );
  // free-text filter (within the selected CFA + Run): DB code / name / channel / tier / reg-zsku + brand of each filler
  const laneCounts = useMemo(() => {
    const c: Record<LaneFilter, number> = { all: dbs.length, dropped: 0, filler: 0, nofiller: 0 };
    dbs.forEach((d) => { c[laneBucket(d)] += 1; });
    return c;
  }, [dbs]);
  const visibleDbs = useMemo(() => {
    const byLane = laneFilter === 'all' ? dbs : dbs.filter((d) => laneBucket(d) === laneFilter);
    const needle = q.trim().toLowerCase();
    if (!needle) return byLane;
    return byLane.filter((d) => (`${d.db} ${d.db_name} ${d.channel} T${d.tier} ${d.cfa ?? ''} `
      + d.filler_calc.map((f) => `${f.z} ${f.name}`).join(' ')).toLowerCase().includes(needle));
  }, [dbs, q, laneFilter]);

  // each state sits in the same page container as the loaded view, so nothing jumps when the data lands
  if (err) return <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1240, mx: 'auto' }}>
    <ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Box>;
  if (loading) return <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1240, mx: 'auto' }}><PageSkeleton kpis={0} rows={8} /></Box>;
  // every lane on this page is filtered to the GLOBAL header CFA — with none picked there is nothing to draw
  if (!cfa) return <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1240, mx: 'auto' }}><EmptyState title="Pick a CFA to continue"
    hint="The filler sequence is scoped to one CFA. Choose one in the run-context bar above." /></Box>;
  if (!data) return <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1240, mx: 'auto' }}><EmptyState title="No filler sequence for this run"
    hint="This run date returned no Step 3 filler lanes. Try another run date, or run the pipeline first." /></Box>;

  const shipped = visibleDbs.filter((d) => d.total > 0 && !d.dropped).length;
  const dropped = visibleDbs.filter((d) => d.dropped).length;

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1240, mx: 'auto' }}>
      <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: C.gold }}>Step 3 · Filler</Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.3 }}>
        <Typography sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 26, color: C.navy }}>Filler Sequence</Typography>
        <IconButton size="small" onClick={() => setHelpOpen(true)} title="How the Filler Sequence works"
          sx={{ color: C.gold, border: `1px solid ${C.goldLight}`, bgcolor: '#FCF4EE', '&:hover': { bgcolor: '#FBE8DC', borderColor: C.gold } }}>
          <HelpOutlineIcon sx={{ fontSize: 19 }} />
        </IconButton>
        <Box component="span" sx={{ fontSize: 11.5, color: C.muted }}>how it works</Box>
        <Box sx={{ flex: 1 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Box component="span" sx={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted }}>
            Show · CFA {cfa}
          </Box>
          <Select size="small" value={laneFilter} onChange={(e) => setLaneFilter(e.target.value as LaneFilter)}
            sx={{ minWidth: 230, bgcolor: C.white, fontSize: 13, fontWeight: 600, color: C.navy }}
            inputProps={{ 'aria-label': 'Filter lanes by outcome' }}>
            {LANE_FILTERS.map((f) => (
              <MenuItem key={f.key} value={f.key} sx={{ fontSize: 13 }}>{f.label} ({laneCounts[f.key]})</MenuItem>
            ))}
          </Select>
        </Box>
      </Box>
      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: `${RADIUS.md}px`, overflow: 'hidden', border: `1px solid ${C.goldLight}` } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2.5, py: 1.5, color: '#fff',
          background: 'linear-gradient(135deg, #EB8C00 0%, #D04A02 55%, #B33F02 100%)', borderBottom: '1px solid rgba(0,0,0,0.10)' }}>
          <HelpOutlineIcon sx={{ fontSize: 20 }} />
          <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 17 }}>How the Filler Sequence works</Box>
          <Box sx={{ flex: 1 }} />
          <IconButton onClick={() => setHelpOpen(false)} size="small" aria-label="close" sx={{ color: '#fff', '&:hover': { bgcolor: 'rgba(255,255,255,0.18)' } }}><CloseIcon sx={{ fontSize: 20 }} /></IconButton>
        </Box>
        <Box sx={{ p: 2.75, color: C.slate, bgcolor: '#FCF7F4', display: 'flex', flexDirection: 'column', gap: 2.75 }}>
          {/* the goal */}
          <Box sx={{ p: '11px 13px', borderRadius: `${RADIUS.sm}px`, bgcolor: '#FCF4EE', border: `1px solid ${C.goldLight}`, borderLeft: `3px solid ${C.gold}` }}>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.gold, mb: 0.5 }}>🎯 The goal</Box>
            <Box sx={{ fontSize: 13, lineHeight: 1.55 }}>Ship the <b>fewest trucks</b>, add the <b>least filler</b>, leave the <b>least in RLM</b>. Step 3 tops each lane's trucks up with filler, then builds them to do exactly that.</Box>
          </Box>

          {/* the build — 3 moves */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.9 }}>The build · 3 moves</Box>
            {([
              ['1', 'Min trucks', <>the fewest trucks that hold the Step&nbsp;1+2 load — <b style={{ fontFamily: MONO }}>ceil(load ÷ cap)</b></>, C.navy],
              ['2', 'Spend the spill', <><b style={{ color: C.success }}>FILL</b> to {pct(P.TRUCK_FILL_TARGET_PCT)} only when filler ≤ spill · <b style={{ color: C.warnText }}>TRIM</b> the spill &amp; ship the full trucks · <b style={{ color: C.navy }}>SHIP AS-IS</b> on an exact fit</>, C.gold],
              ['3', 'Pack', <>full trucks to 100%, any shortfall onto <b>ONE</b> truck → most trucks hit ≥{pct(P.TRUCK_FILL_TARGET_PCT)} (<b style={{ color: C.success }}>SO</b>) instead of a whole lane at ~85% (all RLM)</>, C.success],
            ] as const).map(([n, t, d, col], i, arr) => (
              <Box key={n} sx={{ display: 'flex', gap: 1, mb: i < arr.length - 1 ? 1 : 0 }}>
                <Box sx={{ flexShrink: 0, width: 20, height: 20, borderRadius: '50%', bgcolor: col, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, mt: 0.1 }}>{n}</Box>
                <Box sx={{ fontSize: 12.5, lineHeight: 1.5 }}><b style={{ color: col }}>{t}</b> — {d}</Box>
              </Box>
            ))}
          </Box>

          {/* filler = min of 4 caps */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.7 }}>Filler = the smallest of 4 caps</Box>
            <Box sx={{ p: '10px 12px', borderRadius: `${RADIUS.sm}px`, bgcolor: '#fff', border: `1px solid ${C.rule}` }}>
              <Box sx={{ fontFamily: MONO, fontSize: 12, color: C.slate }}>min( <b style={{ color: C.navy }}>CFA pool</b> · <b style={{ color: C.navy }}>{P.NORM_MULTIPLIER}×Norm room</b> · <b style={{ color: C.navy }}>{pct(P.ADDON_CAP_PCT)} add-on left</b> · <b style={{ color: C.navy }}>truck room</b> )</Box>
              <Box sx={{ fontSize: 11, color: C.muted, mt: 0.5 }}>Drawn across DBs in <b>priority order, rank 1 first</b>. The smallest cap (the “binding cap”) is what stops it.</Box>
            </Box>
          </Box>

          {/* the last truck */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.7 }}>The remainder truck</Box>
            <Box sx={{ display: 'flex', gap: 0.6, flexWrap: 'wrap' }}>
              {([[`≥${pct(P.TRUCK_KEEP_PCT)} ships`, C.success], ['<90% → RLM', C.warnText], [`else trimmed (fil→sub→orig by S/N)`, C.muted], [`<${pct(P.TRUCK_KEEP_PCT)} → lane DROPS`, C.alertRed]] as const).map(([lab, col]) => (
                <Box key={lab} component="span" sx={{ px: 0.9, py: '3px', borderRadius: 999, border: `1px solid ${col}`, color: col, fontSize: 11, fontWeight: 700 }}>{lab}</Box>
              ))}
            </Box>
          </Box>

          {/* draw priority */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.6 }}>Draw priority</Box>
            <Box sx={{ fontSize: 12.5, lineHeight: 1.55 }}><Box component="span" sx={{ fontFamily: MONO }}>tier weight ÷ ( Σheld ÷ Σnorm )</Box> — Σheld = stock + Original + Substitute (pre-filler). Higher priority draws the shared CFA pool first.</Box>
          </Box>

          <Box sx={{ pt: 1.25, borderTop: `1px solid ${C.rule}`, fontSize: 11, color: C.muted }}>Every number on the page is exactly what the engine recorded — nothing is recomputed.</Box>
        </Box>
      </Dialog>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2, mb: 1, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, px: 1.25, py: 0.5, borderRadius: `${RADIUS.sm}px`, bgcolor: C.navy, color: '#fff' }}>
          <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', opacity: 0.75 }}>CFA</span>
          <span style={{ fontSize: 13, fontWeight: 800, fontFamily: 'Consolas, monospace' }}>{cfa || '—'}</span>
        </Box>
        <Box component="span" sx={{ fontSize: 11.5, color: C.muted }}>allocation is CFA-wise — pick the CFA in the run-context header above</Box>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 0.5, mb: 1.5, flexWrap: 'wrap' }}>
        {runs.map(([k, ch]) => (
          <Box key={k} onClick={() => setRun(k)} sx={{ cursor: 'pointer', px: 1.5, py: 0.6, borderRadius: `${RADIUS.sm}px`,
            border: `1px solid ${run === k ? C.navy : C.rule}`, bgcolor: run === k ? C.navy : '#fff', color: run === k ? '#fff' : C.slate,
            fontSize: 12.5, fontWeight: 600 }}>
            Run {k}{ch ? ` · ${ch}` : ''}
          </Box>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search DB / name / reg-zsku / channel / brand…"
          style={{ flex: 1, minWidth: 260, padding: '8px 12px', fontSize: 14, fontFamily: MONO, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
        {q && <Box onClick={() => setQ('')} title="Clear the search field"
          sx={{ cursor: 'pointer', px: 1.5, py: 0.6, fontSize: 13, fontWeight: 700, borderRadius: `${RADIUS.sm}px`, border: `1px solid ${C.rule}`, bgcolor: '#fff', color: C.muted, '&:hover': { borderColor: C.navy, color: C.navy } }}>✕ Clear</Box>}
        <Box sx={{ fontSize: 12.5, color: C.muted }}>
          <b style={{ color: C.navy }}>{visibleDbs.length}</b>{q.trim() ? ` / ${dbs.length}` : ''} DBs · <b style={{ color: C.success }}>{shipped}</b> shipped · <b style={{ color: '#E0301E' }}>{dropped}</b> dropped
          <Box component="span" sx={{ ml: 0.75, color: C.gold, fontWeight: 700 }}>· click a DB → detail opens on the right</Box>
        </Box>
        <ExportXlsxButton label="Export Excel" onClick={() => downloadXlsx('filler_sequence',
          ['CFA', 'DB', 'DB name', 'Channel', 'Run', 'Tier', 'Draw rank', 'SOQ', 'Original', 'Substitute', 'Filler', 'Total', 'Dropped'],
          allDbs.map((e) => [e.cfa ?? '', e.db, e.db_name, e.channel, e.run, e.tier, e.rank, e.soq, e.original, e.substitute, e.filler, e.total, e.dropped ? 'yes' : '']))} />
      </Box>

      {visibleDbs.map((d) => {
        const k = `${d.cfa}|${d.db}|${d.run}`;
        const ct = d.cluster_trim;
        const inCluster = !!ct;                                       // this DB belongs to a transshipment cluster
        const hasClusterTrim = !!ct && ct.trimmed > 0;               // a real cluster primary-truck trim landed on this DB
        const st = d.dropped
          ? { label: 'dropped', bg: '#F8E9E6', fg: '#E0301E' }
          : d.filler > 0 ? { label: 'filled', bg: C.successLight, fg: C.success }
            : d.total > 0 ? { label: 'shipped · no filler', bg: C.navyP, fg: C.navy }
              : { label: 'no fill', bg: C.grayP, fg: C.muted };
        return (
          <Box key={k}>
            <Box onClick={() => setSelectedKey(k)}
              sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap', cursor: 'pointer', userSelect: 'none',
                px: 1.5, py: 0.9, mb: 1.5, bgcolor: '#fff', border: `1px solid ${selectedKey === k ? C.navy : C.rule}`,
                borderRadius: `${RADIUS.sm}px`, boxShadow: SHADOW.sm, transition: 'border-color .12s, box-shadow .12s',
                '&:hover': { borderColor: C.navy, boxShadow: SHADOW.md }, ...trackedSxFor(d.db) }}>
              <ChevronRightIcon sx={{ fontSize: 18, color: C.muted }} />
              <Box sx={{ ...mono, fontSize: 13, fontWeight: 800, color: C.muted, minWidth: 46 }}>{d.rank ? `#${d.rank}` : '—'}</Box>
              <Box sx={{ px: 1, py: 0.3, borderRadius: `${RADIUS.sm}px`, bgcolor: C.cream, color: C.warnText, fontWeight: 800, fontSize: 12.5, ...mono }}>
                prio {d.priority}
              </Box>
              <Chip label={`T${d.tier}`} size="small" sx={{ height: 19, fontSize: 11, fontWeight: 700 }} />
              <Box sx={{ ...mono, fontWeight: 700, color: C.navy, fontSize: 13.5 }}>DB {isTracked(d.db) ? TRACK_STAR + ' ' : ''}{d.db}</Box>
              <Box sx={{ color: C.muted, fontSize: 12.5, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.db_name}</Box>
              {inCluster && (
                <Box component="span" title={`Transshipment / cluster DB — ships via cluster ${ct!.cluster_code}'s shared primary trucks`}
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.3, px: 0.85, py: 0.2, borderRadius: 999, bgcolor: C.navyP,
                    color: C.navy, fontSize: 10, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', border: `1px solid #DCDCDC`, whiteSpace: 'nowrap' }}>
                  🔗 Transship{ct!.cluster_code ? ` · ${ct!.cluster_code}` : ''}
                </Box>
              )}
              <Box sx={{ flex: 1 }} />
              <Box sx={{ fontSize: 12.5, color: C.muted }}>
                SOQ <b style={{ color: C.slate }}>{d.soq}</b> · O <b style={{ color: C.navy }}>{d.original}</b> · S <b style={{ color: C.success }}>{d.substitute}</b> · F <b style={{ color: d.filler > 0 ? C.success : C.muted }}>{d.filler}</b> · Total <b style={{ color: C.slate }}>{d.total}</b>
              </Box>
              <Box sx={{ px: 1, py: 0.25, borderRadius: `${RADIUS.sm}px`, bgcolor: st.bg, color: st.fg, fontWeight: 800, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.03em' }}>{st.label}</Box>
            </Box>
            <Drawer anchor="right" open={selectedKey === k} onClose={() => setSelectedKey(null)}
              PaperProps={{ sx: { width: { xs: '100%', md: 'clamp(600px, 64vw, 980px)' }, maxWidth: '100vw', overflowY: 'auto' } }}>
              {/* sticky drawer header — DB identity + status + close */}
              <Box sx={{ position: 'sticky', top: 0, zIndex: 3, bgcolor: C.navy, color: '#fff', px: 2, py: 1.25,
                display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap', boxShadow: SHADOW.md }}>
                <Box sx={{ px: 0.9, py: 0.3, borderRadius: `${RADIUS.sm}px`, bgcolor: 'rgba(255,255,255,0.12)', color: '#fff', fontWeight: 800, fontSize: 11.5, ...mono }}>#{d.rank || '—'}</Box>
                <Box sx={{ ...mono, fontWeight: 800, fontSize: 15.5 }}>DB {d.db}</Box>
                <Box sx={{ fontSize: 12.5, color: 'rgba(255,255,255,0.82)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.db_name}</Box>
                {inCluster && (
                  <Box component="span" sx={{ px: 0.85, py: 0.2, borderRadius: 999, bgcolor: 'rgba(255,255,255,0.14)', color: '#fff', fontSize: 10, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>🔗 {ct!.cluster_code}</Box>
                )}
                <Box sx={{ flex: 1 }} />
                <Box sx={{ px: 1, py: 0.25, borderRadius: `${RADIUS.sm}px`, bgcolor: st.bg, color: st.fg, fontWeight: 800, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.03em' }}>{st.label}</Box>
                <IconButton onClick={() => setSelectedKey(null)} size="small" aria-label="close" sx={{ color: '#fff', border: '1px solid rgba(255,255,255,0.25)', '&:hover': { bgcolor: 'rgba(208,74,2,0.25)', borderColor: C.gold } }}><CloseIcon sx={{ fontSize: 20 }} /></IconButton>
              </Box>
              <Box sx={{ px: 1.75, pb: 3, pt: 0.5, bgcolor: '#FDFDFD', minHeight: '100%' }}>

              {/* 2 · the NEW truck build: MIN trucks → FILL / TRIM / SHIP-AS-IS decision → PACK (engine numbers, or_filler_sequence) */}
              {(() => {
                const f = d.flow;
                if (f.hold_load <= 0) return (
                  <Box sx={{ my: 1, fontSize: 12, color: C.muted }}>No Original/Substitute load on this lane — no truck to fill.</Box>
                );
                const decHue = f.decision === 2 ? C.warnText : C.success;          // TRIM amber · FILL / SHIP-AS-IS green
                const decLabel = (f.decision_label || 'decision').toUpperCase();
                const capped = f.decision === 1 && f.filler_added < f.filler_needed; // wanted more filler than the caps allowed
                const soCount = d.trucks.filter((t) => (t.so_flag || '').startsWith('SO')).length;
                const rlmCount = d.trucks.filter((t) => (t.so_flag || '').startsWith('RLM')).length;
                // the one-line outcome — SPELL OUT the optimisation (fewer trucks · less filler · less RLM)
                const outcome = d.dropped
                  ? { hue: '#E0301E', text: `Dropped — the ${f.load_l}-case load can't fill even one truck to ${pct(P.TRUCK_KEEP_PCT)} of ${f.cap}; the reserved filler is returned and Original + Substitute cascade to the next run.` }
                  : f.decision === 2
                    ? { hue: C.success, text: `Trimmed the ${f.leftover}-case spill instead of adding ${f.filler_needed} filler → ${f.truck_count} full truck${plural(f.truck_count)} @ 100% (all SO), no RLM. Less filler, less RLM.` }
                    : rlmCount === 0
                      ? { hue: C.success, text: `Packed into ${f.truck_count} truck${plural(f.truck_count)}, every one ≥${pct(P.TRUCK_FILL_TARGET_PCT)} → all SO${f.filler_shipped > 0 ? ` (with ${f.filler_shipped} filler)` : ''}. No RLM.` }
                      : { hue: C.warnText, text: `${soCount} truck${plural(soCount)} packed to ≥${pct(P.TRUCK_FILL_TARGET_PCT)} (SO); the ${f.last_truck_cases}-case remainder ships as ${rlmCount} RLM truck (couldn't reach ${pct(P.TRUCK_FILL_TARGET_PCT)} even with filler).` };
                const dec2Icon = f.decision === 1 ? '➕' : f.decision === 2 ? '✂️' : '✅';
                return (
                  <Box sx={{ my: 1.25, p: 1.35, bgcolor: '#FCF4F5', border: `1px solid #E0E0E0`, borderLeft: `4px solid ${C.navy}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1, flexWrap: 'wrap' }}>
                      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: C.navy }}>🚛 How the trucks build</Box>
                      <Box sx={{ px: 0.9, py: 0.2, borderRadius: 999, bgcolor: C.navyP, color: C.muted, fontSize: 9.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase' }}>
                        min trucks → {decLabel.toLowerCase()} → pack
                      </Box>
                      {inCluster && <Box component="span" sx={{ fontSize: 10.5, color: C.muted }}>· per-DB, before the cluster combines</Box>}
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 0.75, flexWrap: 'wrap' }}>
                      <FlowStep n={1} label="Min trucks" hue={C.navy} icon="📦"
                        big={`${f.min_trucks} truck${plural(f.min_trucks)}`}
                        sub={`hold ${f.hold_load} · cap ${f.cap} → ${f.full_trucks} full${f.leftover > 0 ? ` + ${f.leftover} over` : ''}`} />
                      <Box sx={{ alignSelf: 'center', color: C.muted, fontWeight: 800, fontSize: 20, opacity: 0.5 }}>›</Box>
                      <FlowStep n={2} label={decLabel} hue={f.decision === 1 ? C.gold : decHue} numColor={decHue} icon={dec2Icon}
                        big={f.decision === 1 ? `+${f.filler_added} filler` : f.decision === 2 ? `−${f.leftover} trim` : 'exact fit'}
                        sub={f.decision === 1
                          ? `need ${f.filler_needed} to reach ${pct(P.TRUCK_FILL_TARGET_PCT)} (≤ spill ${f.leftover}) → load ${f.load_l}${capped ? ' · capped by pool/Norm/add-on' : ''}`
                          : f.decision === 2 ? `filler ${f.filler_needed} > spill ${f.leftover} → ship the ${f.full_trucks} full truck${plural(f.full_trucks)}, bin the spill`
                            : `${f.full_trucks} full truck${plural(f.full_trucks)} · no filler, no trim`} />
                      <Box sx={{ alignSelf: 'center', color: C.muted, fontWeight: 800, fontSize: 20, opacity: 0.5 }}>›</Box>
                      {d.dropped
                        ? <FlowStep n={3} label="Pack / ship" hue={C.alertRed} icon="⛔" big="DROP"
                            sub={`load ${f.load_l} < ${pct(P.TRUCK_KEEP_PCT)} of ${f.cap} · ${f.residual} cascade`} />
                        : <FlowStep n={3} label="Pack / ship" hue={C.success} icon="🚛"
                            big={`${f.truck_count} truck${plural(f.truck_count)}`}
                            sub={`${soCount}×SO${rlmCount ? ` + ${rlmCount}×RLM` : ''} · ship ${f.shipped}${f.residual > 0 ? ` · trim ${f.residual}` : ''}`} />}
                    </Box>
                    {d.trucks.length > 0 && (
                      <>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.9, mt: 1.35, mb: 0.35 }}>
                          <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted }}>Trucks on the road</Box>
                          <Box sx={{ flex: 1, height: '1px', bgcolor: C.rowLine }} />
                          <Box sx={{ fontSize: 10.5, color: C.muted }}><b style={{ color: C.success }}>{soCount}</b> SO{rlmCount ? <> · <b style={{ color: C.warnText }}>{rlmCount}</b> RLM</> : ''}</Box>
                        </Box>
                        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                          {d.trucks.map((t) => (
                            <TruckBar key={t.truck} truck={t.truck} cases={t.cases} capacity={t.capacity}
                              fillPct={t.fill_pct} soFlag={t.so_flag} keep={P.TRUCK_KEEP_PCT} fill={P.TRUCK_FILL_TARGET_PCT} belowOk={inCluster} />
                          ))}
                        </Box>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.75, mt: 0.7, fontSize: 10.5, color: C.muted, flexWrap: 'wrap' }}>
                          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4 }}>
                            <span style={{ display: 'inline-block', borderLeft: `1.5px dashed ${C.muted}`, height: 11 }} />{pct(P.TRUCK_KEEP_PCT)} ship floor
                          </Box>
                          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4 }}>
                            <span style={{ display: 'inline-block', borderLeft: `1.5px dashed ${C.navy}`, height: 11 }} />{pct(P.TRUCK_FILL_TARGET_PCT)} SO line
                          </Box>
                          <Box component="span">
                            bar = disposition · <b style={{ color: C.success }}>green</b> SO · <b style={{ color: C.warnText }}>amber</b> RLM · <b style={{ color: C.alertRed }}>red</b> below floor{inCluster ? ' · a transshipment truck ships SO via its cluster primary even below the 90% line' : ''}
                          </Box>
                        </Box>
                      </>
                    )}
                    <Box sx={{ mt: 0.75, p: '8px 12px', borderRadius: `${RADIUS.sm}px`, fontSize: 12.5, lineHeight: 1.45,
                      bgcolor: outcome.hue === '#E0301E' ? '#FCF2F1' : outcome.hue === C.warnText ? C.warnLight : C.successLight,
                      border: `1px solid ${C.rule}`, borderLeft: `3px solid ${outcome.hue}`, color: C.slate }}>
                      <b style={{ color: outcome.hue }}>▸ {d.dropped ? `Lane dropped — ${d.dropped.reason}.` : f.decision === 2 ? 'Trimmed, not filled.' : rlmCount === 0 ? 'All SO.' : 'Packed — one RLM tail.'}</b> {outcome.text}
                    </Box>
                  </Box>
                );
              })()}

              {/* 2b · WHAT WAS TRIMMED / CASCADED — the exact reg-zskus the truck rule cut off, with the S/N ratio that
                   decided the order (Substitute before Original; within each, least-needy = highest S/N first). Shows for
                   a partial tail-trim (TRUCK_TAIL_CASCADE) AND a whole-lane drop (LANE_DROP). */}
              {d.trims.length > 0 && (() => {
                const isDrop = d.trims.some((t) => t.reason.startsWith('LANE_DROP'));
                const totOrig = d.trims.reduce((a, t) => a + t.orig, 0);
                const totSub = d.trims.reduce((a, t) => a + t.sub, 0);
                // the FULL candidate set the trim chose from (every reg-zsku with Original/Substitute allocated); cut = trimmed.
                const cands: Step3Cand[] = (d.trim_candidates && d.trim_candidates.length) ? d.trim_candidates
                  : d.trims.map((t) => ({ z: t.z, name: t.name, orig: t.orig, sub: t.sub, stock: t.stock, norm: t.norm, held: t.held, sn: t.sn, cut: t.orig + t.sub, sub_donor: t.sub_donor }));
                const nCut = cands.filter((t) => t.cut > 0).length;
                // OWNER-centric: attribute each received substitute (and the cut that fell on it) to the reg-zsku that LENT
                // it, and order used-as-substitute → own-original. So a reg-zsku shows what ITS material is used as, and the
                // trim reads as "cut the reg-zskus used as substitute first, then originals" — not the demand that received.
                const orows = ownerStep3Rows(cands, d.filler_donors);
                const hue = isDrop ? '#E0301E' : C.warnText;
                const th = { background: C.headBg, color: C.muted, fontFamily: SANS, fontWeight: 700, fontSize: 10,
                  letterSpacing: '.04em', textTransform: 'uppercase' as const, padding: '7px 10px', whiteSpace: 'nowrap' as const,
                  borderBottom: `1px solid ${C.rule}` };
                return (
                  <Box sx={{ my: 1.25, p: 1.35, bgcolor: isDrop ? '#FCF2F1' : '#FEF6F0', border: `1px solid ${isDrop ? '#F0C9C7' : C.goldLight}`, borderLeft: `4px solid ${hue}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm }}>
                    <Box onClick={() => setTrimOpen((p) => ({ ...p, [k]: !(p[k] ?? false) }))}
                      sx={{ display: 'flex', alignItems: 'center', gap: 0.4, flexWrap: 'wrap', cursor: 'pointer', userSelect: 'none' }}>
                      <ChevronRightIcon sx={{ fontSize: 17, color: hue, transition: 'transform .15s', transform: (trimOpen[k] ?? false) ? 'rotate(90deg)' : 'none' }} />
                      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: hue }}>
                        {isDrop ? `Cascaded to next run · whole lane dropped` : `Trimmed off the truck · cascaded to next run`}
                        {' '}· {totSub > 0 ? <>Substitute <b>{totSub}</b> · </> : ''}Original <b>{totOrig}</b> · cut <b>{nCut}</b> of {cands.length} reg-zsku{cands.length === 1 ? '' : 's'}
                      </Box>
                      <Box sx={{ flex: 1 }} />
                      <Box component="span" sx={{ fontSize: 10.5, fontWeight: 700, color: C.muted }}>{(trimOpen[k] ?? false) ? 'hide' : 'show'}</Box>
                    </Box>
                    <Collapse in={trimOpen[k] ?? false} unmountOnExit>
                    <Box sx={{ fontSize: 11.5, color: C.slate, mt: 0.65, mb: 0.65, lineHeight: 1.45 }}>
                      {isDrop
                        ? <>No truck reached {pct(P.TRUCK_KEEP_PCT)} of {d.flow.cap}, so the <b>whole lane cascades</b> to the next run (its CFA) — every demanded reg-zsku moves on, ordered <b>Substitute first, then least-needy (highest S/N) first</b>.</>
                        : <>The overflow above the packed trucks is trimmed <b>Substitute first, then Original</b>; within each, the <b>least-needy line (highest S/N) is cut first</b>, S/N = <b>SOH ÷ Norm</b> (on-hand stock ÷ norm).</>}
                      {' '}The table below lists <b>every reg-zsku this DB could trim from</b> — its available <b>Substitute</b> &amp; <b>Original</b> and its S/N — in that exact order; the highlighted <b>✂ Cut</b> column is what was actually trimmed, so you can validate the right lines were chosen (and if more Substitutes existed, that the highest-S/N one went first).
                    </Box>
                    <Box sx={{ overflowX: 'auto', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px` }}>
                      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 720 }}>
                        <thead><tr>
                          <th style={{ ...th, textAlign: 'right' }}>Order</th>
                          <th style={{ ...th, textAlign: 'left' }}>Reg-zsku</th>
                          <th style={{ ...th, textAlign: 'left' }}>Description</th>
                          <th style={{ ...th, textAlign: 'left' }} title="what this reg-zsku's OWN material is used as: original (its own demand), or LENT to another reg-zsku here as a substitute / to fill a truck">Used as</th>
                          <th style={{ ...th, textAlign: 'right' }} title="cases of THIS reg-zsku's material LENT to stand in as a substitute for another reg-zsku (not what it received)">As substitute</th>
                          <th style={{ ...th, textAlign: 'right' }} title="this reg-zsku's own demand (original)">As original</th>
                          <th style={{ ...th, textAlign: 'right' }}>S/N = SOH ÷ Norm</th>
                          <th style={{ ...th, textAlign: 'right' }}>✂ Cut</th>
                        </tr></thead>
                        <tbody>
                          {orows.map((o, i) => {
                            const t = o.c;
                            const isCut = o.cutTot > 0;
                            const td = { fontFamily: MONO, fontSize: 11.5, padding: '6px 10px', whiteSpace: 'nowrap' as const,
                              borderBottom: `1px solid ${C.rowLine}`, color: C.slate } as const;
                            return (
                              <tr key={t.z} style={{ background: isCut ? (isDrop ? '#FBEAEA' : '#FCE4D4') : (i % 2 ? C.cream : '#fff') }}>
                                <td style={{ ...td, textAlign: 'right', color: C.muted, fontWeight: 700 }}>{i + 1}</td>
                                <td style={{ ...td, fontWeight: 700, color: C.navy }}>{t.z}</td>
                                <td style={{ ...td, fontFamily: SANS, color: C.muted, whiteSpace: 'normal' }} title={descOf(t.z) || t.name}>{descOf(t.z) || t.name || '—'}</td>
                                <td style={{ ...td }}>
                                  {(o.asOrg === 0 && o.asSub === 0 && o.asFil === 0)
                                    ? <span style={{ color: C.muted }}>—</span>
                                    : (
                                      <span style={{ display: 'inline-flex', gap: 3, flexWrap: 'wrap' }}>
                                        {o.asOrg > 0 && <span style={usedTag('#EEEEEE', '#2D2D2D')}>original</span>}
                                        {o.asSub > 0 && <span style={usedTag('#E6F3EC', '#1E8E5A')}>substitute · {o.asSub}</span>}
                                        {o.asFil > 0 && <span style={usedTag('#FDEDE3', '#D04A02')}>filler · {o.asFil}</span>}
                                      </span>
                                    )}
                                </td>
                                <td style={{ ...td, textAlign: 'right', color: o.asSub > 0 ? C.success : C.rule, fontWeight: o.asSub > 0 ? 700 : 400 }}>{o.asSub > 0 ? o.asSub : ''}{o.cutSub > 0 && <span style={{ color: hue, fontWeight: 800 }}> −{o.cutSub}</span>}</td>
                                <td style={{ ...td, textAlign: 'right', color: o.asOrg > 0 ? C.navy : C.rule, fontWeight: o.asOrg > 0 ? 700 : 400 }}>{o.asOrg > 0 ? o.asOrg : ''}{o.cutOrg > 0 && <span style={{ color: hue, fontWeight: 800 }}> −{o.cutOrg}</span>}</td>
                                <td style={{ ...td, textAlign: 'right' }}>
                                  <b style={{ color: hue }}>{t.sn === null ? '∞' : t.sn.toFixed(2)}</b>
                                  <span style={{ color: C.muted }}> ({t.held} ÷ {t.norm})</span>
                                </td>
                                <td style={{ ...td, textAlign: 'right', fontWeight: 800, color: isCut ? hue : C.rule }}>{isCut ? `−${o.cutTot}` : ''}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </Box>
                    </Collapse>
                  </Box>
                );
              })()}

              {/* 2c · TRANSSHIPMENT CLUSTER — the primary-truck re-plan, kept SEPARATE from the per-DB Step-3 flow above
                   so a cluster DB reads clearly: PREVIOUS (its own secondary truck) → AFTER (the cross-DB-trimmed
                   primary truck). Only rendered for DBs that belong to a transshipment cluster. */}
              {inCluster && (() => {
                const cf = Object.values(ct!.trims).reduce((a, t) => a + t.cut_filler, 0);
                const cs = Object.values(ct!.trims).reduce((a, t) => a + t.cut_sub, 0);
                const co = Object.values(ct!.trims).reduce((a, t) => a + t.cut_orig, 0);
                const cutParts = ([['filler', cf], ['substitute', cs], ['original', co]] as const)
                  .filter(([, v]) => v > 0).map(([lab, v]) => `${lab} −${v}`).join(' · ');
                const clusterDropped = (ct!.status || '').toUpperCase().includes('DROP');   // whole cluster < 65% → nothing ships
                const load = ct!.cluster_load, cap = ct!.primary_cap, ntr = Math.max(0, ct!.primary_trucks);
                // level-load the cluster's combined load across its shared primary trucks (the visual)
                const primLoads = Array.from({ length: ntr }, (_, i) =>
                  (i < (ntr ? load % ntr : 0) ? Math.floor(load / ntr) + 1 : (ntr ? Math.floor(load / ntr) : 0)));
                const share = load ? Math.round(ct!.shipped_after / load * 100) : 0;
                const statusHue = clusterDropped ? C.alertRed : hasClusterTrim ? C.warnText : C.success;
                return (
                  <Box sx={{ my: 1.25, p: 1.35, bgcolor: '#F5F5F5', border: `1px solid #DCDCDC`, borderLeft: `4px solid ${C.navy}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm }}>
                    <Box onClick={() => setClusterOpen((p) => ({ ...p, [k]: !(p[k] ?? false) }))}
                      sx={{ display: 'flex', alignItems: 'center', gap: 0.6, flexWrap: 'wrap', cursor: 'pointer', userSelect: 'none' }}>
                      <ChevronRightIcon sx={{ fontSize: 17, color: C.muted, transition: 'transform .15s', transform: (clusterOpen[k] ?? false) ? 'rotate(90deg)' : 'none' }} />
                      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: C.navy }}>🔗 Transshipment cluster {ct!.cluster_code}</Box>
                      <Box sx={{ px: 0.9, py: 0.2, borderRadius: 999, bgcolor: clusterDropped ? C.redP : C.successLight, color: statusHue, fontSize: 9.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase' }}>{ct!.status || 'ships'}</Box>
                      <Box component="span" sx={{ fontSize: 10.5, color: C.muted }}>· this DB rides {ct!.shipped_after} of {load} cs</Box>
                      <Box sx={{ flex: 1 }} />
                      <Box component="span" sx={{ fontSize: 10.5, fontWeight: 700, color: C.muted }}>{(clusterOpen[k] ?? false) ? 'hide' : 'show'}</Box>
                    </Box>
                    <Collapse in={clusterOpen[k] ?? false} unmountOnExit>
                    <Box sx={{ fontSize: 11.5, color: C.slate, mt: 0.85, mb: 0.85, lineHeight: 1.45 }}>
                      This DB does <b>not</b> ship on its own trucks — the cluster pools every member DB's load and ships the <b>fewest shared PRIMARY trucks</b> (cap {cap}) each ≥{pct(P.TRUCK_KEEP_PCT)}. This DB's cases ride those trucks; its own {d.flow.truck_count}-truck Step-3 plan (at the bottom) is only the pre-cluster view.
                    </Box>
                    {/* THE CLUSTER PRIMARY TRUCKS — the ACTUAL ship, as fill bars */}
                    <Box sx={{ p: 1.15, bgcolor: C.cream, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px` }}>
                      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.6, mb: 0.75, flexWrap: 'wrap' }}>
                        <Box sx={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.muted }}>Cluster ships on</Box>
                        <Box component="span" sx={{ ...mono, fontSize: 12.5, color: C.slate }}>combined <b style={{ color: C.navy }}>{load}</b> cs → <b style={{ color: C.navy }}>{ntr}</b> primary truck{plural(ntr)}</Box>
                      </Box>
                      {ntr > 0 && (
                        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                          {primLoads.map((c, i) => (
                            <TruckBar key={i} truck={i + 1} cases={c} capacity={cap} fillPct={cap ? c / cap * 100 : 0}
                              soFlag={clusterDropped ? 'RLM_TRUCK_APPROVAL' : 'SO_CREATION'} keep={P.TRUCK_KEEP_PCT} fill={P.TRUCK_FILL_TARGET_PCT} belowOk />
                          ))}
                        </Box>
                      )}
                      <Box sx={{ mt: 0.8, p: '7px 10px', bgcolor: '#fff', border: `1px solid ${C.rule}`, borderLeft: `3px solid ${statusHue}`, borderRadius: `${RADIUS.sm}px`, fontSize: 12, color: C.slate, lineHeight: 1.5 }}>
                        This DB (<b>{d.db}</b>) rides <b style={{ color: C.navy }}>{ct!.shipped_after}</b> of the cluster's <b>{load}</b> cs ({share}%)
                        {clusterDropped
                          ? <> — but the combined load couldn't fill a primary truck to {pct(P.TRUCK_KEEP_PCT)}, so the <b style={{ color: C.alertRed }}>whole cluster dropped</b> and cascades to the next run.</>
                          : hasClusterTrim
                            ? <> · <b style={{ color: C.warnText }}>trimmed {ct!.trimmed}</b>{cutParts ? ` (${cutParts})` : ''} <b>CROSS-DB</b> (fillers → substitutes → originals, least-needy by S/N, never below any DB's 65% secondary floor) to fit the primary trucks.</>
                            : <> · <b style={{ color: C.success }}>no trim needed</b> — the combined load fit the primary trucks, so this DB ships its full <b>{ct!.shipped_after}</b> cs.</>}
                      </Box>
                      {hasClusterTrim && Object.keys(ct!.trims).length > 0 && (
                        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.6 }}>
                          {Object.entries(ct!.trims).map(([z, t]) => (
                            <Chip key={z} size="small" label={`${z}: ${t.allocated_before}→${t.allocated_after} (−${t.cut_total})`}
                              sx={{ height: 20, fontSize: 11, ...mono, bgcolor: '#fff', border: `1px solid ${t.cut_total > 0 ? C.warnText : C.rule}`, color: t.cut_total > 0 ? C.warnText : C.slate }} />
                          ))}
                        </Box>
                      )}
                    </Box>
                    {/* this DB's own PRE-cluster secondary trucks — small, de-emphasised context */}
                    {d.trucks.length > 0 && (
                      <Box sx={{ mt: 0.85, display: 'flex', alignItems: 'center', gap: 0.55, flexWrap: 'wrap', fontSize: 11, color: C.muted }}>
                        <Box component="span" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', fontSize: 9.5 }}>Pre-cluster · this DB's own Step-3 trucks (cap {d.flow.cap})</Box>
                        {d.trucks.map((t) => (
                          <Box key={t.truck} component="span" sx={{ px: 0.7, py: 0.2, borderRadius: `${RADIUS.sm}px`, border: `1px solid ${C.rule}`, bgcolor: C.cream, ...mono, fontSize: 11, color: C.slate }}>
                            T{t.truck} {t.cases}/{t.capacity} · {Math.round(t.fill_pct)}%
                          </Box>
                        ))}
                        <Box component="span">→ replaced by the cluster plan above</Box>
                      </Box>
                    )}
                    </Collapse>
                  </Box>
                );
              })()}

              {/* draw-priority score — shown right before the filler fill, because the priority is what decides the ORDER
                  DBs draw the shared CFA filler pool, checked BEFORE any filler is added. Exact engine values. */}
              <Box sx={{ my: 1.25, p: 1.35, bgcolor: '#FCF4EE', border: `1px solid ${C.goldLight}`, borderLeft: `4px solid ${C.gold}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.85, flexWrap: 'wrap' }}>
                  <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: C.gold }}>🎯 Filler draw priority</Box>
                  <Box sx={{ px: 0.9, py: 0.2, borderRadius: 999, bgcolor: C.navyP, color: C.navy, fontSize: 10, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase' }}>rank {d.rank || '—'} / {d.n_in_cfa}</Box>
                  <Box sx={{ flex: 1 }} />
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5 }}>
                    <Box component="span" sx={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: C.muted }}>priority</Box>
                    <Box component="span" sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 23, color: C.gold, lineHeight: 1 }}>{d.priority}</Box>
                  </Box>
                </Box>
                <Box sx={{ ...mono, fontSize: 13, color: C.slate, fontWeight: 700, mb: 0.8 }}>
                  tier&nbsp;weight&nbsp;<b style={{ color: C.navy }}>{d.tier_weight}</b>&nbsp;÷&nbsp;( Σheld&nbsp;<b style={{ color: C.navy }}>{d.sum_held}</b>&nbsp;÷&nbsp;Σnorm&nbsp;<b style={{ color: C.navy }}>{d.sum_norm}</b> )&nbsp;=&nbsp;<b style={{ color: C.gold }}>{d.priority}</b>
                </Box>
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center', mb: 0.6 }}>
                  {([['stock', d.stock, C.muted], ['Original', d.original, C.navy], ['Substitute', d.substitute, C.success]] as const).map(([lab, v, col]) => (
                    <Box key={lab} component="span" sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 0.4, px: 0.85, py: '2px', borderRadius: 999, bgcolor: '#fff', border: `1px solid ${C.rule}`, ...mono, fontSize: 11 }}>
                      <span style={{ color: C.muted, fontSize: 10 }}>{lab}</span><b style={{ color: col }}>{v}</b>
                    </Box>
                  ))}
                  <Box component="span" sx={{ color: C.muted, fontWeight: 800 }}>=</Box>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 0.4, px: 0.85, py: '2px', borderRadius: 999, bgcolor: '#FEF4ED', border: `1px solid ${C.goldLight}`, ...mono, fontSize: 11 }}>
                    <span style={{ color: C.muted, fontSize: 10 }}>Σheld</span><b style={{ color: C.gold }}>{d.sum_held}</b>
                  </Box>
                  <Box component="span" sx={{ color: C.muted, mx: 0.1 }}>·</Box>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 0.4, px: 0.85, py: '2px', borderRadius: 999, bgcolor: '#fff', border: `1px solid ${C.rule}`, ...mono, fontSize: 11 }}>
                    <span style={{ color: C.muted, fontSize: 10 }}>Σnorm</span><b style={{ color: C.slate }}>{d.sum_norm}</b>
                  </Box>
                </Box>
                <Box sx={{ fontSize: 11, color: C.muted }}>
                  Σheld = stock + Original + Substitute after Steps 1 &amp; 2 (pre-filler){d.sum_held === 0 ? ' · Σheld floored to 1 when 0' : ''}. Higher priority draws the shared CFA filler pool earlier — checked <b>before</b> any filler is added.
                </Box>
              </Box>

              {/* 3 · per-eligible-filler fill calc — reuses the exact FillerTable (or_output_filler_calc) */}
              <Box sx={{ my: 1.25, p: 1.35, bgcolor: '#F1F7F2', border: `1px solid #CFE6D5`, borderLeft: `4px solid ${C.success}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5, flexWrap: 'wrap' }}>
                <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: C.success }}>🧩 Filler fill · how each is calculated</Box>
              </Box>
              <Box sx={{ fontSize: 11.5, color: C.slate, mb: 0.85, lineHeight: 1.5 }}>
                Each eligible filler gets the <b>smallest of its four caps</b> — <b>CFA pool</b> (stock reserved &amp; left) · <b>{P.NORM_MULTIPLIER}×Norm room</b> (how much more the DB may hold) · <b>{pct(P.ADDON_CAP_PCT)} add-on left</b> (budget) · <b>truck room</b> (spare truck space). The smallest one — the <b>binding cap</b> — is what stops it, highlighted per row and named under “Limited&nbsp;by”.
              </Box>
              {d.filler_calc.length > 0 && (() => {
                // WHY the "add-on left" column has room: the add-on budget = floor(ADDON_CAP_PCT × the DB's COMBINED SOQ),
                // shared by Substitute + Filler. What substitutes already used = cap − (rank-1 filler's add-on left), so the
                // remainder is exactly where the column below starts. All values are the engine's — nothing recomputed.
                const cap = Math.floor(P.ADDON_CAP_PCT * d.soq);
                const startAddon = Math.max(...d.filler_calc.map((f) => f.addon));
                const usedBySub = cap - startAddon;
                const chip = { height: 21, fontSize: 11, ...mono, bgcolor: C.cream, border: `1px solid ${C.rule}`, color: C.slate, borderRadius: `${RADIUS.sm}px` } as const;
                return (
                  <Box sx={{ mb: 0.85, p: '9px 12px', bgcolor: '#fff', border: `1px solid ${C.rule}`, borderLeft: `3px solid ${C.gold}`, borderRadius: `${RADIUS.sm}px` }}>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.6, fontSize: 11.5, color: C.slate }}>
                      <Box component="span" sx={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', color: C.gold, fontSize: 10, mr: 0.3 }}>{pct(P.ADDON_CAP_PCT)} add-on budget</Box>
                      <Chip size="small" label={`Combined SOQ ${d.soq}`} sx={chip} />
                      <Box component="span" sx={{ ...mono, color: C.muted }}>× {pct(P.ADDON_CAP_PCT)} =</Box>
                      <Chip size="small" label={`${cap} cap`} sx={{ ...chip, fontWeight: 700, color: C.navy, bgcolor: C.navyP }} />
                      <Box component="span" sx={{ ...mono, color: C.muted }}>−&nbsp;{usedBySub}&nbsp;substitute&nbsp;=</Box>
                      <Chip size="small" label={`${startAddon} left for filler`} sx={{ ...chip, fontWeight: 700, color: C.gold, bgcolor: '#FEF4ED', borderColor: C.goldLight }} />
                    </Box>
                    <Box component="span" sx={{ display: 'block', fontSize: 11, color: C.muted, mt: 0.5 }}>→ where the “add-on left” column below starts — Substitute + Filler stay ≤ {pct(P.ADDON_CAP_PCT)} of the DB's SOQ.</Box>
                  </Box>
                );
              })()}
              {hasClusterTrim && (() => {
                // the fillers below still render their GRANTED alloc (green) — the cluster pass cut them AFTER the draw.
                // Flag which ones were reduced so the table isn't read as final. Non-mutating: FillerTable is shared, untouched.
                const trimmedFillers = Object.entries(ct!.trims)
                  .filter(([, t]) => t.cut_filler > 0)
                  .map(([z, t]) => {
                    const before = d.filler_calc.find((f) => f.z === z)?.alloc ?? t.cut_filler;
                    return { z, before, after: before - t.cut_filler };
                  });
                if (!trimmedFillers.length) return null;
                return (
                  <Box sx={{ mb: 0.75, p: '7px 10px', bgcolor: C.warnLight, border: `1px solid ${C.warnText}`, borderLeft: `3px solid ${C.warnText}`,
                    borderRadius: `${RADIUS.sm}px`, fontSize: 11.5, color: C.slate, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.6 }}>
                    <Box component="span" sx={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.03em', color: C.warnText, fontSize: 10.5 }}>Cluster {ct!.cluster_code} trim</Box>
                    <Box component="span" sx={{ color: C.muted }}>reduced these fillers AFTER the draw — the green “Allocated” below is pre-trim:</Box>
                    {trimmedFillers.map((f) => (
                      <Chip key={f.z} size="small" label={`${f.z}: ${f.before} → ${f.after} (cluster trim)`}
                        sx={{ height: 20, fontSize: 11, ...mono, bgcolor: '#fff', border: `1px solid ${C.warnText}`, color: C.warnText, fontWeight: 700 }} />
                    ))}
                  </Box>
                );
              })()}
              {/* WHY no filler was added — so a dropped/0-filler lane explains itself (no fillers defined vs eligible
                  but 0 drawn because the CFA has no stock / no Norm room / add-on cap). Never a bare "no fillers". */}
              {(() => {
                const fc = d.filler_calc;
                const need = Math.round(P.TRUCK_KEEP_PCT * d.flow.cap);
                const drawn = fc.reduce((a, f) => a + f.alloc, 0);
                const reserved = d.flow.filler_added;   // cases reserved before any drop-return (0 if none)
                let why: { title: string; body: string; warn: boolean } | null = null;
                if (fc.length === 0) {
                  why = d.dropped
                    ? { title: 'No fillers defined for this DB', warn: true,
                        body: `no filler SKUs exist in the filler master for this DB, so there was nothing to top the truck up — the ${d.flow.load_l}-case load stays below the ${need}-case (${pct(P.TRUCK_KEEP_PCT)} of ${d.flow.cap}) floor, so the lane drops.` }
                    : { title: 'No eligible fillers', warn: false,
                        body: 'no filler SKUs are defined for this DB (and none were needed here).' };
                } else if (d.dropped && reserved > 0) {
                  why = { title: `Reserved ${reserved} filler, but the lane still dropped`, warn: true,
                    body: `${fc.length} filler SKU${fc.length === 1 ? ' is' : 's are'} eligible; the engine reserved ${reserved} case${reserved === 1 ? '' : 's'} to top the trucks up (load L reached ${d.flow.load_l}), but that still can't fill even one truck to the ${need}-case (${pct(P.TRUCK_KEEP_PCT)} of ${d.flow.cap}) floor — so the reserved filler was returned to the CFA pool and the lane dropped. Each SKU's reserved amount is shown under “Limited by” below.` };
                } else if (drawn === 0) {
                  const noTruck = fc.every((f) => f.truck <= 0);
                  if (noTruck && !d.dropped) {
                    // trucks already full (packed to 100% / trimmed to full trucks) — no filler was NEEDED. A good outcome.
                    why = { title: 'Trucks already full — no filler needed', warn: false,
                      body: `all ${fc.length} eligible filler${fc.length === 1 ? '' : 's'} hit the truck-room cap (0 spare room): the trucks are packed to 100% / trimmed to the full trucks, so nothing needed topping up. Less filler, as intended.` };
                  } else {
                    const noPool = fc.every((f) => f.pool <= 0);
                    const noRoom = fc.every((f) => f.room <= 0);
                    const noAddon = fc.every((f) => f.addon <= 0);
                    const reason = noTruck ? 'the trucks had no spare room (already full)'
                      : noPool ? 'the CFA holds NO stock of them (CFA pool = 0)'
                        : noRoom ? `they have no ${P.NORM_MULTIPLIER}×Norm room left at the DB`
                          : noAddon ? `the ${pct(P.ADDON_CAP_PCT)} add-on budget is exhausted`
                            : 'each hit one of the four caps (see the table below)';
                    why = { title: `${fc.length} filler${fc.length === 1 ? '' : 's'} eligible, but 0 drawn`, warn: true,
                      body: `${fc.length} filler SKU${fc.length === 1 ? ' is' : 's are'} eligible for this DB, but ${reason} — so no filler cases could be added${d.dropped ? `, and the ${d.flow.load_l}-case load stays below the ${need}-case (${pct(P.TRUCK_KEEP_PCT)}) floor → the lane drops` : ''}.` };
                  }
                }
                const tone = d.dropped ? { bg: C.redP, ac: C.alertRed }        // a drop → red
                  : why?.warn ? { bg: C.warnLight, ac: C.warnText }             // a caution (ships, but 0 filler) → amber
                    : { bg: C.grayP, ac: C.muted };                            // no filler needed (good) → neutral grey
                // fillers the engine RESERVED then RETURNED when the lane dropped — parsed from the reason step3.py stamps
                // ("reserved N cs → returned …") so "this much filler was added, still couldn't ship" is visible up front.
                const reservedFillers = d.dropped
                  ? d.filler_calc.map((f) => { const m = /reserved (\d+)/.exec(f.reason || ''); return m ? { z: f.z, n: parseInt(m[1], 10) } : null; })
                      .filter((x): x is { z: string; n: number } => !!x).sort((a, b) => b.n - a.n)
                  : [];
                const reservedTotal = reservedFillers.reduce((a, f) => a + f.n, 0);
                return why ? (
                  <Box sx={{ mb: 0.75, p: '8px 12px', borderRadius: `${RADIUS.sm}px`, fontSize: 12.5, lineHeight: 1.5,
                    bgcolor: tone.bg, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${tone.ac}`, color: C.slate }}>
                    <b style={{ color: tone.ac }}>▸ {why.title}.</b> {why.body}
                    {reservedFillers.length > 0 && (
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5, mt: 0.75 }}>
                        <Box component="span" sx={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', color: tone.ac }}>Filler added then returned</Box>
                        {reservedFillers.map((f) => (
                          <Box key={f.z} component="span" title={`${f.z} — ${f.n} cases reserved to top the truck up, returned when the lane dropped`}
                            sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 0.35, px: 0.8, py: '2px', borderRadius: 999, bgcolor: '#fff', border: `1px solid ${tone.ac}55`, ...mono, fontSize: 11 }}>
                            <span style={{ color: C.muted, fontSize: 10 }}>{f.z}</span><b style={{ color: tone.ac }}>+{f.n}</b>
                          </Box>
                        ))}
                        <Box component="span" sx={{ ...mono, fontSize: 11.5, color: C.slate }}>= <b style={{ color: tone.ac }}>{reservedTotal}</b> cs added, <b>none shipped</b></Box>
                      </Box>
                    )}
                  </Box>
                ) : null;
              })()}
              {/* the eligible fillers ALWAYS show when any exist — even if 0 were drawn — so the caps (CFA pool, 1.2×Norm,
                  35%) are visible and the user can see exactly which cap blocked each one. */}
              {d.filler_calc.length > 0 && <FillerTable rows={d.filler_calc} />}
              </Box>
              </Box>
            </Drawer>
          </Box>
        );
      })}
      {visibleDbs.length === 0 && <Box sx={{ p: 4, textAlign: 'center', color: C.muted }}>{q.trim() ? `No DBs match “${q}”.` : 'No filler sequence for this run.'}</Box>}
    </Box>
  );
}
