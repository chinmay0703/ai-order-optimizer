// engine.ts — demo routes for the engine-view pages:
//   GET /api/v1/waterfill?run=N        Drilldown (Step 1 fair share + Step 2) and Substitution Sequence
//   GET /api/v1/step1_truck_fill       the Step-1 / Step-2 truck-fill tab (CFA × DB lane ratios)
//   GET /api/v1/cfadb                  CFA × DB combined allocation + per-truck table
//   GET /api/v1/truck_trim?run=N       Truck Trims (tail cascades, lane drops, cluster primary trims)
// Every number is derived from the ONE synthetic universe in ../dataset so these pages agree with every other page.
// The dataset's Step 1 is a simple SOQ × tier water-fill; the v2 "weight-equalising" trace shown on the Drilldown is
// BACK-SOLVED from it (DRR is chosen so that the v2 maths reproduces exactly the dataset's Original per DB).
import { get } from '../router';
import {
  CFA, DISTRIBUTORS, REG_ZSKUS, RUNS, RUN_RESULTS, LANES, CLUSTERS, DEMAND, OE_PARAM_DEFS, SOQ_DATE, PRIMARY_CAP,
  rng, rzByCode, tierWeight, type Lane, type Line, type RunResult,
} from '../dataset';

type Cell = string | number | boolean | null;

// ───────── small helpers ─────────
const rd = (x: number, d: number) => { const p = 10 ** d; return Math.round(x * p) / p; };
const r1 = (x: number) => rd(x, 1), r2 = (x: number) => rd(x, 2), r3 = (x: number) => rd(x, 3), r4 = (x: number) => rd(x, 4);
const pct1 = (n: number, d: number) => (d > 0 ? r1((n / d) * 100) : null);
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const param = (k: string) => OE_PARAM_DEFS.find((p) => p.key === k)?.value ?? 0;
const NORM_X = param('NORM_MULTIPLIER');          // 1.2 — the run's values (what the numbers below were computed with)
const ADDON = param('ADDON_CAP_PCT');             // 0.35
const NO_NORM_CAP = 1e9;                          // backend sentinel: a Non-PACE DB carries no 1.2×Norm cap
// DB-tier weight — the dataset's own (the same one its filler draw priority used), so every page shows one value
const tw = (t: number) => tierWeight(t);
const channelOf = (run: number) => RUNS.find((r) => r.run === run)?.channel ?? '';
const RUNS_OUT = RUNS.map((r) => ({ run: r.run, channel: r.channel }));
const runFilter = (q: URLSearchParams) => { const n = Number(q.get('run') ?? 0); return Number.isFinite(n) && n > 0 ? n : 0; };

// PDP frequency (pdp_master) per distributor → RF days
const PDP: [string, number][] = [
  ['Twice a week', 3], ['Weekly', 7], ['Thrice a week', 2], ['Fortnightly', 14], ['Twice a week', 3],
  ['Twice a week', 3], ['Weekly', 7], ['Every 10 days', 10], ['Weekly', 7], ['Fortnightly', 14],
];
const pdpOf = (db: string) => PDP[Math.max(0, DISTRIBUTORS.findIndex((d) => d.code === db)) % PDP.length];
const demandOf = (db: string, rz: string) => DEMAND.find((d) => d.db === db && d.rz === rz);

// Step-2 inputs: Tier score = tier weight · (Stock + Original) ÷ Norm (0 stock → 1 case) · New score = the ratio of the two
const snRatioOf = (x: Line) => r4(Math.max(1, x.dbStock + x.orig) / Math.max(1, x.norm));
const newScoreOf = (lane: Lane, x: Line) => r4(tw(lane.db.tier) / Math.max(0.0001, snRatioOf(x)));

// ═════════════════════════ Step 2 replay ═════════════════════════
// Re-runs the dataset's substitution loop (same order, same pools) to recover, per candidate line, what the engine saw:
// the add-on budget left, the chosen substitute and its grant.
interface SubLine { lane: Lane; line: Line; need: number; addonBefore: number; cand: string | null; take: number }
function replayStep2(rr: RunResult): SubLine[] {
  const pool: Record<string, number> = { ...rr.reserved };
  for (const l of rr.lanes) for (const x of l.lines) pool[x.rz] -= x.orig;
  const out: SubLine[] = [];
  for (const lane of rr.lanes) {
    let addonLeft = Math.floor(lane.lines.reduce((s, x) => s + x.soq, 0) * ADDON);
    for (const x of lane.lines.filter((l) => l.soq > l.orig).sort((a, b) => (b.soq - b.orig) - (a.soq - a.orig))) {
      const cat = rzByCode.get(x.rz)!.category;
      const rec: SubLine = { lane, line: x, need: x.soq - x.orig, addonBefore: addonLeft, cand: null, take: 0 };
      const cand = REG_ZSKUS.filter((z) => z.category === cat && z.rz !== x.rz && pool[z.rz] > 0).sort((a, b) => pool[b.rz] - pool[a.rz])[0];
      if (cand && addonLeft > 0) {
        const take = Math.min(x.soq - x.orig, pool[cand.rz], addonLeft);
        if (take > 0) { rec.cand = cand.rz; rec.take = take; pool[cand.rz] -= take; addonLeft -= take; }
      }
      out.push(rec);
    }
  }
  return out;
}

// ═════════════════════════ /waterfill ═════════════════════════
const STEP_COLS = [
  'run_no', 'channel', 'mrp_band', 'step', 'cfa_id', 'db_id', 'reg_zsku', 'source_zsku', 'db_tier', 'stock', 'norm_qty',
  'soq_remaining', 'score', 'allocated', 'score_after', 'tier_score', 'sn_ratio', 'new_score', 'tier_weight',
  'drr', 'drr_actual', 'pdp_frequency', 'pdp_freq_in_days', 'final_stock', 'demand_qty', 'floor_qty', 'weight',
  'priority_score_before', 'days_of_cover_before', 'cfa_pool', 'regime', 'lambda_level', 'pristine_allocation',
  'adjustment', 'remainder_units', 'final_stock_after', 'days_of_cover_after', 'priority_score_after', 'fill_pct', 'category',
] as const;
type StepCol = typeof STEP_COLS[number];
const toRow = (o: Partial<Record<StepCol, Cell>>): Cell[] => STEP_COLS.map((c) => o[c] ?? null);
const ELIG_COLS = ['Run_No', 'CFA ID', 'DB ID', 'reg-zsku', 'Sub_ZSKU', 'Rank', 'Stock_Before', 'Headroom', 'Allocated',
  'Stock_After', 'Reason', 'Norm', 'Sub_Stock', 'Sub_Orig'];

const CAT = {
  capped: 'CAPPED (received its full SOQ ask)',
  floorCap: 'AT FLOOR (received its full floor — severe scarcity)',
  level: 'LEVELLED (on the common water level)',
  zero: 'ZERO (below the water level)',
};

interface Step1Trace { rows: Cell[][] }
function step1Pool(rr: RunResult, rz: string): Step1Trace {
  const run = rr.run.run;
  const z = rzByCode.get(rz)!;
  const items = rr.lanes.flatMap((lane) => lane.lines.filter((x) => x.rz === rz && x.soq > 0).map((x) => ({ lane, x })));
  if (!items.length) return { rows: [] };
  const pool = Math.max(0, rr.reserved[rz] ?? 0);
  const sumSoq = items.reduce((s, it) => s + it.x.soq, 0);
  const regime = z.cfaStock <= 0 || pool <= 0 ? 'CFA STOCK 0'
    : pool >= sumSoq ? 'NOT CONSTRAINED'
      : pool / sumSoq < 0.4 ? 'SEVERE SCARCITY' : 'NORMAL SCARCITY';
  const R = rng(hash(`${run}|${rz}`));
  const base = (it: { lane: Lane; x: Line }) => {
    const [freq, rf] = pdpOf(it.lane.db.code);
    const t = it.lane.db.tier;
    return {
      run_no: run, channel: rr.run.channel, mrp_band: z.band, step: 1, cfa_id: CFA, db_id: it.lane.db.code, reg_zsku: rz,
      source_zsku: null, db_tier: t, stock: it.x.dbStock, norm_qty: it.x.norm, soq_remaining: it.x.soq, allocated: it.x.orig,
      tier_weight: tw(t), pdp_frequency: freq, pdp_freq_in_days: rf, final_stock: Math.max(1, it.x.dbStock), cfa_pool: pool, regime,
    } satisfies Partial<Record<StepCol, Cell>>;
  };
  // Step-2 inputs (same on every regime): Tier score, (Stock+Orig)÷Norm, New score = Tier score ÷ that ratio
  const step2In = (it: { lane: Lane; x: Line }) => {
    const ns = newScoreOf(it.lane, it.x);
    return { tier_score: tw(it.lane.db.tier), sn_ratio: snRatioOf(it.x), new_score: ns, score_after: ns };
  };

  if (regime === 'NOT CONSTRAINED' || regime === 'CFA STOCK 0') {
    return { rows: items.map((it, i) => {
      const b = base(it);
      const zeroDrr = R.chance(0.07) || (i === 0 && hash(rz) % 9 === 0);   // a few DBs with no L3M sales → DRR 0.1
      const drrA = zeroDrr ? 0 : r2(Math.max(0.12, (it.x.soq / b.pdp_freq_in_days) * (0.35 + R.next() * 0.5)));
      const full = regime === 'NOT CONSTRAINED';
      return toRow({ ...b, ...step2In(it), drr: zeroDrr ? 0.1 : drrA, drr_actual: drrA,
        final_stock_after: b.final_stock + it.x.orig, fill_pct: full ? pct1(it.x.orig, it.x.soq) : 0,
        score: null });
    }) };
  }

  // ── rationed pool: back-solve DRR so the v2 equalisation reproduces the dataset's Original exactly ──
  const severe = regime === 'SEVERE SCARCITY';
  const ratios = items.map((it) => tw(it.lane.db.tier) / pdpOf(it.lane.db.code)[1]);
  const L = severe ? 1.35 * Math.max(...ratios) : 0.45 * Math.min(...ratios);   // common level = priority-after for levelled DBs
  type Calc = { it: { lane: Lane; x: Line }; kind: 'capped' | 'zero' | 'level'; adj: boolean; drr: number; drrA: number };
  let zeroDrrUsed = false;
  const calc: Calc[] = items.map((it) => {
    const t = tw(it.lane.db.tier), fs = Math.max(1, it.x.dbStock), o = it.x.orig, soq = it.x.soq;
    if (o >= soq) {
      const drr = r2(Math.max(0.12, (L * (fs + soq) * (1.15 + R.next() * 0.6)) / t));
      return { it, kind: 'capped', adj: false, drr, drrA: drr };
    }
    if (o <= 0) {
      if (!zeroDrrUsed && (t * 0.1) / fs <= L) { zeroDrrUsed = true; return { it, kind: 'zero', adj: false, drr: 0.1, drrA: 0 }; }
      const drr = r2(Math.max(0.12, (L * fs * (0.4 + R.next() * 0.5)) / t));
      return { it, kind: 'zero', adj: false, drr, drrA: drr };
    }
    const adj = o >= 3 && R.chance(0.3);                     // whole-case remainder handed back to this DB (+1)
    const cont = adj ? o - 1 + 0.55 + R.next() * 0.4 : o + 0.02 + R.next() * 0.48;
    const drr = r2(Math.max(0.12, (L * (fs + cont)) / t));
    return { it, kind: 'level', adj, drr, drrA: drr };
  });
  const sumDrr = calc.reduce((s, c) => s + c.drr, 0);
  const lambda = L / sumDrr;
  const pristineOf = (c: Calc) => (c.kind === 'capped' ? c.it.x.soq : c.kind === 'zero' ? 0 : c.it.x.orig - (c.adj ? 1 : 0));
  const remainder = pool - calc.reduce((s, c) => s + pristineOf(c), 0);
  return { rows: calc.map((c) => {
    const b = base(c.it);
    const t = tw(c.it.lane.db.tier), fs = b.final_stock, o = c.it.x.orig, soq = c.it.x.soq, rf = b.pdp_freq_in_days;
    const demand = r2(c.drr * rf);
    const floor = r2(Math.min(soq, Math.max(0, demand - fs)));
    const pristine = pristineOf(c);
    const cat = c.kind === 'capped' ? (severe && floor < soq ? CAT.floorCap : CAT.capped) : c.kind === 'zero' ? CAT.zero : CAT.level;
    const psBefore = r3((t * c.drr) / fs);
    return toRow({ ...b, ...step2In(c.it), drr: c.drr, drr_actual: c.drrA, demand_qty: demand, floor_qty: floor,
      weight: r4((t * c.drr) / sumDrr), priority_score_before: psBefore, days_of_cover_before: r1(fs / c.drr),
      score: psBefore, lambda_level: Number(lambda.toPrecision(4)), pristine_allocation: pristine, adjustment: o - pristine,
      remainder_units: remainder, final_stock_after: fs + o, days_of_cover_after: r1((fs + o) / c.drr),
      priority_score_after: r3((t * c.drr) / (fs + o)), fill_pct: pct1(o, soq), category: cat });
  }) };
}

interface WaterfillPayload {
  cols: string[]; rows: Cell[][]; runs: { run: number; channel: string }[];
  ledger: Record<string, { stock: number; reserved: number; allocated: number; remaining: number }>;
  eligCols: string[]; eligRows: Cell[][]; subMrp: Record<string, number>; resMrp: Record<string, number>;
  norm_multiplier: number; addon_cap_pct: number; step1_v2_active: boolean; drr_available: boolean; drr_data_date: string | null;
}
let WF: Omit<WaterfillPayload, 'drr_data_date'> | null = null;
function buildWaterfill() {
  if (WF) return WF;
  const rows: Cell[][] = [], eligRows: Cell[][] = [];
  const ledger: WaterfillPayload['ledger'] = {};
  const subMrp: Record<string, number> = {};
  for (const rr of RUN_RESULTS) {
    const run = rr.run.run, nonPace = rr.run.channel === 'Non-PACE';
    // Step 1 — one pool per reg-zsku
    for (const z of REG_ZSKUS) rows.push(...step1Pool(rr, z.rz).rows);
    // Step 2 — the grants are the dataset's; the eligible-substitute audit is laid out in the order both pages show it
    // (New score ↓, the global Step-2 sequence) with the shared CFA pool RUNNING down that order
    const seq = replayStep2(rr);
    const zIx = new Map(REG_ZSKUS.map((z, i) => [z.rz, i])), lIx = new Map(rr.lanes.map((l, i) => [l.db.code, i]));
    const display = [...seq].sort((a, b) => newScoreOf(b.lane, b.line) - newScoreOf(a.lane, a.line)
      || zIx.get(a.line.rz)! - zIx.get(b.line.rz)! || lIx.get(a.lane.db.code)! - lIx.get(b.lane.db.code)!);
    const pool: Record<string, number> = { ...rr.reserved };
    for (const l of rr.lanes) for (const x of l.lines) pool[x.rz] -= x.orig;
    const usedRoom = new Map<string, number>();   // (db|sub) → cases already granted as a substitute (room consumed)
    for (const s of display) {
      const x = s.line, db = s.lane.db.code, t = tw(s.lane.db.tier), zx = rzByCode.get(x.rz)!;
      subMrp[`${CFA}|${db}|${x.rz}`] = zx.mrp;
      if (s.take > 0) {
        rows.push(toRow({ run_no: run, channel: rr.run.channel, mrp_band: zx.band, step: 2, cfa_id: CFA, db_id: db,
          reg_zsku: x.rz, source_zsku: s.cand, db_tier: s.lane.db.tier, stock: x.dbStock, norm_qty: x.norm, soq_remaining: x.soq,
          allocated: s.take, tier_score: t, tier_weight: t,
          score_after: r4(t / (Math.max(1, x.dbStock + x.orig + x.subGot) / Math.max(1, x.norm))) }));
      }
      // eligible list: the granted sub first, then same-category subs at the EXACT MRP (the master is CFA × DB × MRP ×
      // category). A non-granted sub is listed only where the engine really stopped: the order was already full, the
      // add-on budget was spent, or that sub's pool was empty — otherwise it simply isn't in this line's master.
      const needAfter = s.need - s.take, addonOut = s.addonBefore - s.take <= 0;
      const list: [string, number, number, string][] = [];   // sub, CFA pool before, allocated, limited by
      if (s.cand) {
        const before = pool[s.cand];
        list.push([s.cand, before, s.take, s.take >= s.need ? 'demand met' : s.take >= before ? 'CFA pool' : '35% add-on']);
        pool[s.cand] -= s.take;
      }
      const others = REG_ZSKUS.filter((z) => z.category === zx.category && z.mrp === zx.mrp && z.rz !== x.rz && z.rz !== s.cand)
        .map((z) => [z.rz, Math.max(0, pool[z.rz])] as const)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .filter(([, p]) => needAfter <= 0 || addonOut || p <= 0)
        .slice(0, s.cand ? 2 : 3);
      for (const [rz, p] of others) list.push([rz, p, 0, needAfter <= 0 ? 'demand met' : addonOut ? '35% add-on' : 'CFA pool']);
      list.forEach(([sub, before, alloc, reason], i) => {
        const dm = demandOf(db, sub), zs = rzByCode.get(sub)!;
        const own = s.lane.lines.find((l) => l.rz === sub)?.orig ?? 0;
        const k = `${db}|${sub}`, used = usedRoom.get(k) ?? 0;
        // a sub the DB doesn't demand itself: the norm / on-hand convention the dataset's filler calc uses; when it is
        // not filler-eligible (never shown on the filler pages) the on-hand is sized so the room formula reconciles
        let norm = dm?.norm ?? Math.round(zs.unitsPerCase / 4 + 20);
        let soh = dm?.dbStock ?? Math.round(norm * 0.4);
        if (!dm && !zs.isFiller && !nonPace) {
          norm = Math.max(norm, Math.ceil((own + used + alloc) / NORM_X));
          soh = Math.max(0, Math.min(soh, Math.floor(NORM_X * norm) - own - used - alloc));
        }
        // Non-PACE carries no 1.2×Norm cap (sentinel). The dataset's Step 2 doesn't model the room cap, so a Retail
        // grant can exceed the formula room — show room ≥ the grant rather than a breach.
        const room = nonPace ? NO_NORM_CAP : Math.max(alloc, Math.floor(NORM_X * norm) - soh - own - used, 0);
        if (alloc > 0) usedRoom.set(k, used + alloc);
        eligRows.push([run, CFA, db, x.rz, sub, i + 1, before, room, alloc, before - alloc, reason, norm, soh, own]);
      });
    }
    // CFA ledger for this run (stock overall, reserved for the run, allocated = own Original + drawn as a substitute)
    for (const z of REG_ZSKUS) {
      const orig = rr.lanes.reduce((s, l) => s + l.lines.filter((x) => x.rz === z.rz).reduce((a, x) => a + x.orig, 0), 0);
      const asSub = seq.filter((s) => s.cand === z.rz).reduce((a, s) => a + s.take, 0);
      const reserved = Math.max(0, rr.reserved[z.rz] ?? 0);
      ledger[`${CFA}|${run}|${z.rz}`] = { stock: z.cfaStock, reserved, allocated: orig + asSub, remaining: reserved - orig - asSub };
    }
  }
  WF = {
    cols: [...STEP_COLS], rows, runs: RUNS_OUT, ledger, eligCols: ELIG_COLS, eligRows, subMrp,
    resMrp: Object.fromEntries(REG_ZSKUS.map((z) => [`${CFA}|${z.rz}`, z.mrp])),
    norm_multiplier: NORM_X, addon_cap_pct: ADDON, step1_v2_active: true, drr_available: true,
  };
  return WF;
}
export const waterfillPayload = (date: string, run = 0): WaterfillPayload => {
  const wf = buildWaterfill();
  const runIx = STEP_COLS.indexOf('run_no');
  return { ...wf,
    rows: run ? wf.rows.filter((r) => r[runIx] === run) : wf.rows,
    eligRows: run ? wf.eligRows.filter((r) => r[0] === run) : wf.eligRows,
    drr_data_date: SOQ_DATE[date] ?? null };
};
get('/api/v1/waterfill', (ctx) => waterfillPayload(ctx.date, runFilter(ctx.query)));

// ═════════════════════════ /step1_truck_fill ═════════════════════════
export const truckFillPayload = (date: string) => ({
  date,
  rows: LANES.map((l) => {
    const cap = l.db.truckCap, s12 = l.orig + l.sub;
    return {
      cfa: CFA, db: l.db.code, db_name: l.db.name, channel: l.db.channel, total_soq: l.soq,
      step1_alloc: l.orig, step2_alloc: l.sub, total_alloc: s12,
      is_transship: l.db.transship, truck_cap: cap, cap_kind: l.db.transship ? 'Secondary' : 'Lane',
      fill_pct: pct1(l.orig, cap), fill_pct_after: pct1(s12, cap),
      fill_rate: pct1(l.orig, l.soq), fill_rate_after: pct1(s12, l.soq),
    };
  }),
});
get('/api/v1/step1_truck_fill', (ctx) => truckFillPayload(ctx.date));

// ═════════════════════════ /cfadb ═════════════════════════
const CFADB_COLS = ['CFA ID', 'DB ID', 'DB_Tier', 'SOQ', 'Norm', 'Held', 'Original', 'Substitute', 'Filler', 'Total', 'stock',
  'Channel', 'Filler_Priority', 'Draw_Rank', 'Sum_Norm', 'Sum_Held', 'N_In_CFA'];
const TRUCK_COLS = ['CFA ID', 'DB ID', 'Type', 'Truck', 'Cases', 'Capacity', 'Fill_Pct', 'SO_Flag', 'is_transhipment',
  'primary_truck_count', 'cluster_code', 'planned_cases', 'planned_fill_pct'];
export const cfaDbPayload = () => {
  const sum = (l: Lane, f: (x: Line) => number) => l.lines.reduce((s, x) => s + f(x), 0);
  const cfadb = LANES.map((l) => {
    // a dropped lane (RLM truck approval) is ON HOLD with its pre-drop Steps 1-3; every other lane shows what ships
    const o = l.dropped ? l.dropOrig : sum(l, (x) => x.shipOrig);
    const s = l.dropped ? l.dropSub : sum(l, (x) => x.shipSub);
    const f = l.dropped ? l.dropFil : sum(l, (x) => x.shipFil);
    const stock = sum(l, (x) => (x.soq > 0 ? x.dbStock : 0));
    const nRun = LANES.filter((y) => y.run === l.run).length;
    return [CFA, l.db.code, l.db.tier, l.soq, l.sumNorm, stock + o + s, o, s, f, o + s + f, stock, l.db.channel,
      l.priority, l.rank, l.sumNorm, l.sumHeld, nRun];
  });
  const trucks: Cell[][] = [];
  for (const l of LANES) {
    const cap = l.db.truckCap;
    const cl = l.db.cluster ? CLUSTERS.find((c) => c.code === l.db.cluster) : undefined;
    const prim = l.db.transship && cl ? r2(cl.combined / PRIMARY_CAP) : 0;
    const tail = [l.db.transship, prim, l.db.cluster ?? ''] as const;
    if (l.dropped) {   // the planned truck that failed the keep floor — held for RLM approval
      trucks.push([CFA, l.db.code, l.db.truckType, 1, l.planned, cap, r1((l.planned / cap) * 100), l.soFlag, ...tail,
        l.planned, r1((l.planned / cap) * 100)]);
      continue;
    }
    for (const ld of l.loads) {
      trucks.push([CFA, l.db.code, l.db.truckType, ld.no, ld.cases, cap, r1((ld.cases / cap) * 100), l.soFlag, ...tail,
        ld.planned, r1((ld.planned / cap) * 100)]);
    }
  }
  return { cfadb: { cols: CFADB_COLS, rows: cfadb }, trucks: { cols: TRUCK_COLS, rows: trucks } };
};
get('/api/v1/cfadb', () => cfaDbPayload());

// ═════════════════════════ /truck_trim ═════════════════════════
// Replays the dataset's tail trim on a copy so a lane's tail-cascade cut and its later cluster-primary cut are logged apart.
function tailTrimOf(lane: Lane): Map<string, { o: number; s: number; f: number }> {
  const cp = lane.lines.map((x) => ({ rz: x.rz, pa: x.priorityAfter, shipOrig: x.orig, shipSub: x.sub, shipFil: x.filler }));
  let left = lane.cascaded;
  outer: for (const key of ['shipFil', 'shipSub', 'shipOrig'] as const) {
    for (const x of [...cp].sort((a, b) => a.pa - b.pa || b[key] - a[key])) {
      if (left <= 0) break outer;
      const t = Math.min(x[key], left); x[key] -= t; left -= t;
    }
  }
  return new Map(lane.lines.map((x, i) => [x.rz, { o: x.orig - cp[i].shipOrig, s: x.sub - cp[i].shipSub, f: x.filler - cp[i].shipFil }]));
}
export const truckTrimPayload = (run = 0) => {
  const rows: Cell[][] = [];
  const lanes: Record<string, unknown>[] = [];
  const add = (l: Lane, reason: string, per: { rz: string; o: number; s: number; f: number }[]) => {
    const hit = per.filter((p) => p.o + p.s + p.f > 0);
    if (!hit.length) return;
    for (const p of hit) rows.push([l.run, channelOf(l.run), CFA, l.db.code, p.rz, p.o, p.s, p.f, reason]);
    lanes.push({ run: l.run, channel: channelOf(l.run), cfa: CFA, db: l.db.code, db_name: l.db.name, truck_type: l.db.truckType,
      is_transhipment: l.db.transship, truck_cap: l.db.truckCap, cluster: l.db.cluster ?? '', reason,
      skus: hit.length, cases: hit.reduce((s, p) => s + p.o + p.s + p.f, 0) });
  };
  for (const l of LANES) {
    if (run && l.run !== run) continue;
    if (l.dropped) {
      add(l, 'LANE_DROP_<65%', l.lines.map((x) => ({ rz: x.rz, o: x.orig, s: x.sub, f: x.filler })));
      continue;
    }
    const tail = tailTrimOf(l);
    if (l.cascaded > 0) add(l, 'TRUCK_TAIL_CASCADE', l.lines.map((x) => ({ rz: x.rz, ...tail.get(x.rz)! })));
    if (l.clusterTrim > 0) {
      add(l, 'CLUSTER_PRIMARY_TRIM', l.lines.map((x) => {
        const t = tail.get(x.rz)!;
        return { rz: x.rz, o: x.orig - t.o - x.shipOrig, s: x.sub - t.s - x.shipSub, f: x.filler - t.f - x.shipFil };
      }));
    }
  }
  const summary = new Map<string, { run: number; reason: string; lines: number; cases: number }>();
  for (const r of rows) {
    const k = `${r[0]}|${r[8]}`;
    const s = summary.get(k) ?? { run: r[0] as number, reason: r[8] as string, lines: 0, cases: 0 };
    s.lines += 1; s.cases += (r[5] as number) + (r[6] as number) + (r[7] as number);
    summary.set(k, s);
  }
  return {
    cols: ['Run', 'Channel', 'CFA ID', 'DB ID', 'reg-zsku', 'Orig_Trim', 'Sub_Trim', 'Filler_Trim', 'Reason'],
    rows, lanes, runs: RUNS_OUT, summary: [...summary.values()],
  };
};
get('/api/v1/truck_trim', (ctx) => truckTrimPayload(runFilter(ctx.query)));
