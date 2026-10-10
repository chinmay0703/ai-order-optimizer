// sequences.ts — demo routes for the Step-3 / transshipment "show your work" pages, all derived from ../dataset:
//   GET /api/v1/filler_sequence          FillerSequencePage   — Step-3 draw order, truck build, trims, filler caps (per lane)
//   GET /api/v1/cfa/:cfa/run/:run         CfaWalkthroughPage   — run inputs: DB validity (PDP / low stock), CFA earmark, demand
//   GET /api/v1/cluster_primary           ClusterPrimaryPage   — cluster combine → fewest ≥keep primary trucks → cross-DB trim
//   GET /api/v1/cluster_primary_trucks    ClusterPrimaryTrucks — the final primary truck(s): reg-zsku + SKU level
//
// The dataset records a substitute on the DONOR line (line.sub + line.subFor "recv:qty, …"); these pages read it
// RECEIVER-centric (the demand line that got it, with "<donor>:qty; …" donor strings), so the edges are re-derived
// here. Step-3 trims vs the cluster trim are separated by replaying the dataset's own trim order on the planned values.
import { get, HttpError } from '../router';
import {
  CFA, DISTRIBUTORS, REG_ZSKUS, RUNS, RUN_RESULTS, CLUSTERS, OE_PARAM_DEFS, PRIMARY_CAP, LATEST_DATE,
  rzByCode, tierWeight, bareCode, laneByDb,
  type Lane, type ClusterResult, type RunDef, type RunResult,
} from '../dataset';

// ───────── parameters + small helpers ─────────
const param = (k: string, d: number) => OE_PARAM_DEFS.find((p) => p.key === k)?.default ?? d;
const KEEP = param('TRUCK_KEEP_PCT', 0.65);
const FILL_TARGET = param('TRUCK_FILL_TARGET_PCT', 0.9);
const NORM_X = param('NORM_MULTIPLIER', 1.2);
const ADDON = param('ADDON_CAP_PCT', 0.35);
const BELOW_THRESHOLD = 0.25;   // walkthrough low-stock rule: on-hand < 25% of Norm pulls a DB in on a non-PDP day

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pctS = (f: number) => `${Math.round(f * 100)}%`;
const sum = <T,>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const descOf = (rz: string) => rzByCode.get(rz)?.desc ?? rz;
const cfaMatches = (q: string | null) => !q || bareCode(q) === bareCode(CFA);

/** level-load `total` cases across `n` trucks (first trucks take the odd case) */
const levelLoad = (total: number, n: number) =>
  Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));

// ───────── per-line amounts at a stage: own original · lent as substitute · filler ─────────
interface Amt { o: number; s: number; f: number }
type Stage = Map<string, Amt>;
const plannedStage = (lane: Lane): Stage => new Map(lane.lines.map((x) => [x.rz, { o: x.orig, s: x.sub, f: x.filler }]));
const finalStage = (lane: Lane): Stage => new Map(lane.lines.map((x) => [x.rz, { o: x.shipOrig, s: x.shipSub, f: x.shipFil }]));
/** what the lane shipped after the Step-3 truck rule, BEFORE any cluster trim — replays the dataset's trim order
 *  (filler → substitute → original, lowest priority-after first) on the planned values. */
function step3Stage(lane: Lane): Stage {
  if (lane.dropped) return new Map(lane.lines.map((x) => [x.rz, { o: 0, s: 0, f: 0 }]));
  const rows = lane.lines.map((x) => ({ rz: x.rz, pa: x.priorityAfter, shipFil: x.filler, shipSub: x.sub, shipOrig: x.orig }));
  let left = lane.cascaded;
  for (const key of ['shipFil', 'shipSub', 'shipOrig'] as const) {
    for (const x of [...rows].sort((a, b) => a.pa - b.pa || b[key] - a[key])) {
      if (left <= 0) break;
      const t = Math.min(x[key], left); x[key] -= t; left -= t;
    }
  }
  return new Map(rows.map((x) => [x.rz, { o: x.shipOrig, s: x.shipSub, f: x.shipFil }]));
}
const stageTotal = (st: Stage) => sum([...st.values()], (a) => a.o + a.s + a.f);

/** substitute edges donor → receiver at a stage (a donor's lent cases are spread over its receivers in listed order,
 *  so a cut comes off its last receivers first). Same order for every stage, so edges can be zipped by index. */
interface Edge { donor: string; recv: string; q: number }
function edgesAt(lane: Lane, st: Stage): Edge[] {
  const out: Edge[] = [];
  for (const x of lane.lines) {
    if (!x.subFor) continue;
    let left = st.get(x.rz)?.s ?? 0;
    for (const part of x.subFor.split(',')) {
      const [rz, q] = part.split(':').map((s) => s.trim());
      if (!rz) continue;
      const g = Math.min(Number(q) || 0, left); left -= g;
      out.push({ donor: x.rz, recv: rz, q: g });
    }
  }
  return out;
}
const donorString = (es: Edge[]) => es.filter((e) => e.q > 0).map((e) => `${e.donor}:${e.q}`).join('; ');

// ───────── cluster primary pass (shared by 3 routes) ─────────
// The dataset keeps a lone primary truck even when the combined load is < keep × PRIMARY_CAP; every page here drops
// such a cluster. So when that happens the plan is shown on a 19-20 FT primary (800 cs), on which the same load clears
// the keep floor — the shipped / trimmed cases and the truck count are the dataset's, unchanged.
function primaryCapOf(cl: ClusterResult): number {
  if (cl.primaryTrucks > 0 && cl.fullTrucks === 0 && cl.combined < KEEP * cl.primaryCap) {
    const alt = [800, 600].find((c) => cl.combined <= c && cl.combined >= KEEP * c);
    return alt ?? Math.max(cl.combined, Math.round(cl.combined / 0.8));
  }
  return cl.primaryCap ?? PRIMARY_CAP;
}

interface CalcRow {
  reg_zsku: string; stock: number; allocated_before: number; norm: number; sn_ratio: number | null; sn_rank: number;
  filler_before: number; sub_before: number; orig_before: number;
  cut_total: number; cut_filler: number; cut_sub: number; cut_orig: number; allocated_after: number;
  trucks_on: string; cut_by_truck: string; filler_donors: string; sub_donors: string;
}
/** one transshipment DB's reg-zsku rows for the cluster trim: BEFORE = after Step 3, AFTER = final. Receiver-centric
 *  (a received substitute sits on the demand line, with its donor string); trucks_on / cut_by_truck are by material. */
function clusterCalcRows(lane: Lane): CalcRow[] {
  const S3 = step3Stage(lane), F = finalStage(lane);
  const e3 = edgesAt(lane, S3), eF = edgesAt(lane, F);
  const onTruck = new Map<string, Map<number, number>>();
  for (const ld of lane.loads) for (const s of ld.skus) {
    const m = onTruck.get(s.rz) ?? new Map<number, number>();
    m.set(ld.no, (m.get(ld.no) ?? 0) + s.cases); onTruck.set(s.rz, m);
  }
  const lastTruck = lane.loads.length || 1;
  const rows: CalcRow[] = [];
  for (const x of lane.lines) {
    const a = S3.get(x.rz)!, z = F.get(x.rz)!;
    const idx = e3.map((e, i) => (e.recv === x.rz ? i : -1)).filter((i) => i >= 0);
    const subB = sum(idx, (i) => e3[i].q), subA = sum(idx, (i) => eF[i].q);
    if (a.o + subB + a.f + a.s === 0) continue;
    const matCut = (a.o - z.o) + (a.s - z.s) + (a.f - z.f);
    rows.push({
      reg_zsku: x.rz, stock: x.dbStock, allocated_before: a.o + subB + a.f, norm: x.norm,
      sn_ratio: x.norm > 0 ? r3(Math.max(x.dbStock, 1) / x.norm) : null, sn_rank: 0,
      filler_before: a.f, sub_before: subB, orig_before: a.o,
      cut_total: (a.o - z.o) + (subB - subA) + (a.f - z.f), cut_filler: a.f - z.f, cut_sub: subB - subA, cut_orig: a.o - z.o,
      allocated_after: z.o + subA + z.f,
      trucks_on: [...(onTruck.get(x.rz) ?? new Map<number, number>())].map(([t, c]) => `${t}:${c}`).join('; '),
      cut_by_truck: matCut > 0 ? `${lastTruck}:${matCut}` : '',
      filler_donors: a.f > 0 ? `${x.rz}:${a.f}` : '',
      sub_donors: donorString(idx.map((i) => e3[i])),
    });
  }
  [...rows].sort((p, q) => (q.sn_ratio ?? -1) - (p.sn_ratio ?? -1) || p.reg_zsku.localeCompare(q.reg_zsku))
    .forEach((r, i) => { r.sn_rank = i + 1; });
  return rows;
}

interface ClusterView {
  cl: ClusterResult; cap: number; trucks: number; load: number; ships: number; trimmed: number; status: string;
  members: { lane: Lane; built: number; trimmed: number; ships: number; rows: CalcRow[] }[];
}
const CLUSTER_VIEWS: ClusterView[] = CLUSTERS.map((cl) => {
  const cap = primaryCapOf(cl);
  const members = cl.perDb.map((p) => {
    const lane = laneByDb.get(p.db)!;
    return { lane, built: p.built, trimmed: p.trimmed, ships: p.ships, rows: clusterCalcRows(lane) };
  });
  const status = cl.primaryTrucks === 0 ? `CLUSTER_DROP_<${pctS(KEEP)}` : cl.trimmed > 0 ? 'TRIMMED · SHIPS' : 'SHIPS';
  return { cl, cap, trucks: cl.primaryTrucks, load: cl.combined, ships: cl.ships, trimmed: cl.trimmed, status, members };
});
const clusterOfDb = (db: string) => CLUSTER_VIEWS.find((v) => v.members.some((m) => m.lane.db.code === db));

// ═════════════════════════ /filler_sequence ═════════════════════════
const CAP_LABEL: Record<string, string> = {
  'truck room': 'truck room', 'truck full': 'truck room (truck full)', 'CFA pool': 'CFA stock (pool)',
  '1.2×Norm room': `${NORM_X}×Norm room`, '35% add-on': `${pctS(ADDON)} add-on`,
};

function fillerEntry(lane: Lane, nInRun: number) {
  const db = lane.db, cap = db.truckCap;
  const P0 = plannedStage(lane), S3 = step3Stage(lane);
  const e0 = edgesAt(lane, P0), e3 = edgesAt(lane, S3);

  // ── the truck build: min trucks → FILL / TRIM / SHIP-AS-IS → pack ──
  const hold = lane.orig + lane.sub;
  const full = Math.floor(hold / cap), leftover = hold - full * cap;
  const minTrucks = hold > 0 ? Math.ceil(hold / cap) : 0;
  const needed = lane.fillerCalc[0]?.truck ?? Math.max(0, Math.round(minTrucks * cap * 0.97) - hold);
  const decision = leftover === 0 ? 3 : needed <= leftover ? 1 : 2;
  const shipped3 = stageTotal(S3);
  const fillerShipped = sum([...S3.values()], (a) => a.f);
  const trucks = lane.dropped ? [] : lane.loads.map((ld) => ({
    truck: ld.no, cases: ld.planned, capacity: cap, fill_pct: r1((ld.planned / cap) * 100), so_flag: lane.soFlag,
  }));
  const flow = {
    cap, hold_load: hold, full_trucks: full, leftover, min_trucks: minTrucks,
    filler_needed: needed, filler_added: lane.filler, filler_shipped: fillerShipped, load_l: lane.planned,
    so_trucks: trucks.filter((t) => t.fill_pct >= FILL_TARGET * 100).length,
    last_truck_cases: trucks.length ? trucks[trucks.length - 1].cases : 0,
    truck_count: trucks.length, shipped: shipped3, residual: lane.planned - shipped3,
    decision, decision_label: decision === 1 ? 'fill' : decision === 2 ? 'trim' : 'ship as-is', dropped: lane.dropped,
  };

  // ── trim candidates (receiver-centric) + what the truck rule actually cut ──
  const cands = lane.lines
    .filter((x) => x.orig > 0 || x.sub > 0 || e0.some((e) => e.recv === x.rz && e.q > 0))
    .map((x) => {
      const idx = e0.map((e, i) => (e.recv === x.rz && e.q > 0 ? i : -1)).filter((i) => i >= 0);
      const subRecv = sum(idx, (i) => e0[i].q), subCut = sum(idx, (i) => e0[i].q - e3[i].q);
      const s3 = S3.get(x.rz)!;
      const origCut = x.orig - s3.o, filCut = x.filler - s3.f;
      const held = Math.max(x.dbStock, 1);
      return {
        z: x.rz, name: descOf(x.rz), orig: x.orig, sub: subRecv, stock: x.dbStock, norm: x.norm, held,
        sn: x.norm > 0 ? r2(held / x.norm) : null, cut: origCut + subCut, sub_donor: donorString(idx.map((i) => e0[i])),
        origCut, subCut, filCut,
      };
    });
  const reason = lane.dropped ? `LANE_DROP_<${pctS(KEEP)}` : 'TRUCK_TAIL_CASCADE';
  const trims = [
    ...cands.filter((c) => c.cut > 0 || c.filCut > 0).map((c) => ({
      z: c.z, name: c.name, orig: c.origCut, sub: c.subCut, fil: c.filCut, reason,
      stock: c.stock, norm: c.norm, held: c.held, sn: c.sn, sub_donor: c.sub_donor,
    })),
    ...lane.lines.filter((x) => !cands.some((c) => c.z === x.rz) && x.filler - (S3.get(x.rz)?.f ?? 0) > 0).map((x) => {
      const held = Math.max(x.dbStock, 1);
      return { z: x.rz, name: descOf(x.rz), orig: 0, sub: 0, fil: x.filler - (S3.get(x.rz)?.f ?? 0), reason,
        stock: x.dbStock, norm: x.norm, held, sn: x.norm > 0 ? r2(held / x.norm) : null, sub_donor: '' };
    }),
  ];
  const trim_candidates = cands.map(({ origCut: _o, subCut: _s, filCut: _f, ...c }) => c);

  // ── filler caps (the dataset's draw), labelled so the binding-cap pill lights up ──
  const filler_calc = lane.fillerCalc.map((f) => {
    let why = CAP_LABEL[f.reason] ?? f.reason;
    const cut = f.alloc - (S3.get(f.z)?.f ?? 0);
    if (f.alloc > 0 && lane.dropped) why += ` · reserved ${f.alloc} cs → returned (lane dropped)`;
    else if (f.alloc > 0 && cut > 0) why += ` · ${cut} cs returned at the spill trim`;
    return { ...f, reason: why };
  });

  // ── transshipment cluster (post-cascade primary pass) ──
  const cv = clusterOfDb(db.code);
  const cm = cv?.members.find((m) => m.lane.db.code === db.code);
  const cluster_trim = cv && cm ? {
    cluster_code: cv.cl.code, primary_cap: cv.cap, primary_trucks: cv.trucks, cluster_load: cv.load,
    shipped_before: cm.built, trimmed: cm.trimmed, shipped_after: cm.ships, status: cv.status,
    trims: Object.fromEntries(cm.rows.map((r) => [r.reg_zsku, {
      sn_ratio: r.sn_ratio ?? 0, sn_rank: r.sn_rank, stock: r.stock, norm: r.norm,
      allocated_before: r.allocated_before, allocated_after: r.allocated_after,
      cut_total: r.cut_total, cut_filler: r.cut_filler, cut_sub: r.cut_sub, cut_orig: r.cut_orig,
    }])),
  } : null;

  const linesUsedAs = (k: 'sub' | 'filler') => lane.lines.filter((x) => x[k] > 0).map((x) => `${x.rz}:${x[k]}`).join('; ');
  return {
    db: db.code, db_name: db.name, run: lane.run, channel: db.channel, tier: db.tier, tier_weight: tierWeight(db.tier),
    sum_norm: lane.sumNorm, sum_held: lane.sumHeld, priority: lane.priority, rank: lane.rank, n_in_cfa: nInRun,
    stock: lane.sumHeld - lane.orig - lane.sub, soq: lane.soq, original: lane.orig, substitute: lane.sub, filler: lane.filler,
    total: lane.planned,
    flow, trucks,
    dropped: lane.dropped ? {
      reason: `${lane.planned} of ${cap} cs = ${r1((lane.planned / cap) * 100)}% on one ${db.truckType}, under the ${pctS(KEEP)} floor`,
      orig: lane.dropOrig, sub: lane.dropSub, fil: lane.dropFil,
    } : null,
    filler_calc, cfa: CFA,
    sub_donors: linesUsedAs('sub'), filler_donors: linesUsedAs('filler'),
    trims, trim_candidates, cluster_trim,
  };
}

get('/api/v1/filler_sequence', (ctx) => {
  const dbs = RUN_RESULTS.flatMap((rr) => rr.lanes.map((l) => fillerEntry(l, rr.lanes.length)));
  return { date: ctx.date, cfas: cfaMatches(ctx.query.get('cfa')) ? [{ cfa: CFA, dbs }] : [] };
});

// ═════════════════════════ /cfa/:cfa/run/:run ═════════════════════════
const MON: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function runDateIso(d: string): string {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(d || LATEST_DATE) ?? /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(LATEST_DATE)!;
  return `${m[3]}-${String(MON[m[2]] ?? 10).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
const weekdayOf = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
// each DB's PDP (planned delivery) days — a fixed weekly beat
const PDP_DAYS: string[][] = [
  ['Mon', 'Wed', 'Fri'], ['Tue', 'Sat'], ['Mon', 'Thu'], ['Wed', 'Sat'], ['Tue', 'Fri'],
  ['Mon', 'Thu'], ['Tue', 'Fri', 'Sat'], ['Wed', 'Sat'], ['Mon', 'Wed', 'Fri'], ['Thu', 'Sat'],
];
const pdpOf = (code: string) => PDP_DAYS[Math.max(0, DISTRIBUTORS.findIndex((d) => d.code === code)) % PDP_DAYS.length];
const inBand = (run: RunDef, band: string) => run.band.split('+').includes(band.replace(/\D/g, ''));

get('/api/v1/cfa/:cfa/run/:run', (ctx) => {
  if (!cfaMatches(ctx.params.cfa)) throw new HttpError(404, `CFA ${ctx.params.cfa} has no run detail on ${ctx.date}`);
  const runNo = Number(ctx.params.run) || 1;
  const run = RUNS.find((r) => r.run === runNo);
  const rr = RUN_RESULTS.find((r) => r.run.run === runNo);
  if (!run || !rr) throw new HttpError(404, `Run ${ctx.params.run} does not exist — runs are ${RUNS.map((r) => r.run).join(', ')}`);

  const today = runDateIso(ctx.date);
  const qDay = ctx.query.get('run_day') ?? '';
  const runDay = /^\d{4}-\d{2}-\d{2}$/.test(qDay) ? qDay : today;
  const weekday = weekdayOf(runDay);

  const bandRz = REG_ZSKUS.filter((z) => inBand(run, z.band));
  const bandSet = new Set(bandRz.map((z) => z.rz));
  const channelDbs = DISTRIBUTORS.filter((d) => d.channel === run.channel);

  // demand: every channel DB × in-band reg-zsku it demands
  const demand = channelDbs.flatMap((d) => (laneByDb.get(d.code)?.lines ?? [])
    .filter((x) => x.soq > 0 && bandSet.has(x.rz))
    .sort((a, b) => a.rz.localeCompare(b.rz))
    .map((x) => {
      const z = rzByCode.get(x.rz)!;
      const thr = Math.ceil(BELOW_THRESHOLD * x.norm);
      return {
        db: d.code, db_name: d.name, tier: d.tier, reg_zsku: x.rz, brand: z.brand, mrp: z.mrp,
        soq: x.soq, norm: x.norm, max_norm: Math.round(x.norm * NORM_X), db_stock: x.dbStock,
        below_threshold: x.dbStock < thr, threshold_cases: thr, pdp_today: pdpOf(d.code).includes(weekday),
      };
    }));
  const inScope = channelDbs.filter((d) => demand.some((x) => x.db === d.code));
  const list = inScope.map((d) => {
    const pdp = pdpOf(d.code);
    const pdpToday = pdp.includes(weekday);
    const hasBelow = demand.some((x) => x.db === d.code && x.below_threshold);
    return { db: d.code, db_name: d.name, tier: d.tier, pdp_today: pdpToday, pdp_freq: `${pdp.length}×/wk · ${pdp.join('/')}`,
      has_below: hasBelow, valid_via: pdpToday ? 'PDP' : hasBelow ? 'below-threshold' : 'neither' };
  });
  const viaPdp = list.filter((x) => x.valid_via === 'PDP').length;
  const viaBelow = list.filter((x) => x.valid_via === 'below-threshold').length;

  // CFA inventory: in-band reg-zskus, the run's earmark, what it could draw (CAP) and what carries on
  const usedBefore = (rz: string) => sum(RUN_RESULTS.filter((r) => r.run.run < runNo), (r: RunResult) => r.reserved[rz] - r.leftover[rz]);
  const cfa_inventory = bandRz.map((z) => {
    const used = rr.reserved[z.rz] - rr.leftover[z.rz];
    return {
      reg_zsku: z.rz, mrp: z.mrp, stock: z.cfaStock, earmark_pct: run.pct, earmark: Math.floor((z.cfaStock * run.pct) / 100),
      cap: rr.reserved[z.rz], remaining_after: Math.max(0, z.cfaStock - usedBefore(z.rz) - used),
    };
  });

  return {
    cfa: CFA, cfas: [CFA],
    run: { run_no: run.run, channel: run.channel, band: run.band, band_label: `Band ${run.band}`, band_desc: run.bandDesc,
      band_mrps: [...new Set(bandRz.map((z) => z.mrp))].sort((a, b) => a - b), pct: run.pct },
    run_day: runDay, today, weekday,
    params: { below_threshold_pct: BELOW_THRESHOLD },
    dbs: {
      channel_network: channelDbs.length, channel_served: channelDbs.length, in_scope: inScope.length,
      validity: { via_pdp: viaPdp, via_below_only: viaBelow, neither: list.length - viaPdp - viaBelow, total_valid: viaPdp + viaBelow },
      list,
    },
    cfa_inventory, demand,
  };
});

// ═════════════════════════ /cluster_primary ═════════════════════════
function clusterPayload(v: ClusterView) {
  const keep = Math.round(KEEP * v.cap);
  const members = v.members.map((m) => {
    const lane = m.lane, cap = lane.db.truckCap;
    const demanded = lane.lines.filter((x) => x.soq > 0);
    const stock = sum(demanded, (x) => x.dbStock), orig = sum(demanded, (x) => x.orig), norm = sum(demanded, (x) => x.norm);
    return {
      db: lane.db.code, channel: lane.db.channel, soq: lane.soq,
      shipped_before: m.built, trimmed: m.trimmed, shipped_after: m.ships,
      combined_stock: stock, combined_original: orig, combined_norm: norm, sn_ratio: norm > 0 ? r3((stock + orig) / norm) : null,
      trucks: lane.loads.map((ld) => ({ truck_no: ld.no, planned: ld.planned, shipped: ld.cases,
        planned_fill: r1((ld.planned / cap) * 100), fill: r1((ld.cases / cap) * 100) })),
      trim_calc: m.rows,
    };
  });
  return {
    cfa: CFA, cluster_code: v.cl.code, primary_max: v.cap, cluster_load: v.load,
    primary_trucks: v.trucks, trim_total: v.trimmed, status: v.status, n_dbs: members.length, members,
    trim_rows: v.members.flatMap((m) => m.rows.map((r) => ({ ...r, db: m.lane.db.code }))),
    truck_build: {
      cap: v.cap, keep, max65: Math.floor(v.load / keep), minhold: Math.ceil(v.load / v.cap), n_ship: v.trucks,
      shipped: v.ships, trim: v.trimmed,
      fills: levelLoad(v.trucks > 0 ? v.ships : v.load, Math.max(1, v.trucks)).map((c) => ({ cases: c, pct: r1((c / v.cap) * 100) })),
    },
  };
}
get('/api/v1/cluster_primary', (ctx) => ({
  date: ctx.date,
  clusters: cfaMatches(ctx.query.get('cfa')) ? CLUSTER_VIEWS.map(clusterPayload) : [],
}));

// ═════════════════════════ /cluster_primary_trucks ═════════════════════════
interface Pick { reg_zsku: string; sku: string; batch: string; days_to_expiry: number; qty: number; source: string; db: string }
function primaryTrucks(v: ClusterView) {
  // every member DB's final SKU picks, merged per DB × SKU × role
  const picks: Pick[] = [];
  for (const m of v.members) for (const ld of m.lane.loads) for (const s of ld.skus) {
    const source = s.isFiller ? 'Filler' : s.isSub ? 'Substitute' : 'Original';
    const hit = picks.find((p) => p.db === m.lane.db.code && p.sku === s.sku && p.source === source);
    if (hit) hit.qty += s.cases;
    else picks.push({ reg_zsku: s.rz, sku: s.sku, batch: s.batch, days_to_expiry: s.daysToExpiry, qty: s.cases, source, db: m.lane.db.code });
  }
  const ROLE: Record<string, number> = { Original: 0, Substitute: 1, Filler: 2 };
  picks.sort((a, b) => a.db.localeCompare(b.db) || ROLE[a.source] - ROLE[b.source] || a.reg_zsku.localeCompare(b.reg_zsku) || a.sku.localeCompare(b.sku));
  const n = Math.max(0, v.trucks);
  const targets = levelLoad(sum(picks, (p) => p.qty), Math.max(1, n));
  const trucks = targets.map((_, i) => ({ no: i + 1, skus: [] as Pick[] }));
  let t = 0, room = targets[0] ?? 0;
  for (const p of picks) {
    let left = p.qty;
    while (left > 0) {
      if (room <= 0 && t < trucks.length - 1) { t += 1; room = targets[t]; }
      const c = t === trucks.length - 1 ? left : Math.min(left, room);
      trucks[t].skus.push({ ...p, qty: c }); left -= c; room -= c;
    }
  }
  return trucks.slice(0, n).map((tr) => {
    const cases = sum(tr.skus, (s) => s.qty);
    const reg = new Map<string, number>();
    tr.skus.forEach((s) => reg.set(s.reg_zsku, (reg.get(s.reg_zsku) ?? 0) + s.qty));
    return { no: tr.no, cases, capacity: v.cap, fill: r1((cases / v.cap) * 100), skus: tr.skus,
      reg: [...reg].map(([reg_zsku, c]) => ({ reg_zsku, cases: c })).sort((a, b) => b.cases - a.cases) };
  });
}
get('/api/v1/cluster_primary_trucks', (ctx) => ({
  date: ctx.date,
  clusters: !cfaMatches(ctx.query.get('cfa')) ? [] : CLUSTER_VIEWS.map((v) => {
    const reg = new Map<string, { reg_zsku: string; original: number; substitute: number; filler: number; total: number }>();
    for (const m of v.members) for (const x of m.lane.lines) {
      const tot = x.shipOrig + x.shipSub + x.shipFil;
      if (tot <= 0) continue;
      const r = reg.get(x.rz) ?? { reg_zsku: x.rz, original: 0, substitute: 0, filler: 0, total: 0 };
      r.original += x.shipOrig; r.substitute += x.shipSub; r.filler += x.shipFil; r.total += tot;
      reg.set(x.rz, r);
    }
    return {
      cfa: CFA, cluster_code: v.cl.code, primary_cap: v.cap, primary_trucks: v.trucks, combined_cases: v.ships,
      n_dbs: v.members.length, channels: [...new Set(v.members.map((m) => m.lane.db.channel))],
      members: v.members.map((m) => ({ db: m.lane.db.code, channel: m.lane.db.channel, soq: m.lane.soq, ships: m.ships })),
      reg: [...reg.values()].sort((a, b) => b.total - a.total || a.reg_zsku.localeCompare(b.reg_zsku)),
      trucks: primaryTrucks(v),
    };
  }),
}));

