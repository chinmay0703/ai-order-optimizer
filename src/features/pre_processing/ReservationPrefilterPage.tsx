import { Fragment, useEffect, useMemo, useState } from 'react';
import { Box, Typography, Collapse, Chip, Dialog, IconButton } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import CloseIcon from '@mui/icons-material/Close';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { downloadXlsxMulti, ExportXlsxButton } from '../../shared/exportXlsx';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';
import ReservationPctDate, { type ReservationPctMeta } from '../../shared/ReservationPctDate';

/* ============================================================================
   Pre-processing — EVERYTHING that happens BEFORE the engine's Step 1.
   Five lettered stages A→B→C→D→E, then the solid-navy STEP 1 node = engine starts.
   100% live from GET /reservation/prefilter. A run selector scopes Stages C & D.
   ========================================================================== */

type Tbl = { cols: string[]; rows: (string | number)[][] };
interface Intake { pdp: number; below: number; combined: number; final: number; note?: string }
interface FSum { groups_total: number; groups_kept: number; groups_dropped: number; groups_cluster_rejected?: number; rows_kept: number; rows_total: number; dbs_kept: number }
interface Ch { channel: string; dbs: number; run: number; b1: number; b2: number; b3: number; combined: number }
interface RunSum { run: number; channel: string; dbs: number; cfa_b1: number; cfa_b2: number; cfa_b3: number; cfa_reserved: number; sub_dbs: number; sub_lines: number; sub_items: number; filler_dbs: number; filler_items: number }
interface PP extends ReservationPctMeta { soq_intake: Intake; soq_intake_by_cfa?: Record<string, Intake>; filtered_soq_summary?: FSum; filtered_soq_summary_by_cfa?: Record<string, FSum>; channels: Ch[]; channels_by_cfa?: Record<string, Ch[]>; cfas?: string[]; run_cfa?: string; db_channel_map: Tbl; cfa_reservation?: Tbl; cfa_reservation_by_cfa?: Record<string, Tbl>; substitutes?: Tbl; fillers?: Tbl; runs?: RunSum[]; runs_by_cfa?: Record<string, RunSum[]> }

const nf = (n: number) => (n ?? 0).toLocaleString();
// categorical navy-ramp so each run/channel has a stable identity hue (kept on-brand; green/gold stay semantic)
const RUN_HUES = ['#2D2D2D', '#D04A02', '#21A366', '#E0301E', '#6B6B6B', '#2D2D2D'];
const hueOf = (run: number) => RUN_HUES[(Math.max(1, run) - 1) % RUN_HUES.length];

/* ---------- small primitives ---------- */
function Kpi({ label, sub, value, tone = C.navy, strong }: { label: string; sub?: string; value: string; tone?: string; strong?: boolean }) {
  return (
    <Box sx={{ flex: 1, minWidth: 132, border: `1px solid ${strong ? tone : C.border}`, borderRadius: `${RADIUS.md}px`,
      p: 1.5, bgcolor: strong ? tone : C.white, boxShadow: SHADOW.sm }}>
      <Typography sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 30, color: strong ? '#fff' : tone, lineHeight: 1 }}>{value}</Typography>
      <Typography sx={{ fontWeight: 700, fontSize: 12, color: strong ? '#fff' : C.navy, mt: 0.4 }}>{label}</Typography>
      {sub && <Typography sx={{ fontSize: 11, color: strong ? 'rgba(255,255,255,0.85)' : C.muted }}>{sub}</Typography>}
    </Box>
  );
}

function Callout({ tone, title, children }: { tone: 'navy' | 'green' | 'amber'; title: string; children?: React.ReactNode }) {
  const T = tone === 'green' ? { bar: C.green, bg: C.greenP, fg: C.green } : tone === 'amber' ? { bar: C.gold, bg: C.amberP, fg: C.warnText } : { bar: C.navy, bg: C.navyP, fg: C.navy };
  return (
    <Box sx={{ borderLeft: `3px solid ${T.bar}`, bgcolor: T.bg, borderRadius: `0 ${RADIUS.sm}px ${RADIUS.sm}px 0`, p: '10px 14px', my: 1.25 }}>
      <Typography sx={{ fontWeight: 700, fontSize: 13, color: T.fg }}>▸ {title}</Typography>
      {children && <Typography component="div" sx={{ fontSize: 12.5, color: C.slate, mt: 0.35, lineHeight: 1.5 }}>{children}</Typography>}
    </Box>
  );
}

const th = { textAlign: 'left' as const, padding: '10px 12px', background: C.headBg, color: C.muted, fontWeight: 700, fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase' as const, borderBottom: `1px solid ${C.rule}`, whiteSpace: 'nowrap' as const, position: 'sticky' as const, top: 0 };
const td = { padding: '9px 12px', borderTop: `1px solid ${C.rowLine}`, color: C.ink, whiteSpace: 'nowrap' as const, fontSize: 12.5 };

function TableView({ data, max = 380, monoCol0, tintLast }: { data?: Tbl; max?: number; monoCol0?: boolean; tintLast?: boolean }) {
  const descOf = useRegZskuDesc();
  // index of the single-value reg-zsku column (header "reg-zsku"/"reg zsku"/"reg_zsku") — inject a Description column
  // right after it. Strictly anchored so it never matches list columns like "Substitute reg-zskus (ranked)".
  const rzIdx = (data?.cols ?? []).findIndex((h) => /^reg[\s_-]?zsku$/i.test(String(h).trim()));
  if (!data || !data.rows.length) return <Typography sx={{ fontSize: 12.5, color: C.muted, py: 1 }}>No rows.</Typography>;
  return (
    <Box sx={{ overflow: 'auto', border: `1px solid ${C.border}`, borderRadius: `${RADIUS.sm}px`, maxHeight: max }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr>{data.cols.map((h, i) => (
          <Fragment key={i}>
            <th style={{ ...th, textAlign: i >= (monoCol0 ? 1 : 0) && /^(#|Physical|Reserved|Run|MRP|Band|b1|b2)/i.test(h) ? 'right' : 'left' }}>{h}</th>
            {i === rzIdx && <th style={{ ...th, textAlign: 'left' }}>Description</th>}
          </Fragment>
        ))}</tr></thead>
        <tbody>{data.rows.map((r, i) => (
          <tr key={i} style={{ background: '#fff' }}>
            {r.map((c, ci) => {
              const num = typeof c === 'number';
              const mono = (monoCol0 && ci === 0);
              const tint = tintLast && ci === r.length - 1;
              const cell = <td key={ci} style={{ ...td, textAlign: num ? 'right' : 'left', fontVariantNumeric: 'tabular-nums',
                fontFamily: mono ? MONO : SANS, fontWeight: mono || tint ? 700 : 400,
                color: tint ? hueOf(0) : (mono ? C.navy : C.slate) }}>{c == null || c === '' ? '—' : String(c)}</td>;
              if (ci !== rzIdx) return cell;
              const desc = descOf(String(c));
              return (
                <Fragment key={ci}>
                  {cell}
                  <td style={{ ...td, whiteSpace: 'normal', color: C.slate }} title={desc}>{desc || '—'}</td>
                </Fragment>
              );
            })}
          </tr>
        ))}</tbody>
      </table>
    </Box>
  );
}

function Drawer({ label, count, children }: { label: string; count?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ mt: 1 }}>
      <Box onClick={() => setOpen((o) => !o)} sx={{ display: 'flex', alignItems: 'center', gap: 1, cursor: 'pointer', px: 1.5, py: 1,
        border: `1px solid ${C.border}`, borderRadius: `${RADIUS.sm}px`, bgcolor: open ? C.navyP : C.white, '&:hover': { bgcolor: C.navyP } }}>
        <ExpandMoreIcon sx={{ fontSize: 20, color: C.navy, transform: open ? 'rotate(0)' : 'rotate(-90deg)', transition: 'transform .15s' }} />
        <Typography sx={{ fontSize: 13, fontWeight: 700, color: C.navy, flex: 1 }}>{label}</Typography>
        {count != null && <Chip size="small" label={`${nf(count)} rows`} sx={{ bgcolor: C.grayP, color: C.muted, fontWeight: 700, height: 22 }} />}
      </Box>
      <Collapse in={open}><Box sx={{ pt: 1 }}>{children}</Box></Collapse>
    </Box>
  );
}

/* stacked horizontal split bar */
function SplitBar({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <Box>
      <Box sx={{ display: 'flex', height: 30, borderRadius: `${RADIUS.sm}px`, overflow: 'hidden', border: `1px solid ${C.border}` }}>
        {segments.filter((s) => s.value > 0).map((s, i) => (
          <Box key={i} title={`${s.label}: ${nf(s.value)}`} sx={{ width: `${(s.value / total) * 100}%`, bgcolor: s.color,
            display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 2 }}>
            <span style={{ color: '#fff', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden' }}>{(s.value / total) > 0.08 ? nf(s.value) : ''}</span>
          </Box>
        ))}
      </Box>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mt: 0.75 }}>
        {segments.map((s, i) => (
          <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: s.color }} />
            <span style={{ fontSize: 11.5, color: C.muted }}>{s.label} <b style={{ color: C.slate }}>{nf(s.value)}</b></span>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/* ---------- hero pipeline rail: A→B→C→D→E→[STEP 1] ---------- */
function Rail({ nodes, maxRun }: { nodes: { L: string; label: string; stat: string }[]; maxRun: number }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 0, flexWrap: 'wrap', rowGap: 1.5, mt: 2 }}>
      {nodes.map((n, i) => (
        <Box key={n.L} sx={{ display: 'flex', alignItems: 'center' }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5, minWidth: 96, px: 0.5 }}>
            <Box sx={{ width: 40, height: 40, borderRadius: '50%', border: `2px solid ${C.navy}`, bgcolor: C.white, color: C.navy,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SERIF, fontWeight: 700, fontSize: 19, boxShadow: SHADOW.sm }}>{n.L}</Box>
            <Typography sx={{ fontSize: 11.5, fontWeight: 700, color: C.navy, textAlign: 'center', lineHeight: 1.1 }}>{n.label}</Typography>
            <Typography sx={{ fontSize: 10.5, color: C.muted, textAlign: 'center' }}>{n.stat}</Typography>
          </Box>
          <Box sx={{ color: C.gold, fontSize: 22, fontWeight: 700, px: 0.25, alignSelf: 'flex-start', mt: 1 }}>›</Box>
        </Box>
      ))}
      {/* terminal STEP 1 node — solid navy = engine begins here (this page never enters it) */}
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5, minWidth: 118, px: 0.5 }}>
        <Box sx={{ minWidth: 40, height: 40, px: 1.5, borderRadius: `${RADIUS.md}px`, bgcolor: C.navy, color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SERIF, fontWeight: 700, fontSize: 15, boxShadow: SHADOW.md, textAlign: 'center' }}>STEP&nbsp;1</Box>
        <Typography sx={{ fontSize: 11.5, fontWeight: 700, color: C.navy, textAlign: 'center', lineHeight: 1.1 }}>Step-1 Fair Share</Typography>
        <Typography sx={{ fontSize: 10.5, color: C.muted, textAlign: 'center' }}>engine · {maxRun} runs</Typography>
      </Box>
    </Box>
  );
}

/* ---------- a lettered stage section ---------- */
function Stage({ letter, hue, eyebrow, title, purpose, children, right }: { letter: string; hue: string; eyebrow: string; title: string; purpose: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
        <Box sx={{ width: 38, height: 38, borderRadius: '50%', bgcolor: hue, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SERIF, fontWeight: 700, fontSize: 19, boxShadow: SHADOW.sm }}>{letter}</Box>
        <Box sx={{ width: 2, flex: 1, bgcolor: C.border, mt: 0.5 }} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, bgcolor: C.white, p: 2.25, mb: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>{eyebrow}</Typography>
            <Typography sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: '1.28rem', color: C.navy, lineHeight: 1.15, mt: 0.2 }}>{title}</Typography>
          </Box>
          {right && <Box sx={{ flexShrink: 0, mt: 0.2 }}>{right}</Box>}
        </Box>
        <Typography sx={{ fontSize: 13, color: C.muted, mt: 0.3, mb: 1.5 }}>{purpose}</Typography>
        {children}
      </Box>
    </Box>
  );
}

/* ============================ page ============================ */
export default function ReservationPrefilterPage({ date, cfa = '' }: { runProp?: string; tabProp?: number; date?: string; cfa?: string }) {
  // CFA scope comes from the GLOBAL run-context header (not a per-page dropdown) — keeps every page consistent.
  const [d, setD] = useState<PP | null>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from d===null: an empty payload
  const [err, setErr] = useState<string | null>(null);   // (or a failure) would otherwise spin forever
  const [nonce, setNonce] = useState(0);            // bumped by the error Retry to re-run the effect
  const [run, setRun] = useState(0);   // 0 = all runs; else the selected run number
  const [helpOpen, setHelpOpen] = useState(false);   // the "how it works" help modal (was the big intro block)

  useEffect(() => {
    let alive = true;
    setErr(null); setLoading(true);
    api.reservationPrefilter(date).then((r) => { if (alive) setD(r as PP); }).catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, nonce]);

  // the reservation-% master for the selected CFA (falls back to the flat run-CFA channels)
  const chForCfa = useMemo<Ch[]>(() => d?.channels_by_cfa?.[cfa] ?? d?.channels ?? [], [d, cfa]);

  // per-run reserved cases FOR THE SELECTED CFA (each CFA reserves its own stock) — falls back to the flat run-CFA runs
  const runs = useMemo(() => (d?.runs_by_cfa?.[cfa] ?? d?.runs ?? []).slice().sort((a, b) => a.run - b.run), [d, cfa]);
  const sel = useMemo(() => runs.find((r) => r.run === run) ?? null, [runs, run]);
  // per-reg-zsku reservation table FOR THE SELECTED CFA (falls back to the flat run-CFA table)
  const cfaResv = useMemo<Tbl | undefined>(() => d?.cfa_reservation_by_cfa?.[cfa] ?? d?.cfa_reservation, [d, cfa]);

  // CFA reservation sliced to the selected run's channel (reg-zsku, Band, Physical, reserved-for-this-channel)
  const cfaForRun = useMemo<Tbl | undefined>(() => {
    const t = cfaResv; if (!t || !sel) return undefined;
    const idx = t.cols.indexOf(sel.channel); if (idx < 0) return undefined;
    const rows = t.rows.filter((r) => Number(r[idx]) > 0).map((r) => [r[0], r[1], r[2], r[idx]]);
    return { cols: ['reg-zsku', 'Band', 'Physical', `Reserved · ${sel.channel}`], rows };
  }, [cfaResv, sel]);

  // Stage-D tables — scope to the header CFA (col 1) ALWAYS, and to the selected run (col 3) when one is picked
  const subsForRun = useMemo<Tbl | undefined>(() => {
    const t = d?.substitutes; if (!t) return undefined;
    return { cols: t.cols, rows: t.rows.filter((r) => String(r[1]) === cfa && (!sel || Number(r[3]) === run)) };
  }, [d, sel, run, cfa]);

  const filsForRun = useMemo<Tbl | undefined>(() => {
    const t = d?.fillers; if (!t) return undefined;
    return { cols: t.cols, rows: t.rows.filter((r) => String(r[1]) === cfa && (!sel || Number(r[3]) === run)) };
  }, [d, sel, run, cfa]);

  // Stage-B channel-classification ledger — scope to the header CFA (col 1 = CFA)
  const dbChanForCfa = useMemo<Tbl | undefined>(() => {
    const t = d?.db_channel_map; if (!t) return undefined;
    return { cols: t.cols, rows: t.rows.filter((r) => String(r[1]) === cfa) };
  }, [d, cfa]);

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <Box sx={{ p: { xs: 1.5, sm: 2.5, md: 4 }, maxWidth: 1180, mx: 'auto', fontFamily: SANS }}>
      {/* the CFA chip is flexShrink:0, so side-by-side it squeezed the title to one word per line on a phone */}
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'flex-start' }, gap: { xs: 1.25, sm: 2 } }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>Pre-processing · before the engine runs</Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: { xs: 22, sm: 26, md: 30 }, mb: 0.5, lineHeight: 1.15 }}>Everything that happens before Step&nbsp;1</Typography>
            <IconButton size="small" onClick={() => setHelpOpen(true)} title="How this page works"
              sx={{ color: C.gold, border: `1px solid ${C.goldLight}`, bgcolor: '#FCF4EE', '&:hover': { bgcolor: '#FBE8DC', borderColor: C.gold } }}>
              <HelpOutlineIcon sx={{ fontSize: 19 }} />
            </IconButton>
            <Box component="span" sx={{ fontSize: 11.5, color: C.muted }}>how it works</Box>
          </Box>
        </Box>
        {cfa && (
          <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 1, bgcolor: C.cream, border: `1px solid ${C.border}`, borderRadius: `${RADIUS.md}px`, px: 1.5, py: 0.85, boxShadow: SHADOW.sm }}>
            <Typography sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.muted }}>Viewing CFA</Typography>
            <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, px: 1.25, py: 0.5, borderRadius: `${RADIUS.sm}px`, bgcolor: C.navy, color: '#fff', fontSize: 14, fontWeight: 800, fontFamily: 'Consolas, monospace' }}>{cfa}</Box>
            <Typography sx={{ fontSize: 10.5, color: C.muted }}>scoped from the header</Typography>
          </Box>
        )}
      </Box>
      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: `${RADIUS.md}px`, overflow: 'hidden', border: `1px solid ${C.goldLight}` } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2.5, py: 1.5, background: 'linear-gradient(135deg, #EB8C00 0%, #D04A02 55%, #B33F02 100%)', borderBottom: '1px solid rgba(0,0,0,0.10)', color: '#fff' }}>
          <HelpOutlineIcon sx={{ fontSize: 20 }} />
          <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 17 }}>How this page works</Box>
          <Box sx={{ flex: 1 }} />
          <IconButton onClick={() => setHelpOpen(false)} size="small" aria-label="close" sx={{ color: '#fff', '&:hover': { bgcolor: 'rgba(255,255,255,0.18)' } }}><CloseIcon sx={{ fontSize: 20 }} /></IconButton>
        </Box>
        <Box sx={{ p: 2.75, color: C.slate, bgcolor: '#FCF7F4', display: 'flex', flexDirection: 'column', gap: 2.75 }}>
          {/* the goal */}
          <Box sx={{ p: '10px 12px', borderRadius: `${RADIUS.sm}px`, bgcolor: '#FCF4EE', border: `1px solid ${C.goldLight}`, borderLeft: `3px solid ${C.gold}` }}>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.gold, mb: 0.4 }}>🎯 The goal</Box>
            <Box sx={{ fontSize: 13, lineHeight: 1.55 }}>The CFA is the central warehouse — stock in <b>cases</b>. Before the engine can allocate it, <b>five pre-processing stages</b> turn raw demand into ready-to-allocate reserved stock.</Box>
          </Box>

          {/* the five stages */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.7 }}>The five pre-processing stages</Box>
            {([
              ['A', 'SOQ Intake', 'which distributors are in scope'],
              ['B', 'Channel Sort', 'each DB into one AIDEN channel'],
              ['C', 'Stock Reserve', 'CFA cases split per channel × MRP band'],
              ['D', 'Subs & Fillers', 'ranked substitutes + fillers pre-built'],
              ['E', 'Run Order', 'channels queued; unused stock cascades'],
            ] as const).map(([n, t, dd], i, arr) => (
              <Box key={n} sx={{ display: 'flex', gap: 1, mb: i < arr.length - 1 ? 1 : 0, alignItems: 'flex-start' }}>
                <Box sx={{ flexShrink: 0, width: 20, height: 20, borderRadius: '50%', bgcolor: C.navy, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, mt: 0.1 }}>{n}</Box>
                <Box sx={{ fontSize: 12.5, lineHeight: 1.5 }}><b style={{ color: C.navy }}>{t}</b> — {dd}</Box>
              </Box>
            ))}
          </Box>

          {/* then the engine */}
          <Box>
            <Box sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.navy, mb: 0.5 }}>Then the engine allocates · 3 steps</Box>
            <Box sx={{ p: '9px 11px', borderRadius: `${RADIUS.sm}px`, bgcolor: '#fff', border: `1px solid ${C.rule}` }}>
              <Box sx={{ fontFamily: MONO, fontSize: 12, color: C.slate }}><b style={{ color: C.navy }}>Step&nbsp;1</b> water-fill&nbsp;→&nbsp;<b style={{ color: C.navy }}>Step&nbsp;2</b> substitutes&nbsp;→&nbsp;<b style={{ color: C.navy }}>Step&nbsp;3</b> filler + truck</Box>
              <Box sx={{ fontSize: 11, color: C.muted, mt: 0.4 }}>This page covers only what comes <b>before</b> Step&nbsp;1 — the engine starts after Stage&nbsp;E.</Box>
            </Box>
          </Box>

          <Box sx={{ pt: 1, borderTop: `1px solid ${C.rule}`, fontSize: 11, color: C.muted }}>Everything below is live from the run for <b>{date || 'the selected date'}</b> — each CFA reserves its stock with its own&nbsp;%.</Box>
        </Box>
      </Dialog>
      {children}
    </Box>
  );

  if (err) return <Shell><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (loading) return <Shell><PageSkeleton kpis={5} rows={8} /></Shell>;
  if (!d) return <Shell><EmptyState title="No pre-processing data for this run"
    hint="The backend returned nothing for this date — it may still be loading data from S3. Try again, pick another run date, or run the pipeline first." /></Shell>;

  // Stage-A counts follow the ONE page CFA dropdown: whole-run aggregate when 'All' ('' ), else that CFA's tallies
  const si = (cfa && d.soq_intake_by_cfa?.[cfa]) ? d.soq_intake_by_cfa[cfa] : d.soq_intake;
  // Filtered-SOQ gate summary (kept/dropped/lines/dbs) — same CFA scope as the page dropdown
  const fss = (cfa && d.filtered_soq_summary_by_cfa?.[cfa]) ? d.filtered_soq_summary_by_cfa[cfa] : d.filtered_soq_summary;
  // EMPTY-STATE: the snapshot genuinely has NO demand (the S3 SOQ feed is empty for this date, or no run yet) —
  // show a clear message instead of a page of zeros. combined SOQ = PDP ∪ below; 0 in-scope means nothing to do.
  if ((si?.combined ?? 0) === 0 && (d.channels ?? []).every((c) => (c.dbs ?? 0) === 0)) {
    return (
      <Shell>
        <Box sx={{ border: `1px solid ${C.border}`, borderLeft: `4px solid ${C.gold}`, borderRadius: `${RADIUS.md}px`,
          bgcolor: C.cream, p: 2.5, mt: 1, maxWidth: 760 }}>
          <Typography sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: '1.15rem', mb: 0.75 }}>
            No pre-processing data for this snapshot
          </Typography>
          <Typography sx={{ fontSize: 13.5, color: C.slate, lineHeight: 1.6 }}>
            The SOQ for <b>30-Jan-2026</b> has <b>no demand</b> in the S3 data — no PDP-due or below-threshold
            distributors — so there is nothing to pre-process for this date. This is <b>not an error</b>: the feed is
            simply empty for this snapshot. Choose a date that has delivered demand, or run the pipeline first.
          </Typography>
        </Box>
      </Shell>
    );
  }
  const maxRun = Math.max(1, ...(d.channels ?? []).map((c) => c.run));
  // Stock-Reserve reg-zsku count: for a specific CFA use its table; for 'All CFAs' ADD across every CFA (not the run-CFA fallback)
  const cfaRows = cfa
    ? (cfaResv?.rows.length ?? 0)
    : Object.values(d.cfa_reservation_by_cfa ?? {}).reduce((a, t) => a + (t?.rows?.length ?? 0), 0);
  // ITEM counts (sum of the qty column) — same as the Stage-D "sub items"/"filler items" KPIs (col 5 subs, col 4 fillers), NOT the row count
  const subItems = (d.substitutes?.rows ?? []).filter((r) => String(r[1]) === cfa).reduce((a, r) => a + Number(r[5] || 0), 0);
  const filItems = (d.fillers?.rows ?? []).filter((r) => String(r[1]) === cfa).reduce((a, r) => a + Number(r[4] || 0), 0);
  const railNodes = [
    { L: 'A', label: 'SOQ Intake', stat: `${nf(si.final)} DBs` },
    { L: 'B', label: 'Channel Sort', stat: `${d.channels.length} channels` },
    { L: 'C', label: 'Stock Reserve', stat: `${nf(cfaRows)} reserved` },
    { L: 'D', label: 'Subs & Fillers', stat: `${nf(subItems)} sub · ${nf(filItems)} filler items` },
    { L: 'E', label: 'Run Order', stat: `${maxRun} runs` },
  ];

  return (
    <Shell>
      {/* HERO RAIL */}
      <Box sx={{ bgcolor: C.cream, border: `1px solid ${C.border}`, borderRadius: `${RADIUS.lg}px`, boxShadow: SHADOW.sm, p: 2, mt: 1, mb: 3 }}>
        <Typography sx={{ fontSize: 12, color: C.slate, fontWeight: 600 }}>
          Five prep stages feed the engine. The <b style={{ color: C.navy }}>solid navy STEP&nbsp;1</b> node is where the engine begins —
          this page covers only what comes <b>before</b> it.
        </Typography>
        <Box sx={{ overflowX: 'auto' }}><Rail nodes={railNodes} maxRun={maxRun} /></Box>
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
        <ExportXlsxButton label="Export all tables" disabled={!d} onClick={() => { if (d) downloadXlsxMulti('reservation_prefilter', [
          { name: 'DB channel map', headers: d.db_channel_map.cols, rows: d.db_channel_map.rows },
          ...(d.cfa_reservation ? [{ name: 'CFA reservation', headers: d.cfa_reservation.cols, rows: d.cfa_reservation.rows }] : []),
          ...(d.substitutes ? [{ name: 'Substitutes', headers: d.substitutes.cols, rows: d.substitutes.rows }] : []),
          ...(d.fillers ? [{ name: 'Fillers', headers: d.fillers.cols, rows: d.fillers.rows }] : []),
          { name: 'Channel reservation %', headers: ['Run', 'Channel', 'DBs', 'Band 1 (<=10)', 'Band 2 (11-30)', 'Band 3 (>30)'],
            rows: d.channels.map((c) => [c.run, c.channel, c.dbs, c.b1, c.b2, c.b3]) },
        ]); }} />
      </Box>

      {/* ---------- SUMMARY STRIP (before Stage A) — the filtered-SOQ gate outcome, scoped by the page CFA dropdown ---------- */}
      {fss && (
        <Box sx={{ mb: 3 }}>
          <Typography sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.gold, mb: 0.85 }}>
            Filtered SOQ · demand-gate outcome · {cfa ? `CFA ${cfa}` : 'all CFAs'}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <Kpi label="(DB, CFA) kept" sub="passed the demand gate" value={`${nf(fss.groups_kept)} / ${nf(fss.groups_total)}`} tone={C.green} strong />
            <Kpi label="(DB, CFA) dropped" sub="failed the demand gate" value={nf(fss.groups_dropped)} tone={C.alertRed} />
            <Kpi label="Cluster-rejected" sub="single-distributor clusters (needs ≥2)" value={nf(fss.groups_cluster_rejected ?? 0)} tone={C.warnText} />
            <Kpi label="SOQ lines kept" sub="lines the engine runs on" value={`${nf(fss.rows_kept)} / ${nf(fss.rows_total)}`} tone={C.navy} />
            <Kpi label="DBs in run" sub="distinct kept distributors" value={nf(fss.dbs_kept)} tone={C.gold} />
          </Box>
        </Box>
      )}

      {/* ---------- STAGE A — SOQ INTAKE ---------- */}
      <Stage letter="A" hue={hueOf(1)} eyebrow="Stage A · Filtered SOQ Intake" title="Which distributors are in scope"
        purpose="The demand gate picks the DBs to allocate to — kept when (PDP-due OR below-threshold) AND combined SOQ > 65%. These are the filtered-SOQ DBs the whole engine runs on.">
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 1.5 }}>
          <Kpi label="PDP-due DBs" sub="delivery due (in scope)" value={nf(si.pdp)} tone={C.navy} />
          <Kpi label="Below-threshold DBs" sub="below stock norm (in scope)" value={nf(si.below)} tone={C.gold} />
          <Kpi label="In-scope DBs" sub="passed the demand gate" value={nf(si.final)} tone={C.green} strong />
        </Box>
        <SplitBar segments={[
          { label: 'PDP-due', value: si.pdp, color: C.navy },
          { label: 'Below-threshold', value: si.below, color: C.gold },
        ]} />
        <Callout tone="green" title="Why this is correct">
          In scope = the demand gate. A distributor is kept when it is <b>PDP-due OR below-threshold</b>, <b>AND</b> its <b>combined SOQ clears 65%</b> of norm — so all <b>{nf(si.final)}</b> in-scope DBs cleared the mandatory combined&gt;65% gate. PDP-due and below-threshold can overlap, so they need not sum to the in-scope total. (Full kept/dropped detail is on the <b>Filtered SOQ</b> page.)
          {si.note ? <> <span style={{ color: C.muted }}>({si.note})</span></> : null}
        </Callout>
      </Stage>

      {/* ---------- STAGE B — CHANNEL SEGREGATION ---------- */}
      <Stage letter="B" hue={hueOf(2)} eyebrow="Stage B · Channel Segregation" title="Sort each DB into one of four channels"
        purpose="Every in-scope DB is classified into exactly one AIDEN channel — an auditable, defensible rule.">
        <Box sx={{ display: 'flex', gap: 1.25, flexWrap: 'wrap', mb: 1 }}>
          {/* per-channel DB counts follow the page CFA dropdown (chForCfa = channels_by_cfa[cfa] ?? all-CFA channels) */}
          {chForCfa.map((c) => {
            const empty = c.dbs === 0;
            return (
              <Box key={c.channel} sx={{ flex: '1 1 150px', minWidth: 150, border: `1px solid ${empty ? C.border : hueOf(c.run)}`, borderLeft: `4px solid ${empty ? C.border : hueOf(c.run)}`,
                borderRadius: `${RADIUS.sm}px`, p: 1.25, bgcolor: empty ? C.grayP : C.white, opacity: empty ? 0.7 : 1 }}>
                <Typography sx={{ fontSize: 12, fontWeight: 700, color: empty ? C.muted : C.navy, lineHeight: 1.15 }}>{c.channel}</Typography>
                <Typography sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 24, color: empty ? C.muted : C.green, lineHeight: 1 }}>{nf(c.dbs)}</Typography>
                <Typography sx={{ fontSize: 10.5, color: C.muted }}>DBs · Run R{c.run}</Typography>
              </Box>
            );
          })}
        </Box>
        <Callout tone="amber" title="Classification recipe">
          <b>Customer Type</b> + <b>SAP Channel code</b> + <b>Sub-Channel D-code</b> → one <b>AIDEN Channel</b>. This is the mapping the client can audit line by line.
        </Callout>
        <Drawer label={`View the full DB → channel classification ledger`} count={dbChanForCfa?.rows.length ?? 0}>
          <TableView data={dbChanForCfa} max={360} monoCol0 tintLast />
        </Drawer>
      </Stage>

      {/* ---------- RUN SELECTOR (scopes C & D) ---------- */}
      <Box sx={{ border: `1px dashed ${C.navy}`, borderRadius: `${RADIUS.md}px`, bgcolor: C.navyP, p: 1.5, mb: 2 }}>
        <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.navy, mb: 0.75 }}>
          Run selector — click a run to scope Stages C &amp; D (CFA stock · substitutes · fillers) to that channel
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
          <Chip label="All runs" onClick={() => setRun(0)} sx={{ fontWeight: 700, bgcolor: run === 0 ? C.navy : C.white, color: run === 0 ? '#fff' : C.navy, border: `1px solid ${C.navy}`, '&:hover': { bgcolor: run === 0 ? C.navy : C.cream } }} />
          {runs.map((r) => {
            const on = r.run === run; const dis = r.dbs === 0;
            return (
              <Chip key={r.run} onClick={() => setRun(r.run)}
                label={`R${r.run} · ${r.channel} · ${r.dbs} DB`}
                sx={{ fontWeight: 700, bgcolor: on ? hueOf(r.run) : C.white, color: on ? '#fff' : (dis ? C.muted : C.navy),
                  border: `1px solid ${dis ? C.border : hueOf(r.run)}`, opacity: dis ? 0.65 : 1,
                  '&:hover': { bgcolor: on ? hueOf(r.run) : C.cream } }} />
            );
          })}
        </Box>
      </Box>

      {/* ---------- STAGE C — CFA STOCK RESERVATION ---------- */}
      <Stage letter="C" hue={hueOf(3)} eyebrow="Stage C · CFA Stock Reservation" title="Reserve CFA cases per channel × MRP band"
        purpose="The CFA's physical cases are split into per-channel reserved pools by a reservation-% master — separately for Band 1 (≤ ₹10), Band 2 (₹11-30) and Band 3 (> ₹30).">
        <Box sx={{ fontSize: 12, color: C.muted, mb: 1 }}>
          <b style={{ color: C.slate }}>{nf(cfaRows)} reg-zskus reserved</b> {cfa ? `for CFA ${cfa}` : 'across all CFAs (summed)'} — every reg-zsku the CFA <b>holds stock of</b>, incl. substitute/filler <b>donors</b> nobody demanded. This is a superset of the demanded lanes on the CFA × Reg-ZSKU page.
        </Box>
        {/* reservation % matrix — scoped by the ONE page CFA dropdown at the top. The percentages are PER CFA
            (5710 ≠ 5230); when 'All CFAs' is selected this shows the run CFA (each CFA reserves with its own %). */}
        <ReservationPctDate meta={d} />
        <Typography sx={{ fontSize: 12.5, fontWeight: 700, color: C.navy, mb: 0.5 }}>
          Reservation % master · CFA {cfa || d.run_cfa}{cfa ? '' : ' (run default — pick a CFA above)'} — each channel's share of CFA stock, by band
        </Typography>
        <Box sx={{ overflow: 'auto', border: `1px solid ${C.border}`, borderRadius: `${RADIUS.sm}px` }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr>{['Run', 'Channel', 'Band 1 (≤₹10)', 'Band 2 (₹11-30)', 'Band 3 (>₹30)'].map((h, i) => <th key={h} style={{ ...th, textAlign: i >= 2 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
            <tbody>{chForCfa.map((c) => (
              <tr key={c.channel} style={{ background: c.run === run ? C.cream : '#fff' }}>
                <td style={{ ...td, fontWeight: 700, color: hueOf(c.run) }}>R{c.run}</td>
                <td style={{ ...td, fontWeight: 700, color: c.dbs === 0 ? C.muted : C.navy }}>{c.channel}</td>
                {[c.b1, c.b2, c.b3].map((v, i) => (
                  <td key={i} style={{ ...td, textAlign: 'right' }}>
                    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minWidth: 108, justifyContent: 'flex-end' }}>
                      <Box sx={{ width: 60, height: 7, bgcolor: C.grayP, borderRadius: 3, overflow: 'hidden' }}>
                        <Box sx={{ width: `${Math.min(100, v)}%`, height: '100%', bgcolor: hueOf(c.run) }} />
                      </Box>
                      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v}%</span>
                    </Box>
                  </td>
                ))}
              </tr>
            ))}</tbody>
          </table>
        </Box>

        {/* per-run CFA stock (scoped) */}
        {sel ? (
          <Box sx={{ mt: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <Chip size="small" label={`Run R${sel.run} · ${sel.channel}`} sx={{ bgcolor: hueOf(sel.run), color: '#fff', fontWeight: 700 }} />
              <Typography sx={{ fontSize: 12.5, color: C.slate }}>CFA stock reserved for this run</Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 1 }}>
              <Kpi label="Reserved cases" value={nf(sel.cfa_reserved)} tone={hueOf(sel.run)} strong />
              <Kpi label="Band 1 (≤₹10)" value={nf(sel.cfa_b1)} tone={C.navy} />
              <Kpi label="Band 2 (₹11-30)" value={nf(sel.cfa_b2)} tone={C.navy} />
              <Kpi label="Band 3 (>₹30)" value={nf(sel.cfa_b3)} tone={C.navy} />
              <Kpi label="reg-zskus reserved" value={nf(cfaForRun?.rows.length ?? 0)} tone={C.gold} />
            </Box>
            <Drawer label={`View per-reg-zsku reservation for ${sel.channel}`} count={cfaForRun?.rows.length ?? 0}>
              <TableView data={cfaForRun} max={360} monoCol0 />
            </Drawer>
          </Box>
        ) : (
          <Box sx={{ mt: 2 }}>
            <Callout tone="navy" title="Showing all runs">
              Physical cases → per-channel reserved pools. Pick a run above to focus one channel, or open the full matrix below.
              The per-channel reserved cases sum back to <b>Physical</b> for every reg-zsku.
            </Callout>
            <Drawer label="View per-reg-zsku reservation — all channels" count={cfaRows}>
              <TableView data={cfaResv} max={360} monoCol0 />
            </Drawer>
          </Box>
        )}
      </Stage>

      {/* ---------- STAGE D — SUBSTITUTES & FILLERS ---------- */}
      <Stage letter="D" hue={hueOf(4)} eyebrow="Stage D · Substitutes & Fillers" title="Pre-build each DB's substitutes and fillers"
        purpose="Before allocation we pre-compute, per DB, the ranked substitutes (matched to the EXACT demanded MRP) and the ranked fillers (any band) the engine may reach for.">
        {sel && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.25 }}>
            <Chip size="small" label={`Run R${sel.run} · ${sel.channel}`} sx={{ bgcolor: hueOf(sel.run), color: '#fff', fontWeight: 700 }} />
            <Typography sx={{ fontSize: 12.5, color: C.slate }}>substitutes &amp; fillers available under this run</Typography>
          </Box>
        )}
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {/* substitutes */}
          <Box sx={{ flex: '1 1 320px', minWidth: 300 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 700, color: C.navy, mb: 0.5 }}>Substitutes · by DB × exact MRP</Typography>
            <Box sx={{ display: 'flex', gap: 1, mb: 0.5 }}>
              <Kpi label={sel ? 'DBs (this run)' : 'DBs'} value={nf(sel ? sel.sub_dbs : new Set((d.substitutes?.rows ?? []).filter((r) => String(r[1]) === cfa).map((r) => r[0])).size)} tone={C.navy} />
              <Kpi label="sub items" value={nf(sel ? sel.sub_items : (d.substitutes?.rows ?? []).filter((r) => String(r[1]) === cfa).reduce((a, r) => a + Number(r[5] || 0), 0))} tone={C.gold} />
            </Box>
            <Callout tone="green" title="Exact-MRP match">A ₹5 demand draws only ₹5 subs, a ₹10 only ₹10 — exact MRP, not the coarse band.</Callout>
            <Drawer label="View substitute lines" count={subsForRun?.rows.length ?? 0}><TableView data={subsForRun} max={320} /></Drawer>
          </Box>
          {/* fillers */}
          <Box sx={{ flex: '1 1 320px', minWidth: 300 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 700, color: C.navy, mb: 0.5 }}>Fillers · by DB (any band)</Typography>
            <Box sx={{ display: 'flex', gap: 1, mb: 0.5 }}>
              <Kpi label={sel ? 'DBs (this run)' : 'DBs'} value={nf(sel ? sel.filler_dbs : new Set((d.fillers?.rows ?? []).filter((r) => String(r[1]) === cfa).map((r) => r[0])).size)} tone={C.navy} />
              <Kpi label="filler items" value={nf(sel ? sel.filler_items : (d.fillers?.rows ?? []).filter((r) => String(r[1]) === cfa).reduce((a, r) => a + Number(r[4] || 0), 0))} tone={C.gold} />
            </Box>
            <Callout tone="navy" title="Spare-room ride">Ranked items that ride leftover truck space in Step 3 — nothing is consumed here.</Callout>
            <Drawer label="View filler lists" count={filsForRun?.rows.length ?? 0}><TableView data={filsForRun} max={320} /></Drawer>
          </Box>
        </Box>
      </Stage>

      {/* ---------- STAGE E — RUN ORDER & CASCADE ---------- */}
      <Stage letter="E" hue={hueOf(5)} eyebrow="Stage E · Run Order & Cascade" title="Queue the channels in priority order"
        purpose="Channels run one at a time in priority order (Non-PACE first … Retail last); each run's unused reserved stock cascades to the next.">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap', rowGap: 1 }}>
          {runs.map((r, i) => (
            <Box key={r.run} sx={{ display: 'flex', alignItems: 'center' }}>
              <Box sx={{ border: `1px solid ${r.dbs === 0 ? C.border : hueOf(r.run)}`, borderRadius: `${RADIUS.sm}px`, px: 1.25, py: 0.75, bgcolor: r.run === run ? C.cream : C.white, opacity: r.dbs === 0 ? 0.65 : 1, minWidth: 108 }}>
                <Typography sx={{ fontSize: 11, fontWeight: 700, color: hueOf(r.run) }}>R{r.run} · {r.channel}</Typography>
                <Typography sx={{ fontSize: 11, color: C.muted }}>reserve <b style={{ color: C.slate }}>{nf(r.cfa_reserved)}</b> cs · {r.dbs} DB</Typography>
              </Box>
              {i < runs.length - 1 && <Box sx={{ color: C.gold, fontSize: 18, fontWeight: 700, px: 0.4 }}>›</Box>}
            </Box>
          ))}
          <Box sx={{ color: C.gold, fontSize: 18, fontWeight: 700, px: 0.4 }}>›</Box>
          <Box sx={{ px: 1.5, py: 0.85, borderRadius: `${RADIUS.md}px`, bgcolor: C.navy, color: '#fff', fontFamily: SERIF, fontWeight: 700, fontSize: 13 }}>STEP 1 · WATER-FILL BEGINS</Box>
        </Box>
        <Callout tone="navy" title="Cascade">
          Each channel run allocates its reserved pool via the engine's 3 steps; whatever it does not use flows to the next run.
          See <b>Reservation Runs</b> for the full cascade (available → allocated → carried-out) and <b>Step-1 Fair Share</b> for the per-DB Step-1 allocation.
        </Callout>
      </Stage>
    </Shell>
  );
}
