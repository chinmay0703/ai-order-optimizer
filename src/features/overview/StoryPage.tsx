import { useState } from 'react';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { useOeParams, pct, type OeParams } from '../../shared/OeParams';
import type { Page } from '../../shared/layout/Sidebar';

// substitute the {TOKENS} in the story content with the LIVE oe_parameters values (never hardcode 1.2 / 65% / …)
const fill = (s: string, P: OeParams): string => {
  const map: Record<string, string> = {
    '{NORMX}': String(P.NORM_MULTIPLIER),
    '{ADDONF}': String(P.ADDON_CAP_PCT),
    '{ADDONP}': pct(P.ADDON_CAP_PCT),
    '{KEEP}': pct(P.TRUCK_KEEP_PCT),
    '{TARGET}': pct(P.TRUCK_FILL_TARGET_PCT),          // Step-3 filler fill target
    '{SOFILL}': pct(P.SO_CREATION_TRUCK_FILL_PCT),     // SO-creation truck-fill threshold (its OWN knob, not TARGET)
    '{ORIG}': pct(P.SO_CREATION_ORIGINAL_FLOOR_PCT),
  };
  let out = s;
  for (const k in map) out = out.split(k).join(map[k]);
  return out;
};
import PipelineFlow from './PipelineFlow';

/* How the AI Order Optimizer works — the CURRENT end-to-end flow, checked line by line against
   the backend code (develop). A run is stamped with TODAY's run date and processes the chosen SOQ (data) date; every
   CFA runs the full engine in its own process. Inside a CFA: filter the SOQ → segregate DBs by channel → reserve the
   CFA stock by channel × MRP band (the date-wise %) → cascade 4 channel-runs, each a 3-step allocation (Step 1 = the
   DRR × RF fair share) → truck build → FEFO picks → orders + SO/RLM disposition → the RLM rollup. */

// ── content model ─────────────────────────────────────────────────────────
type Tone = 'navy' | 'green' | 'amber' | 'gold';
type Tint = 'red' | 'green' | 'amber' | 'blue' | 'violet';
type Cell = string | { v: string; tint?: Tint };
type Item =
  | { t: 'text'; v: string }
  | { t: 'rule'; v: string; tone?: Tone }
  | { t: 'formula'; v: string }
  | { t: 'table'; head: string[]; rows: Cell[][]; align?: ('left' | 'center')[]; caption?: string };
const T = (v: string): Item => ({ t: 'text', v });
const RULE = (v: string, tone: Tone = 'navy'): Item => ({ t: 'rule', v, tone });
const FX = (v: string): Item => ({ t: 'formula', v });
const TBL = (head: string[], rows: Cell[][], opts?: { align?: ('left' | 'center')[]; caption?: string }): Item =>
  ({ t: 'table', head, rows, ...opts });

interface Phase { n: number; title: string; tag: string; accent: string; steps: { title: string; items: Item[] }[]; }

const PHASES: Phase[] = [
  {
    n: 0, title: 'The run', tag: 'run date = today · data date = the SOQ date you pick · every CFA in parallel', accent: C.muted,
    steps: [
      { title: 'Two dates: the run date and the SOQ (data) date', items: [
        T('You pick the SOQ date to process (the data date). The run is stamped with TODAY’s date (IST). The dated feeds — soq, db_inventory, cfa_inventory and daily_run_rate — are fetched for the data date and stored under today’s run date; the masters are re-loaded in full (latest) and replace the previous copy. Every engine output is cleared and written under today’s run date, so a same-day re-run replaces only today’s outputs and earlier days’ outputs stay.'),
        RULE('pipeline_run_meta records run date → SOQ date — the date chip in the header (e.g. 06-10-2026 · SOQ 05-10-2026). It is written as soon as today’s outputs are cleared, before any S3 fetch, and completed with the CFA list when the run ends — so the chip shows the right SOQ date throughout the run, even if staging or the engine then fails.', 'navy'),
        T('Order of a run: re-read the OE parameters → take the run lock (a second run while one is in progress is rejected; a run date’s lock is reclaimed after 15 minutes without a heartbeat) → stamp one run timestamp → clear today’s outputs and today’s SAP orders (de_sap.orders) → record run date → SOQ date → stage the masters, the daily run rate and the SOQ (applying both demand gates → filtered_soq), then the CFA / DB inventory scoped to it → build the demand-scoped substitute / filler slices and load the sub-channel reservation % → run the engine for every CFA → the secondary-CFA shift for each CFA that succeeded → close the run audit. (RUN_DISABLED blocks runs altogether.)'),
      ] },
      { title: 'Every CFA runs in its own process, in parallel', items: [
        T('Each CFA with filtered demand runs the full engine — in its own process when more than one CFA runs in parallel (CFA_PARALLEL_WORKERS: 0 = automatic from the pod’s CPU and memory, N = at most N CFAs at once, 1 = one CFA at a time inside the API). If worker processes cannot start, the CFAs run one at a time instead. One CFA failing never stops the others — the run is then PARTIAL and the failed CFA is shown on the Run page.'),
        RULE('All CFAs share one run timestamp, so order ids (OEIDs) carry one prefix. Order-id minting and the S3 order_line_items write are serialised with database locks, so parallel CFAs never collide. The run audit (pipeline_run_audit + a row per CFA × stage) ends SUCCESS, PARTIAL or FAILED.', 'green'),
      ] },
    ],
  },
  {
    n: 1, title: 'Delivered data', tag: 'staged from S3 — only light shaping (column mapping, on-hand + in-transit, days to expiry) and the demand gate', accent: C.muted,
    steps: [
      { title: 'soq — the demand + the gate flags', items: [
        T('Rows per DB × CFA × reg-zsku (the feed can repeat a line): SOQ_Case (the adjusted SOQ, cases to order), Norm_Qty_Cases, Max_Norm and Brand, plus three Yes/No flags — is_pdp · is_below_threashold · is_combined_soq_greater_than_65_percentage.'),
        RULE('The flags are applied when the SOQ is staged (the demand gate, next phase) to build filtered_soq — the engine reads ONLY filtered_soq, and drops any line with SOQ_Case ≤ 0.'),
        FX('Max_Norm in the feed is NOT used: the engine recomputes the cap from Norm_Qty_Cases → total held ≤ floor({NORMX} × Norm)  (see the 3 steps)'),
      ] },
      { title: 'db_inventory — the DB stock (SOH)', items: [
        T('Staged from the SOQ feed itself: Qty_in_Cases = DAILY_INV_CASES + DAILY_TRANSIT_CASES (on-hand + in-transit), for the DBs in the filtered SOQ. Stock is per DB × reg-zsku (not per CFA); if the feed repeats a line, the last row wins. This is the stock the engine uses everywhere (Step 1, the {NORMX}×Norm room, the trim ranking, the Final Order).'),
        RULE('A (DB, reg-zsku) with no db_inventory row counts as 0 stock — so a missing DB stock from the data team is directly visible as 0 everywhere.', 'amber'),
      ] },
      { title: 'cfa_inventory — the supply (batch-level)', items: [
        T('One row per batch: Plant · reg-zsku (<zsku>-<region>, e.g. 67296-AP-AT-KN) · zsku · Material_no (the batch’s SAP code — THE SKU ID on the order) · Batch_No · Exp_Date · Days_to_Expiry · Qty_in_Cases, for the CFAs in the filtered SOQ.'),
        FX('CFA pool(reg-zsku) = Σ over its batches of Qty_in_Cases — a batch repeated in the feed is counted once (MAX per reg-zsku × material × batch)'),
      ] },
      { title: 'daily_run_rate — the sales speed (DRR)', items: [
        FX('DRR (per CFA × DB × reg-zsku) = last 3 months of primary sales cases ÷ 90 days   (S3 OE_DAILY_RUN_RATE, published daily)'),
        RULE('Only the snapshot for the run’s EXACT data date is used — another day is never substituted. If it is not published, the Run page shows a warning and every distributor’s DRR is 0 — which Step 1 then uses as 0.1.', 'amber'),
      ] },
      { title: 'The masters', items: [
        T('13 masters, fully re-loaded every run (in parallel): db_master · material_master · network_master · substitution_master + filler_master (latest load) · truck_master · transhipment_master (the Cluster Master) · plant_master · lead_time_master · db_tier (Final_Tier_Score) · region_sku_master · brand_material_master (brand category) · pdp_master (PDP frequency → the Step-1 RF).'),
        RULE('sub_channel_reservation (CFA × channel × MRP-band %) is fetched from S3 every run, after the masters — the LATEST S3 run_date — and stored DATE-WISE under the run date (with the S3 run_date it came from), so every run keeps the % it actually used.', 'green'),
      ] },
    ],
  },
  {
    n: 2, title: 'Filter the SOQ — the demand gate', tag: 'gate 1 (PDP or below-threshold) AND combined > 65%, then gate 2 (cluster needs ≥2 DBs) · per (DB, CFA)', accent: C.gold,
    steps: [
      { title: 'Gate 1 · which (DB, CFA) enter the run', items: [
        FX('KEEP (DB, CFA)   when   ( is_pdp   OR   has a below-threshold REG-SKU )   AND   combined SOQ > 65% of the truck'),
        RULE('combined > 65% is MANDATORY; on top of it the DB must be on a PDP date OR have a below-threshold REG-SKU. Read per (DB, CFA) — ANY line carrying a flag counts — and EVERY line of a kept (DB, CFA) is kept: a DB-universe gate, not a per-line trim. (This 65% is the data-team flag — a fixed gate, not the Step-3 truck floor.)', 'navy'),
      ] },
      { title: 'Gate 2 · a transshipment cluster needs ≥2 distributors', items: [
        RULE('Runs on the gate-1 survivors: a transshipment cluster (per CFA × Cluster_Code in transhipment_master) needs ≥2 DISTINCT distributors still kept to share a primary truck. A cluster left with ONE kept distributor is dropped — shown on the Filtered SOQ page as “Dropped — cluster has only 1 distributor (needs ≥2 to transship)”. A DB with no cluster is never touched by this gate.', 'amber'),
        T('So a cluster can be emptied here even with ≥2 members in the master — if gate 1 dropped one, the lone survivor goes too. The kept / dropped decision and its reason are on the Filtered SOQ page.'),
        T('Everything downstream — reservation · Step 1 · substitute · filler · truck · cluster · orders — runs on this FILTERED SOQ only. Both soq and filtered_soq are on the Data page.'),
      ] },
    ],
  },
  {
    n: 3, title: 'Segregate the DBs into channels', tag: 'Channel taxonomy · Customer Type × Sub-Channel', accent: C.gold,
    steps: [
      { title: 'Which DBs this CFA serves', items: [
        T('The filtered SOQ’s DBs for this CFA with SOQ > 0, that exist in db_master and that the channel rule can classify. The SOQ is the authoritative CFA → DB map from the data team; network_master is used ONLY for the Secondary CFA (RLM).'),
      ] },
      { title: 'Customer Type + Sub-Channel → allocation channel', items: [
        FX('SAH · D81/D84/D85 → Retail   |   D82/D86 → AFH   |   D83 → Hub & Spoke'),
        FX('SAL/SAN → Non-PACE for EVERY D-code (incl. D87 EXPORTS + D88 INTERCOMPANY)'),
        RULE('Keys on Customer Type first, then the D-code; any other combination is not classified and the DB is left out. The full basis — Customer Type · C-code · Sub-Channel → channel — is written to db_channel_map, so every DB’s channel is auditable.'),
        TBL(
          ['Customer type', 'Allocation channel', 'Sub-channel code', 'Sub-channel description'],
          [
            ['SAH', { v: 'Retail', tint: 'green' }, 'D81', 'RETAIL'],
            ['SAH', { v: 'Retail', tint: 'green' }, 'D84', 'RURAL DIRECT'],
            ['SAH', { v: 'Retail', tint: 'green' }, 'D85', 'RURBAN'],
            ['SAH', { v: 'Away from home', tint: 'amber' }, 'D86', 'MULTI-FORMAT'],
            ['SAH', { v: 'Away from home', tint: 'amber' }, 'D82', 'WHOLESALE'],
            ['SAH', { v: 'Hub & spoke', tint: 'red' }, 'D83', 'HUB & SPOKE'],
            ['SAL/SAN', { v: 'Non-Pace', tint: 'violet' }, 'D87', 'EXPORTS'],
            ['SAL/SAN', { v: 'Non-Pace', tint: 'violet' }, 'D81', 'RETAIL'],
            ['SAL/SAN', { v: 'Non-Pace', tint: 'violet' }, 'D82', 'WHOLESALE'],
            ['SAL/SAN', { v: 'Non-Pace', tint: 'violet' }, 'D83', 'HUB & SPOKE'],
            ['SAL/SAN', { v: 'Non-Pace', tint: 'violet' }, 'D84', 'RURAL DIRECT'],
            ['SAL/SAN', { v: 'Non-Pace', tint: 'violet' }, 'D85', 'RURBAN'],
            ['SAL/SAN', { v: 'Non-Pace', tint: 'violet' }, 'D86', 'MULTI-FORMAT'],
            ['SAL/SAN', { v: 'Non-Pace', tint: 'violet' }, 'D88', 'INTERCOMPANY'],
          ],
          { caption: 'Functional-team channel master. The allocation channel keys on Customer Type + Sub-channel (D-code); the sales C-code does not change it. SAN is treated like SAL.' },
        ),
      ] },
    ],
  },
  {
    n: 4, title: 'Reserve the CFA stock', tag: 'per reg-zsku × MRP band × channel % (the % for the run date)', accent: C.gold,
    steps: [
      { title: 'MRP band per reg-zsku', items: [
        FX('band = B1 if MRP ≤ ₹10 · B2 if ₹10 < MRP ≤ ₹30 · B3 if MRP > ₹30'),
        T('The MRP comes from region_sku_master → material_master (if region_sku_master is missing: the batch’s Material_no → material_master). A reg-zsku with several price points takes the MAX MRP; one with no MRP is flagged “NO MRP” and never allocated.'),
      ] },
      { title: 'Split each reg-zsku’s stock across the 4 channels', items: [
        FX('reserved(channel, reg-zsku) = CFA pool × the channel’s band-%   →   cases rounded by largest-remainder, so the channels sum to the physical stock when the %s sum to 100'),
        RULE('The % is the one stored in sub_channel_reservation FOR THE RUN DATE (latest S3 snapshot). If that date has none — e.g. an older run — the LATEST stored date is used, never an empty set (and if this CFA is missing from that row-set, its distinct channel %s are used). The % actually applied is saved on every cfa_reservation row (reservation_pct), so a past split can always be checked.', 'green'),
        RULE('The %s are used exactly as delivered — decimals kept, never renormalised. Only the resulting CASES are rounded.', 'green'),
        RULE('Only reg-zskus with CFA stock > 0 are reserved. A demanded reg-zsku the CFA holds no stock of (no batch with qty > 0) still gets a 0-physical / 0-reserved row when it has an MRP, so it carries its MRP and brand category for the Step-2 substitute match. It gets no cases of its own; any SOQ still unfilled is a NO_CFA_STOCK shortfall.', 'amber'),
        T('Each row also carries the reg-zsku’s brand category (region_sku_master → brand_material_master) — part of the substitute match in Step 2.'),
      ] },
    ],
  },
  {
    n: 5, title: 'The reservation cascade', tag: 'run one channel at a time · smallest reservation first', accent: C.navy,
    steps: [
      { title: 'Run order', items: [
        FX('Run 1 Non-PACE → Run 2 Hub & Spoke → Run 3 AFH → Run 4 Retail'),
        RULE('Order = REVERSE of the reservation priority (Retail 1 · AFH 2 · Hub & Spoke 3 · Non-PACE 4): the smallest-reservation channel runs FIRST so its unused stock cascades UP toward Retail. Every channel takes its turn, even one with no DBs: it allocates 0 and its whole reserved stock passes on.'),
      ] },
      { title: 'What each run gets', items: [
        FX('available(reg-zsku) = min( this channel’s reserved cases + carry-in from earlier runs , remaining physical stock )'),
        T('Each run allocates to ITS channel’s DBs only; whatever it does not use cascades FORWARD to the next run. A run never receives the unused stock of a run that comes after it.'),
      ] },
    ],
  },
  {
    n: 6, title: 'Allocate — the 3 steps', tag: 'or_engine, inside each run’s channel pool', accent: C.green,
    steps: [
      { title: 'Step 1 · Original — the DRR × RF fair share', items: [
        T('Per reg-zsku inside each channel run, the run’s available cases (the pool) are shared across the DBs that asked for it.'),
        FX('pool = 0 → CFA STOCK 0: everyone 0   ·   pool ≥ Σ SOQ → NOT CONSTRAINED: everyone gets the full SOQ   (neither enters the engine; both are still traced)'),
        FX('Tier = Final_Tier_Score (0 or missing → the pool’s smallest positive tier; 0.5 if none) · Stock = SOH + in-transit (0 → 1) · DRR = daily run rate · RF = PDP frequency in days (Daily 1 · Thrice a week 2 · Twice a week 3 · Weekly 7 · Every 10 days 10 · Fortnightly 14 · Monthly 14) · a DRR of 0 (or missing) is used as 0.1 · a missing PDP frequency counts as 0'),
        FX('Demand = DRR × RF   ·   Floor = min( SOQ , max(0, Demand − Stock) )   ·   Weight = Tier × DRR ÷ Σ DRR'),
        RULE('Pool ≤ Σ Floor → SEVERE SCARCITY: each DB gets between 0 and its Floor. Otherwise (Σ Floor < pool < Σ SOQ) NORMAL SCARCITY: every DB first gets its Floor — the cases it still needs, after its stock, to cover DRR × RF days — then a fair share up to its SOQ.', 'navy'),
        FX('one common level λ by bisection:  Σ clip( Weight ÷ λ − Stock , lower , upper ) = pool   (NORMAL: Floor…SOQ · SEVERE: 0…Floor)   →   before whole-case rounding, every DB strictly between its limits ends at the SAME priority score after = Tier × DRR ÷ (Stock + allocation) = λ × Σ DRR  (Stock 0 → 1; rounding moves it slightly)'),
        FX('whole cases: round each down, kept within its limits (pristine — NORMAL ⌈Floor⌉…⌊SOQ⌋ · SEVERE 0…⌊Floor⌋) → hand out the remaining cases one at a time, largest fraction first, only to DBs still below their upper limit — or take back extra cases smallest fraction first, only from DBs above their lower limit (ties: priority score Tier × DRR ÷ Stock → Demand → SOQ → lower Stock) → Σ allocation = the pool exactly'),
        RULE('A DRR of 0 is always calculated as 0.1, so a distributor with no recent sales still takes part in the fair share (ranked below every real seller). Step 1 is capped only by SOQ and the pool — not by {NORMX}×Norm. Every DB’s inputs (DRR used, DRR actual, PDP frequency, RF, Stock, pool) and regime are written to or_waterfill_steps — the Fair-Share page; DBs in pools that enter the engine also get Demand, Floor, Weight, λ, pristine, adjustment and category.', 'green'),
      ] },
      { title: 'Step 2 · Substitute — exact MRP + brand category, neediest first', items: [
        T('Demand Step 1 could not fill (open SOQ = SOQ − Original) is met from the DB’s ranked substitutes (soq_db_substitution, the run’s CFA × DB slice of the substitution master), rank 1 first; a reg-zsku never substitutes itself.'),
        RULE('Substitutes match on CFA × DB × the EXACT MRP price point × the brand category of the demanded reg-zsku — a ₹5 item draws only ₹5 subs of the same category, not every ≤₹10 sub.', 'green'),
        FX('New score = Tier × Norm ÷ max(Stock + Original, 1)  →  lines are served neediest first; each fills its whole open demand through its ranks before the next line, so the needier line has first claim on a contested substitute'),
        FX('grant = min( open demand , CFA pool , {NORMX}×Norm room of the substitute reg-zsku , {ADDONP} add-on )  — a substitute with no SOQ Norm at the DB has 0 room; a demanded reg-zsku with no MRP gets no substitutes'),
        RULE('Non-PACE DBs have NO {NORMX}×Norm room cap — only the pool, the {ADDONP} add-on and the truck limit them.', 'amber'),
      ] },
      { title: 'Step 3 · Filler + truck', items: [
        T('Fillers (soq_db_filler — any MRP, ranked per DB) are drawn only when the truck decision is FILL, topping the lane up to the {TARGET} truck target on its minimum trucks, capped by that truck room, the CFA pool, the {NORMX}×Norm room of the filler reg-zsku (not for Non-PACE) and the {ADDONP} add-on.'),
        FX('filler draw priority = Tier × Σ Norm ÷ max(Σ held, 1) ;   Σ held = Stock + Original + Substitute (the load BEFORE fillers)'),
        RULE('DBs claim the shared CFA filler pool in priority order — rank 1 draws first; the per-CFA draw rank is written to or_filler_sequence.', 'navy'),
        FX('load = Original + Substitute ;  cap = the lane truck (a transshipment DB: its Secondary_Max_Cases) ;  min_trucks = ⌈load ÷ cap⌉ · full_trucks = ⌊load ÷ cap⌋ · leftover = load − full_trucks × cap  →  exact fit → SHIP AS-IS ;  no full truck → FILL ;  ⌈{TARGET} × cap × min_trucks⌉ − load ≤ leftover → FILL to {TARGET} ;  else → TRIM.  No truck_master row → LANE_DROP_NO_TRUCK'),
        RULE('PACK: if the load reaches {TARGET} on every minimum truck, the trucks are loaded evenly; otherwise the full trucks go to 100% and the remainder rides one more truck (if that remainder is short, the full trucks give back down to {TARGET} only when that lifts it to the keep threshold). The remainder SHIPS if it is ≥ round({KEEP} × cap) cases; else it is TRIMMED when a full truck still ships — fillers returned to the pool first, then substitute, then original, least-needy first by on-hand ÷ Norm (TRUCK_TAIL_CASCADE rows for substitute / original) — or the whole lane DROPS (LANE_DROP_<65%): its fillers go back to the CFA pool and its Original + Substitute cases cascade to the next channel run.', 'amber'),
        RULE('A DB in transhipment_master (the Cluster Master) ships on its own SECONDARY truck (Secondary_Max_Cases). The PRIMARY truck is a shared cluster route. The cluster keeps n = min(⌊load ÷ ({KEEP} × Primary_Max)⌋, ⌈load ÷ Primary_Max⌉) primary trucks (lowered further if they would not each reach {KEEP}) and trims the overflow (load − n × Primary_Max) across its DBs: fillers first, then substitutes, then originals — each pass walking the lines filler-only → substitute-only → mixed → original-only, least-needy first by on-hand ÷ Norm — taking cases off each DB’s own secondary truck but never below ⌈{KEEP} × that truck⌉. Overflow the secondary floors cannot absorb rides one extra primary truck. n < 1 → the whole cluster drops (CLUSTER_DROP_<65% (<cluster>)). Primary_Truck_Count = ⌈Σ cluster shipped load (after the trim) ÷ Primary_Max_Cases⌉, one number for every DB of the cluster. (A cluster with only one distributor left was already dropped at the demand gate.)', 'navy'),
      ] },
      { title: 'The caps that bind the add-ons', items: [
        FX('{NORMX}×Norm room (INCLUSIVE ≤):  max(0, floor({NORMX} × Norm) − held) for the reg-zsku being granted, held = stock + Original + Substitute + Filler  → Substitute / Filler stop once held reaches floor({NORMX} × Norm) (Original alone may exceed it)   · not applied in Step 1 · not applied to Non-PACE DBs'),
        FX('{ADDONP} add-on (INCLUSIVE ≤):  Substitute + Filler  ≤  floor({ADDONF} × the DB’s total SOQ in the run)   · one budget shared by Step 2 and Step 3, not Step 1'),
      ] },
    ],
  },
  {
    n: 7, title: 'FEFO picks and orders', tag: 'allocated cases → SKU / batch picks → order ids → SAP', accent: C.green,
    steps: [
      { title: 'FEFO — split each allocated case total into batches', items: [
        RULE('First-Expiry-First-Out: one batch pool per reg-zsku per CFA (a repeated batch counted once), earliest Exp_Date first, depleted in cascade-run order, then DB id; within a lane the Original draws first, then the Substitutes, then the Fillers. An Original case draws from the demanded reg-zsku; a Substitute / Filler case from its own source reg-zsku. Every pick is tagged Original · Substitute · Filler; the SKU ID is the batch’s SAP Material_no (a batch with no Material_no, and every Not_Allocated row, keeps the source zsku).'),
        FX('Σ SKU_Qty (sku level) = Total_Allocated (reg-zsku level)   — by design (the FEFO pool is the reserved pool), at run time; after the RLM rollup it holds over the picks not flagged TRUCK_REJECTED / RLM_SHIFTED — a warn-level Data QA check'),
      ] },
      { title: 'Order ids and orders', items: [
        FX('one order id per CFA × DB:  OEID<YYYYMMDD>-<HHMMSS>-<NNNN>  — date / time = the run’s single timestamp; NNNN continues today’s highest number in DB-id order, minted under a database lock so parallel CFAs never collide (a DB served by two CFAs gets two order ids)'),
        T('actual_order_quantity holds the picks, split per truck (from the truck plan), each line carrying its own truck’s SO flag. order_masters holds every shipped line (qty > 0) — order × truck × reg-zsku × material — with its disposition and whether its SO was created. SO-eligible lines (SO_CREATION, TRUCK_APPROVED or SEC_CFA_REJECTED, not yet SO-created, and no line of the order still RLM_TRUCK_APPROVAL) go to de_sap.orders — one row per order × SAP material, summed over trucks, is_active = 1: the SAP hand-off. The SO-created orders, minus any TRUCK_REJECTED truck, also go at reg-zsku level to order_line_items in S3 (OE_OUTPUT, S3 only; a substitute / filler line is keyed to the reg-zsku that supplied it).'),
        RULE('The S3 order_line_items hand-off is written on QA / production; it is switched off on develop, which shares QA’s S3 location.', 'amber'),
      ] },
    ],
  },
  {
    n: 8, title: 'Output and SO disposition', tag: 'what one run writes, and how each truck is routed', accent: C.navy,
    steps: [
      { title: 'Tables the pages read', items: [
        T('allocation_final — the shipped allocation per DB × reg-zsku (Original + Substitute + Filler + Total + fill %), after the truck trim and the cluster trim (plus 0-allocation rows for every unshipped demand line of a DB that got a truck), and reduced again by the RLM rollup. actual_order_quantity — its FEFO picks per truck (plus Not_Allocated rows).'),
        RULE('alloc_step1_primary / alloc_step2_substitution / alloc_step3_filler hold each STEP’s own allocation BEFORE lane drops and the cluster trim (a dropped lane still shows its Step-1/2 cases); a truck-tail trim is already taken out, and Step 3 lists only fillers that shipped.', 'green'),
        T('or_output_truck_trim — what the truck rules cut: TRUCK_TAIL_CASCADE (substitute / original cut from the remainder-truck tail; filler cut from a tail simply returns to the pool and is not logged), LANE_DROP_<65% (no truck reached {KEEP}), LANE_DROP_NO_TRUCK (no truck_master row), CLUSTER_DROP_<65% (<cluster>) (a whole cluster). Partial cluster trims are in or_cluster_primary_trim.'),
        T('truck_plan_by_run (trucks, fill %, SO flag) · or_filler_sequence · cfa_reservation · db_channel_map · or_output_ledger (the cascade) · or_waterfill_steps + or_sub_eligibility + or_output_filler_calc (drilldown traces) · demand_by_run · or_output_shortfall · or_cluster_primary(_trim) · rlm_ptl_headers / line_items · rlm_cfa_shift_headers / line_items.'),
      ] },
      { title: 'SO disposition — per CFA × DB × truck', items: [
        T('Every planned truck is stamped once, in this order (Original = the DB’s own-demand fill: Σ Original ÷ its combined SOQ — all its demanded reg-zskus at this CFA, including lines that shipped nothing; truck % = this truck’s fill to 1 decimal):'),
        FX('1. Non-PACE DB  AND  truck ≥ 65%  →  SO_CREATION   (Original ÷ SOQ and the {SOFILL} test are skipped)'),
        FX('2. transshipment (cluster) lane  →  SO_CREATION   (it rides the formed cluster primary truck)'),
        FX('3. Original < {ORIG} of SOQ  →  truck fill IGNORED:  Secondary CFA in network_master → RLM_FOR_SECOND_CFA ;  else → RLM_TRUCK_APPROVAL'),
        FX('4. Original ≥ {ORIG} of SOQ  AND  truck ≥ {SOFILL} (rounded to a whole %, so 89.5% passes 90%) → SO_CREATION ;   otherwise → RLM_TRUCK_APPROVAL'),
        TBL(
          ['Lane', 'Original ≥ {ORIG} of SOQ', 'Secondary CFA', 'Truck', 'Action'],
          [
            ['any (cut in Step 3 / the cluster trim, before this)', '–', '–', '< {KEEP}', { v: 'DROP · no truck', tint: 'red' }],
            ['Non-PACE', '– (skipped)', '– (skipped)', '≥ 65%', { v: 'SO CREATION', tint: 'green' }],
            ['Transshipment', '– (skipped)', '– (skipped)', 'cluster primary', { v: 'SO CREATION', tint: 'green' }],
            ['other', 'Yes', '– (ignored)', '≥ {SOFILL}', { v: 'SO CREATION', tint: 'green' }],
            ['other', 'Yes', '– (ignored)', '{KEEP} – {SOFILL}', { v: 'RLM FOR TRUCK APPROVAL', tint: 'amber' }],
            ['other', 'No', 'Yes', '– (ignored)', { v: 'RLM FOR 2ND CFA', tint: 'blue' }],
            ['other', 'No', 'No', '– (ignored)', { v: 'RLM FOR TRUCK APPROVAL', tint: 'amber' }],
          ],
          {
            align: ['center', 'center', 'center', 'center', 'center'],
            caption: 'Engine flags: SO_CREATION · RLM_TRUCK_APPROVAL · RLM_FOR_SECOND_CFA, written to truck_plan_by_run.so_flag (with original_fill_pct); the RLM rollup later sets approved and primary-shipped trucks to SO_CREATION. An order (CFA × DB) with ANY truck in RLM_TRUCK_APPROVAL is held whole — none of its trucks becomes a sales order until RLM decides.',
          },
        ),
        RULE('For every RLM_TRUCK_APPROVAL truck the RLM PTL is built: one header per truck (status PENDING, PDP flag + PDP frequency, combined SOQ, total trucks, capacity, AOQ, gap, utilisation, Original / Filler / Substitution split) and line items per order × reg-zsku × truck for ALL the DB’s reg-zskus (SOQ, AOQ, Original / Filler / Substitution, truck qty, SOH, projected coverage (SOH + AOQ) ÷ Norm and current coverage SOH ÷ Norm; the stock status uses the CURRENT coverage).', 'navy'),
      ] },
    ],
  },
  {
    n: 9, title: 'The RLM rollup', tag: 'how the held trucks finally resolve', accent: C.navy,
    steps: [
      { title: 'When it runs', items: [
        T('RLM_TRUCK_APPROVAL and RLM_FOR_SECOND_CFA lanes are HELD (no SO) until the daily rollup — 15:31 IST by default, right after the 15:00–15:30 RLM window. The scheduled job is opt-in (RLM_CRON_ENABLED); POST /api/v1/rlm/rollup runs it any time. It goes CFA by CFA over the CFAs of that run (pipeline_run_meta), each with up to 3 attempts on a hard failure; a CFA that fails is skipped and the others still resolve. The time is set in the environment (RLM_ROLLUP_HOUR / MINUTE).'),
        RULE('The application sets every decision status (the engine seeds PENDING and only reads it at the rollup); the rollup then writes back the deadline defaults below.', 'navy'),
      ] },
      { title: 'Truck approval (PTL) and the secondary-CFA shift', items: [
        RULE('PTL — rlm_ptl_headers.status is PENDING · APPROVED · REJECTED per truck. At the deadline a still-PENDING truck takes the configured default (REJECTED). APPROVED → TRUCK_APPROVED → the order’s SO is created (its held SO_CREATION trucks ship with it); actual_order_quantity and truck_plan_by_run are re-flagged SO_CREATION. REJECTED → TRUCK_REJECTED: its cases are removed from allocation_final (deleted, or reduced to what still ships); its actual_order_quantity rows stay, re-flagged TRUCK_REJECTED; truck_plan_by_run keeps RLM_TRUCK_APPROVAL; the truck is left out of de_sap.orders and order_line_items.', 'navy'),
        RULE('Shift — rlm_cfa_shift_headers.status is PENDING · SHIFTED · HELD. SHIFTED → the SECONDARY CFA handles it: its actual_order_quantity rows are re-flagged RLM_SHIFTED and its cases removed from this CFA’s allocation_final; no SO here. PENDING, HELD or no header → the PRIMARY CFA ships it now (SEC_CFA_REJECTED → SO created), and PENDING / HELD headers are written back as APPROVED.', 'amber'),
        RULE('After all CFAs, every earlier de_sap.orders row still active (is_active = 1) — except the orders this rollup just created — is set to is_active = 0, so SAP takes only the fresh batch.', 'green'),
        T('The Run page shows both sides: BEFORE RLM — Sent for SO creation · Sent for RLM approval · 2nd CFA · Dropped (every filtered DB in exactly one bucket); AFTER RLM — Shipped before RLM · Shipped after RLM · Rejected by RLM · trucks · Shifted to 2nd CFA · Sent from primary CFA · Pending RLM · Dropped.'),
      ] },
    ],
  },
];

const GUARANTEES: Item[] = [
  RULE('Step 1 hands out the whole pool whenever demand allows: Σ Step-1 allocation = min(pool, Σ SOQ), in whole cases, never above a DB’s SOQ.', 'green'),
  RULE('Substitutes always match the demanded item’s EXACT MRP price point and brand category (₹5 → ₹5); fillers may be any MRP.', 'green'),
  RULE('Substitute + Filler is capped INCLUSIVELY at floor({ADDONF} × SOQ), and Substitute / Filler are granted only while total held (stock + Original + Substitute + Filler) ≤ floor({NORMX} × Norm) — except Non-PACE DBs, which have no Norm cap. Step-1 Original is not Norm-capped, so held can exceed the Norm cap from Original alone.', 'green'),
  RULE('No lane truck ships below round({KEEP} × cap) cases: a lane opens the MINIMUM trucks, packs them, and a remainder below that is trimmed, or the lane drops (its fillers go back to the CFA pool, its Original + Substitute cascade to the next run). Every cluster secondary truck keeps ≥ ⌈{KEEP} × cap⌉; a cluster ships n primary trucks each ≥ {KEEP}, plus at most one overflow truck (which may be below {KEEP}).', 'green'),
  RULE('Allocated cases = shipped SKU/batch cases (the FEFO pool is the reserved pool) — checked by the Data QA tests.', 'green'),
  RULE('Every case is accounted for: allocated, short with a reason (or_output_shortfall), trimmed or dropped with a reason (or_output_truck_trim; cluster overflow trims in or_cluster_primary_trim), or left in the CFA ledger (or_output_ledger) / carried to the next channel run.', 'green'),
];

// ── presentation ─────────────────────────────────────────────────────────
const toneMap: Record<Tone, { bg: string; bar: string; fg: string }> = {
  navy: { bg: C.navyP, bar: C.navy, fg: C.navy },
  green: { bg: C.greenP, bar: C.green, fg: C.green },
  amber: { bg: C.amberP, bar: C.amber, fg: C.amber },
  gold: { bg: C.cream, bar: C.gold, fg: C.warnText },
};

function Line({ it }: { it: Item }) {
  const P = useOeParams();
  if (it.t === 'text')
    return <div style={{ fontSize: 13.5, lineHeight: 1.55, color: C.slate, margin: '5px 0 5px 2px' }}>{fill(it.v, P)}</div>;
  if (it.t === 'formula')
    return (
      <div style={{ margin: '7px 0', background: C.codeBg, borderRadius: RADIUS.sm, padding: '9px 13px',
        fontFamily: MONO, fontSize: 12.5, lineHeight: 1.5, color: '#E7E7E7', overflowX: 'auto',
        borderLeft: `3px solid ${C.gold}` }}>
        <span style={{ color: C.goldLight, fontWeight: 700, marginRight: 8 }}>ƒ</span>{fill(it.v, P)}
      </div>
    );
  if (it.t === 'table') return <StoryTable it={it} />;
  const tn = toneMap[it.tone ?? 'navy'];
  return (
    <div style={{ margin: '7px 0', background: tn.bg, borderLeft: `3px solid ${tn.bar}`, borderRadius: RADIUS.sm,
      padding: '8px 12px', display: 'flex', gap: 8 }}>
      <span style={{ color: tn.fg, fontWeight: 800, flexShrink: 0 }}>▸</span>
      <span style={{ fontSize: 13, lineHeight: 1.5, color: C.slate }}>{fill(it.v, P)}</span>
    </div>
  );
}

// pale-bg + saturated-text tints for emphasised cells (Action / allocation channel) — both colours set directly, high contrast
const cellTint: Record<Tint, { bg: string; fg: string }> = {
  red: { bg: '#FBEAEA', fg: '#E0301E' },
  green: { bg: '#E7F3E7', fg: '#21A366' },
  amber: { bg: '#FBEBE1', fg: '#D04A02' },
  blue: { bg: '#F1F1F1', fg: C.navy },
  violet: { bg: '#F8E9EC', fg: '#9E2A3E' },
};

function StoryTable({ it }: { it: Extract<Item, { t: 'table' }> }) {
  const P = useOeParams();
  return (
    <div style={{ margin: '10px 0', overflowX: 'auto', border: `1px solid ${C.rule}`, borderRadius: RADIUS.md }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: SANS, fontSize: 12.5 }}>
        <thead>
          <tr>
            {it.head.map((h, i) => (
              <th key={i} style={{ background: C.headBg, color: C.muted, fontWeight: 700, textTransform: 'uppercase', fontSize: 11,
                letterSpacing: '.04em', textAlign: it.align?.[i] ?? 'left', padding: '10px 12px', whiteSpace: 'nowrap',
                borderBottom: `1px solid ${C.rule}` }}>{fill(h, P)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {it.rows.map((row, ri) => (
            <tr key={ri} style={{ background: C.white }}>
              {row.map((cell, ci) => {
                const v = typeof cell === 'string' ? cell : cell.v;
                const t = typeof cell === 'string' || !cell.tint ? undefined : cellTint[cell.tint];
                return (
                  <td key={ci} style={{ padding: '8px 12px', textAlign: it.align?.[ci] ?? 'left',
                    borderTop: `1px solid ${C.rule}`, whiteSpace: 'nowrap',
                    color: t?.fg ?? C.slate, background: t?.bg, fontWeight: t ? 800 : 400 }}>{fill(v, P)}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {it.caption && (
        <div style={{ padding: '8px 12px', fontSize: 11.5, lineHeight: 1.5, color: C.muted,
          borderTop: `1px solid ${C.rule}`, background: C.white }}>{fill(it.caption, P)}</div>
      )}
    </div>
  );
}

const PIPE = ['Run', 'Delivered', 'Filter', 'Segregate', 'Reserve', 'Cascade', '3 Steps', 'FEFO & orders', 'Disposition', 'RLM'];
const KPIS = [
  { v: '4', l: 'Allocation channels' },
  { v: '4', l: 'cascade runs' },
  { v: '3', l: 'engine steps' },
  { v: '3', l: 'MRP price bands' },
  { v: 'DRR × RF', l: 'Step-1 fair share' },
  { v: 'FEFO', l: 'SKU / batch output' },
];

export default function StoryPage({ onNav }: { onNav?: (p: Page) => void }) {
  const P = useOeParams();
  const [showFlow, setShowFlow] = useState(false);
  return (
    <div style={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
      {/* hero */}
      <div style={{ background: `linear-gradient(135deg, ${C.navyDark} 0%, ${C.navy} 62%, #464646 100%)`,
        color: '#fff', padding: '38px 32px 30px', borderBottom: `3px solid ${C.gold}` }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: C.goldLight }}>
            How it works
          </div>
          {/* product name, with "AI" in gold */}
          <h1 style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 33, margin: '8px 0 10px', lineHeight: 1.12, textWrap: 'balance', color: '#fff' }}>
            <b style={{ color: C.gold, fontWeight: 800 }}>AI</b> Order Optimizer, end to end
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,0.88)', maxWidth: 780, margin: 0 }}>
            The data team delivers the SOQ (with per-line gate flags), the DB stock, the batch-level CFA inventory, the
            daily run rate and the masters. One run — stamped with today’s date — FILTERS the SOQ to the DBs in scope,
            then, for every CFA in parallel, segregates the DBs by channel, reserves the stock by channel × price band,
            runs a cascade of four channel-runs (each a three-step allocation, Step 1 sharing stock by sales speed),
            builds the trucks, turns the result into FEFO picks and orders, and routes each truck to a sales order or
            to RLM.
          </p>
          {/* KPI strip */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 20 }}>
            {KPIS.map((k) => (
              <div key={k.l} style={{ background: 'rgba(255,255,255,0.09)', border: '1px solid rgba(255,255,255,0.16)',
                borderRadius: RADIUS.md, padding: '10px 16px', minWidth: 120 }}>
                <div style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 22, color: C.goldLight, lineHeight: 1 }}>{k.v}</div>
                <div style={{ fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.72)', marginTop: 4 }}>{k.l}</div>
              </div>
            ))}
          </div>
          {onNav && (
            <button onClick={() => onNav('schema')}
              style={{ marginTop: 20, display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                padding: '10px 18px', fontSize: 13, fontWeight: 800, fontFamily: SANS, color: C.navy,
                background: C.goldLight, border: 'none', borderRadius: RADIUS.md, boxShadow: SHADOW.sm }}>
              📊 View the Data Model — every table · column · data type →
            </button>
          )}
          <button onClick={() => setShowFlow((v) => !v)}
            style={{ marginTop: 20, marginLeft: onNav ? 10 : 0, display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
              padding: '10px 18px', fontSize: 13, fontWeight: 800, fontFamily: SANS, color: '#fff',
              background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.38)', borderRadius: RADIUS.md }}>
            🗺 {showFlow ? 'Hide' : 'View'} pipeline flowchart {showFlow ? '↑' : '↓'}
          </button>
        </div>
      </div>

      {showFlow && (
        <div style={{ maxWidth: 1180, margin: '0 auto', padding: 'clamp(12px, 4vw, 24px) clamp(12px, 4vw, 32px) clamp(92px, 8vw, 92px)' }}>
          <PipelineFlow />
        </div>
      )}

      <div style={{ maxWidth: 1080, margin: '0 auto', padding: 'clamp(13px, 4vw, 26px) clamp(12px, 4vw, 32px) clamp(92px, 8vw, 92px)' }}>
        {/* pipeline strip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 26 }}>
          {PIPE.map((s, i) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.white,
                border: `1px solid ${C.rule}`, borderRadius: 999, padding: '6px 14px 6px 8px', boxShadow: SHADOW.sm }}>
                <span style={{ width: 22, height: 22, borderRadius: '50%', background: C.navy, color: '#fff',
                  fontFamily: SERIF, fontWeight: 700, fontSize: 12.5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: C.navy }}>{s}</span>
              </div>
              {i < PIPE.length - 1 && <span style={{ color: C.gold, fontWeight: 800, fontSize: 15 }}>→</span>}
            </div>
          ))}
        </div>

        {/* phase cards */}
        {PHASES.map((p) => (
          <div key={p.n} style={{ marginBottom: 18, border: `1px solid ${C.rule}`, borderRadius: RADIUS.lg,
            boxShadow: SHADOW.md, overflow: 'hidden', background: C.white }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 20px',
              background: C.cream, borderBottom: `1px solid ${C.rule}`, borderLeft: `5px solid ${p.accent}` }}>
              <span style={{ width: 34, height: 34, borderRadius: '50%', background: C.navy, color: '#fff', flexShrink: 0,
                fontFamily: SERIF, fontWeight: 700, fontSize: 17, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{p.n}</span>
              <div>
                <div style={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 19, lineHeight: 1.1 }}>{p.title}</div>
                <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>{fill(p.tag, P)}</div>
              </div>
            </div>
            <div style={{ padding: '16px 20px' }}>
              {p.steps.map((s, si) => (
                <div key={si} style={{ marginBottom: si < p.steps.length - 1 ? 18 : 0 }}>
                  <div style={{ display: 'inline-block', fontWeight: 800, color: C.navy, fontSize: 13,
                    letterSpacing: '.02em', borderBottom: `2px solid ${C.gold}`, paddingBottom: 2, marginBottom: 8 }}>{s.title}</div>
                  {s.items.map((it, ii) => <Line key={ii} it={it} />)}
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* guarantees */}
        <div style={{ marginTop: 24, border: `1px solid ${C.rule}`, borderRadius: RADIUS.lg, boxShadow: SHADOW.md,
          overflow: 'hidden', background: C.white }}>
          <div style={{ padding: '12px 20px', background: C.green, color: '#fff', display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 17 }}>Guarantees</span>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.82)' }}>what always holds after a run</span>
          </div>
          <div style={{ padding: '14px 20px' }}>{GUARANTEES.map((it, i) => <Line key={i} it={it} />)}</div>
        </div>

        <div style={{ marginTop: 22, fontSize: 12, color: C.muted, textAlign: 'center' }}>
          AI Order Optimizer · sample data
        </div>
      </div>
    </div>
  );
}
