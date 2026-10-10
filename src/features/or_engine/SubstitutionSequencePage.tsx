import { useEffect, useMemo, useState } from 'react';
import {
  Accordion, AccordionSummary, AccordionDetails, Box, Chip,
  Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { downloadXlsx, ExportXlsxButton } from '../../shared/exportXlsx';
import { isTracked, trackedSxFor, TRACK_STAR } from '../../demo';
import TruckFillPanel from './TruckFillPanel';
import PageIntro from '../../shared/PageIntro';
import { OE_DEFAULTS } from '../../shared/OeParams';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';
import { isUncappedRoom, NO_CAP_LABEL, NO_CAP_TIP } from '../../shared/roomCap';
import { useBrandCategory } from '../../shared/BrandCategory';
import { useDistributorName } from '../../shared/DistributorName';

/* ---------------------------------------------------------------------------
   Substitution Sequence — Step 2, in the EXACT order the engine ran it.
   Every (db × reg-zsku) line that had leftover demand after Step 1 is sorted by
   New score DESC and filled top to bottom; this page lists that order, #1 → #N,
   with each line's substitute outcome and the eligible-substitute detail.
   Reads /api/waterfill (or_waterfill_steps + or_sub_eligibility). Current
   Drilldown page is unchanged — this is a separate, sequence-first view.
--------------------------------------------------------------------------- */
type Row = (string | number)[];
interface Elig { sub: string; rank: number; pool: number; poolAfter: number; room: number; alloc: number; reason: string; norm: number; soh: number; ownOrig: number; }
interface Payload { cols?: string[]; rows: Row[]; runs?: { run: number; channel: string }[]; eligRows?: Row[]; subMrp?: Record<string, number | string>; resMrp?: Record<string, number | string>; norm_multiplier?: number; addon_cap_pct?: number; }
// or_waterfill_steps columns read BY NAME from payload.cols (the backend contract changes over time — never by position)
const COL = { run: 'run_no', cfa: 'cfa_id', step: 'step', db: 'db_id', z: 'reg_zsku', src: 'source_zsku', tier: 'db_tier',
  soq: 'soq_remaining', score: 'score', alloc: 'allocated', newScore: 'new_score' } as const;
const colIx = (cols: string[] = []) =>
  Object.fromEntries(Object.entries(COL).map(([k, n]) => [k, cols.indexOf(n)])) as Record<keyof typeof COL, number>;
// or_sub_eligibility: Run_No, CFA, DB, reg-zsku, Sub_ZSKU, Rank, Stock_Before(CFA pool), Headroom(1.2×Norm room),
// Allocated, Stock_After, Reason, Norm, Sub_Stock(SOH), Sub_Orig(the sub's own Step-1 original held by this DB).
const EI = { run: 0, cfa: 1, db: 2, z: 3, sub: 4, rank: 5, before: 6, room: 7, alloc: 8, after: 9, reason: 10, norm: 11, soh: 12, sorig: 13 };

interface Line {
  db: string; z: string; tier: number; newScore: number; mrp: number | null;
  orig: number; soq: number; newSOQ: number;
  sub: number; subPairs: [string, number][]; elig: Elig[];
}
const mono = { fontFamily: MONO, fontVariantNumeric: 'tabular-nums' as const };
const numCell = { textAlign: 'right' as const, ...mono, fontSize: 12.5 };

export default function SubstitutionSequencePage({ date, cfa = '' }: { date?: string; cfa?: string }) {
  // CFA is scoped GLOBALLY from the run-context header (Step 2 runs CFA-wise) — no per-page CFA picker.
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);           // NEVER infer "in flight" from data===null: an empty
  const [err, setErr] = useState<string | null>(null);    // payload, or a failure, would then spin forever.
                                                          // Starts TRUE: the fetch below is unconditional on mount, so
                                                          // the first paint must be the skeleton, never a false "no data".
  const [nonce, setNonce] = useState(0);                  // bumped by the error Retry to re-run the effect
  const [run, setRun] = useState(1);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');   // free-text filter over the rendered sequence (reg-zsku / DB / tier / substitute)
  const [tab, setTab] = useState<'seq' | 'truck'>('seq');   // ① substitution sequence · ② Step-2 truck fill (CFA×DB)
  const descOf = useRegZskuDesc();
  const categoryOf = useBrandCategory();   // reg-zsku → brand category (the new substitution dimension)
  const dbNameOf = useDistributorName();   // DB code -> Customer Name (served off db_master via /distributor_names)

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null); setLoading(true);
    api.waterfill(0, date).then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, on an EMPTY payload AND on failure
    return () => { alive = false; };
  }, [date, nonce]);

  const seq: Line[] = useMemo(() => {
    if (!data) return [];
    const I = colIx(data.cols);
    const rows = (data.rows ?? []).filter((r) => r[I.run] === run && String(r[I.cfa]) === cfa);
    const smrp = data.subMrp ?? {};   // (CFA | DB | reg-zsku) → MRP the substitute set was drawn from (CFA×DB×MRP-wise)
    const rmrp = data.resMrp ?? {};   // (CFA | reg-zsku) → the reg-zsku's OWN MRP from cfa_reservation (always present)
    const map = new Map<string, Line>();
    for (const r of rows) {                                  // Step 1 → the candidate lines + their New score
      if (r[I.step] !== 1) continue;
      const z = r[I.z] as string; const db = r[I.db] as string;
      const orig = r[I.alloc] as number; const soq = r[I.soq] as number;
      // prefer the reg-zsku's own reservation MRP (present for EVERY line); fall back to the substitute-pool MRP.
      const rm = rmrp[`${cfa}|${z}`]; const m = rm != null && rm !== '' ? rm : smrp[`${cfa}|${db}|${z}`];
      map.set(`${z}|${db}`, { db, z, tier: r[I.tier] as number, newScore: r[I.newScore] as number,
        mrp: m != null && m !== '' ? Number(m) : null,
        orig, soq, newSOQ: soq - orig, sub: 0, subPairs: [], elig: [] });
    }
    for (const r of rows) {                                  // Step 2 → substitutes actually allocated to each line
      if (r[I.step] !== 2) continue;
      const l = map.get(`${r[I.z]}|${r[I.db]}`);
      if (l) { l.sub += r[I.alloc] as number; if (r[I.src]) l.subPairs.push([r[I.src] as string, r[I.alloc] as number]); }
    }
    for (const e of data.eligRows ?? []) {                   // the eligible substitutes considered per line
      if (e[EI.run] !== run || String(e[EI.cfa]) !== cfa) continue;
      const l = map.get(`${e[EI.z]}|${e[EI.db]}`);
      if (l) {
        const norm = e[EI.norm] as number;
        // SOH = the DB's PHYSICAL on-hand for the substitute, straight from the backend (or_sub_eligibility.sub_stock,
        // sourced from db_inventory) — this is the exact stock the engine's 1.2×Norm cap uses, so 1.2×Norm − SOH −
        // Step-1 own reconciles to the room. Do NOT recompute Norm − SOQ on the client: that implied on-hand diverges
        // from real stock whenever db_inventory is refreshed independently of the SOQ.
        const soh = e[EI.soh] as number;
        l.elig.push({ sub: e[EI.sub] as string, rank: e[EI.rank] as number, pool: e[EI.before] as number,
          poolAfter: e[EI.after] as number, room: e[EI.room] as number, alloc: e[EI.alloc] as number,
          reason: e[EI.reason] as string, norm, soh, ownOrig: e[EI.sorig] as number });
      }
    }
    map.forEach((l) => l.elig.sort((a, b) => a.rank - b.rank));
    // the SEQUENCE: EVERY line with leftover demand after Step 1, highest New score first — including one that got
    // NOTHING in Step 1 (orig === 0). Those lines DO enter step 2 (or_engine.calc.step2 gates on open SOQ alone), so
    // filtering them out here hid real substitution work from this page. Mirrors the engine exactly.
    return [...map.values()].filter((l) => l.newSOQ > 0).sort((a, b) => b.newScore - a.newScore);
  }, [data, run, cfa]);

  const runs = data?.runs?.length ? [...new Map(data.runs.map((r) => [r.run, r.channel])).entries()] : [[1, ''], [2, '']] as [number, string][];
  // free-text filter — keep the ORIGINAL sequence index i so each surviving row keeps its true #N rank
  const visible = useMemo(() => {
    // EVERY whitespace-separated token must match (AND), so "0000121568 66099" finds that DB *and* that reg-zsku
    // on one line — a single-substring match could never satisfy both. Reg-zsku description and distributor NAME are
    // in the haystack too, so searching either a code or a name works.
    const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return seq.map((l, i) => ({ l, i })).filter(({ l }) => {
      if (!tokens.length) return true;
      const hay = `${l.z} ${descOf(l.z)} ${l.db} ${dbNameOf(l.db)} T${l.tier} ${l.mrp != null ? 'mrp ₹' + l.mrp : ''} ${l.subPairs.map(([s]) => s).join(' ')} ${l.elig.map((e) => e.sub).join(' ')}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [seq, q, descOf, dbNameOf]);
  const vis = visible.map((x) => x.l);
  const totFilled = vis.filter((l) => l.sub >= l.newSOQ).length;
  const totPartial = vis.filter((l) => l.sub > 0 && l.sub < l.newSOQ).length;
  const totNone = vis.filter((l) => l.sub === 0).length;

  const wrapSx = { p: { xs: 2, md: 3 }, maxWidth: 1240, mx: 'auto' };
  // ① Substitution sequence (card view)  ·  ② Step-2 Truck Fill (CFA × DB) — the lane view for the functional team,
  // the same shape as the water-fill page's Step-1 tab but with the Step-2 substitute added. Tab ② is self-contained
  // (its own fetch), so it renders regardless of the sequence payload's load/error state. `header` is JSX (not an
  // inline component) so reusing it across returns never remounts the search box.
  const header = (
    <>
      <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: '#000', bgcolor: '#FFAA72', display: 'inline-block', px: 1, py: '3px', borderRadius: '2px' }}>Step 2 · Substitution</Box>
      <Typography sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 26, color: C.navy, mt: 0.3 }}>
        {tab === 'truck' ? 'Step-2 Truck Fill — CFA × DB' : 'Substitution Sequence'}
      </Typography>
      <Box sx={{ display: 'flex', gap: 0.5, mt: 1, mb: 2, borderBottom: `1px solid ${C.rule}` }}>
        {([['seq', '① Substitution sequence'], ['truck', '② Step-2 Truck Fill · CFA × DB']] as const).map(([k, label]) => (
          <Box key={k} onClick={() => setTab(k)}
            sx={{ cursor: 'pointer', px: 1.75, py: 1, fontSize: 13, fontWeight: 800, color: tab === k ? C.navy : C.muted,
              borderBottom: `2px solid ${tab === k ? C.gold : 'transparent'}`, mb: '-1px', '&:hover': { color: C.navy } }}>{label}</Box>
        ))}
      </Box>
    </>
  );
  if (tab === 'truck') return <Box sx={wrapSx}>{header}<TruckFillPanel mode="step2" date={date} /></Box>;
  if (err) return <Box sx={wrapSx}>{header}<ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Box>;
  if (loading) return <Box sx={wrapSx}>{header}<PageSkeleton kpis={0} rows={8} /></Box>;
  if (!cfa) return <Box sx={wrapSx}>{header}<EmptyState title="Pick a CFA to continue"
    hint="Step 2 runs CFA-wise, so this sequence is scoped to one CFA. Choose one in the run-context bar above." /></Box>;
  if (!data) return <Box sx={wrapSx}>{header}<EmptyState title="No substitution data for this run"
    hint="Nothing was returned for this run date. Try another run date, or run the pipeline first." /></Box>;

  const mult = data.norm_multiplier ?? OE_DEFAULTS.NORM_MULTIPLIER;   // LIVE cap multiplier from the backend (oe_parameters); fallback = shared default
  const addonP = Math.round((data.addon_cap_pct ?? OE_DEFAULTS.ADDON_CAP_PCT) * 100);   // LIVE add-on cap % (never hardcode 35)
  const status = (l: Line) => l.sub >= l.newSOQ
    ? { label: 'Filled', bg: '#A8E3BD', fg: '#000', dashed: false }
    : l.sub > 0 ? { label: 'Partial', bg: '#FFE3A1', fg: '#000', dashed: false }
      // sub === 0 splits two ways: a line with NO eligible rank in the substitution master at all
      // (l.elig.length === 0 — the same signal the detail table shows as "No substitute rules for this
      // line") vs one that had rules but got nothing allocated. Flag the first distinctly so you can
      // tell "there is simply no substitute defined" apart from "a substitute existed but lost" without
      // expanding the row.
      : l.elig.length === 0 ? { label: 'No Sub in Master', bg: C.grayP, fg: C.muted, dashed: true }
        : { label: 'None', bg: C.grayP, fg: C.muted, dashed: false };

  return (
    <Box sx={wrapSx}>
      {header}
      <PageIntro>
        The exact order the engine runs Step 2: every <b>(db × reg-zsku)</b> line with leftover demand after Step 1 is sorted by
        <b> New score descending</b> and its substitutes are filled <b>top to bottom</b>. <b>New score = Tier ÷ [(Stock + Original) ÷ Norm]</b>.
        When the same substitute is contested, the line higher in this list takes it first.
      </PageIntro>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2, mb: 1, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, px: 1.25, py: 0.5, borderRadius: `${RADIUS.sm}px`, bgcolor: C.navy, color: '#fff' }}>
          <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', opacity: 0.75 }}>CFA</span>
          <span style={{ fontSize: 13, fontWeight: 800, fontFamily: 'Consolas, monospace' }}>{cfa || '—'}</span>
        </Box>
        <Box component="span" sx={{ fontSize: 11.5, color: C.muted }}>allocation is CFA-wise — pick the CFA in the run-context header above</Box>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 0.5, mb: 1.5, flexWrap: 'wrap' }}>
        {runs.map(([k, ch]) => (
          <Box key={k} onClick={() => setRun(k)} sx={{ cursor: 'pointer', px: 1.5, py: 0.6, borderRadius: `${RADIUS.sm}px`,
            border: `1px solid ${run === k ? C.navy : C.rule}`, bgcolor: run === k ? C.navy : '#fff', color: run === k ? '#fff' : C.slate,
            fontSize: 12.5, fontWeight: 600 }}>
            Run {k}{ch ? ` · ${ch}` : ''}
          </Box>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reg-zsku / DB / substitute…"
          style={{ flex: 1, minWidth: 240, padding: '8px 12px', fontSize: 14, fontFamily: MONO, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
        {q && <Box onClick={() => setQ('')} title="Clear the search field"
          sx={{ cursor: 'pointer', px: 1.5, py: 0.6, fontSize: 13, fontWeight: 700, borderRadius: `${RADIUS.sm}px`, border: `1px solid ${C.rule}`, bgcolor: '#fff', color: C.muted, '&:hover': { borderColor: C.navy, color: C.navy } }}>✕ Clear</Box>}
        <Box sx={{ fontSize: 12.5, color: C.muted }}>
          <b style={{ color: C.navy }}>{visible.length}</b>{q.trim() ? ` / ${seq.length}` : ''} lines · <b style={{ color: '#000' }}>{totFilled}</b> filled · <b style={{ color: '#000' }}>{totPartial}</b> partial · <b style={{ color: C.muted }}>{totNone}</b> none
        </Box>
        <ExportXlsxButton label="Export Excel" onClick={() => downloadXlsx('substitution_sequence',
          ['DB', 'reg-zsku', 'MRP', 'Tier', 'New score', 'Original', 'SOQ', 'New SOQ', 'Substitute'],
          seq.map((l) => [l.db, l.z, l.mrp ?? '', l.tier, l.newScore, l.orig, l.soq, l.newSOQ, l.sub]))} />
      </Box>

      {visible.map(({ l, i }) => {
        const st = status(l);
        const k = `${l.z}|${l.db}`;
        return (
          <Accordion key={k} disableGutters elevation={0} expanded={open[k] ?? false}
            onChange={(_, ex) => setOpen((p) => ({ ...p, [k]: ex }))}
            slotProps={{ transition: { unmountOnExit: true } }}
            sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px`, boxShadow: SHADOW.sm, mb: 0.6, '&:before': { display: 'none' }, ...trackedSxFor(l.db) }}>
            <AccordionSummary expandIcon={<ChevronRightIcon sx={{ fontSize: 18 }} />}
              sx={{ flexDirection: 'row-reverse', gap: 1.25, px: 2, minHeight: 0,
                '& .MuiAccordionSummary-expandIconWrapper.Mui-expanded': { transform: 'rotate(90deg)' },
                // Clean, spacious row (per the reference): IDENTITY (rank · SCORE · reg-zsku · MRP · category, SKU
                // name beneath) · DISTRIBUTOR (name + code) · FLAG · METRICS (SOQ/ORIG/OPEN/SUB, label over value).
                // Generous column gaps; the distributor has a min width so long names wrap at spaces, never mid-word.
                '& .MuiAccordionSummary-content': {
                  display: 'grid', alignItems: 'start', columnGap: { xs: 1.5, md: 3 }, my: 1, minWidth: 0,
                  gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1.5fr) minmax(150px,0.9fr) auto 210px' },
                } }}>

              {/* ── IDENTITY — rank · SCORE pill · tier · reg-zsku · MRP · category on top; SKU name beneath ── */}
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.45, minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap', minWidth: 0 }}>
                  <Box sx={{ px: 0.85, py: 0.3, borderRadius: `${RADIUS.sm}px`, bgcolor: C.grayP, ...mono, fontSize: 12, fontWeight: 800, color: C.slate, flexShrink: 0 }}>#{i + 1}</Box>
                  <Box sx={{ px: 0.9, py: 0.3, borderRadius: `${RADIUS.sm}px`, bgcolor: '#F2AB75', display: 'flex', alignItems: 'baseline', gap: 0.5, flexShrink: 0 }}
                    title="New score = Tier ÷ [(Stock + Original) ÷ Norm] — the order Step 2 fills these lines in">
                    <Box component="span" sx={{ fontSize: 9, fontWeight: 800, color: '#000', textTransform: 'uppercase', letterSpacing: '.05em', opacity: 0.75 }}>Score</Box>
                    <Box component="span" sx={{ ...mono, fontSize: 13, fontWeight: 800, color: '#000' }}>{l.newScore}</Box>
                  </Box>
                  <Chip label={`T${l.tier}`} size="small" sx={{ height: 19, fontSize: 10.5, fontWeight: 700, flexShrink: 0 }} />
                  <Box sx={{ ...mono, fontWeight: 800, color: C.navy, fontSize: 14.5, whiteSpace: 'nowrap', flexShrink: 0 }}>{l.z}</Box>
                  {l.mrp != null && (
                    <Box sx={{ ...mono, fontWeight: 700, color: C.slate, fontSize: 13, whiteSpace: 'nowrap', flexShrink: 0 }}
                      title="MRP — substitution is CFA × DB × MRP-wise">₹{l.mrp}</Box>
                  )}
                  {categoryOf(l.z) && (
                    <Box sx={{ px: 0.75, py: 0.2, borderRadius: `${RADIUS.sm}px`, bgcolor: '#A8E3BD', color: '#000', fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}
                      title="brand category — CFA × DB × MRP × brand_category">{categoryOf(l.z)}</Box>
                  )}
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.6, minWidth: 0, pl: 0.25 }}>
                  <Box component="span" sx={{ fontSize: 9, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.05em', flexShrink: 0 }}>SKU Name</Box>
                  <Box component="span" sx={{ fontSize: 12, color: C.slate, whiteSpace: 'normal', overflowWrap: 'break-word', lineHeight: 1.35, minWidth: 0 }}
                    title={descOf(l.z)}>{descOf(l.z) || '—'}</Box>
                </Box>
              </Box>

              {/* ── DISTRIBUTOR — name IN FULL (wraps at spaces, never cropped) + code ── */}
              <Box sx={{ minWidth: 0, borderLeft: { md: `1px solid ${C.rule}` }, pl: { md: 2 } }}
                title={dbNameOf(l.db) ? `${l.db} · ${dbNameOf(l.db)}` : l.db}>
                <Box sx={{ fontSize: 13.5, fontWeight: 800, color: C.navy, whiteSpace: 'normal', overflowWrap: 'break-word', lineHeight: 1.3 }}>
                  {isTracked(l.db) ? TRACK_STAR + ' ' : ''}{dbNameOf(l.db) || 'DB ' + l.db}
                </Box>
                <Box sx={{ ...mono, fontSize: 12, color: C.muted, whiteSpace: 'nowrap', mt: 0.2 }}>{l.db}</Box>
              </Box>

              {/* ── FLAG — icon + Title-case label (subtle pill) ── */}
              <Box sx={{ display: 'flex', alignItems: 'center', justifySelf: { md: 'center' } }}>
                <Box title={st.dashed ? 'No substitute rank exists in the substitution master for this DB × reg-zsku' : undefined}
                  sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.4, borderRadius: `${RADIUS.sm}px`, bgcolor: st.bg, color: st.fg,
                    border: `1px ${st.dashed ? 'dashed' : 'solid'} ${st.dashed ? C.muted : 'transparent'}`,
                    fontWeight: 700, fontSize: 11.5, whiteSpace: 'nowrap' }}>
                  {st.dashed && <Box component="span" sx={{ fontSize: 13, lineHeight: 1 }}>⊘</Box>}
                  {st.label}
                </Box>
              </Box>

              {/* ── ALLOCATION BAR — the SOQ split into Original ▸ Substitute ▸ Open as one stacked bar + legend
                     (the version you preferred). Open = the un-allocated remainder (SOQ − Original − Sub), hatched. ── */}
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0, width: '100%' }}>
                {(() => {
                  const soqN = Number(l.soq) || 0, origN = Number(l.orig) || 0, subN = Number(l.sub) || 0;
                  const openN = Math.max(0, soqN - origN - subN);
                  const denom = Math.max(1, soqN);
                  const w = (n: number) => `${Math.max(0, Math.min(100, (n / denom) * 100))}%`;
                  return (
                    <>
                      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                        <Box component="span" sx={{ fontSize: 9, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.06em' }}>SOQ demand</Box>
                        <Box component="span" sx={{ ...mono, fontSize: 14, fontWeight: 800, color: C.navy }}>{soqN}</Box>
                      </Box>
                      <Box sx={{ display: 'flex', height: 9, borderRadius: 5, overflow: 'hidden', border: `1px solid ${C.rule}`,
                        backgroundImage: `repeating-linear-gradient(45deg, ${C.grayP}, ${C.grayP} 3px, #fff 3px, #fff 5px)` }}
                        title={`Original ${origN} · Substitute ${subN} · Open ${openN}  (of SOQ ${soqN})`}>
                        <Box sx={{ width: w(origN), bgcolor: '#E8652C' }} />
                        <Box sx={{ width: w(subN), bgcolor: '#36A462' }} />
                      </Box>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1.25, rowGap: 0.25, ...mono, fontSize: 10 }}>
                        <Box component="span" sx={{ color: '#000', fontWeight: 700 }}><span style={{ color: '#E8652C' }}>●</span> Original {origN}</Box>
                        <Box component="span" sx={{ color: '#000', fontWeight: 700 }}><span style={{ color: '#36A462' }}>●</span> Sub {subN}</Box>
                        <Box component="span" sx={{ color: C.muted, fontWeight: 700 }}>○ Open {openN}</Box>
                      </Box>
                    </>
                  );
                })()}
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 1.5, pb: 1.5, pt: 0, bgcolor: '#FDFDFD' }}>
              {l.subPairs.length > 0 && (
                <Box sx={{ display: 'flex', gap: 0.6, flexWrap: 'wrap', mb: 1 }}>
                  {l.subPairs.map(([s, q], j) => (
                    <Chip key={j} size="small" label={`${s} : ${q}`} sx={{ height: 20, fontSize: 11.5, ...mono, bgcolor: '#A8E3BD', color: '#000', fontWeight: 700 }} />
                  ))}
                </Box>
              )}
              <Box sx={{ fontSize: 11.5, color: C.muted, mb: 0.5 }}>
                Eligible substitutes (master rank order) — each grant = min( New SOQ left, CFA pool, {mult}×Norm room, {addonP}% add-on ); the cap that bound it is the reason.
                {' '}<b>{mult}×Norm = floor({mult} × Norm)</b>, then <b>{mult}×Norm room = {mult}×Norm − SOH − Step‑1 own</b> (SOH = the DB's <b>physical on‑hand</b> for the substitute, from the db_inventory table — the same stock the engine's cap uses. Step‑1 own = cases the DB already holds as its OWN demand).
              </Box>
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small" sx={{ '& td, & th': { py: 0.5, px: 1.1, whiteSpace: 'nowrap' } }}>
                  <TableHead>
                    <TableRow sx={{ bgcolor: C.headBg }}>
                      {['Rank', 'Substitute', 'Description', 'CFA pool → left', 'Norm', `${mult}×Norm`, 'SOH', 'Step-1 own', `Room (${mult}×Norm − SOH − Step-1 own)`, 'Allocated', 'Limited by'].map((h, hi) => (
                        <TableCell key={h} align={hi < 3 || hi === 10 ? 'left' : 'right'}
                          sx={{ color: C.muted, fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>{h}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {l.elig.length === 0 && <TableRow><TableCell colSpan={11} sx={{ color: C.muted, fontSize: 12 }}>No substitute rules for this line.</TableCell></TableRow>}
                    {l.elig.map((e, j) => (
                      <TableRow key={j} hover sx={{ bgcolor: e.alloc > 0 ? C.successLight : undefined }}>
                        <TableCell sx={mono}>{e.rank}</TableCell>
                        <TableCell sx={{ ...mono, fontWeight: 600, color: C.navy }}>{e.sub}</TableCell>
                        <TableCell sx={{ fontSize: 12, color: C.muted, whiteSpace: 'normal' }} title={descOf(e.sub)}>{descOf(e.sub) || '—'}</TableCell>
                        <TableCell sx={numCell} title="Shared CFA pool for this substitute, RUNNING top-to-bottom: what it saw when this line ran → what's left for the next line that wants it">{e.pool}<Box component="span" sx={{ color: '#5C616A', ml: 0.4 }}>→ {e.poolAfter}</Box></TableCell>
                        <TableCell sx={numCell} title="Norm of this substitute zsku at the DB">{e.norm}</TableCell>
                        <TableCell sx={{ ...numCell, color: isUncappedRoom(e.room) ? C.success : C.warnText, fontWeight: 700 }} title={isUncappedRoom(e.room) ? NO_CAP_TIP : `floor(${mult} × Norm ${e.norm}) = ${Math.floor(mult * e.norm)}`}>{isUncappedRoom(e.room) ? NO_CAP_LABEL : Math.floor(mult * e.norm)}</TableCell>
                        <TableCell sx={numCell} title={`SOH — the DB's physical on-hand for this substitute (from db_inventory), exactly as the ${mult}×Norm cap uses it`}>{e.soh}</TableCell>
                        <TableCell sx={numCell} title="Step-1 own — cases of this substitute the DB already holds as its OWN Step-1 demand">{e.ownOrig}</TableCell>
                        <TableCell sx={{ ...numCell, ...(isUncappedRoom(e.room) ? { color: C.success, fontWeight: 700 } : {}) }} title={isUncappedRoom(e.room) ? NO_CAP_TIP : `floor(${mult} × Norm ${e.norm}) ${Math.floor(mult * e.norm)} − SOH ${e.soh} − Step-1 own ${e.ownOrig} = ${Math.floor(mult * e.norm) - e.soh - e.ownOrig}  (engine room ${e.room})`}>{isUncappedRoom(e.room) ? NO_CAP_LABEL : e.room}</TableCell>
                        <TableCell sx={{ ...numCell, fontWeight: 800, color: e.alloc > 0 ? C.success : C.muted }}>{e.alloc}</TableCell>
                        <TableCell sx={{ fontSize: 11.5, color: e.alloc > 0 ? C.success : C.muted }}>{e.reason}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            </AccordionDetails>
          </Accordion>
        );
      })}
      {visible.length === 0 && <Box sx={{ p: 4, textAlign: 'center', color: C.muted }}>{q.trim() ? `No lines match “${q}”.` : 'No substitution lines for this run.'}</Box>}
    </Box>
  );
}
