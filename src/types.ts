// line tuple (ITEM-oriented + fair-share audit): [zsku, brand, soq, orig, subShipped, subForDetail, fillerShipped, fillerForDetail,
//   totalPhysical, cfaStock, dbStock, norm, zskuDesc, maxNorm, ownDemandFilled,
//   priorityBefore, priorityAfter, snBefore, snAfter, requiredM, valueM, binding]
export type Line = [string, string, number, number, number, string, number, string, number, number, number, number, string, number, number,
  number, number, number, number, number, number, boolean];

// sku tuple: [zsku, sku, cases, units, mrp, batchNo, daysToExpiry, isSubstitute(0|1), isFiller(0|1), productDesc, isPdp]
export type Sku = [string, string, number, number, number | null, string, number, number, number, string, string];

export interface Truckload {
  no: number;
  cases: number;      // cases SHIPPED (post cluster-trim = the "after")
  planned?: number;   // cases the engine PLANNED before the cluster primary trim (the "before"); == cases for untrimmed lanes
  truckid: string;    // actual Truck ID for the lane (cfa_db_truck_load_master)
  order: string;      // order id for this physical truck
  skus: Sku[];
}
// one eligible filler's Step-3 calc: allocated = min(truck room, CFA pool [reserved, net of orig+sub], 1.2×Norm room, 35% add-on)
export interface FillerCalc {
  z: string; name: string; rank: number;
  norm: number; max: number; onhand: number; step1: number; sub: number;   // 1.2×Norm room context
  room: number;       // 1.2×Norm room left
  addon: number;      // 35% add-on budget left (shared with substitutes)
  truck: number;      // spare truck room left on the lane
  pool: number;       // reserved CFA pool for the run, already net of orig+sub
  alloc: number;      // cases given as a filler
  poolAfter: number;  // CFA pool after this filler
  reason: string;     // the cap that bound it
}
export interface Truck {
  db: string;
  name: string;       // DB name (db_master)
  tier: number;
  tot: number;
  soq: number;
  cap: number;        // this lane's truck capacity (per CFA x DB)
  truckType?: string; // truck vehicle type for this lane (e.g. "19-20 FT Container", or "ACE Container" for transshipment)
  soFlag?: string;    // backend SO disposition (SO_CREATION | RLM_TRUCK_APPROVAL | RLM_FOR_SECOND_CFA) — displayed as-is, never recomputed
  origFillPct?: number | null;     // Original ÷ SOQ % (own-demand service) — the rate the disposition keys on (≥50% ⇒ SO/RLM-truck, <50% ⇒ RLM 2nd CFA). Engine-served (truck_plan_by_run.original_fill_pct)
  combinedFillPct?: number | null; // Total_Allocated ÷ SOQ % — the combined fill (matches the existing "% of SOQ" chip)
  isTranship?: boolean;       // ships on the transshipment SECONDARY truck (raw_transhipement_master)
  cluster?: string;           // transshipment Cluster_Code — DBs in one cluster share a primary route
  primaryTruckCount?: number; // cluster-combined INTEGER full primary trucks (cluster-level)
  // transshipment FINAL step: the per-DB secondary trucks (loads, above) are built FIRST, then the whole cluster is
  // COMBINED onto the primary truck — whose capacity caps the DB. Present only for transshipment DBs in a cluster.
  clusterCombine?: {
    code: string; combined_load: number; primary_cap: number; primary_trucks: number; primary_ships: number;
    db_sec_built: number; db_trimmed: number; db_ships: number;
  } | null;
  n: number;
  lines: Line[];
  loads: Truckload[];
  opted?: [string, number | string, number, number, number][];   // [zsku, desc, asisAlloc, kept, optedCases] removed by the 80% truck rule
  filler_calc?: FillerCalc[];   // per-eligible-filler Step-3 calc (caps + binding) for the drilldown
  // Step-3 filler DRAW SEQUENCE — the EXACT values the engine used (or_filler_sequence), not recomputed here
  priority?: number;  // (Σnorm ÷ Σheld) × tier weight — the draw-priority score
  rank?: number;      // draw sequence within the CFA (1 = drew the shared filler pool first)
  nRank?: number;     // number of DBs in the CFA's draw sequence
  sumNorm?: number;   // Σnorm (numerator)
  sumHeld?: number;   // Σheld = stock + Original + Substitute (denominator)
  // dropped lane: Steps 1+2 were allocated then CANCELLED at Step 3 (truck < 65%) — from or_output_truck_trim
  dropped?: boolean;
  dropOrig?: number;  // Step-1 Original that was allocated then cancelled (cascades to next run)
  dropSub?: number;   // Step-2 Substitute that was allocated then cancelled
  dropFil?: number;   // filler reserved then released
  // TRUCK_TAIL_CASCADE: a lane that SHIPPED its full truck(s) but had a small overflow beyond capacity that
  // couldn't fill another ≥65% truck — only that tail cascades to the next run (the lane still ships).
  cascaded?: number;
}
export interface Cfa {
  cfa: string;
  tot: number;
  soq: number;
  nt: number;
  atp?: number;       // total sellable CFA stock (all ZSKUs) before allocation
  trucks: Truck[];
}
export interface Meta {
  cfas: number;
  trucks: number;
  cases: number;
  soq: number;
  truck: string;
  label: string;
}
export type Size = 'combined';
export type Mode = 'without_region' | 'with_region';
export interface Payload {
  data: Record<Mode, Record<Size, Cfa[]>>;
  meta: Record<Mode, Record<Size, Meta>>;
}
