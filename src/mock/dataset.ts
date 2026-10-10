// dataset.ts — the ONE synthetic universe every demo endpoint is built from, so numbers agree across pages:
// 1 CFA · 10 distributors · 40 reg-zskus · 2 cascade runs. Everything is deterministic (seeded) and computed once.
//
// The allocation here is a SIMPLIFIED replica of the engine, just enough to make every screen coherent:
//   Step 1  Original   — run pool (reserved % of CFA stock) water-filled across DBs by SOQ × tier weight
//   Step 2  Substitute — a short line borrows from a same-category reg-zsku that still has pool left
//   Step 3  Filler     — the lane's spare truck room is topped up from filler-eligible reg-zskus (35% add-on, 1.2×norm caps)
//   Truck rule         — a last truck < 65% full is trimmed (tail cascades); a lane that can't fill one truck is dropped
//   Cluster primary    — transshipment DBs are combined onto ACE primary trucks; a short primary tail is trimmed
//   SO disposition     — Original ÷ SOQ ≥ 50% → SO_CREATION (or RLM_TRUCK_APPROVAL if the lane dropped), else RLM_FOR_SECOND_CFA

// ───────────────────────── seeded RNG ─────────────────────────
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),   // inclusive
    pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}
const R = rng(20261010);

// ───────────────────────── run dates ─────────────────────────
// run date = DD-Mon-YYYY (day NOT zero-padded — the PdartDatePicker format); SOQ snapshot date = DD-MM-YYYY (the day before)
export const RUN_DATES = ['8-Oct-2026', '9-Oct-2026', '10-Oct-2026'];
export const LATEST_DATE = RUN_DATES[RUN_DATES.length - 1];
export const SOQ_DATE: Record<string, string> = {
  '8-Oct-2026': '07-10-2026', '9-Oct-2026': '08-10-2026', '10-Oct-2026': '09-10-2026',
};
export const RUN_TIMESTAMP: Record<string, string> = {   // when each run finished (ISO, IST)
  '8-Oct-2026': '2026-10-08T06:42:10+05:30', '9-Oct-2026': '2026-10-09T06:39:55+05:30', '10-Oct-2026': '2026-10-10T06:41:27+05:30',
};

// ───────────────────────── CFA / plants ─────────────────────────
export const CFA = '9001';
export const CFA_NAME = 'Pune Central CFA';
export const REGION = 'MH';
export const ALT_CFA = '9002';   // the alternate CFA a <50% DB is shifted to (has stock, no own demand)
export const PLANTS = [
  { plant: CFA, name: CFA_NAME, region: REGION, city: 'Pune', has_demand: true, has_inventory: true },
  { plant: ALT_CFA, name: 'Nashik Satellite CFA', region: REGION, city: 'Nashik', has_demand: false, has_inventory: true },
];

// ───────────────────────── engine parameters (oe_parameters) ─────────────────────────
export const OE_PARAM_DEFS = [
  { key: 'DEFAULT_TIER', value: 4, default: 4, description: 'Tier assigned to a distributor missing from the tier master' },
  { key: 'ADDON_CAP_PCT', value: 0.35, default: 0.35, description: 'Max substitute + filler add-on as a share of the DB\'s SOQ' },
  { key: 'NORM_MULTIPLIER', value: 1.2, default: 1.2, description: 'Room cap: stock + allocation may not exceed this × norm' },
  { key: 'TRUCK_KEEP_PCT', value: 0.65, default: 0.65, description: 'A truck below this fill is trimmed / the lane is dropped' },
  { key: 'TRUCK_FILL_TARGET_PCT', value: 0.9, default: 0.9, description: 'Target fill the filler step tops each truck up to' },
  { key: 'SO_CREATION_ORIGINAL_FLOOR_PCT', value: 0.5, default: 0.5, description: 'Original ÷ SOQ at/above this → SO creation; below → RLM 2nd CFA' },
  { key: 'SO_CREATION_TRUCK_FILL_PCT', value: 0.9, default: 0.9, description: 'Truck fill needed for direct SO creation without RLM approval' },
];
const ADDON = 0.35, NORM_X = 1.2, KEEP = 0.65;

// ───────────────────────── distributors (10) ─────────────────────────
export type Channel = 'Non-PACE' | 'Retail';
export interface Distributor {
  code: string;          // 10-char zero-padded DB code
  name: string;
  city: string;
  channel: Channel;
  tier: number;          // 1 (best) .. 3
  run: number;           // the cascade run that serves this channel
  truckCap: number;      // lane truck capacity, cases
  truckType: string;
  transship: boolean;    // ships on a transshipment secondary truck
  cluster: string | null;
  gstin: string;
  salesOffice: string;
}
const DB_SEED: [string, string, Channel, number, number, string][] = [
  ['Shree Ganesh Traders', 'Pune', 'Non-PACE', 1, 800, '19-20 FT Container'],
  ['Om Sai Distributors', 'Pimpri', 'Non-PACE', 2, 600, '17 FT Container'],
  ['Vighnaharta Enterprises', 'Chakan', 'Non-PACE', 2, 600, '17 FT Container'],
  ['Laxmi Agencies', 'Hadapsar', 'Non-PACE', 3, 800, '19-20 FT Container'],
  ['Ashtavinayak Trading Co', 'Lonavala', 'Non-PACE', 1, 800, '19-20 FT Container'],
  ['Sahyadri Retail Supply', 'Kothrud', 'Retail', 1, 800, '19-20 FT Container'],
  ['Deccan Consumer Goods', 'Wakad', 'Retail', 2, 600, '17 FT Container'],
  ['Mahalaxmi Marketing', 'Baramati', 'Retail', 3, 300, 'ACE Container'],
  ['Krishna Wholesale', 'Satara', 'Retail', 2, 300, 'ACE Container'],
  ['Jai Bhavani Supply', 'Karad', 'Retail', 3, 300, 'ACE Container'],
];
export const DISTRIBUTORS: Distributor[] = DB_SEED.map(([name, city, channel, tier, cap, tt], i) => ({
  code: String(710001 + i).padStart(10, '0'),
  name, city, channel, tier,
  run: channel === 'Non-PACE' ? 1 : 2,
  truckCap: cap, truckType: tt,
  transship: tt === 'ACE Container',
  cluster: tt === 'ACE Container' ? 'CL-PUN-01' : null,
  gstin: `27AAB${'CDEFGHIJKL'[i]}${1000 + i * 37}M1Z${i}`,
  salesOffice: city === 'Pune' || city === 'Pimpri' || city === 'Kothrud' || city === 'Wakad' || city === 'Hadapsar' ? 'Pune City' : 'Pune Rural',
}));
export const dbByCode = new Map(DISTRIBUTORS.map((d) => [d.code, d]));
export const bareCode = (c: unknown) => String(c ?? '').replace(/\D/g, '').replace(/^0+/, '');
export const findDb = (c: unknown) => DISTRIBUTORS.find((d) => bareCode(d.code) === bareCode(c));
const TIER_W: Record<number, number> = { 1: 1.2, 2: 1.0, 3: 0.8, 4: 0.6 };
export const tierWeight = (t: number) => TIER_W[t] ?? 0.6;

// ───────────────────────── reg-zskus (40) ─────────────────────────
export interface SkuVariant {
  sku: string;           // SAP material code — THE SKU id on the order
  desc: string;
  batch: string;
  daysToExpiry: number;
  mrp: number;
  unitsPerCase: number;
  isPdp: string;         // 'Y' | 'N' — product-date-priority batch
}
export interface RegZsku {
  rz: string;            // reg-zsku: <zsku>-<region>
  zsku: string;
  desc: string;          // old_material_description
  brand: string;
  category: string;      // AIDEN category
  band: 'Band 1' | 'Band 2' | 'Band 3';
  mrp: number;
  packG: number;
  unitsPerCase: number;
  isFiller: boolean;     // eligible as a Step-3 filler
  cfaStock: number;      // sellable CFA stock (cases) on the run date
  skus: SkuVariant[];
}
const CATALOG: [string, string, string, number, number][] = [
  // brand, product, AIDEN category, MRP, pack grams
  ['Crunchies', 'Classic Salted', 'Potato Chips', 20, 52], ['Crunchies', 'Magic Masala', 'Potato Chips', 20, 52],
  ['Crunchies', 'Cream & Onion', 'Potato Chips', 20, 52], ['Crunchies', 'Classic Salted', 'Potato Chips', 50, 115],
  ['Crunchies', 'Magic Masala', 'Potato Chips', 50, 115], ['Crunchies', 'Tomato Tango', 'Potato Chips', 10, 27],
  ['Crunchies', 'Chile Lemon', 'Potato Chips', 10, 27], ['Crunchies', 'Peri Peri', 'Potato Chips', 30, 82],
  ['Kurlz', 'Masala Munch', 'Extruded Snacks', 10, 32], ['Kurlz', 'Cheese Balls', 'Extruded Snacks', 10, 30],
  ['Kurlz', 'Masala Munch', 'Extruded Snacks', 20, 70], ['Kurlz', 'Tangy Tomato', 'Extruded Snacks', 20, 70],
  ['Kurlz', 'Puffcorn Butter', 'Extruded Snacks', 10, 28], ['Kurlz', 'Cheese Balls', 'Extruded Snacks', 35, 120],
  ['Desi Mix', 'Aloo Bhujia', 'Namkeen', 10, 39], ['Desi Mix', 'Navratan Mix', 'Namkeen', 10, 39],
  ['Desi Mix', 'Aloo Bhujia', 'Namkeen', 55, 200], ['Desi Mix', 'Moong Dal', 'Namkeen', 10, 35],
  ['Desi Mix', 'Khatta Meetha', 'Namkeen', 45, 180], ['Desi Mix', 'Bikaneri Bhujia', 'Namkeen', 99, 400],
  ['Nacho Craze', 'Cheese Nachos', 'Corn Chips', 20, 55], ['Nacho Craze', 'Sweet Chilli', 'Corn Chips', 20, 55],
  ['Nacho Craze', 'Cheese Nachos', 'Corn Chips', 50, 150], ['Nacho Craze', 'Salsa Dip', 'Corn Chips', 99, 175],
  ['FizzUp', 'Cola', 'Carbonated Drinks', 40, 750], ['FizzUp', 'Lemon Lime', 'Carbonated Drinks', 40, 750],
  ['FizzUp', 'Orange', 'Carbonated Drinks', 20, 250], ['FizzUp', 'Cola', 'Carbonated Drinks', 95, 2250],
  ['FizzUp', 'Cola Zero', 'Carbonated Drinks', 40, 300], ['FizzUp', 'Lemon Lime', 'Carbonated Drinks', 20, 250],
  ['Orchard Gold', 'Mango Delight', 'Juices', 20, 200], ['Orchard Gold', 'Mixed Fruit', 'Juices', 99, 1000],
  ['Orchard Gold', 'Guava', 'Juices', 20, 200], ['Orchard Gold', 'Mango Delight', 'Juices', 110, 1200],
  ['VoltX', 'Original Energy', 'Energy Drinks', 60, 250], ['VoltX', 'Berry Blast', 'Energy Drinks', 60, 250],
  ['VoltX', 'Sugar Free', 'Energy Drinks', 99, 350], ['MorningOats', 'Masala Oats', 'Oats & Cereal', 15, 38],
  ['MorningOats', 'Classic Oats', 'Oats & Cereal', 199, 1000], ['MorningOats', 'Honey Muesli', 'Oats & Cereal', 299, 500],
];
const isDrink = (cat: string) => /Drink|Juice/.test(cat);
export const REG_ZSKUS: RegZsku[] = CATALOG.map(([brand, prod, cat, mrp, g], i) => {
  const zsku = String(61001 + i * 7);
  const size = isDrink(cat) ? (g >= 1000 ? `${g / 1000}L` : `${g}ml`) : (g >= 1000 ? `${g / 1000}kg` : `${g}g`);
  const desc = `${brand} ${prod} ${size} MRP ${mrp}`;
  const upc = mrp <= 10 ? 96 : mrp <= 20 ? 48 : mrp <= 60 ? 24 : 12;
  const nVar = R.chance(0.35) ? 2 : 1;
  const skus: SkuVariant[] = Array.from({ length: nVar }, (_, v) => ({
    sku: String(300000000 + (61001 + i * 7) * 10 + v),
    desc: v === 0 ? desc.toUpperCase() : `${desc.toUpperCase()} (NEW PACK)`,
    batch: `B26${String(R.int(1001, 9899))}`,
    daysToExpiry: v === 0 ? R.int(25, 160) : R.int(120, 220),
    mrp, unitsPerCase: upc,
    isPdp: v === 0 && R.chance(0.2) ? 'Y' : 'N',
  }));
  return {
    rz: `${zsku}-${REGION}`, zsku, desc, brand, category: cat,
    band: i % 10 < 3 ? 'Band 1' : i % 10 < 7 ? 'Band 2' : 'Band 3',
    mrp, packG: g, unitsPerCase: upc,
    isFiller: !isDrink(cat) && mrp <= 20,
    cfaStock: 0,   // set below once demand is known
    skus,
  };
});
export const rzByCode = new Map(REG_ZSKUS.map((z) => [z.rz, z]));
export const findRz = (q: unknown) => {
  const s = String(q ?? '').trim();
  return rzByCode.get(s) ?? REG_ZSKUS.find((z) => z.zsku === s || z.rz.toLowerCase() === s.toLowerCase());
};

// ───────────────────────── runs (cascade) ─────────────────────────
export interface RunDef { run: number; channel: Channel; pct: number; band: string; bandDesc: string; label: string }
export const RUNS: RunDef[] = [
  { run: 1, channel: 'Non-PACE', pct: 55, band: '1+2', bandDesc: 'fast + medium movers', label: 'Run 1 · Non-PACE' },
  { run: 2, channel: 'Retail', pct: 45, band: '1+2+3', bandDesc: 'all movers incl. leftover', label: 'Run 2 · Retail' },
];

// ───────────────────────── demand (SOQ) + norms ─────────────────────────
// SCARCE reg-zskus have little stock → fair share, substitutes and a <50% DB. DB #7 (Deccan) leans on them.
const SCARCE = new Set([1, 4, 9, 17, 22, 26, 31, 36].map((i) => REG_ZSKUS[i].rz));
export interface Demand { db: string; rz: string; soq: number; norm: number; dbStock: number }
export const DEMAND: Demand[] = [];
DISTRIBUTORS.forEach((d, di) => {
  const scale = d.tier === 1 ? 1.35 : d.tier === 2 ? 1.0 : 0.7;
  const small = d.code.endsWith('04');            // Laxmi — too small to fill one truck → dropped lane (RLM truck approval)
  const leansScarce = d.code.endsWith('07');      // Deccan — <50% original fill → RLM 2nd CFA
  const n = small ? 14 : d.transship ? 18 : R.int(24, 30);
  const pool = leansScarce
    ? [...REG_ZSKUS.filter((z) => SCARCE.has(z.rz)), ...REG_ZSKUS.filter((z) => !SCARCE.has(z.rz)).slice(0, 1)]
    : [...REG_ZSKUS].sort(() => R.next() - 0.5).slice(0, n);
  for (const z of pool) {
    const base = z.band === 'Band 1' ? R.int(30, 70) : z.band === 'Band 2' ? R.int(14, 40) : R.int(6, 22);
    const soq = Math.max(4, Math.round(base * scale * (small ? 0.55 : d.transship ? 0.62 : 1) * (isDrink(z.category) ? 0.8 : 1)));
    const norm = Math.round(soq * (1.15 + R.next() * 0.4));
    const dbStock = Math.max(0, Math.round(norm - soq - R.int(0, 6)));
    DEMAND.push({ db: d.code, rz: z.rz, soq, norm, dbStock });
  }
  void di;
});
// CFA stock: ample for most (0.9–1.6× total SOQ), thin for SCARCE, zero for one
for (const z of REG_ZSKUS) {
  const tot = DEMAND.filter((x) => x.rz === z.rz).reduce((s, x) => s + x.soq, 0);
  z.cfaStock = SCARCE.has(z.rz) ? Math.round(tot * 0.28) : Math.round(Math.max(40, tot) * (0.95 + R.next() * 0.7));
}
REG_ZSKUS[36].cfaStock = 0;   // one reg-zsku fully out of stock (shows "no stock" reasons)

// ───────────────────────── allocation ─────────────────────────
export interface SubPick { forRz: string; subRz: string; cases: number }
export interface FillerPick {
  z: string; name: string; rank: number; norm: number; max: number; onhand: number; step1: number; sub: number;
  room: number; addon: number; truck: number; pool: number; alloc: number; poolAfter: number; reason: string;
}
export interface Line {
  db: string; rz: string;
  soq: number; norm: number; maxNorm: number; dbStock: number; cfaStock: number;
  orig: number;          // Step-1 original (as allocated)
  sub: number;           // cases of THIS reg-zsku shipped as a substitute for other lines
  subFor: string;        // "61008-MH:12, …" the lines it substituted for
  subGot: number;        // cases OTHER reg-zskus shipped to cover THIS line's shortfall
  filler: number;        // Step-3 filler cases of this reg-zsku
  // post truck-rule / cluster trim (what actually ships)
  shipOrig: number; shipSub: number; shipFil: number;
  priorityBefore: number; priorityAfter: number; snBefore: number; snAfter: number;
  requiredM: number; valueM: number; binding: boolean;
}
export interface LoadSku {
  rz: string; sku: string; cases: number; units: number; mrp: number; batch: string; daysToExpiry: number;
  isSub: 0 | 1; isFiller: 0 | 1; desc: string; isPdp: string;
}
export interface Load { no: number; cases: number; planned: number; truckid: string; order: string; skus: LoadSku[] }
export type SoFlag = 'SO_CREATION' | 'RLM_TRUCK_APPROVAL' | 'RLM_FOR_SECOND_CFA';
export interface Lane {
  db: Distributor;
  run: number;
  lines: Line[];
  soq: number; orig: number; sub: number; filler: number;
  planned: number;       // orig+sub+filler before the truck rule / cluster trim
  shipped: number;       // what actually ships
  trucks: number;        // physical trucks shipped
  fillPct: number;       // shipped ÷ (trucks × cap)
  origFillPct: number;   // orig ÷ soq %
  combinedFillPct: number;   // shipped ÷ soq %
  dropped: boolean; dropOrig: number; dropSub: number; dropFil: number;
  cascaded: number;      // truck-tail cases cascaded to the next run
  clusterTrim: number;   // cases trimmed by the cluster primary pass
  soFlag: SoFlag;
  priority: number; rank: number; sumNorm: number; sumHeld: number;
  fillerCalc: FillerPick[];
  loads: Load[];
}
export interface RunResult {
  run: RunDef;
  reserved: Record<string, number>;   // rz → pool reserved for this run
  leftover: Record<string, number>;   // rz → pool left after this run
  lanes: Lane[];
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

// integer water-fill: share `pool` across items by weight, each capped at its demand
function waterFill(pool: number, items: { key: string; demand: number; weight: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  items.forEach((it) => { out[it.key] = 0; });
  let left = pool;
  let open = items.filter((it) => it.demand > 0);
  while (left > 0 && open.length) {
    const W = open.reduce((s, it) => s + it.weight, 0);
    let given = 0;
    for (const it of open) {
      const want = it.demand - out[it.key];
      const share = Math.min(want, Math.floor((left * it.weight) / W));
      out[it.key] += share; given += share;
    }
    left -= given;
    open = open.filter((it) => out[it.key] < it.demand);
    if (given === 0) {   // hand the indivisible remainder out one case at a time, heaviest first
      for (const it of [...open].sort((a, b) => b.weight - a.weight)) { if (left <= 0) break; out[it.key] += 1; left -= 1; }
      open = open.filter((it) => out[it.key] < it.demand);
    }
  }
  return out;
}

let orderSeq = 4500231100, truckSeq = 1;
function buildRun(run: RunDef, poolIn: Record<string, number>): RunResult {
  const dbs = DISTRIBUTORS.filter((d) => d.run === run.run);
  const reserved: Record<string, number> = {};
  for (const z of REG_ZSKUS) reserved[z.rz] = run.run === 1 ? Math.floor(z.cfaStock * run.pct / 100) : poolIn[z.rz];
  const pool = { ...reserved };
  const lanes: Lane[] = dbs.map((db) => ({
    db, run: run.run, lines: [], soq: 0, orig: 0, sub: 0, filler: 0, planned: 0, shipped: 0, trucks: 0, fillPct: 0,
    origFillPct: 0, combinedFillPct: 0, dropped: false, dropOrig: 0, dropSub: 0, dropFil: 0, cascaded: 0, clusterTrim: 0,
    soFlag: 'SO_CREATION', priority: 0, rank: 0, sumNorm: 0, sumHeld: 0, fillerCalc: [], loads: [],
  }));
  const laneOf = new Map(lanes.map((l) => [l.db.code, l]));
  const lineOf = (lane: Lane, rz: string): Line => {
    let ln = lane.lines.find((x) => x.rz === rz);
    if (!ln) {
      const z = rzByCode.get(rz)!;
      ln = { db: lane.db.code, rz, soq: 0, norm: 0, maxNorm: 0, dbStock: 0, cfaStock: z.cfaStock, orig: 0, sub: 0, subFor: '',
        subGot: 0, filler: 0, shipOrig: 0, shipSub: 0, shipFil: 0, priorityBefore: 0, priorityAfter: 0, snBefore: 0, snAfter: 0,
        requiredM: 0, valueM: 0, binding: false };
      lane.lines.push(ln);
    }
    return ln;
  };
  for (const dm of DEMAND.filter((x) => laneOf.has(x.db))) {
    const ln = lineOf(laneOf.get(dm.db)!, dm.rz);
    ln.soq = dm.soq; ln.norm = dm.norm; ln.maxNorm = Math.round(dm.norm * NORM_X); ln.dbStock = dm.dbStock;
  }

  // Step 1 — original: per reg-zsku water-fill by SOQ × tier weight
  for (const z of REG_ZSKUS) {
    const ls = lanes.flatMap((l) => l.lines.filter((x) => x.rz === z.rz && x.soq > 0));
    if (!ls.length) continue;
    const alloc = waterFill(pool[z.rz], ls.map((x) => ({ key: x.db, demand: x.soq, weight: x.soq * tierWeight(dbByCode.get(x.db)!.tier) })));
    for (const x of ls) {
      x.orig = alloc[x.db];
      x.snBefore = round2(x.dbStock / Math.max(1, x.norm));
      x.snAfter = round2((x.dbStock + x.orig) / Math.max(1, x.norm));
      x.priorityBefore = round2((1 - x.snBefore) * tierWeight(dbByCode.get(x.db)!.tier));
      x.priorityAfter = round2((1 - x.snAfter) * tierWeight(dbByCode.get(x.db)!.tier));
      x.requiredM = Math.max(0, x.norm - x.dbStock);
      x.valueM = x.orig;
      x.binding = x.orig < x.soq;
      pool[z.rz] -= x.orig;
    }
  }
  // Step 2 — substitute: a short line borrows from a same-category reg-zsku with pool left (≤ 35% add-on budget)
  for (const lane of lanes) {
    let addonLeft = Math.floor(lane.lines.reduce((s, x) => s + x.soq, 0) * ADDON);
    for (const x of [...lane.lines].filter((l) => l.soq > l.orig).sort((a, b) => (b.soq - b.orig) - (a.soq - a.orig))) {
      const cat = rzByCode.get(x.rz)!.category;
      const cand = REG_ZSKUS.filter((z) => z.category === cat && z.rz !== x.rz && pool[z.rz] > 0)
        .sort((a, b) => pool[b.rz] - pool[a.rz])[0];
      if (!cand || addonLeft <= 0) continue;
      const take = Math.min(x.soq - x.orig, pool[cand.rz], addonLeft);
      if (take <= 0) continue;
      const s = lineOf(lane, cand.rz);
      s.sub += take; s.subFor = s.subFor ? `${s.subFor}, ${x.rz}:${take}` : `${x.rz}:${take}`;
      x.subGot += take; pool[cand.rz] -= take; addonLeft -= take;
    }
  }
  // draw priority for the shared filler pool: (Σnorm ÷ Σheld) × tier weight — highest draws first
  for (const lane of lanes) {
    lane.sumNorm = lane.lines.reduce((s, x) => s + x.norm, 0);
    lane.sumHeld = lane.lines.reduce((s, x) => s + x.dbStock + x.orig + x.sub, 0);
    lane.priority = round2((lane.sumNorm / Math.max(1, lane.sumHeld)) * tierWeight(lane.db.tier));
  }
  [...lanes].sort((a, b) => b.priority - a.priority).forEach((l, i) => { l.rank = i + 1; });
  // Step 3 — filler: top the lane's last truck up to the fill target from filler-eligible reg-zskus
  for (const lane of [...lanes].sort((a, b) => a.rank - b.rank)) {
    const cap = lane.db.truckCap;
    const base = lane.lines.reduce((s, x) => s + x.orig + x.sub, 0);
    const trucksNeeded = Math.max(1, Math.ceil(base / cap));
    let truckRoom = Math.max(0, Math.round(trucksNeeded * cap * 0.97) - base);
    let addonLeft = Math.max(0, Math.floor(lane.lines.reduce((s, x) => s + x.soq, 0) * ADDON) - lane.lines.reduce((s, x) => s + x.sub, 0));
    const fillers = REG_ZSKUS.filter((z) => z.isFiller).sort((a, b) => pool[b.rz] - pool[a.rz]);
    let rank = 0;
    for (const z of fillers) {
      rank += 1;
      const dm = DEMAND.find((d) => d.db === lane.db.code && d.rz === z.rz);
      const norm = dm?.norm ?? Math.round(z.unitsPerCase / 4 + 20);
      const onhand = dm?.dbStock ?? Math.round(norm * 0.4);
      const ex = lane.lines.find((x) => x.rz === z.rz);
      const step1 = ex?.orig ?? 0, sub = ex?.sub ?? 0;
      const max = Math.round(norm * NORM_X);
      const room = Math.max(0, max - onhand - step1 - sub);
      const poolNow = pool[z.rz];
      const alloc = Math.max(0, Math.min(truckRoom, poolNow, room, addonLeft));
      const reason = alloc === truckRoom ? 'truck room' : alloc === poolNow ? 'CFA pool' : alloc === room ? '1.2×Norm room' : '35% add-on';
      lane.fillerCalc.push({ z: z.rz, name: z.desc, rank, norm, max, onhand, step1, sub, room, addon: addonLeft, truck: truckRoom,
        pool: poolNow, alloc, poolAfter: poolNow - alloc, reason: truckRoom <= 0 ? 'truck full' : reason });
      if (alloc > 0) {
        const f = lineOf(lane, z.rz);
        if (!dm) { f.norm = norm; f.maxNorm = max; f.dbStock = onhand; }
        f.filler += alloc; pool[z.rz] -= alloc; truckRoom -= alloc; addonLeft -= alloc;
      }
      if (lane.fillerCalc.length >= 8) break;
    }
  }
  // totals + truck rule
  for (const lane of lanes) {
    const cap = lane.db.truckCap;
    lane.soq = lane.lines.reduce((s, x) => s + x.soq, 0);
    lane.orig = lane.lines.reduce((s, x) => s + x.orig, 0);
    lane.sub = lane.lines.reduce((s, x) => s + x.sub, 0);
    lane.filler = lane.lines.reduce((s, x) => s + x.filler, 0);
    lane.planned = lane.orig + lane.sub + lane.filler;
    lane.origFillPct = round1((lane.orig / Math.max(1, lane.soq)) * 100);
    lane.lines.forEach((x) => { x.shipOrig = x.orig; x.shipSub = x.sub; x.shipFil = x.filler; });
    const full = Math.floor(lane.planned / cap), tail = lane.planned - full * cap;
    if (tail / cap >= KEEP) { lane.trucks = full + 1; }
    else if (full >= 1) { lane.trucks = full; lane.cascaded = tail; trimLane(lane, tail); }
    else {   // can't fill one truck → whole lane dropped (cascades)
      lane.dropped = true; lane.trucks = 0;
      lane.dropOrig = lane.orig; lane.dropSub = lane.sub; lane.dropFil = lane.filler;
      lane.lines.forEach((x) => { x.shipOrig = 0; x.shipSub = 0; x.shipFil = 0; });
    }
    for (const x of lane.lines) pool[x.rz] += (x.orig - x.shipOrig) + (x.sub - x.shipSub) + (x.filler - x.shipFil);
  }
  return { run, reserved, leftover: pool, lanes };
}

// trim `cases` off a lane: filler first, then substitute, then original from the lowest-priority lines
function trimLane(lane: Lane, cases: number) {
  let left = cases;
  for (const key of ['shipFil', 'shipSub', 'shipOrig'] as const) {
    for (const x of [...lane.lines].sort((a, b) => a.priorityAfter - b.priorityAfter || b[key] - a[key])) {
      if (left <= 0) return;
      const t = Math.min(x[key], left); x[key] -= t; left -= t;
    }
  }
}

const run1 = buildRun(RUNS[0], {});
const run2 = buildRun(RUNS[1], (() => {   // run 2 gets its 45% plus everything run 1 left behind
  const p: Record<string, number> = {};
  for (const z of REG_ZSKUS) p[z.rz] = Math.floor(z.cfaStock * RUNS[1].pct / 100) + Math.max(0, run1.leftover[z.rz]);
  for (const z of REG_ZSKUS) p[z.rz] = Math.min(p[z.rz], z.cfaStock - (run1.reserved[z.rz] - run1.leftover[z.rz]));
  return p;
})());
export const RUN_RESULTS: RunResult[] = [run1, run2];
export const LANES: Lane[] = [...run1.lanes, ...run2.lanes];
export const laneByDb = new Map(LANES.map((l) => [l.db.code, l]));

// ───────────────────────── cluster primary (transshipment) ─────────────────────────
export const PRIMARY_CAP = 600;
export interface ClusterResult {
  code: string; dbs: string[]; combined: number; primaryCap: number; fullTrucks: number; primaryTrucks: number;
  ships: number; trimmed: number; perDb: { db: string; built: number; trimmed: number; ships: number }[];
}
export const CLUSTERS: ClusterResult[] = (() => {
  const codes = [...new Set(DISTRIBUTORS.filter((d) => d.cluster).map((d) => d.cluster!))];
  return codes.map((code) => {
    const lanes = LANES.filter((l) => l.db.cluster === code && !l.dropped);
    const built = lanes.map((l) => l.lines.reduce((s, x) => s + x.shipOrig + x.shipSub + x.shipFil, 0));
    const combined = built.reduce((s, x) => s + x, 0);
    const full = Math.floor(combined / PRIMARY_CAP), tail = combined - full * PRIMARY_CAP;
    const keepTail = tail / PRIMARY_CAP >= KEEP || full === 0;
    const trimmed = keepTail ? 0 : tail;
    const shares = waterFill(trimmed, lanes.map((l, i) => ({ key: l.db.code, demand: built[i], weight: built[i] })));
    const perDb = lanes.map((l, i) => {
      const t = shares[l.db.code] ?? 0;
      if (t > 0) { trimLane(l, t); l.clusterTrim = t; }
      return { db: l.db.code, built: built[i], trimmed: t, ships: built[i] - t };
    });
    return { code, dbs: lanes.map((l) => l.db.code), combined, primaryCap: PRIMARY_CAP, fullTrucks: full,
      primaryTrucks: keepTail ? full + 1 : full, ships: combined - trimmed, trimmed, perDb };
  });
})();

// ───────────────────────── finalize lanes: shipped, disposition, physical loads ─────────────────────────
for (const lane of LANES) {
  const cap = lane.db.truckCap;
  lane.shipped = lane.lines.reduce((s, x) => s + x.shipOrig + x.shipSub + x.shipFil, 0);
  if (!lane.dropped) lane.trucks = Math.max(1, Math.ceil(lane.shipped / cap));
  lane.fillPct = lane.trucks ? round1((lane.shipped / (lane.trucks * cap)) * 100) : 0;
  lane.combinedFillPct = round1((lane.shipped / Math.max(1, lane.soq)) * 100);
  lane.soFlag = lane.origFillPct < 50 ? 'RLM_FOR_SECOND_CFA' : lane.dropped ? 'RLM_TRUCK_APPROVAL' : 'SO_CREATION';
  if (lane.dropped) continue;
  // pack lines into trucks, SKU-level, truck by truck (original → substitute → filler)
  const items: LoadSku[] = [];
  for (const x of lane.lines) {
    const z = rzByCode.get(x.rz)!;
    const parts: [number, 0 | 1, 0 | 1][] = [[x.shipOrig, 0, 0], [x.shipSub, 1, 0], [x.shipFil, 0, 1]];
    for (const [cases, isSub, isFil] of parts) {
      if (cases <= 0) continue;
      const split = z.skus.length === 2 ? [Math.ceil(cases * 0.7), cases - Math.ceil(cases * 0.7)] : [cases];
      split.forEach((c, i) => {
        if (c <= 0) return;
        const v = z.skus[i];
        items.push({ rz: x.rz, sku: v.sku, cases: c, units: c * v.unitsPerCase, mrp: v.mrp, batch: v.batch,
          daysToExpiry: v.daysToExpiry, isSub, isFiller: isFil, desc: v.desc, isPdp: v.isPdp });
      });
    }
  }
  const loads: Load[] = Array.from({ length: lane.trucks }, (_, i) => ({
    no: i + 1, cases: 0, planned: 0, truckid: `TRK-${CFA}-${String(truckSeq++).padStart(4, '0')}`,
    order: String(orderSeq++), skus: [],
  }));
  let t = 0;
  for (const it of items) {
    let left = it.cases;
    while (left > 0) {
      const room = t === loads.length - 1 ? Infinity : cap - loads[t].cases;
      if (room <= 0) { t += 1; continue; }
      const c = Math.min(left, room);
      loads[t].skus.push({ ...it, cases: c, units: c * Math.round(it.units / it.cases) });
      loads[t].cases += c; left -= c;
    }
  }
  const plannedTotal = lane.shipped + lane.clusterTrim;
  loads.forEach((l, i) => { l.planned = i === loads.length - 1 ? l.cases + (plannedTotal - lane.shipped) : l.cases; });
  lane.loads = loads;
}

// ───────────────────────── convenience roll-ups ─────────────────────────
export const shippedOf = (x: Line) => x.shipOrig + x.shipSub + x.shipFil;
export const allLines = () => LANES.flatMap((l) => l.lines.map((x) => ({ lane: l, line: x })));
export const totals = () => {
  const s = (f: (l: Lane) => number) => LANES.reduce((a, l) => a + f(l), 0);
  return {
    soq: s((l) => l.soq), orig: s((l) => l.orig), sub: s((l) => l.sub), filler: s((l) => l.filler),
    planned: s((l) => l.planned), shipped: s((l) => l.shipped), trucks: s((l) => l.trucks),
    atp: REG_ZSKUS.reduce((a, z) => a + z.cfaStock, 0),
    lanes: LANES.length, shippedLanes: LANES.filter((l) => !l.dropped && l.soFlag === 'SO_CREATION').length,
  };
};
/** SO order ids that actually go to SAP (SO_CREATION lanes only) */
export const soOrders = () => LANES.filter((l) => l.soFlag === 'SO_CREATION').flatMap((l) => l.loads.map((ld) => ({ lane: l, load: ld })));
