// reservations.ts — demo routes for the reservation + pre-processing pages. EVERY number is derived from dataset.ts
// (1 CFA · 10 DBs · 40 reg-zskus · 2 cascade runs), so these pages agree with each other and with the engine pages.
//
//   GET /api/v1/reservation/runs            cascade (MRP band × run) + per-run meta   → ReservationRunsPage, Sidebar run list
//   GET /api/v1/reservation/data            per run: CFA → DB truck → reg-zsku / SKU    → ReservationRunsPage "Allocation runs"
//   GET /api/v1/reservation/rlm_ptl         RLM truck-approval headers + line items     → "RLM truck approval" tab
//   GET /api/v1/reservation/rlm_second_cfa  2nd-CFA shift headers + line items          → "2nd CFA shift" tab
//   GET /api/v1/ledger                      reg-zsku × run CFA stock ledger + reservation_detail
//                                                                                      → CfaStockLedgerPage, CfaStockReservationPage
//   GET /api/v1/reservation/prefilter       pre-processing stages A–E                   → ReservationPrefilterPage
//   GET /api/v1/filtered_soq                demand-gate decision + kept SOQ lines        → FilteredSoqPage
//   GET /api/v1/filtered_soq/dropped        dropped (DB, CFA) groups — paged (limit/offset) + any-field search (q)
//
// Conventions used here (kept local so dataset.ts stays untouched):
//   • MRP band = the band the pages label: Band 1 ≤ ₹10 · Band 2 ₹11-30 · Band 3 > ₹30 (from the reg-zsku MRP).
//   • Reservation % is per channel run (RUNS[].pct) for every band; the LAST run takes the remainder so the per-run
//     earmarks sum back to physical stock exactly. Run 1's earmark == dataset run-1 reserved pool.
//   • "Allocated" in the ledger / cascade = what physically ships (post truck rule + cluster trim) — so shipped == allocated.
//   • Demand gate: CFA 9001's 10 (DB, CFA) groups all pass (they are the engine's lanes). The satellite CFA 9002 also
//     receives SOQ from a few of the same DBs; those groups fail the gate (that is why 9002 has no own demand), and the
//     9001 view of the gate includes its satellite so the dropped / cluster-rejected sections are populated.
import { get } from '../router';
import {
  CFA, CFA_NAME, ALT_CFA, PLANTS, DISTRIBUTORS, REG_ZSKUS, RUNS, LANES, CLUSTERS, DEMAND, SOQ_DATE, LATEST_DATE,
  rzByCode, dbByCode, bareCode, rng, type Lane, type RegZsku, type Distributor,
} from '../dataset';
import type { Cfa, Truck, Truckload, Line as LineT, Sku, FillerCalc } from '../../types';

const round1 = (x: number) => Math.round(x * 10) / 10;
const sum = <T,>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const pctOf = (a: number, b: number) => (b > 0 ? round1((a / b) * 100) : 0);
const MON: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
/** '9-Oct-2026' → '20261009' (order-id suffix) */
const ymd = (date: string) => {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(date);
  return m ? `${m[3]}${MON[m[2]] ?? '01'}${m[1].padStart(2, '0')}` : date.replace(/\D/g, '');
};
const dbTail = (code: string) => bareCode(code).slice(-4);
const ALT_NAME = PLANTS.find((p) => p.plant === ALT_CFA)?.name ?? `CFA ${ALT_CFA}`;
const pctMeta = (date: string) => ({
  reservation_pct_date: date, reservation_pct_fallback: false,
  reservation_pct_source_run_date: SOQ_DATE[date] ?? null, reservation_pct_requested_date: date,
});

// ───────── MRP band (what the pages label: ≤₹10 · ₹11-30 · >₹30) ─────────
const bandOf = (z: RegZsku) => (z.mrp <= 10 ? 1 : z.mrp <= 30 ? 2 : 3);
const BANDS = [1, 2, 3] as const;

// ───────── per reg-zsku × run CFA stock ledger (the backbone of cascade / ledger / reservation detail) ─────────
interface Cell { earmark: number; carriedIn: number; cap: number; own: number; sub: number; fil: number; alloc: number; remaining: number }
const LEDGER = new Map<string, Cell[]>(REG_ZSKUS.map((z) => {
  let carry = 0, earmarked = 0;
  const cells = RUNS.map((run, i) => {
    const earmark = i === RUNS.length - 1 ? z.cfaStock - earmarked : Math.floor((z.cfaStock * run.pct) / 100);
    earmarked += earmark;
    let own = 0, sub = 0, fil = 0;
    for (const l of LANES) {
      if (l.run !== run.run) continue;
      for (const x of l.lines) if (x.rz === z.rz) { own += x.shipOrig; sub += x.shipSub; fil += x.shipFil; }
    }
    const cap = earmark + carry, alloc = own + sub + fil;
    const cell: Cell = { earmark, carriedIn: carry, cap, own, sub, fil, alloc, remaining: cap - alloc };
    carry = cell.remaining;
    return cell;
  });
  return [z.rz, cells];
}));
const cellOf = (rz: string, runIdx: number) => LEDGER.get(rz)![runIdx];
const runLanes = (run: number) => LANES.filter((l) => l.run === run);
/** total SOQ of a reg-zsku at the CFA (every engine lane) */
const soqOfRz = new Map(REG_ZSKUS.map((z) => [z.rz, sum(DEMAND.filter((d) => d.rz === z.rz), (d) => d.soq)]));

// ───────── /reservation/runs — cascade + per-run meta (also feeds the Sidebar run list) ─────────
const CASCADE = Object.fromEntries(BANDS.map((b) => {
  const zs = REG_ZSKUS.filter((z) => bandOf(z) === b);
  return [String(b), RUNS.map((run, i) => {
    const cs = zs.map((z) => cellOf(z.rz, i));
    return {
      run: run.run, channel: run.channel, pct: run.pct,
      earmark: sum(cs, (c) => c.earmark), carried_in: sum(cs, (c) => c.carriedIn), available: sum(cs, (c) => c.cap),
      allocated: sum(cs, (c) => c.alloc), carried_out: sum(cs, (c) => c.remaining),
    };
  })];
}));
const RUN_META = RUNS.map((run, i) => {
  const lanes = runLanes(run.run);
  const demand = sum(lanes, (l) => l.soq), allocated = sum(lanes, (l) => l.shipped);
  const cap = sum(REG_ZSKUS, (z) => cellOf(z.rz, i).cap);
  return {
    meta: {
      run: run.run, channel: run.channel, band: BANDS.length, pct: run.pct, label: run.label,
      lanes: lanes.length, demand, cap, allocated, fill: pctOf(allocated, demand), leftover: cap - allocated,
      trucks: sum(lanes, (l) => l.trucks), held: lanes.filter((l) => l.dropped).length,
    },
  };
});
get('/api/v1/reservation/runs', (ctx) => ({ date: ctx.date, cfa: CFA, cascade: CASCADE, runs: RUN_META }));

// ───────── /reservation/data — per run: CFA → DB lanes (trucks, reg-zsku lines, SKU picks, filler calc) ─────────
function toTruck(l: Lane, nRank: number): Truck {
  const shipSub = sum(l.lines, (x) => x.shipSub);
  const subShare = l.sub > 0 ? shipSub / l.sub : 0;   // share of the substitutes this lane still ships after any trim
  const lines: LineT[] = l.lines.filter((x) => x.soq > 0 || x.shipOrig + x.shipSub + x.shipFil > 0).map((x) => {
    const z = rzByCode.get(x.rz)!;
    const phys = x.shipOrig + x.shipSub + x.shipFil;
    const own = l.dropped ? 0 : Math.min(x.soq, x.shipOrig + Math.round(x.subGot * subShare));
    const filTrucks = l.loads.filter((ld) => ld.skus.some((s) => s.rz === x.rz && s.isFiller)).map((ld) => `T${ld.no}`).join('+');
    return [x.rz, z.brand, x.soq, x.shipOrig, x.shipSub, x.shipSub > 0 ? x.subFor : '', x.shipFil, x.shipFil > 0 ? (filTrucks || 'T1') : '',
      phys, z.cfaStock, x.dbStock, x.norm, z.desc, x.maxNorm, own,
      x.priorityBefore, x.priorityAfter, x.snBefore, x.snAfter, x.requiredM, x.valueM, x.binding];
  });
  const loads: Truckload[] = l.loads.map((ld) => ({
    no: ld.no, cases: ld.cases, planned: ld.planned, truckid: ld.truckid, order: ld.order,
    skus: ld.skus.map((s): Sku => [s.rz, s.sku, s.cases, s.units, s.mrp, s.batch, s.daysToExpiry, s.isSub, s.isFiller, s.rz, s.isPdp]),
  }));
  const cl = l.db.cluster ? CLUSTERS.find((c) => c.code === l.db.cluster) : undefined;
  const per = cl?.perDb.find((p) => p.db === l.db.code);
  const filler_calc: FillerCalc[] = l.fillerCalc.map((f) => ({ ...f, reason: f.reason === 'CFA pool' ? 'CFA stock pool' : f.reason }));
  return {
    db: l.db.code, name: l.db.name, tier: l.db.tier, tot: l.shipped, soq: l.soq, cap: l.db.truckCap, truckType: l.db.truckType,
    soFlag: l.soFlag, origFillPct: l.origFillPct, combinedFillPct: l.combinedFillPct,
    isTranship: l.db.transship, cluster: l.db.cluster ?? undefined,
    primaryTruckCount: cl ? round1(cl.combined / cl.primaryCap) : undefined,
    clusterCombine: cl && per ? {
      code: cl.code, combined_load: cl.combined, primary_cap: cl.primaryCap, primary_trucks: cl.primaryTrucks, primary_ships: cl.ships,
      db_sec_built: per.built, db_trimmed: per.trimmed, db_ships: per.ships,
    } : null,
    n: lines.length, lines, loads, filler_calc,
    priority: l.priority, rank: l.rank, nRank, sumNorm: l.sumNorm, sumHeld: l.sumHeld,
    dropped: l.dropped, dropOrig: l.dropOrig, dropSub: l.dropSub, dropFil: l.dropFil, cascaded: l.cascaded,
  };
}
const RESERVATION_DATA = Object.fromEntries(RUNS.map((run, i) => {
  const lanes = runLanes(run.run);
  const trucks = [...lanes].sort((a, b) => a.db.code.localeCompare(b.db.code)).map((l) => toTruck(l, lanes.length));
  // CFA stock before THIS run = physical − what earlier runs shipped
  const atp = sum(REG_ZSKUS, (z) => z.cfaStock - sum(LEDGER.get(z.rz)!.slice(0, i), (c) => c.alloc));
  const cfa: Cfa = { cfa: CFA, tot: sum(lanes, (l) => l.shipped), soq: sum(lanes, (l) => l.soq), nt: sum(lanes, (l) => l.trucks), atp, trucks };
  return [String(run.run), { cfas: [cfa], meta: { cases: cfa.tot, trucks: cfa.nt } }];
}));
get('/api/v1/reservation/data', () => RESERVATION_DATA);

// ───────── distributor PDP master (delivery plan) + DB-side helpers ─────────
const PDP_PLAN: { due: boolean; freq: string }[] = [
  { due: true, freq: 'Mon · Thu' }, { due: false, freq: 'Tue · Fri' }, { due: true, freq: 'Mon · Wed · Fri' },
  { due: false, freq: 'Weekly · Wed' }, { due: true, freq: 'Tue · Sat' }, { due: true, freq: 'Daily' },
  { due: false, freq: 'Mon · Thu' }, { due: true, freq: 'Weekly · Sat' }, { due: false, freq: 'Wed · Sat' },
  { due: true, freq: 'Tue · Fri' },
];
const pdpOf = (code: string) => PDP_PLAN[DISTRIBUTORS.findIndex((d) => d.code === code)] ?? { due: false, freq: '' };
const covPct = (stock: number, norm: number) => (norm > 0 ? round1((stock / norm) * 100) : null);
const stockStatus = (cov: number | null) =>
  cov == null ? 'Healthy' : cov <= 0 ? 'Out of Stock' : cov < 60 ? 'Low' : cov <= 125 ? 'Healthy' : 'Overstocked';
const BELOW_PCT = 0.25;   // a reg-zsku line is "below threshold" when DB stock < 25% of its norm

// ───────── /reservation/rlm_ptl — trucks held for RLM truck approval ─────────
function ptlPayload(date: string) {
  const lanes = LANES.filter((l) => l.soFlag === 'RLM_TRUCK_APPROVAL');
  const headers = lanes.map((l, i) => {
    const qOf = (x: Lane['lines'][number]) => (l.dropped ? { o: x.orig, s: x.sub, f: x.filler } : { o: x.shipOrig, s: x.shipSub, f: x.shipFil });
    const line_items = l.lines.map((x) => {
      const { o, s, f } = qOf(x);
      const q = o + s + f;
      const cov = covPct(x.dbStock + q, x.norm);
      return {
        reg_zsku_code: x.rz, truck_number: q > 0 ? 1 : null, truck_qty: q, zsku_description: rzByCode.get(x.rz)!.desc,
        zsku_soq_qty: x.soq, zsku_aoq_qty: q, zsku_original_qty: o, zsku_filler_qty: f, zsku_substitution_qty: s,
        zsku_soh: x.dbStock, zsku_db_inventory_coverage_pct: cov, zsku_current_inventory_coverage_pct: covPct(x.dbStock, x.norm),
        zsku_stock_status: stockStatus(cov),
      };
    }).sort((a, b) => (a.truck_number == null ? 1 : 0) - (b.truck_number == null ? 1 : 0) || b.truck_qty - a.truck_qty);
    const base = sum(line_items, (x) => x.zsku_original_qty), fil = sum(line_items, (x) => x.zsku_filler_qty), sub = sum(line_items, (x) => x.zsku_substitution_qty);
    const aoq = base + fil + sub, cap = l.db.truckCap, pdp = pdpOf(l.db.code);
    return {
      engine_order_id: `PTL-${CFA}-${dbTail(l.db.code)}-${ymd(date)}`,
      status: i % 2 === 0 ? 'APPROVED' : 'REJECTED',   // decided — matches the Run page's after-RLM rollup
      distributor_code: l.db.code, distributor_name: l.db.name, pdp_flag: pdp.due, pdp_frequency: pdp.freq || null,
      soq: l.soq, cfa_code: CFA, truck_type: l.db.truckType, truck_number: 1, total_trucks: Math.max(1, l.trucks),
      truck_load_capacity: cap, aoq_qty: aoq, truck_load_gap_qty: Math.max(0, cap - aoq), truck_load_utilization_pct: pctOf(aoq, cap),
      base_aoq_qty: base, filler_aoq_qty: fil, substitution_aoq_qty: sub, line_items,
    };
  });
  return {
    date, available: headers.length > 0, headers,
    summary: { trucks: headers.length, dbs: new Set(headers.map((h) => h.distributor_code)).size,
      line_items: sum(headers, (h) => h.line_items.length), total_aoq: sum(headers, (h) => h.aoq_qty) },
  };
}
get('/api/v1/reservation/rlm_ptl', (ctx) => ptlPayload(ctx.date));

// ───────── /reservation/rlm_second_cfa — DBs whose order routes to the alternate CFA ─────────
// Data-driven: every lane the dataset flags RLM_FOR_SECOND_CFA (all its demanded lines). If the dataset has none
// (currently every lane's Original ÷ SOQ clears 50%), fall back to the scarce-leaning DB (…07) and shift ONLY its
// reg-zskus whose own Original fill is under the floor — a partial 2nd-CFA shift of the short lines.
function shiftCandidates() {
  const flagged = LANES.filter((l) => l.soFlag === 'RLM_FOR_SECOND_CFA');
  if (flagged.length) return flagged.map((lane) => ({ lane, lines: lane.lines.filter((x) => x.soq > 0) }));
  const pool = LANES.filter((l) => !l.dropped);
  const lane = pool.find((l) => bareCode(l.db.code).endsWith('7')) ?? [...pool].sort((a, b) => a.origFillPct - b.origFillPct)[0];
  const lines = lane ? lane.lines.filter((x) => x.soq > 0 && x.orig / x.soq < 0.5) : [];
  return lane && lines.length ? [{ lane, lines }] : [];
}
function shiftPayload(date: string) {
  const headers = shiftCandidates().map(({ lane: l, lines }, i) => {
    const r = rng(Number(bareCode(l.db.code)) * 31 + 7);
    const line_items = lines.map((x) => {
      const pref = x.orig;   // Step-1 Original the preferred CFA could give (a flagged lane is held, so nothing shipped)
      const short = Math.max(0, x.soq - pref);
      const alt = r.chance(0.8) ? short : Math.round(short * (0.6 + r.next() * 0.3));   // alternate CFA's stock covers it (mostly)
      const aoq = pref + alt;
      const cov = covPct(x.dbStock + aoq, x.norm);
      return {
        reg_zsku_code: x.rz, zsku_description: rzByCode.get(x.rz)!.desc, zsku_soq_qty: x.soq, zsku_aoq_qty: aoq,
        zsku_alternate_cfa_qty: alt, zsku_db_inventory_coverage_pct: cov, zsku_stock_status: stockStatus(cov),
        zsku_preferred_cfa_qty: pref,
      };
    });
    const soq = sum(lines, (x) => x.soq), fill = sum(lines, (x) => x.orig);
    const altQty = sum(line_items, (x) => x.zsku_alternate_cfa_qty);
    return {
      engine_order_id: `SHF-${CFA}-${dbTail(l.db.code)}-${ymd(date)}`,
      status: i % 2 === 0 ? 'SHIFTED' : 'APPROVED',   // decided — matches the Run page's after-RLM rollup
      distributor_code: l.db.code, distributor_name: l.db.name,
      preferred_cfa_code: CFA, preferred_cfa_name: CFA_NAME, preferred_cfa_fill_pct: pctOf(fill, soq),
      preferred_cfa_fill_qty: fill, preferred_cfa_shortfall_qty: soq - fill,
      alternate_cfa_code: ALT_CFA, alternate_cfa_name: ALT_NAME, alternate_cfa_qty: altQty,
      aoq_qty: fill + altQty, lead_time: '2 days', soq, line_items,
    };
  });
  return {
    date, available: headers.length > 0, headers,
    summary: { orders: headers.length, dbs: new Set(headers.map((h) => h.distributor_code)).size,
      line_items: sum(headers, (h) => h.line_items.length), total_aoq: sum(headers, (h) => h.aoq_qty) },
  };
}
get('/api/v1/reservation/rlm_second_cfa', (ctx) => shiftPayload(ctx.date));

// ───────── /ledger — CFA stock ledger (CfaStockLedgerPage) + reservation_detail (CfaStockReservationPage) ─────────
const LEDGER_COLS = ['cfa_id', 'run_no', 'channel', 'reg_zsku', 'mrp_band', 'original_stock', 'earmark_added', 'carried_in',
  'reservation_cap', 'allocated', 'as_original', 'as_substitute', 'as_filler', 'remaining_after', 'is_cross_band_filler'];
const LEDGER_ROWS = REG_ZSKUS.flatMap((z) => RUNS.map((run, i) => {
  const c = cellOf(z.rz, i);
  return {
    cfa_id: CFA, run_no: run.run, channel: run.channel, reg_zsku: z.rz, mrp_band: `Band ${bandOf(z)}`, original_stock: z.cfaStock,
    earmark_added: c.earmark, carried_in: c.carriedIn, reservation_cap: c.cap, allocated: c.alloc,
    as_original: c.own, as_substitute: c.sub, as_filler: c.fil, remaining_after: c.remaining, is_cross_band_filler: c.fil > 0,
  };
}));
const RESERVATION_DETAIL = REG_ZSKUS.flatMap((z) => RUNS.map((run, i) => {
  const c = cellOf(z.rz, i), soq = soqOfRz.get(z.rz) ?? 0;
  return {
    cfa_id: CFA, channel: run.channel, reg_zsku: z.rz, zsku: z.zsku, brand_category: z.category,
    role: soq > 0 ? 'Demanded (SOQ)' : 'Donor only', in_soq: soq > 0, soq_cases: soq,
    mrp: String(z.mrp), mrp_band: `Band ${bandOf(z)}`, reservation_pct: run.pct, mrp_note: '',
    physical_cases: z.cfaStock, reserved_cases: c.earmark, shipped: c.alloc,
    status: z.cfaStock > 0 ? 'Priced · reserved' : 'No CFA stock', in_inventory: true,
  };
}));
get('/api/v1/ledger', (ctx) => {
  const cfa = (ctx.query.get('cfa') ?? '').trim();
  const mine = !cfa || bareCode(cfa) === bareCode(CFA);
  const rows = mine ? LEDGER_ROWS : [];
  return {
    date: ctx.date, cfa: cfa || null, cols: LEDGER_COLS, rows,
    regzskus: mine ? REG_ZSKUS.map((z) => z.rz).sort() : [],
    shipped: mine ? Object.fromEntries(REG_ZSKUS.map((z) => [`${z.rz}|${CFA}`, sum(LEDGER.get(z.rz)!, (c) => c.alloc)])) : {},
    reservation_detail: mine ? RESERVATION_DETAIL : [],
    ...pctMeta(ctx.date),
  };
});

// ───────── demand gate (Filtered SOQ) — shared by /filtered_soq, /filtered_soq/dropped and /reservation/prefilter ─────────
interface Decision {
  db: string; cfa: string; pdp: boolean; has_below: boolean; combined: boolean; kept: boolean; combined_soq: number;
  truck_cap: number | null; truck_cap_src: string | null; reason: string; cluster: string | null; cluster_reject: boolean;
}
interface DropRow { reg_zsku: string; soq: number; norm: number; soh: number; sit: number; stock: number }
interface Group { d: Decision; rows: DropRow[]; normPct: number; nBelow: number }
const capSrc = (db: Distributor, cluster: string | null) => db.transship
  ? `Transshipment · ${db.truckType}${cluster ? ` (${cluster})` : ''}` : `Lane truck master · ${db.truckType}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// CFA 9001 — every engine lane passed the gate
const KEPT: Group[] = DISTRIBUTORS.map((db) => {
  const dm = DEMAND.filter((x) => x.db === db.code);
  const soq = sum(dm, (x) => x.soq), norm = sum(dm, (x) => x.norm);
  const nBelow = dm.filter((x) => x.dbStock < BELOW_PCT * x.norm).length;
  const pdp = pdpOf(db.code).due || nBelow === 0;   // the gate needs PDP OR below — never leave a kept DB with neither
  const normPct = Math.round((soq / Math.max(1, norm)) * 100);
  const trig = pdp && nBelow ? `PDP-due + ${nBelow} below-threshold` : pdp ? 'PDP-due' : `${nBelow} below-threshold`;
  const reason = `${trig} · ${normPct}% of norm`;
  return {
    d: { db: db.code, cfa: CFA, pdp, has_below: nBelow > 0, combined: true, kept: true, combined_soq: soq, truck_cap: db.truckCap,
      truck_cap_src: capSrc(db, db.cluster), reason, cluster: db.cluster, cluster_reject: false },
    rows: dm.map((x) => ({ reg_zsku: x.rz, soq: x.soq, norm: x.norm, soh: x.dbStock, sit: 0, stock: x.dbStock })),
    normPct, nBelow,
  };
});

// CFA 9002 (satellite) — SOQ groups that fail the gate (or the cluster gate), so 9002 runs no demand of its own
// `pick` = position in DISTRIBUTORS (-1 = a transshipment DB) — chosen by position, never by name or code
const DROP_SPECS: { pick: number; pdp: boolean; below: boolean; target: number; n: number; cluster?: string }[] = [
  { pick: 1, pdp: false, below: false, target: 0.68, n: 9 },
  { pick: 2, pdp: false, below: true, target: 0.42, n: 8 },
  { pick: 4, pdp: true, below: false, target: 0.44, n: 11 },
  { pick: 8, pdp: false, below: false, target: 0.36, n: 7 },
  { pick: -1, pdp: true, below: true, target: 0.66, n: 8, cluster: 'CL-NSK-01' },   // passes the gate, alone in its cluster
];
const dropDbs = new Set<string>();
const DROPPED: Group[] = DROP_SPECS.flatMap((sp, si) => {
  const db = sp.pick >= 0 ? DISTRIBUTORS[sp.pick % DISTRIBUTORS.length]
    : DISTRIBUTORS.find((d) => d.transship && !dropDbs.has(d.code));
  if (!db || dropDbs.has(db.code)) return [];
  dropDbs.add(db.code);
  const r = rng(9002 * 100 + si * 13 + 1);
  const picks = [...REG_ZSKUS].sort(() => r.next() - 0.5).slice(0, sp.n).sort((a, b) => a.rz.localeCompare(b.rz));
  const rows: DropRow[] = picks.map((z, i) => {
    const norm = (bandOf(z) === 1 ? r.int(20, 48) : bandOf(z) === 2 ? r.int(14, 36) : r.int(8, 22));
    const isBelow = sp.below && i < 2;
    let soq: number, stock: number;
    if (isBelow) { stock = Math.round(norm * (0.06 + r.next() * 0.14)); soq = norm - stock; }
    else {
      const t = Math.min(0.72, Math.max(0.1, sp.target * (0.8 + r.next() * 0.4)));   // ≤72% keeps stock ≥ 25% of norm
      soq = Math.max(1, Math.round(norm * t)); stock = Math.max(Math.ceil(norm * 0.27), norm - soq - r.int(0, 2));
    }
    const sit = Math.round(stock * r.next() * 0.35);
    return { reg_zsku: z.rz, soq, norm, soh: stock - sit, sit, stock };
  });
  const soq = sum(rows, (x) => x.soq), norm = sum(rows, (x) => x.norm);
  const nBelow = rows.filter((x) => x.stock < BELOW_PCT * x.norm).length;
  const normPct = Math.round((soq / Math.max(1, norm)) * 100);
  const combined = normPct > 65, trigger = sp.pdp || nBelow > 0;
  const gateOk = trigger && combined;
  const why = !trigger && !combined
    ? `No PDP / below-threshold trigger · combined ${normPct}% of norm ≤ 65%`
    : !trigger ? `No PDP / below-threshold trigger (combined ${normPct}% of norm passes)`
      : !combined ? `${sp.pdp ? 'PDP-due' : `${nBelow} below-threshold`} · combined ${normPct}% of norm ≤ 65%`
        : `Passed the demand gate · cluster ${sp.cluster} has only 1 distributor in the run (needs ≥2 to consolidate a primary truck)`;
  const cluster = sp.cluster ?? null;   // satellite groups never join the hub's transshipment cluster
  return [{
    d: { db: db.code, cfa: ALT_CFA, pdp: sp.pdp, has_below: nBelow > 0, combined, kept: gateOk, combined_soq: soq,
      truck_cap: db.truckCap, truck_cap_src: capSrc(db, cluster), reason: why, cluster, cluster_reject: gateOk && !!sp.cluster },
    rows, normPct, nBelow,
  }];
});
const GROUPS: Group[] = [...KEPT, ...DROPPED];
/** the CFA scope of the gate views: CFA 9001's view includes its satellite 9002 (which has no own demand) */
const inScope = (groupCfa: string, cfa: string) => {
  if (!cfa) return true;
  const c = bareCode(cfa);
  return bareCode(groupCfa) === c || (c === bareCode(CFA) && groupCfa === ALT_CFA);
};
const isKept = (g: Group) => g.d.kept && !g.d.cluster_reject;
function gateSummary(cfa: string) {
  const gs = GROUPS.filter((g) => inScope(g.d.cfa, cfa));
  const kept = gs.filter(isKept), dropped = gs.filter((g) => !g.d.kept), cr = gs.filter((g) => g.d.cluster_reject);
  const reasonKey = (g: Group) => (g.d.cluster_reject ? 'Single-distributor cluster' : g.d.kept
    ? (g.d.pdp && g.d.has_below ? 'PDP-due + below-threshold' : g.d.pdp ? 'PDP-due' : 'Below-threshold')
    : (!g.d.pdp && !g.d.has_below ? 'No PDP / below-threshold trigger' : 'Combined SOQ ≤ 65% of norm'));
  const tally = (xs: Group[]) => xs.reduce<Record<string, number>>((m, g) => { const k = reasonKey(g); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  return {
    groups_total: gs.length, groups_kept: kept.length, groups_dropped: dropped.length, groups_cluster_rejected: cr.length,
    rows_total: sum(gs, (g) => g.rows.length), rows_kept: sum(kept, (g) => g.rows.length),
    cfas_kept: [...new Set(kept.map((g) => g.d.cfa))], dbs_kept: new Set(kept.map((g) => g.d.db)).size,
    kept_reasons: tally(kept), dropped_reasons: tally([...dropped, ...cr]),
  };
}
const GATE_RULE = '( PDP date  OR  a below-threshold reg-zsku )  AND  combined SOQ > 65%';
const knownCfa = (cfa: string) => !cfa || [CFA, ALT_CFA].some((c) => bareCode(c) === bareCode(cfa));

get('/api/v1/filtered_soq', (ctx) => {
  const cfa = (ctx.query.get('cfa') ?? '').trim();
  if (!knownCfa(cfa)) {
    return { date: ctx.date, rule: GATE_RULE, available: false, note: `No filtered SOQ for CFA ${cfa} on ${ctx.date} — it is not in this run.`,
      summary: {}, decision: [], cluster_rejects: [], columns: [], rows: [] };
  }
  const gs = GROUPS.filter((g) => inScope(g.d.cfa, cfa));
  const kept = gs.filter(isKept);
  const columns = ['DB ID', 'CFA', 'reg-zsku', 'Channel', 'SOQ_Case', 'Norm_Qty_Cases', 'Max_Norm', 'PDP', 'Below', 'Comb>65%'];
  const rows = kept.flatMap((g) => {
    const db = dbByCode.get(g.d.db)!;
    return [...g.rows].sort((a, b) => a.reg_zsku.localeCompare(b.reg_zsku)).map((x) => [g.d.db, g.d.cfa, x.reg_zsku, db.channel, x.soq, x.norm, Math.round(x.norm * 1.2),
      g.d.pdp ? 'Y' : 'N', x.stock < BELOW_PCT * x.norm ? 'Y' : 'N', 'Y']);
  });
  return {
    date: ctx.date, data_date: SOQ_DATE[ctx.date] ?? null, rule: GATE_RULE, available: true,
    note: `CFA ${CFA} view includes its satellite CFA ${ALT_CFA} (${ALT_NAME}), whose SOQ groups did not pass the gate.`,
    summary: gateSummary(cfa), decision: gs.map((g) => g.d), cluster_rejects: gs.filter((g) => g.d.cluster_reject).map((g) => g.d),
    columns, rows,
  };
});

get('/api/v1/filtered_soq/dropped', (ctx) => {
  const cfa = (ctx.query.get('cfa') ?? '').trim();
  const q = ctx.query.get('q') ?? '';
  const limit = Math.max(1, Math.min(200, Number(ctx.query.get('limit')) || 20));
  const offset = Math.max(0, Number(ctx.query.get('offset')) || 0);
  const all = GROUPS.filter((g) => !isKept(g) && inScope(g.d.cfa, cfa)).map((g) => {
    const db = dbByCode.get(g.d.db)!;
    return {
      db: g.d.db, db_name: db.name, cfa: g.d.cfa, gate: g.d.cluster_reject ? 'cluster' : 'demand', reason: g.d.reason, cluster: g.d.cluster,
      combined: { soq: sum(g.rows, (x) => x.soq), norm: sum(g.rows, (x) => x.norm), soh: sum(g.rows, (x) => x.soh),
        sit: sum(g.rows, (x) => x.sit), stock: sum(g.rows, (x) => x.stock) },
      rows: g.rows,
    };
  });
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (x: typeof all[number]) => [x.db, bareCode(x.db), x.db_name, dbByCode.get(x.db)?.city ?? '', x.cfa, x.gate, x.reason, x.cluster ?? '',
    ...x.rows.flatMap((r) => [r.reg_zsku, rzByCode.get(r.reg_zsku)?.desc ?? ''])].join(' ').toLowerCase();
  const hits = terms.length ? all.filter((x) => { const h = hay(x); return terms.every((t) => h.includes(t)); }) : all;
  return {
    date: ctx.date, data_date: SOQ_DATE[ctx.date] ?? ctx.date, cfa: cfa || null, q, count: hits.length, limit, offset,
    dropped: hits.slice(offset, offset + limit),
  };
});

// ───────── /reservation/prefilter — pre-processing stages A → E ─────────
const CHANNEL_MAP: Record<string, { cust: string; sap: string; sub: string }> = {
  'Non-PACE': { cust: 'Distributor', sap: '10 · General Trade', sub: 'D07 · Non-PACE' },
  Retail: { cust: 'Distributor', sap: '20 · Modern Retail', sub: 'D12 · Retail' },
};
function intakeOf(gs: Group[]) {
  const scoped = gs.filter((g) => g.d.cfa === CFA || g.d.cfa === ALT_CFA);
  const kept = scoped.filter(isKept);
  const dropped = scoped.length - kept.length;
  return {
    pdp: kept.filter((g) => g.d.pdp).length, below: kept.filter((g) => g.d.has_below).length,
    combined: kept.filter((g) => g.d.pdp || g.d.has_below).length, final: kept.length,
    note: dropped ? `${plural(dropped, '(DB, CFA) group')} at satellite CFA ${ALT_CFA} did not pass — see Filtered SOQ` : undefined,
  };
}
function prefilterPayload(date: string) {
  const channels = RUNS.map((run) => {
    const dbs = DISTRIBUTORS.filter((d) => d.run === run.run).length;
    return { channel: run.channel, dbs, run: run.run, b1: run.pct, b2: run.pct, b3: run.pct, combined: run.pct };
  });
  const db_channel_map = {
    cols: ['DB ID', 'CFA', 'DB Name', 'City', 'Customer Type', 'SAP Channel', 'Sub-Channel', 'Allocation Channel'],
    rows: DISTRIBUTORS.map((d) => {
      const m = CHANNEL_MAP[d.channel] ?? { cust: 'Distributor', sap: '—', sub: '—' };
      return [d.code, CFA, d.name, d.city, m.cust, m.sap, d.transship ? `${m.sub} (transshipment)` : m.sub, d.channel];
    }),
  };
  const cfa_reservation = {
    cols: ['reg-zsku', 'Band', 'Physical', ...RUNS.map((r) => r.channel)],
    rows: REG_ZSKUS.filter((z) => z.cfaStock > 0).map((z) =>
      [z.rz, `Band ${bandOf(z)}`, z.cfaStock, ...RUNS.map((_, i) => cellOf(z.rz, i).earmark)] as (string | number)[]),
  };
  // Stage D — pre-built ranked substitutes (same category, EXACT MRP, CFA holds stock) per DB × demanded reg-zsku
  const subRows: (string | number)[][] = [];
  const filRows: (string | number)[][] = [];
  for (const l of LANES) {
    for (const x of l.lines) {
      if (x.soq <= 0) continue;
      const z = rzByCode.get(x.rz)!;
      const cands = REG_ZSKUS.filter((c) => c.rz !== z.rz && c.category === z.category && c.mrp === z.mrp && c.cfaStock > 0)
        .sort((a, b) => b.cfaStock - a.cfaStock).slice(0, 3);
      if (cands.length) subRows.push([l.db.code, CFA, `T${l.db.tier}`, l.run, x.rz, cands.length, `₹${z.mrp}`, cands.map((c) => c.rz).join(' › ')]);
    }
    const fz = l.fillerCalc.map((f) => f.z);
    if (fz.length) filRows.push([l.db.code, CFA, `T${l.db.tier}`, l.run, fz.length, fz.join(' › ')]);
  }
  const substitutes = { cols: ['DB ID', 'CFA', 'Tier', 'Run', 'reg-zsku', '# Subs', 'MRP', 'Substitutes (ranked)'], rows: subRows };
  const fillers = { cols: ['DB ID', 'CFA', 'Tier', 'Run', '# Fillers', 'Fillers (ranked)'], rows: filRows };
  const runs = RUNS.map((run, i) => {
    const byBand = (b: number) => sum(REG_ZSKUS.filter((z) => bandOf(z) === b), (z) => cellOf(z.rz, i).earmark);
    const sr = subRows.filter((r) => r[3] === run.run), fr = filRows.filter((r) => r[3] === run.run);
    return {
      run: run.run, channel: run.channel, dbs: DISTRIBUTORS.filter((d) => d.run === run.run).length,
      cfa_b1: byBand(1), cfa_b2: byBand(2), cfa_b3: byBand(3), cfa_reserved: sum(REG_ZSKUS, (z) => cellOf(z.rz, i).earmark),
      sub_dbs: new Set(sr.map((r) => r[0])).size, sub_lines: sr.length, sub_items: sum(sr, (r) => Number(r[5])),
      filler_dbs: new Set(fr.map((r) => r[0])).size, filler_items: sum(fr, (r) => Number(r[4])),
    };
  });
  const intake = intakeOf(GROUPS), fss = gateSummary(CFA);
  return {
    date, cfas: [CFA], run_cfa: CFA,
    soq_intake: intake, soq_intake_by_cfa: { [CFA]: intake },
    filtered_soq_summary: gateSummary(''), filtered_soq_summary_by_cfa: { [CFA]: fss },
    channels, channels_by_cfa: { [CFA]: channels },
    db_channel_map, cfa_reservation, cfa_reservation_by_cfa: { [CFA]: cfa_reservation },
    substitutes, fillers, runs, runs_by_cfa: { [CFA]: runs },
    ...pctMeta(date),
  };
}
get('/api/v1/reservation/prefilter', (ctx) => prefilterPayload(ctx.date));
