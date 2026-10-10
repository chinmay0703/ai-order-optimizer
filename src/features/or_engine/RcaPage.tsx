import { useEffect, useMemo, useState } from 'react';
import { Box, Chip, Collapse } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import PageIntro from '../../shared/PageIntro';
import { useOeParams, pct } from '../../shared/OeParams';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';

/* RCA — one search (DB / reg-zsku / CFA) → the WHOLE end-to-end allocation story, for a client to validate:
   who, how much, from which CFA stock, through Steps 1/2/3, onto which trucks, as which FEFO SKUs. 100% from the backend. */

type Kind = 'db' | 'regzsku' | 'cfa';
interface Idx { dbs: { id: string; name: string; channel: string }[]; reg_zskus: { id: string; brand: string }[]; cfas: string[]; }
const nf = (n: number) => (n ?? 0).toLocaleString();
const th = { textAlign: 'left' as const, padding: '9px 10px', background: C.headBg, color: C.muted, fontWeight: 700, fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase' as const, borderBottom: `1px solid ${C.rule}`, whiteSpace: 'nowrap' as const, position: 'sticky' as const, top: 0 };
const td = { padding: '9px 10px', borderTop: `1px solid ${C.rowLine}`, color: C.ink, fontSize: 12.5, whiteSpace: 'nowrap' as const };
const numTd = { ...td, textAlign: 'right' as const, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' as const };
// Description cells wrap (no clipping) so the full product description always shows.
const tdWrap = { ...td, whiteSpace: 'normal' as const };
// fill-% traffic light: ≥ target → green; ≥ keep floor → amber; else red. keepPct/targetPct come from oe_parameters (×100).
// green (SO) gate uses the fill ROUNDED to the nearest whole % (matches the backend so_flag) — 89.5% rounds up to 90.
const fillColor = (p: number, keepPct: number, targetPct: number) => (Math.round(p) >= targetPct ? C.green : p >= keepPct ? C.warnText : C.alertRed);

/* Post-cascade transshipment CLUSTER primary-truck trim — present on story only for a cluster-trimmed transshipment DB.
   Cluster load can't split into all-≥65% primary trucks, so the <65% remainder is trimmed CROSS-DB (every DB×reg-zsku
   pooled) — ALL fillers first, then subs, then originals (each by S/N), never below any DB's secondary-truck 65% floor. */
interface ClusterTrimLine { sn_ratio: number; sn_rank: number; stock: number; norm: number; allocated_before: number; allocated_after: number; cut_total: number; cut_filler: number; cut_sub: number; cut_orig: number; }
interface ClusterTrim { cluster_code: string; primary_cap: number; primary_trucks: number; shipped_before: number; trimmed: number; shipped_after: number; status: string; trims: Record<string, ClusterTrimLine>; }

function Section({ title, sub, count, children, open: openInit = false }: { title: string; sub?: string; count?: number; children: React.ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(openInit);
  return (
    <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'hidden', mb: 1.5, background: C.white }}>
      <Box onClick={() => setOpen(o => !o)} sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1.1, cursor: 'pointer', bgcolor: C.cream, '&:hover': { bgcolor: '#FFCDA8' } }}>
        <Box sx={{ flex: 1 }}>
          <Box sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 15 }}>{title}{count != null && <Box component="span" sx={{ ml: 1, fontSize: 12, color: C.muted, fontFamily: SANS }}>· {count}</Box>}</Box>
          {sub && <Box sx={{ fontSize: 11.5, color: C.muted }}>{sub}</Box>}
        </Box>
        {open ? <ExpandLessIcon sx={{ color: C.navy }} /> : <ExpandMoreIcon sx={{ color: C.navy }} />}
      </Box>
      <Collapse in={open}><Box sx={{ p: 1.5 }}>{children}</Box></Collapse>
    </Box>
  );
}

function Tbl({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <Box sx={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 1, maxHeight: 400, overflowY: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr>{head.map((h, i) => <th key={i} style={{ ...th, textAlign: i === 0 || head[i] === 'Description' ? 'left' : 'right' }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i} style={{ background: '#fff' }}>{r.map((c, ci) => <td key={ci} style={head[ci] === 'Description' ? tdWrap : ci === 0 ? td : numTd}>{c}</td>)}</tr>
        ))}</tbody>
      </table>
    </Box>
  );
}

function Kpi({ label, val, suffix = '', fg }: { label: string; val: number | string; suffix?: string; fg: string }) {
  return (
    <Box sx={{ flex: 1, minWidth: 110, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, p: 1.25, bgcolor: C.white }}>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 22, color: fg, lineHeight: 1 }}>{typeof val === 'number' ? nf(val) : val}{suffix}</Box>
      <Box sx={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.muted, mt: 0.5 }}>{label}</Box>
    </Box>
  );
}

export default function RcaPage({ date }: { date?: string }) {
  const [idx, setIdx] = useState<Idx | null>(null);
  const [idxLoading, setIdxLoading] = useState(true);   // init TRUE: the search index is fetched on mount -> the first
                                                        // paint is the skeleton, not a flash of "nothing traced yet"
  const [idxErr, setIdxErr] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('db');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string>('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [story, setStory] = useState<any>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from story===null: a not-found trace, or
  const [storyErr, setStoryErr] = useState<string | null>(null);   // an early return, would then spin forever
  const [storyFor, setStoryFor] = useState('');    // the trace key the last SETTLED trace was for. Without it the render
                                                   // cannot tell "picked, the effect hasn't fired yet" from "traced, not
                                                   // found" — and flashes "No allocation for X" before the trace starts
  const [nonce, setNonce] = useState(0);           // bumped by Retry — re-runs the index AND the trace
  const traceKey = sel ? `${kind}:${sel}:${date ?? ''}` : '';   // what the story on screen must belong to

  useEffect(() => {                                // the search index (DBs · reg-zskus · CFAs) for this run date
    let alive = true;
    setIdxErr(null); setIdxLoading(true);
    api.rcaIndex(date).then(r => { if (alive) setIdx(r as Idx); })
      .catch((e: unknown) => { if (alive) setIdxErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setIdxLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, nonce]);

  const options = useMemo(() => {
    if (!idx) return [] as { id: string; primary: string; secondary: string; tag: string }[];
    const needle = q.trim().toLowerCase();
    if (kind === 'db') return idx.dbs.filter(d => `${d.id} ${d.name} ${d.channel}`.toLowerCase().includes(needle)).slice(0, 60)
      .map(d => ({ id: d.id, primary: d.name || d.id, secondary: d.id, tag: d.channel }));
    if (kind === 'regzsku') return idx.reg_zskus.filter(z => `${z.id} ${z.brand}`.toLowerCase().includes(needle)).slice(0, 60)
      .map(z => ({ id: z.id, primary: z.id, secondary: z.brand, tag: '' }));
    return idx.cfas.filter(c => c.toLowerCase().includes(needle)).map(c => ({ id: c, primary: `CFA ${c}`, secondary: '', tag: '' }));
  }, [idx, kind, q]);

  useEffect(() => {
    if (!sel) { setStory(null); setStoryErr(null); setLoading(false); return; }   // nothing picked -> nothing to trace, not "loading"
    let alive = true;
    setStory(null); setStoryErr(null); setLoading(true);
    const fn = kind === 'db' ? api.rcaDb : kind === 'regzsku' ? api.rcaRegzsku : api.rcaCfa;
    fn(sel, date).then(r => { if (alive) setStory(r); })
      .catch((e: unknown) => { if (alive) setStoryErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) { setLoading(false); setStoryFor(traceKey); } });   // settles on success, not-found AND failure
    return () => { alive = false; };
  }, [sel, kind, date, nonce, traceKey]);   // traceKey is derived from sel/kind/date — listed, never fires on its own

  const err = idxErr ?? storyErr;                 // either fetch failing lands in the same ErrorState
  // in flight OR about to be (sel/kind/date changed, the trace effect runs after this paint)
  const tracing = !!sel && (loading || storyFor !== traceKey);
  const settled = !err && !idxLoading && !tracing;   // the request is done — anything empty now is really empty
  const kpis = kind === 'db' ? 6 : kind === 'cfa' ? 5 : 3;   // KPI tiles the story draws, so the skeleton matches it
  const searchLabel = kind === 'db' ? 'DB code, distributor or channel' : kind === 'regzsku' ? 'reg-zsku or brand' : 'CFA';

  const tab = (k: Kind, label: string) => (
    <Box onClick={() => { setKind(k); setSel(''); setStory(null); setQ(''); }}
      sx={{ px: 2, py: 0.75, fontSize: 13, fontWeight: 700, cursor: 'pointer', borderRadius: `${RADIUS.sm}px`,
        border: `1px solid ${kind === k ? C.navy : C.rule}`, bgcolor: kind === k ? C.navy : C.white, color: kind === k ? '#fff' : C.slate }}>{label}</Box>
  );

  return (
    <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
      <Box sx={{ maxWidth: 1180, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
        <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: C.gold }}>RCA · end-to-end allocation trace</Box>
        <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: '6px 0 4px' }}>How did this allocation happen?</Box>
        <PageIntro>
          Search any <b>DB</b>, <b>reg-zsku</b> or <b>CFA</b> and see the whole story — demand, the reserved CFA stock it drew, Step&nbsp;1 → 2 → 3, the trucks, and the final FEFO SKU order, with fill&nbsp;% at every level.
        </PageIntro>

        <Box sx={{ display: 'flex', gap: 1, mb: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
          {tab('db', 'By DB')}{tab('regzsku', 'By reg-zsku')}{tab('cfa', 'By CFA')}
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${kind === 'db' ? 'DB code / distributor / channel' : kind === 'regzsku' ? 'reg-zsku / brand' : 'CFA'}…`}
            style={{ flex: 1, minWidth: 260, padding: '9px 12px', fontSize: 13, fontFamily: SANS, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
        </Box>

        {(q.trim() || !sel) && options.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Box sx={{ fontSize: 11, color: C.muted, mb: 0.5 }}>{options.length} match{options.length === 1 ? '' : 'es'}{q.trim() ? '' : ' — pick one to trace'}</Box>
            <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, maxHeight: 300, overflowY: 'auto', bgcolor: C.white }}>
              {options.map((o, i) => (
                <Box key={o.id} onClick={() => { setSel(o.id); setQ(''); }}
                  sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1, cursor: 'pointer',
                    borderTop: i ? `1px solid ${C.border}` : undefined, '&:hover': { bgcolor: C.cream } }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box sx={{ fontWeight: 700, color: C.navy, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.primary}</Box>
                    {o.secondary && <Box sx={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>{o.secondary}</Box>}
                  </Box>
                  {o.tag && <Chip size="small" label={o.tag} sx={{ height: 20, fontSize: 11, fontWeight: 700, bgcolor: C.navyP, color: C.navy }} />}
                </Box>
              ))}
            </Box>
          </Box>
        )}

        {/* err -> loading -> nothing picked -> nothing found. The tabs + search stay put, so a retry is one click away. */}
        {err && <ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} />}
        {!err && (idxLoading || tracing) && <PageSkeleton kpis={tracing ? kpis : 0} rows={8} />}
        {settled && !sel && <EmptyState title="Nothing traced yet"
          hint={`Search a ${searchLabel} above and pick a match — its whole allocation story loads here.`} />}
        {settled && sel && !story?.found && <EmptyState title={`No allocation for ${sel} in this run`}
          hint="This selection was not allocated in the last run. Try another run date in the run-context bar, or trace a different DB / reg-zsku / CFA." />}

        {!err && !tracing && story?.found && kind === 'db' && <DbStory s={story} />}
        {!err && !tracing && story?.found && kind === 'regzsku' && <ZStory s={story} />}
        {!err && !tracing && story?.found && kind === 'cfa' && <CfaStory s={story} />}
      </Box>
    </Box>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function DbStory({ s }: { s: any }) {
  const P = useOeParams();
  const descOf = useRegZskuDesc();   // reg-zsku → product description (served lookup)
  const descCell = (rz: string) => <span title={descOf(rz)} style={{ whiteSpace: 'normal', fontSize: 11.5, color: C.muted }}>{descOf(rz) || '—'}</span>;
  const keepPct = P.TRUCK_KEEP_PCT * 100, targetPct = P.TRUCK_FILL_TARGET_PCT * 100;   // fill-% bands from oe_parameters
  const id = s.identity ?? {};
  const ct: ClusterTrim | undefined = s.cluster_trim;              // present only for a cluster-trimmed transshipment DB
  const trims: Record<string, ClusterTrimLine> = ct?.trims ?? {};  // keyed by reg-zsku that was trimmed
  const lineByRz: Record<string, any> = {};                        // per-reg-zsku POST-trim line → authoritative post values
  (s.lines ?? []).forEach((l: any) => { lineByRz[l.reg_zsku] = l; });
  return (
    <Box>
      <Box sx={{ border: `1px solid ${C.rule}`, borderLeft: `4px solid ${C.navy}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, p: 2, mb: 1.5, bgcolor: C.white }}>
        <Box sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 19 }}>{s.db} · {id.name || '—'}</Box>
        <Box sx={{ fontSize: 12.5, color: C.slate, mt: 0.5 }}>
          CFA <b>{s.cfa}</b> · Run <b>{s.run?.no} · {s.run?.channel}</b> · Tier <b>T{s.run?.tier}</b> · Customer type <b>{id.customer_type}</b> · Channel <b>{id.channel_code}</b> · Sub-channel <b>{id.sub_channel}</b> · Order <b style={{ fontFamily: MONO }}>{s.order_id}</b> · PDP <b>{s.is_pdp || '—'}</b>
        </Box>
      </Box>
      {s.dropped && (
        <Box sx={{ border: `1px solid ${C.alertRed}`, borderLeft: `4px solid ${C.alertRed}`, borderRadius: `${RADIUS.md}px`, bgcolor: C.redP, p: 1.5, mb: 1.5 }}>
          <Box sx={{ fontWeight: 800, color: C.alertRed, fontSize: 13 }}>⚠ LANE DROPPED — {s.drop_reason || `truck < ${pct(P.TRUCK_KEEP_PCT)}`}</Box>
          <Box sx={{ fontSize: 12, color: C.slate, mt: 0.3 }}>
            Allocated in Step 1 (Original <b>{nf(s.summary.original)}</b> cs) but its truck couldn't reach {pct(P.TRUCK_KEEP_PCT)}, so the whole lane was cancelled and cascaded to the next run — <b>0 shipped</b>. The figures below are what it was allocated <i>before</i> the drop.
          </Box>
        </Box>
      )}
      {ct && (
        <Box sx={{ border: `1px solid ${C.amber}`, borderLeft: `4px solid ${C.amber}`, borderRadius: `${RADIUS.md}px`, bgcolor: C.amberP, p: 1.5, mb: 1.5 }}>
          <Box sx={{ fontWeight: 800, color: C.warnText, fontSize: 13 }}>⚠ CLUSTER {ct.cluster_code} PRIMARY TRIM</Box>
          <Box sx={{ fontSize: 12, color: C.slate, mt: 0.3 }}>
            This cluster combined to <b>{nf(ct.shipped_before)}</b> cs — it can't split into all-≥{pct(P.TRUCK_KEEP_PCT)} primary trucks (cap <b>{nf(ct.primary_cap)}</b> cs, ships <b>{nf(ct.primary_trucks)}</b>), so <b>{nf(ct.trimmed)}</b> cs were trimmed <b>CROSS-DB</b> (every DB×reg-zsku pooled) — ALL fillers first, then subs, then originals (each by S/N), never below any DB's secondary-truck {pct(P.TRUCK_KEEP_PCT)} floor: this DB ships <b>{nf(ct.shipped_after)}</b>. Some Step-1 / Step-3 figures below are <i>pre-trim</i> and are annotated to their post-trim value.
          </Box>
          <Box sx={{ mt: 0.6, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
            {Object.entries(trims).map(([rz, t]) => (
              <Box key={rz} sx={{ fontSize: 11.5, color: C.slate, fontFamily: MONO }}>
                <b>{rz}</b>: {nf(t.allocated_before)}→{nf(t.allocated_after)} (−{nf(t.cut_total)}); filler −{nf(t.cut_filler)}, original −{nf(t.cut_orig)}{t.cut_sub ? `, sub −${nf(t.cut_sub)}` : ''}; S/N {t.sn_ratio}
              </Box>
            ))}
          </Box>
        </Box>
      )}
      <Box sx={{ display: 'flex', gap: 1.25, mb: 2, flexWrap: 'wrap' }}>
        <Kpi label="SOQ (demand)" val={s.summary.soq} fg={C.navy} />
        <Kpi label="Allocated" val={s.summary.allocated} fg={C.slate} />
        <Kpi label="Fill %" val={s.summary.fill_pct} suffix="%" fg={fillColor(s.summary.fill_pct, keepPct, targetPct)} />
        <Kpi label="Original" val={s.summary.original} fg={C.navy} />
        <Kpi label="Substitute" val={s.summary.substitute} fg={C.green} />
        <Kpi label="Filler" val={s.summary.filler} fg={C.warnText} />
      </Box>

      <Section title="Per reg-zsku — demand → CFA reserved → allocation" count={s.lines.length} sub="SOQ vs Norm & DB stock; the reserved CFA pool it drew; Original + Substitute + Filler; fill %" open>
        <Tbl head={['reg-zsku · brand', 'Description', 'SOQ', 'Norm', 'DB stk', 'CFA resv', 'Orig', 'Sub', 'Sub from', 'Filler', 'Filler from', 'Total', 'Fill %']}
          rows={s.lines.map((l: any) => [
            `${l.reg_zsku} · ${l.brand}`, descCell(l.reg_zsku), nf(l.soq), nf(l.norm), nf(l.db_stock), nf(l.cfa_reserved), nf(l.original),
            l.substitute || '—', <span style={{ fontSize: 10.5, color: C.green }}>{l.substitute_from || '—'}</span>,
            l.filler || '—', <span style={{ fontSize: 10.5, color: C.warnText }}>{l.filler_from || '—'}</span>,
            <b>{nf(l.total)}</b>, <span style={{ color: fillColor(l.fill_pct, keepPct, targetPct), fontWeight: 700 }}>{l.fill_pct}%</span>])} />
      </Section>

      {/* WATER-FILL version (retired): title "Step 1 · Original (priority water-fill)", columns Score · Water level */}
      {s.step1?.length > 0 && <Section title="Step 1 · Original (v2 weight-equalising fair share)" count={s.step1.length} sub="priority before = tier × DRR ÷ final stock; one water level λ per pool; NOT CONSTRAINED pools get full SOQ, CFA STOCK 0 pools get 0">
        <Tbl head={['reg-zsku', 'Description', 'Regime', 'Priority before', 'λ (water level)', 'SOQ left', 'Allocated']} rows={s.step1.map((r: any) => {
          const post = lineByRz[r.reg_zsku]?.original;   // POST-cluster-trim original (authoritative, engine-served)
          const alloc = trims[r.reg_zsku] && post != null
            ? <span style={{ fontFamily: MONO }}>{nf(r.allocated)} → <b>{nf(post)}</b> <i style={{ fontStyle: 'normal', color: C.warnText, fontSize: 10.5 }}>(cluster trim)</i></span>
            : <b>{nf(r.allocated)}</b>;
          // priority / λ are NULL for a pool that never entered the v2 engine (NOT CONSTRAINED / CFA STOCK 0) → '—'
          return [r.reg_zsku, descCell(r.reg_zsku), <span style={{ fontSize: 10.5 }}>{r.regime ?? '—'}</span>,
            r.priority_before ?? '—', r.lambda ?? '—', nf(r.soq_remaining), alloc];
        })} />
      </Section>}
      {s.step2?.length > 0 && <Section title="Step 2 · Substitute (same MRP)" count={s.step2.length} sub={`leftover demand filled by same-MRP substitutes; CFA pool + ${P.NORM_MULTIPLIER}×Norm room bind it`}>
        <Tbl head={['reg-zsku', 'Description', 'Sub SKU', 'Description', 'Rank', 'CFA pool', 'Room', 'Allocated', 'Binding']} rows={s.step2.map((r: any) => [r.reg_zsku, descCell(r.reg_zsku), r.sub_zsku, descCell(r.sub_zsku), r.rank, nf(r.cfa_pool), nf(r.room), <b>{nf(r.allocated)}</b>, <span style={{ fontSize: 10.5 }}>{r.reason}</span>])} />
      </Section>}
      {s.filler_priority && <Section title="Step 3 · Filler (draw priority + fill)" count={s.step3?.length ?? 0}
        sub={`Draw rank ${s.filler_priority.rank} / ${s.filler_priority.of} · priority ${s.filler_priority.priority} = (Σnorm ${nf(s.filler_priority.sum_norm)} ÷ Σheld ${nf(s.filler_priority.sum_held)}) × tier`}>
        <Tbl head={['Filler SKU', 'Description', 'Rank', `${P.NORM_MULTIPLIER}×Norm room`, 'Truck room', 'CFA pool', 'Allocated', 'Binding']} rows={(s.step3 ?? []).map((r: any) => {
          const post = lineByRz[r.filler_zsku]?.filler;   // POST-cluster-trim filler (authoritative, engine-served)
          const alloc = trims[r.filler_zsku] && post != null
            ? <span style={{ fontFamily: MONO }}>{nf(r.allocated)} → <b>{nf(post)}</b> <i style={{ fontStyle: 'normal', color: C.warnText, fontSize: 10.5 }}>(cluster trim)</i></span>
            : <b>{nf(r.allocated)}</b>;
          return [r.filler_zsku, descCell(r.filler_zsku), r.rank, nf(r.room), nf(r.truck_room), nf(r.cfa_pool), alloc, <span style={{ fontSize: 10.5 }}>{r.reason}</span>];
        })} />
      </Section>}
      {s.trucks?.length > 0 && <Section title="Trucks" count={s.trucks.length} sub="type · fill % · SO disposition" open>
        <Tbl head={['Truck', 'Type', 'Cases', 'Capacity', 'Fill %', 'SO disposition']} rows={s.trucks.map((t: any) => {
          // A transshipment secondary tail is ALLOWED below 65% and is NOT re-checked — show amber (warnText), never alertRed.
          const isTransTail = (!!ct || t.is_transshipment) && t.fill_pct < keepPct;
          return [
            `#${t.no}`, t.type, nf(t.cases), nf(t.capacity),
            <span style={{ color: isTransTail ? C.warnText : fillColor(t.fill_pct, keepPct, targetPct), fontWeight: 700 }}>{t.fill_pct}%</span>,
            isTransTail
              ? <Box><b>{t.so_flag}</b><Box sx={{ fontSize: 10, fontWeight: 600, color: C.warnText, whiteSpace: 'normal', maxWidth: 230, ml: 'auto' }}>transshipment remainder — &lt;{pct(P.TRUCK_KEEP_PCT)} allowed, not re-checked</Box></Box>
              : <b>{t.so_flag}</b>,
          ];
        })} />
      </Section>}
      {s.skus?.length > 0 && <Section title="Final SKU order (FEFO)" count={s.skus.length} sub="earliest-expiry-first physical picks · Original / Substitute / Filler">
        <Tbl head={['reg-zsku', 'Description', 'SKU', 'Batch', 'Days to exp', 'Qty', 'Source', 'Truck']} rows={s.skus.map((r: any) => [r.reg_zsku, descCell(r.reg_zsku), r.sku, r.batch, <span style={{ color: r.days_to_expiry < 30 ? C.alertRed : r.days_to_expiry < 60 ? C.warnText : C.slate }}>{nf(r.days_to_expiry)}d</span>, <b>{nf(r.qty)}</b>, r.source, `#${r.truck}`])} />
      </Section>}
    </Box>
  );
}

function ZStory({ s }: { s: any }) {
  const P = useOeParams();
  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1.25, mb: 2, flexWrap: 'wrap' }}>
        <Kpi label="Physical CFA stock" val={s.physical} fg={C.navy} />
        <Kpi label="Band" val={s.band} fg={C.slate} />
        <Kpi label="Shipped" val={s.total_shipped ?? 0} fg={C.green} />
      </Box>
      <Section title="Reserved per channel" count={s.reservation?.length} sub="how this reg-zsku's physical stock is split across the 4 channels for its MRP band" open>
        <Tbl head={['Channel', 'Reserved']} rows={(s.reservation ?? []).map((r: any) => [r.channel, <b>{nf(r.reserved)}</b>])} />
      </Section>
      <Section title="Cascade — pool run by run" count={s.cascade?.length} sub="earmark + carry-in → available → allocated → remaining (cascades to the next run)" open>
        <Tbl head={['Run · channel', 'Earmark', 'Carry-in', 'Available', 'Allocated', 'Remaining']} rows={(s.cascade ?? []).map((r: any) => [`R${r.run} · ${r.channel}`, nf(r.earmark), nf(r.carry_in), nf(r.available), <b>{nf(r.allocated)}</b>, nf(r.remaining)])} />
      </Section>
      <Section title="Allocated to (which DBs got it)" count={s.allocated_to?.length} open
        sub={`Step-1 Original (gross) → shipped Original/Sub/Filler. A lane allocated then DROPPED at the ≥${pct(P.TRUCK_KEEP_PCT)} truck rule ships 0${s.total_dropped_step1 ? ` · ${nf(s.total_dropped_step1)} cs allocated in Step 1 then dropped` : ''}`}>
        <Tbl head={['DB · name', 'Channel', 'SOQ', 'Step-1 Orig', 'Shipped Orig', 'Sub', 'Filler', 'Total', 'Status']}
          rows={(s.allocated_to ?? []).map((r: any) => [`${r.db} · ${r.name}`, r.channel, nf(r.soq), nf(r.step1_original), nf(r.original), nf(r.substitute), nf(r.filler), <b>{nf(r.total)}</b>,
            <span style={{ color: r.status === 'dropped' ? C.alertRed : C.green, fontWeight: 700, fontSize: 10.5 }}>{r.status === 'dropped' ? 'DROPPED' : 'shipped'}</span>])} />
      </Section>
    </Box>
  );
}

function CfaStory({ s }: { s: any }) {
  const P = useOeParams();
  const keepPct = P.TRUCK_KEEP_PCT * 100, targetPct = P.TRUCK_FILL_TARGET_PCT * 100;   // fill-% bands from oe_parameters
  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1.25, mb: 2, flexWrap: 'wrap' }}>
        <Kpi label="Physical stock" val={s.summary.physical} fg={C.navy} />
        <Kpi label="SOQ (demand)" val={s.summary.soq} fg={C.slate} />
        <Kpi label="Allocated" val={s.summary.allocated} fg={C.green} />
        <Kpi label="Fill %" val={s.summary.fill_pct} suffix="%" fg={fillColor(s.summary.fill_pct, keepPct, targetPct)} />
        <Kpi label="Idle stock" val={s.summary.wasted} fg={C.alertRed} />
      </Box>
      <Section title="Per run (cascade order)" count={s.per_run?.length} sub="Non-PACE (Run 1) → Retail (Run 4) · DBs · demand · Original+Sub+Filler · fill %" open>
        <Tbl head={['Run · channel', 'DBs', 'SOQ', 'Orig', 'Sub', 'Filler', 'Total', 'Fill %']} rows={(s.per_run ?? []).map((r: any) => [`R${r.run} · ${r.channel}`, nf(r.dbs), nf(r.soq), nf(r.original), nf(r.substitute), nf(r.filler), <b>{nf(r.total)}</b>, <span style={{ color: fillColor(r.fill_pct, keepPct, targetPct), fontWeight: 700 }}>{r.fill_pct}%</span>])} />
      </Section>
    </Box>
  );
}
