import { Fragment, useEffect, useMemo, useState } from 'react';
import { Box, Collapse, Stack, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { ExportXlsxButton, downloadXlsxMulti } from '../../shared/exportXlsx';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';

/* ---------------------------------------------------------------------------
   Filtered SOQ — the DEMAND GATE that runs BEFORE pre-processing. The data team
   ships three Yes/No flags on every SOQ line; a (DB, CFA) enters the run when:

        ( PDP date  OR  a below-threshold REG-SKU )  AND  combined SOQ > 65%

   The whole engine (reservation → water-fill → substitute → filler → truck →
   cluster → order) runs ONLY on the kept subset. This page shows the rule, the
   per-(DB, CFA) decision (kept + dropped), and the kept lines. All numbers are
   engine-served (live from /api/v1/filtered_soq) — no client-side filter math.
--------------------------------------------------------------------------- */
type Cell = string | number | boolean;
interface Decision { db: string; cfa: string; pdp: boolean; has_below: boolean; combined: boolean; kept: boolean; combined_soq: number; truck_cap: number | null; truck_cap_src: string | null; reason: string; cluster?: string | null; cluster_reject?: boolean; }
interface Summary {
  groups_total?: number; groups_kept?: number; groups_dropped?: number; groups_cluster_rejected?: number;
  rows_total?: number; rows_kept?: number; cfas_kept?: string[]; dbs_kept?: number;
  kept_reasons?: Record<string, number>; dropped_reasons?: Record<string, number>;
}
interface Payload {
  date: string; rule: string; available: boolean; note?: string;
  summary: Summary; decision: Decision[]; cluster_rejects?: Decision[]; columns: string[]; rows: Cell[][];
}
interface DroppedRow { reg_zsku: string; soq: number; norm: number; soh: number; sit: number; stock: number; }
interface DroppedGroup { db: string; db_name?: string; cfa: string; gate: string; reason: string; cluster?: string | null;
  combined: { soq: number; norm: number; soh: number; sit: number; stock: number }; rows: DroppedRow[]; }
interface DroppedPayload { date: string; data_date: string; cfa?: string | null; q?: string; count: number; limit?: number; offset?: number; dropped: DroppedGroup[]; }

const nf = (n: number) => Math.round(Number(n) || 0).toLocaleString();
const DROP_PAGE = 20;   // dropped distributors per page (server-paginated, so a slice loads/renders at a time)
const num = { textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums', fontFamily: MONO, fontSize: 12.5, whiteSpace: 'nowrap' as const };
const NUM_COLS = new Set(['SOQ_Case', 'Norm_Qty_Cases', 'Max_Norm']);

const Shell = ({ children }: { children: React.ReactNode }) => (
  <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
    <Box sx={{ maxWidth: 1320, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
      <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: '#000', bgcolor: '#FFAA72', display: 'inline-block', px: 1, py: '3px', borderRadius: '2px' }}>
        Pre-processing · step 0 · the demand gate
      </Box>
      <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: '6px 0 8px' }}>
        Filtered SOQ — the DBs the engine runs on
      </Box>
      {children}
    </Box>
  </Box>
);

const Flag = ({ on }: { on: boolean }) => (
  <Box component="span" sx={{ color: on ? C.green : C.muted, fontWeight: 800 }}>{on ? '✓' : '·'}</Box>
);
const Badge = ({ d }: { d: { kept: boolean; cluster_reject?: boolean } }) => {
  const cr = !!d.cluster_reject;                       // gate-kept but cluster has 1 distributor → rejected
  const label = cr ? 'CLUSTER' : d.kept ? 'KEPT' : 'DROPPED';
  const bg = cr ? C.amberP : d.kept ? C.greenP : C.redP;
  const fg = cr ? C.warnText : d.kept ? C.green : C.red;
  return (
    <Box component="span" title={cr ? 'Rejected — its cluster has only 1 distributor (needs ≥2 to transship)' : undefined}
      sx={{ display: 'inline-block', px: 1, py: 0.25, borderRadius: `${RADIUS.sm}px`, fontSize: 11, fontWeight: 800,
        letterSpacing: '.04em', bgcolor: bg, color: fg }}>
      {label}
    </Box>
  );
};

// one dropped distributor: DB×CFA-combined header (norm/SOQ/SOH/SIT/stock) that expands to its reg-zsku lines.
function DroppedCard({ g, open, onToggle, descOf }:
  { g: DroppedGroup; open: boolean; onToggle: () => void; descOf: (z: string) => string }) {
  const cr = g.gate === 'cluster';
  const numCell = { fontFamily: MONO, fontSize: 12.5, fontVariantNumeric: 'tabular-nums' as const, textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
  const chips: [string, number][] = [['SOQ', g.combined.soq], ['Norm', g.combined.norm], ['SOH', g.combined.soh], ['SIT', g.combined.sit], ['Stock', g.combined.stock]];
  return (
    <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, mb: 1, overflow: 'hidden', bgcolor: C.white }}>
      <Box onClick={onToggle} title={g.reason} sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1.25, cursor: 'pointer', userSelect: 'none', bgcolor: '#FCF7F6', flexWrap: 'wrap' }}>
        <ChevronRightIcon sx={{ fontSize: 18, color: C.red, transition: 'transform .15s', transform: open ? 'rotate(90deg)' : 'none' }} />
        <Box sx={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: C.navy }}>{g.db}</Box>
        {g.db_name && <Box title={g.db_name} sx={{ fontSize: 12, color: C.slate, fontWeight: 600, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.db_name}</Box>}
        <Box sx={{ fontFamily: MONO, fontSize: 12.5, color: C.muted }}>· CFA {g.cfa}</Box>
        <Box component="span" sx={{ px: 0.8, py: 0.15, borderRadius: `${RADIUS.sm}px`, fontSize: 10.5, fontWeight: 800, letterSpacing: '.03em', bgcolor: cr ? C.amberP : C.redP, color: cr ? C.warnText : C.red }}>{cr ? 'CLUSTER' : 'DEMAND'}</Box>
        <Box sx={{ flex: 1, minWidth: 8 }} />
        {chips.map(([k, v]) => (
          <Box key={k} sx={{ textAlign: 'right', minWidth: 60 }}>
            <Box sx={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.muted }}>{k}</Box>
            <Box sx={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: k === 'Stock' ? C.green : C.navy }}>{nf(v)}</Box>
          </Box>
        ))}
        <Box component="span" sx={{ ml: 1, fontSize: 11, fontWeight: 700, color: C.muted, whiteSpace: 'nowrap' }}>{open ? 'hide' : `${g.rows.length} reg-zsku`}</Box>
      </Box>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ maxHeight: 380, overflow: 'auto', borderTop: `1px solid ${C.rule}` }}>
          <Table stickyHeader size="small">
            <TableHead><TableRow>
              {['reg-zsku', 'Description', 'SOQ', 'Norm', 'SOH', 'SIT', 'Stock'].map((h, i) => (
                <TableCell key={h} align={i >= 2 ? 'right' : 'left'} sx={{ fontFamily: SANS, whiteSpace: 'nowrap' }}>{h}</TableCell>
              ))}
            </TableRow></TableHead>
            <TableBody>
              {g.rows.map((r) => (
                <TableRow key={r.reg_zsku} hover>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12.5, whiteSpace: 'nowrap' }}>{r.reg_zsku}</TableCell>
                  <TableCell sx={{ whiteSpace: 'normal', fontSize: 12 }} title={descOf(r.reg_zsku)}>{descOf(r.reg_zsku) || '—'}</TableCell>
                  <TableCell sx={numCell}>{nf(r.soq)}</TableCell>
                  <TableCell sx={numCell}>{nf(r.norm)}</TableCell>
                  <TableCell sx={numCell}>{nf(r.soh)}</TableCell>
                  <TableCell sx={numCell}>{nf(r.sit)}</TableCell>
                  <TableCell sx={{ ...numCell, fontWeight: 700, color: C.green }}>{nf(r.stock)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      </Collapse>
    </Box>
  );
}

// server-paged navigator for the dropped-distributors list — "from–to of total" + Prev/Next
function DropPager({ total, page, loading, onPrev, onNext }:
  { total: number; page: number; loading: boolean; onPrev: () => void; onNext: () => void }) {
  const from = total === 0 ? 0 : page * DROP_PAGE + 1;
  const to = Math.min((page + 1) * DROP_PAGE, total);
  const hasPrev = page > 0, hasNext = to < total;
  const btn = (on: boolean) => ({ px: 1.25, py: 0.5, borderRadius: `${RADIUS.sm}px`, border: `1px solid ${on ? C.navy : C.rule}`,
    cursor: on ? 'pointer' : 'default', fontSize: 12, fontWeight: 700, color: on ? C.navy : C.muted, opacity: on ? 1 : 0.5,
    bgcolor: C.white, userSelect: 'none' as const, '&:hover': on ? { bgcolor: C.navyP } : {} });
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, my: 1 }}>
      <Box sx={{ fontSize: 12, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{loading ? 'loading…' : `${nf(from)}–${nf(to)} of ${nf(total)} dropped`}</Box>
      <Box sx={{ flex: 1 }} />
      <Box onClick={() => hasPrev && onPrev()} sx={btn(hasPrev)}>{'‹'} Prev</Box>
      <Box onClick={() => hasNext && onNext()} sx={btn(hasNext)}>Next {'›'}</Box>
    </Box>
  );
}

export default function FilteredSoqPage({ date, cfa }: { date?: string; cfa?: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from data===null: an empty payload,
  const [err, setErr] = useState<string | null>(null);   // or an early return, would then spin forever
  const [nonce, setNonce] = useState(0);            // bumped by the error Retry to re-run the effect
  const [view, setView] = useState<'all' | 'kept' | 'dropped'>('all');
  const [q, setQ] = useState('');
  const [openSec, setOpenSec] = useState<Record<string, boolean>>({});   // collapsible tables — all closed by default
  const toggle = (kk: string) => setOpenSec((p) => ({ ...p, [kk]: !(p[kk] ?? false) }));
  const descOf = useRegZskuDesc();
  // Dropped-distributors section — lazy (its SOH/SIT come from a REAL-TIME S3 read, not cheap): fetched only on first
  // expand, cached, and dropped whenever the run (date/cfa) changes so a re-open re-fetches for the new run.
  const [dropped, setDropped] = useState<DroppedPayload | null>(null);
  const [droppedLoading, setDroppedLoading] = useState(false);
  const [droppedErr, setDroppedErr] = useState<string | null>(null);
  const [openDb, setOpenDb] = useState<Record<string, boolean>>({});
  const [droppedPage, setDroppedPage] = useState(0);   // 0-based page of the dropped-distributors list
  const [droppedQ, setDroppedQ] = useState('');        // dropped-section search box (immediate)
  const [droppedQQ, setDroppedQQ] = useState('');      // debounced value that drives the SERVER search (across ALL dropped)

  useEffect(() => {                       // decision + kept rows, SCOPED to the GLOBAL header CFA (lazy)
    if (!cfa) { setData(null); setErr(null); setLoading(false); return; }   // no CFA -> nothing to fetch, not "loading"
    let alive = true;
    setData(null); setErr(null); setLoading(true);
    api.filteredSoq(date, cfa).then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, cfa, nonce]);

  useEffect(() => { const t = setTimeout(() => setDroppedQQ(droppedQ.trim()), 300); return () => clearTimeout(t); }, [droppedQ]);   // debounce the box → server
  useEffect(() => { setDroppedPage(0); }, [droppedQQ]);   // new search → back to page 1
  useEffect(() => { setDropped(null); setOpenDb({}); setDroppedPage(0); setDroppedQ(''); setDroppedQQ(''); }, [date, cfa, nonce]);   // new run → reset the dropped view
  useEffect(() => {                          // lazy-load ONE page of the dropped detail when open; re-fetch on page OR search change
    if (!(openSec['dropped'] && cfa)) return;
    const wantOffset = droppedPage * DROP_PAGE;
    if (dropped && dropped.offset === wantOffset && (dropped.q ?? '') === droppedQQ) return;   // already have this page + search
    let alive = true; setDroppedErr(null); setDroppedLoading(true);
    api.filteredSoqDropped(date, cfa, DROP_PAGE, wantOffset, droppedQQ).then((r) => { if (alive) setDropped(r as DroppedPayload); })
      .catch((e: unknown) => { if (alive) setDroppedErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setDroppedLoading(false); });
    return () => { alive = false; };
  }, [openSec, date, cfa, droppedPage, droppedQQ, dropped]);

  const needle = q.trim().toLowerCase();
  const decision = useMemo(() => (data?.decision ?? [])
    .filter((d) => view === 'all' || (view === 'kept' ? (d.kept && !d.cluster_reject) : !d.kept))   // 'kept' = clears BOTH gates (cluster-rejected are NOT kept)
    .filter((d) => !needle || `${d.db} ${d.cfa} ${d.reason}`.toLowerCase().includes(needle)),
  [data, view, needle]);
  const rows = useMemo(() => (data?.rows ?? [])
    .filter((r) => !needle || r.slice(0, 3).join(' ').toLowerCase().includes(needle)), [data, needle]);

  if (err) return <Shell><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (loading) return <Shell><PageSkeleton kpis={5} rows={8} /></Shell>;
  if (!cfa) return <Shell><EmptyState title="Pick a CFA to continue"
    hint="This page is scoped to one CFA. Choose one in the run-context bar above." /></Shell>;
  if (!data) return <Shell><EmptyState title="No data for this run"
    hint="Nothing was returned for this date and CFA. Try another run date, or run the pipeline first." /></Shell>;
  if (!data.available) return <Shell>
    <Box sx={{ mt: 2, p: 2, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${C.gold}`, borderRadius: `${RADIUS.md}px`, bgcolor: C.amberP, color: C.slate }}>
      {data.note || 'No filtered SOQ for this date yet — run the pipeline first.'}
    </Box>
  </Shell>;

  const s = data.summary;
  const Kpi = ({ label, val, suffix, fg, bar }: { label: string; val: number | string; suffix?: string; fg: string; bar: string }) => (
    <Box sx={{ flex: 1, minWidth: 150, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${bar}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, p: 1.5, bgcolor: C.white }}>
      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted }}>{label}</Box>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 26, color: fg, lineHeight: 1.1 }}>
        {typeof val === 'number' ? nf(val) : val}{suffix}
      </Box>
    </Box>
  );

  return (
    <Shell>
      {/* THE RULE */}
      <Box sx={{ mt: 1.5, p: 1.75, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${C.navy}`, borderRadius: `${RADIUS.md}px`, bgcolor: C.navyP }}>
        <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.5 }}>▸ The demand gate</Box>
        <Box sx={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: C.slate }}>{data.rule}</Box>
        <Box sx={{ fontSize: 12.5, color: C.muted, mt: 0.5 }}>
          Flags come from the SOQ feed (is_pdp · is_below_threashold · is_combined_soq_greater_than_65_percentage), read
          per (DB, CFA). Every downstream step runs on the kept subset only.
        </Box>
      </Box>

      {/* KPIs */}
      <Stack direction="row" spacing={1.5} sx={{ mt: 2, flexWrap: 'wrap', gap: 1.5 }}>
        <Kpi label="(DB,CFA) kept" val={s.groups_kept ?? 0} suffix={` / ${nf(s.groups_total ?? 0)}`} fg={C.green} bar={C.green} />
        <Kpi label="(DB,CFA) dropped" val={s.groups_dropped ?? 0} fg={C.red} bar={C.red} />
        <Kpi label="SOQ lines kept" val={s.rows_kept ?? 0} suffix={` / ${nf(s.rows_total ?? 0)}`} fg={C.navy} bar={'#D04A02'} />
        <Kpi label="DBs in run" val={s.dbs_kept ?? 0} fg={C.navy} bar={C.gold} />
        <Kpi label="Cluster-rejected" val={s.groups_cluster_rejected ?? 0} fg={C.warnText} bar={C.gold} />
      </Stack>

      {/* Per-(DB, CFA) decision — collapsible card, closed by default */}
      <Box onClick={() => toggle('decision')} sx={{ display: 'flex', alignItems: 'center', gap: 0.6, cursor: 'pointer', userSelect: 'none', mt: 2.5, mb: 1,
        p: 1.5, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${C.navy}`, borderRadius: `${RADIUS.md}px`, bgcolor: '#F5F7F8', boxShadow: SHADOW.sm }}>
        <ChevronRightIcon sx={{ fontSize: 20, color: C.navy, transition: 'transform .15s', transform: (openSec['decision'] ?? false) ? 'rotate(90deg)' : 'none' }} />
        <Box component="h2" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 19, m: 0 }}>Per-(DB, CFA) decision</Box>
        <Box component="span" sx={{ fontSize: 12.5, color: C.muted }}>· kept <b style={{ color: C.green }}>{s.groups_kept ?? 0}</b> · dropped <b style={{ color: C.red }}>{s.groups_dropped ?? 0}</b></Box>
        <Box sx={{ flex: 1 }} />
        <Box component="span" sx={{ fontSize: 11, fontWeight: 700, color: C.muted }}>{(openSec['decision'] ?? false) ? 'hide' : 'show'}</Box>
      </Box>
      <Collapse in={openSec['decision'] ?? false} unmountOnExit>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1, flexWrap: 'wrap' }}>
        {(['all', 'kept', 'dropped'] as const).map((v) => (
          <Box key={v} component="button" onClick={() => setView(v)}
            sx={{ cursor: 'pointer', border: `1px solid ${view === v ? C.navy : C.rule}`, bgcolor: view === v ? C.navy : C.white,
              color: view === v ? C.white : C.slate, borderRadius: `${RADIUS.sm}px`, px: 1.25, py: 0.35, fontSize: 12, fontWeight: 700,
              fontFamily: SANS, textTransform: 'capitalize' }}>
            {v}{v === 'kept' ? ` (${s.groups_kept ?? 0})` : v === 'dropped' ? ` (${s.groups_dropped ?? 0})` : ''}
          </Box>
        ))}
        <Box component="input" placeholder="filter DB / CFA / reason…" value={q} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQ(e.target.value)}
          sx={{ ml: 'auto', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px`, px: 1, py: 0.4, fontSize: 12.5, fontFamily: SANS, minWidth: 220 }} />
        <ExportXlsxButton label="Download Excel" size="sm" disabled={!(data.rows?.length)}
          onClick={() => downloadXlsxMulti(`filtered_soq_${data.date}`, [
            { name: 'Filtered SOQ', headers: data.columns, rows: data.rows },
            { name: 'Decision', headers: ['DB', 'CFA', 'PDP', 'Below-threshold', 'Combined>65%', 'Combined SOQ', 'Truck cap', 'Cap source', 'Cluster', 'Decision', 'Reason'],
              rows: data.decision.map((x) => [x.db, x.cfa, x.pdp ? 'Yes' : 'No', x.has_below ? 'Yes' : 'No', x.combined ? 'Yes' : 'No', x.combined_soq ?? 0, x.truck_cap ?? '', x.truck_cap_src ?? '', x.cluster ?? '', x.cluster_reject ? 'CLUSTER' : x.kept ? 'KEPT' : 'DROPPED', x.reason]) },
          ])} />
      </Stack>

      {/* DECISION table */}
      <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'hidden', bgcolor: C.white }}>
        <Box sx={{ maxHeight: 460, overflow: 'auto' }}>
          <Table stickyHeader size="small">
            <TableHead>
              <TableRow>
                {['DB ID', 'CFA', 'PDP', 'Below-thresh', 'Combined>65%', 'Combined SOQ', 'Truck cap', 'Cap source', 'Decision', 'Reason'].map((h, i) => (
                  <TableCell key={h} align={i >= 2 && i <= 4 ? 'center' : (i === 5 || i === 6) ? 'right' : 'left'} sx={{ fontFamily: SANS, whiteSpace: 'nowrap' }}>{h}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {decision.map((d, i) => (
                <TableRow key={`${d.db}-${d.cfa}-${i}`} hover>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12.5 }}>{d.db}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12.5 }}>{d.cfa}</TableCell>
                  <TableCell align="center"><Flag on={d.pdp} /></TableCell>
                  <TableCell align="center"><Flag on={d.has_below} /></TableCell>
                  <TableCell align="center"><Flag on={d.combined} /></TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{(d.combined_soq ?? 0).toLocaleString()}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5, fontVariantNumeric: 'tabular-nums', color: d.truck_cap == null ? C.muted : C.slate }}>{d.truck_cap != null ? d.truck_cap.toLocaleString() : '—'}</TableCell>
                  <TableCell sx={{ fontSize: 11.5, whiteSpace: 'nowrap', color: d.truck_cap_src == null ? C.muted : d.truck_cap_src.startsWith('Transshipment') ? C.warnText : C.slate }}>{d.truck_cap_src ?? '—'}</TableCell>
                  <TableCell><Badge d={d} /></TableCell>
                  <TableCell sx={{ fontSize: 12.5, color: d.kept ? C.slate : C.muted }}>{d.reason}</TableCell>
                </TableRow>
              ))}
              {decision.length === 0 && <TableRow><TableCell colSpan={10} sx={{ color: C.muted, py: 3, textAlign: 'center' }}>No rows match.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </Box>
      </Box>
      </Collapse>

      {/* CLUSTER GATE — single-distributor clusters rejected (2nd level, after the demand gate) */}
      {(data.cluster_rejects?.length ?? 0) > 0 && (
        <Box sx={{ mt: 3 }}>
          <Box onClick={() => toggle('cluster')} sx={{ p: 1.75, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${C.warnText}`, borderRadius: `${RADIUS.md}px`, bgcolor: C.amberP, mb: 1, cursor: 'pointer', userSelect: 'none' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <ChevronRightIcon sx={{ fontSize: 17, color: C.warnText, transition: 'transform .15s', transform: (openSec['cluster'] ?? false) ? 'rotate(90deg)' : 'none' }} />
              <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.warnText }}>The cluster gate · needs ≥2 distributors · {data.cluster_rejects!.length} rejected</Box>
              <Box sx={{ flex: 1 }} />
              <Box component="span" sx={{ fontSize: 11, fontWeight: 700, color: C.warnText }}>{(openSec['cluster'] ?? false) ? 'hide' : 'show'}</Box>
            </Box>
            <Box sx={{ fontSize: 13, color: C.slate, mt: 0.5 }}>
              A transshipment cluster needs <b>≥2 distributors in the run</b> to consolidate a primary truck. These <b>{data.cluster_rejects!.length}</b> (DB, CFA)
              cleared the demand gate, but their cluster ended up with a <b>single distributor</b> — so they are <b>NOT stored in filtered_soq</b> and never enter the engine.
            </Box>
          </Box>
          <Collapse in={openSec['cluster'] ?? false} unmountOnExit>
          <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'hidden', bgcolor: C.white }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {['DB ID', 'CFA', 'Cluster', 'Combined SOQ', 'Reason'].map((h, i) => (
                    <TableCell key={h} align={i === 3 ? 'right' : 'left'} sx={{ fontFamily: SANS, whiteSpace: 'nowrap' }}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {data.cluster_rejects!.map((d, i) => (
                  <TableRow key={`cr-${d.db}-${d.cfa}-${i}`} hover>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 12.5 }}>{d.db}</TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 12.5 }}>{d.cfa}</TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 12.5, color: C.warnText, fontWeight: 700 }}>{d.cluster ?? '—'}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{(d.combined_soq ?? 0).toLocaleString()}</TableCell>
                    <TableCell sx={{ fontSize: 12.5, color: C.muted }}>{d.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
          </Collapse>
        </Box>
      )}

      {/* KEPT SOQ lines — collapsible card, closed by default */}
      <Box onClick={() => toggle('kept')} sx={{ display: 'flex', alignItems: 'center', gap: 0.6, cursor: 'pointer', userSelect: 'none', mt: 3, mb: 1,
        p: 1.5, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${C.green}`, borderRadius: `${RADIUS.md}px`, bgcolor: '#F0FAF3', boxShadow: SHADOW.sm }}>
        <ChevronRightIcon sx={{ fontSize: 20, color: C.green, transition: 'transform .15s', transform: (openSec['kept'] ?? false) ? 'rotate(90deg)' : 'none' }} />
        <Box component="h2" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 19, m: 0 }}>Kept SOQ lines</Box>
        <Box component="span" sx={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: C.muted }}>· the demand the engine runs on ({nf(rows.length)} shown)</Box>
        <Box sx={{ flex: 1 }} />
        <Box component="span" sx={{ fontSize: 11, fontWeight: 700, color: C.muted }}>{(openSec['kept'] ?? false) ? 'hide' : 'show'}</Box>
      </Box>
      <Collapse in={openSec['kept'] ?? false} unmountOnExit>
      <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'hidden', bgcolor: C.white }}>
        <Box sx={{ maxHeight: 560, overflow: 'auto' }}>
          <Table stickyHeader size="small">
            <TableHead>
              <TableRow>
                {data.columns.map((h) => (
                  <Fragment key={h}>
                    <TableCell align={NUM_COLS.has(h) ? 'right' : 'left'} sx={{ fontFamily: SANS, whiteSpace: 'nowrap' }}>{h}</TableCell>
                    {h === 'reg-zsku' && <TableCell align="left" sx={{ fontFamily: SANS, whiteSpace: 'nowrap' }}>Description</TableCell>}
                  </Fragment>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r, ri) => (
                <TableRow key={ri} hover>
                  {r.map((c, ci) => (
                    <Fragment key={ci}>
                      <TableCell sx={NUM_COLS.has(data.columns[ci]) ? num : { fontSize: 12.5, fontFamily: data.columns[ci] === 'reg-zsku' ? MONO : SANS, whiteSpace: 'nowrap' }}>
                        {String(c)}
                      </TableCell>
                      {data.columns[ci] === 'reg-zsku' && (
                        <TableCell sx={{ whiteSpace: 'normal' }} title={descOf(String(c))}>{descOf(String(c)) || '—'}</TableCell>
                      )}
                    </Fragment>
                  ))}
                </TableRow>
              ))}
              {rows.length === 0 && <TableRow><TableCell colSpan={Math.max(1, data.columns.length + (data.columns.includes('reg-zsku') ? 1 : 0))} sx={{ color: C.muted, py: 3, textAlign: 'center' }}>No lines.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </Box>
      </Box>
      </Collapse>

      {/* DROPPED distributors — reg-zsku + DB-combined norm/SOQ/SOH/SIT (SOH/SIT read live from S3) */}
      <Box onClick={() => toggle('dropped')} sx={{ display: 'flex', alignItems: 'center', gap: 0.6, cursor: 'pointer', userSelect: 'none', mt: 3, mb: 1,
        p: 1.5, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${C.red}`, borderRadius: `${RADIUS.md}px`, bgcolor: '#FCF3F2', boxShadow: SHADOW.sm }}>
        <ChevronRightIcon sx={{ fontSize: 20, color: C.red, transition: 'transform .15s', transform: (openSec['dropped'] ?? false) ? 'rotate(90deg)' : 'none' }} />
        <Box component="h2" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 19, m: 0 }}>Dropped distributors — full stock detail</Box>
        <Box component="span" sx={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: C.muted }}>· norm · SOQ · SOH · SIT at reg-zsku + DB level (SOH/SIT live from S3){dropped ? ` · ${dropped.count}` : ''}</Box>
        <Box sx={{ flex: 1 }} />
        <Box component="span" sx={{ fontSize: 11, fontWeight: 700, color: C.muted }}>{(openSec['dropped'] ?? false) ? 'hide' : 'show'}</Box>
      </Box>
      <Collapse in={openSec['dropped'] ?? false} unmountOnExit>
        {droppedErr ? <ErrorState error={droppedErr} onRetry={() => { setDropped(null); setDroppedErr(null); }} />
          : (!dropped && droppedLoading) ? (
            <Box>
              <Box sx={{ fontSize: 12.5, color: C.muted, mb: 1 }}>Reading stock (SOH/SIT) from S3 in real time — the first open can take a few seconds; it's cached after that.</Box>
              <PageSkeleton kpis={0} rows={6} />
            </Box>
          )
          : dropped ? (
            <>
              {/* SEARCH — any field: DB name/code · CFA · reg-zsku code + description · reason (server-side, across ALL dropped) */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
                <Box sx={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flex: 1, minWidth: 260, maxWidth: 460 }}>
                  <Box component="input" value={droppedQ} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDroppedQ(e.target.value)}
                    placeholder="Search DB name / code · CFA · reg-zsku · description · reason…"
                    sx={{ width: '100%', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px`, px: 1, py: 0.5, pr: 3.5, fontSize: 13, fontFamily: SANS }} />
                  {droppedQ && (
                    <Box component="button" type="button" onClick={() => setDroppedQ('')} aria-label="Clear search"
                      sx={{ position: 'absolute', right: 6, border: 'none', background: 'transparent', cursor: 'pointer', color: C.muted, fontSize: 17, lineHeight: 1, p: 0.25 }}>×</Box>
                  )}
                </Box>
                {droppedLoading && <Box sx={{ fontSize: 11.5, color: C.muted }}>searching…</Box>}
              </Box>
              {dropped.count > 0 ? (
                <>
                  <Box sx={{ fontSize: 12.5, color: C.muted, mb: 1 }}>
                    <b>{dropped.count}</b> dropped (DB, CFA){droppedQQ ? <> matching “<b>{droppedQQ}</b>”</> : null} · SOH &amp; SIT live from S3 at data date <b>{dropped.data_date}</b>. Click a distributor to open its reg-zsku lines.
                  </Box>
                  <DropPager total={dropped.count} page={droppedPage} loading={droppedLoading}
                    onPrev={() => setDroppedPage((p) => Math.max(0, p - 1))} onNext={() => setDroppedPage((p) => p + 1)} />
                  <Box sx={{ opacity: droppedLoading ? 0.5 : 1, transition: 'opacity .15s' }}>
                    {dropped.dropped.map((g) => {
                      const k = `${g.db}-${g.cfa}`;
                      return <DroppedCard key={k} g={g} open={openDb[k] ?? false}
                        onToggle={() => setOpenDb((p) => ({ ...p, [k]: !(p[k] ?? false) }))} descOf={descOf} />;
                    })}
                  </Box>
                  {dropped.count > DROP_PAGE && (
                    <DropPager total={dropped.count} page={droppedPage} loading={droppedLoading}
                      onPrev={() => setDroppedPage((p) => Math.max(0, p - 1))} onNext={() => setDroppedPage((p) => p + 1)} />
                  )}
                </>
              ) : (
                <Box sx={{ p: 3, textAlign: 'center', color: C.muted, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, bgcolor: '#FAFAFA' }}>
                  {droppedQQ ? <>No dropped distributors match “<b>{droppedQQ}</b>”.</> : 'No dropped distributors for this CFA / date — every (DB, CFA) cleared both gates.'}
                </Box>
              )}
            </>
          ) : null}
      </Collapse>
    </Shell>
  );
}
