// run.ts — the Run page's backend (last-run summary · pipeline audit · health · a SIMULATED worker run streamed over
// SSE) + the Data QA checks. Every number is derived from ../dataset so the Run page agrees with every other page.
//
// The simulated run: POST /run/start stamps {id, date, startedAt} into a module variable (mirrored to localStorage so a
// page refresh mid-run reconnects). Everything else is a pure function of (now − startedAt) over one fixed TIMELINE:
// /run/current and /run/progress replay the events already due and schedule the rest, and /audit flips each stage
// PENDING → RUNNING → SUCCESS on the same clock — so the stream, the snapshot and the audit can never disagree.
import { get, post, stream, HttpError, type Ctx } from '../router';
import { requireUser } from './core';
import {
  CFA, CFA_NAME, ALT_CFA, PLANTS, DISTRIBUTORS, REG_ZSKUS, DEMAND, RUN_RESULTS, LANES, CLUSTERS, PRIMARY_CAP,
  RUN_DATES, LATEST_DATE, SOQ_DATE, RUN_TIMESTAMP, OE_PARAM_DEFS, type Lane,
} from '../dataset';

// ───────────────────────── small helpers ─────────────────────────
type Cell = string | number | boolean | null;
const nf = (n: number) => Math.round(n).toLocaleString('en-US');
const sum = <T,>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const pct = (a: number, b: number) => Math.round((a / Math.max(1, b)) * 1000) / 10;
const IST_MS = 5.5 * 3600 * 1000;
const isoIst = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 19) + '+05:30';
const isRunDate = (d: string) => RUN_DATES.includes(d);
const dbName = (code: string) => DISTRIBUTORS.find((d) => d.code === code)?.name ?? code;
const plural = (n: number, w: string, many = `${w}s`) => `${nf(n)} ${n === 1 ? w : many}`;

// ───────────────────────── run identity (baseline runs = one per run date) ─────────────────────────
const BASE_RUN_ID = 41;                                         // 8-Oct → #41, 9-Oct → #42, 10-Oct → #43
const BASE_DURATION: Record<string, number> = { '8-Oct-2026': 372, '9-Oct-2026': 341, '10-Oct-2026': 357 };   // wall-clock secs
const baseRunId = (date: string) => BASE_RUN_ID + Math.max(0, RUN_DATES.indexOf(date));
const finishedMs = (date: string) => Date.parse(RUN_TIMESTAMP[date] ?? RUN_TIMESTAMP[LATEST_DATE]);
const dayOf = (date: string) => (RUN_TIMESTAMP[date] ?? RUN_TIMESTAMP[LATEST_DATE]).slice(0, 10);   // 2026-10-10

// one order id per CFA × DB — OEID<YYYYMMDD>-<HHMMSS>-<NNNN> (the run's timestamp; NNNN in DB-id order)
const oeidOf = (date: string, db: string) => {
  const ts = RUN_TIMESTAMP[date] ?? RUN_TIMESTAMP[LATEST_DATE];
  const i = DISTRIBUTORS.findIndex((d) => d.code === db);
  return `OEID${ts.slice(0, 10).replace(/-/g, '')}-${ts.slice(11, 19).replace(/:/g, '')}-${String(i + 1).padStart(4, '0')}`;
};
// PDP day (scheduled delivery on the run day) — the same per-DB plan the Filtered-SOQ / RLM pages use (reservations.ts):
// a DB counts as PDP when it is due today, or when it has no below-threshold line (the gate needs one of the two)
const PDP_DUE = [true, false, true, false, true, true, false, true, false, true];
const isPdpDb = (code: string) => {
  const i = DISTRIBUTORS.findIndex((d) => d.code === code);
  return !!PDP_DUE[i] || !DEMAND.some((x) => x.db === code && x.dbStock < 0.25 * x.norm);
};

// ───────────────────────── outcome buckets (from the dataset's SO disposition) ─────────────────────────
const heldCases = (l: Lane) => (l.dropped ? l.dropOrig + l.dropSub + l.dropFil : l.shipped);
const heldTrucks = (l: Lane) => (l.dropped ? Math.max(1, Math.ceil(heldCases(l) / l.db.truckCap)) : l.trucks);
const skuLines = (l: Lane) => sum(l.loads, (ld) => ld.skus.length);
const SO_LANES = LANES.filter((l) => l.soFlag === 'SO_CREATION' && l.shipped > 0);
const RLM_LANES = LANES.filter((l) => l.soFlag === 'RLM_TRUCK_APPROVAL');
const SECOND_LANES = LANES.filter((l) => l.soFlag === 'RLM_FOR_SECOND_CFA');
const DROPPED_LANES = LANES.filter((l) => l.soFlag === 'SO_CREATION' && l.shipped === 0);   // nothing ships, nothing held
// RLM's decision at the rollup — same alternation the RLM pages use (reservations.ts): truck-approval lanes in DB order
// APPROVED, REJECTED, …; 2nd-CFA offers SHIFTED (taken by the secondary), then sent from the primary, …
type RlmKind = 'approved' | 'rejected' | 'secondary' | 'primary';
const rlmDecision = (l: Lane): RlmKind => (l.soFlag === 'RLM_TRUCK_APPROVAL'
  ? (RLM_LANES.indexOf(l) % 2 === 0 ? 'approved' : 'rejected')
  : (SECOND_LANES.indexOf(l) % 2 === 0 ? 'secondary' : 'primary'));

function rlmAfter(date: string, rolledUp: boolean) {
  const held = [...RLM_LANES, ...SECOND_LANES];
  const so_trucks = sum(SO_LANES, (l) => l.trucks);
  if (!rolledUp) {
    return {
      shipped_dbs: SO_LANES.length, primary_dbs: 0, pending_dbs: held.length, shifted_dbs: 0, rejected_dbs: 0,
      dropped_dbs: DROPPED_LANES.length, shipped_with_rejected_dbs: 0, shipped_trucks: so_trucks, so_trucks,
      approved_trucks: 0, primary_ships_trucks: 0, rejected_trucks: 0, shifted_trucks: 0, pending_trucks: sum(held, heldTrucks),
      shipped_after_rlm_dbs: 0, after_rlm_approved_dbs: 0, after_rlm_partial_dbs: 0, after_rlm_primary_dbs: 0, after_rlm_secondary_dbs: 0,
      after_rlm_db_list: { approved: [], partial: [], primary: [], secondary: [] }, after_rlm_rows: [],
    };
  }
  const by = (k: RlmKind) => held.filter((l) => rlmDecision(l) === k);
  const approved = by('approved'), rejected = by('rejected'), secondary = by('secondary'), primary = by('primary');
  const after = [...approved, ...primary, ...secondary];
  return {
    shipped_dbs: SO_LANES.length + after.length, primary_dbs: primary.length, pending_dbs: 0, shifted_dbs: secondary.length,
    rejected_dbs: rejected.length, dropped_dbs: DROPPED_LANES.length, shipped_with_rejected_dbs: 0,
    shipped_trucks: so_trucks + sum(approved, heldTrucks) + sum(primary, heldTrucks), so_trucks,
    approved_trucks: sum(approved, heldTrucks), primary_ships_trucks: sum(primary, heldTrucks), rejected_trucks: sum(rejected, heldTrucks),
    shifted_trucks: sum(secondary, heldTrucks), pending_trucks: 0,
    shipped_after_rlm_dbs: after.length, after_rlm_approved_dbs: approved.length, after_rlm_partial_dbs: 0,
    after_rlm_primary_dbs: primary.length, after_rlm_secondary_dbs: secondary.length,
    after_rlm_db_list: { approved: approved.map((l) => l.db.code), partial: [] as string[], primary: primary.map((l) => l.db.code), secondary: secondary.map((l) => l.db.code) },
    after_rlm_rows: after.map((l) => ({ db: l.db.code, kind: rlmDecision(l) as 'approved' | 'primary' | 'secondary', oeid: oeidOf(date, l.db.code) })),
  };
}

/** The per-CFA block the Run page (hero · funnel · CFA card) and CfaEmptyReason read. */
function perCfa(date: string, rolledUp: boolean) {
  const perChannel: Record<string, number> = {};
  for (const r of RUN_RESULTS) perChannel[r.run.label] = sum(SO_LANES.filter((l) => l.run === r.run.run), (l) => l.shipped);
  const total = sum(SO_LANES, (l) => l.shipped);
  const rlmCases = sum(RLM_LANES, heldCases), secondCases = sum(SECOND_LANES, heldCases);
  return {
    total_allocated_cases: total,
    so_created_cases: total,
    so_held_pending_cases: 0,                      // every held DB has a single (part-load) truck → no SO-ready trucks wait on it
    rlm_truck_cases: rlmCases,
    rlm_second_cfa_cases: secondCases,
    rlm_held_cases: rlmCases + secondCases,
    allocated_incl_rlm_cases: total + rlmCases + secondCases,
    sku_lines: sum(SO_LANES, skuLines),
    dbs: SO_LANES.length,
    dbs_held: 0,
    dbs_in_scope: DISTRIBUTORS.length,
    dbs_network: DISTRIBUTORS.length,
    per_channel: perChannel,
    soq_dbs: DISTRIBUTORS.length,
    filtered_dbs: LANES.length,
    pdp_dbs: LANES.filter((l) => isPdpDb(l.db.code)).length,
    nonpdp_dbs: LANES.filter((l) => !isPdpDb(l.db.code)).length,
    so_dbs: SO_LANES.length,
    rlm_truck_dbs: RLM_LANES.length,
    second_cfa_dbs: SECOND_LANES.length,
    dropped_dbs: DROPPED_LANES.length,
    so_trucks: sum(SO_LANES, (l) => l.trucks),
    rlm_truck_trucks: sum(RLM_LANES, heldTrucks),
    second_cfa_trucks: sum(SECOND_LANES, heldTrucks),
    so_db_list: SO_LANES.map((l) => ({ db: l.db.code, trucks: l.trucks, oeid: oeidOf(date, l.db.code) })),
    rlm_db_list: RLM_LANES.map((l) => ({ db: l.db.code, rlm_trucks: heldTrucks(l), held_trucks: 0 })),
    second_cfa_db_list: SECOND_LANES.map((l) => ({ db: l.db.code, oeid: oeidOf(date, l.db.code), primary_cfa: CFA, secondary_cfa: ALT_CFA })),
    dropped_db_list: DROPPED_LANES.map((l) => ({ db: l.db.code, reason: 'Every truck below the 65% fill floor', soq: l.soq, cases_dropped: l.planned })),
    rlm_after: rlmAfter(date, rolledUp),
    rlm_rolled_up: rolledUp,
    rlm_had: RLM_LANES.length + SECOND_LANES.length > 0,
  };
}

const CFA_INV_ROWS = REG_ZSKUS.reduce((a, z) => a + z.skus.length, 0);   // SKU × batch rows at the CFA
function summaryPayload(date: string) {
  if (!isRunDate(date)) {
    return { available: false, date, data_date: null, cfas: [], summary: {}, orders: { count: 0 },
      diagnostics: { soq_rows: 0, filtered_soq_rows: 0, cfa_inventory_rows: 0 } };
  }
  const sim = loadSim();
  const isSim = !!sim && sim.date === date;
  if (isSim && simElapsed(sim!) < T.done) {   // a run for this date is in flight — it cleared the previous output
    return { available: false, running: true, run_id: sim!.id, date, data_date: SOQ_DATE[date], cfas: [], summary: {}, orders: { count: 0 },
      note: `Run #${sim!.id} for ${date} is in progress — results land when it finishes` };
  }
  return {
    available: true, date, data_date: SOQ_DATE[date], run_id: isSim ? sim!.id : baseRunId(date),
    finished_at: isSim ? isoIst(sim!.startedAt + T.done) : RUN_TIMESTAMP[date],
    cfas: [CFA], summary: { [CFA]: perCfa(date, rolledUpFor(date)) },
    orders: { count: sum(SO_LANES, skuLines) },
    diagnostics: { soq_rows: DEMAND.length, filtered_soq_rows: DEMAND.length, cfa_inventory_rows: CFA_INV_ROWS },
  };
}

// ───────────────────────── the simulated live run ─────────────────────────
// event times (ms after start) — ~21 s end to end
const T = {
  start: 0, clear: 600, s3: 1300, pre: 7400, scope: 7900, gate: 8400, cfas: 8900, res: 9500, resInfo: 10000,
  r1s1: 10600, r1s2: 11200, r1s3: 11800, r1truck: 12400, r1sum: 12900,
  r2s1: 13500, r2s2: 14100, r2s3: 14700, r2truck: 15300, r2sum: 15800,
  cluster: 16300, dispo: 16800, disagg: 17300, disaggOut: 17900, sap: 18400, sapOut: 18900,
  s3up: 19300, s3upOut: 19700, rlm: 20100, cfaDone: 20700, done: 21300, end: 21600,
};
const ROLLUP_AFTER_MS = 60_000;    // the RLM rollup cron (15:30 in production) — compressed to 1 min after a demo run
const ROLLUP_RUN_MS = 8_000;

interface SimRun { id: number; date: string; startedAt: number; source: string; user: string }
const SIM_KEY = 'aiden.demo.simrun';
let simMem: SimRun | null = null;
function loadSim(): SimRun | null {
  try {
    const raw = localStorage.getItem(SIM_KEY);
    if (raw) {
      const s = JSON.parse(raw) as SimRun;
      if (s && typeof s.startedAt === 'number' && isRunDate(s.date) && s.startedAt <= Date.now() + 5000) simMem = s;
    }
  } catch { /* storage blocked — keep the in-memory copy */ }
  return simMem;
}
function saveSim(s: SimRun): void {
  simMem = s;
  try { localStorage.setItem(SIM_KEY, JSON.stringify(s)); } catch { /* in-memory only */ }
}
const simElapsed = (s: SimRun) => Date.now() - s.startedAt;
const simRunning = (s: SimRun | null): boolean => !!s && simElapsed(s) < T.end;
/** RLM rollup done for this date? Baseline runs: yes. The demo run: only once its (compressed) rollup has run. */
function rolledUpFor(date: string): boolean {
  const s = loadSim();
  if (!s || s.date !== date) return true;
  return simElapsed(s) >= T.done + ROLLUP_AFTER_MS + ROLLUP_RUN_MS;
}

// per-run stats for the event labels
const RUN_STATS = RUN_RESULTS.map((r) => {
  const ls = r.lanes;
  return {
    label: r.run.label, pct: r.run.pct, dbs: ls.length,
    soq: sum(ls, (l) => l.soq), orig: sum(ls, (l) => l.orig),
    sub: sum(ls, (l) => l.sub), subLines: sum(ls, (l) => l.lines.filter((x) => x.subGot > 0).length),
    filler: sum(ls, (l) => l.filler), fillerLines: sum(ls, (l) => l.lines.filter((x) => x.filler > 0).length),
    cascaded: sum(ls, (l) => l.cascaded), tails: ls.filter((l) => l.cascaded > 0).length,
    belowRlm: ls.filter((l) => l.dropped && l.soFlag === 'RLM_TRUCK_APPROVAL').length,
    belowSecond: ls.filter((l) => l.dropped && l.soFlag === 'RLM_FOR_SECOND_CFA').length,
    trucks: sum(ls, (l) => l.trucks), built: sum(ls, (l) => l.shipped),
    reserved: sum(Object.values(r.reserved), (x) => x), leftover: sum(Object.values(r.leftover), (x) => Math.max(0, x)),
    ownShare: sum(REG_ZSKUS, (z) => Math.floor((z.cfaStock * r.run.pct) / 100)),
  };
});
const ATP = sum(REG_ZSKUS, (z) => z.cfaStock);
const TRUCK_TYPES = new Set(DISTRIBUTORS.map((d) => d.truckType)).size;
const CLUSTER_DBS = DISTRIBUTORS.filter((d) => d.cluster).length;

interface TEv { at: number; ev: Record<string, unknown> }
function timeline(s: SimRun): TEv[] {
  const soq = SOQ_DATE[s.date];
  const pdp = LANES.filter((l) => isPdpDb(l.db.code)).length;
  const [r1, r2] = RUN_STATS;
  const so = sum(SO_LANES, (l) => l.shipped), held = sum(RLM_LANES, heldCases) + sum(SECOND_LANES, heldCases);
  const lines = sum(SO_LANES, skuLines), trucks = sum(SO_LANES, (l) => l.trucks);
  const tbl = (at: number, label: string, rows: number, secs: number): TEv => ({ at, ev: { phase: 'table', label, rows, secs } });
  const runEvents = (r: typeof r1, i: number, t: [number, number, number, number, number]): TEv[] => [
    { at: t[0], ev: { phase: 'engine', label: `CFA ${CFA} · ${r.label} — Step 1 water-fill · ${plural(r.dbs, 'DB')} · SOQ ${nf(r.soq)} → original ${nf(r.orig)} cases (${pct(r.orig, r.soq)}%)` } },
    { at: t[1], ev: { phase: 'engine', label: `${r.label} · Step 2 substitutes — ${nf(r.sub)} cases cover ${plural(r.subLines, 'short line')} (same category, ≤ 35% add-on)` } },
    { at: t[2], ev: { phase: 'engine', label: `${r.label} · Step 3 filler — ${nf(r.filler)} cases on ${plural(r.fillerLines, 'line')} to top up truck room` } },
    { at: t[3], ev: { phase: 'info', label: `${r.label} · Truck rule — ${plural(r.tails, 'last-truck tail')} under 65% trimmed (${nf(r.cascaded)} cases cascade)`
      + (r.belowRlm ? ` · ${plural(r.belowRlm, 'lane')} can't fill one truck → RLM truck approval` : '')
      + (r.belowSecond ? ` · ${plural(r.belowSecond, 'lane')} under 50% original fill → offered to CFA ${ALT_CFA}` : '') } },
    { at: t[4], ev: { phase: 'info', label: `${r.label} · ${plural(r.trucks, 'truck')} built · ${nf(r.built)} cases`
      + (i === 0 ? ` · ${nf(r.leftover)} cases left in the pool → carried to ${RUN_STATS[1]?.label ?? 'the next run'}` : ` · ${nf(r.leftover)} cases stay at the CFA`) } },
  ];
  const evs: TEv[] = [
    { at: T.start, ev: { phase: 'start', label: `Run #${s.id} started · run date ${s.date} · SOQ snapshot ${soq}`, date: s.date } },
    { at: T.clear, ev: { phase: 'clear', label: `Cleared previous output for ${s.date} — engine tables, SAP hand-off rows, S3 order archive` } },
    { at: T.s3, ev: { phase: 'stage', label: 'S3 fetch — staging the masters + the SOQ feed' } },
    tbl(T.s3 + 450, 'material_master', CFA_INV_ROWS, 1.4),
    tbl(T.s3 + 850, 'region_sku_master', REG_ZSKUS.length, 0.6),
    tbl(T.s3 + 1250, 'brand_category_master', REG_ZSKUS.length, 0.5),
    tbl(T.s3 + 1600, 'plant_master', PLANTS.length, 0.3),
    tbl(T.s3 + 1950, 'db_master', DISTRIBUTORS.length, 0.4),
    tbl(T.s3 + 2300, 'db_tier_master', DISTRIBUTORS.length, 0.3),
    tbl(T.s3 + 2650, 'truck_type_master', TRUCK_TYPES, 0.3),
    tbl(T.s3 + 3000, 'cluster_master', CLUSTER_DBS, 0.3),
    tbl(T.s3 + 3500, `soq_feed · ${soq}`, DEMAND.length, 2.1),
    tbl(T.s3 + 3950, 'db_norms', DEMAND.length, 0.9),
    tbl(T.s3 + 4400, 'cfa_inventory', CFA_INV_ROWS * PLANTS.length, 1.2),
    tbl(T.s3 + 4850, 'db_inventory', DEMAND.length, 0.8),
    { at: T.s3 + 5450, ev: { phase: 'warning', label: `Daily run-rate not published for data date ${soq} — using the trailing 7-day rate (non-blocking)` } },
    { at: T.pre, ev: { phase: 'stage', label: 'Pre-filter — the demand gate (PDP day · below-threshold · combined SOQ ≥ 65%)' } },
    { at: T.scope, ev: { phase: 'scope', label: `Scoped CFA + DB inventory to the SOQ — ${nf(CFA_INV_ROWS * PLANTS.length)} → ${nf(CFA_INV_ROWS)} CFA rows · ${plural(DISTRIBUTORS.length, 'DB')} · ${nf(REG_ZSKUS.length)} reg-zskus`, rows: CFA_INV_ROWS } },
    { at: T.gate, ev: { phase: 'info', label: `Demand gate — ${nf(LANES.length)} of ${nf(DISTRIBUTORS.length)} DBs passed (${nf(pdp)} PDP · ${nf(LANES.length - pdp)} non-PDP)`, rows: DEMAND.length } },
    { at: T.cfas, ev: { phase: 'cfas', label: `CFAs with delivered demand: ${CFA} · ${CFA_NAME} (CFA ${ALT_CFA} has stock but no SOQ — standby for 2nd-CFA offers)` } },
    { at: T.res, ev: { phase: 'stage', label: `CFA ${CFA} · Reservation — CFA stock split across the channel runs` } },
    { at: T.resInfo, ev: { phase: 'info', label: `ATP ${nf(ATP)} cases → ${r1.label} pool ${nf(r1.reserved)} (${r1.pct}%)`
      + (r2 ? ` · ${r2.label} pool ${nf(r2.reserved)} (${r2.pct}% + Run 1 leftover)` : '') } },
    ...runEvents(r1, 0, [T.r1s1, T.r1s2, T.r1s3, T.r1truck, T.r1sum]),
    ...(r2 ? runEvents(r2, 1, [T.r2s1, T.r2s2, T.r2s3, T.r2truck, T.r2sum]) : []),
    ...CLUSTERS.map((c): TEv => ({ at: T.cluster, ev: { phase: 'info', label: `Cluster primary ${c.code} — ${plural(c.dbs.length, 'DB')} combined onto ${plural(c.primaryTrucks, 'primary truck')} · ${nf(c.combined)} / ${nf(c.primaryCap * Math.max(1, c.primaryTrucks))} cases · ${nf(c.trimmed)} trimmed` } })),
    { at: T.dispo, ev: { phase: 'info', label: `SO disposition — ${plural(SO_LANES.length, 'DB')} → SO creation · ${nf(RLM_LANES.length)} → RLM truck approval · ${nf(SECOND_LANES.length)} → 2nd CFA` } },
    ...SECOND_LANES.map((l): TEv => ({ at: T.dispo + 200, ev: { phase: 'rlm_shift', label: `${l.db.code} · ${l.db.name} — original fill ${l.origFillPct}% < 50% → offered to CFA ${ALT_CFA}` } })),
    { at: T.disagg, ev: { phase: 'stage', label: `CFA ${CFA} · Final order — FEFO disaggregation to SKU × batch (earliest expiry first)` } },
    { at: T.disaggOut, ev: { phase: 'info', label: `final_order written — ${plural(trucks, 'truck')} · ${nf(so)} cases`, rows: lines, secs: 0.7 } },
    { at: T.sap, ev: { phase: 'stage', label: `CFA ${CFA} · SAP hand-off — ${plural(SO_LANES.length, 'order')} (one OEID per CFA × DB)` } },
    { at: T.sapOut, ev: { phase: 'info', label: 'sap_orders appended', rows: lines, secs: 0.5 } },
    { at: T.s3up, ev: { phase: 'stage', label: `CFA ${CFA} · S3 upload — order_line_items parquet` } },
    { at: T.s3upOut, ev: { phase: 'info', label: `order_line_items/${dayOf(s.date)}/cfa=${CFA}.parquet`, rows: lines, secs: 0.9 } },
    { at: T.rlm, ev: { phase: 'stage', label: `CFA ${CFA} · RLM — ${plural(sum(RLM_LANES, heldTrucks), 'truck')} queued for approval · ${plural(SECOND_LANES.length, 'DB')} offered to a 2nd CFA (rollup at 15:30)` } },
    { at: T.cfaDone, ev: { phase: 'engine_done', label: `CFA ${CFA} done — ${nf(so)} SO cases · ${plural(trucks, 'truck')} · ${nf(lines)} SKU lines · ${nf(held)} cases on hold for RLM`, secs: Math.round((T.cfaDone - T.res) / 100) / 10 } },
    { at: T.done, ev: { phase: 'done', label: `Pipeline complete — run #${s.id} · ${s.date}`, date: s.date, secs: Math.round(T.done / 100) / 10 } },
    { at: T.end, ev: { phase: '_end', label: 'stream closed' } },
  ];
  return evs.sort((a, b) => a.at - b.at);
}
/** The timeline as numbered SSE payloads (seq = 1-based position; `done` carries the run summary). */
function events(s: SimRun) {
  return timeline(s).map((t, i) => {
    const ev: Record<string, unknown> = { seq: i + 1, ...t.ev, ts: isoIst(s.startedAt + t.at) };
    if (ev.phase === 'done') ev.summary = { [CFA]: perCfa(s.date, false) };
    return { at: t.at, ev };
  });
}

// ───────────────────────── pipeline audit (stage checkpoints) ─────────────────────────
// [stage, shared?, from, to] on the TIMELINE clock; baseline runs scale the same plan to their real wall-clock
const STAGES: [string, boolean, number, number][] = [
  ['s3_fetch', true, T.s3, T.pre], ['pre_filter', true, T.pre, T.res],
  ['reservation', false, T.res, T.r1s1], ['step1', false, T.r1s1, T.r2s2], ['step2', false, T.r1s2, T.r2s3],
  ['step3', false, T.r1s3, T.disagg], ['disaggregation', false, T.disagg, T.sap], ['sap_orders', false, T.sap, T.s3up],
  ['s3_upload', false, T.s3up, T.rlm], ['rlm', false, T.rlm, T.cfaDone],
];
function auditRow(runId: number, date: string, startMs: number, scale: number, elapsed: number,
  cron: { status: string; from: number; to: number }) {
  const at = (t: number) => startMs + t * scale;
  const cfa_stages = STAGES.map(([stage, shared, from, to]) => {
    const status = elapsed >= to ? 'SUCCESS' : elapsed >= from ? 'RUNNING' : 'PENDING';
    return { cfa: shared ? 'ALL' : CFA, stage, status, error_message: null,
      started_at: status === 'PENDING' ? null : isoIst(at(from)), finished_at: status === 'SUCCESS' ? isoIst(at(to)) : null };
  });
  // the daily RLM rollup cron — its cell is listed from the start (PENDING until it runs) so the matrix is always complete
  cfa_stages.push({ cfa: CFA, stage: 'rlm_cron', status: cron.status, error_message: null,
    started_at: cron.status === 'PENDING' ? null : isoIst(cron.from), finished_at: cron.status === 'SUCCESS' ? isoIst(cron.to) : null });
  const running = elapsed < T.done;
  return {
    run_id: runId, run_date: date, data_date: SOQ_DATE[date] ?? null, cfa_scope: [CFA],
    overall_status: running ? 'RUNNING' : 'SUCCESS', rlm_cron_status: cron.status,
    started_at: isoIst(startMs), finished_at: running ? null : isoIst(at(T.done)),
    duration_secs: Math.round((running ? elapsed : T.done) * scale / 1000),
    cfa_stages,
  };
}
function baseAudit(date: string) {
  const dur = (BASE_DURATION[date] ?? 350) * 1000, end = finishedMs(date);
  const cronFrom = Date.parse(`${dayOf(date)}T15:30:00+05:30`);
  return auditRow(baseRunId(date), date, end - dur, dur / T.done, Infinity, { status: 'SUCCESS', from: cronFrom, to: cronFrom + 64_000 });
}
function simAudit(s: SimRun) {
  const el = simElapsed(s);
  const cronFrom = s.startedAt + T.done + ROLLUP_AFTER_MS, cronTo = cronFrom + ROLLUP_RUN_MS;
  const now = Date.now();
  const cron = now >= cronTo ? 'SUCCESS' : now >= cronFrom ? 'RUNNING' : 'PENDING';
  return auditRow(s.id, s.date, s.startedAt, 1, el, { status: cron, from: cronFrom, to: cronTo });
}

// ───────────────────────── routes: Run page ─────────────────────────
get('/api/production/health', () => {
  const s = loadSim();
  return { status: 'ok', db: 'oe_demo · in-browser demo dataset', s3: 'ok', worker: simRunning(s) ? 'running' : 'idle',
    cfas: [CFA], latest_run: s ? s.date : LATEST_DATE, mode: 'demo' };
});

get('/api/v1/last_run_summary', (ctx) => summaryPayload(ctx.date));

get('/api/production/audit', (ctx) => {
  const want = ctx.query.get('date') || '';
  const s = loadSim();
  if (!want) return { runs: [...(s ? [simAudit(s)] : []), ...[...RUN_DATES].reverse().map(baseAudit)] };   // newest first
  if (s && s.date === want) return { runs: [simAudit(s), baseAudit(want)] };
  return { runs: isRunDate(want) ? [baseAudit(want)] : [] };
});

get('/api/production/run/current', (ctx) => {
  const since = Math.max(0, Number(ctx.query.get('since')) || 0);
  const s = loadSim();
  if (s && simRunning(s)) {
    const el = simElapsed(s);
    const due = events(s).filter((e) => e.at <= el);
    return { status: 'running', source: s.source, run_id: s.id, date: s.date, data_date: SOQ_DATE[s.date],
      started_by: s.user, started_at: isoIst(s.startedAt), elapsed_secs: Math.floor(el / 1000),
      last_seq: due.length, events: due.filter((e) => Number(e.ev.seq) > since).map((e) => e.ev) };
  }
  const last = s ?? null;
  return { status: 'idle', source: null, run_id: null, last_seq: 0, events: [],
    last_run: last ? { run_id: last.id, date: last.date, status: 'SUCCESS', finished_at: isoIst(last.startedAt + T.done) }
      : { run_id: baseRunId(LATEST_DATE), date: LATEST_DATE, status: 'SUCCESS', finished_at: RUN_TIMESTAMP[LATEST_DATE] } };
});

function startRun(ctx: Ctx) {
  const u = requireUser(ctx);
  if (!u.can_access_run) throw new HttpError(403, 'You do not have run access — ask an admin to grant it');
  const cfa = (ctx.query.get('cfa') || '').replace(/^0+/, '');
  const want = ctx.query.get('date') || '';
  const date = isRunDate(want) ? want : LATEST_DATE;   // the demo's SOQ snapshots are 8–10 Oct; any other date runs the latest
  if (cfa && cfa !== CFA) throw new HttpError(400, `CFA ${cfa} has no delivered SOQ for ${date} — nothing to run`);
  return { u, date, cfa };
}
post('/api/production/run/start', (ctx) => {
  const { u, date } = startRun(ctx);
  const cur = loadSim();
  if (cur && simRunning(cur)) {
    return { started: false, status: 'running', run_id: cur.id, date: cur.date, source: cur.source,
      detail: 'A run is already in progress — attaching to its live log' };
  }
  const s: SimRun = { id: Math.max(baseRunId(LATEST_DATE), cur?.id ?? 0) + 1, date, startedAt: Date.now(), source: 'manual', user: u.username };
  saveSim(s);
  return { started: true, status: 'running', run_id: s.id, date, data_date: SOQ_DATE[date], cfas: [CFA], source: s.source,
    started_at: isoIst(s.startedAt) };
});

// live progress — replay what's already happened (seq > since), then push the rest on the run's own clock
stream('/api/production/run/progress', (ctx, send, close) => {
  const since = Math.max(0, Number(ctx.query.get('since')) || 0);
  const s = loadSim();
  if (!s || !simRunning(s)) { send({ phase: '_idle', seq: since, label: 'no run in progress' }); close(); return; }
  const el = simElapsed(s);
  const timers: number[] = [];
  for (const e of events(s)) {
    if (Number(e.ev.seq) <= since) continue;
    const fire = () => { send(e.ev); if (e.ev.phase === '_end') close(); };
    if (e.at <= el) fire(); else timers.push(window.setTimeout(fire, e.at - el));
  }
  return () => timers.forEach((t) => window.clearTimeout(t));
});

// synchronous (non-worker) run + the orders it produced — the production contract's one-shot endpoints
const runSummary = (date: string) => ({ ...summaryPayload(date), status: 'SUCCESS' });
post('/api/production/run', (ctx) => { const { date } = startRun(ctx); return runSummary(date); });
post('/api/v1/run', (ctx) => { const { date } = startRun(ctx); return runSummary(date); });
get('/api/production/orders', (ctx) => {
  const date = isRunDate(ctx.date) ? ctx.date : LATEST_DATE;
  const cfa = (ctx.query.get('cfa') || '').replace(/^0+/, '');
  const orders = cfa && cfa !== CFA ? [] : SO_LANES.flatMap((l) => l.loads.map((ld) => ({
    oeid: oeidOf(date, l.db.code), order_id: ld.order, cfa: CFA, db: l.db.code, db_name: l.db.name, channel: l.db.channel,
    truck_id: ld.truckid, truck_no: ld.no, truck_type: l.db.truckType, cases: ld.cases, lines: ld.skus.length,
    so_flag: l.soFlag,
  })));
  return { date, data_date: SOQ_DATE[date], cfa: cfa || null, count: orders.length, orders };
});

// ───────────────────────── Data QA checks ─────────────────────────
type Status = 'pass' | 'fail' | 'warn' | 'skip';
interface Check {
  id: string; table: string; category: string; severity: 'high' | 'medium' | 'low'; title: string; phase: 'pre' | 'post';
  total: number; bad?: number; warn?: boolean; skip?: string; reason?: string; ok?: string; example?: string | null;
  cols?: string[]; rows?: Cell[][];
}
const ALL_LINES = LANES.flatMap((l) => l.lines.map((x) => ({ l, x })));
const shipOf = (x: Lane['lines'][number]) => x.shipOrig + x.shipSub + x.shipFil;

function checks(date: string): Check[] {
  const latest = date === LATEST_DATE;
  const first = RUN_DATES.indexOf(date) === 0;
  const variants = REG_ZSKUS.flatMap((z) => z.skus.map((v) => ({ z, v })));
  // ── data-driven offenders ──
  const noStock = DEMAND.filter((d) => (REG_ZSKUS.find((z) => z.rz === d.rz)?.cfaStock ?? 0) === 0);
  const soqBy = (rz: string) => sum(DEMAND.filter((d) => d.rz === rz), (d) => d.soq);
  const scarce = REG_ZSKUS.filter((z) => z.cfaStock > 0 && z.cfaStock < 0.5 * soqBy(z.rz));
  const shortLife = variants.filter(({ v }) => v.daysToExpiry < 30);
  const zeroOnHand = DEMAND.filter((d) => d.dbStock === 0);
  const belowFloor = LANES.filter((l) => l.dropped);
  const lowOrig = LANES.filter((l) => l.origFillPct < 50);
  const addonOver = LANES.filter((l) => l.sub + l.filler > Math.floor(l.soq * 0.35));
  const overNorm = ALL_LINES.filter(({ x }) => x.maxNorm > 0 && x.soq > 0 && x.dbStock + shipOf(x) > x.maxNorm);
  const overdrawn = RUN_RESULTS.flatMap((r) => Object.entries(r.leftover).filter(([, v]) => v < 0).map(([rz, v]) => ({ r, rz, v })));
  const overCap = LANES.flatMap((l) => l.loads.filter((ld) => ld.cases > l.db.truckCap).map((ld) => ({ l, ld })));
  const soLines = sum(SO_LANES, skuLines);
  const soTrucks = sum(SO_LANES, (l) => l.trucks);
  const dbName10 = (code: string) => `${code} · ${dbName(code)}`;
  return [
    // ════════ PRE-OR-RUN · input & master data ════════
    { id: 'SOQ-01', table: 'soq_feed', category: 'Completeness', severity: 'high', phase: 'pre', title: 'No blank DB code, reg-zsku or SOQ quantity', total: DEMAND.length },
    { id: 'SOQ-02', table: 'soq_feed', category: 'Format', severity: 'high', phase: 'pre', title: 'DB codes are 10-digit, zero-padded', total: DEMAND.length },
    { id: 'SOQ-03', table: 'soq_feed', category: 'Format', severity: 'high', phase: 'pre', title: 'reg-zsku follows <zsku>-<region>', total: DEMAND.length },
    { id: 'SOQ-04', table: 'soq_feed', category: 'Range', severity: 'medium', phase: 'pre', title: 'SOQ is a positive whole number of cases', total: DEMAND.length },
    { id: 'SOQ-05', table: 'soq_feed', category: 'Uniqueness', severity: 'high', phase: 'pre', title: 'One row per DB × reg-zsku (no duplicated feed rows)', total: DEMAND.length },
    { id: 'SOQ-06', table: 'soq_feed', category: 'Freshness', severity: 'high', phase: 'pre', title: `Snapshot is dated the day before the run (${SOQ_DATE[date] ?? '—'})`, total: 1 },
    { id: 'NRM-01', table: 'db_norms', category: 'Completeness', severity: 'high', phase: 'pre', title: 'A norm exists for every SOQ line', total: DEMAND.length },
    { id: 'NRM-02', table: 'db_norms', category: 'Range', severity: 'medium', phase: 'pre', title: 'Norm ≥ SOQ (SOQ = norm − on-hand)', total: DEMAND.length },
    { id: 'NRM-03', table: 'db_norms', category: 'Range', severity: 'low', phase: 'pre', title: 'Max-norm = 1.2 × norm (rounded)', total: DEMAND.length },
    { id: 'MAT-01', table: 'material_master', category: 'Format', severity: 'high', phase: 'pre', title: 'SKU code is a 9-digit number', total: variants.length },
    { id: 'MAT-02', table: 'material_master', category: 'Range', severity: 'high', phase: 'pre', title: 'Units per case > 0', total: variants.length },
    { id: 'MAT-03', table: 'material_master', category: 'Integrity', severity: 'high', phase: 'pre', title: 'Every SKU maps to a reg-zsku', total: variants.length },
    { id: 'MAT-04', table: 'material_master', category: 'Integrity', severity: 'medium', phase: 'pre', title: 'SKU MRP matches the region-SKU master MRP', total: variants.length },
    { id: 'MAT-05', table: 'material_master', category: 'Uniqueness', severity: 'high', phase: 'pre', title: 'No duplicated SKU codes', total: variants.length },
    { id: 'RSK-01', table: 'region_sku_master', category: 'Uniqueness', severity: 'medium', phase: 'pre', title: 'One description per reg-zsku', total: REG_ZSKUS.length },
    { id: 'RSK-02', table: 'region_sku_master', category: 'Completeness', severity: 'medium', phase: 'pre', title: 'Every reg-zsku has a brand + category', total: REG_ZSKUS.length },
    { id: 'RSK-03', table: 'region_sku_master', category: 'Range', severity: 'low', phase: 'pre', title: 'Band is Band 1 / Band 2 / Band 3', total: REG_ZSKUS.length },
    { id: 'RSK-04', table: 'region_sku_master', category: 'Completeness', severity: 'low', phase: 'pre', title: 'Filler-eligibility flag is set (Y / N)', total: REG_ZSKUS.length },
    { id: 'DBM-01', table: 'db_master', category: 'Completeness', severity: 'medium', phase: 'pre', title: 'Customer name present', total: DISTRIBUTORS.length },
    { id: 'DBM-02', table: 'db_master', category: 'Completeness', severity: 'medium', phase: 'pre', title: 'GSTIN present', total: DISTRIBUTORS.length },
    { id: 'DBM-03', table: 'db_master', category: 'Completeness', severity: 'low', phase: 'pre', title: 'Sales office assigned', total: DISTRIBUTORS.length },
    { id: 'DBM-04', table: 'db_master', category: 'Range', severity: 'medium', phase: 'pre', title: 'Channel is Non-PACE or Retail', total: DISTRIBUTORS.length },
    { id: 'TIR-01', table: 'db_tier_master', category: 'Integrity', severity: 'medium', phase: 'pre', title: 'Every SOQ distributor has a tier (else the default tier 4)', total: DISTRIBUTORS.length },
    { id: 'TIR-02', table: 'db_tier_master', category: 'Range', severity: 'low', phase: 'pre', title: 'Tier is between 1 and 4', total: DISTRIBUTORS.length },
    { id: 'TRK-01', table: 'truck_type_master', category: 'Integrity', severity: 'high', phase: 'pre', title: 'Every DB lane has a truck type with capacity > 0', total: DISTRIBUTORS.length },
    { id: 'TRK-02', table: 'truck_type_master', category: 'Integrity', severity: 'medium', phase: 'pre', title: 'ACE-container lanes belong to a transshipment cluster', total: CLUSTER_DBS },
    { id: 'CLU-01', table: 'cluster_master', category: 'Integrity', severity: 'medium', phase: 'pre', title: 'All DBs of a cluster share one CFA', total: CLUSTER_DBS },
    { id: 'CLU-02', table: 'cluster_master', category: 'Completeness', severity: 'low', phase: 'pre', title: `Primary truck capacity configured (${nf(PRIMARY_CAP)} cases)`, total: CLUSTERS.length },
    { id: 'INV-01', table: 'cfa_inventory', category: 'Range', severity: 'high', phase: 'pre', title: 'Stock is non-negative', total: variants.length },
    { id: 'INV-02', table: 'cfa_inventory', category: 'Completeness', severity: 'medium', phase: 'pre', title: 'Batch code present on every stock row', total: variants.length },
    { id: 'INV-03', table: 'cfa_inventory', category: 'Range', severity: 'high', phase: 'pre', title: 'Shelf life ≥ 30 days on every sellable batch (FEFO floor)', total: variants.length,
      bad: shortLife.length, reason: `${plural(shortLife.length, 'batch', 'batches')} under 30 days to expiry still counted as sellable stock`,
      example: shortLife[0] ? `${shortLife[0].v.sku} · batch ${shortLife[0].v.batch} · ${shortLife[0].v.daysToExpiry} days` : null,
      cols: ['plant', 'sku', 'reg_zsku', 'description', 'batch', 'days_to_expiry', 'is_pdp'],
      rows: shortLife.map(({ z, v }) => [CFA, v.sku, z.rz, v.desc, v.batch, v.daysToExpiry, v.isPdp]) },
    { id: 'INV-04', table: 'cfa_inventory', category: 'Format', severity: 'low', phase: 'pre', title: 'PDP-batch flag is Y / N only', total: variants.length },
    { id: 'INV-05', table: 'cfa_inventory', category: 'Uniqueness', severity: 'high', phase: 'pre', title: 'One row per plant × SKU × batch', total: variants.length },
    { id: 'DBI-01', table: 'db_inventory', category: 'Completeness', severity: 'low', phase: 'pre', title: 'DB on-hand reported for every SOQ line', total: DEMAND.length,
      bad: zeroOnHand.length, warn: true,
      reason: `${nf(zeroOnHand.length)} of ${nf(DEMAND.length)} lines report 0 on-hand — likely genuine stock-outs; confirm the DMS feed is complete`,
      example: zeroOnHand[0] ? `${zeroOnHand[0].db} · ${zeroOnHand[0].rz} · SOQ ${zeroOnHand[0].soq}` : null,
      cols: ['db', 'db_name', 'reg_zsku', 'soq', 'norm', 'db_stock'],
      rows: zeroOnHand.map((d) => [d.db, dbName(d.db), d.rz, d.soq, d.norm, d.dbStock]) },
    { id: 'DBI-02', table: 'db_inventory', category: 'Range', severity: 'medium', phase: 'pre', title: 'On-hand ≤ 1.2 × norm', total: DEMAND.length,
      bad: DEMAND.filter((d) => d.dbStock > Math.round(d.norm * 1.2)).length },
    { id: 'XT-01', table: 'cross_table', category: 'Integrity', severity: 'high', phase: 'pre', title: 'Every SOQ reg-zsku has stock at its CFA', total: DEMAND.length,
      bad: noStock.length,
      reason: `${plural(noStock.length, 'SOQ line')} ask for a reg-zsku with zero CFA stock — they can only be met by substitutes`,
      example: noStock[0] ? `${noStock[0].db} · ${noStock[0].rz} · SOQ ${noStock[0].soq} · CFA stock 0` : null,
      cols: ['cfa', 'db', 'db_name', 'reg_zsku', 'description', 'soq', 'cfa_stock'],
      rows: noStock.map((d) => [CFA, d.db, dbName(d.db), d.rz, REG_ZSKUS.find((z) => z.rz === d.rz)?.desc ?? '', d.soq, 0]) },
    { id: 'XT-02', table: 'cross_table', category: 'Coverage', severity: 'medium', phase: 'pre', title: 'CFA stock covers ≥ 50% of the SOQ for each reg-zsku', total: REG_ZSKUS.length,
      bad: scarce.length, warn: true,
      reason: `${plural(scarce.length, 'reg-zsku')} short at the CFA (stock < 50% of SOQ) — fair share + substitutes will apply`,
      example: scarce[0] ? `${scarce[0].rz} · stock ${nf(scarce[0].cfaStock)} vs SOQ ${nf(soqBy(scarce[0].rz))}` : null,
      cols: ['reg_zsku', 'description', 'category', 'total_soq', 'cfa_stock', 'cover_pct'],
      rows: scarce.map((z) => [z.rz, z.desc, z.category, soqBy(z.rz), z.cfaStock, pct(z.cfaStock, soqBy(z.rz))]) },
    { id: 'XT-03', table: 'cross_table', category: 'Integrity', severity: 'high', phase: 'pre', title: 'Every SOQ DB exists in db_master', total: DISTRIBUTORS.length },
    { id: 'XT-04', table: 'cross_table', category: 'Integrity', severity: 'high', phase: 'pre', title: 'Every SOQ reg-zsku exists in region_sku_master', total: REG_ZSKUS.length },
    { id: 'XT-05', table: 'cross_table', category: 'Integrity', severity: 'medium', phase: 'pre', title: 'No DB is served by two CFAs on the same day', total: DISTRIBUTORS.length },
    { id: 'XT-06', table: 'cross_table', category: 'Freshness', severity: 'medium', phase: 'pre', title: 'SOQ feed is not a copy of the previous day', total: DEMAND.length,
      skip: first ? 'No previous SOQ snapshot in the window to compare with' : undefined },
    { id: 'PAR-01', table: 'oe_parameters', category: 'Completeness', severity: 'high', phase: 'pre', title: 'Every engine parameter is present', total: OE_PARAM_DEFS.length },
    { id: 'PAR-02', table: 'oe_parameters', category: 'Range', severity: 'medium', phase: 'pre', title: 'Percent thresholds lie between 0 and 1', total: OE_PARAM_DEFS.filter((p) => /PCT/.test(p.key)).length },

    // ════════ POST-OR-RUN · the engine's own output ════════
    { id: 'FO-01', table: 'final_order', category: 'Reconciliation', severity: 'high', phase: 'post', title: 'Shipped ≤ allocated on every line', total: ALL_LINES.length,
      bad: ALL_LINES.filter(({ x }) => x.shipOrig > x.orig || x.shipSub > x.sub || x.shipFil > x.filler).length },
    { id: 'FO-02', table: 'final_order', category: 'Reconciliation', severity: 'high', phase: 'post', title: 'Original + substitute + filler = planned, per lane', total: LANES.length },
    { id: 'FO-03', table: 'final_order', category: 'Rule', severity: 'medium', phase: 'post', title: 'Add-on (substitute + filler) ≤ 35% of the DB\'s SOQ', total: LANES.length,
      bad: addonOver.length, reason: `${plural(addonOver.length, 'lane')} over the 35% add-on cap`,
      cols: ['db', 'db_name', 'soq', 'substitute', 'filler', 'cap'], rows: addonOver.map((l) => [l.db.code, l.db.name, l.soq, l.sub, l.filler, Math.floor(l.soq * 0.35)]) },
    { id: 'FO-04', table: 'final_order', category: 'Rule', severity: 'low', phase: 'post', title: 'DB stock + shipped ≤ 1.2 × norm (room cap)', total: ALL_LINES.filter(({ x }) => x.soq > 0).length,
      bad: overNorm.length, warn: true,
      reason: `${plural(overNorm.length, 'line')} land above 1.2 × norm once substitutes are counted on the substitute reg-zsku`,
      example: overNorm[0] ? `${overNorm[0].l.db.code} · ${overNorm[0].x.rz} · ${nf(overNorm[0].x.dbStock + shipOf(overNorm[0].x))} vs cap ${nf(overNorm[0].x.maxNorm)}` : null,
      cols: ['db', 'db_name', 'reg_zsku', 'db_stock', 'shipped', 'max_norm'],
      rows: overNorm.map(({ l, x }) => [l.db.code, l.db.name, x.rz, x.dbStock, shipOf(x), x.maxNorm]) },
    { id: 'FO-05', table: 'final_order', category: 'Reconciliation', severity: 'high', phase: 'post', title: 'No run pool is over-drawn (per run × reg-zsku)', total: RUN_RESULTS.length * REG_ZSKUS.length,
      bad: overdrawn.length, reason: `${plural(overdrawn.length, 'pool')} over-drawn`,
      cols: ['run', 'reg_zsku', 'leftover'], rows: overdrawn.map(({ r, rz, v }) => [r.run.label, rz, v]) },
    { id: 'FO-06', table: 'final_order', category: 'Rule', severity: 'medium', phase: 'post', title: 'Original fill ≥ 50% of SOQ for SO-created DBs', total: LANES.length,
      bad: lowOrig.length, warn: true, reason: `${plural(lowOrig.length, 'DB')} below 50% original fill — offered to a 2nd CFA`,
      cols: ['db', 'db_name', 'soq', 'original', 'original_fill_pct'], rows: lowOrig.map((l) => [l.db.code, l.db.name, l.soq, l.orig, l.origFillPct]) },
    { id: 'TL-01', table: 'truck_loads', category: 'Rule', severity: 'high', phase: 'post', title: 'No truck loaded above its capacity', total: sum(LANES, (l) => l.loads.length),
      bad: overCap.length, reason: `${plural(overCap.length, 'truck')} over capacity`,
      cols: ['truck_id', 'db', 'cases', 'capacity'], rows: overCap.map(({ l, ld }) => [ld.truckid, l.db.code, ld.cases, l.db.truckCap]) },
    { id: 'TL-02', table: 'truck_loads', category: 'Rule', severity: 'medium', phase: 'post', title: 'Every lane fills one truck to the 65% floor', total: LANES.length,
      bad: belowFloor.length, warn: true,
      reason: `${plural(belowFloor.length, 'lane')} can't fill one truck to 65% — `
        + [[belowFloor.filter((l) => l.soFlag === 'RLM_TRUCK_APPROVAL').length, 'held for RLM truck approval'],
          [belowFloor.filter((l) => l.soFlag === 'RLM_FOR_SECOND_CFA').length, 'offered to a 2nd CFA']]
          .filter(([n]) => Number(n) > 0).map(([n, w]) => `${n} ${w}`).join(' · ') + ' (expected behaviour)',
      example: belowFloor[0] ? `${dbName10(belowFloor[0].db.code)} · ${nf(belowFloor[0].planned)} / ${nf(belowFloor[0].db.truckCap)} cases` : null,
      cols: ['db', 'db_name', 'truck_type', 'capacity', 'planned_cases', 'fill_pct', 'disposition'],
      rows: belowFloor.map((l) => [l.db.code, l.db.name, l.db.truckType, l.db.truckCap, l.planned, pct(l.planned, l.db.truckCap), l.soFlag]) },
    { id: 'TL-03', table: 'truck_loads', category: 'Uniqueness', severity: 'high', phase: 'post', title: 'Truck IDs are unique', total: sum(LANES, (l) => l.loads.length) },
    { id: 'TL-04', table: 'truck_loads', category: 'Reconciliation', severity: 'high', phase: 'post', title: 'Σ truck cases = shipped cases per lane', total: LANES.length,
      bad: LANES.filter((l) => !l.dropped && sum(l.loads, (ld) => ld.cases) !== l.shipped).length },
    { id: 'CP-01', table: 'cluster_primary', category: 'Rule', severity: 'medium', phase: 'post', title: 'Each primary truck is ≥ 65% full (or the cluster\'s only truck)', total: CLUSTERS.length },
    { id: 'OA-01', table: 'order_line_items', category: 'Reconciliation', severity: 'high', phase: 'post', title: 'Every SO line is archived to the S3 order_line_items', total: soLines },
    { id: 'OA-02', table: 'order_line_items', category: 'Uniqueness', severity: 'high', phase: 'post', title: 'One OEID per CFA × DB', total: LANES.length },
    { id: 'SAP-01', table: 'sap_orders', category: 'Completeness', severity: 'high', phase: 'post', title: 'Every order line has customer, material and plant', total: soLines },
    { id: 'SAP-02', table: 'sap_orders', category: 'Format', severity: 'medium', phase: 'post', title: 'Line numbers (POSNR) are contiguous within each order', total: soTrucks },
    { id: 'SAP-03', table: 'sap_orders', category: 'Rule', severity: 'high', phase: 'post', title: 'Only SO-creation DBs are handed to SAP', total: SO_LANES.length },
    { id: 'SAP-04', table: 'sap_orders', category: 'Reconciliation', severity: 'high', phase: 'post', title: 'Order quantity matches the final order (cases)', total: soLines },
    { id: 'OS-01', table: 'order_status', category: 'Reconciliation', severity: 'medium', phase: 'post', title: 'SAP acknowledged every handed-off order', total: soTrucks,
      skip: latest ? 'SAP acknowledgements for today\'s orders arrive after the posting window — re-check later' : undefined },
    { id: 'RLM-01', table: 'rlm_queue', category: 'Integrity', severity: 'medium', phase: 'post', title: 'Every RLM truck has its held order lines', total: RLM_LANES.length },
    { id: 'RLM-02', table: 'rlm_queue', category: 'Integrity', severity: 'medium', phase: 'post', title: '2nd-CFA offers name an alternate CFA with stock', total: SECOND_LANES.length,
      skip: SECOND_LANES.length ? undefined : 'No 2nd-CFA offers in this run — nothing to check' },
    { id: 'RLM-03', table: 'rlm_queue', category: 'Rule', severity: 'high', phase: 'post', title: 'No DB is both sent for SO creation and held for RLM', total: LANES.length },
  ];
}

const STATUS_LABEL: Record<Status, string> = { pass: 'Passed', fail: 'Failed', warn: 'Warning', skip: 'Skipped' };
function evaluate(c: Check, n: number, date: string) {
  const ran = isRunDate(date);
  const bad = c.bad ?? 0;
  const status: Status = !ran || c.skip ? 'skip' : bad === 0 ? 'pass' : c.warn ? 'warn' : 'fail';
  const reason = !ran ? `No data staged for ${date}`
    : c.skip ? c.skip
      : status === 'pass' ? (c.ok ?? `All ${nf(c.total)} row${c.total === 1 ? '' : 's'} pass`)
        : (c.reason ?? `${nf(bad)} of ${nf(c.total)} rows fail`);
  const hasDetail = (status === 'fail' || status === 'warn') && !!c.rows?.length;
  return {
    number: n, id: c.id, table: c.table, category: c.category, severity: c.severity, title: c.title, phase: c.phase,
    status, status_label: STATUS_LABEL[status], reason, bad: status === 'skip' ? 0 : bad, total: c.total,
    example: status === 'fail' || status === 'warn' ? (c.example ?? null) : null,
    detail: hasDetail ? `${nf(c.rows!.length)} offending row${c.rows!.length === 1 ? '' : 's'} — download for the full list` : null,
    has_detail: hasDetail,
  };
}

function complexQueries() {
  const inSoq = new Set(DEMAND.map((d) => d.rz));
  const dbInSoq = new Set(DEMAND.map((d) => d.db));
  const rz: Cell[][] = REG_ZSKUS.map((z) => [z.rz, z.desc, true, z.skus.length > 0, !!z.category, z.cfaStock > 0, inSoq.has(z.rz)]);
  const db: Cell[][] = DISTRIBUTORS.map((d) => [d.code, d.name, true, d.tier >= 1 && d.tier <= 4, !!d.truckType, d.cluster ?? null, dbInSoq.has(d.code)]);
  return [
    { id: 'CX-01', title: 'Reg-zsku presence across masters', status: 'ok', detail: null,
      description: 'For every reg-zsku: is it in the region-SKU master, does it have SKUs in the material master, a category, CFA stock, and SOQ demand today?',
      sql: 'SELECT r.reg_zsku, r.description,\n       TRUE                                   AS in_region_sku_master,\n       EXISTS (SELECT 1 FROM material_master m WHERE m.reg_zsku = r.reg_zsku) AS has_skus,\n       r.category IS NOT NULL                 AS has_category,\n       COALESCE(i.stock, 0) > 0              AS has_cfa_stock,\n       EXISTS (SELECT 1 FROM soq_feed s WHERE s.reg_zsku = r.reg_zsku)     AS in_soq\nFROM region_sku_master r\nLEFT JOIN cfa_stock_by_reg_zsku i USING (reg_zsku)\nORDER BY r.reg_zsku;',
      columns: ['reg_zsku', 'description', 'in_region_sku_master', 'has_skus', 'has_category', 'has_cfa_stock', 'in_soq'], rows: rz, row_count: rz.length },
    { id: 'CX-02', title: 'Distributor presence across masters', status: 'ok', detail: null,
      description: 'For every distributor: in the DB master, has a valid tier, has a truck type, its transshipment cluster (if any), and whether it sent SOQ today.',
      sql: 'SELECT d.db_code, d.customer_name,\n       TRUE                          AS in_db_master,\n       t.tier BETWEEN 1 AND 4        AS has_tier,\n       tt.truck_type IS NOT NULL     AS has_truck_type,\n       c.cluster_code,\n       EXISTS (SELECT 1 FROM soq_feed s WHERE s.db_code = d.db_code) AS in_soq\nFROM db_master d\nLEFT JOIN db_tier_master t USING (db_code)\nLEFT JOIN db_truck_type tt USING (db_code)\nLEFT JOIN cluster_master c USING (db_code)\nORDER BY d.db_code;',
      columns: ['db_code', 'customer_name', 'in_db_master', 'has_tier', 'has_truck_type', 'cluster', 'in_soq'], rows: db, row_count: db.length },
  ];
}

get('/api/v1/data_tests', (ctx) => {
  const date = ctx.date;
  const tests = checks(date).map((c, i) => evaluate(c, i + 1, date));
  const tally = (ts: typeof tests) => {
    const o: Record<string, number> = { pass: 0, fail: 0, warn: 0, skip: 0, error: 0 };
    for (const t of ts) o[t.status] += 1;
    return o;
  };
  return {
    date, total: tests.length, summary: tally(tests),
    phase_summary: { pre: tally(tests.filter((t) => t.phase === 'pre')), post: tally(tests.filter((t) => t.phase === 'post')) },
    tests, complex: complexQueries(),
  };
});

get('/api/v1/data_tests/detail', (ctx) => {
  const id = ctx.query.get('id') || '';
  const c = checks(ctx.date).find((x) => x.id === id);
  if (!c) throw new HttpError(404, `Unknown check ${id}`);
  const t = evaluate(c, 0, ctx.date);
  if (!t.has_detail) return { id, columns: [], rows: [], detail: 'No offending rows — this check passed.', truncated: false };
  return { id, columns: c.cols ?? [], rows: c.rows ?? [], detail: null, truncated: false };
});
