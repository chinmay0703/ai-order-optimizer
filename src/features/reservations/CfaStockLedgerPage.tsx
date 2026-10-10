import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Box, Typography, Chip, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Autocomplete, TextField, Collapse, Stack,
} from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningIcon from '@mui/icons-material/Warning';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { downloadXlsx, ExportXlsxButton } from '../../shared/exportXlsx';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';

// one or_output_ledger row = one reg-zsku's CFA stock at one channel-run of the cascade (columns are snake_case)
interface Row {
  cfa_id: string; run_no: number; channel: string; reg_zsku: string;
  original_stock: number; earmark_added: number; reservation_cap: number;
  allocated: number; remaining_after: number; is_cross_band_filler: boolean;
  [k: string]: unknown;
}
interface Data { date: string; cols: string[]; rows: Row[]; regzskus: string[]; shipped: Record<string, number>; }

const N = (v: number) => (v ?? 0).toLocaleString();
const C = { navy: '#10365A', gold: '#D98A00', green: '#21A366', slate: '#1C1C1C', muted: '#7A756D',
  cream: '#F4F3F1', border: '#E5E2DB', amber: '#D98A00' };

// a single node of the end-to-end flow strip
function FlowStat({ label, value, sub, hue, strong }: { label: string; value: number; sub?: string; hue: string; strong?: boolean }) {
  return (
    <Paper variant="outlined" sx={{ px: 2, py: 1.25, minWidth: 132, borderTop: `3px solid ${hue}`, flex: '0 0 auto' }}>
      <Typography sx={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.muted }}>{label}</Typography>
      <Typography sx={{ fontFamily: "'Google Sans','Product Sans','Poppins','Segoe UI',system-ui,sans-serif", fontWeight: 700, fontSize: strong ? 26 : 23, color: hue, lineHeight: 1.1 }}>{N(value)}</Typography>
      {sub && <Typography sx={{ fontSize: 10.5, color: C.muted }}>{sub}</Typography>}
    </Paper>
  );
}
const Arrow = () => <ArrowForwardIcon sx={{ color: C.border, fontSize: 20, flex: '0 0 auto' }} />;

const CASC_HEAD: [string, 'left' | 'right'][] = [['Run', 'right'], ['Channel', 'left'],
  ['Earmark', 'right'], ['Reservation cap', 'right'],
  ['Allocated', 'right'], ['Remaining → next', 'right']];

export default function CfaStockLedgerPage({ date, embedded }: { date?: string; embedded?: boolean }) {
  const [d, setD] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);    // init TRUE: the fetch fires on mount, so the FIRST paint is the
                                                   // skeleton, never a one-frame "nothing here". And never infer
                                                   // "in flight" from d===null — a 0-row ledger would spin forever.
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);           // bumped by the error Retry to re-run the effect
  const [sel, setSel] = useState<string | null>(null);
  const [selCfa, setSelCfa] = useState<string | null>(null);   // the ledger runs PER CFA — scope the flow to one CFA
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState('');
  const descOf = useRegZskuDesc();

  useEffect(() => {
    let alive = true;
    setErr(null); setLoading(true);
    api.ledger(date).then((res) => {
      if (!alive) return;
      const data = res as Data;
      setD(data);
      setSel((cur) => cur ?? data.regzskus[0] ?? null);
    }).catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, nonce]);

  const byRz = useMemo(() => {
    const m = new Map<string, Row[]>();
    (d?.rows ?? []).forEach((r) => { const k = String(r.reg_zsku); (m.get(k) ?? m.set(k, []).get(k)!).push(r); });
    m.forEach((v) => v.sort((a, b) => a.run_no - b.run_no));
    return m;
  }, [d]);

  // the ledger runs PER CFA — a reg-zsku can sit at several CFAs, each with its OWN physical + reservation cascade.
  // scope everything to ONE CFA so reserved (sum of that CFA's channel earmarks) never exceeds that CFA's physical.
  const cfasForRz = useMemo(() => [...new Set((byRz.get(sel ?? '') ?? []).map((r) => String(r.cfa_id)))].sort(), [byRz, sel]);
  useEffect(() => { setSelCfa((cur) => (cur && cfasForRz.includes(cur) ? cur : cfasForRz[0] ?? null)); }, [cfasForRz]);

  const cascade = useMemo(() => (byRz.get(sel ?? '') ?? []).filter((r) => String(r.cfa_id) === selCfa), [byRz, sel, selCfa]);
  const flow = useMemo(() => {
    if (!cascade.length) return null;
    const physical = cascade[0].original_stock;                          // one CFA -> reserved == physical (rounding fixed)
    const reserved = cascade.reduce((s, r) => s + r.earmark_added, 0);
    const allocated = cascade.reduce((s, r) => s + r.allocated, 0);
    const remaining = cascade[cascade.length - 1].remaining_after;
    const shipped = d?.shipped[`${sel}|${selCfa}`] ?? 0;   // scoped to the SAME (reg-zsku, CFA) slice as `allocated`
    return { physical, reserved, allocated, remaining, shipped };
  }, [cascade, d, sel]);

  const fullRows = useMemo(() => {
    const rows = d?.rows ?? [];
    const term = q.trim().toLowerCase();
    return term ? rows.filter((r) => String(r.reg_zsku).toLowerCase().includes(term) || String(r.channel).toLowerCase().includes(term)) : rows;
  }, [d, q]);
  const cols = useMemo(() => (d?.cols ?? []).filter((c) => c !== 'is_cross_band_filler'), [d]);   // hide cross-band-filler on this screen

  if (err) return <Box sx={{ p: 3 }}><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Box>;
  if (loading) return <Box sx={{ p: 3 }}><PageSkeleton kpis={5} rows={8} /></Box>;
  if (!d) return <Box sx={{ p: 3 }}><EmptyState title="No CFA stock ledger for this run"
    hint="Nothing was returned for this run date. Pick another date in the run-context bar, or run the pipeline first." /></Box>;
  if (!d.regzskus.length) return <Box sx={{ p: 3 }}><EmptyState title={`No ledger rows for ${d.date}`}
    hint="The engine has not written or_output_ledger for this date yet. Run the engine, or pick a date that has already run." /></Box>;

  const shipOk = flow ? flow.shipped === flow.allocated : true;
  const capOk = flow ? flow.allocated <= flow.physical : true;

  return (
    <Box sx={embedded ? { maxWidth: 1340 } : { p: { xs: 1.5, sm: 2.5, md: 3 }, maxWidth: 1340, mx: 'auto' }}>
      {!embedded && (
        <>
          <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold, mb: 0.3 }}>Reservation · CFA stock ledger</Typography>
          <Typography variant="h5" sx={{ mb: 0.5 }}>CFA Stock Ledger · end-to-end flow per reg-zsku</Typography>
        </>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Follow any one reg-zsku's CFA stock all the way through: <b>physical on-hand</b> → reserved per channel across the
        cascade → <b>allocated</b> (total cases drawn, including when the SKU is borrowed as a substitute/filler for another
        DB) → <b>shipped</b> (FEFO batch picks) → what <b>remains</b>. Every number is live from <code>or_output_ledger</code> for {d.date}.
      </Typography>

      <Autocomplete
        size="small" sx={{ maxWidth: 460, mb: 1.5 }} options={d.regzskus} value={sel}
        onChange={(_, v) => setSel(v)}
        renderInput={(p) => <TextField {...p} label={`Select reg-zsku (${d.regzskus.length})`} />}
      />
      {cfasForRz.length > 0 && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
          <Typography sx={{ fontSize: 12, fontWeight: 700, color: C.muted }}>CFA:</Typography>
          {cfasForRz.map((cf) => (
            <Chip key={cf} label={cf} size="small" onClick={() => setSelCfa(cf)}
              sx={{ fontWeight: 700, cursor: 'pointer', bgcolor: cf === selCfa ? C.navy : '#fff',
                color: cf === selCfa ? '#fff' : C.navy, border: `1px solid ${C.navy}`, '&:hover': { bgcolor: cf === selCfa ? C.navy : C.cream } }} />
          ))}
          <Typography sx={{ fontSize: 11.5, color: C.muted }}>· sits at {cfasForRz.length} CFA{cfasForRz.length > 1 ? 's' : ''} — each has its own physical + reservation (the pipeline runs CFA-wise)</Typography>
        </Stack>
      )}

      {flow && (
        <>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1.25 }}>
            <FlowStat label="Physical stock" value={flow.physical} sub="on-hand at CFA" hue={C.navy} strong />
            <Arrow />
            <FlowStat label="Reserved" value={flow.reserved} sub={`earmarked · CFA ${selCfa ?? ''}`} hue={C.gold} />
            <Arrow />
            <FlowStat label="Allocated" value={flow.allocated} sub="drawn · own + donor" hue={C.navy} />
            <Arrow />
            <FlowStat label="Shipped" value={flow.shipped} sub="FEFO batch picks" hue={C.green} strong />
            <Arrow />
            <FlowStat label="Remaining" value={flow.remaining} sub="left on shelf" hue={C.muted} />
          </Stack>
          <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
            <Chip size="small" icon={shipOk ? <CheckCircleIcon /> : <WarningIcon />}
              label={shipOk ? 'shipped = allocated' : `shipped ${N(flow.shipped)} ≠ allocated ${N(flow.allocated)}`}
              sx={{ bgcolor: shipOk ? '#E9F4EC' : '#FBF1E0', color: shipOk ? C.green : C.amber, fontWeight: 700, '& .MuiChip-icon': { color: shipOk ? C.green : C.amber } }} />
            <Chip size="small" icon={capOk ? <CheckCircleIcon /> : <WarningIcon />}
              label={capOk ? 'allocated ≤ physical' : 'allocated > physical'}
              sx={{ bgcolor: capOk ? '#E9F4EC' : '#F8E9E6', color: capOk ? C.green : '#DC2C25', fontWeight: 700, '& .MuiChip-icon': { color: capOk ? C.green : '#DC2C25' } }} />
            <Chip size="small" icon={flow.reserved <= flow.physical ? <CheckCircleIcon /> : <WarningIcon />}
              label={flow.reserved <= flow.physical ? 'reserved ≤ physical' : `reserved ${N(flow.reserved)} > physical ${N(flow.physical)}`}
              sx={{ bgcolor: flow.reserved <= flow.physical ? '#E9F4EC' : '#F8E9E6', color: flow.reserved <= flow.physical ? C.green : '#DC2C25', fontWeight: 700, '& .MuiChip-icon': { color: flow.reserved <= flow.physical ? C.green : '#DC2C25' } }} />
          </Stack>

          <Typography sx={{ fontSize: 13, fontWeight: 700, color: C.navy, mb: 0.75 }}>Channel cascade — {sel} @ CFA {selCfa} · how the {N(flow.physical)} cases flow run by run</Typography>
          <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {CASC_HEAD.map(([h, a]) => <TableCell key={h} align={a}>{h}</TableCell>)}
                </TableRow>
              </TableHead>
              <TableBody>
                {cascade.map((r) => (
                  <TableRow key={r.run_no} sx={{ bgcolor: '#fff', '& td': { fontSize: 12.5 } }}>
                    <TableCell align="right" sx={{ fontWeight: 700, color: C.navy }}>R{r.run_no}</TableCell>
                    <TableCell>{r.channel}</TableCell>
                    <TableCell align="right" sx={{ color: C.gold, fontWeight: 600 }}>{N(r.earmark_added)}</TableCell>
                    <TableCell align="right">{N(r.reservation_cap)}</TableCell>
                    <TableCell align="right" sx={{ color: r.allocated > 0 ? C.green : C.muted, fontWeight: r.allocated > 0 ? 700 : 400 }}>{N(r.allocated)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{N(r.remaining_after)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1, flexWrap: 'wrap' }}>
        <Typography onClick={() => setShowAll((v) => !v)} sx={{ cursor: 'pointer', fontWeight: 700, color: C.navy, fontSize: 13, userSelect: 'none' }}>
          {showAll ? '▾' : '▸'} Full ledger table — all reg-zskus, as-is ({d.rows.length} rows)
        </Typography>
        {showAll && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter reg-zsku / channel"
            style={{ minWidth: 240, padding: '8px 12px', fontSize: 14, fontFamily: 'Consolas, monospace', border: `1px solid ${C.border}`, borderRadius: 6 }} />
        )}
        {showAll && q && (
          <Box onClick={() => setQ('')} title="Clear the search field"
            sx={{ cursor: 'pointer', px: 1.5, py: 0.6, fontSize: 13, fontWeight: 700, borderRadius: '6px', border: `1px solid ${C.border}`, bgcolor: '#fff', color: C.muted, '&:hover': { borderColor: C.navy, color: C.navy } }}>✕ Clear</Box>
        )}
        <Box sx={{ flex: 1 }} />
        <ExportXlsxButton label="Export Excel"
          onClick={() => downloadXlsx('cfa_stock_ledger', cols, d.rows.map((r) => cols.map((c) => r[c] as string | number | boolean | null)))} />
      </Box>
      <Collapse in={showAll}>
        <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 620 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                {cols.map((c) => (
                  c === 'reg_zsku'
                    ? <Fragment key={c}><TableCell align="left">{c}</TableCell><TableCell align="left">Description</TableCell></Fragment>
                    : <TableCell key={c} align={typeof d.rows[0]?.[c] === 'number' ? 'right' : 'left'}>{c}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {fullRows.slice(0, 800).map((r, i) => (
                <TableRow key={i} hover sx={{ bgcolor: String(r.reg_zsku) === sel ? '#EAF0F8' : '#fff' }}>
                  {cols.map((c) => {
                    const v = r[c];
                    const cell = <TableCell key={c} align={typeof v === 'number' ? 'right' : 'left'} sx={{ fontSize: 12, whiteSpace: 'nowrap' }}>{typeof v === 'number' ? N(v) : typeof v === 'boolean' ? (v ? 'true' : '') : String(v ?? '')}</TableCell>;
                    return c === 'reg_zsku'
                      ? <Fragment key={c}>{cell}<TableCell align="left" sx={{ whiteSpace: 'normal', fontSize: 12 }} title={descOf(String(r.reg_zsku))}>{descOf(String(r.reg_zsku)) || '—'}</TableCell></Fragment>
                      : cell;
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        {fullRows.length > 800 && <Typography sx={{ fontSize: 11, color: C.muted, mt: 0.5 }}>showing first 800 of {N(fullRows.length)} rows — filter to narrow</Typography>}
      </Collapse>
    </Box>
  );
}
