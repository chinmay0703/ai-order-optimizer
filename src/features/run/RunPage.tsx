import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Box, Typography, Chip, CircularProgress, Button, Collapse, Dialog, IconButton } from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useDistributorName } from '../../shared/DistributorName';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StorageIcon from '@mui/icons-material/Storage';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { api } from '../../api';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import PageIntro from '../../shared/PageIntro';
import PdartDatePicker, { todayStr } from '../../shared/PdartDatePicker';

/* ============================================================================
   Run — the landing page. Enter a date (+ optional CFA) and run the FULL
   production pipeline end-to-end: POST /api/production/run. Shows the per-CFA
   allocation summary; every other page then reflects this run.
   ========================================================================== */
interface PerCfa { total_allocated_cases: number; so_created_cases?: number; so_held_pending_cases?: number; rlm_truck_cases?: number; rlm_second_cfa_cases?: number; rlm_held_cases?: number; allocated_incl_rlm_cases?: number; sku_lines: number; dbs: number; dbs_held?: number; dbs_in_scope?: number; dbs_network?: number; per_channel: Record<string, number>;
  // DB funnel (from the intermediate tables — aligned with the Filtered-SOQ / CFA×DB / Final-Order pages)
  soq_dbs?: number; filtered_dbs?: number; pdp_dbs?: number; nonpdp_dbs?: number; so_dbs?: number; rlm_truck_dbs?: number; second_cfa_dbs?: number; dropped_dbs?: number;
  // truck counts behind the BEFORE-RLM buckets (the engine's decision — stays the same after the RLM rollup)
  so_trucks?: number; rlm_truck_trucks?: number; second_cfa_trucks?: number;
  so_db_list?: { db: string; trucks: number; oeid: string }[];   // the "Sent for SO creation" DBs, for the summary popup
  rlm_db_list?: { db: string; rlm_trucks: number; held_trucks: number }[];   // the "RLM truck" DBs: trucks to RLM + held with them
  second_cfa_db_list?: { db: string; oeid: string; primary_cfa: string; secondary_cfa: string }[];   // the "2nd CFA" DBs + the offer's CFAs
  dropped_db_list?: { db: string; reason: string; soq: number; cases_dropped: number }[];   // the "Dropped" DBs + why (truck rule)
  rlm_after?: RlmAfter; rlm_rolled_up?: boolean; rlm_had?: boolean }
// AFTER the RLM rollup (15:30): what RLM decided, per DB and per truck (backend domain.calculations.rlm_funnel)
interface RlmAfter { shipped_dbs: number; primary_dbs: number; pending_dbs: number; shifted_dbs: number; rejected_dbs: number; dropped_dbs: number;
  shipped_with_rejected_dbs: number; shipped_trucks: number; so_trucks: number; approved_trucks: number;
  primary_ships_trucks: number; rejected_trucks: number; shifted_trucks: number; pending_trucks: number;
  // held before RLM → still went for SO creation after the rollup (a summary across the buckets, not a bucket)
  shipped_after_rlm_dbs: number; after_rlm_approved_dbs: number; after_rlm_partial_dbs: number;
  after_rlm_primary_dbs: number; after_rlm_secondary_dbs: number;
  after_rlm_db_list?: { approved: string[]; partial: string[]; primary: string[]; secondary: string[] };
  after_rlm_rows?: { db: string; kind: 'approved' | 'partial' | 'primary' | 'secondary'; oeid: string }[] }   // one row per DB, for the popup
// the four ways a HELD distributor still went for SO creation after the rollup — wording for the summary modal
const AFTER_RLM_KINDS: { key: 'approved' | 'partial' | 'primary' | 'secondary'; title: string; what: string }[] = [
  { key: 'approved', title: 'RLM approved the held truck', what: 'The truck waiting for RLM approval was approved, so the whole order went for SO creation.' },
  { key: 'partial', title: 'One truck rejected, the rest sent for SO', what: 'RLM rejected one of the truck(s) it was holding. That truck does not ship; the distributor\'s other trucks went for SO creation.' },
  { key: 'primary', title: '2nd CFA declined — sent from primary CFA', what: 'The order was offered to a secondary CFA, which declined or did not respond in time, so it was sent from the primary CFA.' },
  { key: 'secondary', title: 'Accepted by the 2nd CFA', what: 'The order was offered to a secondary CFA, which accepted it — it ships from that CFA instead of this one.' },
];

// a visible, slim scrollbar (the OS overlay scrollbar is easy to miss) — used by the summary modal's scroll areas
const SCROLLBAR = {
  scrollbarWidth: 'thin' as const, scrollbarColor: `${C.border} transparent`,
  '&::-webkit-scrollbar': { width: 8 }, '&::-webkit-scrollbar-thumb': { background: C.border, borderRadius: 8 },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
};

/* Before-RLM distributor popup — one per count (Sent for SO creation / Sent for RLM approval / 2nd CFA / Dropped): a CFA's distributors with the columns
   that matter for that bucket. Scrolls with a sticky header when the list is long. */
interface PopupCol { label: string; num?: boolean; mono?: boolean; get: (r: Record<string, unknown>) => React.ReactNode }
function DbListPopup({ cfa, eyebrow, title, intro, cols, rows, onClose }: {
  cfa: string; eyebrow: string; title: string; intro: string; cols: PopupCol[]; rows: Record<string, unknown>[]; onClose: () => void;
}) {
  const nameOf = useDistributorName();
  const th = { position: 'sticky' as const, top: 0, background: C.cream, color: C.navy, fontSize: 10.5, fontWeight: 800,
    letterSpacing: '.04em', textTransform: 'uppercase' as const, padding: '7px 10px', borderBottom: `1px solid ${C.rule}`, textAlign: 'left' as const, whiteSpace: 'nowrap' as const };
  const td = { padding: '7px 10px', borderTop: `1px solid ${C.rule}`, fontSize: 12.5, color: C.slate, verticalAlign: 'top' as const };
  const all: PopupCol[] = [
    { label: 'CFA', mono: true, get: () => cfa },
    { label: 'DB code', mono: true, get: (r) => String(r.db) },
    { label: 'Distributor', get: (r) => nameOf(String(r.db)) || '—' },
    ...cols,
  ];
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: `${RADIUS.md}px`, border: `1px solid ${C.rule}` } }}>
      <Box sx={{ px: 2.5, pt: 2, pb: 1.25, borderBottom: `1px solid ${C.rule}` }}>
        <Typography sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.gold }}>{eyebrow} · CFA {cfa}</Typography>
        <Typography sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 20, color: C.navy }}>{title}</Typography>
        <Typography sx={{ fontSize: 12.5, color: C.slate, mt: 0.5 }}>{intro}</Typography>
      </Box>
      <Box sx={{ px: 2.5, py: 1.5 }}>
        <Box sx={{ maxHeight: '55vh', overflow: 'auto', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px`, ...SCROLLBAR }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr>{all.map((c) => <th key={c.label} style={{ ...th, textAlign: c.num ? 'right' : 'left' }}>{c.label}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.db)}>
                  {all.map((c) => (
                    <td key={c.label} style={{ ...td, textAlign: c.num ? 'right' : 'left', fontVariantNumeric: c.num ? 'tabular-nums' : undefined,
                      fontWeight: c.num || c.mono ? 700 : 400, fontFamily: c.mono ? MONO : undefined, color: c.mono ? C.navy : C.slate,
                      whiteSpace: c.mono ? 'nowrap' : undefined }}>{c.get(r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Box>
      </Box>
      <Box sx={{ px: 2.5, py: 1.25, borderTop: `1px solid ${C.rule}`, display: 'flex', justifyContent: 'flex-end' }}>
        <Button onClick={onClose} sx={{ textTransform: 'none', fontWeight: 700, color: C.navy }}>Close</Button>
      </Box>
    </Dialog>
  );
}

interface Diagnostics { soq_rows: number; filtered_soq_rows: number; cfa_inventory_rows: number }
interface RunResult { date: string; data_date?: string | null; cfas: string[]; summary: Record<string, PerCfa>; orders: { count: number }; available?: boolean; diagnostics?: Diagnostics }

/** Plain-language WHY for a 0-allocation run, from its input row counts (checked in the order the pipeline consumes them). */
const diagReason = (d: Diagnostics): string =>
  d.soq_rows === 0 ? 'No SOQ was delivered for this date — there was no demand to allocate.'
    : d.filtered_soq_rows === 0 ? 'SOQ was delivered but none passed the demand gate (PDP / below-threshold / combined-SOQ ≥ 65%).'
      : d.cfa_inventory_rows === 0 ? 'Demand was present, but there was no CFA inventory (stock) to allocate.'
        : 'Demand and stock were both present, yet nothing allocated — worth investigating (reservation split / thresholds).';
interface StepEv { phase: string; label: string; rows?: number; secs?: number; group?: string; date?: string; summary?: Record<string, PerCfa>;
  kind?: string; table?: string; missing?: string[]; available?: string[]; path?: string }

const nf = (n: number) => (n ?? 0).toLocaleString();
const IDLE_POLL_MS = 4000;
// today as dd-mm-yyyy — the run date every run is stamped with (the backend's run_day, IST)
const todayLabel = () => { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`; };   // how often an idle Run page checks whether a run started elsewhere (API / cron / another user)
const SOURCE_LABEL: Record<string, string> = { api: 'started via API', cron: 'started by the daily schedule', manual: 'started from the UI' };
const RUN_HUES = ['#10365A', '#D98A00', '#21A366', '#DC2C25', '#7A756D', '#1C1C1C'];

/* ---- Pipeline Run Audit: a slim run HEADER + PER-CFA per-stage detail, from GET /api/production/audit ---- */
interface CfaStage {   // one (cfa, stage) checkpoint; cfa='ALL' = a shared/whole-run stage
  cfa: string; stage: string; status: string;
  error_message?: string | null; started_at?: string | null; finished_at?: string | null;
}
interface AuditRow {
  run_id: number; run_date: string; data_date?: string; overall_status: string; rlm_cron_status?: string;
  started_at?: string | null; finished_at?: string | null; duration_secs?: number | null;
  cfa_stages?: CfaStage[];
}
// whole-run wall-clock, humanised — "48s", "1m 23s", "1h 4m"
const fmtDur = (s?: number | null) => {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
// ONLY s3_fetch + pre_filter are shared/whole-run (cfa='ALL'); EVERYTHING else — incl. rlm + the daily rlm cron —
// is PER CFA. Both lists are in pipeline order.
const SHARED_ORDER = ['s3_fetch', 'pre_filter'] as const;
const SHARED_LABELS: Record<string, string> = { s3_fetch: 'S3 Fetch', pre_filter: 'Pre-filter' };
const CFA_ORDER = ['reservation', 'step1', 'step2', 'step3', 'disaggregation', 'sap_orders', 's3_upload', 'rlm', 'rlm_cron'] as const;
const CFA_LABELS: Record<string, string> = {
  reservation: 'Reservation', step1: 'Step 1', step2: 'Step 2', step3: 'Step 3',
  disaggregation: 'Disaggregation', sap_orders: 'SAP Orders', s3_upload: 'S3 Upload', rlm: 'RLM', rlm_cron: 'RLM Cron',
};
// calm status palette — only a small DOT carries colour (green ok · gold partial/running · red fail · grey idle)
const ST_TONE: Record<string, { dot: string; fg: string; bg: string }> = {
  SUCCESS: { dot: '#21A366', fg: '#1E7E4B', bg: '#E7F3E7' },
  RUNNING: { dot: '#D98A00', fg: '#B26A00', bg: '#FBF1E0' },
  FAILED: { dot: '#DC2C25', fg: '#C0261F', bg: '#FBEAEA' },
  PARTIAL: { dot: '#D98A00', fg: '#B26A00', bg: '#FBF1E0' },
  SKIPPED: { dot: '#CBD5E1', fg: '#7A756D', bg: '#F1F5F9' },
  PENDING: { dot: '#CBD5E1', fg: '#9AA3AD', bg: '#F1F5F9' },
};
function AuditSection({ audit, loading }: { audit: AuditRow | null; loading?: boolean }) {
  // celebrate a stage the moment it flips to SUCCESS — a one-shot pop + ring + sparkle burst, ONLY on the live
  // transition (never on first paint of an already-finished run).
  const [celebrate, setCelebrate] = useState<Set<string>>(() => new Set());
  const prevStatus = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!audit) return;
    const justDone: string[] = [];
    for (const s of audit.cfa_stages ?? []) {
      const key = `${s.cfa}:${s.stage}`; const now = String(s.status ?? 'PENDING');
      if (prevStatus.current[key] && prevStatus.current[key] !== 'SUCCESS' && now === 'SUCCESS') justDone.push(key);
      prevStatus.current[key] = now;
    }
    if (!justDone.length) return;
    setCelebrate((s) => new Set([...s, ...justDone]));
    const t = setTimeout(() => setCelebrate((s) => { const n = new Set(s); justDone.forEach((k) => n.delete(k)); return n; }), 1000);
    return () => clearTimeout(t);
  }, [audit]);
  if (!audit) return loading ? (
    // audit still loading (no card yet) → a clear "loading" card so the Run page never looks empty/hung on first paint
    <Box sx={{ border: `1px solid ${C.rule}`, borderLeft: `3px solid ${C.gold}`, borderRadius: `${RADIUS.md}px`,
      boxShadow: SHADOW.sm, bgcolor: C.white, p: 2.25, mt: 3, display: 'flex', alignItems: 'center', gap: 1.25 }}>
      <CircularProgress size={16} thickness={5} sx={{ color: C.gold }} />
      <Typography sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 15 }}>Loading run audit…</Typography>
    </Box>
  ) : null;
  const ov = ST_TONE[audit.overall_status] ?? ST_TONE.PENDING;
  const runningNow = audit.overall_status === 'RUNNING';
  const cron = ST_TONE[audit.rlm_cron_status ?? 'PENDING'] ?? ST_TONE.PENDING;   // the daily RLM rollup cron's overall status
  const cronRunning = audit.rlm_cron_status === 'RUNNING';
  // index the per-CFA per-stage detail: shared stages (cfa='ALL') as a stepper + a CFA × stage matrix
  const byKey: Record<string, CfaStage> = {};
  for (const s of (audit.cfa_stages ?? [])) byKey[`${s.cfa}:${s.stage}`] = s;
  const shared = SHARED_ORDER.filter((st) => byKey[`ALL:${st}`]);
  const cfas = [...new Set((audit.cfa_stages ?? []).map((s) => s.cfa).filter((c) => c !== 'ALL'))].sort();
  const cols = CFA_ORDER.filter((st) => cfas.some((c) => byKey[`${c}:${st}`]));   // only columns with data (hides rlm_cron until the cron runs)
  const failures = (audit.cfa_stages ?? []).filter((s) => String(s.status) === 'FAILED');
  return (
    <Box sx={{ border: `1px solid ${C.rule}`, borderLeft: `3px solid ${ov.dot}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, bgcolor: C.white, p: 2.25, mt: 3 }}>
      {/* header: title · status · run duration (prominent) · run/data/finished meta */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 2, flexWrap: 'wrap' }}>
        <Typography sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 17 }}>Pipeline Run Audit</Typography>
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.6, px: 1, py: 0.35, borderRadius: 999, bgcolor: ov.bg, color: ov.fg, fontWeight: 800, fontSize: 11.5, letterSpacing: '.04em' }}>
          <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: ov.dot, ...(runningNow ? { animation: 'auditPulse 1.2s ease-in-out infinite' } : {}) }} />{audit.overall_status}
        </Box>
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.6, px: 1, py: 0.35, borderRadius: 999, bgcolor: cron.bg, color: cron.fg, fontWeight: 800, fontSize: 11.5, letterSpacing: '.04em' }}
          title="the daily RLM rollup cron's overall status for this run (PENDING → RUNNING → SUCCESS)">
          <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: cron.dot, ...(cronRunning ? { animation: 'auditPulse 1.2s ease-in-out infinite' } : {}) }} />RLM Cron · {audit.rlm_cron_status ?? 'PENDING'}
        </Box>
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.55, px: 1.1, py: 0.4, borderRadius: 999, bgcolor: C.cream, border: `1px solid ${C.border}`, color: C.navy, fontWeight: 800, fontSize: 12 }}
          title="whole-pipeline wall-clock (started → finished)">
          <AccessTimeIcon sx={{ fontSize: 15 }} />{runningNow ? 'running · ' : 'ran in '}<span style={{ fontFamily: MONO }}>{fmtDur(audit.duration_secs)}</span>
        </Box>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 11.5, color: C.muted, fontFamily: MONO }}>
          run {audit.run_date}{audit.data_date ? ` · data ${audit.data_date}` : ''}{audit.finished_at ? ` · ${String(audit.finished_at).slice(11, 19)}` : ''}
        </Typography>
      </Box>

      {/* SHARED (whole-run) stages — a connected stepper flowing left→right; scrolls on a narrow screen */}
      {shared.length > 0 && (
        <>
          <Box sx={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.muted, mb: 0.8 }}>Shared stages</Box>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', overflowX: 'auto', pb: 0.5,
            '&::-webkit-scrollbar': { height: 6 }, '&::-webkit-scrollbar-thumb': { background: C.border, borderRadius: 6 } }}>
            {shared.map((k, i) => {
              const st = String(byKey[`ALL:${k}`]?.status ?? 'PENDING'); const t = ST_TONE[st] ?? ST_TONE.PENDING;
              const idle = st === 'PENDING' || st === 'SKIPPED';
              const done = st === 'SUCCESS'; const failed = st === 'FAILED'; const running = st === 'RUNNING';
              const glyph = done ? '✓' : failed ? '✕' : String(i + 1).padStart(2, '0');
              const cel = done && celebrate.has(`ALL:${k}`);   // JUST flipped to SUCCESS → play the one-shot celebration
              return (
                <Box key={k} sx={{ display: 'flex', alignItems: 'flex-start', flex: '0 0 auto' }} title={`${SHARED_LABELS[k]}: ${st}`}>
                  <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.7, width: 92, px: 0.4 }}>
                    <Box sx={{ position: 'relative', width: 30, height: 30, flexShrink: 0 }}>
                      <Box sx={{ width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: done || failed ? 14 : 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                        bgcolor: idle ? '#fff' : t.dot, color: idle ? C.muted : '#fff', border: `2px solid ${idle ? C.border : t.dot}`,
                        ...(running ? { animation: 'auditPulse 1.2s ease-in-out infinite' } : {}),
                        ...(cel ? { animation: 'auditPop 0.55s cubic-bezier(.2,1.35,.4,1) both' } : {}) }}>{glyph}</Box>
                      {/* expanding success ring */}
                      {cel && <Box aria-hidden sx={{ position: 'absolute', inset: -4, borderRadius: '50%', border: `2px solid ${t.dot}`,
                        animation: 'auditRing 0.7s ease-out forwards', pointerEvents: 'none' }} />}
                      {/* 6-point sparkle burst */}
                      {cel && [0, 1, 2, 3, 4, 5].map((si) => {
                        const ang = (si / 6) * Math.PI * 2;
                        const dx = Math.round(Math.cos(ang) * 19), dy = Math.round(Math.sin(ang) * 19);
                        return <Box key={si} aria-hidden component="span"
                          style={{ '--dx': `${dx}px`, '--dy': `${dy}px` } as CSSProperties}
                          sx={{ position: 'absolute', top: '50%', left: '50%', mt: '-3px', ml: '-3px', width: 6, height: 6, borderRadius: '50%',
                            bgcolor: t.dot, boxShadow: `0 0 6px ${t.dot}`, pointerEvents: 'none', animation: 'auditSpark 0.7s ease-out forwards' }} />;
                      })}
                    </Box>
                    <Box sx={{ fontSize: 10.5, fontWeight: 700, color: idle ? C.muted : C.slate, textAlign: 'center', lineHeight: 1.15 }}>{SHARED_LABELS[k]}</Box>
                  </Box>
                  {i < shared.length - 1 && (
                    <Box sx={{ width: 22, height: 2.5, borderRadius: 2, flexShrink: 0, mt: '14px', bgcolor: done ? t.dot : C.border }} />
                  )}
                </Box>
              );
            })}
          </Box>
        </>
      )}

      {/* PER-CFA stages — a CFA × stage matrix, so you can see EXACTLY which CFA broke where */}
      {cfas.length > 0 && cols.length > 0 && (
        <Box sx={{ mt: shared.length ? 2.25 : 0 }}>
          <Box sx={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.muted, mb: 0.8 }}>Per-CFA stages</Box>
          <Box sx={{ overflowX: 'auto', '&::-webkit-scrollbar': { height: 6 }, '&::-webkit-scrollbar-thumb': { background: C.border, borderRadius: 6 } }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: `92px repeat(${cols.length}, minmax(64px, 1fr))`,
              minWidth: 92 + cols.length * 64, border: `1px solid ${C.border}`, borderRadius: `${RADIUS.sm}px`, overflow: 'hidden' }}>
              {/* navy header row — CFA + one column per engine stage */}
              <Box sx={{ bgcolor: C.navy, color: '#fff', fontWeight: 700, fontSize: 10.5, px: 1, py: 0.7, display: 'flex', alignItems: 'center' }}>CFA</Box>
              {cols.map((st) => (
                <Box key={st} sx={{ bgcolor: C.navy, color: '#fff', fontWeight: 700, fontSize: 10, px: 0.5, py: 0.7, textAlign: 'center',
                  lineHeight: 1.1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{CFA_LABELS[st]}</Box>
              ))}
              {/* one row per CFA, a status dot per stage */}
              {cfas.map((c, ri) => (
                <Fragment key={c}>
                  <Box sx={{ bgcolor: ri % 2 ? C.cream : C.white, borderTop: `1px solid ${C.border}`, px: 1, py: 0.7, display: 'flex', alignItems: 'center' }}>
                    <Box sx={{ fontFamily: MONO, fontWeight: 700, fontSize: 12, color: C.navy }}>{c}</Box>
                  </Box>
                  {cols.map((st) => {
                    const cell = byKey[`${c}:${st}`];
                    const stt = cell ? String(cell.status) : 'PENDING'; const t = ST_TONE[stt] ?? ST_TONE.PENDING;
                    const idle = !cell || stt === 'PENDING' || stt === 'SKIPPED';
                    const done = stt === 'SUCCESS'; const failed = stt === 'FAILED'; const running = stt === 'RUNNING';
                    const cel = done && celebrate.has(`${c}:${st}`);
                    const tip = cell ? `${c} · ${CFA_LABELS[st]}: ${stt}${cell.error_message ? ` — ${cell.error_message}` : ''}` : `${c} · ${CFA_LABELS[st]}: not run`;
                    return (
                      <Box key={st} title={tip} sx={{ bgcolor: ri % 2 ? C.cream : C.white, borderTop: `1px solid ${C.border}`, py: 0.7,
                        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Box sx={{ width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 12, fontWeight: 800, lineHeight: 1,
                          bgcolor: idle ? '#fff' : t.dot, color: idle ? C.muted : '#fff', border: `2px solid ${idle ? C.border : t.dot}`,
                          ...(running ? { animation: 'auditPulse 1.2s ease-in-out infinite' } : {}),
                          ...(cel ? { animation: 'auditPop 0.55s cubic-bezier(.2,1.35,.4,1) both' } : {}) }}>
                          {done ? '✓' : failed ? '✕' : ''}
                        </Box>
                      </Box>
                    );
                  })}
                </Fragment>
              ))}
            </Box>
          </Box>
          {/* legend */}
          <Box sx={{ display: 'flex', gap: 1.5, mt: 0.9, flexWrap: 'wrap' }}>
            {([['SUCCESS', 'done'], ['RUNNING', 'running'], ['FAILED', 'failed'], ['PENDING', 'idle / not run']] as [string, string][]).map(([k, lbl]) => (
              <Box key={k} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 11, color: C.muted }}>
                <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: k === 'PENDING' ? '#fff' : ST_TONE[k].dot,
                  border: `1.5px solid ${k === 'PENDING' ? C.border : ST_TONE[k].dot}` }} />{lbl}
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {failures.length > 0 && (
        <Box sx={{ mt: 1.75, border: '1px solid #F3C9C9', borderLeft: `3px solid ${C.alertRed}`, bgcolor: '#FDF3F3', borderRadius: `${RADIUS.sm}px`, p: 1.25 }}>
          <Typography sx={{ fontSize: 12.5, fontWeight: 800, color: C.alertRed }}>
            Trouble at: {failures.map((f) => `${f.cfa === 'ALL' ? '' : `${f.cfa} · `}${CFA_LABELS[f.stage] ?? SHARED_LABELS[f.stage] ?? f.stage}`).join(', ')}
          </Typography>
          {failures.filter((f) => f.error_message).map((f, i) => (
            <Typography key={i} sx={{ fontSize: 12, color: C.slate, mt: 0.3, fontFamily: MONO, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {f.cfa === 'ALL' ? '' : `${f.cfa}: `}{f.error_message}
            </Typography>
          ))}
        </Box>
      )}
      <style>{'@keyframes auditPulse{0%,100%{opacity:1}50%{opacity:.3}}'
        + '@keyframes auditPop{0%{transform:scale(1)}35%{transform:scale(1.32)}65%{transform:scale(.9)}100%{transform:scale(1)}}'
        + '@keyframes auditRing{0%{transform:scale(.55);opacity:.7}100%{transform:scale(2.4);opacity:0}}'
        + '@keyframes auditSpark{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(var(--dx),var(--dy)) scale(.2);opacity:0}}'}</style>
    </Box>
  );
}

function Kpi({ label, value, sub, tone = C.navy, strong }: { label: string; value: string; sub?: string; tone?: string; strong?: boolean }) {
  return (
    <Box sx={{ flex: 1, minWidth: 150, border: `1px solid ${strong ? tone : C.border}`, borderRadius: `${RADIUS.md}px`, p: 1.75, bgcolor: strong ? tone : C.white, boxShadow: SHADOW.sm }}>
      <Typography sx={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: strong ? 'rgba(255,255,255,0.85)' : C.muted }}>{label}</Typography>
      <Typography sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 30, color: strong ? '#fff' : tone, lineHeight: 1.05, mt: 0.3 }}>{value}</Typography>
      {sub && <Typography sx={{ fontSize: 11, color: strong ? 'rgba(255,255,255,0.85)' : C.muted }}>{sub}</Typography>}
    </Box>
  );
}

function CfaCard({ cfa, s }: { cfa: string; s: PerCfa }) {
  const channels = Object.entries(s.per_channel);
  const max = Math.max(1, ...channels.map(([, v]) => v));
  return (
    <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, bgcolor: C.white, p: 2, flex: '1 1 340px', minWidth: 320 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Chip label={`CFA ${cfa}`} sx={{ bgcolor: C.navy, color: '#fff', fontWeight: 700 }} />
        <Typography sx={{ fontSize: 12.5, color: C.muted }}>{nf(s.dbs)} DBs served · {nf(s.sku_lines)} SKU lines</Typography>
      </Box>
      {(s.dbs_in_scope != null || s.dbs_network != null) && (
        <Typography sx={{ fontSize: 11.5, color: C.muted, mb: 0.75 }}>
          <b style={{ color: C.green }}>{nf(s.dbs)}</b> served (got cases) ·
          <b style={{ color: C.navy }}> {nf(s.dbs_in_scope ?? 0)}</b> in-scope (had SOQ demand) ·
          <b style={{ color: C.slate }}> {nf(s.dbs_network ?? 0)}</b> classified (SOQ-served)
        </Typography>
      )}
      <Typography sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 28, color: C.green, lineHeight: 1 }}>{nf(s.total_allocated_cases)}<span style={{ fontSize: 13, color: C.muted, fontFamily: SANS, fontWeight: 400 }}> SO cases created</span></Typography>
      {s.rlm_truck_cases ? <Typography sx={{ fontSize: 11.5, color: C.gold, fontWeight: 700, mt: 0.3 }}>+ {nf(s.rlm_truck_cases)} cases on pending RLM truck(s) — held (not an SO)</Typography> : null}
      {s.so_held_pending_cases ? <Typography sx={{ fontSize: 11.5, color: C.gold, fontWeight: 700, mt: 0.15 }}>+ {nf(s.so_held_pending_cases)} SO-ready cases also held — a truck in {s.dbs_held ? `${nf(s.dbs_held)} DB(s)` : 'this DB'} is pending RLM, so the whole DB waits</Typography> : null}
      {s.rlm_second_cfa_cases ? <Typography sx={{ fontSize: 11.5, color: C.gold, fontWeight: 700, mt: 0.15 }}>+ {nf(s.rlm_second_cfa_cases)} cases sent to 2nd CFA (pending — not an SO)</Typography> : null}
      <Box sx={{ mt: 1.25, display: 'flex', flexDirection: 'column', gap: 0.6 }}>
        {channels.map(([ch, v], i) => (
          <Box key={ch} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography sx={{ fontSize: 11.5, color: v ? C.slate : C.muted, width: 128, flexShrink: 0 }}>{ch}</Typography>
            <Box sx={{ flex: 1, height: 9, bgcolor: C.grayP, borderRadius: 4, overflow: 'hidden' }}>
              <Box sx={{ width: `${(v / max) * 100}%`, height: '100%', bgcolor: RUN_HUES[i % RUN_HUES.length] }} />
            </Box>
            <Typography sx={{ fontSize: 11.5, fontWeight: 700, color: C.navy, width: 62, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{nf(v)}</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/* ---- Demand → outcome DB funnel (per CFA): BEFORE the RLM rollup (engine decision) and AFTER it (RLM outcome) ---- */
const trucksLabel = (n: number | undefined) => `${nf(n ?? 0)} truck${(n ?? 0) === 1 ? '' : 's'}`;

function FunnelTable({ summary, cfas }: { summary: Record<string, PerCfa>; cfas: string[] }) {
  const th = { padding: '8px 10px', background: '#F4F3F1', color: C.muted, fontWeight: 700, fontSize: 10, letterSpacing: '.04em', textTransform: 'uppercase' as const, borderBottom: '1px solid #E5E2DB', whiteSpace: 'nowrap' as const, textAlign: 'right' as const };
  const td = { padding: '9px 10px', borderTop: '1px solid #EDEBE6', fontSize: 13, fontVariantNumeric: 'tabular-nums' as const, textAlign: 'right' as const, verticalAlign: 'top' as const };
  // a DB count with an optional small second line (truck counts / detail) underneath
  // `sub` = one small line, or a LIST stacked one per line (stays narrow however many parts there are); `tip` = hover text
  const cell = (v: number | undefined, color?: string, bold?: boolean, sub?: string | string[], subColor?: string, tip?: string) => (
    <td style={{ ...td, color: color ?? C.slate, fontWeight: bold ? 800 : 500 }} title={tip}>
      {nf(v ?? 0)}
      {(Array.isArray(sub) ? sub : sub ? [sub] : []).map((line) => (
        <div key={line} style={{ fontSize: 10.5, fontWeight: 500, color: subColor ?? C.muted, marginTop: 2, lineHeight: 1.3,
          whiteSpace: Array.isArray(sub) ? 'normal' : 'nowrap', maxWidth: Array.isArray(sub) ? 170 : undefined, marginLeft: 'auto' }}>{line}</div>
      ))}
    </td>
  );
  const tone = (n: number | undefined, c: string) => ((n ?? 0) > 0 ? c : C.muted);
  const Table = ({ head, rows }: { head: [string, string?][]; rows: React.ReactNode }) => (
    <Box sx={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 780 }}>
        <thead><tr>{head.map(([h, col], i) => <th key={h} style={{ ...th, textAlign: i === 0 ? 'left' : 'right', color: col ?? C.muted }}>{h}</th>)}</tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </Box>
  );
  const cfaCell = (c: string) => <td style={{ ...td, textAlign: 'left', fontWeight: 800, color: C.navy, fontFamily: MONO }}>{c}</td>;
  const anyRolled = cfas.some((c) => summary[c]?.rlm_rolled_up);
  const anyRlm = cfas.some((c) => summary[c]?.rlm_had);
  const anyPending = cfas.some((c) => (summary[c]?.rlm_after?.pending_dbs ?? 0) > 0);
  const [afterOpen, setAfterOpen] = useState(false);
  const [summaryCfa, setSummaryCfa] = useState<string | null>(null);
  // the open Before-RLM popup: which CFA, and which count (Sent for SO creation / Sent for RLM approval / 2nd CFA / Dropped)
  const [popup, setPopup] = useState<{ cfa: string; kind: 'so' | 'rlm' | 'second' | 'dropped' } | null>(null);
  const infoBtn = (onClick: () => void, label: string, tip: string) => (
    <IconButton size="small" onClick={onClick} aria-label={label} title={tip}
      sx={{ p: 0.25, color: C.navy, '&:hover': { color: C.gold } }}><InfoOutlinedIcon sx={{ fontSize: 16 }} /></IconButton>
  );   // the CFA whose "Shipped after RLM" summary modal is open   // ② After-RLM section is collapsible (closed by default; status shows in its header)

  return (
    <Box sx={{ mb: 3 }}>
      <Typography sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: '1.15rem', color: C.navy, mb: 0.75 }}>Demand → outcome funnel · DBs per CFA</Typography>
      <PageIntro>
        How many distributors came from the <b>S3 SOQ</b>, passed the <b>demand gate</b> (PDP / non-PDP), then where each ended up —
        first as the <b>engine decided</b> (before RLM), then <b>after the RLM rollup</b> (what RLM approved, rejected or shifted).
        The small line under a count is the number of <b>trucks</b> behind it.
      </PageIntro>

      <Typography sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.gold, mb: 0.5 }}>① Before RLM · engine decision</Typography>
      <Table head={[['CFA'], ['S3 SOQ DBs'], ['Filtered'], ['PDP'], ['Non-PDP'], ['Sent for SO creation', C.green], ['Sent for RLM approval', C.gold], ['2nd CFA', C.gold], ['Dropped', C.alertRed]]}
        rows={cfas.map((c) => { const s = summary[c]; if (!s) return null; return (
          <tr key={c}>
            {cfaCell(c)}
            {cell(s.soq_dbs)}{cell(s.filtered_dbs, C.navy, true)}{cell(s.pdp_dbs)}{cell(s.nonpdp_dbs)}
            <td style={{ ...td, color: C.green, fontWeight: 800 }}>
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.25 }}>
                {(s.so_db_list?.length ?? 0) > 0 && infoBtn(() => setPopup({ cfa: c, kind: 'so' }),
                  `Sent for SO creation — distributors for CFA ${c}`, 'See the distributors, trucks and OEIDs')}
                {nf(s.so_dbs ?? 0)}
              </Box>
              <div style={{ fontSize: 10.5, fontWeight: 500, color: C.muted, marginTop: 2, whiteSpace: 'nowrap' }}>{trucksLabel(s.so_trucks)}</div>
            </td>
            <td style={{ ...td, color: tone(s.rlm_truck_dbs, C.gold), fontWeight: 500 }}>
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.25 }}>
                {(s.rlm_db_list?.length ?? 0) > 0 && infoBtn(() => setPopup({ cfa: c, kind: 'rlm' }),
                  `Sent for RLM approval — distributors for CFA ${c}`, 'See the distributors, trucks sent for RLM and trucks on hold')}
                {nf(s.rlm_truck_dbs ?? 0)}
              </Box>
              <div style={{ fontSize: 10.5, fontWeight: 500, color: C.muted, marginTop: 2, whiteSpace: 'nowrap' }}>{trucksLabel(s.rlm_truck_trucks)}</div>
            </td>
            <td style={{ ...td, color: tone(s.second_cfa_dbs, C.gold), fontWeight: 500 }}>
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.25 }}>
                {(s.second_cfa_db_list?.length ?? 0) > 0 && infoBtn(() => setPopup({ cfa: c, kind: 'second' }),
                  `2nd CFA — distributors for CFA ${c}`, 'See the distributors and their primary / secondary CFA')}
                {nf(s.second_cfa_dbs ?? 0)}
              </Box>
              <div style={{ fontSize: 10.5, fontWeight: 500, color: C.muted, marginTop: 2, whiteSpace: 'nowrap' }}>{trucksLabel(s.second_cfa_trucks)}</div>
            </td>
            <td style={{ ...td, color: tone(s.dropped_dbs, C.alertRed), fontWeight: (s.dropped_dbs ?? 0) > 0 ? 800 : 500 }}>
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.25 }}>
                {(s.dropped_db_list?.length ?? 0) > 0 && infoBtn(() => setPopup({ cfa: c, kind: 'dropped' }),
                  `Dropped — distributors for CFA ${c}`, 'See the distributors and why they were dropped')}
                {nf(s.dropped_dbs ?? 0)}
              </Box>
            </td>
          </tr>
        ); })} />
      <Typography sx={{ fontSize: 11.5, color: C.muted, mt: 0.6, mb: 2 }}>
        Every filtered DB is in exactly one bucket: Sent for SO creation + Sent for RLM approval + 2nd CFA + dropped = filtered. A DB with ANY truck held for
        RLM counts as Sent for RLM approval (its whole order waits). <b>Dropped</b> = the DB shipped nothing (every lane below the 65% truck floor).
      </Typography>

      <Box role="button" tabIndex={0} aria-expanded={afterOpen} onClick={() => setAfterOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAfterOpen((o) => !o); } }}
        sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.5, flexWrap: 'wrap', cursor: 'pointer', userSelect: 'none',
          borderRadius: `${RADIUS.sm}px`, '&:hover .after-chev': { color: C.navy }, '&:focus-visible': { outline: `2px solid ${C.gold}`, outlineOffset: 2 } }}>
        <Box component="span" className="after-chev" aria-hidden sx={{ display: 'inline-block', color: C.gold, fontWeight: 800, fontSize: 12,
          transform: afterOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</Box>
        <Typography sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.gold }}>② After RLM rollup · RLM outcome</Typography>
        <Typography sx={{ fontSize: 11.5, fontWeight: 700, color: !anyRlm ? C.muted : anyPending ? C.warnText : C.green }}>
          {!anyRlm ? 'no RLM trucks in this run — same as above' : anyPending ? (anyRolled ? 'rollup done for some CFAs · others still pending (runs at 15:30)' : 'RLM decision pending — the rollup runs at 15:30') : 'RLM rollup complete'}
        </Typography>
      </Box>
      <Collapse in={afterOpen} unmountOnExit>
      <Table head={[['CFA'], ['Filtered'], ['Shipped before RLM', C.green], ['Shipped after RLM', C.green], ['Rejected by RLM · trucks', C.alertRed], ['Shifted to 2nd CFA', C.navy], ['Sent from primary CFA', C.green], ['Pending RLM', C.gold], ['Dropped', C.alertRed]]}
        rows={cfas.map((c) => { const s = summary[c]; if (!s) return null; const a = s.rlm_after; if (!a) return null;
          return (
            <tr key={c}>
              {cfaCell(c)}
              {cell(s.filtered_dbs, C.navy, true)}
              {/* SHIPPED BEFORE RLM — the engine sent these straight for SO creation; RLM never touched them (= ① Sent for SO creation) */}
              <td style={{ ...td, color: C.green, fontWeight: 800 }}>
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.25 }}>
                  {(s.so_db_list?.length ?? 0) > 0 && infoBtn(() => setPopup({ cfa: c, kind: 'so' }),
                    `Shipped before RLM — distributors for CFA ${c}`, 'See the distributors, trucks and OEIDs')}
                  {nf(s.so_dbs ?? 0)}
                </Box>
                <div style={{ fontSize: 10.5, fontWeight: 500, color: C.muted, marginTop: 2, whiteSpace: 'nowrap' }}>{trucksLabel(s.so_trucks)}</div>
              </td>
              <td style={{ ...td, color: tone(a.shipped_after_rlm_dbs, C.green), fontWeight: (a.shipped_after_rlm_dbs ?? 0) > 0 ? 800 : 500, whiteSpace: 'nowrap' }}>
                {nf(a.shipped_after_rlm_dbs ?? 0)}
                {(a.shipped_after_rlm_dbs ?? 0) > 0 && (
                  <IconButton size="small" onClick={() => setSummaryCfa(c)} aria-label={`Shipped after RLM — summary for CFA ${c}`}
                    title="See which distributors and why" sx={{ ml: 0.5, p: 0.25, color: C.navy, '&:hover': { color: C.gold } }}>
                    <InfoOutlinedIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                )}
              </td>
              {cell(a.rejected_trucks, tone(a.rejected_trucks, C.alertRed), (a.rejected_trucks ?? 0) > 0)}
              {cell(a.shifted_dbs, tone(a.shifted_dbs, C.navy), false, trucksLabel(a.shifted_trucks))}
              {cell(a.primary_dbs, tone(a.primary_dbs, C.green), false, trucksLabel(a.primary_ships_trucks))}
              {cell(a.pending_dbs, tone(a.pending_dbs, C.gold), false, trucksLabel(a.pending_trucks))}
              {cell(a.dropped_dbs, tone(a.dropped_dbs, C.alertRed), (a.dropped_dbs ?? 0) > 0)}
            </tr>
          ); })} />
      <Typography sx={{ fontSize: 11.5, color: C.muted, mt: 0.6 }}>
        <b>Shipped before RLM</b> = the engine sent these distributors straight for SO creation (no RLM involved — same as
        ① Sent for SO creation). <b>Shipped after RLM</b> = they were held before RLM (a truck for approval or a 2nd-CFA offer)
        and still went for SO creation once RLM decided; click ⓘ for which and why. Before + after = every distributor that
        went for SO creation. <b>Rejected by RLM · trucks</b> = trucks RLM rejected (they do not ship). <b>Shifted to 2nd CFA</b> /
        <b> Sent from primary CFA</b> = the 2nd-CFA offers: taken by the secondary, or declined and sent from the primary (these are
        part of Shipped after RLM). <b>Pending</b> = RLM has not decided yet (the whole order waits).
      </Typography>
      </Collapse>
      {popup?.kind === 'so' && summary[popup.cfa] && (() => { const s = summary[popup.cfa]; const rows = s.so_db_list ?? []; return (
        <DbListPopup cfa={popup.cfa} eyebrow="Before RLM · engine decision" onClose={() => setPopup(null)}
          title={`${nf(rows.length)} distributor${rows.length === 1 ? '' : 's'} sent for SO creation · ${trucksLabel(s.so_trucks)}`}
          intro="The engine sent these distributors' orders straight for SO creation — no truck waiting for RLM approval and no 2nd-CFA offer."
          rows={rows} cols={[{ label: 'Trucks', num: true, get: (r) => nf(Number(r.trucks)) }, { label: 'OEID', mono: true, get: (r) => String(r.oeid) }]} />
      ); })()}
      {popup?.kind === 'second' && summary[popup.cfa] && (() => { const s = summary[popup.cfa]; const rows = s.second_cfa_db_list ?? []; return (
        <DbListPopup cfa={popup.cfa} eyebrow="Before RLM · engine decision" onClose={() => setPopup(null)}
          title={`${nf(rows.length)} distributor${rows.length === 1 ? '' : 's'} offered to a 2nd CFA`}
          intro="The primary CFA could not fill these orders well enough, so the engine offered each one to a secondary CFA. RLM decides whether the secondary takes it (it ships from there) or the primary sends it."
          rows={rows} cols={[{ label: 'Primary CFA', get: (r) => String(r.primary_cfa) },
            { label: 'Secondary CFA', get: (r) => String(r.secondary_cfa) }]} />
      ); })()}
      {popup?.kind === 'dropped' && summary[popup.cfa] && (() => { const s = summary[popup.cfa]; const rows = s.dropped_db_list ?? []; return (
        <DbListPopup cfa={popup.cfa} eyebrow="Before RLM · engine decision" onClose={() => setPopup(null)}
          title={`${nf(rows.length)} distributor${rows.length === 1 ? '' : 's'} dropped — nothing ships`}
          intro="These distributors passed the demand gate, but every truck the engine could build for them stayed below the 65% fill floor, so the whole order was dropped. Cases dropped includes substitutes and fillers that had been added on top of their own SOQ."
          rows={rows} cols={[{ label: 'Why dropped', get: (r) => String(r.reason) },
            { label: 'SOQ (cases)', num: true, get: (r) => nf(Number(r.soq)) },
            { label: 'Cases dropped', num: true, get: (r) => nf(Number(r.cases_dropped)) }]} />
      ); })()}
      {popup?.kind === 'rlm' && summary[popup.cfa] && (() => { const s = summary[popup.cfa]; const rows = s.rlm_db_list ?? []; return (
        <DbListPopup cfa={popup.cfa} eyebrow="Before RLM · engine decision" onClose={() => setPopup(null)}
          title={`${nf(rows.length)} distributor${rows.length === 1 ? '' : 's'} sent for RLM approval`}
          intro="Each of these distributors has at least one truck that went for RLM approval. Until RLM decides, the whole order waits — so its other trucks are on hold too."
          rows={rows} cols={[{ label: 'Trucks went for RLM', num: true, get: (r) => nf(Number(r.rlm_trucks)) },
            { label: 'Trucks on hold', num: true, get: (r) => nf(Number(r.held_trucks)) }]} />
      ); })()}
      {summaryCfa && summary[summaryCfa]?.rlm_after && (() => { const a = summary[summaryCfa].rlm_after!; const rows = a.after_rlm_rows ?? [];
        const kindOf = (k: unknown) => AFTER_RLM_KINDS.find((x) => x.key === k);
        return (
          <DbListPopup cfa={summaryCfa} eyebrow="After RLM rollup" onClose={() => setSummaryCfa(null)}
            title={`${nf(rows.length)} distributor${rows.length === 1 ? '' : 's'} shipped after RLM`}
            intro="These distributors were on hold before RLM (a truck waiting for approval, or an order offered to a 2nd CFA) and still went for SO creation once the RLM rollup decided."
            rows={rows} cols={[{ label: 'OEID', mono: true, get: (r) => String(r.oeid) },
              { label: 'Reason', get: (r) => (
                <>
                  <div style={{ fontWeight: 700, color: C.navy }}>{kindOf(r.kind)?.title ?? String(r.kind)}</div>
                  <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{kindOf(r.kind)?.what}</div>
                </>
              ) }]} />
        ); })()}
    </Box>
  );
}

// count-up for the headline number — a small satisfying reveal (respects reduced-motion)
function useCountUp(target: number, ms = 700): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setV(target); return; }
    let raf = 0; const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - p, 3))));   // ease-out cubic
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

// small stat inside the (white) hero — big serif number over an uppercase micro-label
function HeroMetric({ label, value, tone = C.navy }: { label: string; value: number; tone?: string }) {
  return (
    <Box>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 24, color: tone, lineHeight: 1 }}>{value.toLocaleString()}</Box>
      <Box sx={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.muted, mt: 0.35 }}>{label}</Box>
    </Box>
  );
}
// legend swatch for the outcome split bar (on the white hero)
function HeroLegend({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
      <Box sx={{ width: 9, height: 9, borderRadius: '2px', bgcolor: color }} />
      <span style={{ fontSize: 11, color: C.muted }}>{label} <b style={{ color: C.slate }}>{value.toLocaleString()}</b></span>
    </Box>
  );
}
// reconciliation as a visual equation — a term chip + an operator glyph
function EqChip({ value, label, color, strong }: { value: number; label: string; color: string; strong?: boolean }) {
  return (
    <Box sx={{ px: 1.25, py: 0.6, borderRadius: `${RADIUS.md}px`, border: `1px solid ${strong ? color : C.border}`,
      bgcolor: strong ? color : '#fff', textAlign: 'center', minWidth: 66, boxShadow: SHADOW.sm }}>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 18, lineHeight: 1, color: strong ? '#fff' : color }}>{value.toLocaleString()}</Box>
      <Box sx={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: strong ? 'rgba(255,255,255,0.85)' : C.muted, mt: 0.35 }}>{label}</Box>
    </Box>
  );
}
function EqOp({ children }: { children: string }) {
  return <Box component="span" sx={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: C.muted, px: 0.25 }}>{children}</Box>;
}

export default function RunPage({ viewDate, onRan, canRun = true }: { viewDate?: string; onRan?: (date: string) => void; canRun?: boolean }) {
  const [date, setDate] = useState(todayStr);   // default to TODAY's date (current date) — DD-Mon-YYYY
  const [dbTarget, setDbTarget] = useState('');
  const [runDisabled, setRunDisabled] = useState(false);   // Run lock — sourced from the BACKEND env via GET /app_config
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [schemaErr, setSchemaErr] = useState<StepEv | null>(null);   // structured "an S3 master's columns changed" error
  const [steps, setSteps] = useState<StepEv[]>([]);   // live pipeline progress (SSE)
  const [audit, setAudit] = useState<AuditRow | null>(null);   // the pipeline run-audit for the header date (slim header + per-CFA stages)
  const [auditLoading, setAuditLoading] = useState(true);      // audit fetch in-flight → show a loading card, never a blank gap
  // `d` omitted (live run) → the backend's latest run; `d` = the header run_date → THAT run's audit (keyed on run_date, like /last_run_summary)
  const loadAudit = (d?: string) => { setAuditLoading(true); return api.pipelineAudit(d)
    .then((r) => setAudit(((r as { runs?: AuditRow[] }).runs ?? [])[0] ?? null)).catch(() => {})
    .finally(() => setAuditLoading(false)); };

  useEffect(() => {
    api.prodHealth().then((h) => setDbTarget((h as { db?: string }).db ?? '')).catch(() => {});
    // The Run lock is owned by the BACKEND env (RUN_DISABLED) — read it at runtime so no frontend/Docker rebuild is
    // needed to flip it. POST /run · /run/start enforce it server-side too, so this only mirrors the state in the UI.
    api.appConfig().then((c) => setRunDisabled(!!(c as { run_disabled?: boolean }).run_disabled)).catch(() => {});
  }, []);

  // Show the summary for the run date selected in the GLOBAL HEADER — re-fetch whenever the header date changes, so
  // the Run page always reflects the chosen run (not just the latest). Blank viewDate → backend returns the latest run.
  // The POST result isn't stored, so this rebuilds it live from the DB (survives refresh). The run-date INPUT above is
  // separate (the SOQ snapshot to run next).
  useEffect(() => {
    if (running) return;                                    // don't clobber a live run's own summary
    api.lastRunSummary(viewDate).then((r) => {
      const res = r as RunResult;
      setResult(res?.available ? res : null);               // show the card for ANY recorded run — incl. 0-allocation (renders 0s)
    }).catch(() => {});
    loadAudit(viewDate);                                   // the run-audit for the SELECTED header date (not just the latest)
  }, [viewDate]);   // eslint-disable-line react-hooks/exhaustive-deps

  // while a run is live, poll the audit so the 10 stages flip PENDING→RUNNING→SUCCESS in real time
  useEffect(() => {
    if (!running) return;
    loadAudit();                                            // live run → the LATEST (running) audit
    const id = setInterval(() => loadAudit(), 2000);        // keep polling the latest while running, not the header date
    return () => clearInterval(id);
  }, [running]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── WORKER-BASED run. The pipeline runs in the BACKEND (POST /run/start) and we TAIL its live progress
  // (/run/progress). Because the run is decoupled from this page, a refresh or a dropped connection never kills it —
  // we just reconnect from the last event we saw. A CRON run streams here too (it writes to the same progress store).
  const esRef = useRef<EventSource | null>(null);
  const lastSeqRef = useRef(0);
  const runningRef = useRef(false);
  useEffect(() => { runningRef.current = running; }, [running]);

  const closeTail = () => { esRef.current?.close(); esRef.current = null; };

  const tail = (since: number) => {
    closeTail();
    lastSeqRef.current = since;
    const es = new EventSource(api.runProgressUrl(since));
    esRef.current = es;
    es.onmessage = (e) => {
      let ev: StepEv & { seq?: number };
      try { ev = JSON.parse(e.data); } catch { return; }
      if (typeof ev.seq === 'number') lastSeqRef.current = ev.seq;   // resume point for a reconnect
      if (ev.phase === '_end' || ev.phase === '_idle') { closeTail(); setRunning(false); return; }
      if (ev.phase === 'done') {
        setSteps((s) => [...s, ev]); setRunning(false); loadAudit();
        onRan?.(ev.date ?? date);   // switch every page's global run date to the one just run + refresh the date list
        // the summary event counts TOTAL allocation (incl RLM-held); pull the SO_CREATION-only summary so the numbers
        // are real created orders (+ the RLM/2nd-CFA held split). Fall back to the event summary if unavailable.
        const fallback = () => {
          const summary = (ev.summary ?? {}) as Record<string, PerCfa>;
          setResult({ date: ev.date ?? date, cfas: Object.keys(summary), summary,
                      orders: { count: Object.values(summary).reduce((a, s) => a + (s.sku_lines || 0), 0) } });
        };
        api.lastRunSummary(ev.date).then((r) => {
          const res = r as RunResult;
          if (res?.available) setResult(res); else fallback();   // 0-allocation run is still available → show its 0-summary
        }).catch(fallback);
      } else if (ev.phase === 'error') {
        if (ev.kind === 'schema_change' || ev.kind === 'master_missing') setSchemaErr(ev); else setErr(ev.label);
        setSteps((s) => [...s, ev]); setRunning(false);
      } else {
        setSteps((s) => [...s, ev]);   // start · clear · stage · table · warning · scope · info · cfas · engine · engine_done · rlm_shift · retry
      }
    };
    es.onerror = () => {               // a dropped connection mid-run → reconnect from the last event (no duplicate replay)
      closeTail();
      if (runningRef.current) setTimeout(() => tail(lastSeqRef.current), 1200);
    };
  };

  // START a run: fire the background worker, then tail it. started=false (a run — manual OR cron — is already live) →
  // we still tail, so clicking Run while one is in flight just attaches to that live log instead of erroring.
  const run = async () => {
    setErr(null); setSchemaErr(null); setResult(null); setSteps([]);
    try {
      await api.runStart(date);
      setRunSource('manual');
      setRunning(true);
      tail(0);
    } catch {
      setErr('Failed to start the run — is the backend up?');
    }
  };

  // On load / refresh: if a run (manual OR cron) is already in flight, reconnect to its live log so the page shows
  // exactly what the pipeline is doing right now — the run keeps going in the backend regardless of this page.
  useEffect(() => {
    api.runCurrent().then((c) => {
      const cur = c as { status?: string; source?: string };
      if (cur.status === 'running') { setRunSource(cur.source ?? null); setRunning(true); tail(0); }
    }).catch(() => {});
    return () => closeTail();
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // While IDLE, keep watching the backend: a run started from ANYWHERE else — the API (POST /run), the daily cron, or
  // another user's browser — is picked up within a few seconds and its live log streams here, no refresh needed.
  const [runSource, setRunSource] = useState<string | null>(null);
  useEffect(() => {
    if (running) return undefined;
    const id = setInterval(() => {
      api.runCurrent().then((c) => {
        const cur = c as { status?: string; source?: string };
        if (cur.status === 'running' && !runningRef.current) {
          setErr(null); setSchemaErr(null); setResult(null); setSteps([]);
          setRunSource(cur.source ?? null); setRunning(true); tail(0);
        }
      }).catch(() => {});
    }, IDLE_POLL_MS);
    return () => clearInterval(id);
  }, [running]);   // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => {
    if (!result) return null;
    const rows = Object.values(result.summary);
    return {
      cases: rows.reduce((a, s) => a + (s.total_allocated_cases || 0), 0),   // TRULY-shipping SO cases (headline reads this)
      lines: result.orders?.count ?? rows.reduce((a, s) => a + (s.sku_lines || 0), 0),
      dbs: rows.reduce((a, s) => a + (s.dbs || 0), 0),
      soHeld: rows.reduce((a, s) => a + (s.so_held_pending_cases || 0), 0),  // SO-ready but held (whole DB waits on a pending truck)
      rlmTruck: rows.reduce((a, s) => a + (s.rlm_truck_cases || 0), 0),      // held for RLM truck approval
      rlmSecond: rows.reduce((a, s) => a + (s.rlm_second_cfa_cases || 0), 0), // sent to a 2nd CFA
      cfas: result.cfas.length,
    };
  }, [result]);

  // a run that allocated NOTHING (0 SO + 0 held) — the card still shows, with 0s and a why-is-it-0 diagnostic
  const nothingAllocated = !!totals && totals.cases === 0 && totals.soHeld === 0 && totals.rlmTruck === 0 && totals.rlmSecond === 0;
  // headline number animates up on reveal; live stream auto-scrolls to the newest event
  const soCount = useCountUp(totals?.cases ?? 0);
  const streamRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { const el = streamRef.current; if (el) el.scrollTop = el.scrollHeight; }, [steps.length]);

  return (
    <Box sx={{ p: { xs: 1.5, sm: 2.5, md: 4 }, maxWidth: 1120, mx: 'auto', fontFamily: SANS }}>
      <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>Production · run the engine</Typography>
      <Typography sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 30, mb: 0.5, lineHeight: 1.1 }}>Run the allocation engine</Typography>
      <PageIntro>
        Enter a <b>run date</b> (the SOQ snapshot to allocate) and click <b>Run pipeline</b> — it runs every CFA with
        delivered demand. One call runs the whole pipeline: channel segregation → CFA-stock reservation → the cascade
        (Step 1 water-fill → Step 2 substitutes → Step 3 filler + truck) → FEFO disaggregation to SKU level.
        Every other page then reflects this run.
      </PageIntro>

      {/* ---- control card ---- */}
      <Box sx={{ border: `1px solid ${C.rule}`, borderTop: `3px solid ${C.navy}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.md, bgcolor: C.white, p: 2.5, mb: 3 }}>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <PdartDatePicker label="Run date (SOQ snapshot)" value={date} onChange={setDate} disabled={running} />
          <Button onClick={run} disabled={!canRun || runDisabled || running || !date.trim()} variant="contained"
            title={!canRun ? 'You do not have run access — ask an admin to grant it' : undefined}
            startIcon={!canRun || runDisabled ? <LockOutlinedIcon /> : running ? <CircularProgress size={16} sx={{ color: '#fff' }} /> : <PlayArrowIcon />}
            sx={{ bgcolor: C.green, fontWeight: 700, px: 3, py: 1, textTransform: 'none', fontSize: 15, boxShadow: SHADOW.sm, '&:hover': { bgcolor: '#256528' } }}>
            {!canRun ? 'No run access' : runDisabled ? 'Today’s run complete' : running ? 'Running…' : 'Run pipeline'}
          </Button>
          <Typography sx={{ fontSize: 12, color: C.muted, alignSelf: 'center', maxWidth: 360, lineHeight: 1.4 }}>
            Results are saved under <b>today's run date ({todayLabel()})</b>; the header shows that date with the
            <b> SOQ</b> date it processed.
          </Typography>
          {!canRun && (
            <Typography sx={{ fontSize: 12, color: C.muted, alignSelf: 'center' }}>
              View only — you can follow runs and the audit here; ask an admin for run access to start one.
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {dbTarget && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: C.muted }}>
              <StorageIcon sx={{ fontSize: 18 }} />
              <Typography sx={{ fontSize: 11.5, fontFamily: MONO, overflowWrap: 'anywhere', minWidth: 0 }}>{dbTarget}</Typography>
            </Box>
          )}
        </Box>
        {runDisabled && (
          <Box sx={{ mt: 1.75, display: 'flex', alignItems: 'center', gap: 1.25, px: 1.75, py: 1.25, borderRadius: `${RADIUS.md}px`,
            bgcolor: C.warnLight, border: `1px solid ${C.goldLight}`, borderLeft: `3px solid ${C.gold}` }}>
            <LockOutlinedIcon sx={{ fontSize: 20, color: C.warnText }} />
            <Typography sx={{ fontSize: 13, color: C.slate }}>
              <b style={{ color: C.warnText }}>Today’s run is already complete.</b> The pipeline is locked for the day — the Run button re-enables in the next run window.
            </Typography>
          </Box>
        )}
        {schemaErr && schemaErr.kind === 'master_missing' && (
          <Box sx={{ mt: 1.75, border: `1px solid ${C.red}`, borderLeft: `4px solid ${C.red}`, borderRadius: `${RADIUS.md}px`, bgcolor: '#FDF3F3', p: 2 }}>
            <Typography sx={{ fontWeight: 800, color: C.red, fontSize: 14, mb: 0.5 }}>
              ⚠ Master not present in S3 — pipeline stopped at staging
            </Typography>
            <Typography sx={{ fontSize: 13, color: C.slate, mb: 1.25 }}>
              The master <b>{schemaErr.table}</b> has no delta table in S3 for this environment, so it can't be staged.
              This is a <b>missing data source</b>, not a bug in the engine.
            </Typography>
            {schemaErr.path && (
              <Box sx={{ mb: 1.25 }}>
                <Typography sx={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: C.muted, mb: 0.3 }}>No delta table found at</Typography>
                <Box sx={{ fontFamily: 'Consolas, monospace', fontSize: 12, color: C.red, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{schemaErr.path}</Box>
              </Box>
            )}
            <Typography sx={{ fontSize: 12, color: C.muted }}>
              Fix: publish <b>{schemaErr.table}</b> to this environment's S3 bucket, or set <b style={{ fontFamily: 'Consolas, monospace', color: C.navy }}>S3_ENV</b> to an environment that has it, then re-run.
            </Typography>
          </Box>
        )}
        {schemaErr && schemaErr.kind !== 'master_missing' && (
          <Box sx={{ mt: 1.75, border: `1px solid ${C.red}`, borderLeft: `4px solid ${C.red}`, borderRadius: `${RADIUS.md}px`, bgcolor: '#FDF3F3', p: 2 }}>
            <Typography sx={{ fontWeight: 800, color: C.red, fontSize: 14, mb: 0.5 }}>
              ⚠ Master-data schema changed — pipeline stopped at staging
            </Typography>
            <Typography sx={{ fontSize: 13, color: C.slate, mb: 1.25 }}>
              The master <b>{schemaErr.table}</b> could not be read from S3 — the data team renamed/changed its columns.
              This is a <b>data-source change</b>, not a bug in the engine.
            </Typography>
            <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap', mb: 1.25 }}>
              <Box sx={{ minWidth: 220 }}>
                <Typography sx={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: C.muted, mb: 0.3 }}>Expected but now missing</Typography>
                <Box sx={{ fontFamily: 'Consolas, monospace', fontSize: 12, color: C.red, whiteSpace: 'pre-wrap' }}>{(schemaErr.missing ?? []).join('\n')}</Box>
              </Box>
              <Box sx={{ minWidth: 220 }}>
                <Typography sx={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: C.muted, mb: 0.3 }}>Actually in the S3 file now</Typography>
                <Box sx={{ fontFamily: 'Consolas, monospace', fontSize: 12, color: C.slate, whiteSpace: 'pre-wrap' }}>{(schemaErr.available ?? []).join('\n')}</Box>
              </Box>
            </Box>
            <Typography sx={{ fontSize: 12, color: C.muted }}>
              Fix: update the column mapping in <b style={{ fontFamily: 'Consolas, monospace', color: C.navy }}>db/source_schemas/{schemaErr.table}.py</b> to the new names, then re-run.
            </Typography>
          </Box>
        )}
        {err && <Typography sx={{ color: C.red, mt: 1.5, fontSize: 13 }}>Run failed: {err}</Typography>}
      </Box>

      {/* ---- LIVE engine console — the streaming "socket": each S3 fetch + each CFA as it happens ---- */}
      {(running || steps.length > 0) && !result && (
        <Box className="aiden-live" sx={{ position: 'relative', overflow: 'hidden', borderRadius: `${RADIUS.lg}px`, mb: 3,
          bgcolor: '#fff', border: `1px solid ${C.border}`, boxShadow: SHADOW.lg }}>
          <style>{`
            @keyframes aidenPing { 0%{transform:scale(1);opacity:.5} 80%,100%{transform:scale(2.6);opacity:0} }
            @keyframes aidenSweep { 0%{left:-40%} 100%{left:100%} }
            @keyframes aidenRowIn { from{opacity:0;transform:translateY(5px)} to{opacity:1;transform:translateY(0)} }
            @keyframes aidenBlink { 0%,100%{opacity:.25} 50%{opacity:1} }
            @keyframes aidenSpin { to { transform: rotate(360deg) } }
            @keyframes aidenCaret { 50% { opacity: 0 } }
            @keyframes aidenTop { 0%{background-position:0% 0} 100%{background-position:200% 0} }
            @media (prefers-reduced-motion: reduce){ .aiden-live *{ animation:none !important } }
          `}</style>
          {/* animated green→gold top accent — the "magic" edge on white */}
          <Box aria-hidden sx={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, zIndex: 3,
            background: `linear-gradient(90deg, ${C.green}, ${C.gold}, ${C.green})`, backgroundSize: '200% 100%',
            ...(running ? { animation: 'aidenTop 3s linear infinite' } : {}) }} />
          {/* faint rotating aurora + soft corner glows (green/gold on white) */}
          {running && <Box aria-hidden sx={{ position: 'absolute', top: '-45%', left: '-12%', width: '124%', height: '190%', zIndex: 0, pointerEvents: 'none', opacity: 0.10, filter: 'blur(50px)',
            background: 'conic-gradient(from 0deg, rgba(33,163,102,0), rgba(33,163,102,0.6), rgba(217,138,0,0.5), rgba(33,163,102,0))',
            animation: 'aidenSpin 10s linear infinite' }} />}
          <Box aria-hidden sx={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
            background: 'radial-gradient(500px 180px at 10% -20%, rgba(33,163,102,0.08), transparent 60%), radial-gradient(440px 200px at 100% 120%, rgba(217,138,0,0.07), transparent 60%)' }} />

          {/* header */}
          <Box sx={{ position: 'relative', zIndex: 2, px: 2.25, pt: 2.25, pb: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
              <Box sx={{ position: 'relative', width: 10, height: 10, flexShrink: 0 }}>
                <Box sx={{ position: 'absolute', inset: 0, borderRadius: '50%', bgcolor: running ? C.green : C.muted }} />
                {running && <Box sx={{ position: 'absolute', inset: 0, borderRadius: '50%', bgcolor: C.green, animation: 'aidenPing 1.5s cubic-bezier(0,0,0.2,1) infinite' }} />}
              </Box>
              <Typography sx={{ fontWeight: 800, color: C.navy, fontSize: 14.5, letterSpacing: '.01em' }}>
                {running ? 'Engine running' : 'Run finished'} · <span style={{ fontFamily: MONO, color: C.gold }}>{date}</span>
                {runSource && <span style={{ color: C.muted, fontWeight: 600, fontSize: 12 }}> · {SOURCE_LABEL[runSource] ?? runSource}</span>}
              </Typography>
              <Box sx={{ flex: 1 }} />
              <Typography sx={{ fontSize: 11.5, color: C.muted, fontFamily: MONO }}>{steps.length} event{steps.length === 1 ? '' : 's'}</Typography>
            </Box>
            <Typography sx={{ fontSize: 12, color: C.muted, mt: 0.5 }}>
              fetch masters + SOQ → scope cfa/db inventory to the SOQ → allocate each CFA
            </Typography>
            {/* shimmer progress rail */}
            <Box sx={{ position: 'relative', mt: 1.25, height: 4, borderRadius: 2, overflow: 'hidden', bgcolor: C.grayP }}>
              {running
                ? <Box sx={{ position: 'absolute', top: 0, bottom: 0, width: '38%', borderRadius: 2, background: `linear-gradient(90deg, transparent, ${C.green}, ${C.gold}, transparent)`, animation: 'aidenSweep 1.6s ease-in-out infinite' }} />
                : <Box sx={{ position: 'absolute', inset: 0, bgcolor: C.green }} />}
            </Box>
          </Box>

          {/* stream */}
          <Box ref={streamRef} sx={{ position: 'relative', zIndex: 2, maxHeight: 220, overflowY: 'auto', px: 1.25, pb: 1.5,
            '&::-webkit-scrollbar': { width: 8 }, '&::-webkit-scrollbar-thumb': { background: C.border, borderRadius: 8 } }}>
            {steps.map((s, i) => {
              const isTable = s.phase === 'table';
              const done = s.phase === 'engine_done';
              const isErr = s.phase === 'error';
              const isWarn = s.phase === 'warning';                 // e.g. the DRR not published for the data date
              const isLast = i === steps.length - 1;
              const glyph = isErr ? '✕' : done ? '✓' : isTable ? '↓' : isWarn ? '!' : '▸';
              const gc = isErr ? C.red : done ? C.green : isTable ? C.navy : isWarn ? C.warnText : C.gold;
              return (
                <Box key={i} sx={{ display: 'flex', alignItems: 'baseline', gap: 1, px: 1.25, py: 0.5, borderRadius: 1,
                  fontFamily: MONO, fontSize: 12.5,
                  bgcolor: isLast && running ? 'rgba(33,163,102,0.08)' : 'transparent',
                  animation: isLast ? 'aidenRowIn 0.35s ease-out' : 'none' }}>
                  <span style={{ color: C.muted, width: 22, textAlign: 'right', flexShrink: 0 }}>{i + 1}</span>
                  <span style={{ color: gc, fontWeight: 800, flexShrink: 0 }}>{glyph}</span>
                  <span style={{ fontWeight: isTable || done || isWarn ? 700 : 500, color: done ? C.green : isErr ? C.red : isWarn ? C.warnText : C.slate }}>{s.label}</span>
                  {isLast && running && <span style={{ color: C.green, marginLeft: 2, animation: 'aidenCaret 1s step-end infinite' }}>▋</span>}
                  {s.rows != null && <span style={{ color: C.navy, marginLeft: 'auto', fontWeight: 700, whiteSpace: 'nowrap' }}>{nf(s.rows)} rows</span>}
                  {s.secs != null && <span style={{ color: C.muted, width: 52, textAlign: 'right', flexShrink: 0, marginLeft: s.rows != null ? 0 : 'auto' }}>{s.secs}s</span>}
                </Box>
              );
            })}
            {running && steps.length === 0 && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1.75, color: C.muted, fontFamily: SANS, fontSize: 13 }}>
                <Box sx={{ display: 'flex', gap: 0.5 }}>
                  {[0, 1, 2].map((d) => <Box key={d} sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: C.green, animation: `aidenBlink 1s ease-in-out ${d * 0.16}s infinite` }} />)}
                </Box>
                Connecting to the pipeline…
              </Box>
            )}
          </Box>
        </Box>
      )}

      {/* ---- result ---- */}
      {result && totals && (
        <>
          {/* HERO — premium WHITE result banner: the headline number, framed as the win */}
          {(() => {
            const held = totals.soHeld + totals.rlmTruck + totals.rlmSecond;
            const alloc = totals.cases + held || 1;
            const cw = (totals.cases / alloc) * 100;
            const hw = (held / alloc) * 100;
            return (
              <Box sx={{ position: 'relative', overflow: 'hidden', borderRadius: `${RADIUS.lg}px`, p: 3, mb: 2.5,
                bgcolor: '#fff', color: C.slate, border: `1px solid ${C.border}`, borderLeft: `4px solid ${nothingAllocated ? C.gold : C.green}`, boxShadow: SHADOW.lg }}>
                {/* soft green/gold corner glows on white */}
                <Box aria-hidden sx={{ position: 'absolute', inset: 0, pointerEvents: 'none',
                  background: 'radial-gradient(460px 180px at 92% -25%, rgba(33,163,102,0.10), transparent 60%), radial-gradient(380px 190px at 0% 120%, rgba(217,138,0,0.07), transparent 60%)' }} />

                {/* top row: status + the number */}
                <Box sx={{ position: 'relative', zIndex: 2, display: 'flex', alignItems: 'flex-end', gap: 3, flexWrap: 'wrap' }}>
                  <Box sx={{ minWidth: 200 }}>
                    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.85, px: 1, py: 0.4, mb: 1.25, borderRadius: 999,
                      bgcolor: nothingAllocated ? C.amberP : C.greenP, border: `1px solid ${(nothingAllocated ? C.gold : C.green)}44` }}>
                      <span style={{ width: 16, height: 16, borderRadius: '50%', background: nothingAllocated ? C.gold : C.green, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 900 }}>{nothingAllocated ? '!' : '✓'}</span>
                      <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase', color: nothingAllocated ? C.warnText : C.green }}>{nothingAllocated ? 'No allocation' : 'Allocation complete'}</span>
                    </Box>
                    <Typography sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 26, color: C.navy, lineHeight: 1.05 }}>Run results</Typography>
                    <Typography sx={{ fontSize: 12.5, color: C.muted, mt: 0.5 }}>
                      ran <b style={{ color: C.slate }}>{result.date}</b>{result.data_date ? <> · SOQ <b style={{ color: C.gold }}>{result.data_date}</b></> : null} · {totals.cfas} CFA{totals.cfas > 1 ? 's' : ''}
                    </Typography>
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 12 }} />
                  <Box sx={{ textAlign: 'right' }}>
                    <Typography sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase', color: C.muted }}>SO cases created</Typography>
                    <Typography sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 64, color: nothingAllocated ? C.muted : C.green, lineHeight: 1 }}>{nf(soCount)}</Typography>
                    <Typography sx={{ fontSize: 12, color: C.muted, mt: 0.5 }}>{nothingAllocated ? 'nothing to ship' : 'shipping to SAP'}</Typography>
                  </Box>
                </Box>

                {/* bottom row: mini-metrics + outcome split bar */}
                <Box sx={{ position: 'relative', zIndex: 2, mt: 2.25, pt: 2, borderTop: `1px solid ${C.border}`, display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
                  <HeroMetric label="SKU order lines" value={totals.lines} tone={C.navy} />
                  <HeroMetric label="Distributors served" value={totals.dbs} tone={C.navy} />
                  <HeroMetric label="On hold · RLM" value={held} tone={C.gold} />
                  <Box sx={{ flex: 1, minWidth: 220 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.6 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: C.muted }}>Allocated outcome</span>
                      <span style={{ fontSize: 11, color: C.slate, fontFamily: MONO }}>{Math.round(cw)}% ships now</span>
                    </Box>
                    <Box sx={{ display: 'flex', height: 9, borderRadius: 999, overflow: 'hidden', bgcolor: C.grayP }}>
                      {totals.cases > 0 && <Box sx={{ width: `${cw}%`, background: `linear-gradient(90deg,${C.green},#5EE0A0)` }} />}
                      {held > 0 && <Box sx={{ width: `${hw}%`, background: `linear-gradient(90deg,${C.gold},#FDD666)` }} />}
                    </Box>
                    <Box sx={{ display: 'flex', gap: 2, mt: 0.7 }}>
                      <HeroLegend color={C.green} label="Sent for SO creation" value={totals.cases} />
                      {held > 0 && <HeroLegend color={C.gold} label="On hold" value={held} />}
                    </Box>
                  </Box>
                </Box>
              </Box>
            );
          })()}

          {/* WHY-IS-IT-0 — a 0-allocation run shows its input row counts so the cause is visible at a glance */}
          {nothingAllocated && result.diagnostics && (
            <Box sx={{ mb: 2.5, p: 2, borderRadius: `${RADIUS.md}px`, bgcolor: C.amberP, border: `1px solid ${C.border}`, borderLeft: `4px solid ${C.gold}` }}>
              <Typography sx={{ fontSize: 13.5, fontWeight: 800, color: C.warnText, mb: 0.5 }}>▸ Nothing was allocated for this run</Typography>
              <Typography sx={{ fontSize: 12.5, color: C.slate, mb: 1.25 }}>{diagReason(result.diagnostics)}</Typography>
              <Box sx={{ display: 'flex', gap: 1.25, flexWrap: 'wrap' }}>
                {([['SOQ rows', result.diagnostics.soq_rows], ['Filtered SOQ rows', result.diagnostics.filtered_soq_rows], ['CFA inventory rows', result.diagnostics.cfa_inventory_rows]] as const).map(([label, value]) => (
                  <Box key={label} sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, px: 1.25, py: 0.6, borderRadius: `${RADIUS.sm}px`, bgcolor: '#fff', border: `1px solid ${C.border}` }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted }}>{label}</span>
                    <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 800, color: value > 0 ? C.slate : C.alertRed }}>{nf(value)}</span>
                  </Box>
                ))}
              </Box>
            </Box>
          )}

          {/* HELD / PENDING — gold, only when something waits on RLM; otherwise an all-clear note */}
          {(totals.soHeld + totals.rlmTruck + totals.rlmSecond) > 0 ? (
            <>
              <Typography sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.gold, mb: 0.85 }}>On hold · waits on the RLM 15:30 decision</Typography>
              <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 1.25 }}>
                <Kpi label="Held · RLM approval" value={nf(totals.rlmTruck)} sub="cases on pending truck(s)" tone={C.gold} />
                <Kpi label="SO-ready · on hold" value={nf(totals.soHeld)} sub="whole DB held by a pending truck" tone={C.gold} />
                <Kpi label="Sent to 2nd CFA" value={nf(totals.rlmSecond)} sub="RLM 2nd-CFA pending" tone={C.gold} />
              </Box>
            </>
          ) : (
            <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, px: 1.5, py: 0.75, mb: 1.5, borderRadius: 999, bgcolor: C.greenP, color: C.green, fontWeight: 700, fontSize: 13 }}>
              ✓ All clear — nothing on hold, every allocated case ships.
            </Box>
          )}
          {/* reconciliation — a clean equation, not a wall of muted text */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', mb: 2.25 }}>
            <EqChip value={totals.cases} label="Sent for SO creation" color={C.green} />
            <EqOp>+</EqOp>
            <EqChip value={totals.rlmTruck} label="Sent for RLM approval" color={C.gold} />
            <EqOp>+</EqOp>
            <EqChip value={totals.soHeld} label="SO-held" color={C.gold} />
            <EqOp>+</EqOp>
            <EqChip value={totals.rlmSecond} label="2nd-CFA" color={C.gold} />
            <EqOp>=</EqOp>
            <EqChip value={totals.cases + totals.soHeld + totals.rlmTruck + totals.rlmSecond} label="allocated" color={C.navy} strong />
            <Typography sx={{ fontSize: 11, color: C.muted, ml: 1, maxWidth: 250, lineHeight: 1.4 }}>
              all figures in <b>cases</b> (Σ SKU_Qty) · a CFA×DB with any pending RLM truck is held <b>whole</b>
            </Typography>
          </Box>
          <FunnelTable summary={result.summary} cfas={result.cfas} />
          <Typography sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: '1.15rem', color: C.navy, mb: 1 }}>Per-CFA allocation</Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {result.cfas.map((c) => result.summary[c] && <CfaCard key={c} cfa={c} s={result.summary[c]} />)}
          </Box>
        </>
      )}

      {/* ---- Pipeline Run Audit — dot-per-stage, at the END of the page (live-polled while a run is in progress) ---- */}
      <AuditSection audit={audit} loading={auditLoading} />
    </Box>
  );
}
