import { useEffect, useState } from 'react';
import { Box, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import CloseIcon from '@mui/icons-material/Close';
import { api } from '../../api';
import PageIntro from '../../shared/PageIntro';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';

/* ---------------------------------------------------------------------------
   Order Status — read STRAIGHT from `de_sap.order_status` (the SAP status-response table), per run date.
   SERVER-PAGINATED: the DB does LIMIT/OFFSET and any-field search, so the browser only ever holds one page
   (100 rows) — de_sap.order_status can carry very many rows, so loading them all at once was slow. The Download
   hits the SAME endpoint with ?format=xlsx and carries EVERY matching row (not just the page).
--------------------------------------------------------------------------- */
const PAGE_SIZE = 100;
type Row = (string | number | null)[];
interface Payload { cols: string[]; rows: Row[]; date?: string; count?: number; total?: number; }

const MONO_COLS = new Set(['oeid', 'zvbeln', 'zernum']);
const NUM_COLS = new Set(['id', 'zcount']);
const HDR: Record<string, string> = {
  id: 'ID', oeid: 'OEID', zvbeln: 'SAP SO (VBELN)', zstatus_msg: 'Status Message', zstatus: 'Status',
  zernum: 'Created At', zdatum: 'Status Date', zerdat: 'Order Date', zmode: 'Mode', zcount: 'Count',
  created_on: 'Created On',
};
const nf = (n: number) => n.toLocaleString();

const Shell = ({ children }: { children: React.ReactNode }) => (
  <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
    <Box sx={{ maxWidth: 1400, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
      <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>
        Order Status · the SAP status response
      </Box>
      <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: '6px 0 8px' }}>
        Order Status — de_sap.order_status
      </Box>
      {children}
    </Box>
  </Box>
);

// server-paged navigator: "from–to of total" + Prev/Next, matching the Data page's pager
function Pager({ total, page, onPrev, onNext, loading }:
  { total: number; page: number; onPrev: () => void; onNext: () => void; loading: boolean }) {
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);
  const hasPrev = page > 0, hasNext = to < total;
  const btn = (on: boolean) => ({ px: 1.25, py: 0.5, borderRadius: `${RADIUS.sm}px`, border: `1px solid ${on ? C.navy : C.rule}`,
    cursor: on ? 'pointer' : 'default', fontSize: 12, fontWeight: 700, color: on ? C.navy : C.muted, opacity: on ? 1 : 0.5,
    bgcolor: C.white, userSelect: 'none' as const, '&:hover': on ? { bgcolor: C.navyP } : {} });
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
      <Typography sx={{ fontSize: 12, color: C.muted, fontVariantNumeric: 'tabular-nums', mr: 0.5 }}>
        {loading ? 'loading…' : `${nf(from)}–${nf(to)} of ${nf(total)}`}
      </Typography>
      <Box onClick={() => hasPrev && onPrev()} sx={btn(hasPrev)}>{'‹'} Prev</Box>
      <Box onClick={() => hasNext && onNext()} sx={btn(hasNext)}>Next {'›'}</Box>
    </Box>
  );
}

export default function OrderStatusPage({ date }: { date?: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from data===null: an empty payload
  const [err, setErr] = useState<string | null>(null);   // or a failure would then spin forever
  const [nonce, setNonce] = useState(0);            // bumped by the error Retry to re-run the effect
  const [q, setQ] = useState('');                   // the search box value (immediate, for a responsive input)
  const [qq, setQq] = useState('');                 // debounced value that actually drives the server query
  const [page, setPage] = useState(0);              // 0-based page

  // debounce the box → qq so we hit the server once the user pauses, not on every keystroke
  useEffect(() => { const t = setTimeout(() => setQq(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  // a new date or a new search → back to the first page
  useEffect(() => { setPage(0); }, [date, qq]);

  useEffect(() => {
    let alive = true;
    setErr(null); setLoading(true);
    api.orderStatus(date, PAGE_SIZE, page * PAGE_SIZE, qq)
      .then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, page, qq, nonce]);

  const cols = data?.cols ?? [];
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (err) return <Shell><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (!data && loading) return <Shell><PageSkeleton kpis={0} rows={10} /></Shell>;   // FIRST load only → full skeleton
  if (!data) return <Shell><EmptyState title="No SAP order status for this run"
    hint="Nothing came back from de_sap.order_status for this run date. Try another run date." /></Shell>;

  const prev = () => setPage((p) => Math.max(0, p - 1));
  const next = () => setPage((p) => p + 1);

  return (
    <Shell>
      <PageIntro>
        The <b>SAP order status</b> write-back for <b>{data.date}</b> — every column of the
        <b> de_sap.order_status</b> table, read straight from Postgres, for statuses recorded on this date.
        Server-paginated ({PAGE_SIZE}/page); search any field, clear it, and download all matching rows as Excel.
      </PageIntro>

      <Box sx={{ display: 'flex', gap: 1.25, mb: 1.75, flexWrap: 'wrap', alignItems: 'center' }}>
        <Box sx={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flex: 1, minWidth: 240, maxWidth: 380 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search any field…"
            style={{ width: '100%', padding: '8px 30px 8px 12px', fontSize: 13, fontFamily: SANS, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
          {q && (
            <button type="button" onClick={() => setQ('')} aria-label="Clear search"
              style={{ position: 'absolute', right: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                border: 'none', background: 'transparent', cursor: 'pointer', padding: 2, color: C.muted, lineHeight: 0 }}>
              <CloseIcon sx={{ fontSize: 16 }} />
            </button>
          )}
        </Box>
        <Box sx={{ flex: 1 }} />
        <Pager total={total} page={page} loading={loading} onPrev={prev} onNext={next} />
        <a href={api.orderStatusXlsxUrl(date, qq)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none', padding: '8px 16px',
            fontSize: 13, fontWeight: 800, color: '#fff', background: C.navy, borderRadius: RADIUS.sm, boxShadow: SHADOW.sm }}>
          <DownloadIcon sx={{ fontSize: 17 }} /> Download Excel
        </a>
      </Box>
      <Box sx={{ fontSize: 12, color: C.muted, mb: 0.5 }}>
        {nf(total)} row{total === 1 ? '' : 's'} · {data.date}{qq ? ` matching “${qq}”` : ''}
        {total > PAGE_SIZE ? ` · page ${page + 1} of ${nf(pages)}` : ''}
      </Box>

      {total === 0 ? (
        <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, p: 5, textAlign: 'center', bgcolor: '#FAFAFA' }}>
          <Box sx={{ fontFamily: SERIF, fontSize: 18, color: C.navy, mb: 0.5 }}>
            No order status{qq ? ` matching “${qq}”` : ''} for {data.date}
          </Box>
          <Box sx={{ fontSize: 13, color: C.muted, maxWidth: 640, mx: 'auto' }}>
            <b>de_sap.order_status</b> holds SAP's status write-backs. Either none were recorded for this date, or the
            table isn't present in this environment yet. It populates automatically once SAP writes statuses, and this
            page shows them for the selected date.
          </Box>
        </Box>
      ) : (
        <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'auto', maxHeight: '72vh', bgcolor: C.white, opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
          <Table size="small" stickyHeader sx={{ minWidth: 'max-content' }}>
            <TableHead><TableRow>
              {cols.map((c) => (
                <TableCell key={c} align={NUM_COLS.has(c) ? 'right' : 'left'}
                  sx={{ fontFamily: SANS, whiteSpace: 'nowrap' }}>{HDR[c] ?? c}</TableCell>
              ))}
            </TableRow></TableHead>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  {cols.map((c, j) => {
                    const v = r[j];
                    return (
                      <TableCell key={c} align={NUM_COLS.has(c) ? 'right' : 'left'}
                        sx={{ fontFamily: MONO_COLS.has(c) || NUM_COLS.has(c) ? MONO : SANS, fontSize: 12,
                          color: (c === 'oeid' || c === 'zstatus') ? C.navy : C.slate,
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

      {total > PAGE_SIZE && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
          <Pager total={total} page={page} loading={loading} onPrev={prev} onNext={next} />
        </Box>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.rule}`, mt: 3, pt: 1, fontSize: 9, color: C.muted }}>
        <span>AI Order Optimizer · Order Status (de_sap.order_status · SAP write-back) · sample data</span>
        <span>server-paginated · created_on (IST)</span>
      </Box>
    </Shell>
  );
}
