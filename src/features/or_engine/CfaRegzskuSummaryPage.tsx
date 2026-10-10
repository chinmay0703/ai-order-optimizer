import { useEffect, useMemo, useState } from 'react';
import { Box, Dialog, IconButton, Table, TableBody, TableCell, TableHead, TableRow, TableSortLabel } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import CloseIcon from '@mui/icons-material/Close';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { downloadXlsx } from '../../shared/exportXlsx';
import { isTracked, trackedSxFor, TRACK_STAR } from '../../demo';
import { Stat, SplitBar } from '../../shared/StatCards';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';
import CfaStockLedgerPage from '../reservations/CfaStockLedgerPage';

/* ---------------------------------------------------------------------------
   CFA × Reg-ZSKU — the FINAL SO-created roll-up the functional team checks first.
   Per (CFA, reg-zsku): combined CFA Total Inventory, combined SOQ (demand, from
   filtered_soq), and AOQ = the final allocated qty that went for SO CREATION across
   ALL DBs (Original + Substitute + Filler). AOQ comes from the same builder as the
   Final Order, so it can never drift from the final-level numbers; it reads the live
   allocation_final + so_flag, so the RLM 15:30 rollup (approved / 2nd-CFA-rejected →
   SO_CREATION) is picked up automatically. Live from /api/v1/cfa_regzsku_summary.
--------------------------------------------------------------------------- */
interface Row {
  cfa: string; reg_zsku: string; total_inventory: number; soq: number;
  original: number; as_substitute: number; as_filler: number; aoq: number; aoq_pct_soq: number | null;
}
interface Recon { reserved_total: number; reserved_on_page: number; reserved_offpage: number; }
interface Payload { date?: string; rows: Row[]; reservation?: Recon; reservation_by_cfa?: Record<string, Recon>; totals: { lanes: number; soq: number; aoq: number; inventory: number }; }

type Kind = 'mono' | 'desc' | 'num' | 'numStrong' | 'numGreen' | 'numAmber' | 'pct';
interface Col { h: string; kind: Kind; get: (r: Row) => string | number | null; }
const NUMERIC: Kind[] = ['num', 'numStrong', 'numGreen', 'numAmber', 'pct'];
const COLS: Col[] = [
  { h: 'CFA', kind: 'mono', get: (r) => r.cfa },
  { h: 'Reg-ZSKU', kind: 'mono', get: (r) => r.reg_zsku },
  { h: 'Description', kind: 'desc', get: (r) => r.reg_zsku },
  { h: 'Total Inventory', kind: 'num', get: (r) => r.total_inventory },
  { h: 'SOQ (demand)', kind: 'num', get: (r) => r.soq },
  { h: 'Original', kind: 'num', get: (r) => r.original },
  { h: 'As Substitute', kind: 'numGreen', get: (r) => r.as_substitute },
  { h: 'As Filler', kind: 'numAmber', get: (r) => r.as_filler },
  { h: 'AOQ (SO created)', kind: 'numStrong', get: (r) => r.aoq },
  { h: 'AOQ % of SOQ', kind: 'pct', get: (r) => r.aoq_pct_soq },
];

const nf = (n: unknown) => (Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString() : '');
const num = { textAlign: 'right' as const, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' as const, fontSize: 12.5 };

const Shell = ({ title, help, children }: { title: string; help?: React.ReactNode; children: React.ReactNode }) => (
  <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
    <Box sx={{ maxWidth: 1360, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
      <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>
        Post-allocation · CFA × Reg-ZSKU
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, m: '6px 0 8px' }}>
        <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: 0 }}>
          {title}
        </Box>
        {help}
      </Box>
      {children}
    </Box>
  </Box>
);

export default function CfaRegzskuSummaryPage({ date, cfa = '' }: { date?: string; cfa?: string }) {
  // CFA scope comes from the GLOBAL run-context header (not a per-page picker) — keeps every page consistent.
  const descOf = useRegZskuDesc();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from data===null: an empty payload,
  const [err, setErr] = useState<string | null>(null);   // or a failure, would then spin forever
  const [nonce, setNonce] = useState(0);            // bumped by the error Retry to re-run the effect
  const [q, setQ] = useState('');
  const [sortCol, setSortCol] = useState<number>(-1);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [tab, setTab] = useState<'summary' | 'ledger'>('summary');   // ① CFA × Reg-ZSKU · ② CFA Stock Ledger
  const [helpOpen, setHelpOpen] = useState(false);                   // the "how it works" help modal (was the big intro block)

  useEffect(() => {
    let alive = true; setData(null); setErr(null); setLoading(true);
    api.cfaRegzskuSummary(date).then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, nonce]);

  const all = data?.rows ?? [];
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => all.filter((r) =>
    (!cfa || r.cfa === cfa) && (!needle || `${r.cfa} ${r.reg_zsku}`.toLowerCase().includes(needle))),
  [all, cfa, needle]);

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
  }, [filtered, sortCol, sortDir]);
  const clickSort = (ci: number) => {
    if (sortCol === ci) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(ci); setSortDir('asc'); }
  };

  // KPIs reflect the current CFA filter
  const kpi = useMemo(() => ({
    lanes: filtered.length,
    inv: filtered.reduce((s, r) => s + r.total_inventory, 0),
    soq: filtered.reduce((s, r) => s + r.soq, 0),
    aoq: filtered.reduce((s, r) => s + r.aoq, 0),
  }), [filtered]);

  // ① CFA × Reg-ZSKU roll-up · ② CFA Stock Ledger (folded in — no separate sidebar page). The ledger tab is
  // self-contained (its own fetch), so it renders regardless of this page's data state.
  const SUMMARY_TITLE = 'CFA × Reg-ZSKU — Inventory · SOQ · AOQ';
  const tabBar = (
    <Box sx={{ display: 'flex', gap: 0.5, mb: 2.5, borderBottom: `1px solid ${C.rule}`, flexWrap: 'wrap' }}>
      {([['summary', 'CFA × Reg-ZSKU · Inventory · SOQ · AOQ'], ['ledger', 'CFA Stock Ledger']] as const).map(([k, label]) => (
        <Box key={k} onClick={() => setTab(k)}
          sx={{ cursor: 'pointer', px: 1.75, py: 1, fontSize: 13, fontWeight: 800, color: tab === k ? C.navy : C.muted,
            borderBottom: `2px solid ${tab === k ? C.gold : 'transparent'}`, mb: '-1px', '&:hover': { color: C.navy } }}>{label}</Box>
      ))}
    </Box>
  );
  if (tab === 'ledger') return <Shell title="CFA Stock Ledger — end-to-end flow per reg-zsku">{tabBar}<CfaStockLedgerPage date={date} embedded /></Shell>;
  if (err) return <Shell title={SUMMARY_TITLE}>{tabBar}<ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (loading) return <Shell title={SUMMARY_TITLE}>{tabBar}<PageSkeleton kpis={4} rows={9} /></Shell>;
  if (!data) return <Shell title={SUMMARY_TITLE}>{tabBar}<EmptyState title="No roll-up for this run"
    hint="Nothing was returned for this run date. Try another run date, or run the pipeline first." /></Shell>;
  // Loaded, but the run produced no reg-zsku lanes at all — an empty payload, not a filtered view (the table keeps
  // its own "No lanes match." message for when the CFA / search filter empties it).
  if (all.length === 0) return <Shell title={SUMMARY_TITLE}>{tabBar}<EmptyState title="No CFA × Reg-ZSKU lanes in this run"
    hint="The engine allocated nothing for this run date, so there is no roll-up to show. Try another run date, or run the pipeline first." /></Shell>;

  const Kpi = ({ label, val, suffix, fg, bar }: { label: string; val: string; suffix?: string; fg: string; bar: string }) => (
    <Box sx={{ flex: 1, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${bar}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, p: 1.5, bgcolor: C.white }}>
      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted }}>{label}</Box>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 25, color: fg, lineHeight: 1.1 }}>{val}{suffix}</Box>
    </Box>
  );

  const renderCell = (col: Col, r: Row) => {
    const v = col.get(r);
    switch (col.kind) {
      case 'mono': return <TableCell key={col.h} sx={{ fontFamily: MONO, fontSize: 12.5, whiteSpace: 'nowrap' }}>{v}</TableCell>;
      case 'desc': { const d = descOf(v as string); return <TableCell key={col.h} sx={{ whiteSpace: 'normal', fontSize: 12.5 }} title={d}>{d || '—'}</TableCell>; }
      case 'num': return <TableCell key={col.h} sx={num}>{nf(v)}</TableCell>;
      case 'numStrong': return <TableCell key={col.h} sx={{ ...num, fontWeight: 800, color: C.navy }}>{nf(v)}</TableCell>;
      case 'numGreen': return <TableCell key={col.h} sx={{ ...num, color: (v as number) > 0 ? C.success : C.muted }}>{nf(v)}</TableCell>;
      case 'numAmber': return <TableCell key={col.h} sx={{ ...num, color: (v as number) > 0 ? C.warnText : C.muted }}>{nf(v)}</TableCell>;
      case 'pct': {
        // STACKED AOQ%-of-SOQ bar: navy = Original, green = Substitute, gold = Filler — total = AOQ ÷ SOQ.
        // AOQ = Original + Substitute + Filler exactly, so the three segments always sum to the bar total; when the
        // total exceeds 100% (filler pushes AOQ past SOQ) all three are scaled to fit the track, keeping proportions.
        const p = v as number | null;
        if (p == null || r.soq <= 0) return <TableCell key={col.h} sx={num}><span style={{ color: C.grey700 }}>—</span></TableCell>;
        const oPct = (100 * r.original) / r.soq;
        const sPct = (100 * r.as_substitute) / r.soq;
        const fPct = (100 * r.as_filler) / r.soq;
        const total = oPct + sPct + fPct;
        const scale = total > 100 ? 100 / total : 1;                 // clip to the track, preserving each source's share
        const [oW, sW, fW] = [oPct * scale, sPct * scale, fPct * scale];
        const over = p >= 100;
        return (
          <TableCell key={col.h} sx={{ ...num, width: 170 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, justifyContent: 'flex-end' }}>
              <Box sx={{ position: 'relative', width: 78, height: 8, borderRadius: 999, bgcolor: C.grayP, overflow: 'hidden', flexShrink: 0 }}
                title={`Original ${oPct.toFixed(1)}%  +  Substitute ${sPct.toFixed(1)}%  +  Filler ${fPct.toFixed(1)}%  =  ${p.toFixed(1)}% of SOQ`}>
                <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${oW}%`, bgcolor: C.navy }} />
                <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: `${oW}%`, width: `${sW}%`, bgcolor: C.success }} />
                <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: `${oW + sW}%`, width: `${fW}%`, bgcolor: C.warnText }} />
              </Box>
              <Box component="span" sx={{ minWidth: 44, fontWeight: 700, color: over ? C.warnText : C.slate }}>{p.toFixed(1)}%</Box>
            </Box>
          </TableCell>);
      }
      default: return <TableCell key={col.h}>{v}</TableCell>;
    }
  };

  // reservation reconciliation — tie THESE lanes to the reserved-stock universe (142) shown on the CFA Stock
  // Reservation & pre-processing pages; scoped by the CFA filter so it agrees with the KPIs. reserved_on_page also
  // equals the lanes that have CFA stock; the reserved_offpage donors are never demanded/shipped so have no lane here.
  const scoped = cfa ? all.filter((r) => r.cfa === cfa) : all;
  const recon = (cfa ? data.reservation_by_cfa?.[cfa] : data.reservation) ?? { reserved_total: 0, reserved_on_page: 0, reserved_offpage: 0 };
  const nDemand = scoped.filter((r) => r.soq > 0).length;
  const nNoStock = scoped.filter((r) => r.total_inventory === 0).length;
  const nRed = scoped.filter((r) => r.total_inventory < r.soq).length;

  const helpAdornment = (
    <>
      <IconButton size="small" onClick={() => setHelpOpen(true)} title="How this page works"
        sx={{ color: C.gold, border: `1px solid ${C.goldLight}`, bgcolor: '#FFF5ED', '&:hover': { bgcolor: '#FFE8D4', borderColor: C.gold } }}>
        <HelpOutlineIcon sx={{ fontSize: 19 }} />
      </IconButton>
      <Box component="span" sx={{ fontSize: 11.5, color: C.muted }}>how it works</Box>
    </>
  );

  return (
    <Shell title={SUMMARY_TITLE} help={helpAdornment}>
      {tabBar}
      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: `${RADIUS.md}px`, overflow: 'hidden', border: `1px solid ${C.goldLight}` } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2.5, py: 1.5, background: 'linear-gradient(135deg, #FE7C39 0%, #C52B09 55%, #C52B09 100%)', borderBottom: '1px solid rgba(0,0,0,0.10)', color: '#fff' }}>
          <HelpOutlineIcon sx={{ fontSize: 20 }} />
          <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 17 }}>How this page works</Box>
          <Box sx={{ flex: 1 }} />
          <IconButton onClick={() => setHelpOpen(false)} size="small" aria-label="close" sx={{ color: '#fff', '&:hover': { bgcolor: 'rgba(255,255,255,0.18)' } }}><CloseIcon sx={{ fontSize: 20 }} /></IconButton>
        </Box>
        <Box sx={{ p: 2.75, color: C.slate, bgcolor: '#FFF5ED', display: 'flex', flexDirection: 'column', gap: 2.75 }}>
          {/* the goal */}
          <Box sx={{ p: '10px 12px', borderRadius: `${RADIUS.sm}px`, bgcolor: '#FFF5ED', border: `1px solid ${C.goldLight}`, borderLeft: `3px solid ${C.gold}` }}>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.gold, mb: 0.4 }}>🎯 The goal</Box>
            <Box sx={{ fontSize: 13, lineHeight: 1.55 }}>One row per <b>CFA × Reg-ZSKU</b> — the SO-created roll-up you check first: how much of each reg-zsku's demand actually went for <b>SO creation</b> across all DBs.</Box>
          </Box>

          {/* each row = 3 reads */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.7 }}>What each row shows</Box>
            {([
              ['Total Inventory', <>the combined CFA <b>stock</b> of that reg-zsku</>, C.navy],
              ['SOQ', <>the combined <b>demand</b>, from filtered SOQ</>, C.slate],
              ['AOQ', <>the final allocated qty that went for <b>SO creation</b> across all DBs</>, C.success],
            ] as const).map(([t, d, col], i, arr) => (
              <Box key={t} sx={{ display: 'flex', gap: 1, mb: i < arr.length - 1 ? 1 : 0 }}>
                <Box sx={{ flexShrink: 0, width: 8, height: 8, borderRadius: '50%', bgcolor: col, mt: 0.65 }} />
                <Box sx={{ fontSize: 12.5, lineHeight: 1.5 }}><b style={{ color: col }}>{t}</b> — {d}</Box>
              </Box>
            ))}
          </Box>

          {/* AOQ = three sources */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.5 }}>AOQ = three sources</Box>
            <Box sx={{ p: '9px 11px', mb: 0.85, borderRadius: `${RADIUS.sm}px`, bgcolor: '#fff', border: `1px solid ${C.rule}` }}>
              <Box sx={{ fontFamily: MONO, fontSize: 12.5, color: C.slate }}>AOQ = <b style={{ color: C.navy }}>Original</b> + <b style={{ color: C.success }}>Substitute</b> + <b style={{ color: C.warnText }}>Filler</b></Box>
            </Box>
            <Box sx={{ fontSize: 12.5, lineHeight: 1.55, mb: 0.6 }}>The <b>AOQ % of SOQ</b> bar is split by these three — hover it for the exact split:</Box>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {([['navy · Original', C.navy], ['green · Substitute', C.success], ['gold · Filler', C.warnText]] as const).map(([lab, col]) => (
                <Box key={lab} component="span" sx={{ px: 0.85, py: '3px', borderRadius: 999, border: `1px solid ${col}`, color: col, fontSize: 11, fontWeight: 700 }}>{lab}</Box>
              ))}
            </Box>
          </Box>

          {/* live / exact caveat */}
          <Box sx={{ pt: 1, borderTop: `1px solid ${C.rule}`, fontSize: 11, color: C.muted, lineHeight: 1.5 }}>AOQ is the same final-level number as the <b>Final Order</b> — post truck-trim &amp; cluster primary-truck trim — and reads the live tables, so the <b>RLM 15:30 rollup</b> (approved / 2nd-CFA-rejected → SO created) is picked up automatically.</Box>
        </Box>
      </Dialog>

      <Box sx={{ display: 'flex', gap: 1.5, mb: 2 }}>
        <Kpi label="Reg-ZSKU lanes" val={nf(kpi.lanes)} fg={C.navy} bar={C.navy} />
        <Kpi label="Σ Total Inventory" val={nf(kpi.inv)} suffix=" cs" fg={C.navy} bar={C.gold} />
        <Kpi label="Σ SOQ (demand)" val={nf(kpi.soq)} suffix=" cs" fg={C.slate} bar={C.navy} />
        <Kpi label="Σ AOQ (SO created)" val={nf(kpi.aoq)} suffix=" cs" fg={C.success} bar={C.success} />
      </Box>

      <Box sx={{ display: 'flex', gap: 1, mb: 1.25, flexWrap: 'wrap', alignItems: 'center' }}>
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, px: 1.25, py: 0.5, borderRadius: `${RADIUS.sm}px`, bgcolor: C.navy, color: '#fff' }}>
          <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', opacity: 0.75 }}>CFA</span>
          <span style={{ fontSize: 13, fontWeight: 800, fontFamily: 'Consolas, monospace' }}>{cfa || '—'}</span>
        </Box>
        <Box component="span" sx={{ fontSize: 11.5, color: C.muted }}>scoped from the run-context header above</Box>
      </Box>

      <Box sx={{ display: 'flex', gap: 1.25, mb: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter — CFA or reg-zsku…"
          style={{ flex: 1, minWidth: 260, maxWidth: 420, padding: '8px 12px', fontSize: 13, fontFamily: SANS, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
        <Box sx={{ flex: 1 }} />
        <Box onClick={() => downloadXlsx('cfa_regzsku_summary',
          ['CFA', 'Reg-ZSKU', 'Total Inventory', 'SOQ', 'Original', 'As Substitute', 'As Filler', 'AOQ (SO created)', 'AOQ % of SOQ'],
          rows.map((r) => [r.cfa, r.reg_zsku, r.total_inventory, r.soq, r.original, r.as_substitute, r.as_filler, r.aoq, r.aoq_pct_soq ?? '']))}
          sx={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 0.75, px: 2, py: 1, fontSize: 13, fontWeight: 800, color: '#fff', background: C.navy, borderRadius: RADIUS.sm, boxShadow: SHADOW.sm }}>
          <DownloadIcon sx={{ fontSize: 17 }} /> Download Excel
        </Box>
      </Box>
      {/* reconciliation — stat cards + a composition bar, not a wall of text */}
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'stretch', mb: 1.5 }}>
        <Stat label="Reserved on page" value={recon.reserved_on_page} sub={`of ${nf(recon.reserved_total)} reserved`} tone={C.success} strong />
        <Stat label="Demanded" value={nDemand} sub="live SOQ > 0" tone={C.navy} />
        <Stat label="No CFA stock" value={nNoStock} sub="0 inventory" tone={C.gold} />
        <Stat label="Short (red)" value={nRed} sub="inventory < SOQ" tone={nRed > 0 ? C.alertRed : C.muted} />
      </Box>
      <Box sx={{ mb: 1.75, maxWidth: 780 }}>
        <Box sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted, mb: 0.6 }}>
          Lane composition · {nf(scoped.length)} lanes{cfa ? ` · CFA ${cfa}` : ''}{q ? ` · ${nf(rows.length)} match “${q}”` : ''}
        </Box>
        <SplitBar segments={[
          { label: 'Demanded (SOQ>0)', value: nDemand, color: C.navy },
          { label: 'Feed · 0 SOQ', value: Math.max(0, scoped.length - nDemand), color: C.gold },
        ]} />
        <Box sx={{ fontSize: 11.5, color: C.muted, mt: 0.75 }}>
          <b style={{ color: C.success }}>{nf(recon.reserved_on_page)} reserved on page</b> = the same “reserved” figure as the CFA Stock Reservation &amp; pre-processing pages; {nf(recon.reserved_offpage)} donor lanes have no row here · <Box component="span" sx={{ px: 0.55, py: 0.1, bgcolor: C.redP, color: C.alertRed, fontWeight: 700, borderRadius: `${RADIUS.sm}px` }}>red rows</Box> = inventory below SOQ · click a header to sort.
        </Box>
      </Box>

      <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'auto', maxHeight: '70vh' }}>
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
            {rows.map((r, i) => {
              const short = r.total_inventory < r.soq;   // CFA stock of this reg-zsku can't cover the SOQ demand → red-pastel row
              const unmet = r.soq > 0 && r.aoq === 0;    // demanded but nothing SO-created
              return (
                // short (inventory < demand) wins the row colour over the unmet/tracked states
                <TableRow key={i} hover sx={{ bgcolor: unmet ? '#F5F7F8' : undefined, ...trackedSxFor(r.reg_zsku), ...(short ? { bgcolor: C.redP } : {}) }}>
                  {COLS.map((c) => renderCell(c, r))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.rule}`, mt: 3, pt: 1, fontSize: 9, color: C.muted }}>
        <span>AI Order Optimizer · CFA × Reg-ZSKU SO-created roll-up · AOQ = Original + Substitute + Filler (same as Final Order, post all trims)</span>
        <span>CFA × Reg-ZSKU · {data.date ?? ''}</span>
      </Box>
    </Shell>
  );
}
