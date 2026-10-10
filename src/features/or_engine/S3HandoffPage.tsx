import { useEffect, useMemo, useState } from 'react';
import { Box, Pagination, Stack } from '@mui/material';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { downloadXlsx, ExportXlsxButton } from '../../shared/exportXlsx';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';

/* ---------------------------------------------------------------------------
   S3 Hand-off — the order_line_items parquet READ BACK from S3 (OE_OUTPUT), exactly
   as the pipeline / RLM rollup wrote it. One file per date; the date comes from the
   header run-date selector. Lets us see visually what actually landed in S3.
--------------------------------------------------------------------------- */
interface Payload { date: string; path: string | null; found: boolean; columns: string[]; count: number; rows: (string | number | boolean | null)[][]; dates: string[]; }

const BOOL_COLS = new Set(['rlm_approved', 'zsku_substitution', 'zsku_filler']);
const MONO_COLS = new Set(['aiden_order_id', 'reg_zsku_code', 'cfa_code', 'distributor_code', 'truck_description']);
// reg-zsku code columns that get a Description injected right after them — the
// primary line reg-zsku PLUS any substitute / filler reg-zsku code column.
const RZ_COLS = new Set([
  'reg_zsku_code', 'reg_zsku',
  'sub_zsku', 'substitute_zsku', 'sub_reg_zsku', 'sub_reg_zsku_code', 'substitute_reg_zsku_code',
  'filler_zsku', 'filler_reg_zsku', 'filler_reg_zsku_code',
]);
// Full description on ONE line — never truncated, never wrapped; the table scrolls horizontally instead (the
// wrapper is overflow:auto), so a long name like "Lays-Ridged-Salted-M-10" reads as one clean row.
const descTd: React.CSSProperties = { whiteSpace: 'nowrap' };

const thCell: React.CSSProperties = {
  position: 'sticky', top: 0, textAlign: 'left', padding: '10px 12px', background: C.headBg, color: C.muted,
  fontWeight: 700, fontFamily: SANS, fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase',
  borderBottom: `1px solid ${C.rule}`, whiteSpace: 'nowrap', zIndex: 1,
};
const tdCell: React.CSSProperties = {
  padding: '10px 12px', borderTop: `1px solid ${C.rowLine}`, color: C.ink, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
};

function BoolChip({ v }: { v: boolean }) {
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, letterSpacing: '.03em', padding: '1px 8px', borderRadius: 999,
      background: v ? '#E7F3E7' : '#F1F1F0', color: v ? C.green : C.muted, border: `1px solid ${v ? C.green : C.rule}`,
    }}>{v ? 'TRUE' : 'false'}</span>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
    <div style={{ maxWidth: 1320, margin: '0 auto', padding: 'clamp(14px, 4vw, 28px) clamp(12px, 4vw, 32px) clamp(92px, 8vw, 92px)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>
        S3 Hand-off · OE_OUTPUT
      </div>
      <h1 style={{ fontFamily: SANS, fontWeight: 800, color: C.navy, fontSize: 30, letterSpacing: '-.01em', margin: '6px 0 8px' }}>
        S3 · order_line_items
      </h1>
      {children}
    </div>
  </div>
);

export default function S3HandoffPage({ date }: { date?: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);    // init TRUE: the fetch fires on mount, so the FIRST paint is the
  const [nonce, setNonce] = useState(0);           // skeleton, never a flash of "nothing came back". NEVER infer
                                                   // "in flight" from data===null: an empty parquet, or a failure,
                                                   // would then spin forever.
  const [sel, setSel] = useState<string | undefined>(undefined);   // page's own S3-date pick (undefined -> header date -> latest S3)
  const descOf = useRegZskuDesc();

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    api.s3OrderLineItems(sel ?? date)   // date + date-list both come straight from S3 (no Postgres)
      .then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [sel, date, nonce]);

  // search across ALL rows + client-side pagination — never render thousands of (wide) DOM rows at once.
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = data?.rows ?? [];
    return s ? all.filter((r) => r.some((c) => String(c ?? '').toLowerCase().includes(s))) : all;
  }, [data, q]);
  useEffect(() => { setPage(1); }, [q, data]);

  if (err) return <Shell><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (loading) return <Shell><PageSkeleton kpis={0} rows={10} /></Shell>;
  if (!data) return <Shell><EmptyState title="Nothing came back from S3"
    hint="The S3 read returned no payload for this date. Pick another run date in the header, then try again." /></Shell>;

  const PAGE_SIZE = 200;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const pageRows = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

  return (
    <Shell>
      <p style={{ fontSize: 14, color: C.slate, maxWidth: 980, lineHeight: 1.5, margin: '0 0 16px' }}>
        The <b>order_line_items</b> parquet read straight back <b>from S3</b> for the header run date — reg-zsku level,
        exactly as the pipeline &amp; the RLM rollup wrote it. <b>rlm_approved</b> = TRUE for lines the RLM scheduler
        processed (truck-approval / secondary-shift); false for direct SO_CREATION lines.
      </p>

      {/* source card */}
      <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, p: 1.5, mb: 1.5,
        background: C.white, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Box sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: '1.05rem' }}>date</Box>
        <select value={data?.date ?? ''} onChange={(e) => setSel(e.target.value)}
          style={{ fontWeight: 700, fontSize: 13, color: C.navy, background: '#fff', border: `1px solid ${C.rule}`,
            borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontFamily: MONO }}>
          {(data?.dates ?? []).length === 0 && <option value="">— no S3 dates —</option>}
          {(data?.dates ?? []).map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <Box component="span" sx={{ fontSize: 11, color: C.muted }}>· from S3</Box>
        <Box component="span" sx={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, px: 0.9, py: 0.2, borderRadius: 999,
          bgcolor: C.navyP, color: C.navy }}>{data?.count ?? 0} rows</Box>
        <ExportXlsxButton size="sm" label="Export Excel" disabled={!data?.found || !data?.rows.length}
          onClick={() => { if (data) downloadXlsx(`order_line_items_${data.date}`, data.columns, data.rows); }} />
        <Box sx={{ flex: 1 }} />
        <Box sx={{ fontFamily: MONO, fontSize: '0.72rem', color: C.muted, wordBreak: 'break-all' }}>
          <span style={{ color: C.gold, fontWeight: 800 }}>S3 · </span>{data?.path ?? '—'}
        </Box>
      </Box>

      {data.found && data.rows.length > 0 && (
        <Box sx={{ mb: 1.25, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter any field…"
            style={{ flex: 1, minWidth: 240, maxWidth: 420, padding: '8px 12px', fontSize: 13, fontFamily: SANS, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
          {q && <Box component="span" sx={{ fontSize: 12, color: C.muted }}>
            {filtered.length.toLocaleString()} match{filtered.length === 1 ? '' : 'es'} of {data.rows.length.toLocaleString()}</Box>}
        </Box>
      )}
      {!data.found ? (
        <EmptyState title="No hand-off file in S3 for this date"
          hint={<>No <b>order_line_items</b> parquet has landed in S3 for <b>{data.date}</b> yet. Run the pipeline (or the RLM rollup) for this date, or pick another date above.</>} />
      ) : data.rows.length === 0 ? (
        <EmptyState title="The hand-off file is empty"
          hint={<>The parquet for <b>{data.date}</b> is in S3 but carries no order lines — nothing was handed off. Re-run the pipeline for this date, or pick another date above.</>} />
      ) : (
        <Box sx={{ overflow: 'auto', maxHeight: 620, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`,
          boxShadow: SHADOW.sm, background: C.white }}>
          <style>{`.s3tbl tbody tr:hover td { background: rgba(16,54,90,0.07); }`}</style>
          <table className="s3tbl" style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
            <thead><tr>{data.columns.map((c) => (
              RZ_COLS.has(c)
                ? [<th key={c} style={thCell}>{c}</th>, <th key={`${c}__desc`} style={thCell}>Description</th>]
                : <th key={c} style={thCell}>{c}</th>
            ))}</tr></thead>
            <tbody>
              {pageRows.map((r, i) => (
                <tr key={(curPage - 1) * PAGE_SIZE + i} style={{ background: '#fff' }}>
                  {r.map((v, ci) => {
                    const col = data.columns[ci];
                    const first = ci === 0;
                    const cell = BOOL_COLS.has(col)
                      ? <td key={ci} style={tdCell}><BoolChip v={v === true || v === 'true' || v === 'True'} /></td>
                      : (
                        <td key={ci} style={{ ...tdCell,
                          ...(MONO_COLS.has(col) ? { fontFamily: MONO } : null),
                          ...(first ? { fontWeight: 600, color: C.navy } : null) }}>
                          {v == null ? '' : String(v)}
                        </td>
                      );
                    if (RZ_COLS.has(col)) {
                      const rz = v == null ? '' : String(v);
                      return [cell, <td key={`${ci}__desc`} style={{ ...tdCell, ...descTd }} title={descOf(rz)}>{descOf(rz) || '—'}</td>];
                    }
                    return cell;
                  })}
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={data.columns.length + data.columns.filter((c) => RZ_COLS.has(c)).length} style={{ ...tdCell, textAlign: 'center', color: C.muted, padding: '28px 12px' }}>No rows match “{q}”.</td></tr>
              )}
            </tbody>
          </table>
        </Box>
      )}

      {data.found && filtered.length > 0 && pageCount > 1 && (
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1.25, flexWrap: 'wrap', gap: 1 }}>
          <Box sx={{ fontSize: 12, color: C.muted }}>page {curPage} / {pageCount} · {pageRows.length.toLocaleString()} shown of {filtered.length.toLocaleString()}</Box>
          <Pagination count={pageCount} page={curPage} onChange={(_, p) => setPage(p)} size="small"
            siblingCount={1} boundaryCount={1} showFirstButton showLastButton />
        </Stack>
      )}
    </Shell>
  );
}
