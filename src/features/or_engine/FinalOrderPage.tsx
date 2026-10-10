import { useEffect, useMemo, useState } from 'react';
import { Box, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { isTracked, trackedRowSxFor, TRACK_STAR } from '../../demo';
import PageIntro from '../../shared/PageIntro';
import { useOeParams, pct } from '../../shared/OeParams';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';

/* ---------------------------------------------------------------------------
   Final Order — THE shipped order per CFA × DB × reg-zsku (post-truck-trim), in the
   functional team's format. Live from /api/final_order; the Download button hits the
   SAME endpoint with ?format=xlsx, so the sheet can never drift from the screen.
--------------------------------------------------------------------------- */
type Row = (string | number | boolean)[];
interface Payload { cols: string[]; rows: Row[]; date?: string; total?: number; transhipment_dbs?: number; }
// cols: CFA, DB, Reg-ZSKU, Norms, SOH, SOQ, Original allocated, Used as Substitute, Used as Filler, Total shipped, Truck max cases, Is_Transhipment, Cluster, Primary_Truck_Count, SO_Flag, Cluster_Trimmed
const F = { cfa: 0, db: 1, rz: 2, norm: 3, soh: 4, soq: 5, orig: 6, sub: 7, fil: 8, tot: 9, truckMax: 10, tr: 11, cluster: 12, prim: 13, soFlag: 14, clusterTrimmed: 15 };
const nf = (n: number) => Math.round(Number(n) || 0).toLocaleString();
const num = { textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums', fontFamily: MONO, fontSize: 12.5, whiteSpace: 'nowrap' as const };

const Shell = ({ children }: { children: React.ReactNode }) => (
  <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
    <Box sx={{ maxWidth: 1320, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
      <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>
        Final Order · Reg-ZSKU level · the shipped order
      </Box>
      <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: '6px 0 8px' }}>
        Final Order · Reg-ZSKU level — one row per CFA × DB × Reg-ZSKU
      </Box>
      {children}
    </Box>
  </Box>
);

export default function FinalOrderPage({ date }: { date?: string }) {
  const P = useOeParams();
  const descOf = useRegZskuDesc();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from data===null: a run with 0 order
  const [err, setErr] = useState<string | null>(null);   // lines, or a failed call, would then spin forever
  const [nonce, setNonce] = useState(0);           // bumped by the error Retry to re-run the effect
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null); setLoading(true);
    api.finalOrder(date).then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, nonce]);

  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => (data?.rows ?? []).filter(
    (r) => !needle || `${r[F.cfa]} ${r[F.db]} ${r[F.rz]}`.toLowerCase().includes(needle)), [data, needle]);
  const totals = useMemo(() => {
    const s = { norm: 0, soh: 0, soq: 0, orig: 0, sub: 0, fil: 0, tot: 0, soCreated: 0, rlmHeld: 0 };
    for (const r of rows) {
      s.norm += Number(r[F.norm]); s.soh += Number(r[F.soh]); s.soq += Number(r[F.soq]);
      s.orig += Number(r[F.orig]); s.sub += Number(r[F.sub]); s.fil += Number(r[F.fil]); s.tot += Number(r[F.tot]);
      // SO_CREATION = truly shipped; RLM_* = ON HOLD (pending approval) — NOT counted as shipped/allocated
      const flag = String(r[F.soFlag]);
      if (flag === 'SO_CREATION') s.soCreated += Number(r[F.tot]);
      else if (flag === 'RLM_TRUCK_APPROVAL' || flag === 'RLM_FOR_SECOND_CFA') s.rlmHeld += Number(r[F.tot]);
    }
    return s;
  }, [rows]);

  if (err) return <Shell><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (loading) return <Shell><PageSkeleton kpis={4} rows={10} /></Shell>;
  if (!data) return <Shell><EmptyState title="No final order for this run"
    hint="Nothing was returned for this run date — the pipeline may not have produced a shipped order yet. Try another run date, or run the pipeline first." /></Shell>;

  const Kpi = ({ label, val, suffix, fg, bar }: { label: string; val: number; suffix?: string; fg: string; bar: string }) => (
    <Box sx={{ flex: 1, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${bar}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, p: 1.5, bgcolor: C.white }}>
      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted }}>{label}</Box>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 26, color: fg, lineHeight: 1.1 }}>{nf(val)}{suffix}</Box>
    </Box>
  );
  const th = (h: string, a: 'left' | 'right' | 'center' = 'right') => (
    <TableCell key={h} align={a} sx={{ fontFamily: SANS, whiteSpace: 'nowrap' }}>{h}</TableCell>
  );

  return (
    <Shell>
      <PageIntro>
        Per <b>CFA × DB × reg-zsku</b> — <b>every demanded reg-zsku</b>, including lines allocated nowhere (shown 0/0/0/0:
        lost the fair-share or had 0 CFA stock). Each row shows how that reg-zsku was used: <b>Original</b> (its own demand),
        <b>Used as Substitute</b> / <b>Used as Filler</b> = its cases shipped AS a sub/filler for OTHER demand lines. So
        <b>Σ SOQ here = the full demand book</b> (a {pct(P.ADDON_CAP_PCT)}-of-SOQ check ties out to the engine). <b>Total shipped = Original + Substitute + Filler</b>.
        For an <b>Is_Transhipment</b> lane the order is <b>created on the cluster's PRIMARY truck</b> (never the per-DB secondary): <b>Primary_Truck_Count</b> = the <b>cluster</b>'s integer full primary trucks and <b>Truck max cases</b> = that primary truck's capacity (one route per cluster — see the Cluster Primary page).
        <b> Truck max cases</b> for a plain DB = its own truck-master cap.
        Download gives the same rows as an Excel sheet.
      </PageIntro>

      <Box sx={{ display: 'flex', gap: 1.5, mb: 2 }}>
        <Kpi label="Order lines" val={data.rows.length} fg={C.navy} bar={C.navy} />
        <Kpi label="SO cases created" val={totals.soCreated} suffix=" cs" fg={C.success} bar={C.success} />
        {totals.rlmHeld > 0 && <Kpi label="On hold · RLM" val={totals.rlmHeld} suffix=" cs" fg={C.warnText} bar={C.gold} />}
        <Kpi label="Transshipment DBs" val={data.transhipment_dbs ?? 0} fg={C.warnText} bar={C.gold} />
      </Box>

      <Box sx={{ display: 'flex', gap: 1.25, mb: 1.75, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by CFA, DB or Reg-ZSKU…"
          style={{ flex: 1, minWidth: 240, maxWidth: 380, padding: '8px 12px', fontSize: 13, fontFamily: SANS, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
        <Box sx={{ flex: 1 }} />
        <a href={api.finalOrderXlsxUrl(date)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none', padding: '8px 16px',
            fontSize: 13, fontWeight: 800, color: '#fff', background: C.navy, borderRadius: RADIUS.sm, boxShadow: SHADOW.sm }}>
          <DownloadIcon sx={{ fontSize: 17 }} /> Download Excel
        </a>
      </Box>
      <Box sx={{ fontSize: 12, color: C.muted, mb: 0.5 }}>{nf(rows.length)} lines{q ? ` matching “${q}”` : ''}</Box>

      <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'auto', maxHeight: '68vh' }}>
        <Table size="small" stickyHeader sx={{ minWidth: 'max-content' }}>
          <TableHead><TableRow>
            {th('CFA', 'left')}{th('DB', 'left')}{th('Reg-ZSKU', 'left')}{th('Description', 'left')}{th('Norms')}{th('SOH')}{th('SOQ')}
            {th('Original allocated')}{th('Used as Substitute')}{th('Used as Filler')}{th('Total shipped')}{th('Truck max cases')}{th('Transship?', 'center')}{th('Cluster', 'center')}{th('Primary trucks', 'center')}{th('SO Flag', 'center')}
          </TableRow></TableHead>
          <TableBody>
            {rows.length === 0 && <TableRow><TableCell colSpan={16} sx={{ color: C.muted, py: 2 }}>No lines match.</TableCell></TableRow>}
            {rows.map((r, i) => {
              const isTr = Boolean(r[F.tr]);
              const db = r[F.db];
              const tracked = isTracked(db);
              const trimmed = Number(r[F.clusterTrimmed]) || 0;
              // A transshipment lane can ship < SOQ because the cluster primary-truck pass trimmed it to fit
              // integer full primary trucks — NOT a plain fair-share loss. Flag it so the green SO_CREATION isn't misread.
              const undershipTrim = isTr && trimmed > 0 && Number(r[F.tot]) < Number(r[F.soq]);
              return (
                <TableRow key={i} sx={{ bgcolor: isTr ? '#FFF5ED' : undefined, ...trackedRowSxFor(db) }}>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{r[F.cfa]}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: C.navy, fontWeight: 700 }}>{tracked ? TRACK_STAR + ' ' : ''}{db}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: C.slate }}>{r[F.rz]}</TableCell>
                  <TableCell sx={{ whiteSpace: 'normal' }} title={descOf(String(r[F.rz]))}>{descOf(String(r[F.rz])) || '—'}</TableCell>
                  <TableCell sx={{ ...num, color: C.muted }}>{nf(r[F.norm] as number)}</TableCell>
                  <TableCell sx={{ ...num, color: C.muted }}>{nf(r[F.soh] as number)}</TableCell>
                  <TableCell sx={num}>{nf(r[F.soq] as number)}</TableCell>
                  <TableCell sx={{ ...num, color: C.navy, fontWeight: 700 }}>{nf(r[F.orig] as number)}</TableCell>
                  <TableCell sx={{ ...num, color: Number(r[F.sub]) > 0 ? C.success : C.muted }}>{nf(r[F.sub] as number)}</TableCell>
                  <TableCell sx={{ ...num, color: Number(r[F.fil]) > 0 ? C.warnText : C.muted }}>{nf(r[F.fil] as number)}</TableCell>
                  <TableCell sx={{ ...num, fontWeight: 800, color: C.success }}>
                    {nf(r[F.tot] as number)}
                    {undershipTrim && (
                      <Box component="span"
                        title={`Trimmed ${nf(trimmed)} cs to fit cluster ${String(r[F.cluster] || '')}'s ${nf(Number(r[F.prim]))} full primary truck(s) — not a fair-share loss`}
                        sx={{ ml: 0.6, px: 0.6, py: 0.15, borderRadius: 1, fontWeight: 800, fontSize: 9.5, verticalAlign: 'middle', bgcolor: '#FFE8D4', color: C.warnText, cursor: 'help' }}>
                        −{nf(trimmed)} trim
                      </Box>
                    )}
                  </TableCell>
                  <TableCell sx={{ ...num, color: C.slate }} title="Max cases of the truck the order is created on — the cluster's PRIMARY truck cap for a transshipment lane, else this DB's own truck-master cap">{nf(r[F.truckMax] as number)}</TableCell>
                  <TableCell align="center">{isTr
                    ? <Box component="span" title="Order created on the cluster's PRIMARY truck (transshipment)" sx={{ px: 0.9, py: 0.2, borderRadius: 1, fontWeight: 800, fontSize: 11, bgcolor: '#FFE8D4', color: '#C52B09' }}>▸ primary</Box>
                    : <span style={{ color: C.muted }}>—</span>}</TableCell>
                  <TableCell align="center" sx={{ fontFamily: MONO, fontSize: 11.5, color: C.muted }}>{isTr ? String(r[F.cluster] || '—') : '—'}</TableCell>
                  <TableCell align="center" sx={{ ...num, textAlign: 'center', color: C.muted }} title="CLUSTER primary trucks (INTEGER full trucks, shared across the cluster's DBs) — the truck count emitted to the order">{isTr && Number(r[F.prim]) > 0 ? nf(r[F.prim] as number) : '—'}</TableCell>
                  <TableCell align="center">{(() => {
                    const f = String(r[F.soFlag] || ''); const green = f === 'SO_CREATION';
                    return f
                      ? <Box component="span" title="SO disposition (from the shipped order)" sx={{ px: 0.8, py: 0.2, borderRadius: 1, fontWeight: 800, fontSize: 10, whiteSpace: 'nowrap', bgcolor: green ? '#E9F4EC' : '#FFE8D4', color: green ? C.success : '#C52B09' }}>{f}</Box>
                      : <span style={{ color: C.muted }}>—</span>;
                  })()}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>

      <Box sx={{ display: 'flex', gap: 3, mt: 1, fontFamily: MONO, fontSize: 12.5, color: C.navy, fontWeight: 700, flexWrap: 'wrap' }}>
        <span>TOTAL — Norms {nf(totals.norm)} · SOH {nf(totals.soh)} · SOQ {nf(totals.soq)}</span>
        <span>Original {nf(totals.orig)} · Substitute {nf(totals.sub)} · Filler {nf(totals.fil)} · <b style={{ color: C.success }}>SO created {nf(totals.soCreated)}</b>{totals.rlmHeld > 0 ? <> · <b style={{ color: C.warnText }}>on hold · RLM {nf(totals.rlmHeld)}</b></> : null}</span>
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.rule}`, mt: 3, pt: 1, fontSize: 9, color: C.muted }}>
        <span>AI Order Optimizer · Final Order (shipped, post-truck-trim) · sample data</span>
        <span>CFA × DB × reg-zsku · Original → Substitute → Filler</span>
      </Box>
    </Shell>
  );
}
