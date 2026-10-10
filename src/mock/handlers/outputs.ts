// outputs.ts — demo routes for the OUTPUT pages: Final Order · CFA × Reg-ZSKU roll-up · SAP Orders (de_sap.orders)
// · Order Status (de_sap.order_status, server-paginated) · S3 hand-off (order_line_items).
//
// Every number is derived from dataset.ts so the pages tie out with each other:
//   Final Order "SO cases created"  = Σ AOQ on CFA × Reg-ZSKU  = Σ qty on SAP Orders  = Σ cases in the S3 file
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

// ═════════════════════════ Final Order ═════════════════════════
const FINAL_COLS = ['CFA', 'DB', 'Reg-ZSKU', 'Norms', 'SOH', 'SOQ', 'Original allocated', 'Used as Substitute', 'Used as Filler',
  'Total shipped', 'Truck max cases', 'Is_Transhipment', 'Cluster', 'Primary_Truck_Count', 'SO_Flag', 'Cluster_Trimmed'];
type FinalRow = [string, string, string, number, number, number, number, number, number, number, number, boolean, string, number, string, number];

function finalRows(): FinalRow[] {
  const rows: FinalRow[] = [];
  for (const l of sortedLanes()) {
    const tr = l.db.transship;
    const cl = clusterOf(l.db.cluster);
    const trim = clusterTrimByLine(l);
    for (const x of sortedLines(l)) {
      const q = orderQty(l, x);
      rows.push([CFA, l.db.code, x.rz, x.norm, x.dbStock, x.soq, q.orig, q.sub, q.fil, q.orig + q.sub + q.fil,
        tr ? PRIMARY_CAP : l.db.truckCap, tr, tr ? (l.db.cluster ?? '') : '', tr ? (cl?.primaryTrucks ?? 0) : 0, l.soFlag, trim.get(x.rz) ?? 0]);
    }
  }
  return rows;
}

get('/api/v1/final_order', (ctx) => {
  const rows = isRunDate(ctx.date) ? finalRows() : [];
  if (wantsXlsx(ctx)) {
    const head = ['CFA', 'DB', 'DB Name', 'Reg-ZSKU', 'Description', ...FINAL_COLS.slice(3)];
    const body = rows.map((r) => {
      const db = DISTRIBUTORS.find((d) => d.code === r[1]);
      return [r[0], r[1], db?.name ?? '', r[2], rzByCode.get(r[2])?.desc ?? '', r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10],
        r[11] ? 'Y' : 'N', r[12], r[13], r[14], r[15]] as (string | number | null)[];
    });
    const byDb = sortedLanes().map((l) => {
      const q = l.lines.reduce((s, x) => { const v = orderQty(l, x); return { o: s.o + v.orig, s: s.s + v.sub, f: s.f + v.fil }; }, { o: 0, s: 0, f: 0 });
      return [CFA, l.db.code, l.db.name, l.db.channel, `Run ${l.run}`, l.soq, q.o, q.s, q.f, q.o + q.s + q.f,
        l.dropped ? 0 : l.trucks, l.dropped ? 0 : l.fillPct, l.soFlag] as (string | number | null)[];
    });
    return xlsxFile(`final_order_${fileTag(ctx.date)}.xlsx`, [
      { name: 'Final Order', rows: [head, ...body] },
      { name: 'By DB', rows: [['CFA', 'DB', 'DB Name', 'Channel', 'Run', 'SOQ', 'Original', 'Substitute', 'Filler', 'Total', 'Trucks', 'Truck fill %', 'SO_Flag'], ...byDb] },
    ]);
  }
  return {
    date: ctx.date, cols: FINAL_COLS, rows, total: rows.length,
    transhipment_dbs: new Set(rows.filter((r) => r[11]).map((r) => r[1])).size,
  };
});

// ═════════════════════════ CFA × Reg-ZSKU roll-up ═════════════════════════
get('/api/v1/cfa_regzsku_summary', (ctx) => {
  const ok = isRunDate(ctx.date);
  const acc = new Map<string, { soq: number; o: number; s: number; f: number }>();
  if (ok) {
    for (const l of LANES) for (const x of l.lines) {
      const a = acc.get(x.rz) ?? { soq: 0, o: 0, s: 0, f: 0 };
      a.soq += x.soq;
      if (!isRlm(l)) { a.o += x.shipOrig; a.s += x.shipSub; a.f += x.shipFil; }   // AOQ = what went for SO creation
      acc.set(x.rz, a);
    }
  }
  const rows = REG_ZSKUS.filter((z) => acc.has(z.rz)).map((z) => {
    const a = acc.get(z.rz)!;
    const aoq = a.o + a.s + a.f;
    return { cfa: CFA, reg_zsku: z.rz, total_inventory: z.cfaStock, soq: a.soq, original: a.o, as_substitute: a.s, as_filler: a.f,
      aoq, aoq_pct_soq: a.soq > 0 ? Math.round((aoq / a.soq) * 1000) / 10 : null };
  });
  const reservedTotal = ok ? REG_ZSKUS.filter((z) => z.cfaStock > 0).length : 0;
  const onPage = rows.filter((r) => r.total_inventory > 0).length;
  const recon = { reserved_total: reservedTotal, reserved_on_page: onPage, reserved_offpage: Math.max(0, reservedTotal - onPage) };
  return {
    date: ctx.date, rows, reservation: recon, reservation_by_cfa: { [CFA]: recon },
    totals: {
      lanes: rows.length, soq: rows.reduce((s, r) => s + r.soq, 0), aoq: rows.reduce((s, r) => s + r.aoq, 0),
      inventory: rows.reduce((s, r) => s + r.total_inventory, 0),
    },
  };
});

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

// ═════════════════════════ S3 hand-off (OE_OUTPUT · order_line_items parquet) ═════════════════════════
// Reg-zsku level, one row per order × reg-zsku × source (original / substitute / filler); a substitute or filler line is
// keyed to the reg-zsku that SUPPLIED it. Only SO-created orders land here, so rlm_approved is false for every line.
const S3_COLS = ['engine_order_id', 'run_date', 'cfa_code', 'distributor_code', 'distributor_name', 'channel', 'truck_number',
  'truck_description', 'reg_zsku_code', 'category', 'soq_qty', 'order_qty_cases', 'order_qty_units', 'mrp',
  'zsku_substitution', 'substitute_for', 'zsku_filler', 'so_flag', 'rlm_approved', 'created_at'];

function s3Rows(date: string): (string | number | boolean)[][] {
  const iso = isoOf(date);
  const createdAt = `${iso} ${runClock(date)}`;
  const rows: (string | number | boolean)[][] = [];
  for (const { lane, load } of soOrders()) {
    const db = lane.db;
    const truck = db.transship ? `${load.truckid} · primary ${db.cluster} · ${PRIMARY_CAP} cs` : `${load.truckid} · ${db.truckType}`;
    const agg = new Map<string, { rz: string; kind: 0 | 1 | 2; cases: number; units: number; mrp: number }>();
    for (const k of load.skus) {
      const kind = k.isSub ? 1 : k.isFiller ? 2 : 0;
      const key = `${kind}|${k.rz}`;
      const a = agg.get(key) ?? { rz: k.rz, kind, cases: 0, units: 0, mrp: k.mrp };
      a.cases += k.cases; a.units += k.units;
      agg.set(key, a);
    }
    const items = [...agg.values()].sort((a, b) => a.kind - b.kind || a.rz.localeCompare(b.rz));
    for (const a of items) {
      const ln = lane.lines.find((x) => x.rz === a.rz);
      const subFor = a.kind === 1 && ln?.subFor ? ln.subFor.split(',').map((s) => s.trim().split(':')[0]).join(', ') : '';
      rows.push([load.order, iso, CFA, db.code, db.name, db.channel, load.no, truck, a.rz, rzByCode.get(a.rz)?.category ?? '',
        a.kind === 0 ? (ln?.soq ?? 0) : 0, a.cases, a.units, a.mrp, a.kind === 1, subFor, a.kind === 2, lane.soFlag, false, createdAt]);
    }
  }
  return rows;
}

get('/api/v1/s3_order_line_items', (ctx) => {
  const dates = [...RUN_DATES].reverse();
  const found = isRunDate(ctx.date);
  const iso = isoOf(ctx.date);
  const rows = found ? s3Rows(ctx.date) : [];
  return {
    date: ctx.date,
    path: found ? `s3://oe-handoff-prod/OE_OUTPUT/order_line_items/run_date=${iso}/order_line_items_${fileTag(ctx.date)}_${CFA}.parquet` : null,
    found, columns: S3_COLS, count: rows.length, rows, dates,
  };
});
