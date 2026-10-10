import { useEffect, useMemo, useState } from 'react';
import { Box, Pagination, Stack, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { api } from '../../api';
import PageIntro from '../../shared/PageIntro';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';

/* ---------------------------------------------------------------------------
   SAP Orders — read STRAIGHT from `de_sap.orders` (the SAP z-column hand-off table), per run date.
   One row per SAP order line (oeid · zposnr). Live from /api/v1/sap_orders?date=… ; the Download hits
   the SAME endpoint with ?format=xlsx. Only SO_CREATION lines are written to de_sap.orders, so a run
   with none shows an empty state.
--------------------------------------------------------------------------- */
type Row = (string | number | null)[];
interface Payload { cols: string[]; rows: Row[]; date?: string; count?: number; }

const MONO_COLS = new Set(['oeid', 'zposnr', 'zkunnr', 'zmatnr', 'zwerks']);
const NUM_COLS = new Set(['zmenge', 'is_active']);
const HDR: Record<string, string> = {
  oeid: 'OEID', zposnr: 'Line # (POSNR)', zkunnr: 'Customer', zvkorg: 'Sales Org', zvkbur: 'Sales Office',
  zspart: 'Division', zvbtype: 'Doc Category', zerdat: 'Created On', zernum: 'Created At', zwerks: 'Plant',
  zmatnr: 'Material', zmenge: 'Qty', zmeins: 'UoM', zautyp: 'Approval Type', is_active: 'Active (SAP pick)',
};

const Shell = ({ children }: { children: React.ReactNode }) => (
  <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
    <Box sx={{ maxWidth: 1400, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
      <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>
        SAP Orders · the SAP hand-off
      </Box>
      <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: '6px 0 8px' }}>
        SAP Orders — de_sap.orders
      </Box>
      {children}
    </Box>
  </Box>
);

export default function SapOrdersPage({ date }: { date?: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from data===null: an empty payload
  const [err, setErr] = useState<string | null>(null);   // or a failure would then spin forever
  const [nonce, setNonce] = useState(0);            // bumped by the error Retry to re-run the effect
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    setErr(null); setLoading(true);
    api.sapOrders(date).then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, nonce]);

  const cols = data?.cols ?? [];
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => (data?.rows ?? []).filter(
    (r) => !needle || r.some((v) => String(v ?? '').toLowerCase().includes(needle))), [data, needle]);

  // client-side pagination — render one PAGE_SIZE slice at a time so a large SO hand-off never renders thousands of
  // (wide) DOM rows at once. Search filters ALL rows first; page resets to 1 whenever the filter or the data changes.
  const PAGE_SIZE = 200;
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [needle, data]);

  if (err) return <Shell><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (loading) return <Shell><PageSkeleton kpis={0} rows={10} /></Shell>;
  if (!data) return <Shell><EmptyState title="No SAP hand-off for this run"
    hint="Nothing came back from de_sap.orders for this run date. Try another run date, or run the pipeline first." /></Shell>;

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const pageRows = rows.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

  return (
    <Shell>
      <PageIntro>
        The final <b>SAP order hand-off</b> for <b>{data.date}</b> — one row per order line
        (<b>oeid · zposnr</b>), read straight from the <b>de_sap.orders</b> table exactly as the engine appends it.
        Only <b>SO_CREATION</b> lines are written here (RLM dispositions are held back), so a run with no
        SO_CREATION orders shows none. Download gives the same rows as an Excel sheet.
      </PageIntro>

      <Box sx={{ display: 'flex', gap: 1.25, mb: 1.75, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter any field…"
          style={{ flex: 1, minWidth: 240, maxWidth: 380, padding: '8px 12px', fontSize: 13, fontFamily: SANS, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
        <Box sx={{ flex: 1 }} />
        <a href={api.sapOrdersXlsxUrl(date)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none', padding: '8px 16px',
            fontSize: 13, fontWeight: 800, color: '#fff', background: C.navy, borderRadius: RADIUS.sm, boxShadow: SHADOW.sm }}>
          <DownloadIcon sx={{ fontSize: 17 }} /> Download Excel
        </a>
      </Box>
      <Box sx={{ fontSize: 12, color: C.muted, mb: 0.5 }}>
        {rows.length.toLocaleString()} order line{rows.length === 1 ? '' : 's'} · {data.date}{q ? ` matching “${q}”` : ''}
        {pageCount > 1 && <> · page {curPage} / {pageCount}</>}
      </Box>

      {data.rows.length === 0 ? (
        <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, p: 5, textAlign: 'center', bgcolor: '#FAFAFA' }}>
          <Box sx={{ fontFamily: SERIF, fontSize: 18, color: C.navy, mb: 0.5 }}>No SAP orders for {data.date}</Box>
          <Box sx={{ fontSize: 13, color: C.muted, maxWidth: 640, mx: 'auto' }}>
            <b>de_sap.orders</b> only holds <b>SO_CREATION</b> lines. This run produced none — either 0 demand,
            or every line went to an <b>RLM</b> disposition. It populates automatically on a run with real
            SO_CREATION orders, and this page will show them for the selected date.
          </Box>
        </Box>
      ) : (
        <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'auto', maxHeight: '72vh', bgcolor: C.white }}>
          <Table size="small" stickyHeader sx={{ minWidth: 'max-content' }}>
            <TableHead><TableRow>
              {cols.map((c) => (
                <TableCell key={c} align={NUM_COLS.has(c) ? 'right' : 'left'}
                  sx={{ fontFamily: SANS, whiteSpace: 'nowrap' }}>{HDR[c] ?? c}</TableCell>
              ))}
            </TableRow></TableHead>
            <TableBody>
              {pageRows.map((r, i) => (
                <TableRow key={(curPage - 1) * PAGE_SIZE + i}>
                  {cols.map((c, j) => {
                    const v = r[j];
                    return (
                      <TableCell key={c} align={NUM_COLS.has(c) ? 'right' : 'left'}
                        sx={{ fontFamily: MONO_COLS.has(c) || NUM_COLS.has(c) ? MONO : SANS, fontSize: 12,
                          color: (c === 'zwerks' || c === 'zkunnr') ? C.navy : C.slate,
                          fontWeight: MONO_COLS.has(c) ? 700 : 400, whiteSpace: 'nowrap',
                          fontVariantNumeric: NUM_COLS.has(c) ? 'tabular-nums' : undefined }}>
                        {v === null || v === undefined || v === '' ? '—' : String(v)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}

      {data.rows.length > 0 && pageCount > 1 && (
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1.25, flexWrap: 'wrap', gap: 1 }}>
          <Box sx={{ fontSize: 12, color: C.muted }}>page {curPage} / {pageCount} · {pageRows.length.toLocaleString()} shown of {rows.length.toLocaleString()}</Box>
          <Pagination count={pageCount} page={curPage} onChange={(_, p) => setPage(p)} size="small"
            siblingCount={1} boundaryCount={1} showFirstButton showLastButton />
        </Stack>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.rule}`, mt: 3, pt: 1, fontSize: 9, color: C.muted }}>
        <span>AI Order Optimizer · SAP Orders (de_sap.orders · SO_CREATION hand-off) · sample data</span>
        <span>date-scoped · oeid · zposnr</span>
      </Box>
    </Shell>
  );
}
