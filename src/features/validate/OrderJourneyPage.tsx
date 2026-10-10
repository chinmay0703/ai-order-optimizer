import { Fragment, useEffect, useMemo, useState } from 'react';
import { Box, LinearProgress } from '@mui/material';
import { api } from '../../api';
import PageIntro from '../../shared/PageIntro';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';

/* ---------------------------------------------------------------------------
   Order Journey — end-to-end read of a distributor's order.
     • Reg-zsku SUMMARY (demand / stock / owner-centric used-as) is exact from
       /uat_report_v2 (the completed report, untouched).
     • The TRUCKS (real, from truck_plan_by_run) + which reg-zskus rode each one
       (owner-centric, from actual_order_quantity) come from /order_journey_trucks.
   Pick a distributor → pick a truck → see exactly what that truck carried.
--------------------------------------------------------------------------- */
type Cell = string | number | boolean | null;
interface Payload { date?: string; cols: string[]; rows: Cell[][]; total: number; filtered: number }

interface TLine { rz: string; receiver: string; sku: string; batch: string; source: string; cases: number; dte: number | null }
interface Truck { truck: number; cases: number; capacity: number; fill_pct: number; so_flag: string; truck_type: string; lines: TLine[] }
type TruckMap = Record<string, Truck[]>;
interface Cluster { code: string; primary_cap: number; primary_trucks: number; cluster_load: number; members: { db: string; shipped: number }[] }

interface SkuLine { sku: string; batch: string; desc: string; oeid: string; qty: number }
interface Reg {
  rz: string; desc: string; soq: number; norm: number; soh: number; sit: number;
  origB: number; subB: number; filB: number; origA: number; subA: number; filA: number; afterTot: number; drop: string; skus: SkuLine[];
}
type Status = 'SO' | 'Transship' | 'Mixed' | 'RLM' | 'Shift' | 'NoStock' | 'Dropped' | 'Before';
interface Dist {
  code: string; name: string; orderType: string; input: boolean; remark: string; shipType: string;
  regs: Reg[]; status: Status; shipped: number; soq: number;
}

const ST: Record<Status, { label: string; note: string; accent: string; pale: string }> = {
  SO: { label: 'SO Created', note: 'direct order · shipped', accent: C.success, pale: C.greenP },
  Transship: { label: 'Transshipment', note: 'ships via a cluster primary truck', accent: C.navy, pale: C.navyP },
  Mixed: { label: 'SO + RLM · held', note: 'a sibling truck is pending RLM', accent: C.gold, pale: C.amberP },
  RLM: { label: 'RLM Truck', note: 'held for truck approval', accent: C.warnText, pale: C.amberP },
  Shift: { label: '2nd-CFA Shift', note: 'shifted to a secondary CFA', accent: C.navy, pale: C.navyP },
  NoStock: { label: 'No CFA stock', note: 'entered the engine, nothing to allocate', accent: C.muted, pale: C.panelBg },
  Dropped: { label: 'Dropped < 65%', note: 'truck fill floor not met', accent: C.alertRed, pale: C.redP },
  Before: { label: 'Dropped before engine', note: 'combined SOQ ≤ 65% / no demand', accent: C.muted, pale: C.panelBg },
};
const ORDER: Status[] = ['SO', 'Transship', 'Mixed', 'RLM', 'Shift', 'NoStock', 'Dropped', 'Before'];
// disposition of a truck (colour used ONLY on a small chip — the bar stays neutral so the page isn't a wall of green)
const DISP: Record<string, { label: string; c: string; pale: string }> = {
  SO_CREATION: { label: 'SO', c: C.success, pale: C.greenP }, TRUCK_APPROVED: { label: 'SO · RLM ok', c: C.success, pale: C.greenP }, SEC_CFA_REJECTED: { label: 'SO · shift', c: C.success, pale: C.greenP },
  RLM_TRUCK_APPROVAL: { label: 'RLM held', c: C.warnText, pale: C.amberP }, TRUCK_REJECTED: { label: 'RLM rejected', c: C.alertRed, pale: C.redP },
  RLM_FOR_SECOND_CFA: { label: 'shift 2nd CFA', c: C.navy, pale: C.navyP }, RLM_SHIFTED: { label: 'shifted', c: C.navy, pale: C.navyP },
};
const disp = (f: string) => DISP[(f || '').toUpperCase()] || { label: f || 'ships', c: C.muted, pale: C.panelBg };
// merge a truck's raw lines into ONE row per reg-zsku × SKU × batch with the owner-centric used-as split (like the
// report's "Used as Original / Substitute / Filler"), keeping which demand line each lent sub/filler served
interface MLine { rz: string; sku: string; batch: string; orig: number; sub: number; fil: number; total: number; served: string[] }
function mergeLines(lines: TLine[]): MLine[] {
  const m = new Map<string, MLine>();
  for (const ln of lines) {
    const key = `${ln.rz}|${ln.sku}|${ln.batch}`;
    let e = m.get(key);
    if (!e) { e = { rz: ln.rz, sku: ln.sku, batch: ln.batch, orig: 0, sub: 0, fil: 0, total: 0, served: [] }; m.set(key, e); }
    if (ln.source === 'Substitute') { e.sub += ln.cases; if (ln.receiver && ln.receiver !== ln.rz) e.served.push(`sub ${ln.cases}→${ln.receiver}`); }
    else if (ln.source === 'Filler') { e.fil += ln.cases; if (ln.receiver && ln.receiver !== ln.rz) e.served.push(`filler ${ln.cases}→${ln.receiver}`); }
    else e.orig += ln.cases;
    e.total += ln.cases;
  }
  return Array.from(m.values()).sort((a, b) => a.rz.localeCompare(b.rz) || a.sku.localeCompare(b.sku));
}
// one row per REG-ZSKU (its owner-centric used-as split), expandable to its SKU · batch lines
interface RegGroup { rz: string; orig: number; sub: number; fil: number; total: number; served: string[]; skus: MLine[] }
function mergeByReg(lines: TLine[]): RegGroup[] {
  const byRz = new Map<string, RegGroup>();
  for (const m of mergeLines(lines)) {
    let g = byRz.get(m.rz);
    if (!g) { g = { rz: m.rz, orig: 0, sub: 0, fil: 0, total: 0, served: [], skus: [] }; byRz.set(m.rz, g); }
    g.orig += m.orig; g.sub += m.sub; g.fil += m.fil; g.total += m.total; g.served.push(...m.served); g.skus.push(m);
  }
  return Array.from(byRz.values()).sort((a, b) => a.rz.localeCompare(b.rz));
}
// the owner-centric used-as triple (original · substitute · filler), like the report
const Tri = ({ o, s, f }: { o: number; s: number; f: number }) => (
  <Box component="span" sx={{ fontFamily: MONO, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
    <Box component="span" sx={{ color: o ? C.slate : C.rule, fontWeight: o ? 700 : 400 }} title="used as original">{o}</Box>
    <Box component="span" sx={{ color: C.rule }}> · </Box>
    <Box component="span" sx={{ color: s ? C.success : C.rule, fontWeight: s ? 700 : 400 }} title="used as substitute (lent)">{s}</Box>
    <Box component="span" sx={{ color: C.rule }}> · </Box>
    <Box component="span" sx={{ color: f ? C.gold : C.rule, fontWeight: f ? 700 : 400 }} title="used as filler (lent)">{f}</Box>
  </Box>
);

// load every report line for the header CFA (the backend caches the full sheet per date) — never a first-N slice, or the
// funnel and the distributor list silently miss every distributor whose lines fall past the cut
const ALL_LINES = 1_000_000;
// in-engine outcomes, in funnel order — they partition "Input to AIDEN" (Before is the pre-engine branch, shown apart)
const ENGINE_OUTCOMES: Status[] = ORDER.filter((s) => s !== 'Before');
const nf = (n: unknown) => (Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString() : '');
const num = (v: Cell) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const txt = (v: Cell) => (v === null || v === undefined ? '' : String(v)).trim();

function classify(remark: string, shipType: string, input: boolean): Status {
  const r = remark.toLowerCase();
  if (!input || r.startsWith('not input')) return 'Before';
  if (r.startsWith('drop')) return 'Dropped';
  if (r.startsWith('no allocation')) return 'NoStock';
  if (r.startsWith('mixed')) return 'Mixed';
  if (r.startsWith('rlm')) return 'RLM';
  if (r.startsWith('shift')) return 'Shift';
  return shipType.toLowerCase().startsWith('trans') ? 'Transship' : 'SO';
}

function groupDists(cols: string[], rows: Cell[][]): Dist[] {
  const at = (name: string) => cols.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
  const I = {
    code: at('Customer Code'), name: at('Customer Description'), otype: at('Order Type (PDP / Non-PDP)_DB'),
    input: at('Input to AIDEN_DB'), remark: at('Overall_remarks DB_Level'), ship: at('Shipment type_DB Level'),
    rz: at('Reg_ZSKU Code'), rzdesc: at('Old Material Description'),
    soq: at('SOQ_QTY_RegZSKU'), norm: at('Norms_QTY_RegZSKU'), soh: at('SOH_QTY_Reg_SKU'), sit: at('SIT_QTY_RegZSKU'),
    ob: at('AOQ_Prestine_QTY_RegZSKU'), sb: at('AOQ_Substitution_QTY_RegZSKU_Before_Truck fill'), fb: at('AOQ_Filler_QTY_RegZSKU_Before_Truck fill'),
    oa: at('AOQ_Prestine_QTY_RegZSKU_after_Truckfill'), sa: at('AOQ_Substitution_QTY_RegZSKU_after_truck_fill'), fa: at('AOQ_Filler_QTY_RegZSKU_after_Truckfill'),
    at_sku: at('AOQ_QTY_Total_after_Truck_Fill_SKU_Level'), drop: at('AOQ Drop reason Reg_ZSKU Level'),
    sku: at('SKU code'), batch: at('Batch code'), skudesc: at('SKU Description'), oeid: at('AiDEN Order ID'),
  };
  const byDb = new Map<string, Dist>();
  const regOf = new Map<string, Map<string, Reg>>();
  for (const r of rows) {
    const code = txt(r[I.code]);
    if (!byDb.has(code)) {
      byDb.set(code, { code, name: txt(r[I.name]) || '—', orderType: txt(r[I.otype]), input: txt(r[I.input]) === 'Yes', remark: txt(r[I.remark]), shipType: txt(r[I.ship]), regs: [], status: 'SO', shipped: 0, soq: 0 });
      regOf.set(code, new Map());
    }
    const regs = regOf.get(code)!;
    const rz = txt(r[I.rz]);
    if (rz && !regs.has(rz)) {
      regs.set(rz, { rz, desc: txt(r[I.rzdesc]), soq: num(r[I.soq]), norm: num(r[I.norm]), soh: num(r[I.soh]), sit: num(r[I.sit]), origB: num(r[I.ob]), subB: num(r[I.sb]), filB: num(r[I.fb]), origA: num(r[I.oa]), subA: num(r[I.sa]), filA: num(r[I.fa]), afterTot: 0, drop: txt(r[I.drop]), skus: [] });
    }
    if (rz) {
      const reg = regs.get(rz)!;
      const sku = txt(r[I.sku]);
      if (sku) { reg.skus.push({ sku, batch: txt(r[I.batch]), desc: txt(r[I.skudesc]), oeid: txt(r[I.oeid]), qty: num(r[I.at_sku]) }); reg.afterTot += num(r[I.at_sku]); }
    }
  }
  const out: Dist[] = [];
  for (const [code, d] of byDb) {
    d.regs = Array.from(regOf.get(code)!.values()).sort((a, b) => b.soq - a.soq || a.rz.localeCompare(b.rz));
    d.shipped = d.regs.reduce((s, r) => s + r.afterTot, 0);
    d.soq = d.regs.reduce((s, r) => s + r.soq, 0);
    d.status = classify(d.remark, d.shipType, d.input);
    out.push(d);
  }
  return out.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.shipped - a.shipped || a.code.localeCompare(b.code));
}

/* ── atoms (module-level = stable identity; the search input keeps focus while typing) ── */
const Eyebrow = ({ children }: { children: React.ReactNode }) => (
  <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.11em', textTransform: 'uppercase', color: C.gold }}>{children}</Box>
);
const Chip = ({ s }: { s: Status }) => (
  <Box component="span" sx={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', px: 0.9, py: '2px', borderRadius: 999, whiteSpace: 'nowrap', bgcolor: ST[s].pale, color: ST[s].accent }}>{ST[s].label}</Box>
);
const Dot = ({ c }: { c: string }) => (<Box component="span" sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: c, flexShrink: 0 }} />);
const Shell = ({ children }: { children: React.ReactNode }) => (
  <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
    <Box sx={{ maxWidth: 1560, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
      <Eyebrow>Reports · Order Journey · end-to-end fulfilment trace</Eyebrow>
      <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: '6px 0 8px' }}>Order Journey</Box>
      {children}
    </Box>
  </Box>
);

export default function OrderJourneyPage({ date, cfa }: { date?: string; cfa?: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [tm, setTm] = useState<TruckMap>({});
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Status | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [selCluster, setSelCluster] = useState<string | null>(null);
  const [selTruck, setSelTruck] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    Promise.all([
      api.uatReportV2({ date, cfa, limit: ALL_LINES, offset: 0 }),   // EVERY line for the CFA — the funnel + list need all distributors
      api.orderJourneyTrucks({ date, cfa }).catch(() => ({ dbs: {}, clusters: [] })),
    ])
      .then(([rep, tk]) => { if (alive) { const t = tk as { dbs?: TruckMap; clusters?: Cluster[] }; setData(rep as Payload); setTm(t.dbs || {}); setClusters(t.clusters || []); setSel(null); setSelCluster(null); setFilter(null); setSelTruck(null); } })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [date, cfa, nonce]);

  const dists = useMemo(() => (data ? groupDists(data.cols, data.rows) : []), [data]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {}; let input = 0, shipped = 0;
    for (const d of dists) { c[d.status] = (c[d.status] || 0) + 1; if (d.input) input++; if (d.shipped > 0) shipped++; }
    return { byStatus: c, total: dists.length, input, shipped, dropped: dists.length - input };
  }, [dists]);
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return dists.filter((d) => (!filter || d.status === filter) && (!term || d.code.toLowerCase().includes(term) || d.name.toLowerCase().includes(term) || ST[d.status].label.toLowerCase().includes(term) || d.regs.some((r) => r.rz.toLowerCase().includes(term))));
  }, [dists, q, filter]);
  const clusteredDbs = useMemo(() => new Set(clusters.flatMap((c) => c.members.map((m) => m.db))), [clusters]);
  const curCluster = useMemo(() => clusters.find((c) => c.code === selCluster) || null, [clusters, selCluster]);
  const cur = useMemo(() => (selCluster ? null : (dists.find((d) => d.code === sel) || list[0] || dists[0] || null)), [dists, list, sel, selCluster]);
  const curTrucks = useMemo(() => (cur ? tm[cur.code] || [] : []), [cur, tm]);
  // default-select the first truck whenever the distributor (or its trucks) change
  useEffect(() => { setSelTruck(curTrucks.length ? curTrucks[0].truck : null); }, [cur?.code, curTrucks.length]);
  const distByCode = useMemo(() => { const m = new Map<string, Dist>(); dists.forEach((d) => m.set(d.code, d)); return m; }, [dists]);

  if (err) return <Shell><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (loading && !data) return <Shell><PageSkeleton kpis={4} rows={10} /></Shell>;
  if (!data || dists.length === 0) return <Shell><EmptyState title="No distributors in this run" hint="Nothing was returned for this run date / CFA. Try another run date, pick a CFA in the header, or run the pipeline first." /></Shell>;

  const truncated = data.total > data.rows.length;

  return (
    <Shell>
      <PageIntro>
        Pick a distributor, then a <b>truck</b> — the panel below shows exactly what that truck carried, reg-zsku by SKU,
        with the <b>owner-centric</b> used-as (original / substitute / filler). Reg-zsku demand &amp; stock come from
        <b> Allocation Report</b>; the trucks and their contents come from the engine truck plan. Scoped to the header
        CFA{truncated ? ' · partial load — some lines were not returned' : ''}.
      </PageIntro>

      {/* funnel */}
      <Box sx={{ bgcolor: C.white, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.lg}px`, boxShadow: SHADOW.sm, p: { xs: 1.5, md: 2 }, mt: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5, pb: 1.25, borderBottom: `1px solid ${C.rule}` }}>
          <Eyebrow>Distributor funnel</Eyebrow>
          <Box sx={{ ml: 'auto', fontFamily: MONO, fontSize: 12, fontWeight: 700, color: C.navy, bgcolor: C.cream, px: 1.25, py: 0.4, borderRadius: 999 }}>CFA {cfa || 'all'} · {data.date ?? ''}</Box>
        </Box>
        {(() => {
          // STEP CARD — a count that (optionally) filters the distributor list below when clicked
          const Card = ({ label, v, fg, status, big, hint }: { label: string; v: number; fg: string; status?: Status; big?: boolean; hint?: string }) => {
            const on = !!status && filter === status;
            return (
              <Box onClick={status ? () => setFilter(on ? null : status) : undefined} title={hint}
                sx={{ flex: big ? '1 1 150px' : '1 1 96px', cursor: status ? 'pointer' : 'default', bgcolor: big ? C.cream : C.white,
                  border: `1px solid ${C.rule}`, borderLeft: `3px solid ${fg}`, borderRadius: `${RADIUS.md}px`, p: big ? 1.25 : 1,
                  boxShadow: on ? `0 0 0 2px ${fg}` : SHADOW.sm, transition: '.12s', ...(status ? { '&:hover': { transform: 'translateY(-1px)' } } : {}) }}>
                <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: big ? 30 : 22, lineHeight: 1, color: fg }}>{nf(v)}</Box>
                <Box sx={{ fontSize: big ? 10.5 : 9.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: C.muted, mt: 0.5 }}>{label}</Box>
              </Box>
            );
          };
          const Op = ({ t }: { t: string }) => <Box sx={{ alignSelf: 'center', fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: C.muted, px: 0.25 }}>{t}</Box>;
          const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
            <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'stretch', flexWrap: 'wrap' }}>
              <Box sx={{ width: 150, flexShrink: 0, alignSelf: 'center' }}>
                <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.gold }}>Step {n}</Box>
                <Box sx={{ fontSize: 12.5, fontWeight: 700, color: C.navy }}>{title}</Box>
              </Box>
              <Box sx={{ flex: 1, display: 'flex', gap: 0.75, flexWrap: 'wrap', alignItems: 'stretch' }}>{children}</Box>
            </Box>
          );
          const outcomes = ENGINE_OUTCOMES.filter((st) => counts.byStatus[st]);
          return (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
              <Step n={1} title="Demand gate (before the engine)">
                <Card big label="Distributors (SOQ)" v={counts.total} fg={C.navy} hint="every distributor in this CFA's SOQ" />
                <Op t="=" />
                <Card big label="Dropped before engine" v={counts.dropped} fg={C.warnText} status="Before" hint="Input to AIDEN = No — combined SOQ not > 65% / single-distributor cluster / no demand" />
                <Op t="+" />
                <Card big label="Input to AIDEN" v={counts.input} fg={C.success} hint="Input to AIDEN = Yes — entered the allocation engine" />
              </Step>
              <Step n={2} title={`What happened to the ${nf(counts.input)} input to AIDEN`}>
                {outcomes.length
                  ? outcomes.map((st, i) => (
                    <Fragment key={st}>
                      {i > 0 && <Op t="+" />}
                      <Card label={ST[st].label} v={counts.byStatus[st]} fg={ST[st].accent} status={st} hint={ST[st].note} />
                    </Fragment>
                  ))
                  : <Box sx={{ alignSelf: 'center', fontSize: 12.5, color: C.muted }}>no distributor entered the engine</Box>}
              </Step>
              <Step n={3} title="Shipped">
                <Card big label="Shipped (> 0 cases)" v={counts.shipped} fg={C.success} hint="input distributors with at least one case on a truck after the truck fill" />
                <Box sx={{ alignSelf: 'center', fontSize: 12, color: C.muted }}>
                  of {nf(counts.input)} input to AIDEN{counts.input - counts.shipped > 0 ? ` · ${nf(counts.input - counts.shipped)} ship nothing (dropped / no stock / held)` : ''}
                </Box>
              </Step>
            </Box>
          );
        })()}
      </Box>

      {/* split */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '320px 1fr' }, gap: 2, mt: 2, alignItems: 'start' }}>
        <Box sx={{ bgcolor: C.white, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.lg}px`, boxShadow: SHADOW.sm, overflow: 'hidden' }}>
          <Box sx={{ p: 1.5, borderBottom: `1px solid ${C.rule}`, display: 'flex', alignItems: 'center', gap: 1 }}>
            <Eyebrow>Pick one</Eyebrow><Box component="h2" sx={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: C.navy, m: 0 }}>Distributors</Box>
            <Box sx={{ ml: 'auto', fontFamily: MONO, fontSize: 11.5, color: C.muted }}>{list.length}/{counts.total}</Box>
          </Box>
          <Box sx={{ px: 1.25, pt: 1.25, display: 'flex', gap: 0.75 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="code / name / status / reg-zsku…" style={{ flex: 1, minWidth: 0, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm, padding: '7px 10px', fontFamily: MONO, fontSize: 12.5, color: C.slate, background: C.white }} />
            {filter && <button type="button" onClick={() => setFilter(null)} title="clear status filter" style={{ border: `1px solid ${C.rule}`, background: C.white, color: C.navy, borderRadius: RADIUS.sm, fontSize: 12, fontWeight: 700, cursor: 'pointer', padding: '0 10px' }}>✕</button>}
          </Box>
          <Box sx={{ maxHeight: '64vh', overflow: 'auto', px: 1, pt: 0.5, pb: 1.25 }}>
            {/* TRANSSHIPMENT CLUSTERS — multiple DBs consolidate into one combined primary truck; open a cluster to see its members */}
            {clusters.length > 0 && (
              <Box sx={{ mb: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.9, px: 0.5, py: 0.75, position: 'sticky', top: 0, zIndex: 1, bgcolor: C.white, borderBottom: `1px solid ${C.rule}` }}>
                  <Dot c={C.navy} /><Box sx={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.muted }}>Transshipment clusters</Box>
                  <Box sx={{ ml: 'auto', fontFamily: MONO, fontSize: 11, color: C.muted }}>{clusters.length}</Box>
                </Box>
                {clusters.map((cl) => {
                  const on = selCluster === cl.code;
                  return (
                    <Box key={cl.code} onClick={() => { setSelCluster(cl.code); setSel(null); }} sx={{ px: 1, py: 0.85, borderRadius: `${RADIUS.sm}px`, cursor: 'pointer', borderLeft: `2px solid ${on ? C.navy : 'transparent'}`, bgcolor: on ? C.navyP : 'transparent', my: '1px', '&:hover': { bgcolor: on ? C.navyP : C.panelBg } }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                        <span style={{ fontSize: 13 }}>🚚</span>
                        <Box sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 700, color: C.navy }}>Cluster {cl.code}</Box>
                        <Box sx={{ ml: 'auto', fontFamily: MONO, fontSize: 10.5, color: C.muted }}>{cl.members.length} DB · {cl.primary_trucks} pri</Box>
                      </Box>
                      <Box sx={{ fontSize: 11, color: C.muted, mt: 0.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cl.members.map((m) => m.db).join(' · ')}</Box>
                    </Box>
                  );
                })}
              </Box>
            )}
            {list.filter((d) => !clusteredDbs.has(d.code)).length === 0 && clusters.length === 0 && <Box sx={{ p: 2, fontSize: 12.5, color: C.muted }}>No distributors match.</Box>}
            {ORDER.filter((s) => list.some((d) => d.status === s && !clusteredDbs.has(d.code))).map((s) => (
              <Box key={s}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.9, px: 0.5, py: 0.75, position: 'sticky', top: 0, zIndex: 1, bgcolor: C.white, borderBottom: `1px solid ${C.rule}` }}>
                  <Dot c={ST[s].accent} /><Box sx={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.muted }}>{ST[s].label}</Box>
                  <Box sx={{ ml: 'auto', fontFamily: MONO, fontSize: 11, color: C.muted }}>{list.filter((d) => d.status === s && !clusteredDbs.has(d.code)).length}</Box>
                </Box>
                {list.filter((d) => d.status === s && !clusteredDbs.has(d.code)).map((d) => {
                  const on = !selCluster && cur?.code === d.code;
                  return (
                    <Box key={d.code} onClick={() => { setSel(d.code); setSelCluster(null); }} sx={{ px: 1, py: 0.85, borderRadius: `${RADIUS.sm}px`, cursor: 'pointer', borderLeft: `2px solid ${on ? C.navy : 'transparent'}`, bgcolor: on ? C.cream : 'transparent', my: '1px', '&:hover': { bgcolor: on ? C.cream : C.panelBg } }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                        <Box sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 700, color: C.navy }}>{d.code}</Box>
                        <Box sx={{ ml: 'auto', fontFamily: MONO, fontSize: 10.5, color: C.muted, flexShrink: 0 }}>{d.shipped > 0 ? `${nf(d.shipped)} cs` : `SOQ ${nf(d.soq)}`}</Box>
                      </Box>
                      <Box sx={{ fontSize: 11.5, color: C.muted, mt: 0.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</Box>
                    </Box>
                  );
                })}
              </Box>
            ))}
          </Box>
        </Box>

        <Box sx={{ minWidth: 0 }}>
          {curCluster
            ? <ClusterView cl={curCluster} tm={tm} distByCode={distByCode} onOpenDb={(code) => { setSel(code); setSelCluster(null); }} />
            : cur ? <Detail d={cur} trucks={curTrucks} selTruck={selTruck} setSelTruck={setSelTruck} /> : null}
        </Box>
      </Box>

      {loading && <LinearProgress sx={{ position: 'fixed', top: 0, left: 0, right: 0, height: 3, zIndex: 20, bgcolor: 'transparent', '& .MuiLinearProgress-bar': { bgcolor: C.gold } }} />}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.rule}`, mt: 3, pt: 1, fontSize: 9, color: C.muted }}>
        <span>PepsiCo AIDEN · Order Journey · reg-zsku from the Allocation Report · trucks from the engine truck plan · owner-centric</span>
        <span>CFA {cfa || 'all'} · {data.date ?? ''}</span>
      </Box>
    </Shell>
  );
}

/* ── CLUSTER view — the combined primary truck + each member DB's secondary trucks ── */
function ClusterView({ cl, tm, distByCode, onOpenDb }: { cl: Cluster; tm: TruckMap; distByCode: Map<string, Dist>; onOpenDb: (code: string) => void }) {
  const priCap = cl.primary_trucks * cl.primary_cap;
  const priFr = priCap > 0 ? Math.max(0, Math.min(100, Math.round((cl.cluster_load / priCap) * 100))) : 0;
  return (
    <Box sx={{ bgcolor: C.white, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.lg}px`, boxShadow: SHADOW.sm, overflow: 'hidden' }}>
      <Box sx={{ p: { xs: 1.5, md: 2 }, borderBottom: `1px solid ${C.rule}` }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 17 }}>🚚</span>
          <Box sx={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: C.navy }}>Cluster {cl.code}</Box>
          <Chip s="Transship" />
          <Box sx={{ fontSize: 12, color: C.muted }}><b style={{ color: C.slate }}>{cl.members.length}</b> distributors consolidate into <b style={{ color: C.slate }}>{cl.primary_trucks}</b> combined primary truck{cl.primary_trucks === 1 ? '' : 's'}</Box>
        </Box>
      </Box>

      {/* combined primary truck */}
      <Box sx={{ p: { xs: 1.5, md: 2 }, borderBottom: `1px solid ${C.rule}`, bgcolor: C.panelBg }}>
        <Box sx={{ mb: 0.75 }}><Eyebrow>Combined primary truck{cl.primary_trucks === 1 ? '' : 's'}</Eyebrow></Box>
        <Box sx={{ p: 1.1, bgcolor: C.white, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px` }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, mb: 0.55 }}>
            <span style={{ fontSize: 15 }}>🚚</span>
            <Box sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 800, color: C.navy }}>Primary ×{cl.primary_trucks}</Box>
            <Box component="span" sx={{ fontFamily: MONO, fontSize: 12, color: C.muted }}><b style={{ color: C.slate }}>{nf(cl.cluster_load)}</b>/{nf(priCap)} cs</Box>
            <Box sx={{ flex: 1 }} /><b style={{ fontFamily: MONO, color: C.navy }}>{priFr}%</b>
          </Box>
          <Box sx={{ position: 'relative', height: 16, bgcolor: C.headBg, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px`, overflow: 'hidden' }}>
            <Box sx={{ position: 'absolute', inset: 0, width: `${priFr}%`, background: `linear-gradient(180deg, ${C.navy}, ${C.navy}CC)` }} />
            <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: '65%', borderLeft: `1px dashed ${C.muted}`, opacity: 0.5 }} />
          </Box>
          <Box sx={{ fontSize: 11, color: C.muted, mt: 0.5 }}>{cl.primary_trucks} × {nf(cl.primary_cap)} cs — the fewest primary trucks each ≥ 65%.</Box>
        </Box>
      </Box>

      {/* member distributors + their secondary trucks */}
      <Box sx={{ p: { xs: 1.5, md: 2 } }}>
        <Box sx={{ mb: 0.75 }}><Eyebrow>Member distributors · secondary (last-mile) trucks</Eyebrow></Box>
        <Box sx={{ display: 'grid', gap: 0.85 }}>
          {cl.members.map((m) => {
            const d = distByCode.get(m.db);
            const trucks = tm[m.db] || [];
            return (
              <Box key={m.db} sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, p: 1.1, bgcolor: C.white }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.9, mb: trucks.length ? 0.7 : 0, flexWrap: 'wrap' }}>
                  <Box onClick={() => onOpenDb(m.db)} sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 700, color: C.navy, cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}>{m.db}</Box>
                  <Box sx={{ fontSize: 12, color: C.slate }}>{d?.name || ''}</Box>
                  <Box onClick={() => onOpenDb(m.db)} sx={{ fontSize: 10.5, fontWeight: 700, color: C.navy, cursor: 'pointer' }}>open →</Box>
                  <Box sx={{ ml: 'auto', fontFamily: MONO, fontSize: 11.5, color: C.muted }}>shipped <b style={{ color: C.slate }}>{nf(m.shipped)}</b> cs</Box>
                </Box>
                <Box sx={{ display: 'flex', gap: 0.6, flexWrap: 'wrap' }}>
                  {trucks.length === 0 && <Box sx={{ fontSize: 11.5, color: C.muted }}>No secondary truck built.</Box>}
                  {trucks.map((t) => {
                    const dd = disp(t.so_flag); const fr = Math.max(0, Math.min(100, Math.round(t.fill_pct)));
                    return (
                      <Box key={t.truck} onClick={() => onOpenDb(m.db)} title={`${t.truck_type} · ${dd.label}`} sx={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 0.5, border: `1px solid ${C.rule}`, borderRadius: 999, px: 0.9, py: '3px', bgcolor: C.cream, '&:hover': { bgcolor: C.panelBg } }}>
                        <span style={{ fontSize: 12 }}>🚛</span>
                        <Box sx={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: C.navy }}>T{t.truck}</Box>
                        <Box sx={{ fontFamily: MONO, fontSize: 10.5, color: C.muted }}>{nf(t.cases)}/{nf(t.capacity)} · {fr}%</Box>
                        <Box component="span" sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: dd.c }} />
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

/* ── DETAIL ─────────────────────────────────────────────────────────── */
function Detail({ d, trucks, selTruck, setSelTruck }: { d: Dist; trucks: Truck[]; selTruck: number | null; setSelTruck: (t: number | null) => void }) {
  const meta = ST[d.status];
  const fill = d.soq > 0 ? Math.round((d.shipped / d.soq) * 100) : 0;
  const [showAll, setShowAll] = useState(false);
  const [openReg, setOpenReg] = useState<string | null>(null);
  const truck = trucks.find((t) => t.truck === selTruck) || null;
  const regGroups = useMemo(() => (truck ? mergeByReg(truck.lines) : []), [truck]);
  useEffect(() => { setOpenReg(null); }, [selTruck, d.code]);
  const Metric = ({ k, v, fg }: { k: string; v: React.ReactNode; fg?: string }) => (
    <Box sx={{ flex: '1 1 92px', bgcolor: C.cream, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, p: 1 }}>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 19, lineHeight: 1, color: fg || C.navy }}>{v}</Box>
      <Box sx={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: C.muted, mt: 0.4 }}>{k}</Box>
    </Box>
  );

  return (
    <Box sx={{ bgcolor: C.white, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.lg}px`, boxShadow: SHADOW.sm, overflow: 'hidden' }}>
      {/* header */}
      <Box sx={{ p: { xs: 1.5, md: 2 }, borderBottom: `1px solid ${C.rule}` }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Box sx={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: C.navy }}>{d.code}</Box>
          <Chip s={d.status} />
          <Box component="span" sx={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: d.orderType === 'PDP' ? C.gold : C.muted, border: `1px solid ${C.rule}`, borderRadius: 999, px: 0.9, py: '2px' }}>{d.orderType || '—'}</Box>
          <Box sx={{ ml: 'auto', display: 'flex', gap: 0.75 }}>
            <Metric k="SOQ" v={nf(d.soq)} />
            <Metric k="Shipped" v={nf(d.shipped)} fg={d.shipped > 0 ? C.success : C.muted} />
            <Metric k="Fill %" v={`${fill}%`} fg={fill >= 90 ? C.success : fill >= 65 ? C.gold : C.alertRed} />
          </Box>
        </Box>
        <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 18, color: C.navy, mt: 0.6 }}>{d.name}</Box>
        <Box sx={{ fontSize: 12, color: C.muted, mt: 0.25 }}>{meta.note} · <b style={{ color: C.slate }}>{d.remark}</b></Box>
      </Box>

      {/* trucks — selectable; the first is selected by default */}
      <Box sx={{ p: { xs: 1.5, md: 2 }, borderBottom: `1px solid ${C.rule}`, bgcolor: C.panelBg }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Eyebrow>Trucks</Eyebrow>
          <Box sx={{ fontSize: 11.5, color: C.muted }}>click a truck — the contents below are for the <b style={{ color: C.slate }}>selected</b> one</Box>
        </Box>
        {trucks.length === 0 ? (
          <Box sx={{ fontSize: 12, color: C.muted, bgcolor: C.white, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, p: 1.25 }}>No truck built — nothing shipped for this distributor.</Box>
        ) : (
          <Box sx={{ display: 'flex', gap: 0.85, flexWrap: 'wrap' }}>
            {trucks.map((t) => {
              const dd = disp(t.so_flag); const on = t.truck === selTruck; const fr = Math.max(0, Math.min(100, Math.round(t.fill_pct)));
              return (
                <Box key={t.truck} onClick={() => setSelTruck(t.truck)} sx={{ flex: '1 1 210px', minWidth: 190, cursor: 'pointer', p: 1, bgcolor: C.white, border: `1px solid ${on ? C.navy : C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: on ? `0 0 0 2px ${C.navy}22` : SHADOW.sm, transition: '.12s' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, mb: 0.6 }}>
                    <span style={{ fontSize: 14 }}>🚛</span>
                    <Box sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 800, color: C.navy }}>Truck {t.truck}</Box>
                    <Box sx={{ flex: 1 }} />
                    <Box component="span" sx={{ px: 0.75, py: '1px', borderRadius: 999, bgcolor: dd.pale, color: dd.c, fontSize: 9, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{dd.label}</Box>
                  </Box>
                  {/* neutral bar — colour lives on the chip, not the bar, so the page isn't a wall of green */}
                  <Box sx={{ position: 'relative', height: 14, bgcolor: C.headBg, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px`, overflow: 'hidden' }}>
                    <Box sx={{ position: 'absolute', inset: 0, width: `${fr}%`, background: on ? `linear-gradient(180deg, ${C.navy}, ${C.navy}CC)` : `linear-gradient(180deg, ${C.muted}, ${C.muted}CC)` }} />
                    <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: '65%', borderLeft: `1px dashed ${C.muted}`, opacity: 0.5 }} />
                  </Box>
                  <Box sx={{ display: 'flex', mt: 0.5, fontFamily: MONO, fontSize: 11, color: C.muted }}>
                    <span><b style={{ color: C.slate }}>{nf(t.cases)}</b>/{nf(t.capacity)} cs</span><Box sx={{ flex: 1 }} /><b style={{ color: on ? C.navy : C.slate }}>{fr}%</b>
                  </Box>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* selected truck contents (owner-centric, exactly what it carried) */}
      {truck && (
        <Box sx={{ p: { xs: 1.5, md: 2 }, borderBottom: `1px solid ${C.rule}` }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
            <Eyebrow>On truck {truck.truck}</Eyebrow>
            <Box sx={{ fontSize: 11.5, color: C.muted }}>{truck.truck_type || 'truck'} · <b style={{ color: disp(truck.so_flag).c }}>{disp(truck.so_flag).label}</b> · {nf(truck.cases)}/{nf(truck.capacity)} cs · click a reg-zsku for its SKU · batch</Box>
            <Box sx={{ ml: 'auto', fontFamily: MONO, fontSize: 11.5, color: C.muted }}>{regGroups.length} reg-zsku</Box>
          </Box>
          <Box sx={{ overflowX: 'auto', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px` }}>
            <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%', minWidth: 520, fontSize: 12 }}>
              <Box component="thead"><Box component="tr" sx={{ '& th': { bgcolor: C.cream, color: C.navy, fontWeight: 700, fontFamily: SANS, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.03em', textAlign: 'right', p: '7px 9px', whiteSpace: 'nowrap', borderBottom: `1px solid ${C.rule}` }, '& th:first-of-type': { textAlign: 'left' } }}>
                <Box component="th">Reg-zsku</Box><Box component="th" title="owner-centric: original · substitute · filler">Used as (orig · sub · fil)</Box><Box component="th">Cases</Box>
              </Box></Box>
              <Box component="tbody">
                {regGroups.map((g) => {
                  const open = openReg === g.rz;
                  return (
                    <Fragment key={g.rz}>
                      <Box component="tr" onClick={() => setOpenReg(open ? null : g.rz)} sx={{ cursor: 'pointer', bgcolor: open ? C.cream : 'transparent', '&:hover': { bgcolor: open ? C.cream : C.panelBg }, '& td': { p: '7px 9px', borderBottom: `1px solid ${C.rowLine}`, whiteSpace: 'nowrap', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }, '& td:first-of-type': { textAlign: 'left' } }}>
                        <Box component="td" sx={{ color: C.navy, fontWeight: 700 }}><Box component="span" sx={{ color: C.muted, fontSize: 10, mr: 0.5 }}>{open ? '▾' : '▸'}</Box>{g.rz}</Box>
                        <Box component="td"><Tri o={g.orig} s={g.sub} f={g.fil} /></Box>
                        <Box component="td" sx={{ fontWeight: 700, color: C.slate }}>{nf(g.total)}</Box>
                      </Box>
                      {open && g.skus.map((m, i) => (
                        <Box component="tr" key={i} sx={{ bgcolor: C.panelBg, '& td': { p: '5px 9px 5px 22px', borderBottom: `1px solid ${C.rowLine}`, whiteSpace: 'nowrap', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }, '& td:first-of-type': { textAlign: 'left' } }}>
                          <Box component="td"><b style={{ color: C.slate }}>{m.sku}</b> <span style={{ color: C.muted }}>· {m.batch || '—'}</span>{m.served.length > 0 && <Box sx={{ fontFamily: SANS, fontSize: 10, color: C.muted }}>{m.served.join(' · ')}</Box>}</Box>
                          <Box component="td"><Tri o={m.orig} s={m.sub} f={m.fil} /></Box>
                          <Box component="td" sx={{ fontWeight: 700, color: C.slate }}>{nf(m.total)}</Box>
                        </Box>
                      ))}
                    </Fragment>
                  );
                })}
              </Box>
            </Box>
          </Box>
        </Box>
      )}

      {/* whole-DB reg-zsku summary (V2) — collapsed by default to keep it clean */}
      <Box sx={{ p: { xs: 1.5, md: 2 } }}>
        <Box onClick={() => setShowAll((v) => !v)} sx={{ display: 'flex', alignItems: 'center', gap: 1, cursor: 'pointer' }}>
          <Eyebrow>All reg-zskus · whole DB</Eyebrow>
          <Box sx={{ fontSize: 11.5, color: C.muted }}>demand · stock · owner-centric used-as (before &amp; after truck fill)</Box>
          <Box sx={{ ml: 'auto', fontFamily: MONO, fontSize: 11.5, color: C.navy, fontWeight: 700 }}>{showAll ? '▾ hide' : `▸ show ${d.regs.length}`}</Box>
        </Box>
        {showAll && (
          <Box sx={{ overflowX: 'auto', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, mt: 1 }}>
            <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%', minWidth: 640, fontSize: 12 }}>
              <Box component="thead"><Box component="tr" sx={{ '& th': { bgcolor: C.cream, color: C.navy, fontWeight: 700, fontFamily: SANS, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.03em', textAlign: 'right', p: '7px 9px', whiteSpace: 'nowrap', borderBottom: `1px solid ${C.rule}` }, '& th:first-of-type': { textAlign: 'left' } }}>
                <Box component="th">Reg-zsku</Box><Box component="th">SOQ</Box><Box component="th">Norm</Box><Box component="th">SOH</Box><Box component="th">SIT</Box><Box component="th">Orig·Sub·Fil (aft)</Box><Box component="th">Shipped</Box>
              </Box></Box>
              <Box component="tbody">
                {d.regs.map((r) => (
                  <Box component="tr" key={r.rz} sx={{ '& td': { p: '6px 9px', borderBottom: `1px solid ${C.rowLine}`, whiteSpace: 'nowrap', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }, '& td:first-of-type': { textAlign: 'left' } }}>
                    <Box component="td"><Box sx={{ color: C.navy, fontWeight: 700 }}>{r.rz}</Box><Box sx={{ fontFamily: SANS, fontSize: 10.5, color: C.muted, maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.desc}</Box></Box>
                    <Box component="td">{r.soq}</Box><Box component="td" sx={{ color: C.muted }}>{r.norm}</Box><Box component="td" sx={{ color: C.muted }}>{r.soh}</Box><Box component="td" sx={{ color: C.muted }}>{r.sit}</Box>
                    <Box component="td"><span style={{ color: r.origA ? C.slate : C.rule, fontWeight: r.origA ? 700 : 400 }}>{r.origA}</span><span style={{ color: C.rule }}> · </span><span style={{ color: r.subA ? C.success : C.rule, fontWeight: r.subA ? 700 : 400 }}>{r.subA}</span><span style={{ color: C.rule }}> · </span><span style={{ color: r.filA ? C.gold : C.rule, fontWeight: r.filA ? 700 : 400 }}>{r.filA}</span></Box>
                    <Box component="td" sx={{ fontWeight: 700, color: r.afterTot ? C.success : C.muted }}>{r.afterTot || (r.drop ? <span title={r.drop} style={{ color: C.alertRed, fontFamily: SANS, fontSize: 10 }}>drop</span> : 0)}</Box>
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}
