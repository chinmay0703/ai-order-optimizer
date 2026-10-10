// validate.ts — the REPORT pages + the RCA drill-through, all derived from dataset.ts so they agree with every engine page:
//   GET /api/v1/uat_report_v2          Allocation Report — one row per CFA × DB × reg-zsku × truck × SKU-batch (cfa / q / sort / dir / limit / offset; ?format=xlsx = ALL rows)
//   GET /api/v1/order_journey_trucks   the physical trucks per DB + the owner-centric SKU lines each carried + the clusters
//   GET /api/v1/rca/index · /rca/db/:dbid · /rca/regzsku/:z · /rca/cfa/:cfa   the end-to-end allocation stories
//
// Conventions shared with the rest of the demo data:
//   • a DB's "shipped" is lane.shipped (post truck-rule + cluster trim) — Σ = totals().shipped
//   • a DROPPED lane (truck < 65%) ships 0 and is held as ONE truck for RLM truck approval (its pre-drop planned cases)
//   • numbers are owner-centric: a reg-zsku row's Substitute / Filler are cases OF THAT reg-zsku used as substitute / filler
//   • PDP order type = tier-1 distributors (the dataset has no DB-level PDP flag)
import { get, xlsxTable, type Ctx } from '../router';
import {
  CFA, CFA_NAME, ALT_CFA, SOQ_DATE, LATEST_DATE, OE_PARAM_DEFS, RUN_RESULTS, LANES, CLUSTERS, DISTRIBUTORS,
  REG_ZSKUS, rzByCode, findDb, findRz, bareCode, tierWeight, laneByDb, shippedOf,
  type Lane, type Line, type LoadSku, type SoFlag, type RunResult,
} from '../dataset';

type Cell = string | number | null;

// ───────── small helpers ─────────
const param = (k: string) => OE_PARAM_DEFS.find((p) => p.key === k)?.default ?? 0;
const KEEP_PCT = Math.round(param('TRUCK_KEEP_PCT') * 100);                       // 65
const SO_FLOOR_PCT = Math.round(param('SO_CREATION_ORIGINAL_FLOOR_PCT') * 100);   // 50
const ADDON_PCT = param('ADDON_CAP_PCT');                                         // 0.35
const r1 = (x: number) => Math.round(x * 10) / 10;
const pctOf = (a: number, b: number) => (b > 0 ? r1((a / b) * 100) : 0);
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const sumBy = <T,>(xs: readonly T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

const inScope = (ctx: Ctx) => { const c = ctx.query.get('cfa'); return !c || bareCode(c) === bareCode(CFA); };
const soqDate = (date: string) => SOQ_DATE[date] ?? SOQ_DATE[LATEST_DATE];
const runOf = (lane: Lane): RunResult => RUN_RESULTS.find((r) => r.run.run === lane.run) ?? RUN_RESULTS[0];
const demandLines = (lane: Lane) => lane.lines.filter((x) => x.soq > 0);
const byRz = (a: Line, b: Line) => a.rz.localeCompare(b.rz);

// ───────── DB-level derived fields ─────────
const pdpOf = (lane: Lane) => (lane.db.tier === 1 ? 'PDP' : 'Non-PDP');
const shipTypeOf = (lane: Lane) => (lane.db.transship ? 'Transshipment' : 'Direct');
const inputReason = (lane: Lane) =>
  `Valid SOQ — ${demandLines(lane).length} reg-zskus · ${fmt(lane.soq)} cs; DB, tier & truck masters matched`;

/** The DB-level outcome line. Its first word drives the Order Journey status (SO / RLM / Shift / No allocation);
 *  a lane dropped at the truck rule says "dropped" (red row on the Reporting Format). */
function remarkOf(lane: Lane): string {
  const cap = lane.db.truckCap;
  if (lane.planned === 0) return 'No allocation — no CFA stock left for its reg-zskus';
  if (lane.soFlag === 'RLM_FOR_SECOND_CFA') {
    return `Shift to 2nd CFA ${ALT_CFA} — original fill ${lane.origFillPct}% < ${SO_FLOOR_PCT}% floor; `
      + (lane.dropped ? `lane dropped at the ${KEEP_PCT}% truck rule` : `${plural(lane.trucks, 'truck')} · ${fmt(lane.shipped)} cs held for RLM`);
  }
  if (lane.dropped) {
    return `RLM truck approval — lane dropped: ${fmt(lane.planned)} cs fills ${pctOf(lane.planned, cap)}% of one ${fmt(cap)}-cs truck (< ${KEEP_PCT}%)`;
  }
  const parts = [lane.db.transship && lane.db.cluster
    ? `SO created via cluster ${lane.db.cluster} primary — ${plural(lane.trucks, 'secondary truck')} · ${fmt(lane.shipped)} cs`
    : `SO created — ${plural(lane.trucks, 'truck')} · ${fmt(lane.shipped)} cs (${lane.fillPct}% fill)`];
  if (lane.cascaded > 0) parts.push(`${fmt(lane.cascaded)} cs truck tail cascaded to next run`);
  if (lane.clusterTrim > 0) parts.push(`${fmt(lane.clusterTrim)} cs cluster primary trim`);
  return parts.join(' · ');
}

// ───────── trucks (real loads, or the one truck a dropped lane holds for RLM approval) ─────────
interface TruckRow { no: number; cases: number; capacity: number; fill: number; flag: SoFlag; type: string; order: string | null; held: boolean; skus: LoadSku[] }

/** SKU-level picks for a lane from per-line (orig, sub, filler) cases — the same split dataset.ts uses for real loads. */
function packLines(lane: Lane, val: (x: Line) => [number, number, number]): LoadSku[] {
  const out: LoadSku[] = [];
  for (const x of lane.lines) {
    const z = rzByCode.get(x.rz);
    if (!z) continue;
    const [o, s, f] = val(x);
    const parts: [number, 0 | 1, 0 | 1][] = [[o, 0, 0], [s, 1, 0], [f, 0, 1]];
    for (const [cases, isSub, isFiller] of parts) {
      if (cases <= 0) continue;
      const split = z.skus.length === 2 ? [Math.ceil(cases * 0.7), cases - Math.ceil(cases * 0.7)] : [cases];
      split.forEach((c, i) => {
        if (c <= 0) return;
        const v = z.skus[i];
        out.push({ rz: x.rz, sku: v.sku, cases: c, units: c * v.unitsPerCase, mrp: v.mrp, batch: v.batch,
          daysToExpiry: v.daysToExpiry, isSub, isFiller, desc: v.desc, isPdp: v.isPdp });
      });
    }
  }
  return out;
}

const truckCache = new Map<string, TruckRow[]>();
function trucksOf(lane: Lane): TruckRow[] {
  const hit = truckCache.get(lane.db.code);
  if (hit) return hit;
  const cap = lane.db.truckCap;
  let t: TruckRow[] = [];
  if (lane.loads.length) {
    t = lane.loads.map((ld) => ({ no: ld.no, cases: ld.cases, capacity: cap, fill: pctOf(ld.cases, cap), flag: lane.soFlag,
      type: lane.db.truckType, order: lane.soFlag === 'SO_CREATION' ? ld.order : null, held: lane.soFlag !== 'SO_CREATION', skus: ld.skus }));
  } else if (lane.dropped && lane.planned > 0) {
    t = [{ no: 1, cases: lane.planned, capacity: cap, fill: pctOf(lane.planned, cap), flag: lane.soFlag, type: lane.db.truckType,
      order: null, held: true, skus: packLines(lane, (x) => [x.orig, x.sub, x.filler]) }];
  }
  truckCache.set(lane.db.code, t);
  return t;
}
const rlmStatus = (t: TruckRow) => (t.flag === 'SO_CREATION' ? 'NOT REQUIRED' : 'PENDING');

// ───────── substitution bookkeeping (owner → receivers, receiver ← owners) ─────────
const parseSubFor = (s: string) => (s ? s.split(/,\s*/).map((p) => {
  const i = p.lastIndexOf(':');
  return { rz: p.slice(0, i), cases: Number(p.slice(i + 1)) || 0 };
}).filter((p) => p.rz) : []);
/** Every Step-2 link in a lane (lender → receiver) with its Step-2 cases (`pre`) and what still ships after the truck
 *  rule / cluster trim (`post`: the lender's shipped substitute cases, attributed to its receivers in engine order). */
interface SubLink { from: string; to: string; pre: number; post: number }
function subLinks(lane: Lane): SubLink[] {
  const out: SubLink[] = [];
  for (const x of lane.lines) {
    let left = lane.dropped ? x.sub : x.shipSub;
    for (const p of parseSubFor(x.subFor)) {
      const post = Math.min(p.cases, Math.max(0, left));
      left -= post;
      out.push({ from: x.rz, to: p.rz, pre: p.cases, post });
    }
  }
  return out;
}
/** Substitute cases this demand line RECEIVED from other reg-zskus (post-trim; Step-2 value on a dropped lane). */
const received = (links: SubLink[], rz: string) => sumBy(links.filter((l) => l.to === rz), (l) => l.post);
const linkTxt = (arrow: string, rz: string, l: SubLink) => `${arrow} ${rz} ×${l.post}${l.post < l.pre ? ` (${l.pre - l.post} trimmed)` : ''}`;
function subText(lane: Lane, x: Line, links = subLinks(lane)): string | null {
  const got = links.filter((l) => l.to === x.rz).map((l) => linkTxt('←', l.from, l));
  const lent = links.filter((l) => l.from === x.rz).map((l) => linkTxt('→', l.to, l));
  return [...got, ...lent].join(' · ') || null;
}

/** Why a reg-zsku line ended up below its SOQ (or was cut after allocation). Null when nothing was cut. */
function dropReason(lane: Lane, x: Line): string | null {
  const z = rzByCode.get(x.rz);
  const before = x.orig + x.sub + x.filler, after = shippedOf(x);
  if (lane.dropped) {
    if (before === 0) return 'Lane dropped — nothing allocated';
    return lane.soFlag === 'RLM_FOR_SECOND_CFA'
      ? `Lane dropped — original fill < ${SO_FLOOR_PCT}%; shift to 2nd CFA ${ALT_CFA} pending RLM`
      : `Lane dropped — truck < ${KEEP_PCT}%; held for RLM truck approval`;
  }
  if (x.soq > 0 && x.orig === 0) return z && z.cfaStock === 0 ? 'No CFA stock' : 'CFA pool exhausted (fair share)';
  if (after < before) return after === 0 ? 'Trimmed at truck fill — tail cascaded' : `Truck-fill trim −${fmt(before - after)} cs (tail cascaded)`;
  if (x.soq > 0 && x.orig < x.soq) {
    return `Fair share — CFA pool short by ${fmt(x.soq - x.orig)} cs${x.subGot > 0 ? ` (${fmt(x.subGot)} cs covered by substitute)` : ''}`;
  }
  return null;
}

// ───────── KPIs + server-side search / sort / paging (shared by both reports) ─────────
function kpiOf(lanes: Lane[]) {
  return {
    dbs: lanes.length,
    input_to_engine: lanes.length,           // every SOQ distributor in this dataset entered the engine
    dropped_before_engine: 0,
    shipped_dbs: lanes.filter((l) => l.shipped > 0).length,
    dropped_in_engine: lanes.filter((l) => l.dropped).length,
    total_shipped: sumBy(lanes, (l) => l.shipped),
  };
}
const isBlank = (v: Cell) => v === null || v === '';
function cmp(a: Cell, b: Cell): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}
function pageOf(ctx: Ctx, cols: string[], all: Cell[][]) {
  const terms = (ctx.query.get('q') ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  let rows = terms.length
    ? all.filter((r) => { const t = r.map((v) => (v == null ? '' : String(v))).join(' | ').toLowerCase(); return terms.every((w) => t.includes(w)); })
    : all;
  const sort = ctx.query.has('sort') ? Number(ctx.query.get('sort')) : -1;
  if (Number.isInteger(sort) && sort >= 0 && sort < cols.length) {
    const dir = ctx.query.get('dir') === 'desc' ? -1 : 1;
    rows = rows.map((r, i) => ({ r, i })).sort((A, B) => {
      const a = A.r[sort], b = B.r[sort];
      if (isBlank(a) || isBlank(b)) return isBlank(a) === isBlank(b) ? A.i - B.i : isBlank(a) ? 1 : -1;   // blanks last, both ways
      return (cmp(a, b) * dir) || A.i - B.i;
    }).map((x) => x.r);
  }
  const offset = Math.max(0, Math.floor(Number(ctx.query.get('offset')) || 0));
  const limit = ctx.query.has('limit') ? Math.max(0, Math.floor(Number(ctx.query.get('limit')) || 0)) : rows.length;
  return { rows: rows.slice(offset, offset + limit), filtered: rows.length, limit, offset };
}
const forXlsx = (rows: Cell[][]) => rows.map((r) => r.map((v) => (v === '' ? null : v)));

// ═════════ Allocation Report — CFA × DB × reg-zsku × truck × SKU-batch ═════════
// (the Order Journey page reads these headers BY NAME — keep them exact)
const V2_DB = ['SOQ Date', 'CFA', 'Plant Name', 'Customer Code', 'Customer Description', 'Customer Type_DB', 'Tier_DB',
  'Order Type (PDP / Non-PDP)_DB', 'Input to engine_DB', 'Engine Input Reason_DB', 'Overall_remarks DB_Level',
  'Shipment type_DB Level', 'Cluster Code_DB'];
const V2_REG = ['Reg_ZSKU Code', 'Old Material Description', 'Brand Category', 'MRP',
  'SOQ_QTY_RegZSKU', 'Norms_QTY_RegZSKU', 'SOH_QTY_Reg_SKU', 'SIT_QTY_RegZSKU', 'CFA Stock_QTY_RegZSKU', 'CFA Reserved_QTY_RegZSKU',
  'AOQ_Prestine_QTY_RegZSKU', 'AOQ_Substitution_QTY_RegZSKU_Before_Truck fill', 'AOQ_Filler_QTY_RegZSKU_Before_Truck fill',
  'AOQ_Total_QTY_RegZSKU_Before_Truck fill',
  'AOQ_Prestine_QTY_RegZSKU_after_Truckfill', 'AOQ_Substitution_QTY_RegZSKU_after_truck_fill', 'AOQ_Filler_QTY_RegZSKU_after_Truckfill',
  'AOQ_Total_QTY_RegZSKU_after_Truckfill', 'Fill rate RegZSKU (AOQ / SOQ)', 'Substitution served (Reg_ZSKU)',
  'AOQ Drop reason Reg_ZSKU Level'];
const V2_TRUCK = ['Truck No', 'Truck Type', 'Truck Capacity', 'Truck Load', 'Truck Fill rate', 'Truck SO Flag', 'RLM Truck Status'];
const V2_SKU = ['SKU code', 'SKU Description', 'Batch code', 'Days to Expiry', 'PDP Batch Flag',
  'AOQ_QTY_Total_after_Truck_Fill_SKU_Level', 'Units_after_Truck_Fill_SKU_Level', 'Engine Order ID', 'Order Created At'];
const V2_COLS = [...V2_DB, ...V2_REG, ...V2_TRUCK, ...V2_SKU];

function v2Rows(date: string, lane: Lane): Cell[][] {
  const db = lane.db, run = runOf(lane), trucks = trucksOf(lane), links = subLinks(lane);
  const dbPart: Cell[] = [soqDate(date), CFA, CFA_NAME, db.code, db.name, db.channel, db.tier, pdpOf(lane), 'Yes',
    inputReason(lane), remarkOf(lane), shipTypeOf(lane), db.cluster ?? null];
  const truckPart = (t: TruckRow | null): Cell[] => (t
    ? [t.no, t.type, t.capacity, t.cases, t.fill, t.flag, rlmStatus(t)]
    : [null, null, null, null, null, null, null]);
  const out: Cell[][] = [];
  for (const x of [...lane.lines].sort(byRz)) {
    const z = rzByCode.get(x.rz);
    if (!z) continue;
    const before = x.orig + x.sub + x.filler, after = shippedOf(x);
    const sit = x.soq > 0 ? Math.max(0, x.norm - x.soq - x.dbStock) : 0;   // SOQ = Norm − SOH − SIT
    const regPart: Cell[] = [x.rz, z.desc, z.category, z.mrp,
      x.soq, x.norm, x.dbStock, sit, z.cfaStock, run.reserved[x.rz] ?? 0,
      x.orig, x.sub, x.filler, before, x.shipOrig, x.shipSub, x.shipFil, after,
      // demand coverage: own original + substitutes received + filler, ÷ SOQ (a lender's lent cases don't inflate it)
      x.soq > 0 ? pctOf(x.shipOrig + (lane.dropped ? 0 : received(links, x.rz)) + x.shipFil, x.soq) : null,
      subText(lane, x, links), dropReason(lane, x)];
    if (lane.dropped) {   // held truck — nothing picked yet, nothing shipped, no order until RLM approves
      out.push([...dbPart, ...regPart, ...truckPart(before > 0 ? trucks[0] ?? null : null), null, null, null, null, null, 0, 0, null, null]);
      continue;
    }
    let any = false;
    for (const t of trucks) {
      const agg = new Map<string, { s: LoadSku; cases: number; units: number }>();
      for (const s of t.skus) {
        if (s.rz !== x.rz) continue;
        const k = `${s.sku}|${s.batch}`;
        const e = agg.get(k) ?? { s, cases: 0, units: 0 };
        e.cases += s.cases; e.units += s.units;
        agg.set(k, e);
      }
      for (const { s, cases, units } of [...agg.values()].sort((a, b) => a.s.sku.localeCompare(b.s.sku))) {
        any = true;
        out.push([...dbPart, ...regPart, ...truckPart(t), s.sku, s.desc, s.batch, s.daysToExpiry, s.isPdp, cases, units,
          t.order, t.order ? `${date} 15:30` : null]);
      }
    }
    if (!any) out.push([...dbPart, ...regPart, ...truckPart(null), null, null, null, null, null, 0, 0, null, null]);
  }
  return out;
}
const v2All = (date: string) => LANES.slice().sort((a, b) => a.db.code.localeCompare(b.db.code)).flatMap((l) => v2Rows(date, l));

get('/api/v1/uat_report_v2', (ctx) => {
  const all = v2All(ctx.date);
  if (ctx.query.get('format') === 'xlsx') return xlsxTable(`allocation_report_${ctx.date}.xlsx`, V2_COLS, forXlsx(all), 'Allocation Report');
  const scoped = inScope(ctx) ? all : [];
  const lanes = inScope(ctx) ? LANES : [];
  const pg = pageOf(ctx, V2_COLS, scoped);
  return { date: ctx.date, cfa: ctx.query.get('cfa') || null, cols: V2_COLS, rows: pg.rows, total: scoped.length,
    filtered: pg.filtered, limit: pg.limit, offset: pg.offset, kpi: kpiOf(lanes) };
});

// ═════════ Order Journey — trucks per DB + what each carried (owner-centric) + clusters ═════════
// The truck-plan read is the slow one (≈ a real backend's): the extra latency also means the page's boot-time refetches
// (no date → run date → header CFA) cancel each other and only the last lands — otherwise OrderJourneyPage's
// default-truck effect (deps [cur?.code, curTrucks.length]) doesn't re-fire after the refetch resets selTruck to null.
const TRUCK_PLAN_LATENCY_MS = 360;
get('/api/v1/order_journey_trucks', async (ctx) => {
  await new Promise((r) => setTimeout(r, TRUCK_PLAN_LATENCY_MS));
  if (!inScope(ctx)) return { date: ctx.date, cfa: ctx.query.get('cfa'), dbs: {}, clusters: [] };
  const dbs: Record<string, unknown[]> = {};
  for (const lane of LANES) {
    // each lent substitute case is attributed to the demand line it covered, in the order the engine recorded them
    const queue = new Map<string, { recv: string; left: number }[]>();
    for (const x of lane.lines) queue.set(x.rz, parseSubFor(x.subFor).map((p) => ({ recv: p.rz, left: p.cases })));
    dbs[lane.db.code] = trucksOf(lane).map((t) => ({
      truck: t.no, cases: t.cases, capacity: t.capacity, fill_pct: t.fill, so_flag: t.flag, truck_type: t.type,
      order_id: t.order, rlm_status: rlmStatus(t),
      lines: t.skus.flatMap((s) => {
        const base = { rz: s.rz, sku: s.sku, batch: s.batch, dte: s.daysToExpiry };
        if (!s.isSub) return [{ ...base, receiver: s.rz, source: s.isFiller ? 'Filler' : 'Original', cases: s.cases }];
        const parts: { rz: string; sku: string; batch: string; dte: number; receiver: string; source: string; cases: number }[] = [];
        let left = s.cases;
        for (const q of queue.get(s.rz) ?? []) {
          if (left <= 0) break;
          const c = Math.min(left, q.left);
          if (c <= 0) continue;
          parts.push({ ...base, receiver: q.recv, source: 'Substitute', cases: c });
          q.left -= c; left -= c;
        }
        if (left > 0) parts.push({ ...base, receiver: '', source: 'Substitute', cases: left });
        return parts;
      }),
    }));
  }
  const clusters = CLUSTERS.map((c) => ({
    code: c.code, primary_cap: c.primaryCap, primary_trucks: c.primaryTrucks, cluster_load: c.ships, combined_before_trim: c.combined,
    trimmed: c.trimmed, members: c.perDb.map((p) => ({ db: p.db, shipped: laneByDb.get(p.db)?.shipped ?? p.ships })),
  }));
  return { date: ctx.date, cfa: CFA, dbs, clusters };
});

// ═════════ RCA drill-through ═════════
get('/api/v1/rca/index', (ctx) => ({
  date: ctx.date,
  dbs: DISTRIBUTORS.map((d) => ({ id: d.code, name: d.name, channel: d.channel })),
  reg_zskus: REG_ZSKUS.map((z) => ({ id: z.rz, brand: z.brand })),
  cfas: [CFA],
}));

/** Step-1 regime of one reg-zsku pool in a run: NOT CONSTRAINED pools give full SOQ, CFA STOCK 0 gives 0, else the
 *  weight-equalising water level λ = Σ allocated ÷ Σ (SOQ × tier weight). */
function regimeOf(run: RunResult, rz: string): { regime: string; lambda: number | null } {
  const z = rzByCode.get(rz);
  const ls = run.lanes.flatMap((l) => l.lines.filter((x) => x.rz === rz && x.soq > 0).map((x) => ({ x, tw: tierWeight(l.db.tier) })));
  const demand = sumBy(ls, (e) => e.x.soq), pool = run.reserved[rz] ?? 0;
  if (!z || z.cfaStock === 0) return { regime: 'CFA STOCK 0', lambda: null };
  if (pool >= demand) return { regime: 'NOT CONSTRAINED', lambda: null };
  const w = sumBy(ls, (e) => e.x.soq * e.tw);
  return { regime: 'CONSTRAINED', lambda: w > 0 ? Math.round((sumBy(ls, (e) => e.x.orig) / w) * 10000) / 10000 : 0 };
}
const poolAfterStep1 = (run: RunResult, rz: string) =>
  (run.reserved[rz] ?? 0) - sumBy(run.lanes, (l) => sumBy(l.lines.filter((x) => x.rz === rz), (x) => x.orig));

/** Replays dataset.ts's two trims on this lane (truck-rule tail, then the cluster share) to show what the cluster pass cut. */
function clusterTrimOf(lane: Lane) {
  if (!(lane.clusterTrim > 0) || !lane.db.cluster) return undefined;
  const cl = CLUSTERS.find((c) => c.code === lane.db.cluster);
  if (!cl) return undefined;
  type V = { shipOrig: number; shipSub: number; shipFil: number };
  const st = new Map<string, V>(lane.lines.map((x) => [x.rz, { shipOrig: x.orig, shipSub: x.sub, shipFil: x.filler }]));
  const trim = (cases: number) => {
    let left = cases;
    for (const key of ['shipFil', 'shipSub', 'shipOrig'] as const) {
      for (const x of [...lane.lines].sort((a, b) => a.priorityAfter - b.priorityAfter || st.get(b.rz)![key] - st.get(a.rz)![key])) {
        if (left <= 0) return;
        const v = st.get(x.rz)!;
        const t = Math.min(v[key], left); v[key] -= t; left -= t;
      }
    }
  };
  if (lane.cascaded > 0) trim(lane.cascaded);
  const before = new Map([...st].map(([k, v]) => [k, { ...v }]));
  trim(lane.clusterTrim);
  const order = [...lane.lines].sort((a, b) => a.priorityAfter - b.priorityAfter);
  const trims: Record<string, unknown> = {};
  for (const x of lane.lines) {
    const b = before.get(x.rz)!, a = st.get(x.rz)!;
    const tb = b.shipOrig + b.shipSub + b.shipFil, ta = a.shipOrig + a.shipSub + a.shipFil;
    if (tb === ta) continue;
    trims[x.rz] = { sn_ratio: x.snAfter, sn_rank: order.indexOf(x) + 1, stock: x.dbStock, norm: x.norm, allocated_before: tb,
      allocated_after: ta, cut_total: tb - ta, cut_filler: b.shipFil - a.shipFil, cut_sub: b.shipSub - a.shipSub, cut_orig: b.shipOrig - a.shipOrig };
  }
  return { cluster_code: cl.code, primary_cap: cl.primaryCap, primary_trucks: cl.primaryTrucks, shipped_before: cl.combined,
    trimmed: cl.trimmed, shipped_after: lane.shipped, status: 'TRIMMED', trims };
}

get('/api/v1/rca/db/:dbid', (ctx) => {
  const d = findDb(ctx.params.dbid);
  const lane = d ? laneByDb.get(d.code) : undefined;
  if (!d || !lane) return { found: false, db: ctx.params.dbid, date: ctx.date };
  const run = runOf(lane), links = subLinks(lane), trucks = trucksOf(lane);
  // a dropped lane is told with its PRE-drop allocation (the page says so); every other lane with what actually ships
  const val = (x: Line): [number, number, number] => (lane.dropped ? [x.orig, x.sub, x.filler] : [x.shipOrig, x.shipSub, x.shipFil]);
  const lines = [...lane.lines].sort((a, b) => (b.soq > 0 ? 1 : 0) - (a.soq > 0 ? 1 : 0) || b.soq - a.soq || byRz(a, b)).map((x) => {
    const z = rzByCode.get(x.rz);
    const [o, s, f] = val(x), total = o + s + f;
    const fc = lane.fillerCalc.find((c) => c.z === x.rz && c.alloc > 0);
    return {
      reg_zsku: x.rz, brand: z?.brand ?? '', soq: x.soq, norm: x.norm, db_stock: x.dbStock, cfa_reserved: run.reserved[x.rz] ?? 0,
      original: o, substitute: s, substitute_from: subText(lane, x, links), filler: f,
      filler_from: f > 0 && fc ? `draw #${fc.rank} · ${fc.reason}` : null,
      total, fill_pct: x.soq > 0 ? pctOf(o + received(links, x.rz) + f, x.soq) : 100,   // demand coverage, not owner-centric
    };
  });
  const summary = {
    soq: lane.soq, original: sumBy(lines, (l) => l.original), substitute: sumBy(lines, (l) => l.substitute),
    filler: sumBy(lines, (l) => l.filler), allocated: sumBy(lines, (l) => l.total), fill_pct: 0,
  };
  summary.fill_pct = pctOf(summary.allocated, summary.soq);
  const step1 = demandLines(lane).sort(byRz).map((x) => {
    const g = regimeOf(run, x.rz);
    return { reg_zsku: x.rz, regime: g.regime, priority_before: g.regime === 'CONSTRAINED' ? x.priorityBefore : null,
      lambda: g.lambda, soq_remaining: x.soq - x.orig, allocated: x.orig };
  });
  const addonBudget = Math.floor(lane.soq * ADDON_PCT), subTotal = lane.sub;
  const step2 = lane.lines.flatMap((lender) => parseSubFor(lender.subFor).map((p) => {
    const rcv = lane.lines.find((x) => x.rz === p.rz);
    const short = rcv ? rcv.soq - rcv.orig : p.cases;
    return {
      reg_zsku: p.rz, sub_zsku: lender.rz, rank: 1, cfa_pool: Math.max(0, poolAfterStep1(run, lender.rz)),
      room: rcv ? Math.max(0, rcv.maxNorm - rcv.dbStock - rcv.orig) : 0, allocated: p.cases,
      reason: p.cases >= short ? 'shortfall covered' : subTotal >= addonBudget ? `${Math.round(ADDON_PCT * 100)}% add-on cap` : 'CFA pool',
    };
  })).sort((a, b) => a.reg_zsku.localeCompare(b.reg_zsku));
  const step3 = lane.fillerCalc.map((c) => ({ filler_zsku: c.z, rank: c.rank, room: c.room, truck_room: c.truck, cfa_pool: c.pool,
    allocated: c.alloc, reason: c.reason }));
  const skus = trucks.flatMap((t) => [...t.skus].sort((a, b) => a.daysToExpiry - b.daysToExpiry || a.rz.localeCompare(b.rz)).map((s) => ({
    reg_zsku: s.rz, sku: s.sku, batch: s.batch, days_to_expiry: s.daysToExpiry, qty: s.cases,
    source: s.isSub ? 'Substitute' : s.isFiller ? 'Filler' : 'Original', truck: t.no,
  })));
  const orders = trucks.map((t) => t.order).filter(Boolean) as string[];
  const ct = clusterTrimOf(lane);
  return {
    found: true, date: ctx.date, db: d.code, cfa: CFA,
    identity: { name: d.name, city: d.city, customer_type: d.channel, channel_code: ({ 'Non-PACE': 'NPC', 'Hub & Spoke': 'HNS', AFH: 'AFH', Retail: 'RTL' } as Record<string, string>)[d.channel] ?? 'NPC',
      sub_channel: d.salesOffice === 'Pune City' ? 'Urban' : 'Rural', gstin: d.gstin, sales_office: d.salesOffice },
    run: { no: lane.run, channel: run.run.channel, tier: d.tier },
    order_id: orders.length ? orders.join(', ')
      : lane.soFlag === 'RLM_FOR_SECOND_CFA' ? `none — shift to CFA ${ALT_CFA} pending` : lane.soFlag !== 'SO_CREATION' || lane.dropped ? 'none — held for RLM' : '—',
    is_pdp: pdpOf(lane) === 'PDP' ? 'Y' : 'N',
    so_flag: lane.soFlag, remark: remarkOf(lane),
    dropped: lane.dropped,
    drop_reason: !lane.dropped ? null : lane.soFlag === 'RLM_FOR_SECOND_CFA'
      ? `truck ${pctOf(lane.planned, d.truckCap)}% < ${KEEP_PCT}% and original fill ${lane.origFillPct}% < ${SO_FLOOR_PCT}% — shift to 2nd CFA ${ALT_CFA}`
      : `truck ${pctOf(lane.planned, d.truckCap)}% < ${KEEP_PCT}% — held for RLM truck approval`,
    ...(ct ? { cluster_trim: ct } : {}),
    summary, lines, step1, step2,
    filler_priority: { rank: lane.rank, of: run.lanes.length, priority: lane.priority, sum_norm: lane.sumNorm, sum_held: lane.sumHeld },
    step3,
    trucks: trucks.map((t) => ({ no: t.no, type: t.type, cases: t.cases, capacity: t.capacity, fill_pct: t.fill, so_flag: t.flag,
      is_transshipment: d.transship, order_id: t.order })),
    skus,
  };
});

get('/api/v1/rca/regzsku/:z', (ctx) => {
  const z = findRz(ctx.params.z);
  if (!z) return { found: false, reg_zsku: ctx.params.z, date: ctx.date };
  const cascade = RUN_RESULTS.map((r) => {
    const earmark = Math.floor((z.cfaStock * r.run.pct) / 100);
    const available = r.reserved[z.rz] ?? 0;
    const allocated = sumBy(r.lanes, (l) => sumBy(l.lines.filter((x) => x.rz === z.rz), shippedOf));
    return { run: r.run.run, channel: r.run.channel, earmark, carry_in: Math.max(0, available - earmark), available, allocated,
      remaining: available - allocated };
  });
  const allocated_to = LANES.flatMap((l) => l.lines.filter((x) => x.rz === z.rz).map((x) => ({
    db: l.db.code, name: l.db.name, channel: l.db.channel, soq: x.soq, step1_original: x.orig,
    original: x.shipOrig, substitute: x.shipSub, filler: x.shipFil, total: shippedOf(x), status: l.dropped ? 'dropped' : 'shipped',
  }))).sort((a, b) => b.total - a.total || b.soq - a.soq || a.db.localeCompare(b.db));
  return {
    found: true, date: ctx.date, reg_zsku: z.rz, desc: z.desc, brand: z.brand, category: z.category, mrp: z.mrp,
    physical: z.cfaStock, band: z.band,
    total_shipped: sumBy(allocated_to, (r) => r.total),
    total_dropped_step1: sumBy(allocated_to.filter((r) => r.status === 'dropped'), (r) => r.step1_original),
    reservation: cascade.map((c) => ({ channel: c.channel, reserved: c.earmark })),
    cascade, allocated_to,
  };
});

get('/api/v1/rca/cfa/:cfa', (ctx) => {
  if (bareCode(ctx.params.cfa) !== bareCode(CFA)) return { found: false, cfa: ctx.params.cfa, date: ctx.date };
  const physical = sumBy(REG_ZSKUS, (z) => z.cfaStock);
  const soq = sumBy(LANES, (l) => l.soq), allocated = sumBy(LANES, (l) => l.shipped);
  const per_run = RUN_RESULTS.map((r) => {
    const ls = r.lanes.flatMap((l) => l.lines);
    const o = sumBy(ls, (x) => x.shipOrig), s = sumBy(ls, (x) => x.shipSub), f = sumBy(ls, (x) => x.shipFil), q = sumBy(r.lanes, (l) => l.soq);
    return { run: r.run.run, channel: r.run.channel, dbs: r.lanes.length, soq: q, original: o, substitute: s, filler: f, total: o + s + f,
      fill_pct: pctOf(o + s + f, q) };
  });
  return {
    found: true, date: ctx.date, cfa: CFA, name: CFA_NAME,
    summary: { physical, soq, allocated, fill_pct: pctOf(allocated, soq), wasted: Math.max(0, physical - allocated) },
    per_run,
  };
});
