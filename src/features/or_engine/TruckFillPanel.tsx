import { useEffect, useMemo, useState } from 'react';
import { Box, Table, TableBody, TableCell, TableHead, TableRow, TableSortLabel } from '@mui/material';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { ExportXlsxButton, downloadXlsx } from '../../shared/exportXlsx';
import { isTracked, trackedSxFor, TRACK_STAR } from '../../demo';

/* ---------------------------------------------------------------------------
   Truck Fill (CFA × DB) — one reusable lane view, shown as a tab on BOTH the water-fill
   page (mode="step1") and the substitution page (mode="step2"). Per (CFA, DB): the DB's
   full combined SOQ, allocated cases, the truck cap, and the overall fill % = allocated ÷
   cap. NO truck building — a single lane-level ratio. For a transshipment/cluster DB the
   cap is its SECONDARY truck cap; otherwise its own lane truck cap.
     · step1 → Step-1 ORIGINAL (water-fill only); fill = Step-1 ÷ cap
     · step2 → adds Step-2 SUBSTITUTE + Step 1+2; fill = (Step-1 + Step-2) ÷ cap
   Live from /api/v1/step1_truck_fill (carries both steps). Self-contained — its own fetch.
--------------------------------------------------------------------------- */
type Mode = 'step1' | 'step2';
interface Row {
  cfa: string; db: string; db_name: string; channel: string; total_soq: number;
  step1_alloc: number; step2_alloc: number; total_alloc: number;
  is_transship: boolean; truck_cap: number; cap_kind: string;
  fill_pct: number | null; fill_pct_after: number | null;         // TRUCK UTIL = allocated ÷ truck cap
  fill_rate: number | null; fill_rate_after: number | null;       // FILL RATE = allocated ÷ SOQ
}
interface Payload { date?: string; rows: Row[]; }

type Kind = 'mono' | 'text' | 'db' | 'num' | 'numStrong' | 'numGreen' | 'transship' | 'fill' | 'fillStack';
interface Col { h: string; kind: Kind; get: (r: Row) => string | number | null; }
const NUMERIC: Kind[] = ['num', 'numStrong', 'numGreen', 'fill', 'fillStack'];

const nf = (n: unknown) => (Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString() : '');
const num = { textAlign: 'right' as const, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' as const, fontSize: 12.5 };

const colsFor = (mode: Mode): Col[] => {
  const truckUtil = (r: Row) => (mode === 'step2' ? r.fill_pct_after : r.fill_pct);   // allocated ÷ truck cap
  const fillRate = (r: Row) => (mode === 'step2' ? r.fill_rate_after : r.fill_rate);   // allocated ÷ SOQ
  return [
    { h: 'CFA', kind: 'mono', get: (r) => r.cfa },
    { h: 'DB', kind: 'db', get: (r) => r.db },
    { h: 'Channel', kind: 'text', get: (r) => r.channel },
    { h: 'Total SOQ', kind: 'num', get: (r) => r.total_soq },
    { h: 'Step-1 allocated', kind: 'numStrong', get: (r) => r.step1_alloc },
    ...(mode === 'step2' ? [
      { h: 'Step-2 allocated', kind: 'numGreen' as Kind, get: (r: Row) => r.step2_alloc },
      { h: 'Step 1+2', kind: 'num' as Kind, get: (r: Row) => r.total_alloc },
    ] : []),
    { h: 'Truck cap', kind: 'num', get: (r) => r.truck_cap },
    { h: 'Transship?', kind: 'transship', get: (r) => (r.is_transship ? 'Yes' : 'No') },
    // Fill rate = allocated ÷ SOQ (demand met) · Truck util = allocated ÷ truck cap (how full the truck is).
    // On step2 the Fill-rate bar is STACKED (navy Step-1 + green Step-2) so the split by source reads at a glance.
    { h: mode === 'step2' ? 'Fill rate % (Step 1+2 ÷ SOQ)' : 'Fill rate % (Step-1 ÷ SOQ)', kind: mode === 'step2' ? 'fillStack' : 'fill', get: fillRate },
    { h: mode === 'step2' ? 'Truck util % (Step 1+2 ÷ cap)' : 'Truck util % (Step-1 ÷ cap)', kind: 'fill', get: truckUtil },
  ];
};

export default function TruckFillPanel({ date, mode }: { date?: string; mode: Mode }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);           // NEVER infer "in flight" from data===null: a payload with
  const [err, setErr] = useState<string | null>(null);    // 0 lanes, or a failure, would then spin forever.
                                                          // Starts TRUE: the fetch below is unconditional on mount, so
                                                          // the first paint must be the skeleton, never a false "no data".
  const [nonce, setNonce] = useState(0);                  // bumped by the error Retry to re-run the effect
  const [q, setQ] = useState('');
  const [sortCol, setSortCol] = useState<number>(-1);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    let alive = true; setData(null); setErr(null); setLoading(true);
    api.step1TruckFill(date).then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, on an EMPTY payload AND on failure
    return () => { alive = false; };
  }, [date, nonce]);

  const COLS = useMemo(() => colsFor(mode), [mode]);
  const all = data?.rows ?? [];
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => all.filter((r) => !needle
    || `${r.cfa} ${r.db} ${r.db_name} ${r.channel} ${r.is_transship ? 'transship yes' : 'no'}`.toLowerCase().includes(needle)),
  [all, needle]);

  // click any header to sort asc → desc → asc; numeric columns compare numerically, blanks sort last
  const rows = useMemo(() => {
    if (sortCol < 0) return filtered;
    const { kind, get } = COLS[sortCol];
    const numeric = NUMERIC.includes(kind);
    return [...filtered].sort((a, b) => {
      const va = get(a), vb = get(b);
      const ea = va === null || va === '', eb = vb === null || vb === '';
      if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
      const d = numeric ? Number(va) - Number(vb) : String(va).localeCompare(String(vb));
      return sortDir === 'asc' ? d : -d;
    });
  }, [filtered, sortCol, sortDir, COLS]);
  const clickSort = (ci: number) => {
    if (sortCol === ci) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(ci); setSortDir('asc'); }
  };

  const kpi = useMemo(() => {
    const n = all.length;
    const tr = all.filter((r) => r.is_transship).length;
    const withSub = all.filter((r) => r.step2_alloc > 0).length;
    const sumSub = all.reduce((s, r) => s + r.step2_alloc, 0);
    const fillOf = (r: Row) => (mode === 'step2' ? r.fill_pct_after : r.fill_pct);
    const withFill = all.filter((r) => fillOf(r) != null);
    const avg = withFill.length ? withFill.reduce((s, r) => s + (fillOf(r) ?? 0), 0) / withFill.length : 0;
    const over = all.filter((r) => (fillOf(r) ?? 0) >= 100).length;
    return { n, tr, withSub, sumSub, avg, over };
  }, [all, mode]);

  if (err) return <ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} />;
  if (loading) return <PageSkeleton kpis={4} rows={8} />;
  if (!data || all.length === 0) return <EmptyState title="No truck fill for this run"
    hint="This run produced no CFA × DB lanes. Try another run date, or run the pipeline first." />;

  const Kpi = ({ label, val, suffix, fg, bar }: { label: string; val: string; suffix?: string; fg: string; bar: string }) => (
    <Box sx={{ flex: 1, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${bar}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, p: 1.4, bgcolor: C.white }}>
      <Box sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted }}>{label}</Box>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 23, color: fg, lineHeight: 1.1 }}>{val}{suffix}</Box>
    </Box>
  );

  const renderCell = (col: Col, r: Row) => {
    const v = col.get(r);
    const key = col.h;
    switch (col.kind) {
      case 'db': return (
        <TableCell key={key} sx={{ fontFamily: MONO, fontSize: 12.5, whiteSpace: 'nowrap' }} title={r.db_name}>
          {isTracked(r.db) ? TRACK_STAR + ' ' : ''}{r.db}
        </TableCell>);
      case 'text': return <TableCell key={key} sx={{ fontSize: 12.5, color: C.slate }}>{v || <span style={{ color: C.grey700 }}>—</span>}</TableCell>;
      case 'mono': return <TableCell key={key} sx={{ fontFamily: MONO, fontSize: 12.5 }}>{v}</TableCell>;
      case 'num': return <TableCell key={key} sx={num}>{nf(v)}</TableCell>;
      case 'numStrong': return <TableCell key={key} sx={{ ...num, fontWeight: 700, color: C.navy }}>{nf(v)}</TableCell>;
      case 'numGreen': return <TableCell key={key} sx={{ ...num, fontWeight: 700, color: (v as number) > 0 ? C.success : C.muted }}>{nf(v)}</TableCell>;
      case 'transship': return (
        <TableCell key={key} sx={{ fontSize: 12 }}>
          {r.is_transship
            ? <Box component="span" sx={{ px: 0.7, py: 0.15, borderRadius: `${RADIUS.sm}px`, bgcolor: C.navyP, color: C.navy, fontWeight: 800, fontSize: 11 }} title="Transshipment / cluster DB — fill is against its Secondary truck cap">Yes · Sec</Box>
            : <span style={{ color: C.muted }}>No</span>}
        </TableCell>);
      case 'fill': {
        const fill = v as number | null;
        const over = (fill ?? 0) >= 100;
        const barW = fill == null ? 0 : Math.min(100, fill);
        return (
          <TableCell key={key} sx={{ ...num, width: 190 }}>
            {fill == null ? <span style={{ color: C.grey700 }}>—</span> : (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, justifyContent: 'flex-end' }}>
                <Box sx={{ position: 'relative', width: 96, height: 9, borderRadius: 999, bgcolor: C.grayP, overflow: 'hidden', flexShrink: 0 }}>
                  <Box sx={{ position: 'absolute', inset: 0, width: `${barW}%`, bgcolor: over ? C.warnText : C.success, borderRadius: 999 }} />
                </Box>
                <Box component="span" sx={{ minWidth: 46, fontWeight: 800, color: over ? C.warnText : C.slate }}>{fill.toFixed(1)}%</Box>
              </Box>
            )}
          </TableCell>);
      }
      case 'fillStack': {
        // STACKED Fill-rate bar: navy = Step-1 (Original), green = Step-2 (Substitute) — total = (Step-1+2) ÷ SOQ.
        // s1 = Step-1 ÷ SOQ (always ≤ tot, since Step-2 ≥ 0); the green segment is the Step-2 lift on top of navy.
        const s1 = r.fill_rate;               // Step-1 ÷ SOQ
        const tot = r.fill_rate_after;        // (Step-1 + Step-2) ÷ SOQ
        if (tot == null) return <TableCell key={key} sx={{ ...num, width: 190 }}><span style={{ color: C.grey700 }}>—</span></TableCell>;
        const over = tot >= 100;
        const totw = Math.min(100, tot);                      // total bar width (clipped at 100%)
        const s1w = Math.min(totw, Math.max(0, s1 ?? 0));     // navy segment (Step-1)
        const s2w = Math.max(0, totw - s1w);                  // green segment (Step-2 lift)
        const s2val = Math.max(0, tot - (s1 ?? 0));
        return (
          <TableCell key={key} sx={{ ...num, width: 190 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, justifyContent: 'flex-end' }}>
              <Box sx={{ position: 'relative', width: 96, height: 9, borderRadius: 999, bgcolor: C.grayP, overflow: 'hidden', flexShrink: 0 }}
                title={`Step-1 ${(s1 ?? 0).toFixed(1)}%  +  Step-2 ${s2val.toFixed(1)}%  =  ${tot.toFixed(1)}% of SOQ`}>
                <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${s1w}%`, bgcolor: C.navy }} />
                <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: `${s1w}%`, width: `${s2w}%`, bgcolor: '#029740' }} />
              </Box>
              <Box component="span" sx={{ minWidth: 46, fontWeight: 800, color: over ? C.warnText : C.slate }}>{tot.toFixed(1)}%</Box>
            </Box>
          </TableCell>);
      }
      default: return <TableCell key={key}>{v}</TableCell>;
    }
  };

  return (
    <Box sx={{ fontFamily: SANS }}>
      <Box sx={{ fontSize: 13.5, color: C.slate, lineHeight: 1.5, maxWidth: 1000, mb: 1.5 }}>
        One row per <b>CFA × DB</b> — the DB's full combined <b>SOQ</b>, the <b style={{ color: C.navy }}>Step-1 Original</b> allocated
        {mode === 'step2'
          ? <> plus the <b style={{ color: C.success }}>Step-2 Substitute</b> allocated, then two ratios of the <b>Step-1 + Step-2</b> total.</>
          : <> (water-fill only, <i>no substitute or filler</i>), then two ratios of the <b>Step-1</b> allocation.</>}
        {' '}<b>Fill rate %</b> = allocated ÷ <b>SOQ</b> (how much of the DB's demand is met); <b>Truck util %</b> = allocated ÷ <b>truck cap</b> (how full the truck is).
        {mode === 'step2' && <> The <b>Fill rate</b> bar is split by source — <b style={{ color: C.navy }}>navy = Step-1</b>, <b style={{ color: C.success }}>green = Step-2</b> (hover to see the exact split).</>}
        {' '}For a <b>transshipment</b> DB the cap is its <b>Secondary</b> truck; otherwise its own lane truck. A value <b style={{ color: C.warnText }}>&gt; 100%</b> means the allocation exceeds SOQ (fill rate) or overfills the truck (util).
      </Box>

      <Box sx={{ display: 'flex', gap: 1.25, mb: 1.75 }}>
        <Kpi label="Lanes (CFA × DB)" val={nf(kpi.n)} fg={C.navy} bar={'#D04A02'} />
        {mode === 'step2'
          ? <Kpi label="Lanes with substitute" val={nf(kpi.withSub)} fg={C.success} bar={C.success} />
          : <Kpi label="Transshipment lanes" val={nf(kpi.tr)} fg={C.navy} bar={C.gold} />}
        <Kpi label={mode === 'step2' ? 'Avg truck util (1+2)' : 'Avg truck util (Step-1)'} val={kpi.avg.toFixed(1)} suffix="%" fg={C.success} bar={C.success} />
        {mode === 'step2'
          ? <Kpi label="Σ Step-2 substitute" val={nf(kpi.sumSub)} suffix=" cs" fg={C.warnText} bar={C.gold} />
          : <Kpi label="Lanes ≥ 100% (overfilled)" val={nf(kpi.over)} fg={C.warnText} bar={C.gold} />}
      </Box>

      <Box sx={{ display: 'flex', gap: 1.25, mb: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter — CFA, DB, name, channel, transship…"
          style={{ flex: 1, minWidth: 260, maxWidth: 420, padding: '8px 12px', fontSize: 13, fontFamily: SANS, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
        <Box sx={{ flex: 1 }} />
        <ExportXlsxButton label="Export Excel" onClick={() => downloadXlsx(mode === 'step2' ? 'step2_truck_fill' : 'step1_truck_fill',
          ['CFA', 'DB', 'DB Name', 'Channel', 'Total SOQ', 'Step-1 allocated', 'Step-2 allocated', 'Step 1+2', 'Truck cap', 'Cap type', 'Transship',
            'Fill rate % (Step-1 ÷ SOQ)', 'Fill rate % (1+2 ÷ SOQ)', 'Truck util % (Step-1 ÷ cap)', 'Truck util % (1+2 ÷ cap)'],
          rows.map((r) => [r.cfa, r.db, r.db_name, r.channel, r.total_soq, r.step1_alloc, r.step2_alloc, r.total_alloc, r.truck_cap, r.cap_kind, r.is_transship ? 'Yes' : 'No',
            r.fill_rate ?? '', r.fill_rate_after ?? '', r.fill_pct ?? '', r.fill_pct_after ?? '']))} />
      </Box>
      <Box sx={{ fontSize: 12, color: C.muted, mb: 0.5 }}>{nf(rows.length)} of {nf(all.length)} lanes{q ? ` matching “${q}”` : ''} · click any column header to sort</Box>

      <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'auto', maxHeight: '66vh' }}>
        <Table size="small" stickyHeader sx={{ minWidth: 'max-content' }}>
          <TableHead><TableRow>
            {COLS.map((c, ci) => (
              <TableCell key={c.h} align={NUMERIC.includes(c.kind) ? 'right' : 'left'} sortDirection={sortCol === ci ? sortDir : false}
                sx={{ fontFamily: SANS, whiteSpace: 'nowrap', fontSize: 11.5 }}>
                <TableSortLabel active={sortCol === ci} direction={sortCol === ci ? sortDir : 'asc'} onClick={() => clickSort(ci)}>{c.h}</TableSortLabel>
              </TableCell>
            ))}
          </TableRow></TableHead>
          <TableBody>
            {rows.length === 0 && <TableRow><TableCell colSpan={COLS.length} sx={{ color: C.muted, py: 2 }}>No lanes match.</TableCell></TableRow>}
            {rows.map((r, i) => (
              <TableRow key={i} hover sx={trackedSxFor(r.db)}>
                {COLS.map((c) => renderCell(c, r))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>

      <Box sx={{ borderTop: `1px solid ${C.rule}`, mt: 2.5, pt: 1, fontSize: 9, color: C.muted, display: 'flex', justifyContent: 'space-between' }}>
        <span>AI Order Optimizer · {mode === 'step2' ? 'Step-2 Truck Fill (after substitution)' : 'Step-1 Truck Fill (water-fill only)'} · CFA × DB · Fill rate = ÷ SOQ · Truck util = ÷ truck cap</span>
        <span>CFA × DB · {data.date ?? ''}</span>
      </Box>
    </Box>
  );
}
