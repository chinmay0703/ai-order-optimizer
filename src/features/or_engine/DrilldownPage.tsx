import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Accordion, AccordionSummary, AccordionDetails, Box, Collapse,
  Table, TableBody, TableCell, TableHead, TableRow,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { downloadXlsxMulti, ExportXlsxButton } from '../../shared/exportXlsx';
import { isTracked, trackedRowSxFor, TRACK_STAR } from '../../demo';
import TruckFillPanel from './TruckFillPanel';
import PageIntro from '../../shared/PageIntro';
import { isUncappedRoom, NO_CAP_LABEL, NO_CAP_TIP } from '../../shared/roomCap';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';
import { useDistributorName } from '../../shared/DistributorName';
import { OE_DEFAULTS } from '../../shared/OeParams';

/* ---------------------------------------------------------------------------
   Drilldown — search ONE reg-zsku and read its Step 1 + Step 2 allocation story, per DB.
   Reads /api/waterfill (or_waterfill_steps). THIS PAGE COVERS STEP 1 + STEP 2 ONLY:
     STEP 1 · Original   the v2 WEIGHT-EQUALISING engine (functional team): Demand = DRR × RF, one water level λ per
                         pool, Weight = tier × DRR share; served DBs are GREEN. Pools that are NOT CONSTRAINED (full SOQ)
                         or have CFA STOCK 0 never enter it — shown with their inputs only.
                         The previous priority-score WATER-FILL view is kept below as COMMENTED code (its columns were
                         retired from the API/table; restoring it needs them back + STEP1_V2 = False in the backend).
     STEP 2 · Substitute the same DB's leftover demand filled by substitutes — shows the Sub score
                         used, the Remaining demand, the amount, and the sources (icon → popup).
   Step 3 (filler + truck) is NOT shown here — it lives on the truck-level page.
   Every constraint/score is on the screen so the allocation explains itself.
--------------------------------------------------------------------------- */
type Row = (string | number)[];
type Pair = [string, number];
interface EligRow { sub: string; rank: number; before: number; room: number; alloc: number; after: number; reason: string;
  norm: number; stk: number; sorig: number; }   // Norm, on-hand stock, Step-1 own order — the room breakdown
interface Stock { stock: number; reserved: number; allocated: number; remaining: number; }
interface Payload { cols: string[]; rows: Row[]; runs: { run: number; channel: string }[]; ledger?: Record<string, Stock>;
  eligCols?: string[]; eligRows?: Row[]; norm_multiplier?: number; addon_cap_pct?: number; step1_v2_active?: boolean;
  drr_available?: boolean; drr_data_date?: string | null; }   // was OE_DAILY_RUN_RATE published for this run's data date?
// or_waterfill_steps columns, read BY NAME from payload.cols (the backend contract = engine STEP_COLS) — a schema change
// can never silently shift a value into the wrong column again.
const COL = {
  run: 'run_no', channel: 'channel', band: 'mrp_band', step: 'step', cfa: 'cfa_id', db: 'db_id', z: 'reg_zsku',
  src: 'source_zsku', tier: 'db_tier', stock: 'stock', norm: 'norm_qty', soq: 'soq_remaining', score: 'score',
  alloc: 'allocated', scoreAfter: 'score_after', tierScore: 'tier_score', snRatio: 'sn_ratio', newScore: 'new_score',
  tierWeight: 'tier_weight',
  // Step-1 v2 weight-equalising trace
  drr: 'drr', drrActual: 'drr_actual', pdpFreq: 'pdp_frequency', rf: 'pdp_freq_in_days', finalStock: 'final_stock', demand: 'demand_qty', floor: 'floor_qty',
  weight: 'weight', psBefore: 'priority_score_before', docBefore: 'days_of_cover_before', pool: 'cfa_pool',
  regime: 'regime', lambda: 'lambda_level', pristine: 'pristine_allocation', adjustment: 'adjustment',
  remainder: 'remainder_units', finalStockAfter: 'final_stock_after', docAfter: 'days_of_cover_after',
  psAfter: 'priority_score_after', fillPct: 'fill_pct', category: 'category',
  // RETIRED water-fill / epsilon columns (no longer in the API): cumulative_score, water_level, fair_share, p1_score,
  // logic_met, s_over_n, priority_score, delta_pscore, epsilon, epsilon_met, share_saliency
} as const;
type ColKey = keyof typeof COL;
const colIx = (cols: string[]) =>
  Object.fromEntries(Object.entries(COL).map(([k, name]) => [k, cols.indexOf(name)])) as Record<ColKey, number>;
// v2 regimes the backend writes for pools that never enter the engine (or_engine/calc/step1.py)
const REGIME_NOT_CONSTRAINED = 'NOT CONSTRAINED';
const REGIME_CFA_STOCK_0 = 'CFA STOCK 0';
const dash = (v: number | string | null | undefined) => (v == null || v === '' ? '—' : v);
const catShort = (c: string | null) => (c ? c.split(' (')[0] : null);   // 'CAPPED (received its full SOQ ask)' → 'CAPPED'
// or_sub_eligibility cols: Run_No, CFA ID, DB ID, reg-zsku, Sub_ZSKU, Rank, Stock_Before, Headroom, Allocated, Stock_After, Reason, Norm, Sub_Stock, Sub_Orig
const EI = { run: 0, cfa: 1, db: 2, z: 3, sub: 4, rank: 5, before: 6, room: 7, alloc: 8, after: 9, reason: 10,
  norm: 11, stk: 12, sorig: 13 };
// every value shown comes straight from or_waterfill_steps / or_sub_eligibility — nothing is recomputed in the browser
const nf = (n: number) => (n ?? 0).toLocaleString();
const num = { textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums', fontFamily: MONO, fontSize: 12.5, verticalAlign: 'top' as const };

// Page chrome — defined at MODULE scope (NOT inside the component) so it isn't a new component identity on every
// render; otherwise React remounts the whole subtree (incl. the search input) each keystroke → the cursor drops.
const Shell = ({ children, eyebrow = 'Drilldown · one reg-zsku, the whole story', title = "How each DB's order is shaped" }:
  { children: React.ReactNode; eyebrow?: string; title?: string }) => (
  <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
    <Box sx={{ maxWidth: 1280, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
      <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>
        {eyebrow}
      </Box>
      <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: '6px 0 8px' }}>
        {title}
      </Box>
      {children}
    </Box>
  </Box>
);

interface DbFlow {
  db: string; tier: number; stock: number; norm: number; soq: number; orig: number;
  tierScore: number; snRatio: number; newScoreV: number;  // Step-2 inputs: Tier_Score = tier×Norm; SN = (Stock+Alloc)÷Norm; New_Score = Tier_Score÷(Stock+Alloc)
  tierWeight: number | null;
  // Step-1 v2 weight-equalising trace (straight from or_waterfill_steps — nothing recomputed in the browser)
  drr: number | null; drrActual: number | null; pdpFreq: string | null; rf: number | null; finalStock: number | null; demand: number | null; floor: number | null;
  weight: number | null; psBefore: number | null; docBefore: number | null; pristine: number | null;
  adjustment: number | null; finalStockAfter: number | null; docAfter: number | null; psAfter: number | null;
  fillPct: number | null; category: string | null;
  // ── WATER-FILL fields (retired view, kept for reference) ──
  // score: number | null; cum: number | null; sOverN: number | null; priorityScore: number | null;
  // fair: number | null; p1: number | null; met: number | null;
  // epsilon: number | null; epsilonMet: number | null; saliency: number | null;
  newSoq: number; newSc: number;          // from DB: SOQ_Remaining − Allocated, and step-1 Score_After
  gRank?: number;                          // GLOBAL Step-2 position (New score rank across ALL reg-zskus this run)
  soq2: number;                            // New SOQ (Step-2 demand) = SOQ − Allocated (SOQ already nets DB stock)
  sub: number; afterSc: number; subPairs: Pair[]; elig: EligRow[];
}
interface ZFlow { z: string; served: number; dbs: number; orig: number; sub: number; full: boolean; rows: DbFlow[];  // full = NOT CONSTRAINED (pool ≥ combined SOQ) → gave all
  regime: string | null; lambda: number | null; pool: number | null; remainder: number | null; }   // Step-1 v2 pool: regime, water level λ, rationed pool, remainder units
  // water: number;   // WATER-FILL (retired): the waterline's fair share L
type Pop = { top: number; left: number; title: string; meta: string; pairs?: Pair[]; elig?: EligRow[]; tone: string } | null;

export default function DrilldownPage({ date, cfa = '' }: { date?: string; cfa?: string }) {
  // CFA is scoped GLOBALLY from the run-context header (allocation runs CFA-wise) — no per-page CFA picker.
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from data===null: a run with no
  const [err, setErr] = useState<string | null>(null);   // water-fill rows, or a failure, would then spin forever
  const [nonce, setNonce] = useState(0);           // bumped by the error Retry to re-run the effect
  const [run, setRun] = useState(1);
  const [q, setQ] = useState('');
  const [subsOnly, setSubsOnly] = useState(false);   // filter to reg-zskus where substitutes were actually used (sub > 0)
  const [pop, setPop] = useState<Pop>(null);
  const [openZ, setOpenZ] = useState<Record<string, boolean>>({});   // controlled accordions — only a header click toggles them
  const [openElig, setOpenElig] = useState<Record<string, boolean>>({});   // per-reg-zsku "eligible substitutes" collapse
  const [tab, setTab] = useState<'wf' | 'truck'>('wf');   // ① water-fill reg-zsku detail · ② Step-1 truck fill (CFA×DB)
  const descOf = useRegZskuDesc();   // reg-zsku → old_material_description (served lookup)
  const dbNameOf = useDistributorName();   // DB code → Customer Name (served off db_master; nothing stored)

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null); setLoading(true);
    api.waterfill(0, date).then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, nonce]);

  const flows: ZFlow[] = useMemo(() => {
    if (!data) return [];
    const I = colIx(data.cols);
    const rows = data.rows.filter((r) => r[I.run] === run && String(r[I.cfa]) === cfa);   // CFA-wise: Step 1 + Step 2 for ONE CFA
    const subByZD = new Map<string, { alloc: number; src: Map<string, number>; after: number }>();
    for (const r of rows) {
      if (r[I.step] !== 2) continue;
      const key = `${r[I.z]}|${r[I.db]}`;
      const s = subByZD.get(key) ?? { alloc: 0, src: new Map<string, number>(), after: r[I.scoreAfter] as number };
      s.alloc += r[I.alloc] as number;
      s.after = r[I.scoreAfter] as number;            // step-2 Score_After — the after-substitution priority (same per line)
      if (r[I.src]) s.src.set(r[I.src] as string, (s.src.get(r[I.src] as string) ?? 0) + (r[I.alloc] as number));
      subByZD.set(key, s);
    }
    // every eligible substitute per (reg-zsku | DB): name · rank · stock before/after · allocated, from /api/waterfill
    const eligByZD = new Map<string, EligRow[]>();
    for (const e of data.eligRows ?? []) {
      if (e[EI.run] !== run || String(e[EI.cfa]) !== cfa) continue;
      const key = `${e[EI.z]}|${e[EI.db]}`;
      const list = eligByZD.get(key) ?? [];
      list.push({ sub: e[EI.sub] as string, rank: e[EI.rank] as number, before: e[EI.before] as number,
        room: e[EI.room] as number, alloc: e[EI.alloc] as number, after: e[EI.after] as number, reason: e[EI.reason] as string,
        norm: e[EI.norm] as number, stk: e[EI.stk] as number, sorig: e[EI.sorig] as number });
      eligByZD.set(key, list);
    }
    for (const list of eligByZD.values()) list.sort((a, b) => a.rank - b.rank);
    const byZ = new Map<string, ZFlow>();
    for (const r of rows) {
      if (r[I.step] !== 1) continue;
      const z = r[I.z] as string; const db = r[I.db] as string;
      let zf = byZ.get(z);
      if (!zf) { zf = { z, served: 0, dbs: 0, orig: 0, sub: 0, full: false, rows: [],
        regime: (r[I.regime] as string | null) ?? null, lambda: r[I.lambda] as number | null,
        pool: r[I.pool] as number | null, remainder: r[I.remainder] as number | null }; byZ.set(z, zf); }
      const sub = subByZD.get(`${z}|${db}`);
      const orig = r[I.alloc] as number;
      const newSc = r[I.scoreAfter] as number;            // step-1 Score_After = priority AFTER the original allocation
      zf.rows.push({
        db, tier: r[I.tier] as number, stock: r[I.stock] as number, norm: r[I.norm] as number, soq: r[I.soq] as number,
        orig,
        tierScore: r[I.tierScore] as number, snRatio: r[I.snRatio] as number, newScoreV: r[I.newScore] as number,
        tierWeight: r[I.tierWeight] as number | null,
        drr: r[I.drr] as number | null, drrActual: I.drrActual >= 0 ? (r[I.drrActual] as number | null) : null, pdpFreq: (r[I.pdpFreq] as string | null) ?? null, rf: r[I.rf] as number | null, finalStock: r[I.finalStock] as number | null,
        demand: r[I.demand] as number | null, floor: r[I.floor] as number | null, weight: r[I.weight] as number | null,
        psBefore: r[I.psBefore] as number | null, docBefore: r[I.docBefore] as number | null,
        pristine: r[I.pristine] as number | null, adjustment: r[I.adjustment] as number | null,
        finalStockAfter: r[I.finalStockAfter] as number | null, docAfter: r[I.docAfter] as number | null,
        psAfter: r[I.psAfter] as number | null, fillPct: r[I.fillPct] as number | null,
        category: (r[I.category] as string | null) ?? null,
        // ── WATER-FILL fields (retired — the columns are no longer served) ──
        // score: r[I.score] as number | null, cum: r[I.cum] as number | null,
        // sOverN: …tier_wt ÷ priority…, priorityScore: r[I.priorityScore] as number | null,
        // fair: r[I.fair] as number | null, p1: r[I.p1] as number | null, met: r[I.met] as number | null,
        // epsilon: r[I.epsilon] as number | null, epsilonMet: r[I.epsilonMet] as number | null, saliency: r[I.saliency] as number | null,
        newSoq: (r[I.soq] as number) - orig, newSc,            // SOQ_Remaining − Allocated, both from the DB
        soq2: Math.max(0, (r[I.soq] as number) - orig),   // New SOQ (Step-2 demand) = SOQ − Allocated; SOQ already nets DB stock, so DON'T subtract stock again (= the engine's rem_soq the substitute fills)

        sub: sub?.alloc ?? 0, afterSc: sub?.after ?? newSc, subPairs: sub ? [...sub.src] : [],
        elig: eligByZD.get(`${z}|${db}`) ?? [],
      });
      zf.dbs++; if (orig > 0) zf.served++; zf.orig += orig; zf.sub += sub?.alloc ?? 0;
    }
    let out = [...byZ.values()];
    // STEP-1 v2: NOT CONSTRAINED pools gave everyone full SOQ (biggest ask first); rationed pools list the neediest
    // DB first (v2 priority BEFORE = tier × DRR ÷ Final Stock). Every value is read from or_waterfill_steps.
    out.forEach((zf) => {
      zf.full = zf.regime === REGIME_NOT_CONSTRAINED;
      if (zf.full) { zf.rows.sort((a, b) => b.soq - a.soq); return; }
      zf.rows.sort((a, b) => (b.psBefore ?? -1) - (a.psBefore ?? -1) || b.soq - a.soq);
    });
    // ── WATER-FILL view (retired Step-1) — kept for reference ──
    // // Cumulative / Fair share / P+1 / Logic met were recomputed HERE from each DB's score and the reserved pool.
    // out.forEach((zf) => {
    //   zf.full = zf.rows.length > 0 && zf.rows[0].score == null;
    //   if (zf.full) { zf.rows.sort((a, b) => b.soq - a.soq); return; }
    //   zf.rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));   // still sort by priority score
    //   const pool = data.ledger?.[`${cfa}|${run}|${zf.z}`]?.reserved ?? 0;
    //   let cumS = 0;
    //   zf.rows.forEach((r, i) => {
    //     cumS += r.soq;                                           // CUMULATIVE SOQ
    //     const fairRaw = (cumS - pool) / (i + 1);
    //     r.cum = cumS;
    //     r.fair = +fairRaw.toFixed(2);
    //     r.p1 = i + 1 < zf.rows.length ? (zf.rows[i + 1].score ?? 0) : 0;  // P+1 = the next DB's PRIORITY SCORE
    //     r.met = fairRaw >= (r.p1 ?? 0) ? 1 : 0;                  // Logic Met: fair share ≥ next priority score
    //   });
    // });
    // GLOBAL Step-2 rank: every (reg-zsku × db) line with leftover demand this run, New score DESC — the REAL order
    // the engine fills substitutes across ALL reg-zskus. The per-reg-zsku "#1/#2" below is only local to that view.
    const cand: { key: string; ns: number }[] = [];
    out.forEach((zf) => zf.rows.forEach((r) => { if (r.soq - r.orig > 0) cand.push({ key: `${zf.z}|${r.db}`, ns: r.newSc }); }));
    cand.sort((a, b) => b.ns - a.ns);
    const gr = new Map<string, number>();
    cand.forEach((c, i) => gr.set(c.key, i + 1));
    out.forEach((zf) => zf.rows.forEach((r) => { r.gRank = gr.get(`${zf.z}|${r.db}`); }));
    // EVERY whitespace-separated token must match (AND), so "0000121568 66099" finds that DB *and* that reg-zsku.
    // Reg-zsku description and distributor NAME are searchable too — a name shown on screen must be findable.
    const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length) {
      out = out.filter((zf) => {
        const zHay = `${zf.z} ${descOf(zf.z)}`.toLowerCase();
        return tokens.every((t) => zHay.includes(t)
          || zf.rows.some((r) => `${r.db} ${dbNameOf(r.db)}`.toLowerCase().includes(t)));
      });
    }
    if (subsOnly) out = out.filter((zf) => zf.sub > 0);            // only reg-zskus where substitutes were used
    // ORDER: reg-zskus the CFA actually stocks first (most allocated first), then every 0-CFA-stock one at the
    // BOTTOM. Those are priced-but-empty lines — they never entered the water-fill and can only ever be filled by a
    // substitute — so they are the tail of the story, not the head. (They grew a lot once demanded-but-unstocked
    // reg-zskus started being priced into cfa_reservation; the amber "0 CFA stock" count above tallies them.)
    const cfaStockOf = (z: string) => data.ledger?.[`${cfa}|${run}|${z}`]?.stock ?? 0;
    out.sort((a, b) => (Number(cfaStockOf(b.z) > 0) - Number(cfaStockOf(a.z) > 0))
                       || (b.orig + b.sub) - (a.orig + a.sub));
    return out;
  }, [data, run, cfa, q, subsOnly, descOf, dbNameOf]);

  // ① Water-fill detail (reg-zsku)  ·  ② Step-1 Truck Fill (CFA × DB) — the functional-team lane view that sits
  // right here, after the water-fill and before substitution. Tab ② is self-contained (its own fetch), so it
  // renders regardless of the water-fill payload's load/error state.
  const tabBar = (
    <Box sx={{ display: 'flex', gap: 0.5, mb: 2, borderBottom: `1px solid ${C.rule}` }}>
      {([['wf', '① Step-1 fair share detail'], ['truck', '② Step-1 Truck Fill · CFA × DB']] as const).map(([k, label]) => (
        <Box key={k} onClick={() => setTab(k)}
          sx={{ cursor: 'pointer', px: 1.75, py: 1, fontSize: 13, fontWeight: 800, color: tab === k ? C.navy : C.muted,
            borderBottom: `2px solid ${tab === k ? C.gold : 'transparent'}`, mb: '-1px',
            '&:hover': { color: C.navy } }}>{label}</Box>
      ))}
    </Box>
  );
  if (tab === 'truck') return <Shell eyebrow="Step 1 · truck fill — after water-fill, before substitution" title="Step-1 Truck Fill — CFA × DB">{tabBar}<TruckFillPanel mode="step1" date={date} /></Shell>;
  if (err) return <Shell>{tabBar}<ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (loading) return <Shell>{tabBar}<PageSkeleton kpis={0} rows={8} /></Shell>;
  // the whole water-fill view is filtered to the GLOBAL header CFA — with none picked there is nothing to draw
  if (!cfa) return <Shell>{tabBar}<EmptyState title="Pick a CFA to continue"
    hint="This drilldown is scoped to one CFA. Choose one in the run-context bar above." /></Shell>;
  if (!data) return <Shell>{tabBar}<EmptyState title="No Step-1 detail for this run"
    hint="This run date returned no Step 1 / Step 2 allocation rows. Try another run date, or run the pipeline first." /></Shell>;

  const mult = data.norm_multiplier ?? OE_DEFAULTS.NORM_MULTIPLIER;   // LIVE cap multiplier from the backend (oe_parameters); fallback = shared default
  const addonP = Math.round((data.addon_cap_pct ?? OE_DEFAULTS.ADDON_CAP_PCT) * 100);   // LIVE add-on budget % from the backend (oe_parameters); fallback = shared default
  // const epsOn = !!data.epsilon_active;   // WATER-FILL (retired): epsilon columns flag
  // reg-zskus with no stock in this pool never entered the v2 engine (nothing to ration) — flagged amber below so a
  // 0-served row reads as "no stock to give", not "the engine missed it".
  const isNoStock = (zf: ZFlow) => zf.regime === REGIME_CFA_STOCK_0 || ((data.ledger?.[`${cfa}|${run}|${zf.z}`]?.stock ?? 0) <= 0);
  const noStockCount = flows.filter(isNoStock).length;

  const pill = (active: boolean) => ({
    cursor: 'pointer', px: 1.5, py: 0.6, fontSize: 13, fontWeight: 700, borderRadius: `${RADIUS.sm}px`,
    border: `1px solid ${active ? C.navy : C.rule}`, bgcolor: active ? C.navy : C.white, color: active ? '#fff' : C.slate,
  });
  const grp = (label: string, span: number, bg: string, fg: string) => (
    <TableCell colSpan={span} align="center" sx={{ bgcolor: bg, color: fg, fontFamily: SANS, fontWeight: 800,
      fontSize: 10.5, letterSpacing: '.05em', textTransform: 'uppercase', borderBottom: `2px solid ${fg}` }}>{label}</TableCell>
  );
  let _subKey = 0;
  const sub = (h: string, a: 'left' | 'right', tint?: string) => (
    <TableCell key={`h${_subKey++}-${h}`} align={a} sx={{ fontFamily: SANS, bgcolor: tint, whiteSpace: 'nowrap' }}>{h}</TableCell>
  );
  // a compact "N sources" chip that opens the breakdown popup
  // substitute chip → popup of EVERY eligible sub: rank · name · stock before · allocated · stock after
  const subChip = (elig: EligRow[], title: string, meta: string) => (
    elig.length
      ? <Box onClick={(e) => { e.stopPropagation(); setPop({ top: e.clientY, left: e.clientX, title, meta, elig, tone: C.success }); }}
          sx={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 0.4, px: 0.85, py: 0.3,
            borderRadius: 999, bgcolor: C.successLight, color: C.success, fontWeight: 800, fontSize: 11, '&:hover': { filter: 'brightness(0.94)' } }}>
          <FormatListBulletedIcon sx={{ fontSize: 13 }} /> {elig.length}
        </Box>
      : <span style={{ color: C.muted }}>—</span>
  );

  return (
    <Shell>
      {tabBar}
      <PageIntro>
        Search a reg-zsku (e.g. <b>AP-66202</b>) and open it. This page shows the <b>first two allocation steps only</b>. Each DB row reads left to right —
        <b style={{ color: C.navy }}> Step 1</b> original (v2 weight-equalising fair share; served rows green) →
        <b style={{ color: C.success }}> Step 2</b> substitutes (click the chip for the sources). Step 3 fillers &amp; the truck rule live on the truck page, not here.
        {' '}These are the <b>pre-trim</b> Step-1+2 numbers; the final shipped qty can be lower — and for <b>transshipment / cluster</b> DBs a
        {' '}post-cascade <b>cluster primary trim</b> can claw back even this Step-1 Original (see the Cluster Primary / Final Order pages for shipped).
      </PageIntro>

      {data.drr_available === false && (
        <Box role="alert" sx={{ mb: 1.5, borderLeft: `3px solid ${C.warnText}`, bgcolor: C.warnLight, borderRadius: `${RADIUS.sm}px`, px: 1.5, py: 1 }}>
          <Box sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.warnText, mb: 0.25 }}>Daily run rate not available</Box>
          <Box sx={{ fontSize: 12.5, color: C.slate, lineHeight: 1.5 }}>
            OE_DAILY_RUN_RATE was <b>not published for data date {data.drr_data_date ?? 'of this run'}</b>. No other date is used, so
            Step 1 ran with <b>DRR = 0</b> for every distributor (Demand, Floor and Weight are 0). Re-run once the data team publishes it.
          </Box>
        </Box>
      )}
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mb: 1 }}>
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, px: 1.25, py: 0.5, borderRadius: `${RADIUS.sm}px`, bgcolor: C.navy, color: '#fff' }}>
          <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', opacity: 0.75 }}>CFA</span>
          <span style={{ fontSize: 13, fontWeight: 800, fontFamily: 'Consolas, monospace' }}>{cfa || '—'}</span>
        </Box>
        <Box component="span" sx={{ fontSize: 11.5, color: C.muted }}>allocation runs CFA-wise — pick the CFA in the run-context header above</Box>
      </Box>
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', mb: 1.5 }}>
        <Box sx={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.05em' }}>Run</Box>
        {data.runs.map((r) => <Box key={r.run} sx={pill(run === r.run)} onClick={() => setRun(r.run)}>{r.run} · {r.channel}</Box>)}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a reg-zsku — e.g. AP-66202"
          style={{ flex: 1, minWidth: 240, padding: '8px 12px', fontSize: 14, fontFamily: MONO, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
        {q && <Box sx={pill(false)} onClick={() => setQ('')} title="Clear the search field">✕ Clear</Box>}
        <Box sx={pill(subsOnly)} onClick={() => setSubsOnly((v) => !v)} title="Show only reg-zskus where substitutes were used (sub > 0)">{subsOnly ? '✓ ' : ''}Subs used</Box>
        <ExportXlsxButton label="Export Excel" onClick={() => downloadXlsxMulti('drilldown_step1_2', [
          { name: 'Step 1 v2 fair share', headers: data.cols, rows: data.rows },
          { name: 'Step 2 substitutes', headers: data.eligCols ?? [], rows: data.eligRows ?? [] },
        ])} />
      </Box>
      <Box sx={{ fontSize: 12, color: C.muted, mb: 1 }}>{nf(flows.length)} reg-zskus{subsOnly ? ' with substitutes used' : ''}{q ? ` matching “${q}”` : ''}{noStockCount ? <> · <b style={{ color: C.warnText }}>{nf(noStockCount)}</b> with 0 CFA stock <span style={{ color: C.warnText }}>(amber — nothing to allocate)</span></> : ''}</Box>

      {flows.map((zf) => {
        const led = data.ledger?.[`${cfa}|${run}|${zf.z}`];
        const noStock = isNoStock(zf);   // CFA STOCK 0 → this pool never entered the v2 engine (nothing to allocate)
        return (
        <Accordion key={zf.z} disableGutters elevation={0}
          expanded={openZ[zf.z] ?? (flows.length <= 2)} onChange={(_, ex) => setOpenZ((p) => ({ ...p, [zf.z]: ex }))}
          slotProps={{ transition: { unmountOnExit: true } }}
          sx={{ border: `1px solid ${noStock ? C.gold : C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, mb: 0.85, '&:before': { display: 'none' } }}>
          <AccordionSummary expandIcon={<ChevronRightIcon sx={{ fontSize: 18 }} />}
            sx={{ flexDirection: 'row-reverse', gap: 1.25, px: 1.75, borderRadius: `${RADIUS.md}px`,
              bgcolor: noStock ? C.amberP : undefined, borderLeft: noStock ? `3px solid ${C.gold}` : undefined,
              '& .MuiAccordionSummary-expandIconWrapper.Mui-expanded': { transform: 'rotate(90deg)' },
              '& .MuiAccordionSummary-content': { alignItems: 'center', gap: 1.5, my: 0.9 } }}>
            <Box sx={{ fontWeight: 700, color: C.navy, fontFamily: MONO, fontSize: 15 }}>{zf.z}</Box>
            {descOf(zf.z) && <Box sx={{ fontSize: 12.5, color: C.muted }} title={descOf(zf.z)}>{descOf(zf.z)}</Box>}
            {noStock && <Box sx={{ px: 0.85, py: 0.2, bgcolor: C.white, color: C.navy, border: `1px solid ${C.gold}`,
              fontWeight: 800, fontSize: 10, letterSpacing: '.04em', textTransform: 'uppercase', borderRadius: `${RADIUS.sm}px` }}>0 CFA stock</Box>}
            <Box sx={{ flex: 1 }} />
            <Box sx={{ fontSize: 12.5, color: C.muted }}>
              served <b style={{ color: C.success }}>{zf.served}</b>/{zf.dbs} DBs · original <b style={{ color: C.navy }}>{nf(zf.orig)}</b> + sub <b style={{ color: C.success }}>{nf(zf.sub)}</b> cs
            </Box>
            {noStock
              ? <Box sx={{ px: 1, py: 0.3, bgcolor: C.gold, color: C.navy, fontWeight: 800, fontSize: 12, borderRadius: `${RADIUS.sm}px` }}
                  title={`${zf.z} has no CFA stock in this pool this run, so it never entered the v2 engine — no allocation was possible (not an engine miss).`}>not allocated · CFA stock 0</Box>
              : zf.full
                ? <Box sx={{ px: 1, py: 0.3, bgcolor: C.successLight, color: C.success, fontWeight: 800, fontSize: 12, borderRadius: `${RADIUS.sm}px` }}
                    title="Reserved pool ≥ combined SOQ — no rationing: every DB got its full SOQ (the v2 engine was not run).">not constrained · full SOQ</Box>
                : <Box sx={{ px: 1, py: 0.3, bgcolor: C.warnLight, color: C.warnText, fontWeight: 800, fontSize: 12, borderRadius: `${RADIUS.sm}px` }}
                    title={`v2 regime ${zf.regime} — the pool's single water level λ (each DB's continuous share = Weight ÷ λ − Final Stock, clipped to [floor, SOQ]).`}>
                    {zf.regime ? zf.regime.toLowerCase() : 'regime —'} · λ {dash(zf.lambda)}</Box>}
            {/* WATER-FILL header badge (retired): water level {zf.water} */}
          </AccordionSummary>
          <AccordionDetails sx={{ px: 0.5, py: 0.5, overflowX: 'auto' }}>
            {(() => {
              const s = led;
              if (!s) return null;
              const cell = (label: string, val: number, fg: string, title?: string) => (
                <Box title={title} sx={{ flex: 1, px: 1.25, py: 0.75, borderRight: `1px solid ${C.rule}` }}>
                  <Box sx={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.muted }}>{label}</Box>
                  <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 18, color: fg, lineHeight: 1.1 }}>{nf(val)}</Box>
                </Box>
              );
              // Combined SOQ = this reg-zsku's TOTAL demand across every DB (Σ SOQ over all rows) — computed in the browser.
              const combinedSoq = zf.rows.reduce((acc, r) => acc + (r.soq || 0), 0);
              return (
                <Box sx={{ display: 'flex', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px`, bgcolor: C.cream, mx: 1, mb: 1, '& > :last-child': { borderRight: 'none' } }}>
                  {cell('Combined SOQ · all DBs', combinedSoq, C.slate, `DB-level combined demand for ${zf.z} — the sum of SOQ across all ${zf.dbs} distributors of this reg-zsku (computed in the browser).`)}
                  {cell('CFA stock (overall)', s.stock, C.navy)}{cell('Reserved · this run', s.reserved, C.warnText)}
                  {/* Step 1 (original) and Step 2 (substitute) shown SEPARATELY — NOT the shipped number: Step-3 truck-trim AND,
                      for transshipment/cluster DBs, a post-cascade cluster primary trim can reduce even these. See Cluster Primary. */}
                  {cell('Allocated · step 1 · original', zf.orig, C.navy)}{cell('Allocated · step 2 · substitute', zf.sub, C.success)}{cell('Unallocated · this run', Math.max(0, s.reserved - zf.orig - zf.sub), (s.reserved - zf.orig - zf.sub) > 0 ? C.slate : C.muted)}
                </Box>
              );
            })()}
            {/* Step 1 — navy callout, ties to the navy "Step 1 · Original" table group */}
            <Box sx={{ mx: 1, mb: 0.75, borderLeft: `3px solid ${C.navy}`, bgcolor: C.navyP, borderRadius: `${RADIUS.sm}px`, px: 1.25, py: 0.85 }}>
              <Box sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.navy, mb: 0.35 }}>Allocation · Step 1 — Original (v2 weight-equalising fair share)</Box>
              <Box sx={{ fontSize: 12, color: C.slate, lineHeight: 1.5 }}>
                {noStock ? (
                  <>No CFA stock in this pool — <b>nothing to ration</b>, so the v2 engine is not run and every DB gets <b>0</b>. DRR and PDP frequency are still shown for reference.</>
                ) : zf.full ? (
                  <>Reserved CFA pool ≥ combined SOQ for this reg-zsku — <b>no rationing needed</b>, so the v2 engine is skipped and every DB gets its <b>full SOQ</b>. DRR / PDP frequency / Final stock are shown; the fair-share columns are <b>not calculated</b> for these lines.</>
                ) : (
                  <><b>DRR</b> = the daily run rate, or <b>0.1 when it is 0</b> (the actual value is in DRR (actual)); <b>Demand = DRR × PDP freq (days)</b>; <b>Final stock = SOH + SIT</b> (0 → 1 case). <b>Floor = min(SOQ, max(0, Demand − Final stock))</b> is protected first (severe scarcity: the pool is rationed toward the floors only). <b>Weight = tier weight × (DRR ÷ ΣDRR of the pool)</b>. One water level <b>λ = {dash(zf.lambda)}</b> is found by bisection so that Σ clip(<b>Weight ÷ λ − Final stock</b>, floor, SOQ) = the pool (<b>{dash(zf.pool)}</b>) — this <b>equalises Weight ÷ (stock after)</b> across DBs. Then whole cases: each DB's <b>pristine</b> rounding, and the pool-wide <b>adjustment</b> (remainder {dash(zf.remainder)}) by priority. <b style={{ color: C.warnText }}>⚙ Original</b> and every column come straight from the engine (or_waterfill_steps).</>
                )}
                {/* WATER-FILL callout (retired): Ranked by priority score (tier weight ÷ (stock ÷ norm)) → waterline where
                    Fair share = (SOQ Cum − pool) / k ≥ the next DB's priority score; served rows get SOQ − L (full SOQ when
                    L > SOQ); rows below the waterline get 0. */}
              </Box>
            </Box>
            {/* Step 2 — green callout, ties to the green "Step 2 · Substitute" table group */}
            <Box sx={{ mx: 1, mb: 1, borderLeft: `3px solid ${C.success}`, bgcolor: C.successLight, borderRadius: `${RADIUS.sm}px`, px: 1.25, py: 0.85 }}>
              <Box sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.success, mb: 0.35 }}>Step 2 · Substitution</Box>
              <Box sx={{ fontSize: 12, color: C.slate, lineHeight: 1.5 }}>
                Substitutes fill the New SOQ (SOQ − Original) <b>rank by rank</b> (rank 1 first); when the same substitute is contested by several DBs at the same rank, the higher <b>New score</b> wins. Each grant is capped by demand, CFA supply, the sub&apos;s {mult}×Norm room, and the DB&apos;s {addonP}% add-on budget. <b>New score = Tier score ÷ [(Stock+Original)÷Norm]</b>. Click a chip for the source reg-zskus. <i style={{ color: C.muted }}>(No fillers here — Step 3 fillers live on the truck page.)</i>
              </Box>
            </Box>
            <Box sx={{ overflowX: 'auto', width: '100%' }}>
            <Table size="small" sx={{ minWidth: 'max-content', '& td': { py: 0.5, px: 1.1, whiteSpace: 'nowrap' }, '& th': { py: 0.5, px: 1.1, whiteSpace: 'nowrap' } }}>
              <TableHead>
                <TableRow>
                  {grp('Distributor · demand', 5, C.grayP, C.muted)}
                  {grp('Step 1 · v2 inputs', 8, C.amberP, C.warnText)}
                  {grp('Step 1 · v2 weight equalisation', 5, C.navyP, C.navy)}
                  {grp('Step 1 · Allocated', 6, C.warnLight, C.warnText)}
                  {grp('Step 2 · Substitute (rank-based)', 7, C.successLight, C.success)}
                  {/* WATER-FILL groups (retired): Priority score · tier ÷ (S/N) [3] · Step 1 · Original (water-fill on
                      SOQ cumulative) [4] · Step 1 · Epsilon (spread-fair) [3] · Step 1 · Allocated [⚙ Original, ⚙ SOQ − Alloc] */}
                </TableRow>
                <TableRow>
                  {sub('DB', 'left')}{sub('Tier', 'right')}{sub('Stock', 'right')}{sub('Norm', 'right')}{sub('SOQ', 'right')}
                  {sub('Tier wt', 'right', C.amberP)}{sub('Final stock', 'right', C.amberP)}{sub('DRR (used)', 'right', C.amberP)}{sub('DRR (actual)', 'right', C.amberP)}{sub('PDP frequency', 'left', C.amberP)}{sub('PDP freq (days)', 'right', C.amberP)}{sub('Demand', 'right', C.amberP)}{sub('Floor', 'right', C.amberP)}
                  {sub('Weight', 'right', C.navyP)}{sub('Priority before', 'right', C.navyP)}{sub('Days cover before', 'right', C.navyP)}{sub('Pristine', 'right', C.navyP)}{sub('Adjustment', 'right', C.navyP)}
                  {sub('⚙ Original', 'right', C.warnLight)}{sub('Stock after', 'right', C.warnLight)}{sub('Days cover after', 'right', C.warnLight)}{sub('Priority after', 'right', C.warnLight)}{sub('Fill %', 'right', C.warnLight)}{sub('Category', 'left', C.warnLight)}
                  {/* WATER-FILL sub-headers (retired): Tier wt · S/N · Priority score · SOQ Cum · Fair share · P+1 Score ·
                      Logic met? · Epsilon · Epsilon met? · Saliency · ⚙ Original · ⚙ SOQ − Alloc */}
                  {sub('New SOQ', 'right', C.successLight)}{sub('Tier score', 'right', C.successLight)}{sub('(Stock+Orig)÷Norm', 'right', C.successLight)}{sub('New score', 'right', C.successLight)}{sub('Substitute', 'right', C.successLight)}{sub('After score', 'right', C.successLight)}{sub('Sources', 'left', C.successLight)}
                </TableRow>
              </TableHead>
              <TableBody>
                {zf.rows.map((r, i) => {
                  const served = r.orig > 0;                      // got a Step-1 ORIGINAL (row highlight)
                  // ENTERS STEP 2 = any line with demand still open after step 1 — orig 0 included. Step 2 gates
                  // on open SOQ alone (or_engine.calc.step2), so these columns must not be dashed out for a DB
                  // that got nothing in step 1: it is substitutable, and New SOQ is exactly what a sub fills.
                  const inStep2 = r.soq - r.orig > 0;
                  return (
                    <TableRow key={i} sx={{ bgcolor: served ? C.successLight : undefined, ...trackedRowSxFor(r.db) }}>
                      <TableCell sx={{ fontFamily: MONO, fontSize: 12, fontWeight: served ? 700 : 400, color: served ? C.navy : C.muted, verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                        {isTracked(r.db) ? TRACK_STAR + ' ' : ''}{r.db}
                        {/* distributor NAME under the code — served from /distributor_names, never wrapped */}
                        {dbNameOf(r.db) && (
                          <Box sx={{ fontFamily: SANS, fontSize: 11, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 190 }}
                            title={dbNameOf(r.db)}>{dbNameOf(r.db)}</Box>
                        )}
                      </TableCell>
                      <TableCell sx={num}>T{r.tier}</TableCell>
                      <TableCell sx={num}>{r.stock}</TableCell>
                      <TableCell sx={num}>{r.norm}</TableCell>
                      <TableCell sx={num}>{r.soq}</TableCell>
                      {/* ── Step 1 · v2 inputs ── */}
                      <TableCell sx={{ ...num, bgcolor: C.amberP }} title="Tier weight = the DB's Final_Tier_Score (a missing / 0 tier is floored to the pool's smallest positive tier — the engine needs tier > 0).">{dash(r.tierWeight)}</TableCell>
                      <TableCell sx={{ ...num, bgcolor: C.amberP }} title="Final stock = SOH + SIT; a 0 stock is taken as 1 case (engine input).">{dash(r.finalStock)}</TableCell>
                      <TableCell sx={{ ...num, bgcolor: C.amberP, fontWeight: r.drrActual === 0 ? 700 : undefined, color: r.drrActual === 0 ? C.warnText : undefined }} title="DRR used by Step 1 = the daily run rate (L3M primary cases ÷ 90), or 0.1 when the actual DRR is 0 / missing — so the distributor still takes part in the fair share.">{dash(r.drr)}</TableCell>
                      <TableCell sx={{ ...num, bgcolor: C.amberP }} title="Actual DRR as staged from daily_run_rate (S3 OE_DAILY_RUN_RATE). 0 = no L3M primary sales or no row — Step 1 then uses 0.1.">{dash(r.drrActual)}</TableCell>
                      <TableCell sx={{ fontSize: 12, whiteSpace: 'nowrap', bgcolor: C.amberP }} title="The distributor's PDP frequency (pdp_master, staged from S3 OE_PDP_MASTER) — converted to the days on the right. Blank when the DB has no PDP row for this CFA (RF 0).">{r.pdpFreq || '—'}</TableCell>
                      <TableCell sx={{ ...num, bgcolor: C.amberP }} title="PDP frequency in days = RF (pdp_master, staged from S3 OE_PDP_MASTER: Daily 1 · Thrice a week 2 · Twice a week 3 · Weekly 7 · Every 10 days 10 · Fortnightly / Monthly 14).">{dash(r.rf)}</TableCell>
                      <TableCell sx={{ ...num, bgcolor: C.amberP }} title="Demand = DRR × PDP freq (days). Blank when the pool did not enter the engine.">{dash(r.demand)}</TableCell>
                      <TableCell sx={{ ...num, bgcolor: C.amberP }} title="Floor = min(SOQ, max(0, Demand − Final stock)) — the safety need protected first.">{dash(r.floor)}</TableCell>
                      {/* ── Step 1 · v2 weight equalisation ── */}
                      <TableCell sx={{ ...num, color: C.slate }} title="Weight = tier weight × (DRR ÷ ΣDRR of the pool) — the DB's claim on the pool.">{dash(r.weight)}</TableCell>
                      <TableCell sx={{ ...num, color: C.navy, fontWeight: 800 }} title="Priority before = tier weight ÷ (Final stock ÷ DRR) = tier × DRR ÷ Final stock (the tier weight when DRR = 0). Higher = needier.">{dash(r.psBefore)}</TableCell>
                      <TableCell sx={{ ...num, color: C.muted }} title="Days of cover before = Final stock ÷ DRR (blank when DRR = 0).">{dash(r.docBefore)}</TableCell>
                      <TableCell sx={{ ...num, color: C.slate }} title="Pristine = this DB's own whole-case rounding of its continuous share (Weight ÷ λ − Final stock, clipped to [floor, SOQ]), before the pool-wide correction.">{dash(r.pristine)}</TableCell>
                      <TableCell sx={{ ...num, color: (r.adjustment ?? 0) > 0 ? C.success : (r.adjustment ?? 0) < 0 ? C.alertRed : C.muted }} title="Adjustment = cases gained (+) or given up (−) when the pool-wide remainder was handed out / taken back by priority.">{r.adjustment == null ? '—' : (r.adjustment > 0 ? `+${r.adjustment}` : r.adjustment)}</TableCell>
                      {/* ── Step 1 · Allocated ── */}
                      <TableCell sx={{ ...num, color: served ? C.navy : C.muted, fontWeight: 800, bgcolor: C.warnLight, borderLeft: `2px solid ${C.warnText}` }} title="Original allocated qty — straight from the engine (or_waterfill_steps · Allocated)">{r.orig || '—'}</TableCell>
                      <TableCell sx={{ ...num, color: C.slate }} title="Stock after = Final stock + allocated">{dash(r.finalStockAfter)}</TableCell>
                      <TableCell sx={{ ...num, color: C.muted }} title="Days of cover after = (Final stock + allocated) ÷ DRR">{dash(r.docAfter)}</TableCell>
                      <TableCell sx={{ ...num, color: C.warnText, fontWeight: 700 }} title="Priority after = tier × DRR ÷ (Final stock + allocated) — the engine levels this across the DBs it rations.">{dash(r.psAfter)}</TableCell>
                      <TableCell sx={{ ...num, color: C.slate }} title="Fill % = allocated ÷ SOQ × 100">{r.fillPct == null ? '—' : `${r.fillPct}%`}</TableCell>
                      <TableCell sx={{ fontSize: 11.5, color: C.slate, verticalAlign: 'top', whiteSpace: 'nowrap' }} title={r.category ?? ''}>{dash(catShort(r.category))}</TableCell>
                      {/* ── WATER-FILL cells (retired view — kept for reference; their columns are no longer served) ──
                      // <TableCell sx={{ ...num, bgcolor: C.amberP }} title="Tier weight = the DB's Final_Tier_Score. Blank on give-all slices (pool ≥ SOQ → no water-fill ran).">{zf.full ? '—' : (r.tierWeight ?? '—')}</TableCell>
                      // <TableCell sx={{ ...num, bgcolor: C.amberP }} title="S/N = Stock ÷ Norm (before allocation). Not computed when stock is 0 (then priority IS the tier weight) nor on give-all slices.">{zf.full || r.sOverN == null ? '—' : r.sOverN}</TableCell>
                      // <TableCell sx={{ ...num, bgcolor: C.amberP, color: C.warnText, fontWeight: 800 }} title="Priority score = Tier weight ÷ (Stock ÷ Norm); when stock is 0 it IS the tier weight (no S/N). Blank on give-all slices (no water-fill). Higher = needier — the SCORE the water-fill sorts + fills on.">{zf.full ? '—' : (r.priorityScore ?? '—')}</TableCell>
                      // <TableCell sx={{ ...num, color: C.muted }}>{zf.full ? '—' : r.cum}</TableCell>
                      // <TableCell sx={{ ...num, color: C.slate }} title="Fair share = (cumulative score − pool) ÷ k — the candidate water level at this rank (sheet col F)">{zf.full ? '—' : r.fair}</TableCell>
                      // <TableCell sx={{ ...num, color: C.muted }} title="P+1 score = the next DB's score (sheet col G)">{zf.full ? '—' : r.p1}</TableCell>
                      // <TableCell sx={{ ...num, fontWeight: 800, color: !zf.full && r.met ? C.success : C.muted, bgcolor: !zf.full && r.met ? C.successLight : undefined }} title="Logic met? = 1 when Fair share ≥ P+1 score — the water level is set at the first 1 (sheet col H)">{zf.full ? '—' : (r.met ? '1' : '0')}</TableCell>
                      // {epsOn && <TableCell sx={{ ...num, color: C.muted, borderLeft: `2px solid ${C.warnText}` }} title="Epsilon = IQR (QUARTILE 3 − QUARTILE 1) of the epsilon group's priority scores — the priority threshold. Blank above the waterline.">{zf.full || r.epsilon == null ? '—' : r.epsilon}</TableCell>}
                      // {epsOn && <TableCell sx={{ ...num, fontWeight: 800, color: r.epsilonMet ? C.alertRed : C.muted, bgcolor: r.epsilonMet ? C.warnLight : undefined }} title="Epsilon met? = 1 when this DB's priority score ≥ Epsilon (per-row, no cascade). Epsilon-met DBs share the leftover CFA stock by saliency; the rest get 0. Blank above the waterline.">{zf.full || r.epsilonMet == null ? '—' : (r.epsilonMet ? '1' : '0')}</TableCell>}
                      // {epsOn && <TableCell sx={{ ...num, color: C.slate }} title="Share saliency = priority ÷ Σ(priority of the epsilon-met DBs) — this DB's share of the LEFTOVER stock (after the water-fill). Higher % ⇒ more stock. Blank for non-epsilon-met / above the waterline.">{zf.full || r.saliency == null ? '—' : `${Math.round(r.saliency * 100)}%`}</TableCell>}
                      // <TableCell sx={{ ...num, color: served ? C.navy : C.muted, fontWeight: 800, bgcolor: C.warnLight, borderLeft: `2px solid ${C.warnText}` }} title="Original allocated qty — straight from the SOLVER (or_waterfill_steps · Allocated)">{r.orig || '—'}</TableCell>
                      // <TableCell sx={{ ...num, color: served ? C.warnText : C.muted, fontWeight: 700, bgcolor: C.warnLight }} title="SOQ − Allocated — the equal cut this DB took (≈ the water level for served DBs; 0 for a give-full DB whose SOQ was below the water level). Blank on give-all slices (no water-fill).">{zf.full || r.score == null ? '—' : (served ? +(r.soq - r.orig).toFixed(2) : '—')}</TableCell>
                      */}
                      <TableCell sx={{ ...num, color: inStep2 ? C.slate : C.muted, fontWeight: 700 }} title="New SOQ (Step-2 demand) = SOQ − Allocated (the gap to Norm). SOQ already nets DB stock, so substitutes fill up to this — never more.">{inStep2 ? r.soq2 : '—'}</TableCell>
                      <TableCell sx={{ ...num, color: inStep2 ? C.slate : C.muted }} title="Tier score = the DB-tier weight (T1 1.0 · T2 0.85 · T3 0.65 · T4 0.5) — from the DB">{inStep2 ? r.tierScore : '—'}</TableCell>
                      <TableCell sx={{ ...num, color: inStep2 ? C.slate : C.muted }} title="(DB Stock + Step-1 Original) ÷ Norm — from the DB">{inStep2 ? r.snRatio : '—'}</TableCell>
                      <TableCell sx={{ ...num, color: inStep2 ? C.navy : C.muted, fontWeight: 700 }} title="New score = Tier score ÷ [(Stock+Original)÷Norm] = step-1 Score_After in the DB">{inStep2 ? r.newSc : '—'}</TableCell>
                      <TableCell sx={{ ...num, color: r.sub > 0 ? C.success : C.muted, fontWeight: 800 }}>{r.sub || '—'}</TableCell>
                      <TableCell sx={{ ...num, color: inStep2 ? C.success : C.muted, fontWeight: 700 }} title="After-substitution priority score = step-2 Score_After in the DB">{inStep2 ? r.afterSc : '—'}</TableCell>
                      <TableCell sx={{ verticalAlign: 'top' }}>{subChip(r.elig, `${r.db}${dbNameOf(r.db) ? ' · ' + dbNameOf(r.db) : ''} · ${zf.z} substitutes`, `${r.elig.length} eligible · rank by stock · ${r.sub} cs allocated`)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </Box>

            {/* Step 2 · Eligible substitutes — collapsible, ABOVE the filler. Every eligible sub per DB:
                rank (by stock) · stock before · allocated to this DB · stock after. Rank 1 is filled first. */}
            {(() => {
              const cands = zf.rows.filter((r) => r.soq - r.orig > 0);   // every Step-2 candidate line (orig 0 included)
              if (!cands.length) return null;
              const open = openElig[zf.z] ?? false;
              // GLOBAL New-score order — EVERY candidate DB for this reg-zsku, INCLUDING ones with no substitute
              // rule (shown inline), so the global #1 line is always visible even when it can't be filled.
              const dbGroups = [...cands].sort((a, b) => b.newSc - a.newSc || a.db.localeCompare(b.db));
              return (
                <Box sx={{ mt: 1.75, mx: 1, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px`, overflow: 'hidden' }}>
                  <Box onClick={() => setOpenElig((p) => ({ ...p, [zf.z]: !open }))}
                    sx={{ px: 1.25, py: 0.6, bgcolor: C.successLight, color: C.success, fontWeight: 800, fontSize: 11,
                      letterSpacing: '.04em', textTransform: 'uppercase', cursor: 'pointer', display: 'flex',
                      alignItems: 'center', justifyContent: 'space-between', userSelect: 'none' }}>
                    <span>Step 2 · Eligible substitutes — GLOBAL New-score order (each DB's true position across ALL reg-zskus), each filled rank by rank ({dbGroups.length} DBs)</span>
                    <ChevronRightIcon sx={{ fontSize: 17, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
                  </Box>
                  <Collapse in={open} unmountOnExit>
                    <Box sx={{ px: 1.25, py: 0.5, fontSize: 11, color: C.muted, bgcolor: C.cream, fontStyle: 'italic' }}>
                      <b>global #</b> is each line's position in the run-wide New-score order (across every reg-zsku) — that is the real fill sequence; the same substitute SKU's {mult}×Norm room can already be taken by a lower global # of <i>another</i> reg-zsku at the same DB. Each DB's order for {zf.z} is filled rank 1, then 2, … until its New SOQ is met. Room left = ⌈{mult}×Norm⌉ − On-hand − Step-1 own. <b style={{ color: C.success }}>“order filled ✓”</b> = complete; <b style={{ color: C.muted }}>“order already full”</b> = an earlier rank filled it.
                    </Box>
                    <Box sx={{ overflowX: 'auto' }}>
                    <Table size="small" sx={{ minWidth: 'max-content', '& td, & th': { py: 0.4, px: 1.1, whiteSpace: 'nowrap' } }}>
                      <TableHead><TableRow>
                        {sub('Substitute', 'left')}{sub('Description', 'left')}{sub('Rank', 'right')}
                        {sub('Norm', 'right')}{sub(`${mult}×Norm`, 'right')}{sub('− On-hand', 'right')}{sub('− Step-1 own', 'right')}{sub('= Room left', 'right')}
                        {sub('CFA pool → left', 'right')}{sub('Allocated', 'right')}{sub('Limited by', 'left')}
                      </TableRow></TableHead>
                      <TableBody>
                        {dbGroups.flatMap((r) => [
                          <TableRow key={`h-${r.db}`} sx={{ bgcolor: C.cream, ...trackedRowSxFor(r.db) }}>
                            <TableCell colSpan={11} sx={{ fontFamily: MONO, fontSize: 12.5, py: 0.55 }}>
                              <b style={{ color: C.navy, whiteSpace: 'nowrap' }}>{`global #${r.gRank ?? '—'}  ·  DB ${isTracked(r.db) ? TRACK_STAR + ' ' : ''}${r.db}${dbNameOf(r.db) ? '  ·  ' + dbNameOf(r.db) : ''}`}</b>
                              <span style={{ color: C.muted, fontWeight: 600 }}>{`  ·  New score ${r.newSc}  ·  New SOQ ${Math.max(0, r.soq - r.orig)}  ·  substitute ${r.sub} cs`}</span>
                            </TableCell>
                          </TableRow>,
                          ...(r.elig.length === 0 ? [
                            <TableRow key={`n-${r.db}`}><TableCell colSpan={11} sx={{ color: C.warnText, fontSize: 11.5, fontStyle: 'italic', bgcolor: C.warnLight }}>{`No substitute rule for DB ${r.db} × ${zf.z} in the master — nothing to fill its New SOQ ${Math.max(0, r.soq - r.orig)} with (data gap).`}</TableCell></TableRow>,
                          ] : [...r.elig].sort((a, b) => a.rank - b.rank).map((e) => (
                            <TableRow key={`${r.db}-${e.sub}`} sx={{ bgcolor: e.alloc > 0 ? C.successLight : undefined }}>
                              <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: e.alloc > 0 ? C.success : C.slate }}>{e.sub}</TableCell>
                              <TableCell sx={{ fontFamily: SANS, fontSize: 11.5, color: C.muted, verticalAlign: 'top', minWidth: 150, '&&': { whiteSpace: 'normal' } }} title={descOf(e.sub) || ''}>{descOf(e.sub) || '—'}</TableCell>
                              <TableCell sx={{ ...num, color: C.navy, fontWeight: 800 }} title="This substitute's rank for this DB (1 = top choice)">{e.rank}</TableCell>
                              <TableCell sx={{ ...num, color: C.slate }} title="This DB's Norm for this substitute SKU">{e.norm.toLocaleString()}</TableCell>
                              <TableCell sx={{ ...num, color: isUncappedRoom(e.room) ? C.success : C.muted, fontWeight: isUncappedRoom(e.room) ? 700 : undefined }} title={isUncappedRoom(e.room) ? NO_CAP_TIP : `Max this DB may hold of this SKU = ⌈${mult} × Norm⌉`}>{isUncappedRoom(e.room) ? NO_CAP_LABEL : Math.ceil(mult * e.norm).toLocaleString()}</TableCell>
                              <TableCell sx={{ ...num, color: C.muted }} title="DB on-hand stock of this SKU">{e.stk.toLocaleString()}</TableCell>
                              <TableCell sx={{ ...num, color: C.muted }} title="Step-1 ORIGINAL of this SKU (the DB's own order)">{e.sorig.toLocaleString()}</TableCell>
                              <TableCell sx={{ ...num, color: isUncappedRoom(e.room) ? C.success : C.navy, fontWeight: 800 }} title={isUncappedRoom(e.room) ? NO_CAP_TIP : `= ⌈${mult}×Norm⌉ − On-hand − Step-1 own = room this DB has left for this substitute`}>{isUncappedRoom(e.room) ? NO_CAP_LABEL : e.room.toLocaleString()}</TableCell>
                              <TableCell sx={{ ...num, color: C.muted }} title="Shared CFA pool for this substitute, RUNNING top-to-bottom: what it saw when this line ran → what's left for the next line that wants it">
                                {e.before.toLocaleString()}<Box component="span" sx={{ color: '#6B6B6B', ml: 0.4 }}>→ {e.after.toLocaleString()}</Box>
                              </TableCell>
                              <TableCell sx={{ ...num, color: e.alloc > 0 ? C.success : C.muted, fontWeight: 800 }}>{e.alloc || '—'}</TableCell>
                              <TableCell sx={{ fontSize: 11, color: e.reason === 'demand met' ? (e.alloc > 0 ? C.success : C.muted) : e.alloc > 0 ? C.slate : C.warnText }}>{e.reason === 'demand met' ? (e.alloc > 0 ? 'order filled ✓' : 'order already full') : e.reason}</TableCell>
                            </TableRow>
                          ))),
                        ])}
                      </TableBody>
                    </Table>
                    </Box>
                  </Collapse>
                </Box>
              );
            })()}
          </AccordionDetails>
        </Accordion>
        );
      })}

      {/* sources popup — fixed cloud bubble at the click point, portaled to <body> so the scroll
          container / accordion can never re-anchor it (no top-left jump) and the accordion stays open */}
      {pop && createPortal(
        <Box onClick={() => setPop(null)} sx={{ position: 'fixed', inset: 0, zIndex: 1500 }}>
          <Box onClick={(e) => e.stopPropagation()}
            sx={{ position: 'fixed',
              top: Math.min(pop.top + 10, window.innerHeight - 300),
              left: Math.min(Math.max(pop.left, pop.elig ? 190 : 124), window.innerWidth - (pop.elig ? 190 : 124)),
              transform: 'translateX(-50%)',
              minWidth: pop.elig ? 318 : 158, maxWidth: pop.elig ? 380 : 230,
              bgcolor: C.white, p: 1.1, borderRadius: 2, border: `1px solid ${C.rule}`,
              boxShadow: '0 8px 28px rgba(15,30,51,0.18)',
              '&::before': { content: '""', position: 'absolute', top: -6, left: '50%', transform: 'translateX(-50%) rotate(45deg)',
                width: 11, height: 11, bgcolor: C.white, borderLeft: `1px solid ${C.rule}`, borderTop: `1px solid ${C.rule}` } }}>
            <Box sx={{ fontFamily: MONO, fontWeight: 700, color: C.navy, fontSize: 11.5 }}>{pop.title}</Box>
            <Box sx={{ fontSize: 10, color: C.muted, mb: 0.6 }}>{pop.meta}</Box>
            {pop.elig ? (
              <Box sx={{ maxHeight: 240, overflowY: 'auto' }}>
                <Box sx={{ display: 'grid', gridTemplateColumns: '24px 1fr 50px 44px 50px', gap: 0.5, fontSize: 9.5, fontWeight: 800,
                  textTransform: 'uppercase', letterSpacing: '.03em', color: C.muted, pb: 0.3, borderBottom: `1px solid ${C.rule}` }}>
                  <span>Rk</span><span>Substitute</span><span style={{ textAlign: 'right' }}>Before</span>
                  <span style={{ textAlign: 'right' }}>Alloc</span><span style={{ textAlign: 'right' }}>After</span>
                </Box>
                {pop.elig.map((e, i) => (
                  <Box key={i} sx={{ display: 'grid', gridTemplateColumns: '24px 1fr 50px 44px 50px', gap: 0.5, fontFamily: MONO, fontSize: 11.5,
                    py: 0.25, borderTop: i ? `1px solid ${C.rule}` : 'none', bgcolor: e.alloc > 0 ? C.successLight : undefined }}>
                    <b style={{ color: C.navy }}>{e.rank}</b>
                    <span style={{ color: e.alloc > 0 ? C.success : C.slate }}>{e.sub}</span>
                    <span style={{ textAlign: 'right', color: C.muted }}>{e.before.toLocaleString()}</span>
                    <b style={{ textAlign: 'right', color: e.alloc > 0 ? C.success : C.muted }}>{e.alloc || '—'}</b>
                    <span style={{ textAlign: 'right', color: C.muted }}>{e.after.toLocaleString()}</span>
                  </Box>
                ))}
              </Box>
            ) : pop.pairs?.map(([z, qq], i) => (
              <Box key={i} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2.5, fontFamily: MONO, fontSize: 12, py: 0.2, borderTop: i ? `1px solid ${C.rule}` : 'none' }}>
                <span style={{ color: pop.tone }}>{z}</span><b style={{ color: C.slate }}>×{qq}</b>
              </Box>
            ))}
          </Box>
        </Box>,
        document.body
      )}

      <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.rule}`, mt: 3, pt: 1, fontSize: 9, color: C.muted }}>
        <span>AI Order Optimizer · Step-1 v2 weight-equalising fair share (functional team engine)</span>
        <span>per reg-zsku · Step 1 original → Step 2 substitute</span>
      </Box>
    </Shell>
  );
}
