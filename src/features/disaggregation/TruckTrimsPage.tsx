import { useEffect, useMemo, useState } from 'react';
import { Box, Dialog, IconButton, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import CloseIcon from '@mui/icons-material/Close';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { downloadXlsxMulti, ExportXlsxButton } from '../../shared/exportXlsx';
import { isTracked, trackedRowSxFor, TRACK_STAR } from '../../demo';
import { useOeParams, pct } from '../../shared/OeParams';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';


/* ---------------------------------------------------------------------------
   Truck Trims — what the truck rule removed, per (run, CFA, DB, reg-zsku):
     TRUCK_TAIL_CASCADE       the remainder truck's tail shaved off a lane (filler→sub→original,
                              least-needy first) so its shipped trucks stay ≥65% & ≤cap
     LANE_DROP_<65%           a whole lane dropped because its remainder truck couldn't reach 65%
     LANE_DROP_NO_TRUCK       a whole lane dropped because it has no truck_master row
     CLUSTER_DROP_<65% (code) a whole transshipment cluster dropped — its primary truck fell below 65%
     CLUSTER_PRIMARY_TRIM     post-cascade: a cluster's DBs are combined onto shared primary truck(s);
                              the overflow is trimmed CROSS-DB (fillers→subs→originals, least-needy first
                              by post-alloc (on-hand+allocated)/Norm) and TRUCK-AWARE, each secondary truck
                              stopping at its 65% floor
   Tail-cascade & lane-drop stock is NOT consumed — it cascades to the next run.
   Cluster-primary-trim & cluster-drop stock is post-cascade and is NOT re-shipped (it is why a
   transshipment DB can carry a sub-65% secondary tail truck, or a whole cluster can be dropped).
--------------------------------------------------------------------------- */
type Row = (string | number)[];
interface Lane { run: number; channel: string; cfa: string; db: string; db_name: string; truck_type: string; is_transhipment?: boolean; truck_cap?: number; cluster?: string; reason: string; skus: number; cases: number; }
interface Payload {
  cols: string[]; rows: Row[]; lanes: Lane[];
  runs: { run: number; channel: string }[];
  summary: { run: number; reason: string; lines: number; cases: number }[];
}
const I = { run: 0, channel: 1, cfa: 2, db: 3, z: 4, oTrim: 5, sTrim: 6, fTrim: 7, reason: 8 };
const nf = (n: number) => (n ?? 0).toLocaleString();
const num = { textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums', fontFamily: MONO, fontSize: 12.5 };

export default function TruckTrimsPage({ date, cfa = '' }: { date?: string; cfa?: string }) {
  const P = useOeParams();
  const descOf = useRegZskuDesc();
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);    // explicit in-flight flag — true from the FIRST paint (the mount
                                                  // effect always fetches); NEVER infer it from data===null
  const [nonce, setNonce] = useState(0);           // bumped by the error Retry to re-run the effect
  const [run, setRun] = useState(0);
  const [q, setQ] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);  // "how it works" help modal (was the inline PageIntro block)

  // reason chip styling; label thresholds come from the live oe_parameters (keys must match backend reason strings).
  // The backend emits FOUR truck-trim reasons + a synthetic cluster-primary-trim; CLUSTER_DROP carries a dynamic
  // "(<clustercode>)" suffix, so reasonKey() strips a trailing "(…)" before the lookup / KPI bucketing.
  const REASON: Record<string, { label: string; bg: string; fg: string }> = {
    'TRUCK_TAIL_CASCADE': { label: 'Tail cascade', bg: '#FFE3A1', fg: '#000' },
    'LANE_DROP_<65%': { label: `Lane drop · <${pct(P.TRUCK_KEEP_PCT)}`, bg: '#F7BFB5', fg: '#000' },
    'LANE_DROP_NO_TRUCK': { label: 'Lane drop · no truck', bg: '#F7BFB5', fg: '#000' },
    'CLUSTER_DROP_<65%': { label: `Cluster drop · <${pct(P.TRUCK_KEEP_PCT)}`, bg: '#F7BFB5', fg: '#000' },
    'CLUSTER_PRIMARY_TRIM': { label: 'Cluster primary trim', bg: C.navyP, fg: C.navy },
  };
  const reasonKey = (reason: unknown) => String(reason ?? '').replace(/\s*\(.*\)\s*$/, '').trim();
  const reasonMetaOf = (reason: unknown) => REASON[reasonKey(reason)] ?? { label: String(reason ?? ''), bg: C.grayP, fg: C.muted };

  useEffect(() => {
    let alive = true;
    setErr(null); setLoading(true);
    api.truckTrim(0, date).then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, nonce]);

  // rows scoped to the header CFA + run (NOT the search box) — the KPIs read this so they reflect the CFA scope
  const scopedRows = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => (!cfa || String(r[I.cfa] ?? '').trim() === cfa) && (!run || r[I.run] === run));
  }, [data, run, cfa]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return scopedRows.filter((r) => !needle || `${r[I.cfa]} ${r[I.db]} ${r[I.z]}`.toLowerCase().includes(needle));
  }, [scopedRows, q]);

  const lanes = useMemo(() => {
    if (!data?.lanes) return [];
    const needle = q.trim().toLowerCase();
    return data.lanes.filter((l) => (!cfa || String(l.cfa ?? '').trim() === cfa) && (!run || l.run === run) &&
      (!needle || `${l.cfa} ${l.db} ${l.db_name} ${l.truck_type}`.toLowerCase().includes(needle)));
  }, [data, run, q, cfa]);

  // KPIs recomputed from the CFA+run-scoped detail rows (summing Orig+Sub+Fil per reason) so they honour the CFA
  // scope — data.summary is aggregated across ALL CFAs and can't be filtered by CFA.
  const kpi = useMemo(() => {
    let tail = 0, drop = 0, cluster = 0;
    for (const r of scopedRows) {
      const c = (Number(r[I.oTrim]) || 0) + (Number(r[I.sTrim]) || 0) + (Number(r[I.fTrim]) || 0);
      const rs = reasonKey(r[I.reason]);
      if (rs === 'TRUCK_TAIL_CASCADE') tail += c;
      else if (rs === 'LANE_DROP_<65%' || rs === 'LANE_DROP_NO_TRUCK' || rs === 'CLUSTER_DROP_<65%') drop += c;
      else if (rs === 'CLUSTER_PRIMARY_TRIM') cluster += c;
    }
    return { tail, drop, cluster, total: tail + drop + cluster };
  }, [scopedRows]);

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
      <Box sx={{ maxWidth: 1180, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
        <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: '#000', bgcolor: '#FFAA72', display: 'inline-block', px: 1, py: '3px', borderRadius: '2px' }}>
          Truck rule · what got trimmed
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: '6px 0 8px' }}>
            Trimmed &amp; dropped by the truck rule
          </Box>
          <IconButton size="small" onClick={() => setHelpOpen(true)} title="How this page works"
            sx={{ color: C.gold, border: `1px solid ${C.goldLight}`, bgcolor: '#FFF5ED', '&:hover': { bgcolor: '#FFE8D4', borderColor: C.gold } }}>
            <HelpOutlineIcon sx={{ fontSize: 19 }} />
          </IconButton>
          <Box component="span" sx={{ fontSize: 11.5, color: C.muted }}>how it works</Box>
        </Box>
        <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: `${RADIUS.md}px`, overflow: 'hidden', border: `1px solid ${C.goldLight}` } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2.5, py: 1.5, background: 'linear-gradient(135deg, #FE7C39 0%, #CC3D07 55%, #CC3D07 100%)', borderBottom: '1px solid rgba(0,0,0,0.10)', color: '#fff' }}>
            <HelpOutlineIcon sx={{ fontSize: 20 }} />
            <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 17 }}>How this page works</Box>
            <Box sx={{ flex: 1 }} />
            <IconButton onClick={() => setHelpOpen(false)} size="small" aria-label="close" sx={{ color: '#fff', '&:hover': { bgcolor: 'rgba(255,255,255,0.18)' } }}><CloseIcon sx={{ fontSize: 20 }} /></IconButton>
          </Box>
          <Box sx={{ p: 2.75, color: C.slate, bgcolor: '#FFF5ED', display: 'flex', flexDirection: 'column', gap: 2.75 }}>
            {/* the goal */}
            <Box sx={{ p: '10px 12px', borderRadius: `${RADIUS.sm}px`, bgcolor: '#FFF5ED', border: `1px solid ${C.goldLight}`, borderLeft: `3px solid ${C.gold}` }}>
              <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: '#000', borderLeft: '3px solid #E8652C', pl: 0.75, lineHeight: 1.35, mb: 0.4 }}>🎯 The goal</Box>
              <Box sx={{ fontSize: 13, lineHeight: 1.55 }}>Ship as many <b>balanced trucks</b> as a lane needs. Whatever can&apos;t fit a <b>clean truck</b> is trimmed off — and every case removed is listed here.</Box>
            </Box>

            {/* what a clean truck is — the rule */}
            <Box>
              <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.7 }}>A clean truck</Box>
              <Box sx={{ p: '9px 11px', borderRadius: `${RADIUS.sm}px`, bgcolor: '#fff', border: `1px solid ${C.rule}` }}>
                <Box sx={{ fontFamily: MONO, fontSize: 12.5, color: C.slate }}>≥ <b style={{ color: C.navy }}>{pct(P.TRUCK_KEEP_PCT)}</b> full &nbsp;·&nbsp; ≤ <b style={{ color: C.navy }}>truck cap</b></Box>
              </Box>
            </Box>

            {/* three ways cases come off */}
            <Box>
              <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.7 }}>How cases come off</Box>
              {([
                ['1', 'Tail trim', <>the remainder truck&apos;s tail shaved off a lane (filler → substitute → original, least-needy first) so its shipped trucks stay ≥{pct(P.TRUCK_KEEP_PCT)} &amp; ≤cap</>, C.warnText],
                ['2', 'Lane drop', <>a whole lane whose remainder truck couldn&apos;t reach <b>one</b> ≥{pct(P.TRUCK_KEEP_PCT)} truck (or has no truck row) — the lane is dropped</>, C.alertRed],
                ['3', 'Cluster primary trim', <><b>after</b> the cascade, a cluster&apos;s DBs are combined onto shared primary truck(s); the overflow is trimmed <b>cross-DB</b> — all fillers → subs → originals, least-needy first by post-alloc <b style={{ fontFamily: MONO }}>(on-hand+allocated)/Norm</b> — and <b>truck-aware</b>, each secondary truck stopping at its {pct(P.TRUCK_KEEP_PCT)} floor</>, C.navy],
                ['4', 'Cluster drop', <>a whole transshipment cluster that couldn&apos;t fill even <b>one</b> primary truck to {pct(P.TRUCK_KEEP_PCT)} — the entire cluster is dropped</>, C.alertRed],
              ] as const).map(([n, t, d, col], i, arr) => (
                <Box key={n} sx={{ display: 'flex', gap: 1, mb: i < arr.length - 1 ? 1 : 0 }}>
                  <Box sx={{ flexShrink: 0, width: 20, height: 20, borderRadius: '50%', bgcolor: col, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, mt: 0.1 }}>{n}</Box>
                  <Box sx={{ fontSize: 12.5, lineHeight: 1.5 }}><b style={{ color: col }}>{t}</b> — {d}</Box>
                </Box>
              ))}
            </Box>

            {/* where the trimmed stock goes */}
            <Box>
              <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.6 }}>Where the trimmed stock goes</Box>
              <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
                <Box sx={{ flexShrink: 0, width: 3, borderRadius: 2, bgcolor: C.warnText }} />
                <Box sx={{ fontSize: 12.5, lineHeight: 1.5 }}><b style={{ color: C.warnText }}>Tail trim &amp; lane drop</b> — <b>not consumed</b>: the stock cascades to the next run.</Box>
              </Box>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Box sx={{ flexShrink: 0, width: 3, borderRadius: 2, bgcolor: C.navy }} />
                <Box sx={{ fontSize: 12.5, lineHeight: 1.5 }}><b style={{ color: C.navy }}>Cluster primary trim &amp; cluster drop</b> — post-cascade, <b>not re-shipped</b>: that&apos;s why a transshipment DB can end on a sub-{pct(P.TRUCK_KEEP_PCT)} secondary tail truck, and a whole cluster can be dropped.</Box>
              </Box>
            </Box>

            <Box sx={{ pt: 1, borderTop: `1px solid ${C.rule}`, fontSize: 11, color: C.muted }}>Every case here comes straight from the engine&apos;s truck-rule audit — nothing is recomputed.</Box>
          </Box>
        </Dialog>
        {children}
      </Box>
    </Box>
  );

  // Load states, in order. `loading` is the ONLY in-flight signal; `!data` now means "finished with nothing",
  // never "still fetching" — so a 0-row / empty payload lands on the empty state instead of spinning forever.
  if (err) return <Shell><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (loading) return <Shell><PageSkeleton kpis={4} rows={8} /></Shell>;
  if (!data) return <Shell><EmptyState title="No truck-trim audit for this run"
    hint="Nothing was returned for this run date. Try another run date, or run the pipeline first." /></Shell>;

  const pill = (active: boolean) => ({
    cursor: 'pointer', px: 1.5, py: 0.6, fontSize: 13, fontWeight: 700, borderRadius: `${RADIUS.sm}px`,
    border: `1px solid ${active ? C.navy : C.rule}`, bgcolor: active ? C.navy : C.white, color: active ? '#fff' : C.slate,
  });
  const Kpi = ({ label, val, bar, fg }: { label: string; val: number; bar: string; fg: string }) => (
    <Box sx={{ flex: 1, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${bar}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, p: 1.5, bgcolor: C.white }}>
      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted }}>{label}</Box>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 26, color: fg, lineHeight: 1.1 }}>{nf(val)}</Box>
      <Box sx={{ fontSize: 11.5, color: C.muted }}>cases</Box>
    </Box>
  );

  return (
    <Shell>
      <Box sx={{ display: 'flex', gap: 1.5, mb: 2 }}>
        <Kpi label="Tail trims" val={kpi.tail} bar={C.gold} fg={C.warnText} />
        <Kpi label={`Lane drops (<${pct(P.TRUCK_KEEP_PCT)})`} val={kpi.drop} bar={C.alertRed} fg={C.alertRed} />
        <Kpi label="Cluster primary trim" val={kpi.cluster} bar={'#D04A02'} fg={C.navy} />
        <Kpi label="Total removed" val={kpi.total} bar={C.slate} fg={C.slate} />
      </Box>

      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', mb: 1.5 }}>
        <Box sx={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.05em' }}>Run</Box>
        <Box sx={pill(run === 0)} onClick={() => setRun(0)}>All</Box>
        {data.runs.map((r) => <Box key={r.run} sx={pill(run === r.run)} onClick={() => setRun(r.run)}>{r.run} · {r.channel}</Box>)}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search CFA / DB / reg-zsku…"
          style={{ flex: 1, minWidth: 220, padding: '7px 10px', fontSize: 13, fontFamily: SANS, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
        <ExportXlsxButton label="Export Excel" onClick={() => downloadXlsxMulti('truck_trims', [
          { name: 'Cancelled lanes',
            headers: ['Run', 'Channel', 'CFA', 'DB', 'Distributor', 'Truck type', 'Transship', 'Truck cap', 'Cluster', 'Reason', 'reg-zskus', 'Cases'],
            rows: data.lanes.filter((l) => !cfa || String(l.cfa ?? '').trim() === cfa)
              .map((l) => [l.run, l.channel, l.cfa, l.db, l.db_name, l.truck_type, l.is_transhipment, l.truck_cap, l.cluster, l.reason, l.skus, l.cases]) },
          { name: 'Per-SKU detail', headers: data.cols, rows: data.rows.filter((r) => !cfa || String(r[I.cfa] ?? '').trim() === cfa) },
        ])} />
      </Box>
      {/* PRIMARY: truck-rule actions per CFA × DB — dropped lanes, tail trims, and cluster-primary trims */}
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 17, color: C.navy, mb: 0.25 }}>Truck-rule actions — {nf(lanes.length)} lanes</Box>
      <Box sx={{ fontSize: 12.5, color: C.muted, mb: 1 }}>
        Each row is a <b>CFA × DB</b> truck action from Step&nbsp;3 or the cluster pass — a <b>dropped lane</b> (couldn’t reach a ≥{pct(P.TRUCK_KEEP_PCT)} truck; its cases cascade to the next run), a <b>tail trim</b> (the lane still ships its full trucks), or a <b>cluster-primary trim</b> (post-cascade, not re-shipped). See the <b>Reason</b> column.
      </Box>
      <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'auto', maxHeight: '46vh', mb: 3, bgcolor: C.white }}>
        <Table size="small" stickyHeader sx={{ minWidth: 'max-content' }}>
          <TableHead><TableRow>
            {['Run', 'DB', 'Distributor', 'Truck type', 'reg-zskus', 'Cases dropped', 'Reason'].map((h, i) => (
              <TableCell key={h} sx={{ textAlign: i === 4 || i === 5 ? 'right' : 'left' }}>{h}</TableCell>
            ))}
          </TableRow></TableHead>
          <TableBody>
            {lanes.length === 0 && <TableRow><TableCell colSpan={7} sx={{ color: C.muted, py: 2 }}>No trucks cancelled in this run.</TableCell></TableRow>}
            {lanes.map((l, i) => {
              const rs = reasonMetaOf(l.reason);
              return (
                <TableRow key={i} hover sx={trackedRowSxFor(l.db)}>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: C.muted }}>{l.run} · {l.channel}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: C.navy, fontWeight: 700 }}>{isTracked(l.db) ? TRACK_STAR + ' ' : ''}{l.db}</TableCell>
                  <TableCell sx={{ fontSize: 12.5, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.db_name}>{l.db_name || '—'}</TableCell>
                  <TableCell sx={{ fontSize: 12.5, color: C.slate }}>
                    {l.truck_type || '—'}{l.truck_cap ? ` · ${l.truck_cap} cs` : ''}
                    {l.is_transhipment && <Box component="span" title="Transshipment secondary truck (Cluster Master)" sx={{ ml: 0.6, px: 0.6, py: 0.2, borderRadius: 1, fontSize: 10, fontWeight: 800, bgcolor: '#FFE8D4', color: '#CC3D07' }}>▸ secondary{l.cluster ? ` · ${l.cluster}` : ''}</Box>}
                  </TableCell>
                  <TableCell sx={num}>{nf(l.skus)}</TableCell>
                  <TableCell sx={{ ...num, fontWeight: 800, color: C.alertRed }}>{nf(l.cases)}</TableCell>
                  <TableCell><Box sx={{ display: 'inline-block', px: 0.85, py: 0.2, borderRadius: 999, bgcolor: rs.bg, color: rs.fg, fontSize: 10.5, fontWeight: 800 }}>{rs.label}</Box></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>

      {/* SECONDARY: per-reg-zsku detail of what was trimmed */}
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 15, color: C.navy, mb: 0.25 }}>Per-SKU detail</Box>
      <Box sx={{ fontSize: 12, color: C.muted, mb: 0.75 }}>{nf(filtered.length)} reg-zsku lines · the cases trimmed from each SKU on the cancelled lanes.</Box>
      <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'auto', maxHeight: '52vh', bgcolor: C.white }}>
        <Table size="small" stickyHeader>
          <TableHead><TableRow>
            {['Run', 'CFA', 'DB', 'reg-zsku', 'Description', 'Orig trim', 'Sub trim', 'Filler trim', 'Total', 'Reason']
              .map((h, i) => <TableCell key={h} sx={{ fontFamily: SANS, textAlign: i >= 5 && i <= 8 ? 'right' : 'left' }}>{h}</TableCell>)}
          </TableRow></TableHead>
          <TableBody>
            {filtered.length === 0 && <TableRow><TableCell colSpan={10} sx={{ color: C.muted, py: 2 }}>Nothing trimmed in this run.</TableCell></TableRow>}
            {filtered.map((r, i) => {
              const o = r[I.oTrim] as number, s = r[I.sTrim] as number, f = r[I.fTrim] as number;
              const rs = reasonMetaOf(r[I.reason]);
              return (
                <TableRow key={i} sx={trackedRowSxFor(r[I.db])}>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: C.muted }}>{r[I.run]} · {r[I.channel]}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{r[I.cfa]}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: C.navy }}>{isTracked(r[I.db]) ? TRACK_STAR + ' ' : ''}{r[I.db]}</TableCell>
                  <TableCell sx={{ fontWeight: 600, color: C.navy }}>{r[I.z]}</TableCell>
                  <TableCell sx={{ whiteSpace: 'normal' }} title={descOf(String(r[I.z]))}>{descOf(String(r[I.z])) || '—'}</TableCell>
                  <TableCell sx={{ ...num, color: o > 0 ? C.navy : C.muted }}>{o || '—'}</TableCell>
                  <TableCell sx={{ ...num, color: s > 0 ? C.success : C.muted }}>{s || '—'}</TableCell>
                  <TableCell sx={{ ...num, color: f > 0 ? C.warnText : C.muted }}>{f || '—'}</TableCell>
                  <TableCell sx={{ ...num, fontWeight: 800, color: C.slate }}>{o + s + f}</TableCell>
                  <TableCell><Box sx={{ display: 'inline-block', px: 0.85, py: 0.2, borderRadius: 999, bgcolor: rs.bg, color: rs.fg, fontSize: 10.5, fontWeight: 800 }}>{rs.label}</Box></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.rule}`, mt: 3, pt: 1, fontSize: 9, color: C.muted }}>
        <span>AI Order Optimizer · truck rule audit</span>
        <span>tail trim · lane drop → cascade to next run · cluster primary trim → post-cascade, not re-shipped</span>
      </Box>
    </Shell>
  );
}
