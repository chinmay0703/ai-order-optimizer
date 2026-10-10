import { useEffect, useState, type ReactNode } from 'react';
import {
  Box, Typography, FormControl, InputLabel, Select, MenuItem, Chip, Paper, Stack, Tooltip, Collapse,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { downloadXlsxMulti, ExportXlsxButton } from '../../shared/exportXlsx';
import { useOeParams, pct } from '../../shared/OeParams';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';

interface DbRow { db: string; db_name: string; tier: number; pdp_today: boolean; pdp_freq: string | null;
  has_below: boolean; valid_via: string; }
interface Validity { via_pdp: number; via_below_only: number; neither: number; total_valid: number; }
interface InvRow { reg_zsku: string; mrp: number | null; stock: number; earmark_pct: number; earmark: number; cap: number; remaining_after: number; }
interface DemRow { db: string; db_name: string; tier: number; reg_zsku: string; brand: string; mrp: number | null;
  soq: number; norm: number; max_norm: number; db_stock: number; below_threshold: boolean; threshold_cases: number; pdp_today: boolean; }
interface RunData {
  cfa: string; cfas: string[];
  run: { run_no: number; channel: string; band: number; band_label: string; band_desc: string; band_mrps: number[]; pct: number };
  run_day: string; today: string; weekday: string;
  params: { below_threshold_pct: number };
  dbs: { channel_network: number; channel_served: number; in_scope: number; validity: Validity; list: DbRow[] };
  cfa_inventory: InvRow[]; demand: DemRow[];
}

const fmt = (n: number) => n.toLocaleString();
// today + the next (n-1) days, computed with LOCAL date math (no UTC shift) — used so the run-day picker
// can ONLY offer today/future; past dates simply don't exist as options.
function upcomingDays(todayIso: string, n: number) {
  const [y, m, dd] = todayIso.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const dt = new Date(y, m - 1, dd + i);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const wd = dt.toLocaleDateString('en-US', { weekday: 'short' });
    return { iso, label: `${wd} ${iso}${i === 0 ? ' · today' : ''}` };
  });
}
const cell = { py: 0.4, px: 1, fontSize: '0.72rem', whiteSpace: 'nowrap' as const };
const YesNo = ({ v }: { v: boolean }) => (
  <Chip size="small" label={v ? 'Yes' : 'No'} sx={{ height: 18, fontSize: '0.62rem', fontWeight: 700,
    bgcolor: v ? '#dcfce7' : '#f1f5f9', color: v ? '#15803d' : '#7A756D' }} />
);

function Section({ n, title, desc, count, children }: { n: number; title: string; desc: string; count?: string; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ mb: 2, overflow: 'hidden' }}>
      <Box sx={{ px: 2, py: 1.25, bgcolor: '#f8fafc', borderBottom: '1px solid #E5E2DB' }}>
        <Stack direction="row" spacing={1.5} alignItems="flex-start">
          <Box sx={{ width: 26, height: 26, borderRadius: '50%', bgcolor: '#10365A', color: '#fff', mt: 0.25,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '0.78rem', flexShrink: 0 }}>{n}</Box>
          <Box sx={{ flex: 1 }}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography sx={{ fontWeight: 800, fontSize: '0.92rem' }}>{title}</Typography>
              {count && <Chip size="small" label={count} sx={{ bgcolor: '#e0e7ff', color: '#10365A', fontWeight: 700, fontSize: '0.64rem' }} />}
            </Stack>
            <Typography sx={{ fontSize: '0.72rem', color: '#1C1C1C', mt: 0.25 }}>{desc}</Typography>
          </Box>
        </Stack>
      </Box>
      <Box sx={{ p: 1.5 }}>{children}</Box>
    </Paper>
  );
}

// table hidden by default — keeps the page to summary stats; click to reveal
function Collapsible({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Box>
      <Box onClick={() => setOpen((o) => !o)}
        sx={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 0.25, py: 0.5,
          color: '#10365A', fontWeight: 700, fontSize: '0.74rem', userSelect: 'none' }}>
        {open ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
        {open ? 'Hide' : label}
      </Box>
      <Collapse in={open} timeout="auto" unmountOnExit>{children}</Collapse>
    </Box>
  );
}

const Stat = ({ label, value, hi }: { label: string; value: string | number; hi?: boolean }) => (
  <Box sx={{ px: 1.5, py: 0.75, border: '1px solid #E5E2DB', borderRadius: 1, minWidth: 130, bgcolor: hi ? '#eff6ff' : '#fff' }}>
    <Typography sx={{ fontSize: '0.6rem', color: '#7A756D', textTransform: 'uppercase', letterSpacing: '.03em' }}>{label}</Typography>
    <Typography sx={{ fontWeight: 800, fontSize: '1.05rem', color: hi ? '#10365A' : '#0f172a' }}>{value}</Typography>
  </Box>
);

function Head({ cols }: { cols: string[] }) {
  return <TableHead><TableRow sx={{ '& th': { fontWeight: 700, bgcolor: '#F1F1F0', color: '#7A756D', textTransform: 'uppercase', letterSpacing: '.04em', ...cell } }}>
    {cols.map((c, i) => <TableCell key={c} align={i === 0 || c === 'Description' ? 'left' : 'right'}>{c}</TableCell>)}
  </TableRow></TableHead>;
}

export default function CfaWalkthroughPage({ date }: { date?: string }) {
  const [cfa, setCfa] = useState('');
  const [runDay, setRunDay] = useState('');           // '' = let the backend use today
  const [d, setD] = useState<RunData | null>(null);
  const [listLoading, setListLoading] = useState(true);   // the CFA list is fetched on mount -> start busy
  const [loading, setLoading] = useState(false);          // the per-run fetch. NEVER inferred from d===null:
  const [err, setErr] = useState<string | null>(null);    // no CFA, or an empty run, would then spin forever
  const [nonce, setNonce] = useState(0);                  // bumped by the error Retry to re-run BOTH fetches
  const P = useOeParams();
  const descOf = useRegZskuDesc();
  const RUN = 1;

  useEffect(() => {                       // which CFAs ran on this date -> the picker's first value
    let alive = true;
    setErr(null); setListLoading(true);
    api.cfaList(date).then((r) => { if (!alive) return; const c = (r as { cfas: string[] }).cfas; if (c.length) setCfa(c[0]); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setListLoading(false); });   // 0 CFAs settles too -> we show "no CFA", not a spinner
    return () => { alive = false; };
  }, [date, nonce]);
  useEffect(() => {
    if (!cfa) { setLoading(false); return; }   // nothing to fetch without a CFA -> that is NOT "loading"
    let alive = true;
    setD(null); setErr(null); setLoading(true);
    api.cfaRun(cfa, RUN, runDay || undefined, date).then((r) => { if (!alive) return; const v = r as RunData; setD(v); if (!runDay) setRunDay(v.run_day); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [cfa, runDay, date, nonce]);

  if (err) return <Box sx={{ p: 3 }}><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Box>;
  if (listLoading || loading) return <Box sx={{ p: 3 }}><PageSkeleton kpis={4} rows={8} /></Box>;
  if (!cfa) return <Box sx={{ p: 3 }}><EmptyState title="No CFA to walk through"
    hint="No CFA ran on this date, so there is nothing to step through. Pick another run date in the bar above, or run the pipeline first." /></Box>;
  if (!d) return <Box sx={{ p: 3 }}><EmptyState title={`No run detail for CFA ${cfa}`}
    hint="This CFA returned nothing for the selected run day. Try another run day, or another run date." /></Box>;

  const r = d.run; const thrPct = d.params.below_threshold_pct * 100;

  return (
    <Box sx={{ p: { xs: 1.5, sm: 2.5, md: 3 }, maxWidth: 1320, mx: 'auto' }}>
      <Typography variant="h5" sx={{ fontWeight: 800, mb: 0.5 }}>CFA Walkthrough</Typography>

      <Stack direction="row" spacing={2} sx={{ mb: 2 }} alignItems="center" flexWrap="wrap" useFlexGap>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>CFA</InputLabel>
          <Select label="CFA" value={cfa} onChange={(e) => setCfa(e.target.value)}>
            {d.cfas.map((c) => <MenuItem key={c} value={c}>CFA {c}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel>Run day (PDP)</InputLabel>
          <Select label="Run day (PDP)" value={runDay || d.today} onChange={(e) => setRunDay(e.target.value)}>
            {upcomingDays(d.today, 15).map((o) => <MenuItem key={o.iso} value={o.iso}>{o.label}</MenuItem>)}
          </Select>
        </FormControl>
        <ExportXlsxButton label="Export Excel" onClick={() => downloadXlsxMulti(`cfa_walkthrough_${d.cfa}`, [
          { name: 'DBs', headers: ['DB', 'Name', 'Tier', 'PDP today', 'PDP freq', 'Has below', 'Valid via'],
            rows: d.dbs.list.map((x) => [x.db, x.db_name, x.tier, x.pdp_today, x.pdp_freq, x.has_below, x.valid_via]) },
          { name: 'CFA inventory', headers: ['reg-zsku', 'MRP', 'CFA stock', 'Earmark %', 'Earmark', 'CAP', 'Remaining after'],
            rows: d.cfa_inventory.map((x) => [x.reg_zsku, x.mrp, x.stock, x.earmark_pct, x.earmark, x.cap, x.remaining_after]) },
          { name: 'Demand', headers: ['DB', 'DB name', 'Tier', 'reg-zsku', 'Brand', 'MRP', 'SOQ', 'Norm', 'Max-Norm', 'DB stock', 'Below threshold', 'Threshold cases', 'PDP today'],
            rows: d.demand.map((x) => [x.db, x.db_name, x.tier, x.reg_zsku, x.brand, x.mrp, x.soq, x.norm, x.max_norm, x.db_stock, x.below_threshold, x.threshold_cases, x.pdp_today]) },
        ])} />
      </Stack>

      {/* Run 1 banner */}
      <Paper variant="outlined" sx={{ p: 1.5, mb: 2, bgcolor: '#eff6ff', borderColor: '#bfdbfe' }}>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip label={`RUN ${r.run_no}`} color="primary" sx={{ fontWeight: 800 }} />
          <Typography sx={{ fontWeight: 700 }}>{r.channel} · Band {r.band} ({r.band_desc}) · {r.pct}% reserved</Typography>
          <Box sx={{ flex: 1 }} />
          <Typography sx={{ fontSize: '0.74rem', color: '#1C1C1C' }}>run day <b>{d.weekday} {d.run_day}</b></Typography>
        </Stack>
        <Typography sx={{ fontSize: '0.72rem', color: '#1C1C1C', mt: 0.75 }}>
          Run {r.run_no} allocates {r.pct}% of stock to the <b>{r.channel}</b> channel for <b>Band {r.band}</b> reg-zskus (<b>{r.band_desc}</b> — e.g.
          MRP {r.band_mrps.slice(0, 6).map((m) => `₹${m}`).join(', ')}…). Only {r.channel} DBs and Band-{r.band} reg-zskus are considered here.
        </Typography>
      </Paper>

      {/* 1 — DB selection */}
      <Section n={1} title="DBs selected for this run" count={`${fmt(d.dbs.in_scope)} of ${fmt(d.dbs.channel_served)} this CFA serves`}
        desc={`Each DB is served by exactly one CFA. CFA ${d.cfa} serves ${fmt(d.dbs.channel_served)} ${r.channel} DBs (the ${fmt(d.dbs.channel_network)} network total is split across all CFAs); ${fmt(d.dbs.in_scope)} of them have Band-${r.band} demand.`}>
        <Stack direction="row" spacing={1.25} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
          <Stat label={`${r.channel} DBs — network`} value={fmt(d.dbs.channel_network)} />
          <Stat label={`${r.channel} DBs — CFA ${d.cfa} serves`} value={fmt(d.dbs.channel_served)} />
          <Stat label={`…with Band-${r.band} demand`} value={fmt(d.dbs.in_scope)} hi />
        </Stack>
      </Section>

      {/* 1b — validity: PDP first, then non-PDP-but-below-threshold */}
      <Section n={2} title="Which of those DBs are valid for allocation" count={`${fmt(d.dbs.validity.total_valid)} valid`}
        desc={`A DB qualifies if (1) it is a PDP day — scheduled for delivery on the run day (${d.weekday}) — OR (2) even if NOT PDP today, it has at least one reg-zsku with on-hand below ${thrPct}% of Norm (running low). Both paths count as valid.`}>
        <Stack direction="row" spacing={1.25} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
          <Stat label={`① PDP today (${d.weekday})`} value={fmt(d.dbs.validity.via_pdp)} />
          <Stat label={`② not PDP, but ≥1 reg-zsku < ${thrPct}%`} value={fmt(d.dbs.validity.via_below_only)} />
          <Stat label="= valid for allocation" value={fmt(d.dbs.validity.total_valid)} hi />
          {d.dbs.validity.neither > 0 && <Stat label="neither (check)" value={fmt(d.dbs.validity.neither)} />}
        </Stack>
        <Collapsible label={`View all ${fmt(d.dbs.in_scope)} DBs`}>
        <TableContainer sx={{ maxHeight: 360 }}>
          <Table size="small" stickyHeader sx={{ '& td,& th': cell }}>
            <Head cols={['DB', 'name', 'tier', 'PDP frequency', `PDP ${d.weekday}?`, `has reg-zsku < ${thrPct}%?`, 'valid via']} />
            <TableBody>
              {[...d.dbs.list].sort((a, b) => Number(b.pdp_today) - Number(a.pdp_today)).map((x) => (
                <TableRow key={x.db} hover>
                  <TableCell>{x.db}</TableCell>
                  <TableCell align="right">{x.db_name}</TableCell>
                  <TableCell align="right">{x.tier}</TableCell>
                  <TableCell align="right">{x.pdp_freq ?? '—'}</TableCell>
                  <TableCell align="right"><YesNo v={x.pdp_today} /></TableCell>
                  <TableCell align="right"><YesNo v={x.has_below} /></TableCell>
                  <TableCell align="right">
                    <Chip size="small" label={x.valid_via}
                      sx={{ height: 18, fontSize: '0.62rem', fontWeight: 700,
                        bgcolor: x.valid_via === 'PDP' ? '#dbeafe' : x.valid_via === 'below-threshold' ? '#FBF4E1' : '#fee2e2',
                        color: x.valid_via === 'PDP' ? '#10365A' : x.valid_via === 'below-threshold' ? '#b45309' : '#DC2C25' }} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        </Collapsible>
      </Section>

      {/* 3 — CFA inventory (this run's band) + earmark */}
      <Section n={3} title={`CFA ${d.cfa} inventory — Band ${r.band} reg-zskus, with the ${r.pct}% reservation`} count={`${fmt(d.cfa_inventory.length)} reg-zskus`}
        desc={`This CFA's stock of each Band-${r.band} reg-zsku. Run ${r.run_no} may use up to ${r.pct}% of it (the earmark); CAP is what this run can actually draw, and “remaining → next” carries to the next Band-${r.band} run.`}>
        <Collapsible label={`View ${fmt(d.cfa_inventory.length)} reg-zskus`}>
        <TableContainer sx={{ maxHeight: 340 }}>
          <Table size="small" stickyHeader sx={{ '& td,& th': cell }}>
            <Head cols={['reg-zsku', 'Description', 'MRP', 'CFA stock', `earmark ${r.pct}%`, 'CAP this run', 'remaining → next']} />
            <TableBody>
              {d.cfa_inventory.map((x) => (
                <TableRow key={x.reg_zsku} hover>
                  <TableCell>{x.reg_zsku}</TableCell>
                  <TableCell sx={{ whiteSpace: 'normal' }} title={descOf(x.reg_zsku)}>{descOf(x.reg_zsku) || '—'}</TableCell>
                  <TableCell align="right">{x.mrp != null ? `₹${x.mrp}` : '—'}</TableCell>
                  <TableCell align="right">{fmt(x.stock)}</TableCell>
                  <TableCell align="right">{fmt(x.earmark)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, color: '#10365A' }}>{fmt(x.cap)}</TableCell>
                  <TableCell align="right" sx={{ color: '#21A366' }}>{fmt(x.remaining_after)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        </Collapsible>
      </Section>

      {/* 4 — demand: SOQ / Norm / Max-Norm + PDP + below-threshold */}
      <Section n={4} title={`Demand per DB × Band-${r.band} reg-zsku`} count={`${fmt(d.demand.length)} lines`}
        desc={`For every selected DB and Band-${r.band} reg-zsku: SOQ (cases to ship) = Norm − on-hand; Max-Norm = the ${P.NORM_MULTIPLIER}× ceiling. “< ${thrPct}%” flags on-hand below ${thrPct}% of Norm (the low-stock rule that pulls a line into demand even on a non-PDP day).`}>
        <Collapsible label={`View ${fmt(d.demand.length)} demand lines`}>
        <TableContainer sx={{ maxHeight: 460 }}>
          <Table size="small" stickyHeader sx={{ '& td,& th': cell }}>
            <Head cols={['DB · reg-zsku', 'Description', 'MRP', 'tier', 'Norm', 'on-hand', `< ${thrPct}%?`, 'SOQ', 'Max-Norm', `PDP ${d.weekday}?`]} />
            <TableBody>
              {d.demand.map((x, i) => (
                <TableRow key={i} hover>
                  <TableCell><Tooltip title={`${x.db_name} · ${x.brand}`}><span>{x.db} · {x.reg_zsku}</span></Tooltip></TableCell>
                  <TableCell sx={{ whiteSpace: 'normal' }} title={descOf(x.reg_zsku)}>{descOf(x.reg_zsku) || '—'}</TableCell>
                  <TableCell align="right">{x.mrp != null ? `₹${x.mrp}` : '—'}</TableCell>
                  <TableCell align="right">{x.tier}</TableCell>
                  <TableCell align="right">{fmt(x.norm)}</TableCell>
                  <TableCell align="right">{fmt(x.db_stock)}</TableCell>
                  <TableCell align="right">
                    <Tooltip title={`threshold = ${x.threshold_cases} cs (${thrPct}% of Norm)`}><span><YesNo v={x.below_threshold} /></span></Tooltip>
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>{fmt(x.soq)}</TableCell>
                  <TableCell align="right" sx={{ color: '#10365A' }}>{fmt(x.max_norm)}</TableCell>
                  <TableCell align="right"><YesNo v={x.pdp_today} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        </Collapsible>
      </Section>
    </Box>
  );
}
