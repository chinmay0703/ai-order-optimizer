import { useEffect, useMemo, useState } from 'react';
import { Box, Stack } from '@mui/material';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { downloadXlsx, ExportXlsxButton } from '../../shared/exportXlsx';

/* ---------------------------------------------------------------------------
   Data QA — ~100 live data-quality checks over the staged master + feed tables
   for the selected run date. QA-ONLY (frontend), computed on request via
   /api/v1/data_tests, nothing stored. As fresh data lands each day, this validates
   every table the pipeline fetches & saves: nulls, ID zero-padding, reg-zsku
   format, ranges, duplicates, and cross-table integrity (MRP vs material master,…).
--------------------------------------------------------------------------- */
type Status = 'pass' | 'fail' | 'warn' | 'skip' | 'error';
type Phase = 'pre' | 'post';
interface Test { number: number; id: string; table: string; category: string; severity: string; title: string; phase: Phase; status: Status; status_label: string; reason: string; bad: number; total: number; example: string | null; detail: string | null; has_detail?: boolean; }
// COMPLEX QA — inspection queries that return a full result TABLE (columns + rows), not a pass/fail count
type CxVal = string | number | boolean | null;
interface ComplexQ { id: string; title: string; description: string; sql: string; status: string; columns: string[]; rows: CxVal[][]; row_count: number; detail: string | null; }
interface Payload { date: string; total: number; summary: Record<string, number>; phase_summary?: Record<Phase, Record<string, number>>; tests: Test[]; complex?: ComplexQ[]; }

// the page runs in two phases: BEFORE the engine (input / master data quality + cross-table leak checks) and
// AFTER the engine (reconciliation of its own output tables for the date).
const PHASES: { key: Phase; label: string; blurb: string }[] = [
  { key: 'pre', label: 'Pre-OR-Run', blurb: 'Input & master data quality + connected cross-table leak checks — validated on the staged S3 data BEFORE the engine runs.' },
  { key: 'post', label: 'Post-OR-Run', blurb: 'Reconciliation of the engine’s OWN output for this date — truck packing, shipped vs allocated, order archive, SAP orders, RLM.' },
];

const STY: Record<Status, { bg: string; fg: string; label: string }> = {
  pass:  { bg: '#e9f4ec', fg: '#21A366', label: 'Passed' },
  fail:  { bg: '#f8e9e6', fg: '#DC2C25', label: 'Failed' },
  warn:  { bg: '#fbf1e0', fg: '#D98A00', label: 'Warning' },
  skip:  { bg: '#f1f5f9', fg: '#7A756D', label: 'Skipped' },
  error: { bg: '#3a1414', fg: '#ffb4a2', label: 'Error' },
};
const GRID = '52px minmax(0,1.35fr) 104px minmax(0,1.75fr)';   // #  ·  Test case  ·  Status  ·  Reason
const nf = (n: number) => (Number(n) || 0).toLocaleString();

// COMPLEX QA card — a query's full result set as a table (bool cells rendered as TRUE/FALSE chips), with the SQL on demand.
function ComplexCard({ q }: { q: ComplexQ }) {
  const [open, setOpen] = useState(false);       // collapsible — default CLOSED
  const [showSql, setShowSql] = useState(false);
  return (
    <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'hidden' }}>
      <Box onClick={() => setOpen((v) => !v)} sx={{ cursor: 'pointer', px: 2, py: 1.1, bgcolor: '#F4F3F1', borderBottom: open ? `1px solid ${C.rule}` : 'none', '&:hover': { bgcolor: '#eceae6' } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Box sx={{ fontFamily: MONO, fontWeight: 800, color: C.navy, fontSize: 13, width: 12, textAlign: 'center' }}>{open ? '▾' : '▸'}</Box>
          <Box sx={{ fontFamily: MONO, fontWeight: 800, color: C.navy, fontSize: 13 }}>{q.id}</Box>
          <Box sx={{ fontWeight: 700, color: C.slate, fontSize: 14, minWidth: 0 }}>{q.title}</Box>
          <Box sx={{ flex: 1 }} />
          {q.status === 'error'
            ? <Box sx={{ px: 1, py: 0.2, borderRadius: 1, fontSize: 11, fontWeight: 800, bgcolor: STY.error.bg, color: STY.error.fg }}>Error</Box>
            : <Box sx={{ px: 1, py: 0.2, borderRadius: 1, fontSize: 11, fontWeight: 800, bgcolor: STY.pass.bg, color: STY.pass.fg }}>{nf(q.row_count)} rows</Box>}
          {open && (
            <Box onClick={(e) => { e.stopPropagation(); setShowSql((v) => !v); }} sx={{ cursor: 'pointer', px: 1, py: 0.2, borderRadius: 1, fontSize: 11, fontWeight: 700, border: `1px solid ${C.rule}`, color: C.navy, bgcolor: '#fff' }}>
              {showSql ? 'Hide SQL' : 'Show SQL'}
            </Box>
          )}
        </Box>
        <Box sx={{ fontSize: 12.5, color: C.muted, mt: 0.5, lineHeight: 1.4 }}>{q.description}</Box>
      </Box>
      {open && (<>
      {showSql && (
        <Box component="pre" sx={{ m: 0, px: 2, py: 1.5, bgcolor: '#0F1E33', color: '#d7e3f4', fontFamily: MONO, fontSize: 11.5, lineHeight: 1.5, overflowX: 'auto', whiteSpace: 'pre' }}>{q.sql}</Box>
      )}
      {q.status === 'error'
        ? <Box sx={{ p: 2, color: STY.error.fg, fontSize: 12.5, fontFamily: MONO }}>{q.detail}</Box>
        : (
          <Box sx={{ overflowX: 'auto' }}>
            <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
              <Box component="thead">
                <Box component="tr">
                  {q.columns.map((c) => (
                    <Box component="th" key={c} sx={{ textAlign: 'left', px: 1.25, py: 0.85, bgcolor: C.navy, color: '#fff', fontWeight: 700, whiteSpace: 'nowrap', fontFamily: MONO, fontSize: 11.5 }}>{c}</Box>
                  ))}
                </Box>
              </Box>
              <Box component="tbody">
                {q.rows.length === 0
                  ? <Box component="tr"><Box component="td" colSpan={q.columns.length} sx={{ px: 1.25, py: 1.25, color: C.muted }}>No rows.</Box></Box>
                  : q.rows.map((row, i) => (
                    <Box component="tr" key={i} sx={{ bgcolor: i % 2 ? '#faf6ee' : '#fff' }}>
                      {row.map((v, j) => (
                        <Box component="td" key={j} sx={{ px: 1.25, py: 0.6, borderTop: '1px solid #eef2f7', whiteSpace: 'nowrap', textAlign: typeof v === 'number' ? 'right' : 'left', fontVariantNumeric: 'tabular-nums', color: C.slate }}>
                          {typeof v === 'boolean'
                            ? <Box component="span" sx={{ px: 0.8, py: 0.15, borderRadius: 1, fontSize: 11, fontWeight: 800, bgcolor: v ? STY.pass.bg : STY.fail.bg, color: v ? STY.pass.fg : STY.fail.fg }}>{v ? 'TRUE' : 'FALSE'}</Box>
                            : (v === null ? <Box component="span" sx={{ color: C.muted }}>—</Box> : String(v))}
                        </Box>
                      ))}
                    </Box>
                  ))}
              </Box>
            </Box>
          </Box>
        )}
      </>)}
    </Box>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
    <Box sx={{ maxWidth: 1320, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
      <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>
        Data QA · master &amp; feed validation
      </Box>
      <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: '6px 0 8px' }}>
        Data Quality Tests
      </Box>
      {children}
    </Box>
  </Box>
);

export default function DataTestsPage({ date }: { date?: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from data===null: a 0-check payload,
  const [err, setErr] = useState<string | null>(null);   // or a failure, would then spin on "Running checks…" forever
  const [nonce, setNonce] = useState(0);            // bumped by the error Retry to re-run the effect
  const [flt, setFlt] = useState<'all' | 'issues' | Status>('issues');
  const [q, setQ] = useState('');
  const [dl, setDl] = useState('');   // id of the test whose offending-rows Excel is currently downloading

  async function downloadDetail(t: Test) {
    setDl(t.id);
    try {
      const r = await api.dataTestDetail(t.id, date) as { columns: string[]; rows: (string | number | boolean | null)[][]; detail: string | null; truncated?: boolean };
      if (!r.columns?.length) { window.alert(r.detail || 'No row-level detail available for this check.'); return; }
      downloadXlsx(`qa_${t.id}_${t.table}`, r.columns, r.rows);
      if (r.truncated) window.alert(`Downloaded the first ${r.rows.length.toLocaleString()} offending rows (capped).`);
    } catch (e) { window.alert('Download failed: ' + (e instanceof Error ? e.message : String(e))); }
    finally { setDl(''); }
  }

  useEffect(() => {
    let alive = true; setData(null); setErr(null); setLoading(true);
    api.dataTests(date).then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [date, nonce]);

  const needle = q.trim().toLowerCase();
  const tests = useMemo(() => (data?.tests ?? []).filter((t) => {
    if (flt === 'issues' && !(t.status === 'fail' || t.status === 'warn' || t.status === 'error')) return false;
    if (flt !== 'all' && flt !== 'issues' && t.status !== flt) return false;
    if (needle && !`#${t.number} ${t.table} ${t.title} ${t.category} ${t.reason} ${t.example ?? ''}`.toLowerCase().includes(needle)) return false;
    return true;
  }), [data, flt, needle]);

  // group by PHASE first (Pre-OR-Run / Post-OR-Run), then by table within each phase
  const phaseGroups = useMemo(() => PHASES.map((ph) => {
    const inPhase = tests.filter((t) => (t.phase ?? 'pre') === ph.key);
    const m = new Map<string, Test[]>();
    for (const t of inPhase) { const a = m.get(t.table) ?? []; a.push(t); m.set(t.table, a); }
    return { ...ph, tables: [...m.entries()], count: inPhase.length };
  }), [tests]);

  if (err) return <Shell><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (loading) return <Shell><PageSkeleton kpis={5} rows={10} /></Shell>;
  if (!data) return <Shell><EmptyState title="No checks ran for this date"
    hint="The QA run returned nothing for this date — the staged tables may not be loaded yet. Try another run date, or run the pipeline first." /></Shell>;

  const s = data.summary;
  const Kpi = ({ k, label }: { k: Status; label: string }) => (
    <Box onClick={() => setFlt((cur) => (cur === k ? 'all' : k))}
      sx={{ flex: 1, cursor: 'pointer', border: `1px solid ${C.rule}`, borderLeft: `3px solid ${STY[k].fg}`,
        borderRadius: `${RADIUS.md}px`, boxShadow: flt === k ? `0 0 0 2px ${STY[k].fg}55` : SHADOW.sm, p: 1.5, bgcolor: C.white }}>
      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.muted }}>{label}</Box>
      <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 26, color: STY[k].fg, lineHeight: 1.1 }}>{nf(s[k] ?? 0)}</Box>
    </Box>
  );

  return (
    <Shell>
      <Box sx={{ fontSize: 14, color: C.slate, lineHeight: 1.5, maxWidth: 1000, mb: 1.5 }}>
        <b>{data.total}</b> live checks for <b>{data.date}</b>, in two sections: <b>Pre-OR-Run</b> validates the input &amp;
        master data before the engine — completeness, formats, ranges, duplicates, and connected cross-table leak
        checks (demand with no CFA stock, DBs missing a tier, duplicated feeds); <b>Post-OR-Run</b> reconciles the
        engine&apos;s own output for the date (truck packing, shipped vs allocated, order archive, SAP orders, RLM).
        Computed on request — <b>nothing is stored</b>. Change the date up top to validate a different day&apos;s data.
      </Box>

      <Box sx={{ display: 'flex', gap: 1.5, mb: 2 }}>
        <Kpi k="pass" label="Passed" /><Kpi k="fail" label="Failed" /><Kpi k="warn" label="Warnings" />
        <Kpi k="skip" label="Skipped" />{(s.error ?? 0) > 0 && <Kpi k="error" label="Errors" />}
      </Box>

      <Box sx={{ display: 'flex', gap: 1, mb: 1.75, flexWrap: 'wrap', alignItems: 'center' }}>
        {(['issues', 'all', 'fail', 'warn', 'pass', 'skip'] as const).map((f) => (
          <Box key={f} onClick={() => setFlt(f)} sx={{ cursor: 'pointer', px: 1.5, py: 0.5, borderRadius: `${RADIUS.sm}px`, fontSize: 12.5, fontWeight: 700,
            textTransform: 'capitalize', border: `1px solid ${flt === f ? C.navy : C.rule}`, bgcolor: flt === f ? C.navy : '#fff', color: flt === f ? '#fff' : C.slate }}>
            {f === 'issues' ? 'Issues only' : f}
          </Box>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by table / check / example…"
          style={{ flex: 1, minWidth: 240, padding: '8px 12px', fontSize: 13, fontFamily: SANS, border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm }} />
        <ExportXlsxButton label="Export Excel" onClick={() => downloadXlsx('data_qa_checks',
          ['#', 'Test ID', 'Table', 'Category', 'Severity', 'Test case', 'Phase', 'Status', 'Reason', 'Bad', 'Total', 'Example'],
          (data.tests ?? []).map((t) => [t.number, t.id, t.table, t.category, t.severity, t.title, t.phase, t.status_label, t.reason, t.bad, t.total, t.example]))} />
      </Box>
      <Box sx={{ fontSize: 12, color: C.muted, mb: 1 }}>{nf(tests.length)} check{tests.length === 1 ? '' : 's'} shown</Box>

      <Stack spacing={4}>
        {phaseGroups.map((ph) => {
          // always render BOTH section headers (with the full per-phase summary), even when the active filter hides
          // every row — so the user always sees the two sections exist. Only hide a phase that has NO checks at all.
          const ps = data.phase_summary?.[ph.key];
          const totalInPhase = (data.tests ?? []).filter((t) => (t.phase ?? 'pre') === ph.key).length;
          if (totalInPhase === 0) return null;
          return (
            <Box key={ph.key}>
              {/* PHASE section header — Pre-OR-Run / Post-OR-Run */}
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 1.5, pb: 0.85, borderBottom: `2px solid ${C.navy}`, flexWrap: 'wrap' }}>
                <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.gold }}>
                  {ph.key === 'pre' ? 'Section 1' : 'Section 2'}
                </Box>
                <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 20, color: C.navy }}>{ph.label}</Box>
                <Box sx={{ fontSize: 12.5, color: C.muted, flex: 1, minWidth: 200 }}>{ph.blurb}</Box>
                {ps && (['fail', 'warn', 'pass', 'skip'] as Status[]).map((k) => ((ps[k] ?? 0) > 0
                  ? <Box key={k} sx={{ px: 1, py: 0.2, borderRadius: 1, fontSize: 11, fontWeight: 800, bgcolor: STY[k].bg, color: STY[k].fg }}>{nf(ps[k])} {k}</Box>
                  : null))}
              </Box>
              {ph.tables.length === 0 && (
                <Box sx={{ p: 2, textAlign: 'center', color: C.muted, fontSize: 12.5, border: `1px dashed ${C.rule}`, borderRadius: `${RADIUS.md}px` }}>
                  All {totalInPhase} check{totalInPhase === 1 ? '' : 's'} in this section pass — switch the filter to “All” to see them.
                </Box>
              )}
              <Stack spacing={2}>
                {ph.tables.map(([table, ts]) => {
                  const fails = ts.filter((t) => t.status === 'fail' || t.status === 'error').length;
                  const warns = ts.filter((t) => t.status === 'warn').length;
                  return (
                    <Box key={table} sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'hidden' }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1.1, bgcolor: '#F4F3F1', borderBottom: `1px solid ${C.rule}` }}>
                        <Box sx={{ fontFamily: MONO, fontWeight: 800, color: C.navy, fontSize: 14 }}>{table}</Box>
                        <Box sx={{ flex: 1 }} />
                        {fails > 0 && <Box sx={{ px: 1, py: 0.2, borderRadius: 1, fontSize: 11, fontWeight: 800, bgcolor: STY.fail.bg, color: STY.fail.fg }}>{fails} fail</Box>}
                        {warns > 0 && <Box sx={{ px: 1, py: 0.2, borderRadius: 1, fontSize: 11, fontWeight: 800, bgcolor: STY.warn.bg, color: STY.warn.fg }}>{warns} warn</Box>}
                        <Box sx={{ fontSize: 11.5, color: C.muted }}>{ts.length} checks</Box>
                      </Box>
                      <Box sx={{ display: 'grid', gridTemplateColumns: GRID, gap: 1.25, px: 2, py: 0.55, borderTop: `1px solid #eef2f7`,
                        fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: C.muted, bgcolor: '#fcfcfa' }}>
                        <Box>#</Box><Box>Test case</Box><Box>Status</Box><Box>Reason</Box>
                      </Box>
                      {ts.map((t) => (
                        <Box key={t.id} sx={{ display: 'grid', gridTemplateColumns: GRID, gap: 1.25, alignItems: 'center', px: 2, py: 0.85, borderTop: `1px solid #eef2f7` }}>
                          <Box sx={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: C.muted }}>{t.number}</Box>
                          <Box sx={{ fontSize: 13.5, color: C.slate, fontWeight: (t.status === 'fail' || t.status === 'error') ? 700 : 500, minWidth: 0 }}>{t.title}</Box>
                          <Box sx={{ justifySelf: 'start', px: 1, py: 0.28, borderRadius: 1, fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap', bgcolor: STY[t.status].bg, color: STY[t.status].fg }}>{t.status_label || STY[t.status].label}</Box>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                            <Box sx={{ flex: 1, fontSize: 12.5, lineHeight: 1.4, color: (t.status === 'fail' || t.status === 'error') ? STY[t.status].fg : C.muted, minWidth: 0 }}>{t.reason}</Box>
                            {(t.status === 'fail' || t.status === 'warn' || t.status === 'error') && t.has_detail && (
                              <Box component="button" onClick={() => downloadDetail(t)} disabled={dl === t.id}
                                sx={{ flexShrink: 0, cursor: dl === t.id ? 'wait' : 'pointer', border: `1px solid ${C.rule}`, bgcolor: '#fff',
                                  color: C.navy, fontFamily: SANS, fontSize: 11, fontWeight: 700, px: 1, py: 0.3, borderRadius: `${RADIUS.sm}px`,
                                  whiteSpace: 'nowrap', '&:hover': { bgcolor: '#f4f3f1' } }}>
                                {dl === t.id ? '…' : '⬇ Excel'}
                              </Box>
                            )}
                          </Box>
                        </Box>
                      ))}
                    </Box>
                  );
                })}
              </Stack>
            </Box>
          );
        })}
      </Stack>

      {/* SECTION 3 · COMPLEX QA — result-set inspection queries (not filtered; always shown) */}
      {(data.complex ?? []).length > 0 && (
        <Box sx={{ mt: 4 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 1.5, pb: 0.85, borderBottom: `2px solid ${C.navy}`, flexWrap: 'wrap' }}>
            <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.gold }}>Section 3</Box>
            <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 20, color: C.navy }}>Complex QA</Box>
            <Box sx={{ fontSize: 12.5, color: C.muted, flex: 1, minWidth: 200 }}>
              Cross-master presence checks that return a full result table (not pass/fail) — read each row directly. Master-scoped, so not tied to the run date.
            </Box>
          </Box>
          <Stack spacing={2}>
            {(data.complex ?? []).map((q) => <ComplexCard key={q.id} q={q} />)}
          </Stack>
        </Box>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.rule}`, mt: 3, pt: 1, fontSize: 9, color: C.muted }}>
        <span>PepsiCo AIDEN · Data QA (live, not stored) · /api/v1/data_tests · QA-only, not production</span>
        <span>{data.total} checks · {data.date}</span>
      </Box>
    </Shell>
  );
}
