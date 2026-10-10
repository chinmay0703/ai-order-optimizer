import { useEffect, useState, Fragment } from 'react';
import {
  Box, Typography, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel,
  Dialog, IconButton,
} from '@mui/material';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import CloseIcon from '@mui/icons-material/Close';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import CfaEmptyReason from '../../shared/CfaEmptyReason';
import { Stat, SplitBar } from '../../shared/StatCards';
import { ExportXlsxButton, downloadXlsx } from '../../shared/exportXlsx';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';
import ReservationPctDate, { type ReservationPctMeta } from '../../shared/ReservationPctDate';

// one reservation_detail row = one reg-zsku the CFA holds stock of OR one demanded in the SOQ (union), with its MRP,
// anomaly note, role (demanded vs donor-only sub/filler), physical/reserved, and status
interface ResDetail {
  cfa_id: string; channel: string; reg_zsku: string; zsku: string; brand_category: string; role: string; in_soq: boolean; soq_cases: number;
  mrp: string; mrp_band: string; reservation_pct: number; mrp_note: string; physical_cases: number; reserved_cases: number; shipped: number; status: string;
  in_inventory?: boolean;   // does the CFA carry this reg-zsku in cfa_inventory (vs NA / absent) — for the no-stock breakdown
}
type Data = { date: string; reservation_detail?: ResDetail[] } & ReservationPctMeta;

const N = (v: number) => (v ?? 0).toLocaleString();
const C = { navy: '#2D2D2D', gold: '#CC3D07', green: '#017E35', muted: '#5C616A', cream: '#F5F7F8', border: '#DFE3E6', amber: '#CC3D07' };
const PAGE_SIZE = 100;   // client-side pagination — a large reservation table (thousands of reg-zsku × channel rows) froze the render

type Col = { label: string; align: 'left' | 'right'; key: keyof ResDetail; num?: boolean };
const SB_HEAD: Col[] = [
  { label: 'CFA', align: 'left', key: 'cfa_id' },
  { label: 'Channel', align: 'left', key: 'channel' },
  { label: 'reg-zsku', align: 'left', key: 'reg_zsku' },
  { label: 'zsku', align: 'left', key: 'zsku' },
  { label: 'Brand Category', align: 'left', key: 'brand_category' },
  { label: 'MRP', align: 'right', key: 'mrp', num: true },
  { label: 'Band', align: 'left', key: 'mrp_band' },
  { label: 'Physical', align: 'right', key: 'physical_cases', num: true },
  { label: 'Reserved', align: 'right', key: 'reserved_cases', num: true },
  { label: 'Resv %', align: 'right', key: 'reservation_pct', num: true },
  { label: 'Role', align: 'left', key: 'role' },
  { label: 'SOQ', align: 'right', key: 'soq_cases', num: true },
  { label: 'Status', align: 'left', key: 'status' },
];

// CFA STOCK RESERVATION — the FIRST step (pre-processing), before the engine. Every stocked reg-zsku is priced from the
// actual materials in CFA inventory (cfa_inventory ⋈ material_master); a reg-zsku whose materials DISAGREE on MRP is
// resolved to the HIGHEST MRP (business decision) and still reserved — only a reg-zsku with NO parseable MRP is a data
// anomaly dropped here, never reaching the engine. This is the input-validation view, so MRP issues are caught here.
export default function CfaStockReservationPage({ date, cfa }: { date?: string; cfa?: string }) {
  const [d, setD] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from d===null: an empty payload,
  const [err, setErr] = useState<string | null>(null);   // or the no-CFA early return, would then spin forever
  const [nonce, setNonce] = useState(0);            // bumped by the error Retry to re-run the effect
  const [q, setQ] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);   // the "how it works" help modal (was the big intro block)
  const [sortKey, setSortKey] = useState<keyof ResDetail | ''>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);              // 0-based page for the client-side pager
  const descOf = useRegZskuDesc();

  useEffect(() => {                       // reservation detail — SCOPED to the GLOBAL header CFA (lazy)
    if (!cfa) { setD(null); setErr(null); setLoading(false); return; }   // no CFA -> nothing to fetch, not "loading"
    let alive = true; setD(null); setErr(null); setLoading(true);
    api.ledger(date, cfa).then((res) => { if (alive) setD(res as Data); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, cfa, nonce]);

  // any change to the filter / sort / scope resets the pager to the first page (so page N of the old result set
  // can't outlive it). Kept above the early returns so the hook order never changes.
  useEffect(() => { setPage(0); }, [q, sortKey, sortDir, date, cfa]);

  // no CFA -> nothing was ever fetched. This guard sits ABOVE err/loading so clearing the CFA mid-flight
  // cannot flash a skeleton (or a stale error) for the frame before the effect resets them.
  if (!cfa) return <Box sx={{ p: 3 }}><EmptyState title="Pick a CFA to continue"
    hint="This page is scoped to one CFA. Choose one in the run-context bar above." /></Box>;
  if (err) return <Box sx={{ p: 3 }}><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Box>;
  if (loading) return <Box sx={{ p: 3 }}><PageSkeleton kpis={3} rows={9} /></Box>;
  if (!d) return <Box sx={{ p: 3 }}><EmptyState title="No stock reservation for this run"
    hint="Nothing was returned for this date and CFA. Try another run date, or run the pipeline first." /></Box>;

  const rows = d.reservation_detail ?? [];
  // rows are per (reg-zsku × channel), mirroring the cfa_reservation table; summary chips count DISTINCT reg-zskus
  const uniq = Array.from(new Map(rows.map((r) => [`${r.cfa_id}|${r.reg_zsku}`, r])).values());
  // "Demanded" = TRUE live demand (SOQ > 0) — the SAME 113 shown on every other page. (in_soq alone also counts
  // reg-zskus carried in the feed at 0 SOQ, which are NOT real demand — that mislabel is why counts differed.)
  const nDemanded = uniq.filter((r) => (r.soq_cases || 0) > 0).length;   // 113
  const nDonor = uniq.filter((r) => !r.in_soq).length;                   // pure donors — not in the SOQ feed at all
  const nFeedZero = uniq.length - nDemanded - nDonor;                    // in the feed but 0 SOQ (carried, no demand)
  // reg-zskus that ACTUALLY got a reserved pool (physical CFA stock > 0) — the IDENTICAL number the pre-processing
  // "Stock Reserve" node shows (142 all-CFA / 45 for 5230 / 97 for 5710). The other (202 − 142 = 60) reg-zskus are
  // considered/priced but have 0 CFA stock, so nothing is reserved for them (46 feed·0-SOQ + 14 demanded-no-stock).
  const nReserved = uniq.filter((r) => (r.reserved_cases || 0) > 0).length;   // 142 = the pre-processing Stock Reserve count
  const nNoStock = uniq.length - nReserved;                             // considered but 0 CFA stock (nothing reserved)
  // of the DEMANDED (SOQ>0) reg-zskus, how many the CFA actually holds stock of vs how many hold 0 (must be covered by
  // substitute / filler, or go short) — the split the demanded funnel really cares about
  const nDemStock = uniq.filter((r) => (r.soq_cases || 0) > 0 && (r.physical_cases || 0) > 0).length;
  const nDemNoStock = nDemanded - nDemStock;
  // the reserved (have-stock) set, split across the SAME three roles as the composition bar, so the numbers reconcile:
  // reserved = demanded-with-stock + feed·0-SOQ-with-stock + donor-with-stock
  const nDonorStock = uniq.filter((r) => !r.in_soq && (r.physical_cases || 0) > 0).length;
  const nFeedStock = nReserved - nDemStock - nDonorStock;
  // the No-CFA-stock (52) breakdown — all dynamic — for the help tooltip on that KPI box
  const noStock = uniq.filter((r) => (r.physical_cases || 0) <= 0);
  const nNoStockDemanded = noStock.filter((r) => (r.soq_cases || 0) > 0).length;            // demanded but 0 stock (real gaps)
  const nNoStockZeroSoq = noStock.length - nNoStockDemanded;                                // SOQ=0 and 0 stock
  const nNoStockAbsent = noStock.filter((r) => !r.in_inventory).length;                     // not in cfa_inventory at all (NA)
  const nNoStockInvZero = noStock.length - nNoStockAbsent;                                  // in cfa_inventory but qty=0
  // SEARCH — space-separated terms, ALL must match (AND), each term matching ANY field (OR across every column). So
  // "5230 demanded 66020" keeps only rows containing every one of those anywhere across the whole row.
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Search the DISPLAYED cell values (what the user sees), NOT the raw row. The raw `role` field is "Demanded (SOQ)"
  // for EVERY in-feed row (including Feed·0-SOQ ones — it keys off in_soq, not soq_cases), so a raw-value search for
  // "demanded" wrongly matched feed rows too. Build the haystack from the shown cells: the computed Role LABEL, the SOQ
  // (blank when not in the feed), MRP, band, status, ids — so "demanded", "feed", "donor", "no cfa stock", "66020",
  // "554", "b1" all filter to exactly the rows that display them. Space-separated terms AND together (same as UAT V2).
  const roleLabel = (r: ResDetail) => ((r.soq_cases || 0) > 0 ? 'Demanded' : r.in_soq ? 'Feed (SOQ=0)' : 'Donor only');
  const hayOf = (r: ResDetail) => [
    r.cfa_id, r.channel, r.reg_zsku, r.zsku, r.brand_category, descOf(r.reg_zsku), r.mrp, r.mrp_band, r.mrp_note,
    r.physical_cases, r.reserved_cases, r.reservation_pct, roleLabel(r), r.in_soq ? r.soq_cases : '', r.status,
  ].map((v) => String(v ?? '')).join(' ').toLowerCase();   // descOf = the SAME description shown in the table (separate API)
  const shown = terms.length ? rows.filter((r) => terms.every((t) => hayOf(r).includes(t))) : rows;
  // sort by any column, ascending/descending (numeric columns compared numerically)
  const numCol = new Set(SB_HEAD.filter((c) => c.num).map((c) => c.key));
  const clickSort = (k: keyof ResDetail) => { if (sortKey === k) setSortDir((x) => (x === 'asc' ? 'desc' : 'asc')); else { setSortKey(k); setSortDir('asc'); } };
  const sortedShown = (() => {
    if (!sortKey) return shown;
    const sk = sortKey; const isNum = numCol.has(sk);
    return [...shown].sort((a, b) => {
      const va = a[sk] as string | number, vb = b[sk] as string | number;
      const cmp = isNum ? (parseFloat(String(va)) || 0) - (parseFloat(String(vb)) || 0) : String(va ?? '').localeCompare(String(vb ?? ''));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  })();
  // row tint by outcome: MRP anomaly = amber (action needed), no CFA stock = neutral grey, priced OK = white
  const tint = (r: ResDetail) => (r.mrp_note ? '#FFE8D4' : r.status === 'No CFA stock' ? '#F5F7F8' : '#fff');
  // client-side pagination — only the visible page's rows are rendered (a full reservation table is thousands of rows)
  const total = sortedShown.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);   // clamp in case a filter shrank the result set below the current page
  const fromRow = total === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const toRow = Math.min((safePage + 1) * PAGE_SIZE, total);
  const pageRows = sortedShown.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const pBtn = (on: boolean) => ({ px: 1.25, py: '5px', borderRadius: '6px', border: `1px solid ${on ? C.navy : C.border}`,
    cursor: on ? 'pointer' : 'default', fontSize: 12, fontWeight: 700, color: on ? C.navy : C.muted, opacity: on ? 1 : 0.5,
    bgcolor: '#fff', userSelect: 'none' as const, font: 'inherit', '&:hover': on ? { bgcolor: C.cream } : {} });
  const pager = total > PAGE_SIZE ? (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
      <Typography sx={{ fontSize: 12, color: C.muted, fontVariantNumeric: 'tabular-nums', mr: 0.25 }}>{N(fromRow)}–{N(toRow)} of {N(total)}</Typography>
      <Box component="button" type="button" disabled={safePage <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))} sx={pBtn(safePage > 0)}>‹ Prev</Box>
      <Box component="button" type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage((p) => p + 1)} sx={pBtn(safePage < pageCount - 1)}>Next ›</Box>
    </Box>
  ) : null;

  return (
    <Box sx={{ p: { xs: 1.5, sm: 2.5, md: 3 }, maxWidth: 1340, mx: 'auto' }}>
      <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: '#000', bgcolor: '#FFAA72', display: 'inline-block', px: 1, py: '3px', borderRadius: '2px', mb: 0.3 }}>Pre-processing · Step 1 · CFA stock reservation</Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Typography variant="h5">CFA Stock Reservation · MRP validation</Typography>
        <IconButton size="small" onClick={() => setHelpOpen(true)} title="How this page works"
          sx={{ color: C.gold, border: '1px solid #FFCDA8', bgcolor: '#FFF5ED', '&:hover': { bgcolor: '#FFE8D4', borderColor: C.gold } }}>
          <HelpOutlineIcon sx={{ fontSize: 19 }} />
        </IconButton>
        <Box component="span" sx={{ fontSize: 11.5, color: C.muted }}>how it works</Box>
      </Box>
      <ReservationPctDate meta={d} />
      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: '8px', overflow: 'hidden', border: '1px solid #FFB600' } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2.5, py: 1.5, background: 'linear-gradient(135deg, #FE7C39 0%, #CC3D07 55%, #CC3D07 100%)', borderBottom: '1px solid rgba(0,0,0,0.10)', color: '#fff' }}>
          <HelpOutlineIcon sx={{ fontSize: 20 }} />
          <Box sx={{ fontFamily: "'ITC Charter', Charter, Georgia, serif", fontWeight: 700, fontSize: 17 }}>How this page works</Box>
          <Box sx={{ flex: 1 }} />
          <IconButton onClick={() => setHelpOpen(false)} size="small" aria-label="close" sx={{ color: '#fff', '&:hover': { bgcolor: 'rgba(255,255,255,0.18)' } }}><CloseIcon sx={{ fontSize: 20 }} /></IconButton>
        </Box>
        <Box sx={{ p: 2.75, color: '#4C5056', bgcolor: '#FFF5ED', display: 'flex', flexDirection: 'column', gap: 2.75 }}>
          {/* the goal */}
          <Box sx={{ p: '10px 12px', borderRadius: '6px', bgcolor: '#FFF5ED', border: '1px solid #FFCDA8', borderLeft: `3px solid ${C.gold}` }}>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: '#000', borderLeft: '3px solid #E8652C', pl: 0.75, lineHeight: 1.35, mb: 0.4 }}>🎯 The goal</Box>
            <Box sx={{ fontSize: 13, lineHeight: 1.55 }}>The <b>first step</b>, before the engine. <b>Every reg-zsku the CFA holds stock of</b> is priced from the actual materials in CFA inventory, then banded &amp; reserved for the engine to draw.</Box>
          </Box>

          {/* how it's priced */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.7 }}>How each reg-zsku is priced</Box>
            <Box sx={{ p: '9px 11px', mb: 1, borderRadius: '6px', bgcolor: '#fff', border: `1px solid ${C.border}` }}>
              <Box sx={{ fontFamily: 'Consolas, monospace', fontSize: 12, color: '#4C5056' }}><b style={{ color: C.navy }}>cfa_inventory</b> ⋈ <b style={{ color: C.navy }}>material_master</b> → MRP → band → reserve</Box>
            </Box>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
              <Box component="span" sx={{ px: 0.85, py: '3px', borderRadius: 999, border: `1px solid ${C.green}`, color: C.green, fontSize: 11, fontWeight: 700 }}>one clean MRP → banded &amp; reserved</Box>
              <Box component="span" sx={{ px: 0.85, py: '3px', borderRadius: 999, border: `1px solid ${C.amber}`, color: C.amber, fontSize: 11, fontWeight: 700 }}>materials disagree → priced at MAX MRP, still reserved</Box>
              <Box component="span" sx={{ px: 0.85, py: '3px', borderRadius: 999, border: '1px solid #E0301E', color: '#E0301E', fontSize: 11, fontWeight: 700 }}>no MRP at all → dropped</Box>
            </Box>
            <Box sx={{ fontSize: 12.5, lineHeight: 1.5 }}>A reg-zsku whose materials <b>disagree on MRP</b> is <b>not</b> dropped — it is priced at the <b>HIGHEST MRP</b> (a deliberate business decision) and still reserved into the cascade. Only a reg-zsku with <b>no parseable MRP at all</b> is a data anomaly, dropped here so it never reaches the engine. MRP issues are caught at this <b>input-validation gate</b>, not in the engine output.</Box>
          </Box>

          {/* what gets reserved */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.7 }}>What gets reserved</Box>
            <Box sx={{ fontSize: 12.5, lineHeight: 1.5, mb: 1 }}><b>Not limited to demanded (SOQ) reg-zskus</b> — substitute / filler <i>donors</i> that aren't in the SOQ are reserved too, else the engine couldn't draw them. Each row is tagged by role:</Box>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              <Box component="span" sx={{ px: 0.85, py: '3px', borderRadius: 999, border: `1px solid ${C.navy}`, color: C.navy, fontSize: 11, fontWeight: 700 }}>Demanded — in the SOQ</Box>
              <Box component="span" sx={{ px: 0.85, py: '3px', borderRadius: 999, border: `1px solid ${C.green}`, color: C.green, fontSize: 11, fontWeight: 700 }}>Donor only — stock, no SOQ</Box>
            </Box>
          </Box>

          <Box sx={{ pt: 1, borderTop: `1px solid ${C.border}`, fontSize: 11, color: C.muted }}>Live from <code>cfa_reservation</code> for {d.date}.</Box>
        </Box>
      </Dialog>

      {!rows.length ? (
        <CfaEmptyReason cfa={cfa} date={d.date} noun="stock reservation" />
      ) : (
        <>
          {/* stat cards — the reservation at a glance */}
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'stretch', mb: 1.75 }}>
            <Stat label="Reserved" value={nReserved} sub="reg-zskus with CFA stock" tone={C.green} strong />
            <Stat label="Considered" value={uniq.length} sub="filtered SOQ + CFA inv" tone={'#D04A02'} />
            <Stat label="No CFA stock" value={nNoStock} sub="priced · nothing to reserve" tone={C.gold}
              help={<Box sx={{ maxWidth: 300 }}>
                <Box sx={{ fontWeight: 800, mb: 0.6 }}>{nNoStock} priced, 0 CFA stock — two views:</Box>
                <Box><b>by demand:</b> {nNoStockDemanded} (SOQ&gt;0) + {nNoStockZeroSoq} (SOQ=0)</Box>
                <Box><b>by inventory presence:</b> {nNoStockAbsent} (absent / NA) + {nNoStockInvZero} (in inv, qty 0)</Box>
              </Box>} />
            <Box sx={{ flex: 1, minWidth: 8 }} />
            <Box sx={{ display: 'flex', alignItems: 'flex-end' }}>
              <ExportXlsxButton label="Download Excel" size="sm" disabled={!rows.length}
                onClick={() => downloadXlsx(`cfa_stock_reservation_${d.date}`,
                  SB_HEAD.map((c) => c.label), rows.map((r) => SB_HEAD.map((c) => r[c.key])), 'CFA Stock Reservation')} />
            </Box>
          </Box>
          {/* reserved-set composition — demanded vs carried vs donor */}
          <Box sx={{ mb: 1.75, maxWidth: 760 }}>
            <Box sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted, mb: 0.6 }}>
              Reserved-set composition · {uniq.length} reg-zskus · {rows.length} channel rows
            </Box>
            <SplitBar segments={[
              { label: 'Demanded (SOQ>0)', value: nDemanded, color: '#D04A02' },
              { label: 'Feed (SOQ=0)', value: nFeedZero, color: '#E0301E' },
              { label: 'Donor only', value: nDonor, color: C.green },
            ]} />
            <Box sx={{ fontSize: 11.5, color: C.muted, mt: 0.75 }}>
              <b style={{ color: C.green }}>{nReserved} reserved</b> (hold CFA stock) = <b>{nDemStock}</b> demanded (SOQ&gt;0) + <b>{nFeedStock}</b> feed (SOQ=0 but CFA inv &gt; 0) + <b>{nDonorStock}</b> donor (no SOQ but CFA inv &gt; 0) · the other <b>{nNoStock}</b> are priced but hold 0 CFA stock.
            </Box>
            {/* the demanded funnel: of the SOQ-demanded reg-zskus, how many the CFA actually holds stock of */}
            <Box sx={{ mt: 0.9, display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', fontSize: 11.5 }}>
              <Box component="span" sx={{ fontWeight: 800, color: C.navy }}>Demanded {nDemanded}</Box>
              <Box component="span" sx={{ color: C.muted }}>reg-zskus (SOQ&gt;0) →</Box>
              <Box component="span" sx={{ px: 0.85, py: '2px', borderRadius: 999, bgcolor: '#E6F7EC', color: C.green, fontWeight: 800 }}>{nDemStock} have CFA stock</Box>
              <Box component="span" sx={{ px: 0.85, py: '2px', borderRadius: 999, bgcolor: '#FFE8D4', color: C.gold, fontWeight: 800 }}>{nDemNoStock} hold 0 stock</Box>
            </Box>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.25, flexWrap: 'wrap' }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search any field — space-separated (e.g. 5230 demanded 66020)"
              style={{ minWidth: 340, flex: '1 1 340px', maxWidth: 520, padding: '8px 12px', fontSize: 14, fontFamily: 'Consolas, monospace', border: `1px solid ${C.border}`, borderRadius: 6 }} />
            <Box component="button" type="button" onClick={() => setQ('')}
              sx={{ font: 'inherit', cursor: 'pointer', px: 1.75, py: '8px', border: `1px solid ${C.border}`, borderRadius: '6px',
                bgcolor: '#fff', color: C.navy, fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', '&:hover': { bgcolor: C.cream } }}>Clear</Box>
            <Box sx={{ flex: 1, minWidth: 8 }} />
            {pager}
          </Box>
          <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 640 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>{SB_HEAD.map((c) => (
                  <Fragment key={c.label}>
                    <TableCell align={c.align} sortDirection={sortKey === c.key ? sortDir : false} sx={{ whiteSpace: 'nowrap' }}>
                      <TableSortLabel active={sortKey === c.key} direction={sortKey === c.key ? sortDir : 'asc'} onClick={() => clickSort(c.key)}>{c.label}</TableSortLabel>
                    </TableCell>
                    {c.key === 'reg_zsku' && (
                      <TableCell align="left" sx={{ whiteSpace: 'nowrap' }}>Description</TableCell>
                    )}
                  </Fragment>
                ))}</TableRow>
              </TableHead>
              <TableBody>
                {pageRows.map((r, i) => (
                  <TableRow key={i} sx={{ bgcolor: tint(r), '& td': { fontSize: 12.5, whiteSpace: 'nowrap' } }}>
                    <TableCell sx={{ fontWeight: 700, color: C.navy }}>{r.cfa_id}</TableCell>
                    <TableCell>{r.channel || '—'}</TableCell>
                    <TableCell sx={{ fontFamily: 'Consolas, monospace' }}>{r.reg_zsku}</TableCell>
                    <TableCell sx={{ whiteSpace: 'normal' }} title={descOf(r.reg_zsku)}>{descOf(r.reg_zsku) || '—'}</TableCell>
                    <TableCell sx={{ fontFamily: 'Consolas, monospace', color: C.muted }}>{r.zsku || '—'}</TableCell>
                    <TableCell sx={{ color: r.brand_category ? C.navy : C.muted, fontWeight: r.brand_category ? 600 : 400 }}>{r.brand_category || '—'}</TableCell>
                    <TableCell align="right" sx={{ color: r.mrp ? C.green : C.muted, fontWeight: r.mrp ? 700 : 400 }}>{r.mrp ? `₹${r.mrp}` : '—'}</TableCell>
                    <TableCell>{r.mrp_band || '—'}</TableCell>
                    <TableCell align="right">{N(r.physical_cases)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600, color: C.navy }}>{r.channel ? N(r.reserved_cases) : '—'}</TableCell>
                    <TableCell align="right" sx={{ color: '#CC3D07', fontWeight: 600 }} title="Reservation % for this CFA × channel × band (reserved ≈ physical × this %)">{r.channel ? `${r.reservation_pct}%` : '—'}</TableCell>
                    <TableCell sx={{ color: (r.soq_cases || 0) > 0 ? C.navy : C.muted, fontWeight: (r.soq_cases || 0) > 0 ? 600 : 400 }}>{(r.soq_cases || 0) > 0 ? 'Demanded' : (r.in_soq ? 'Feed (SOQ=0)' : 'Donor only')}</TableCell>
                    <TableCell align="right">{r.in_soq ? N(r.soq_cases) : '—'}</TableCell>
                    <TableCell sx={{ color: r.mrp_note ? C.amber : r.status === 'No CFA stock' ? C.muted : C.green, fontWeight: r.mrp_note ? 700 : 600 }}>{r.mrp_note || r.status}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {pager && <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.25 }}>{pager}</Box>}
        </>
      )}
    </Box>
  );
}
