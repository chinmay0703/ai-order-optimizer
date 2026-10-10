import { useEffect, useMemo, useState } from 'react';
import {
  Box, Typography, Chip, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  FormControl, InputLabel, Select, MenuItem, ListSubheader,
} from '@mui/material';
import CfaAccordion from '../../shared/accordions/CfaAccordion';
import PageIntro from '../../shared/PageIntro';
import { useOeParams, pct } from '../../shared/OeParams';
import ClusterPrimaryTrucks from './ClusterPrimaryTrucks';
import Metric from '../../shared/Metric';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { downloadXlsx, downloadXlsxMulti, ExportXlsxButton } from '../../shared/exportXlsx';
import type { Cfa } from '../../types';

interface Casc { run: number; channel: string; pct: number; earmark: number; carried_in: number; available: number; allocated: number; carried_out: number; }
interface Meta { run: number; channel: string; band: number; pct: number; lanes: number; demand: number; cap: number; allocated: number; fill: number; leftover: number; }
interface Run { meta: Meta; }
interface Data { cascade: Record<string, Casc[]>; runs: Run[]; }
type RunData = Record<string, { cfas: Cfa[]; meta: { cases: number; trucks: number } }>;

const N = (v: number) => v.toLocaleString();
const bandc = (b: number) => (b === 1 ? { bg: '#E6F7EC', bar: '#017E35', chip: '#017E35' } : b === 2 ? { bg: '#F5F7F8', bar: '#2D2D2D', chip: '#2D2D2D' } : { bg: '#FFE8D4', bar: '#CC3D07', chip: '#CC3D07' });
// three internal tabs: the reservation cascade waterfall · the per-run allocation detail · the transshipment cluster primary trucks
const TABS = [
  { k: 'cascade', label: 'Reservation cascade' },
  { k: 'runs', label: 'Allocation runs · Trucks · SKUs' },
  { k: 'transship', label: 'Transshipment · cluster primary trucks' },
  { k: 'rlmptl', label: 'RLM truck approval' },
  { k: 'seccfa', label: '2nd CFA shift' },
] as const;
type Tab = typeof TABS[number]['k'];

function CascadeTable({ cascade }: { cascade: Record<string, Casc[]> }) {
  const rows: { band: number; s: Casc }[] = [];
  for (const b of [1, 2, 3]) for (const st of (cascade[String(b)] ?? [])) rows.push({ band: b, s: st });
  const HEAD: [string, 'left' | 'right'][] = [['Band', 'left'], ['Run', 'right'], ['Channel', 'left'],
    ['Reserve %', 'right'], ['Pool in', 'right'], ['Earmark', 'right'], ['Available', 'right'], ['Used', 'right'], ['Carry \u2192 next', 'right']];
  return (
    <TableContainer component={Paper} sx={{ mb: 2 }}>
      <Table size="small">
        <TableHead><TableRow>{HEAD.map(([h, a]) => <TableCell key={h} align={a}>{h}</TableCell>)}</TableRow></TableHead>
        <TableBody>
          {rows.map(({ band, s }) => {
            const c = bandc(band);
            return (
              <TableRow key={`${band}-${s.run}`} sx={{ bgcolor: c.bg }}>
                <TableCell><Chip size="small" label={`Band ${band} ${band === 1 ? '\u226410\u20b9' : band === 2 ? '11-30\u20b9' : '>30\u20b9'}`} sx={{ bgcolor: '#fff', color: c.chip, border: `1px solid ${c.bar}`, fontWeight: 700, height: 22 }} /></TableCell>
                <TableCell align="right" sx={{ fontWeight: 700, color: '#2D2D2D' }}>R{s.run}</TableCell>
                <TableCell>{s.channel}</TableCell>
                <TableCell align="right" sx={{ color: '#5C616A' }}>{s.pct}%</TableCell>
                <TableCell align="right">{N(s.carried_in)}</TableCell>
                <TableCell align="right" sx={{ color: '#2D2D2D', fontWeight: 600 }}>{N(s.earmark)}</TableCell>
                <TableCell align="right">{N(s.available)}</TableCell>
                <TableCell align="right" sx={{ color: '#017E35' }}>{N(s.allocated)}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>{N(s.carried_out)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

// ---- RLM tabs (date-wise): truck-approval (PTL) + 2nd-CFA shift, from the RLM tables we persist ----
const STOCK_C: Record<string, { bg: string; fg: string }> = {
  'Out of Stock': { bg: '#F8E9E6', fg: '#D02818' }, Low: { bg: '#FFE8D4', fg: '#8A3A0C' },
  Healthy: { bg: '#E6F7EC', fg: '#017E35' }, Overstocked: { bg: '#F5F7F8', fg: '#2D2D2D' },
};
const stockChip = (s: string) => {
  const c = STOCK_C[s] ?? { bg: '#F5F7F8', fg: '#5C616A' };
  return <Chip size="small" label={s || '—'} sx={{ bgcolor: c.bg, color: c.fg, fontWeight: 700, height: 20, fontSize: 11 }} />;
};
const nm = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString());
const pc = (v: number | null | undefined) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
// PTL header status → chip colour. The application sends exactly one of PENDING / APPROVED / REJECTED.
// APPROVED = shipped (green); REJECTED = won't ship (red); PENDING = awaiting the rollup (amber, auto-REJECTS at the deadline).
const ptlStatusChipC = (s: string): { bg: string; fg: string } => {
  const st = String(s || '').trim().toUpperCase();
  if (st === 'APPROVED') return { bg: '#E6F7EC', fg: '#017E35' };
  if (st === 'REJECTED') return { bg: '#F8E9E6', fg: '#D02818' };
  return { bg: '#FFE8D4', fg: '#8A3A0C' };   // PENDING (or anything else) → amber
};
// 2nd-CFA shift header status → chip colour. The application owns it (PENDING / SHIFTED / HELD); the rollup resolves a
// PENDING or HELD header to APPROVED (the primary CFA ships), and leaves SHIFTED (the secondary CFA ships) as-is.
const shiftStatusChipC = (s: string): { bg: string; fg: string } => {
  const st = String(s || '').trim().toUpperCase();
  if (st === 'APPROVED') return { bg: '#E6F7EC', fg: '#017E35' };   // resolved → primary/current CFA ships
  if (st === 'SHIFTED') return { bg: '#F5F7F8', fg: '#4C5056' };    // routed to the secondary CFA
  if (st === 'HELD') return { bg: '#FFE8D4', fg: '#8A3A0C' };       // held
  return { bg: '#F5F7F8', fg: '#5C616A' };                          // PENDING (or unknown) → awaiting the rollup
};

interface PtlLine { reg_zsku_code: string; truck_number: number | null; truck_qty: number; zsku_description: string; zsku_soq_qty: number; zsku_aoq_qty: number; zsku_original_qty: number; zsku_filler_qty: number; zsku_substitution_qty: number; zsku_soh: number; zsku_db_inventory_coverage_pct: number; zsku_current_inventory_coverage_pct: number; zsku_stock_status: string; }
interface PtlHeader { engine_order_id: string; status: string; distributor_code: string; distributor_name: string; pdp_flag: boolean; pdp_frequency: string | null; soq: number; cfa_code: string; truck_type: string; truck_number: string | number; total_trucks: number; truck_load_capacity: number; aoq_qty: number; truck_load_gap_qty: number; truck_load_utilization_pct: number; base_aoq_qty: number; filler_aoq_qty: number; substitution_aoq_qty: number; line_items: PtlLine[]; }
interface PtlData { available: boolean; headers: PtlHeader[]; summary: { trucks: number; dbs: number; line_items: number; total_aoq: number }; }

// ONE workbook, TWO sheets — 'Headers' (one row per truck header) + 'Line Items' (every SKU line, keyed back to its
// order/DB/truck). Exports the COMPLETE dataset (all headers + all their line_items), not just what's expanded.
function exportRlmPtl(d: PtlData, date?: string): void {
  const H_HEAD = ['Order ID', 'Status', 'DB Code', 'DB Name', 'PDP Flag', 'PDP Frequency', 'Combined SOQ', 'CFA', 'Truck Type', 'Truck #', 'Total Trucks', 'Capacity',
    'AOQ Qty', 'Gap Qty', 'Fill %', 'Base AOQ', 'Filler AOQ', 'Substitute AOQ'];
  const headerRows = d.headers.map((h) => [h.engine_order_id, h.status, h.distributor_code, h.distributor_name,
    h.pdp_flag, h.pdp_frequency, h.soq, h.cfa_code, h.truck_type, h.truck_number, h.total_trucks, h.truck_load_capacity, h.aoq_qty, h.truck_load_gap_qty,
    h.truck_load_utilization_pct, h.base_aoq_qty, h.filler_aoq_qty, h.substitution_aoq_qty]);
  const H_LINE = ['Order ID', 'DB Code', 'DB Name', 'CFA', 'Truck #', 'reg-zsku', 'Truck Qty', 'Description',
    'SOQ', 'AOQ', 'Original', 'Filler', 'Substitution', 'SOH', 'Coverage %', 'Current Coverage %', 'Stock Status'];
  const lineRows = d.headers.flatMap((h) => h.line_items.map((l) => [h.engine_order_id, h.distributor_code,
    h.distributor_name, h.cfa_code, l.truck_number, l.reg_zsku_code, l.truck_qty, l.zsku_description,
    l.zsku_soq_qty, l.zsku_aoq_qty, l.zsku_original_qty, l.zsku_filler_qty, l.zsku_substitution_qty,
    l.zsku_soh, l.zsku_db_inventory_coverage_pct, l.zsku_current_inventory_coverage_pct, l.zsku_stock_status]));
  downloadXlsxMulti(`rlm_truck_approval_${date || 'latest'}`, [
    { name: 'Headers', headers: H_HEAD, rows: headerRows },
    { name: 'Line Items', headers: H_LINE, rows: lineRows },
  ]);
}

function RlmPtlTab({ date }: { date?: string }) {
  const P = useOeParams();   // engine thresholds (oe_parameters) — never hardcode 90
  const descOf = useRegZskuDesc();
  const [d, setD] = useState<PtlData | null>(null);
  const [loading, setLoading] = useState(true);    // init TRUE: fetched on mount -> first paint is the skeleton, not
                                                   // a flash of "no data". NEVER infer "in flight" from d===null:
                                                   // a null payload would spin forever
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let alive = true;
    setD(null); setLoading(true);
    api.rlmPtl(date).then((r) => { if (alive) setD(r as PtlData); })
      .catch(() => { if (alive) setD({ available: false, headers: [], summary: { trucks: 0, dbs: 0, line_items: 0, total_aoq: 0 } }); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date]);
  if (loading) return <PageSkeleton kpis={4} rows={6} />;
  if (!d) return <EmptyState title="No RLM truck-approval data"
    hint="Nothing came back for this run date. Pick another date in the run-context bar, or run the pipeline first." />;
  if (!d.available || !d.headers.length) return <Typography color="text.secondary" sx={{ p: 1 }}>No RLM truck-approval trucks for this run date.</Typography>;
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Trucks held for <b>RLM truck approval</b> (allocated but truck fill &lt; {pct(P.TRUCK_FILL_TARGET_PCT)} — pending a planner&apos;s approval before an SO is created). One card per DB truck; click for its SKU line items. Saved in <b>rlm_ptl_headers</b> / <b>rlm_ptl_line_items</b>.
      </Typography>
      <Box sx={{ display: 'flex', gap: 1.5, mb: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <Metric label="Trucks held">{N(d.summary.trucks)}</Metric>
        <Metric label="Distributors">{N(d.summary.dbs)}</Metric>
        <Metric label="SKU line items">{N(d.summary.line_items)}</Metric>
        <Metric label="AOQ cases (pending)">{N(d.summary.total_aoq)}</Metric>
        <Box sx={{ flex: 1, minWidth: 12 }} />
        <ExportXlsxButton label="Export Excel" onClick={() => exportRlmPtl(d, date)} />
      </Box>
      {d.headers.map((h) => (
        <Paper key={h.engine_order_id} variant="outlined" sx={{ mb: 1.25, overflow: 'hidden' }}>
          <Box onClick={() => setOpen((o) => ({ ...o, [h.engine_order_id]: !o[h.engine_order_id] }))}
            sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 1.75, py: 1.1, cursor: 'pointer', flexWrap: 'wrap', '&:hover': { bgcolor: '#FAF9F8' } }}>
            <Typography sx={{ fontWeight: 800, color: '#2D2D2D' }}>{open[h.engine_order_id] ? '▾' : '▸'} DB {h.distributor_code}</Typography>
            <Typography sx={{ fontSize: 13, color: '#2D2D2D' }}>{h.distributor_name}</Typography>
            <Chip size="small" label={`CFA ${h.cfa_code}`} sx={{ bgcolor: '#F5F7F8', color: '#2D2D2D', fontWeight: 700, height: 22 }} />
            <Chip size="small" label={`${h.truck_type || 'Truck'} #${h.truck_number}`} sx={{ bgcolor: '#fff', border: '1px solid #CBD1D6', fontWeight: 700, height: 22 }} />
            {/* distributor-level (CFA × DB) — from filtered_soq */}
            <Chip size="small" label={`PDP ${h.pdp_flag ? '✓' : '✗'}`} title="distributor PDP flag (filtered_soq.is_pdp — boolean)"
              sx={{ bgcolor: h.pdp_flag ? '#E6F7EC' : '#F5F7F8', color: h.pdp_flag ? '#017E35' : '#5C616A', fontWeight: 700, height: 22 }} />
            <Chip size="small" label={`PDP freq ${h.pdp_frequency || '—'}`}
              title={h.pdp_frequency ? `distributor PDP frequency from the PDP master: ${h.pdp_frequency}` : 'no PDP frequency for this distributor in the PDP master'}
              sx={{ bgcolor: h.pdp_frequency ? '#F5F7F8' : '#fff', border: '1px solid #CBD1D6', color: h.pdp_frequency ? '#4C5056' : '#5C616A', fontWeight: 700, height: 22 }} />
            <Chip size="small" label={`Combined SOQ ${nm(h.soq)}`} title="distributor combined SOQ (CFA × DB, Σ SOQ over its reg-zskus)"
              sx={{ bgcolor: '#F5F7F8', color: '#2D2D2D', fontWeight: 700, height: 22 }} />
            <Box sx={{ flex: 1 }} />
            <Typography sx={{ fontSize: 12.5, color: '#5C616A' }}>fill <b style={{ color: Math.round(h.truck_load_utilization_pct ?? 0) >= P.TRUCK_FILL_TARGET_PCT * 100 ? '#017E35' : '#8A3A0C' }}>{pc(h.truck_load_utilization_pct)}</b> · cap {nm(h.truck_load_capacity)} · AOQ <b>{nm(h.aoq_qty)}</b> · gap {nm(h.truck_load_gap_qty)} · DB trucks <b title="total trucks for this DB across SO + RLM + shift">{nm(h.total_trucks)}</b></Typography>
            <Chip size="small" label={h.status || 'RLM_TRUCK_APPROVAL'} sx={{ bgcolor: ptlStatusChipC(h.status).bg, color: ptlStatusChipC(h.status).fg, fontWeight: 700, height: 22 }} />
          </Box>
          {open[h.engine_order_id] && (
            <Box sx={{ px: 1.75, pb: 1.5 }}>
              <Typography sx={{ fontSize: 11.5, color: '#5C616A', mb: 0.75 }}>Base {nm(h.base_aoq_qty)} + Filler {nm(h.filler_aoq_qty)} + Substitute {nm(h.substitution_aoq_qty)} = AOQ {nm(h.aoq_qty)}</Typography>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead><TableRow>{([['reg-zsku', 'left'], ['Description', 'left'], ['Truck Qty', 'right'], ['SOQ', 'right'], ['AOQ', 'right'], ['Original', 'right'], ['Filler', 'right'], ['Substitution', 'right'], ['SOH', 'right'], ['Coverage', 'right'], ['Curr. Cov', 'right'], ['Stock', 'left']] as const).map(([c, a], i) => <TableCell key={i} align={a}>{c}</TableCell>)}</TableRow></TableHead>
                  <TableBody>
                    {h.line_items.map((l, i) => {
                      const notAllocated = l.truck_number == null;   // demanded (has SOQ) but nothing allocated — no truck
                      return (
                      <TableRow key={i} sx={notAllocated ? { bgcolor: '#FAFAFA', '& td': { color: '#A1A8B3', fontStyle: 'italic' } } : undefined}
                        title={notAllocated ? 'Demanded (has SOQ) but not allocated — not on any truck' : undefined}>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, color: notAllocated ? '#A1A8B3' : '#2D2D2D' }}>{l.reg_zsku_code}</TableCell>
                        <TableCell sx={{ whiteSpace: 'normal' }} title={descOf(l.reg_zsku_code) || l.zsku_description}>{descOf(l.reg_zsku_code) || l.zsku_description || '—'}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700 }}>{l.truck_number != null ? nm(l.truck_qty) : '—'}</TableCell>
                        <TableCell align="right">{nm(l.zsku_soq_qty)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700 }}>{nm(l.zsku_aoq_qty)}</TableCell>
                        <TableCell align="right" title="cases shipped for the reg-zsku's OWN demand">{nm(l.zsku_original_qty)}</TableCell>
                        <TableCell align="right" title="cases used as a FILLER (truck top-up)">{nm(l.zsku_filler_qty)}</TableCell>
                        <TableCell align="right" title="cases lent as a SUBSTITUTE">{nm(l.zsku_substitution_qty)}</TableCell>
                        <TableCell align="right">{nm(l.zsku_soh)}</TableCell>
                        <TableCell align="right" title="Projected coverage: (SOH + AOQ) / stock-norm × 100">{pc(l.zsku_db_inventory_coverage_pct)}</TableCell>
                        <TableCell align="right" title="Current coverage: SOH / stock-norm × 100 — on-hand only, no AOQ">{pc(l.zsku_current_inventory_coverage_pct)}</TableCell>
                        <TableCell>{stockChip(l.zsku_stock_status)}</TableCell>
                      </TableRow>
                    );})}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}
        </Paper>
      ))}
    </Box>
  );
}

interface ShiftLine { reg_zsku_code: string; zsku_description: string; zsku_soq_qty: number; zsku_aoq_qty: number; zsku_alternate_cfa_qty: number; zsku_db_inventory_coverage_pct: number; zsku_stock_status: string; }
interface ShiftHeader { engine_order_id: string; status: string; distributor_code: string; distributor_name: string; preferred_cfa_code: string; preferred_cfa_name: string; preferred_cfa_fill_pct: number; preferred_cfa_fill_qty: number; preferred_cfa_shortfall_qty: number; alternate_cfa_code: string; alternate_cfa_name: string; alternate_cfa_qty: number; aoq_qty: number; lead_time: string | number; line_items: ShiftLine[]; }
interface ShiftData { available: boolean; headers: ShiftHeader[]; summary: { orders: number; dbs: number; line_items: number; total_aoq: number }; }

function RlmSecondCfaTab({ date }: { date?: string }) {
  const P = useOeParams();   // engine thresholds (oe_parameters) — never hardcode 50
  const descOf = useRegZskuDesc();
  const [d, setD] = useState<ShiftData | null>(null);
  const [loading, setLoading] = useState(true);    // init TRUE: fetched on mount -> first paint is the skeleton, not
                                                   // a flash of "no data". NEVER infer "in flight" from d===null:
                                                   // a null payload would spin forever
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let alive = true;
    setD(null); setLoading(true);
    api.rlmSecondCfa(date).then((r) => { if (alive) setD(r as ShiftData); })
      .catch(() => { if (alive) setD({ available: false, headers: [], summary: { orders: 0, dbs: 0, line_items: 0, total_aoq: 0 } }); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date]);
  if (loading) return <PageSkeleton kpis={4} rows={6} />;
  if (!d) return <EmptyState title="No 2nd-CFA shift data"
    hint="Nothing came back for this run date. Pick another date in the run-context bar, or run the pipeline first." />;
  if (!d.available || !d.headers.length) return <Typography color="text.secondary" sx={{ p: 1 }}>No 2nd-CFA shift orders for this run date.</Typography>;
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        DBs whose orders route to an <b>alternate CFA</b> (the preferred CFA can&apos;t fill enough — Original &lt; {pct(P.SO_CREATION_ORIGINAL_FLOOR_PCT)} of SOQ). Each card shows the <b>preferred</b> CFA (fill% + shortfall) vs the <b>alternate</b> CFA (qty) + lead time; click for the SKU line items. Saved in <b>rlm_cfa_shift_headers</b> / <b>rlm_cfa_shift_line_items</b>.
      </Typography>
      <Box sx={{ display: 'flex', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
        <Metric label="Orders shifted">{N(d.summary.orders)}</Metric>
        <Metric label="Distributors">{N(d.summary.dbs)}</Metric>
        <Metric label="SKU line items">{N(d.summary.line_items)}</Metric>
        <Metric label="AOQ cases (2nd CFA)">{N(d.summary.total_aoq)}</Metric>
      </Box>
      {d.headers.map((h) => (
        <Paper key={h.engine_order_id} variant="outlined" sx={{ mb: 1.25, overflow: 'hidden' }}>
          <Box onClick={() => setOpen((o) => ({ ...o, [h.engine_order_id]: !o[h.engine_order_id] }))}
            sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 1.75, py: 1.1, cursor: 'pointer', flexWrap: 'wrap', '&:hover': { bgcolor: '#FAF9F8' } }}>
            <Typography sx={{ fontWeight: 800, color: '#2D2D2D' }}>{open[h.engine_order_id] ? '▾' : '▸'} DB {h.distributor_code}</Typography>
            <Typography sx={{ fontSize: 13, color: '#2D2D2D' }}>{h.distributor_name}</Typography>
            <Chip size="small" label={h.status || 'PENDING'} sx={{ bgcolor: shiftStatusChipC(h.status).bg, color: shiftStatusChipC(h.status).fg, fontWeight: 700, height: 22 }} />
            <Box sx={{ flex: 1 }} />
            <Chip size="small" label={`preferred ${h.preferred_cfa_code} · ${pc(h.preferred_cfa_fill_pct)} · short ${nm(h.preferred_cfa_shortfall_qty)}`} sx={{ bgcolor: '#F8E9E6', color: '#D02818', fontWeight: 700, height: 22 }} />
            <Typography sx={{ color: '#5C616A' }}>→</Typography>
            <Chip size="small" label={`alternate ${h.alternate_cfa_code} · ${nm(h.alternate_cfa_qty)} cs`} sx={{ bgcolor: '#E6F7EC', color: '#017E35', fontWeight: 700, height: 22 }} />
            <Chip size="small" label={`lead ${h.lead_time ?? '—'}`} sx={{ bgcolor: '#fff', border: '1px solid #CBD1D6', fontWeight: 700, height: 22 }} />
          </Box>
          {open[h.engine_order_id] && (
            <Box sx={{ px: 1.75, pb: 1.5 }}>
              <Typography sx={{ fontSize: 11.5, color: '#5C616A', mb: 0.75 }}>Preferred {h.preferred_cfa_name} ({h.preferred_cfa_code}): fill {nm(h.preferred_cfa_fill_qty)} / shortfall {nm(h.preferred_cfa_shortfall_qty)} · Alternate {h.alternate_cfa_name} ({h.alternate_cfa_code}): {nm(h.alternate_cfa_qty)} · AOQ {nm(h.aoq_qty)}</Typography>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead><TableRow>{['reg-zsku', 'Description', 'SOQ', 'AOQ', 'Alt-CFA qty', 'Coverage', 'Stock'].map((c, i) => <TableCell key={i} align={i >= 2 && i <= 5 ? 'right' : 'left'}>{c}</TableCell>)}</TableRow></TableHead>
                  <TableBody>
                    {h.line_items.map((l, i) => (
                      <TableRow key={i}>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, color: '#2D2D2D' }}>{l.reg_zsku_code}</TableCell>
                        <TableCell sx={{ whiteSpace: 'normal' }} title={descOf(l.reg_zsku_code) || l.zsku_description}>{descOf(l.reg_zsku_code) || l.zsku_description || '—'}</TableCell>
                        <TableCell align="right">{nm(l.zsku_soq_qty)}</TableCell>
                        <TableCell align="right">{nm(l.zsku_aoq_qty)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, color: '#017E35' }}>{nm(l.zsku_alternate_cfa_qty)}</TableCell>
                        <TableCell align="right">{pc(l.zsku_db_inventory_coverage_pct)}</TableCell>
                        <TableCell>{stockChip(l.zsku_stock_status)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}
        </Paper>
      ))}
    </Box>
  );
}

export default function ReservationRunsPage({ date, initialTab }: { date?: string; initialTab?: Tab }) {
  const P = useOeParams();   // engine thresholds (oe_parameters) — never hardcode 65
  const [d, setD] = useState<Data | null>(null);
  const [rd, setRd] = useState<RunData | null>(null);
  const [loading, setLoading] = useState(true);    // init TRUE: fetched on mount -> the FIRST paint is the skeleton,
                                                   // not a flash of "no data". And never infer "in flight" from
                                                   // d===null — a run list with 0 rows would spin forever.
  const [rdLoading, setRdLoading] = useState(false);   // the HEAVY reservation_data is fetched lazily (Runs tab only)
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);           // bumped by the error Retry to re-run the effect
  const [sel, setSel] = useState(1);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'runs');   // ① cascade · ② run allocation (default) · ③ transshipment cluster · RLM approval tabs
  // when the sidebar Approvals links open this page at a specific tab (rlmptl / seccfa), honor it on (re)navigation
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);

  // SHELL + cascade data (the LIGHT `reservation_runs`) — drives the title, the tab bar, the Reservation-cascade tab
  // and the Runs-tab selector. Always fetched; it is cheap. A new date drops the heavy run-detail so the Runs tab
  // refetches it for that date.
  useEffect(() => {
    let alive = true;
    setErr(null); setLoading(true); setRd(null);
    api.reservationRuns(date).then((runs) => { if (alive) setD(runs as Data); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, nonce]);

  // PER-RUN allocation detail — the HEAVY `reservation_data` (≈12 tables, looped runs × CFAs × DBs × trucks × SKUs).
  // ONLY the "Allocation runs" tab renders it, so fetch it LAZILY the first time that tab is opened. The RLM truck
  // approval / 2nd-CFA shift / cascade / transshipment tabs never trigger it (they self-fetch their own small
  // payloads) — which is what made opening this page directly at the 2nd-CFA-shift tab needlessly slow. Cached per date.
  const needRunData = tab === 'runs';
  useEffect(() => {
    if (!needRunData || rd) return;                        // not the Runs tab, or already loaded for this date → skip
    let alive = true; setRdLoading(true);
    api.reservationData(date).then((data) => { if (alive) setRd(data as RunData); })
      .catch(() => { if (alive) setRd({}); })              // settle empty on failure → the tab shows "no allocation", not a spinner
      .finally(() => { if (alive) setRdLoading(false); });
    return () => { alive = false; };
  }, [date, nonce, needRunData, rd]);

  const run = useMemo(() => d?.runs.find((r) => r.meta.run === sel), [d, sel]);

  if (err) return (
    <Box sx={{ p: 3 }}>
      <ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} />
    </Box>
  );
  if (loading) return <Box sx={{ p: 3 }}><PageSkeleton kpis={5} rows={8} /></Box>;
  if (!d) return <Box sx={{ p: 3 }}><EmptyState title="No reservation runs for this date"
    hint="The cascade produced no runs for this run date. Pick another date in the run-context bar, or run the pipeline first." /></Box>;

  const channels: string[] = [];
  d.runs.forEach((r) => { if (!channels.includes(r.meta.channel)) channels.push(r.meta.channel); });
  const m = run?.meta;
  const cfas = rd?.[String(sel)]?.cfas ?? [];
  const heldLanes = cfas.reduce((s, c) => s + c.trucks.filter((t) => t.dropped).length, 0);   // lanes cancelled at the ≥65% truck rule

  return (
    <Box sx={{ p: { xs: 1.5, sm: 2.5, md: 3 }, maxWidth: 1340, mx: 'auto' }}>
      <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: '#000', bgcolor: '#FFAA72', display: 'inline-block', px: 1, py: '3px', borderRadius: '2px', mb: 0.3 }}>Reservation · CFA stock cascade</Typography>
      <Typography variant="h5" sx={{ mb: 0.5 }}>Reservation Runs · {d.runs.length}-run cascade</Typography>
      <PageIntro>
        The CFA stock is reserved per channel (each band's share) and allocated in {d.runs.length} sequential channel runs
        (smallest reservation first: Non-PACE → Hub &amp; Spoke → AFH → Retail) — all three MRP bands of a channel ship in ONE truck per DB. Leftover stock cascades per
        band to the next channel; any surplus after the last run stays unallocated.
      </PageIntro>

      <Box sx={{ display: 'flex', gap: 0.5, mb: 2.5, borderBottom: '1px solid #DFE3E6', flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <Box key={t.k} onClick={() => setTab(t.k)}
            sx={{ cursor: 'pointer', px: 2, py: 1, fontSize: 13, fontWeight: 800, color: tab === t.k ? '#2D2D2D' : '#5C616A',
              borderBottom: `2px solid ${tab === t.k ? '#CC3D07' : 'transparent'}`, mb: '-1px', '&:hover': { color: '#2D2D2D' } }}>{t.label}</Box>
        ))}
      </Box>

      {/* ① Reservation cascade — the run-by-run × band waterfall (pool in → earmark → used → carry to next) */}
      {tab === 'cascade' && (
        <>
          <Box sx={{ mb: 1.5 }}>
            <ExportXlsxButton label="Export cascade" onClick={() => downloadXlsx('reservation_cascade',
              ['Band', 'Run', 'Channel', 'Reserve %', 'Pool in', 'Earmark', 'Available', 'Used', 'Carry to next'],
              [1, 2, 3].flatMap((b) => (d.cascade[String(b)] ?? []).map((s) =>
                [b, s.run, s.channel, s.pct, s.carried_in, s.earmark, s.available, s.allocated, s.carried_out])))} />
          </Box>
          <CascadeTable cascade={d.cascade} />
        </>
      )}

      {/* ② Allocation runs — pick a run, see its cascade stats + per-CFA Allocation · Trucks · SKUs */}
      {tab === 'runs' && (
        <>
          <FormControl size="small" sx={{ minWidth: { xs: 0, sm: 480 }, width: { xs: '100%', sm: 'auto' }, maxWidth: '100%', mb: 2 }}>
            <InputLabel>Select run</InputLabel>
            <Select label="Select run" value={sel} onChange={(e) => setSel(Number(e.target.value))}
              renderValue={(v) => {
                const r = d.runs.find((x) => x.meta.run === v)?.meta;
                return r ? `Run ${r.run} · ${r.channel} (Bands 1+2+3) — ${N(r.allocated)} cs` : '';
              }}>
              {channels.flatMap((ch) => [
                <ListSubheader key={ch} sx={{ fontWeight: 800, fontSize: '0.7rem', letterSpacing: '.04em',
                  textTransform: 'uppercase', color: '#2D2D2D', lineHeight: 2.4, bgcolor: '#FAFAFA' }}>{ch}</ListSubheader>,
                ...d.runs.filter((r) => r.meta.channel === ch).map((r) => (
                  <MenuItem key={r.meta.run} value={r.meta.run} sx={{ pl: 3, fontSize: '0.82rem' }}>
                    <Box component="span" sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: '#2D2D2D', mr: 1, flexShrink: 0 }} />
                    {/* ONE span for the whole label: MenuItem is a flex row, so bare text + <b> + " cs" would be
                        THREE flex items and the narrow ones get squeezed — "194 cs" wrapped as "19 / 4 · c / s"
                        on a phone. As a single item the label wraps like normal prose. */}
                    <Box component="span" sx={{ minWidth: 0 }}>
                      Run {r.meta.run} · {r.meta.channel} (Bands 1+2+3) — <b>{N(r.meta.allocated)}</b>&nbsp;cs
                    </Box>
                  </MenuItem>
                )),
              ])}
            </Select>
          </FormControl>

          {m && run && (
            <>
              <Paper variant="outlined" sx={{ px: 2, py: 1.5, mb: 1.5, borderTop: '3px solid #2D2D2D' }}>
                <Typography sx={{ fontWeight: 700, fontSize: '1rem', color: '#303236', mb: 1 }}>
                  Run {m.run} — {m.channel} · Bands 1+2+3 (combined truck)
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                  <Metric label="Lanes">{N(m.lanes)}</Metric>
                  <Metric label="Demand">{N(m.demand)} cs</Metric>
                  <Metric label="Reservation cap" tip="Combined reservation pool available to this channel run (carried-in + this run's earmark, across all bands)">{N(m.cap)} cs</Metric>
                  <Metric label="Allocated" color="#2D2D2D">{N(m.allocated)} cs</Metric>
                  <Metric label="Fill" color="#017E35">{m.fill}%</Metric>
                  {heldLanes > 0 && <Metric label="Held · no truck" color="#E0301E" tip={`Lanes cancelled at the ≥${pct(P.TRUCK_KEEP_PCT)}-per-truck rule — cases cascade to the next run`}>{heldLanes}</Metric>}
                </Box>
              </Paper>

              <Typography sx={{ fontSize: 13, fontWeight: 700, color: '#2D2D2D', mb: 0.75 }}>Allocation · Trucks · SKUs</Typography>
              <Box>
                {(rdLoading || !rd) && <Typography color="text.secondary" sx={{ py: 2 }}>Loading run detail…</Typography>}
                {rd && cfas.map((c) => <CfaAccordion key={c.cfa} cfa={c} defaultOpen={false} />)}
                {!rdLoading && rd && cfas.length === 0 && <Typography color="text.secondary" sx={{ py: 2 }}>No allocation in this run.</Typography>}
              </Box>
            </>
          )}
        </>
      )}

      {/* ③ Transshipment — the final cluster PRIMARY trucks (combine → full trucks → trim) */}
      {tab === 'transship' && <ClusterPrimaryTrucks date={date} />}
      {tab === 'rlmptl' && <RlmPtlTab date={date} />}
      {tab === 'seccfa' && <RlmSecondCfaTab date={date} />}
    </Box>
  );
}
