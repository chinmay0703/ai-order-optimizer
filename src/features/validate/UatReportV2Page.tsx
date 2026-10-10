import { useEffect, useMemo, useState } from 'react';
import { Box, CircularProgress, LinearProgress, Table, TableBody, TableCell, TableHead, TableRow, TableSortLabel } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { api } from '../../api';
import PageIntro from '../../shared/PageIntro';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';

/* ---------------------------------------------------------------------------
   Allocation Report (was "UAT Report V2") — live from /api/v1/uat_report_v2 (the API path is unchanged).
   EVERY SOQ distributor is here: the ones that entered the engine (Input to AIDEN = Yes)
   AND the ones dropped BEFORE it (No, with the drop reason). Run it for the OLD Step-1
   logic vs the EPSILON logic and compare directly. The on-screen table is scoped to the
   header CFA; "Download Excel" always exports EVERY CFA. 100% real — no table is written.
--------------------------------------------------------------------------- */
type Cell = string | number | boolean | null;
type Kpi = { dbs: number; input_to_aiden: number; dropped_before_engine: number; shipped_dbs: number; dropped_in_engine: number; total_shipped: number };
interface Payload { date?: string; cols: string[]; rows: Cell[][]; total: number; filtered: number; kpi: Kpi; }
const PAGE_SIZE = 100;

const nf = (n: unknown) => (Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString() : '');
// TEXT (left-aligned) columns; everything else is a measure → right-aligned + tabular
const TEXT_COL = /date|^cfa$|plant|customer|flag|pdp|input to aiden|reason|truck type|shipment type|cluster|remarks|reg.?zsku|sku|oeid|aiden|order id|status|created|material|batch/i;
const isNum = (h: string) => !TEXT_COL.test(h);

const Shell = ({ children }: { children: React.ReactNode }) => (
  <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
    <Box sx={{ maxWidth: 1560, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
      <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>
        Reports · Allocation Report · reg-zsku × DB × truck
      </Box>
      <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: '6px 0 8px' }}>
        Allocation Report
      </Box>
      {children}
    </Box>
  </Box>
);

export default function UatReportV2Page({ date, cfa }: { date?: string; cfa?: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);    // explicit in-flight flag — true from the FIRST paint (the mount
                                                  // effect always fetches); NEVER infer it from data===null
  const [nonce, setNonce] = useState(0);           // bumped by the error Retry to re-run the effect
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(0);
  const [sortCol, setSortCol] = useState<number>(-1);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [downloading, setDownloading] = useState(false);   // in-flight flag for the Excel export → drives the button spinner
  const [dlErr, setDlErr] = useState<string | null>(null); // download-only error (kept SEPARATE from `err` so a failed
                                                          // export shows a small inline note, not a full-page ErrorState)

  // Fetch the .xlsx as a blob (instead of a plain <a href>) so we can show progress INSIDE the button: the native
  // href download gives no JS signal of when it finishes, so a big all-CFAs export looked like nothing was happening.
  const onDownload = async () => {
    if (downloading) return;
    setDownloading(true); setDlErr(null);
    try {
      const res = await fetch(api.uatReportV2XlsxUrl(date));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `allocation_report_${date ?? 'latest'}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch (e) {
      setDlErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  };

  useEffect(() => { const t = window.setTimeout(() => setDq(q), 350); return () => window.clearTimeout(t); }, [q]);
  useEffect(() => { setPage(0); }, [date, cfa, dq, sortCol, sortDir]);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    api.uatReportV2({ date, cfa, q: dq, sort: sortCol, dir: sortDir, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, cfa, dq, sortCol, sortDir, page, nonce]);

  // column indices for row styling (fetched, never assumed)
  const ix = useMemo(() => {
    const c = data?.cols ?? [];
    const at = (name: string) => c.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    return { input: at('Input to AIDEN'), remarks: at('Remarks') };
  }, [data]);

  const clickSort = (ci: number) => {
    if (sortCol === ci) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(ci); setSortDir('asc'); }
  };

  // Load states, in order. `loading` is the ONLY in-flight signal; `!data` now means "finished with nothing",
  // never "still fetching" — so a 0-row / empty payload lands on the empty state instead of spinning forever.
  if (err) return <Shell><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  // skeleton only on the FIRST load; a re-fetch (search / sort / page) keeps the table and uses the inline bar below
  if (loading && !data) return <Shell><PageSkeleton kpis={6} rows={10} /></Shell>;
  if (!data) return <Shell><EmptyState title="No report for this run"
    hint="Nothing was returned for this run date. Try another run date, or run the pipeline first." /></Shell>;
  if (data.total === 0 && data.rows.length === 0 && !dq) return <Shell><EmptyState title="No distributors in this run"
    hint="This run date has no SOQ distributors to report on. Try another run date, or run the pipeline first." /></Shell>;

  const { kpi, filtered, rows } = data;
  const pageCount = Math.max(1, Math.ceil(Math.max(filtered, 1) / PAGE_SIZE));
  const curPage = Math.min(page, pageCount - 1);
  const from = filtered === 0 ? 0 : curPage * PAGE_SIZE + 1;
  const to = Math.min(filtered, (curPage + 1) * PAGE_SIZE);

  const Kpi = ({ label, val, suffix, fg, bar }: { label: string; val: number; suffix?: string; fg: string; bar: string }) => (
    <Box sx={{ flex: 1, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${bar}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, p: 1.5, bgcolor: C.white }}>
      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted }}>{label}</Box>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 24, color: fg, lineHeight: 1.1 }}>{nf(val)}{suffix}</Box>
    </Box>
  );

  const PageBtn = ({ children, disabled, active, onClick }: { children: React.ReactNode; disabled?: boolean; active?: boolean; onClick: () => void }) => (
    <Box component="button" type="button" disabled={disabled} onClick={onClick}
      sx={{ font: 'inherit', cursor: disabled ? 'default' : 'pointer', minWidth: 34, px: 1, py: 0.5, borderRadius: `${RADIUS.sm}px`,
        border: `1px solid ${active ? C.navy : C.rule}`, bgcolor: active ? C.navy : C.white,
        color: disabled ? C.rule : active ? '#fff' : C.navy, fontSize: 12.5, fontWeight: 700,
        fontVariantNumeric: 'tabular-nums', opacity: disabled ? 0.6 : 1, '&:hover': disabled ? {} : { bgcolor: active ? C.navy : C.cream } }}>
      {children}
    </Box>
  );

  const win = 2;
  const nums: number[] = [];
  for (let i = Math.max(0, curPage - win); i <= Math.min(pageCount - 1, curPage + win); i++) nums.push(i);

  return (
    <Shell>
      <PageIntro>
        One row per <b>CFA × DB × reg-zsku × truck</b> — <b>every distributor that came in the SOQ</b>, including the ones
        dropped <b>before</b> the engine (<b>Input to AIDEN = No</b>). DB-level fields repeat down the DB's reg-zskus; the
        allocation (Original / Filler / Substitution) splits to the reg-zsku, and the shipped cases + <b>Truck SO Flag</b> +
        <b>RLM Truck Status</b> split to the truck — so a DB with one direct-SO truck and one held for RLM reads truck-by-truck.
        <b>AiDEN Order ID</b> comes from the SAP orders hand-off: it is <b>empty while held for RLM</b> and appears once the 15:30 rollup
        creates the SO. The table is scoped to the header CFA; <b>Download Excel exports every CFA</b>.
      </PageIntro>

      <Box sx={{ display: 'flex', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
        <Kpi label="Distributors (SOQ)" val={kpi.dbs} fg={C.navy} bar={C.navy} />
        <Kpi label="Input to AIDEN" val={kpi.input_to_aiden} fg={C.success} bar={C.success} />
        <Kpi label="Dropped before engine" val={kpi.dropped_before_engine} fg={C.warnText} bar={C.gold} />
        <Kpi label="Shipped (>0)" val={kpi.shipped_dbs} fg={C.success} bar={C.success} />
        <Kpi label="Dropped in engine" val={kpi.dropped_in_engine} fg={C.alertRed} bar={C.alertRed} />
        <Kpi label="Total shipped" val={kpi.total_shipped} suffix=" cs" fg={C.navy} bar={C.navy} />
      </Box>

      <Box sx={{ display: 'flex', gap: 1.25, mb: 1.75, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search any column — space-separated terms all match (e.g. 5230 PENDING 66020-MP)"
          style={{ flex: 1, minWidth: 260, maxWidth: 460, padding: '8px 12px', fontSize: 13, fontFamily: SANS, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
        {/* Clear — filters now persist across navigation, so this is the explicit reset for the search box */}
        <button type="button" onClick={() => setQ('')} disabled={!q}
          style={{ padding: '8px 16px', fontSize: 13, fontWeight: 700, fontFamily: SANS, cursor: q ? 'pointer' : 'default',
            color: q ? C.navy : C.rule, background: '#fff', border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }}>
          Clear
        </button>
        <Box sx={{ flex: 1 }} />
        <button type="button" onClick={onDownload} disabled={downloading}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', textDecoration: 'none', padding: '8px 16px',
            fontSize: 13, fontWeight: 800, color: '#fff', background: C.navy, borderRadius: RADIUS.sm, boxShadow: SHADOW.sm,
            cursor: downloading ? 'progress' : 'pointer', opacity: downloading ? 0.85 : 1 }}>
          {downloading
            ? <><CircularProgress size={15} thickness={5} sx={{ color: '#fff' }} /> Downloading… <span style={{ opacity: 0.85, fontWeight: 700 }}>· all CFAs</span></>
            : <><DownloadIcon sx={{ fontSize: 17 }} /> Download Excel <span style={{ opacity: 0.85, fontWeight: 700 }}>· all CFAs</span></>}
        </button>
      </Box>
      {dlErr && <Box sx={{ fontSize: 12, color: C.red, fontWeight: 700, mb: 0.5 }}>Excel download failed: {dlErr} — try again.</Box>}
      <Box sx={{ fontSize: 12, color: C.muted, mb: 0.5, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <span>{nf(filtered)} of {nf(kpi.dbs)} distributors{q ? ` matching “${q}”` : ''} · click a header to sort · {PAGE_SIZE} rows / page</span>
        {loading && <span style={{ color: C.gold, fontWeight: 700 }}>· updating…</span>}
      </Box>

      <Box sx={{ position: 'relative', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'hidden' }}>
        {loading && <LinearProgress sx={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 3, height: 3, bgcolor: 'transparent', '& .MuiLinearProgress-bar': { bgcolor: C.gold } }} />}
        <Box sx={{ overflow: 'auto', maxHeight: '68vh', opacity: loading ? 0.55 : 1, transition: 'opacity .15s', pointerEvents: loading ? 'none' : 'auto' }}>
          <Table size="small" stickyHeader sx={{ minWidth: 'max-content' }}>
            <TableHead><TableRow>
              {data.cols.map((h, ci) => (
                <TableCell key={h} align={isNum(h) ? 'right' : 'left'} sortDirection={sortCol === ci ? sortDir : false}
                  sx={{ fontFamily: SANS, whiteSpace: 'nowrap', fontSize: 11.5 }}>
                  <TableSortLabel active={sortCol === ci} direction={sortCol === ci ? sortDir : 'asc'} onClick={() => clickSort(ci)}>{h}</TableSortLabel>
                </TableCell>
              ))}
            </TableRow></TableHead>
            <TableBody>
              {rows.length === 0 && <TableRow><TableCell colSpan={data.cols.length} sx={{ color: C.muted, py: 2 }}>No distributors match.</TableCell></TableRow>}
              {rows.map((r, i) => {
                const notInput = ix.input >= 0 && String(r[ix.input]) === 'No';
                const remark = ix.remarks >= 0 ? String(r[ix.remarks] ?? '') : '';
                const isDrop = /drop/i.test(remark);
                const bg = notInput ? '#F8F8F8' : isDrop ? '#FBECEB' : undefined;   // grey = dropped pre-engine, red = dropped in-engine
                return (
                  <TableRow key={i} sx={{ bgcolor: bg, '& td': { fontSize: 12, whiteSpace: 'nowrap' } }}>
                    {r.map((v, ci) => {
                      const h = data.cols[ci];
                      const numeric = isNum(h);
                      const isInputCol = /input to aiden/i.test(h);
                      const inputYes = isInputCol && String(v) === 'Yes';
                      const isReason = /aiden input reason/i.test(h);   // show the FULL reason — never trimmed
                      const clip = !isReason && /db name|truck type/i.test(h);   // Remarks: full text, single line (no clip/wrap)
                      return (
                        <TableCell key={ci} align={numeric ? 'right' : 'left'}
                          sx={{
                            fontFamily: numeric || /customer code|^cfa$|sku code|reg.?zsku|order id/i.test(h) ? MONO : SANS,
                            fontVariantNumeric: numeric ? 'tabular-nums' : undefined,
                            color: isInputCol ? (inputYes ? C.success : C.warnText)
                              : /reason|remarks/i.test(h) && v ? C.muted : C.slate,
                            fontWeight: isInputCol || /^(total allocated|final allocated|original fill)/i.test(h) ? 700 : 400,
                            maxWidth: clip ? 240 : undefined,
                            overflow: clip ? 'hidden' : undefined,
                            textOverflow: clip ? 'ellipsis' : undefined,
                            ...(isReason ? { minWidth: 300, '&&': { whiteSpace: 'normal' } } : {}),   // full text, wraps
                          }}
                          title={clip ? String(v ?? '') : undefined}>
                          {v === null || v === '' ? <span style={{ color: C.rule }}>—</span>
                            : /fill rate/i.test(h) ? `${Number(v).toFixed(1)}%`   // AOQ/SOQ shown as a percentage
                              : numeric ? nf(v) : String(v)}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1.75, flexWrap: 'wrap', gap: 1.5 }}>
        <Box sx={{ fontSize: 12, color: C.muted }}>
          Showing <b style={{ color: C.navy }}>{nf(from)}–{nf(to)}</b> of <b style={{ color: C.navy }}>{nf(filtered)}</b> distributors
          {cfa ? <> · CFA <b style={{ color: C.navy }}>{cfa}</b></> : ''} · page {curPage + 1} / {pageCount}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
          <PageBtn disabled={curPage === 0} onClick={() => setPage(0)}>« First</PageBtn>
          <PageBtn disabled={curPage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ Prev</PageBtn>
          {nums[0] > 0 && <Box component="span" sx={{ color: C.muted, px: 0.25 }}>…</Box>}
          {nums.map((n) => <PageBtn key={n} active={n === curPage} onClick={() => setPage(n)}>{n + 1}</PageBtn>)}
          {nums[nums.length - 1] < pageCount - 1 && <Box component="span" sx={{ color: C.muted, px: 0.25 }}>…</Box>}
          <PageBtn disabled={curPage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>Next ›</PageBtn>
          <PageBtn disabled={curPage >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>Last »</PageBtn>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.rule}`, mt: 3, pt: 1, fontSize: 9, color: C.muted }}>
        <span>AI Order Optimizer · Allocation Report · sample data · every SOQ distributor · one row per CFA × DB</span>
        <span>CFA × DB · {data.date ?? ''}</span>
      </Box>
    </Shell>
  );
}
