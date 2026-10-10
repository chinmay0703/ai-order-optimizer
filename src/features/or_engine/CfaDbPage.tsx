import { Fragment, useEffect, useMemo, useState } from 'react';
import { Box, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { downloadXlsxMulti, ExportXlsxButton } from '../../shared/exportXlsx';
import { isTracked, trackedRowSxFor, TRACK_STAR } from '../../demo';
import PageIntro from '../../shared/PageIntro';
import { useOeParams, pct } from '../../shared/OeParams';

/* ---------------------------------------------------------------------------
   CFA × DB — combined allocation (everything summed across reg-zskus):
     top    : per CFA × DB        — SOQ, Norm, Original, Substitute, Filler, Total, Fill%
     bottom : per CFA × DB × Truck — cases, capacity, fill%, + original/sub/filler % of the lane load
   All live from /api/cfadb (Postgres). Nothing computed in the engine here — pure aggregation.
--------------------------------------------------------------------------- */
type Row = (string | number)[];
interface Payload {
  cfadb: { cols: string[]; rows: Row[] };
  trucks: { cols: string[]; rows: Row[] };
}
// cfadb cols: CFA ID, DB ID, DB_Tier, SOQ, Norm, Held, Original, Substitute, Filler, Total, stock, Channel,
//             Filler_Priority, Draw_Rank, Sum_Norm, Sum_Held, N_In_CFA
// `stock` = REAL demand on-hand (demand_by_run); the engine now inserts it BEFORE Channel, so Channel and every
// appended column shift by 1 vs the pre-cluster-trim payload — indices below already reflect the shift.
const D = { cfa: 0, db: 1, tier: 2, soq: 3, norm: 4, held: 5, orig: 6, sub: 7, fil: 8, tot: 9,
  stock: 10, channel: 11, prio: 12, rank: 13, snorm: 14, sheld: 15, ncfa: 16 };
const TW: Record<number, number> = { 1: 1.0, 2: 0.85, 3: 0.65, 4: 0.5 };   // DB-tier weight (T1..T4)
// truck cols: CFA ID, DB ID, Type, Truck, Cases, Capacity, Fill_Pct, SO_Flag, is_transhipment, primary_truck_count,
//             cluster_code, planned_cases, planned_fill_pct  (last two = PRE-cluster-trim "before"; == cases/fill for untrimmed lanes)
const T = { cfa: 0, db: 1, type: 2, truck: 3, cases: 4, cap: 5, fill: 6, flag: 7, tranship: 8, primCount: 9, cluster: 10,
  plannedCases: 11, plannedFill: 12 };

const nf = (n: number) => Math.round(n ?? 0).toLocaleString();
const pc = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const f1 = (n: number) => { const x = Math.round((n ?? 0) * 10) / 10; return Number.isInteger(x) ? `${x}` : x.toFixed(1); };
const ordinal = (n: number) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const num = { textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums', fontFamily: MONO, fontSize: 12.5, whiteSpace: 'nowrap' as const };

// a thin stacked composition bar: original (navy) · substitute (green) · filler (gold)
const Bar = ({ o, s, f }: { o: number; s: number; f: number }) => {
  const tot = o + s + f || 1;
  const seg = (v: number, color: string) => v > 0
    ? <Box sx={{ width: `${(v / tot) * 100}%`, bgcolor: color, height: '100%' }} /> : null;
  return (
    <Box sx={{ display: 'flex', width: 84, height: 9, borderRadius: 999, overflow: 'hidden', border: `1px solid ${C.rule}` }}>
      {seg(o, C.navy)}{seg(s, C.success)}{seg(f, C.gold)}
    </Box>
  );
};

// Page chrome — MODULE scope (not inside the component) so it isn't a new component identity every render;
// otherwise React remounts the subtree (search box + channel dropdown) each keystroke and the cursor drops.
const Shell = ({ children }: { children: React.ReactNode }) => (
  <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
    <Box sx={{ maxWidth: 1280, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
      <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>
        CFA × DB · combined allocation
      </Box>
      <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: '6px 0 8px' }}>
        Every CFA × DB, combined — and its trucks
      </Box>
      {children}
    </Box>
  </Box>
);

export default function CfaDbPage({ date }: { date?: string }) {
  const P = useOeParams();   // engine thresholds (oe_parameters) — never hardcode 90 / 65 / tier 4
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from data===null: an empty payload,
  const [err, setErr] = useState<string | null>(null);   // or a failure, would then spin forever
  const [nonce, setNonce] = useState(0);            // bumped by the error Retry to re-run the effect
  const [q, setQ] = useState('');
  const [ch, setCh] = useState('all');                 // channel filter
  const [open, setOpen] = useState<string | null>(null);   // which DB row's filler-rank drilldown is expanded

  useEffect(() => {
    let alive = true;
    setErr(null); setLoading(true);
    api.cfaDb(date).then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, nonce]);

  const needle = q.trim().toLowerCase();
  const channels = useMemo(() => Array.from(new Set(
    (data?.cfadb.rows ?? []).map((r) => String(r[D.channel])).filter(Boolean))).sort(), [data]);
  const dbChannel = useMemo(() => {                    // (cfa|db) -> channel, to filter the truck table too
    const m = new Map<string, string>();
    (data?.cfadb.rows ?? []).forEach((r) => m.set(`${r[D.cfa]}|${r[D.db]}`, String(r[D.channel])));
    return m;
  }, [data]);
  const cfadb = useMemo(() => (data?.cfadb.rows ?? []).filter(
    (r) => (!needle || `${r[D.cfa]} ${r[D.db]}`.toLowerCase().includes(needle))
        && (ch === 'all' || String(r[D.channel]) === ch)), [data, needle, ch]);
  const trucks = useMemo(() => (data?.trucks.rows ?? []).filter(
    (r) => (!needle || `${r[T.cfa]} ${r[T.db]}`.toLowerCase().includes(needle))
        && (ch === 'all' || dbChannel.get(`${r[T.cfa]}|${r[T.db]}`) === ch)), [data, needle, ch, dbChannel]);

  const kpi = useMemo(() => {
    const rows = data?.cfadb.rows ?? []; const tk = data?.trucks.rows ?? [];
    const soq = rows.reduce((a, r) => a + (r[D.soq] as number), 0);
    // SO_CREATION trucks = truly allocated (shipped). RLM_* trucks are ON HOLD until approved/rejected — NOT allocated.
    const isRlm = (f: string) => f === 'RLM_TRUCK_APPROVAL' || f === 'RLM_FOR_SECOND_CFA';
    const soCreated = tk.reduce((a, r) => a + (String(r[T.flag]) === 'SO_CREATION' ? (Number(r[T.cases]) || 0) : 0), 0);
    const rlmHeld = tk.reduce((a, r) => a + (isRlm(String(r[T.flag])) ? (Number(r[T.cases]) || 0) : 0), 0);
    return { pairs: rows.length, trucks: tk.length, soCreated, rlmHeld, fill: pc(soCreated, soq) };
  }, [data]);

  if (err) return <Shell><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (loading) return <Shell><PageSkeleton kpis={5} rows={9} /></Shell>;
  if (!data) return <Shell><EmptyState title="No allocation for this run"
    hint="Nothing was returned for this run date. Try another run date, or run the pipeline first." /></Shell>;
  // Loaded, but the run produced no lanes at all — an empty payload, not a filtered view (the tables keep their
  // own "No lanes match." message for when a search/channel filter empties them).
  if ((data.cfadb?.rows?.length ?? 0) === 0 && (data.trucks?.rows?.length ?? 0) === 0) return <Shell><EmptyState
    title="No CFA × DB lanes in this run"
    hint="The engine allocated nothing for this run date — no lanes and no trucks. Try another run date, or run the pipeline first." /></Shell>;

  const Kpi = ({ label, val, suffix, fg, bar }: { label: string; val: number; suffix?: string; fg: string; bar: string }) => (
    <Box sx={{ flex: 1, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${bar}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, p: 1.5, bgcolor: C.white }}>
      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted }}>{label}</Box>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 26, color: fg, lineHeight: 1.1 }}>{nf(val)}{suffix}</Box>
    </Box>
  );
  const th = (h: string, a: 'left' | 'right' = 'right') => (
    <TableCell key={h} align={a} sx={{ fontFamily: SANS, whiteSpace: 'nowrap' }}>{h}</TableCell>
  );

  return (
    <Shell>
      <PageIntro>
        Everything summed across reg-zskus. The top table is the combined order per <b>CFA × DB</b>; the bottom is the
        same lane broken into its <b>trucks</b>, each with the lane&apos;s <b>original / substitute / filler</b> mix.
        <b style={{ color: '#2D2D2D' }}> Draw rank</b> is the Step-3 order each DB claims the shared CFA filler pool —
        by <b>filler priority = (Σnorm ÷ Σheld) × tier weight</b>, Σheld = stock + original + substitute (highest draws first).
        The bar shows the mix — <span style={{ color: C.navy, fontWeight: 700 }}>■ original</span>{' '}
        <span style={{ color: C.success, fontWeight: 700 }}>■ substitute</span>{' '}
        <span style={{ color: C.gold, fontWeight: 700 }}>■ filler</span>.
      </PageIntro>

      <Box sx={{ display: 'flex', gap: 1.5, mb: 2 }}>
        <Kpi label="CFA × DB lanes" val={kpi.pairs} fg={C.navy} bar={C.navy} />
        <Kpi label="Trucks" val={kpi.trucks} fg={C.navy} bar={C.gold} />
        <Kpi label="SO cases created" val={kpi.soCreated} fg={C.success} bar={C.success} />
        {kpi.rlmHeld > 0 && <Kpi label="On hold · RLM" val={kpi.rlmHeld} fg={C.warnText} bar={C.gold} />}
        <Kpi label="Fill (SO ÷ SOQ)" val={kpi.fill} suffix="%" fg={C.navy} bar={C.navy} />
      </Box>

      <Box sx={{ display: 'flex', gap: 1.25, mb: 1.75, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by CFA or DB…"
          style={{ flex: 1, minWidth: 220, maxWidth: 360, padding: '8px 12px', fontSize: 13, fontFamily: SANS, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
        <Box sx={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.05em' }}>Channel</Box>
        <select value={ch} onChange={(e) => setCh(e.target.value)}
          style={{ padding: '8px 12px', fontSize: 13, fontFamily: SANS, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm, background: '#fff', color: C.slate, cursor: 'pointer' }}>
          <option value="all">All channels</option>
          {channels.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <Box sx={{ flex: 1 }} />
        <ExportXlsxButton label="Export Excel" disabled={!data} onClick={() => { if (data) downloadXlsxMulti('cfa_db', [
          { name: 'Per CFA x DB', headers: data.cfadb.cols, rows: data.cfadb.rows },
          { name: 'Per truck', headers: data.trucks.cols, rows: data.trucks.rows },
        ]); }} />
      </Box>

      {/* ---- CFA × DB combined ---- */}
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 18, mb: 0.5 }}>Per CFA × DB</Box>
      <Box sx={{ fontSize: 12, color: C.muted, mb: 0.5 }}>{nf(cfadb.length)} lanes</Box>
      <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'auto', maxHeight: '52vh', mb: 3, bgcolor: C.white }}>
        <Table size="small" stickyHeader sx={{ minWidth: 'max-content' }}>
          <TableHead><TableRow>
            {th('CFA', 'left')}{th('DB', 'left')}{th('Tier')}{th('SOQ')}{th('Norm')}{th('Held')}{th('Original')}{th('Substitute')}{th('Filler')}{th('Total')}{th('Fill %')}{th('Filler priority')}{th('Draw rank')}{th('Mix', 'left')}
          </TableRow></TableHead>
          <TableBody>
            {cfadb.length === 0 && <TableRow><TableCell colSpan={14} sx={{ color: C.muted, py: 2 }}>No lanes match.</TableCell></TableRow>}
            {cfadb.map((r) => {
              const o = r[D.orig] as number, s = r[D.sub] as number, f = r[D.fil] as number, tot = r[D.tot] as number;
              const tierRaw = r[D.tier] as number, tier = tierRaw === 0 ? P.DEFAULT_TIER : tierRaw;   // db_tier 0 ≡ default tier (label + weight)
              const held = r[D.held] as number, prio = r[D.prio] as number, rank = r[D.rank] as number;
              const snorm = r[D.snorm] as number, sheld = r[D.sheld] as number, ncfa = r[D.ncfa] as number;
              const tw = TW[tier] ?? 0.5, stock = r[D.stock] as number;   // REAL demand on-hand (engine-served), NOT back-computed from Σheld
              const rowKey = `${r[D.cfa]}|${r[D.db]}`, isOpen = open === rowKey, hasSeq = rank > 0 || snorm > 0;
              const tracked = isTracked(r[D.db]);
              const prioTip = `Filler draw priority = tier weight ${tw} ÷ (Σheld ${nf(sheld)} ÷ Σnorm ${nf(snorm)}) = ${prio}. Click the row for the full calculation.`;
              return (
                <Fragment key={rowKey}>
                <TableRow hover onClick={() => setOpen(isOpen ? null : rowKey)}
                  sx={{ cursor: 'pointer', bgcolor: isOpen ? '#FFF5ED' : undefined, '& > td': isOpen ? { borderBottom: 'none' } : undefined, ...trackedRowSxFor(r[D.db]) }}>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{isOpen ? '▾ ' : '▸ '}{r[D.cfa]}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: C.navy, fontWeight: 700 }}>{tracked ? TRACK_STAR + ' ' : ''}{r[D.db]}</TableCell>
                  <TableCell sx={{ ...num, color: C.muted }}>T{tier}</TableCell>
                  <TableCell sx={num}>{nf(r[D.soq] as number)}</TableCell>
                  <TableCell sx={{ ...num, color: C.muted }}>{nf(r[D.norm] as number)}</TableCell>
                  <TableCell sx={{ ...num, color: C.muted }} title="Held = DB stock + Step-1 Original + Step-2 Substitute (post-trim). The Step-3 draw priority uses the engine's pre-trim Σheld, shown in the row drilldown.">{nf(held)}</TableCell>
                  <TableCell sx={{ ...num, color: C.navy, fontWeight: 700 }}>{nf(o)}</TableCell>
                  <TableCell sx={{ ...num, color: s > 0 ? C.success : C.muted }}>{nf(s)}</TableCell>
                  <TableCell sx={{ ...num, color: f > 0 ? C.warnText : C.muted }}>{nf(f)}</TableCell>
                  <TableCell sx={{ ...num, fontWeight: 800, color: C.slate }}>{nf(tot)}</TableCell>
                  <TableCell sx={{ ...num, color: C.navy, fontWeight: 700 }}>{pc(tot, r[D.soq] as number)}%</TableCell>
                  <TableCell sx={{ ...num, color: '#2D2D2D', fontWeight: 700 }} title={prioTip}>{prio}</TableCell>
                  <TableCell align="center">
                    {rank > 0
                      ? <Box component="span" title={prioTip}
                          sx={{ display: 'inline-block', px: 0.9, py: 0.2, borderRadius: 999, fontWeight: 800, fontSize: 11.5,
                            bgcolor: rank === 1 ? '#FFCDA8' : '#F5F7F8', color: rank === 1 ? '#C52B09' : '#2D2D2D' }}>{ordinal(rank)}</Box>
                      : <span style={{ color: C.muted }}>—</span>}
                  </TableCell>
                  <TableCell><Bar o={o} s={s} f={f} /></TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow>
                    <TableCell colSpan={14} sx={{ bgcolor: '#FFF5ED', borderBottom: `2px solid ${C.gold}`, py: 1.75 }}>
                      {hasSeq ? (
                        <Box sx={{ display: 'flex', gap: 3.5, flexWrap: 'wrap', alignItems: 'center' }}>
                          <Box>
                            <Box sx={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: C.muted, letterSpacing: '.05em' }}>Filler draw rank</Box>
                            <Box sx={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: rank === 1 ? '#C52B09' : C.navy, lineHeight: 1.15 }}>{ordinal(rank)}{ncfa > 0 ? ` of ${ncfa}` : ''}</Box>
                            <Box sx={{ fontSize: 11.5, color: C.muted, maxWidth: 250 }}>in CFA {r[D.cfa]}, DBs sorted by priority ↓ — rank 1 draws the shared filler pool first</Box>
                          </Box>
                          {/* priority = tier weight ÷ (Σheld ÷ Σnorm) — same shape as the Step-1 priority score */}
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, fontFamily: MONO, fontSize: 13.5, color: C.slate }}>
                            <span>priority =</span>
                            <Box sx={{ textAlign: 'center' }}>
                              <Box sx={{ px: 1.5, color: C.navy, fontWeight: 700 }}>tier wt {tw}</Box>
                              <Box sx={{ borderTop: `1.5px solid ${C.slate}`, mt: 0.4, pt: 0.4, px: 1.5 }}>Σheld {nf(sheld)} ÷ Σnorm {nf(snorm)}</Box>
                            </Box>
                            <span>= <b style={{ color: '#2D2D2D', fontSize: 18 }}>{prio}</b></span>
                          </Box>
                          <Box sx={{ fontFamily: MONO, fontSize: 12, color: C.muted }}>
                            ≡ (Σnorm {nf(snorm)} ÷ max(Σheld {nf(sheld)}, 1)) × T{tier} weight {tw} = {prio}
                          </Box>
                          <Box sx={{ fontSize: 12.5, color: C.slate, bgcolor: C.white, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px`, px: 1.25, py: 0.75, maxWidth: 560 }}>
                            <b>Held {nf(held)}</b> = stock {nf(stock)} + Step-1 Original {nf(o)} + Step-2 Substitute {nf(s)} — the <b>post-trim</b> Held column (Filler {nf(f)} is drawn after the rank is set, so it is not part of Held).<br />
                            <b>Σheld {nf(sheld)}</b> = the engine&apos;s <b>pre-trim priority denominator</b> used by the Step-3 draw priority above — <i>not</i> the same as the post-trim Held column; after a cluster primary trim it can be larger.<br />
                            <b>Σnorm {nf(snorm)}</b> = Σ of this DB&apos;s norms · <b>tier weight {tw}</b> = T{tier} (T1 1.0 · T2 0.85 · T3 0.65 · T4 0.5)
                          </Box>
                        </Box>
                      ) : (
                        <Box sx={{ fontSize: 12.5, color: C.muted }}>DB {r[D.db]} did not enter the Step-3 filler draw sequence (no norm / no eligible filler).</Box>
                      )}
                    </TableCell>
                  </TableRow>
                )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </Box>

      {/* ---- CFA × DB × Truck ---- */}
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 18, mb: 0.5 }}>Per CFA × DB × Truck</Box>
      <Box sx={{ fontSize: 12, color: C.muted, mb: 0.5 }}>{nf(trucks.length)} trucks · truck type + fill % + SO disposition + transshipment per lane</Box>
      <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'auto', maxHeight: '60vh', bgcolor: C.white }}>
        <Table size="small" stickyHeader sx={{ minWidth: 'max-content' }}>
          <TableHead><TableRow>
            {th('CFA', 'left')}{th('DB', 'left')}{th('Truck type', 'left')}{th('Truck')}{th('Cases')}{th('Capacity')}{th('Fill %')}{th('SO disposition', 'left')}{th('Transship?', 'left')}{th('Cluster', 'left')}{th('Primary trucks')}
          </TableRow></TableHead>
          <TableBody>
            {trucks.length === 0 && <TableRow><TableCell colSpan={11} sx={{ color: C.muted, py: 2 }}>No trucks match.</TableCell></TableRow>}
            {trucks.map((r, i) => {
              const fill = Math.round(r[T.fill] as number);
              const isTranship = !!r[T.tranship];
              const casesNow = r[T.cases] as number;
              const plannedCases = Number(r[T.plannedCases] ?? 0);
              const plannedFillRaw = Number(r[T.plannedFill] ?? 0), fillRaw = Number(r[T.fill] ?? 0);
              const trimmed = plannedCases > 0 && plannedCases !== casesNow;   // cluster primary trim reduced this truck
              // a sub-65% transshipment secondary tail (cluster remainder after the primary-truck trim) is ALLOWED, not a floor failure → amber, not red
              // ROUND the fill to the nearest whole % for the SO/green gate (matches the backend so_flag): a truck ≥89.5%
              // rounds up to 90 → green (SO), not amber. Threshold stays live from oe_parameters.
              const fillColor = Math.round(fill) >= P.TRUCK_FILL_TARGET_PCT * 100 ? C.success : fill >= P.TRUCK_KEEP_PCT * 100 ? C.warnText : (isTranship ? C.warnText : C.alertRed);
              const fillTip = isTranship && fill < P.TRUCK_KEEP_PCT * 100
                ? `sub-${pct(P.TRUCK_KEEP_PCT)} permitted for transshipment secondary tail (cluster remainder after primary-truck trim)`
                : (trimmed ? `planned ${f1(plannedFillRaw)}% → shipped ${f1(fillRaw)}% (cluster primary trim)` : undefined);
              const flag = String(r[T.flag]);
              const flagTone = flag === 'SO_CREATION' ? { bg: C.successLight, fg: C.success }
                : flag === 'RLM_FOR_SECOND_CFA' ? { bg: C.redP, fg: C.alertRed }
                : { bg: C.warnLight, fg: C.warnText };
              const newLane = i === 0 || r[T.cfa] !== trucks[i - 1][T.cfa] || r[T.db] !== trucks[i - 1][T.db];
              const tracked = isTracked(r[T.db]);
              return (
                <TableRow key={i} sx={{ borderTop: newLane ? `2px solid ${C.rule}` : undefined, ...trackedRowSxFor(r[T.db]) }}>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: newLane ? C.slate : C.muted }}>{newLane ? r[T.cfa] : ''}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: newLane ? C.navy : C.muted, fontWeight: newLane ? 700 : 400 }}>{newLane ? `${tracked ? TRACK_STAR + ' ' : ''}${r[T.db]}` : ''}</TableCell>
                  <TableCell sx={{ fontSize: 12, color: C.slate }}>{String(r[T.type])}</TableCell>
                  <TableCell sx={{ ...num, color: C.slate }}>#{r[T.truck]}</TableCell>
                  <TableCell sx={{ ...num, fontWeight: 700 }} title={trimmed ? `planned ${nf(plannedCases)} → shipped ${nf(casesNow)} (cluster primary trim)` : undefined}>
                    {trimmed ? <><Box component="span" sx={{ color: C.muted, fontWeight: 400 }}>{nf(plannedCases)} → </Box>{nf(casesNow)}</> : nf(casesNow)}
                  </TableCell>
                  <TableCell sx={{ ...num, color: C.muted }}>{nf(r[T.cap] as number)}</TableCell>
                  <TableCell sx={{ ...num, fontWeight: 800, color: fillColor }} title={fillTip}>
                    {trimmed ? <><Box component="span" sx={{ color: C.muted, fontWeight: 400 }}>{f1(plannedFillRaw)}% → </Box>{f1(fillRaw)}%</> : `${fill}%`}
                  </TableCell>
                  <TableCell><Box component="span" sx={{ px: 0.9, py: 0.2, borderRadius: 1, fontWeight: 800, fontSize: 11, bgcolor: flagTone.bg, color: flagTone.fg }}>{flag}</Box></TableCell>
                  <TableCell>{r[T.tranship]
                    ? <Box component="span" title="Ships on the SECONDARY truck from the transhipement master" sx={{ px: 0.9, py: 0.2, borderRadius: 1, fontWeight: 800, fontSize: 11, bgcolor: C.amberP, color: C.warnText }}>▸ secondary</Box>
                    : <span style={{ color: C.muted }}>—</span>}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 11.5, color: C.muted }} title="Transshipment cluster — DBs in one cluster share a single primary truck route">{r[T.tranship] ? String(r[T.cluster] || '—') : '—'}</TableCell>
                  <TableCell sx={{ ...num, color: C.muted }} title="CLUSTER-combined primary trucks (decimal) = Σ Total over the cluster's DBs ÷ cluster primary max cases — same for every DB in the cluster">{Number(r[T.primCount]) > 0 ? Number(r[T.primCount]).toFixed(1) : '—'}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.rule}`, mt: 3, pt: 1, fontSize: 9, color: C.muted }}>
        <span>AI Order Optimizer · CFA × DB combined allocation</span>
        <span>combined SOQ · norm · original · sub · filler · per truck</span>
      </Box>
    </Shell>
  );
}
