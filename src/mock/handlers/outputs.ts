// outputs.ts — demo routes for the OUTPUT pages: SAP Orders (de_sap.orders) · Order Status (de_sap.order_status,
// server-paginated).
//
// Every number is derived from dataset.ts so the pages tie out with each other:
//   SAP orders = the SO_CREATION trucks (soOrders()), one row per order × SAP material (summed over the truck)
//   Order status = SAP's write-back trail for exactly those orders (zcount = that order's SAP line count)
import { get, xlsxFile, xlsxTable, type Ctx } from '../router';
import {
  CFA, CLUSTERS, DISTRIBUTORS, LANES, PRIMARY_CAP, REG_ZSKUS, RUN_DATES, RUN_TIMESTAMP, LATEST_DATE,
  rng, rzByCode, shippedOf, soOrders, type Lane, type Line, type Load,
} from '../dataset';

// ───────────────────────── date helpers ─────────────────────────
const MONTHS: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const p2 = (n: number) => String(n).padStart(2, '0');
/** '10-Oct-2026' → '2026-10-10' (falls back to the latest run date) */
function isoOf(date: string): string {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(date.trim());
  if (!m || !MONTHS[m[2]]) return isoOf(LATEST_DATE);
  return `${m[3]}-${p2(MONTHS[m[2]])}-${p2(Number(m[1]))}`;
}
const isRunDate = (date: string) => RUN_DATES.includes(date);
/** the run's finish time on that date, as minutes after midnight (IST) */
function runMinutes(date: string): number {
  const ts = RUN_TIMESTAMP[date] ?? RUN_TIMESTAMP[LATEST_DATE];
  const m = /T(\d{2}):(\d{2}):(\d{2})/.exec(ts);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 6 * 60 + 40;
}
const runClock = (date: string) => /T(\d{2}:\d{2}:\d{2})/.exec(RUN_TIMESTAMP[date] ?? RUN_TIMESTAMP[LATEST_DATE])?.[1] ?? '06:41:27';
/** minutes after midnight (may run past 24h) on `iso` → ['YYYY-MM-DD', 'HH:MM:SS'] */
function stamp(iso: string, minutes: number, sec: number): [string, string] {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMinutes(Math.round(minutes));
  return [d.toISOString().slice(0, 10), `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(sec % 60)}`];
}
const wantsXlsx = (ctx: Ctx) => (ctx.query.get('format') || '').toLowerCase() === 'xlsx';
const fileTag = (date: string) => isoOf(date).replace(/-/g, '');

// ───────────────────────── shared derivations ─────────────────────────
const sortedLanes = () => [...LANES].sort((a, b) => a.db.code.localeCompare(b.db.code));
const sortedLines = (l: Lane) => [...l.lines].sort((a, b) => a.rz.localeCompare(b.rz));
const clusterOf = (code: string | null) => CLUSTERS.find((c) => c.code === code);
const isRlm = (l: Lane) => l.soFlag !== 'SO_CREATION';

/** The cases of a line that the order carries. A dropped (RLM truck-approval) lane ships nothing yet, but its planned
 *  truck is HELD for RLM — the Final Order shows that held quantity under its RLM flag (counted "on hold", not shipped). */
function orderQty(l: Lane, x: Line): { orig: number; sub: number; fil: number } {
  if (l.dropped) return { orig: x.orig, sub: x.sub, fil: x.filler };
  return { orig: x.shipOrig, sub: x.shipSub, fil: x.shipFil };
}

/** Per-line cases removed by the CLUSTER primary-truck pass (replays the truck-rule trim, then diffs to what ships). */
function clusterTrimByLine(l: Lane): Map<string, number> {
  const out = new Map<string, number>();
  if (l.dropped || l.clusterTrim <= 0) return out;
  const sim = l.lines.map((x) => ({ x, shipOrig: x.orig, shipSub: x.sub, shipFil: x.filler }));
  let left = l.cascaded;
  outer: for (const key of ['shipFil', 'shipSub', 'shipOrig'] as const) {
    for (const s of [...sim].sort((a, b) => a.x.priorityAfter - b.x.priorityAfter || b[key] - a[key])) {
      if (left <= 0) break outer;
      const t = Math.min(s[key], left); s[key] -= t; left -= t;
    }
  }
  for (const s of sim) out.set(s.x.rz, Math.max(0, s.shipOrig + s.shipSub + s.shipFil - shippedOf(s.x)));
  return out;
}

// ═════════════════════════ SAP hand-off (de_sap.orders) ═════════════════════════
const SALES_ORG = '1100';
const SALES_OFFICE: Record<string, string> = { 'Pune City': 'PNC1', 'Pune Rural': 'PNR1' };
const isBev = (rz: string) => /Drink|Juice/.test(rzByCode.get(rz)?.category ?? '');

interface SapLine { lane: Lane; load: Load; posnr: string; sku: string; rz: string; cases: number; units: number; mrp: number }
interface SapOrder { lane: Lane; load: Load; lines: SapLine[]; cases: number; units: number; value: number; vbeln: string; seq: number }

/** SO_CREATION trucks → SAP orders, one line per order × material (summed over the truck), POSNR 10, 20, 30 … */
function sapOrders(): SapOrder[] {
  return soOrders().map(({ lane, load }, i) => {
    const bySku = new Map<string, SapLine>();
    for (const k of load.skus) {
      const cur = bySku.get(k.sku);
      if (cur) { cur.cases += k.cases; cur.units += k.units; continue; }
      bySku.set(k.sku, { lane, load, posnr: '', sku: k.sku, rz: k.rz, cases: k.cases, units: k.units, mrp: k.mrp });
    }
    const lines = [...bySku.values()];
    lines.forEach((ln, j) => { ln.posnr = String((j + 1) * 10).padStart(6, '0'); });
    const units = lines.reduce((s, x) => s + x.units, 0);
    return {
      lane, load, lines, seq: i,
      cases: lines.reduce((s, x) => s + x.cases, 0), units,
      value: Math.round(lines.reduce((s, x) => s + x.units * x.mrp, 0) * 0.74),   // distributor landing ≈ 74% of MRP
      vbeln: String(80041200 + i * 3).padStart(10, '0'),
    };
  });
}

const SAP_COLS = ['oeid', 'zposnr', 'zkunnr', 'zvkorg', 'zvkbur', 'zspart', 'zvbtype', 'zerdat', 'zernum', 'zwerks', 'zmatnr', 'zmenge', 'zmeins', 'zautyp', 'is_active'];
function sapRows(date: string): (string | number)[][] {
  if (!isRunDate(date)) return [];
  const iso = isoOf(date), clock = runClock(date);
  return sapOrders().flatMap((o) => o.lines.map((ln) => [
    o.load.order, ln.posnr, o.lane.db.code, SALES_ORG, SALES_OFFICE[o.lane.db.salesOffice] ?? 'PNC1', isBev(ln.rz) ? '20' : '10',
    'ZOR', iso, clock, CFA, ln.sku, ln.cases, 'CS', 'AUTO', 1,
  ]));
}

get('/api/v1/sap_orders', (ctx) => {
  const rows = sapRows(ctx.date);
  if (wantsXlsx(ctx)) return xlsxTable(`sap_orders_${fileTag(ctx.date)}.xlsx`, SAP_COLS, rows, 'de_sap.orders');
  return { date: ctx.date, cols: SAP_COLS, rows, count: rows.length };
});

// ═════════════════════════ SAP write-back (de_sap.order_status) ═════════════════════════
// Each SAP order walks CREATED → INVOICED → DISPATCHED → DELIVERED through the day; how far it has got depends on the
// distance to the DB (city DBs deliver same-day, rural ones are still on the road) — older run dates are all delivered.
const STATUS_COLS = ['id', 'oeid', 'zvbeln', 'zstatus_msg', 'zstatus', 'zernum', 'zdatum', 'zerdat', 'zmode', 'zcount', 'created_on'];
type StatusBody = [string, string, string, string, string, string, string, string, number, string];   // all but id
type StatusRow = [number, ...StatusBody];
const inr = (n: number) => `INR ${n.toLocaleString('en-IN')}`;

function statusRows(date: string): StatusRow[] {
  if (!isRunDate(date)) return [];
  const iso = isoOf(date), t0 = runMinutes(date);
  const latest = date === LATEST_DATE;
  const out: StatusBody[] = [];
  const add = (o: SapOrder, status: string, msg: string, mode: string, minutes: number, r: ReturnType<typeof rng>) => {
    const [d, tm] = stamp(iso, minutes, r.int(0, 59));
    out.push([o.load.order, o.vbeln, msg, status, runClock(date), d, iso, mode, o.lines.length, `${d} ${tm}`]);
  };
  for (const o of sapOrders()) {
    const r = rng(Number(o.load.order.slice(-6)) * 31 + RUN_DATES.indexOf(date));
    const db = o.lane.db;
    const city = db.salesOffice === 'Pune City';
    // furthest stage reached: 1 created · 2 invoiced · 3 dispatched · 4 delivered
    const stage = !latest ? 4 : city ? (r.chance(0.7) ? 4 : 3) : db.transship ? 2 : (r.chance(0.5) ? 3 : 2);
    const creditHold = latest && !city && o.seq === 2;   // one rural order trips the credit check before release
    let t = t0 + r.int(3, 9);
    add(o, 'CREATED', `Sales order ${o.vbeln} created · ${o.lines.length} item(s) · ${o.cases.toLocaleString()} CS`, 'SYNC', t, r);
    if (creditHold) {
      add(o, 'CREDIT_BLOCK', `Credit check: order ${o.vbeln} blocked — open receivables above limit`, 'SYNC', t + 1, r);
      t += r.int(110, 170);
      add(o, 'RELEASED', `Credit block released by finance · ${o.vbeln} cleared for delivery`, 'MANUAL', t, r);
    }
    if (stage < 2) continue;
    t += r.int(95, 170);
    const dlv = String(84017300 + o.seq * 7).padStart(10, '0'), inv = String(90052100 + o.seq * 5).padStart(10, '0');
    add(o, 'INVOICED', `Delivery ${dlv} picked · invoice ${inv} posted · ${inr(o.value)}`, 'BATCH', t, r);
    if (stage < 3) continue;
    t += r.int(50, 110);
    const via = db.transship ? `primary truck ${o.load.truckid} (cluster ${db.cluster})` : `truck ${o.load.truckid}`;
    add(o, 'DISPATCHED', `Goods issued from plant ${CFA} · ${via} dispatched to ${db.city}`, 'BATCH', t, r);
    if (stage < 4) continue;
    t += city ? r.int(70, 150) : r.int(240, 420);
    add(o, 'DELIVERED', `Proof of delivery received at ${db.city} · ${o.cases.toLocaleString()} CS · ${o.units.toLocaleString()} units`, 'POD', t, r);
  }
  // newest status first; ids follow insertion time (the write-back table's sequence)
  const byTime = [...out].sort((a, b) => a[9].localeCompare(b[9]));
  const base = 52310 + RUN_DATES.indexOf(date) * 200;
  const withId = byTime.map((row, i): StatusRow => [base + i, ...row]);
  return withId.reverse();
}

get('/api/v1/order_status', (ctx) => {
  const needle = (ctx.query.get('q') || '').trim().toLowerCase();
  const all = statusRows(ctx.date);
  const hits = needle ? all.filter((r) => r.some((v) => String(v).toLowerCase().includes(needle))) : all;
  if (wantsXlsx(ctx)) {
    return xlsxTable(`order_status_${fileTag(ctx.date)}${needle ? '_filtered' : ''}.xlsx`, STATUS_COLS, hits, 'de_sap.order_status');
  }
  const limit = Math.max(1, Math.min(1000, Number(ctx.query.get('limit')) || 100));
  const offset = Math.max(0, Number(ctx.query.get('offset')) || 0);
  const rows = hits.slice(offset, offset + limit);
  return { date: ctx.date, cols: STATUS_COLS, rows, count: rows.length, total: hits.length, limit, offset };
});
