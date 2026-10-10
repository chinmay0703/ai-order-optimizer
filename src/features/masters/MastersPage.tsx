import { useEffect, useMemo, useState } from 'react';
import { Box, Chip, InputBase, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import StorageIcon from '@mui/icons-material/Storage';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { ExportXlsxButton } from '../../shared/exportXlsx';

// Data page — every table LIVE from the API (FastAPI/Postgres), grouped, with a real 10-row sample.
interface TableInfo { table: string; group: string; rows: number; source?: string; s3_path?: string | null; }
interface TablesResponse { groups: string[]; tables: TableInfo[]; }
interface TableData { table: string; group: string; columns: string[]; rows: (string | number | null)[][]; total_rows: number; source?: string; s3_path?: string | null; sampled?: boolean; }

// group -> pdart tint (pale bg + saturated fg)
const GROUP_COLOR: Record<string, { bg: string; fg: string }> = {
  'Masters': { bg: C.amberP, fg: C.amber },
  'Orphan Masters': { bg: C.navyP, fg: C.navy },
  'Transactional': { bg: C.greenP, fg: C.green },
  'Processed': { bg: '#FBE6EA', fg: '#D93954' },   // violet — a deliberately DISTINCT tint for the derived/processed step (filtered SOQ), set apart from amber/green/navy/red
  'Engine Output': { bg: C.redP, fg: C.red },
  Other: { bg: C.grayP, fg: C.muted },
};
const groupChip = (g: string) => GROUP_COLOR[g] ?? { bg: C.grayP, fg: C.muted };
const nf = (n: number) => (n ?? 0).toLocaleString();
const PAGE_SIZE = 25;

// Columns hidden on the Data page UI (display-only — the underlying table is untouched). raw_soq.Max_Norm is delivered
// as ceil(1.2×Norm) but the engine uses floor(1.2×Norm) everywhere, so the delivered field is hidden to avoid confusion.
const HIDE_FIELDS: Record<string, string[]> = { raw_soq: ['Max_Norm'] };
const isHidden = (table: string, col: string) => (HIDE_FIELDS[table] ?? []).includes(col);
const HIDDEN_GROUPS = new Set(['Engine Output', 'Other']);   // hidden for now (per request) — delivered tables only

function Kpi({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ flex: 1, position: 'relative', border: `1px solid ${C.rule}`, borderRadius: RADIUS.md, padding: '14px 18px 14px 20px', background: C.white, boxShadow: SHADOW.sm, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: accent }} />
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: C.muted }}>{label}</div>
      <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 30, color: C.navy, lineHeight: 1.05, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

// sticky navy header + hairline body cells for the paged data grid
const thCell: React.CSSProperties = { position: 'sticky', top: 0, textAlign: 'left', padding: '10px 12px', background: C.headBg,
  color: C.muted, fontWeight: 700, fontFamily: SANS, fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase',
  borderBottom: `1px solid ${C.rule}`, whiteSpace: 'nowrap', zIndex: 1 };
const tdCell: React.CSSProperties = { padding: '10px 12px', borderTop: `1px solid ${C.rowLine}`, color: C.ink,
  whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };

function Pager({ total, page, onPrev, onNext, loading }: { total: number; page: number; onPrev: () => void; onNext: () => void; loading: boolean }) {
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);
  const hasPrev = page > 0, hasNext = to < total;
  const btn = (on: boolean) => ({ px: 1.25, py: 0.5, borderRadius: `${RADIUS.sm}px`, border: `1px solid ${on ? C.navy : C.border}`,
    cursor: on ? 'pointer' : 'default', fontSize: 12, fontWeight: 700, color: on ? C.navy : C.muted, opacity: on ? 1 : 0.5,
    bgcolor: C.white, userSelect: 'none' as const, '&:hover': on ? { bgcolor: C.navyP } : {} });
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
      <Typography sx={{ fontSize: 12, color: C.muted, fontVariantNumeric: 'tabular-nums', mr: 0.5 }}>
        {loading ? 'loading…' : `${nf(from)}–${nf(to)} of ${nf(total)}`}
      </Typography>
      <Box onClick={() => hasPrev && onPrev()} sx={btn(hasPrev)}>{'‹'} Prev</Box>
      <Box onClick={() => hasNext && onNext()} sx={btn(hasNext)}>Next {'›'}</Box>
    </Box>
  );
}

// Shell is hoisted to MODULE scope: if it were defined inside MastersPage it would be a new function on every
// render, so React would remount the whole subtree on each keystroke and the search inputs would lose focus.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
      <div style={{ maxWidth: 1320, margin: '0 auto', padding: 'clamp(14px, 4vw, 28px) clamp(12px, 4vw, 32px) clamp(92px, 8vw, 92px)' }}>
        <style>{`.mtbl tbody tr:hover td { background: rgba(45,45,45,0.07); }`}</style>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>
          Data · live from API
        </div>
        <h1 style={{ fontFamily: SANS, fontWeight: 800, color: C.navy, fontSize: 30, letterSpacing: '-.01em', margin: '6px 0 8px' }}>
          Data
        </h1>
        {children}
      </div>
    </div>
  );
}

export default function MastersPage() {
  const [catalog, setCatalog] = useState<TablesResponse | null>(null);
  const [catLoading, setCatLoading] = useState(true);   // init TRUE: fetched on mount -> the first paint is the skeleton,
                                                        // not a flash of "no tables". NEVER infer "in flight" from
                                                        // catalog===null: an empty payload would spin forever
  const [catErr, setCatErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);           // bumped by the catalog Retry
  const [dataNonce, setDataNonce] = useState(0);   // bumped by the table-panel Retry (the two sides load independently)
  const [sel, setSel] = useState<string | null>(null);
  const [data, setData] = useState<TableData | null>(null);
  const [loading, setLoading] = useState(false);
  const [dataErr, setDataErr] = useState<string | null>(null);
  const [dataFor, setDataFor] = useState<string | null>(null);   // the table the last SETTLED fetch was for. Without it the
                                                                 // render cannot tell "picked, effect hasn't fired yet" from
                                                                 // "fetched, payload was empty" — and flashes the empty state
  const [q, setQ] = useState('');
  const [view, setView] = useState<'data' | 'schema'>('data');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (g: string) => setCollapsed((prev) => { const n = new Set(prev); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  const [opened, setOpened] = useState(false);   // true once the USER opens a table (not the on-load default) — gates the fold dot
  const [page, setPage] = useState(0);      // 0-based page of the selected table
  const [dataQ, setDataQ] = useState('');   // server-side search across every field of the selected table

  useEffect(() => {
    let alive = true;
    setCatErr(null); setCatLoading(true);
    api.tables()
      .then((j) => {
        if (!alive) return;
        const cat = j as TablesResponse;
        setCatalog(cat);
        const first = cat.tables.find((t) => !HIDDEN_GROUPS.has(t.group));
        if (first) setSel(first.table);
      })
      .catch((e: unknown) => { if (alive) setCatErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setCatLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [nonce]);

  useEffect(() => { setPage(0); setDataQ(''); }, [sel]);   // new table → back to page 1, clear its search
  useEffect(() => { setPage(0); }, [dataQ]);               // new search → back to page 1

  useEffect(() => {
    if (!sel) { setData(null); setDataErr(null); setLoading(false); return; }   // nothing picked -> nothing to fetch, not "loading"
    let alive = true;
    setLoading(true); setDataErr(null);
    const t = setTimeout(() => {                            // debounce the server-side search
      api.table(sel, PAGE_SIZE, page * PAGE_SIZE, dataQ)
        .then((d) => { if (alive) setData(d as TableData); })
        .catch((e: unknown) => { if (alive) setDataErr(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (alive) { setLoading(false); setDataFor(sel); } });   // settles on success, empty AND failure
    }, dataQ ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [sel, page, dataQ, dataNonce]);

  const grouped = useMemo(() => {
    if (!catalog) return [];
    const needle = q.trim().toLowerCase();
    const match = (t: TableInfo) => !needle || t.table.toLowerCase().includes(needle);
    return catalog.groups
      .filter((g) => !HIDDEN_GROUPS.has(g))                 // Engine Output + Other hidden for now
      .map((g) => ({ group: g, items: catalog.tables.filter((t) => t.group === g && match(t)) }))
      .filter((g) => g.items.length > 0);
  }, [catalog, q]);

  const totals = useMemo(() => {
    if (!catalog) return { tables: 0, rows: 0, groups: 0 };
    const shown = catalog.tables.filter((t) => !HIDDEN_GROUPS.has(t.group));   // count only the visible (delivered) tables
    return {
      tables: shown.length,
      rows: shown.reduce((a, t) => a + (t.rows ?? 0), 0),
      groups: new Set(shown.map((t) => t.group)).size,
    };
  }, [catalog]);

  // visible column indices for the selected table (Max_Norm hidden for raw_soq — see HIDE_FIELDS). Rows stay aligned.
  const visIdx = useMemo(
    () => (data ? data.columns.map((_, i) => i).filter((i) => !isHidden(data.table, data.columns[i])) : []),
    [data],
  );
  // right-align columns whose values are numeric (codes come as strings, so they stay left)
  const numCols = useMemo(
    () => new Set(data ? visIdx.filter((ci) => data.rows.some((r) => typeof r[ci] === 'number')) : []),
    [data, visIdx],
  );

  if (catErr) return <Shell><ErrorState error={`${catErr} — is the backend running on ${api.base}?`}
    onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (catLoading) return <Shell><PageSkeleton kpis={3} rows={9} /></Shell>;
  if (!catalog || catalog.tables.length === 0) return <Shell><EmptyState title="No tables in the catalog"
    hint={`The API at ${api.base} answered with no tables. Run the pipeline so the engine database is populated, then reload.`} /></Shell>;

  const selInfo = catalog.tables.find((t) => t.table === sel) ?? null;
  // The list and the detail panel load INDEPENDENTLY. A NEWLY picked table shimmers in its own skeleton (data still
  // holds the previous table); paging/searching the SAME table keeps the existing dim-in-place grid and its pager.
  // in flight OR about to be (sel changed, the fetch effect runs after this paint) AND nothing showable for THIS table yet.
  const detailLoading = !!sel && (loading || dataFor !== sel) && !(data && data.table === sel);

  return (
    <Shell>
      <p style={{ fontSize: 14, color: C.slate, maxWidth: 980, lineHeight: 1.5, margin: '0 0 16px' }}>
        The feeds live from the engine database — Masters · Orphan Masters · Transactional · Processed
        (the filtered SOQ the engine runs on). Each table opens on a {PAGE_SIZE}-row page; use <b>Search</b> to filter
        across <b>every field</b> and the pager to move through the rows. Switch <b>Schema</b> / <b>Data</b> per table.
      </p>

      <div style={{ display: 'flex', gap: 14, margin: '0 0 18px' }}>
        <Kpi label="Tables" value={nf(totals.tables)} accent={C.navy} />
        <Kpi label="Total rows" value={nf(totals.rows)} accent={C.gold} />
        <Kpi label="Groups" value={nf(totals.groups)} accent={C.green} />
      </div>

      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 2, alignItems: { xs: 'stretch', md: 'flex-start' } }}>
        {/* ---- table list ---- */}
        <Box sx={{ width: { xs: '100%', md: 300 }, flexShrink: 0, position: { xs: 'static', md: 'sticky' }, top: 44, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'hidden',
          maxHeight: { xs: '50vh', md: 'calc(100vh - 150px)' }, display: 'flex', flexDirection: 'column', background: C.white }}>
          {/* search + fold-all */}
          <Box sx={{ p: 1, borderBottom: `1px solid ${C.rule}`, display: 'flex', alignItems: 'center', gap: 0.6, bgcolor: C.white }}>
            <SearchIcon sx={{ fontSize: 18, color: C.muted }} />
            <InputBase value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tables…" sx={{ flex: 1, fontSize: 13, fontFamily: SANS }} />
            {q && <Box onClick={() => setQ('')} title="clear" sx={{ cursor: 'pointer', color: C.muted, fontSize: 17, lineHeight: 1, px: 0.3, '&:hover': { color: C.navy } }}>×</Box>}
            {(() => {
              const allC = grouped.length > 0 && grouped.every((g) => collapsed.has(g.group));
              return (
                <Box onClick={() => setCollapsed(allC ? new Set() : new Set(grouped.map((g) => g.group)))}
                  title={allC ? 'Expand all sections' : 'Collapse all sections'}
                  sx={{ fontSize: '0.56rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.03em', color: C.muted,
                    cursor: 'pointer', px: 0.7, py: 0.35, borderRadius: `${RADIUS.sm}px`, whiteSpace: 'nowrap', border: `1px solid ${C.border}`, lineHeight: 1.3,
                    '&:hover': { color: C.navy, borderColor: C.navy, bgcolor: C.grayP } }}>
                  {allC ? '▸ open' : '▾ fold'}
                </Box>
              );
            })()}
          </Box>
          <Box sx={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
            {grouped.length === 0 && <Typography sx={{ p: 2, fontSize: 13, color: C.muted }}>No tables match “{q}”.</Typography>}
            {grouped.map(({ group, items }) => {
              const isC = !q && collapsed.has(group);   // while searching, always show matches (ignore fold)
              const selInGroup = items.some((t) => t.table === sel);
              const gc = groupChip(group);
              return (
              <Box key={group}>
                {/* clean sticky section header: chevron · color dot · name · (open marker) · count pill; color is an ACCENT, not a fill */}
                <Box onClick={() => toggleGroup(group)}
                  sx={{ position: 'sticky', top: 0, zIndex: 3, display: 'flex', alignItems: 'center', gap: 0.75,
                    px: 1.1, py: 0.85, cursor: 'pointer', userSelect: 'none', bgcolor: C.white,
                    borderTop: `1px solid ${C.rule}`, borderLeft: `3px solid ${gc.fg}`,
                    '&:hover': { bgcolor: C.canvas } }}>
                  <Box component="span" sx={{ width: 12, textAlign: 'center', fontSize: 10, color: C.muted, transition: 'transform .15s', transform: isC ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</Box>
                  <Box component="span" sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: gc.fg, flexShrink: 0 }} />
                  <Box component="span" sx={{ flex: 1, fontSize: '0.7rem', fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.navy }}>{group}</Box>
                  {opened && selInGroup && <Box component="span" sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: C.gold, flexShrink: 0 }} title="a table from this section is open on the right" />}
                  <Box component="span" sx={{ fontSize: '0.64rem', fontWeight: 800, color: gc.fg, bgcolor: gc.bg, borderRadius: '10px', px: 0.85, py: '1px', minWidth: 18, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{items.length}</Box>
                </Box>
                {!isC && items.map((t) => {
                  const on = t.table === sel;
                  return (
                    <Box key={t.table} onClick={() => { setSel(t.table); setView('data'); setOpened(true); }}
                      sx={{ pl: 2.4, pr: 1, py: 0.75, cursor: 'pointer', borderBottom: `1px solid ${C.rowLine}`,
                        borderLeft: `3px solid ${on ? C.navy : 'transparent'}`,
                        bgcolor: on ? C.navyP : 'transparent', '&:hover': { bgcolor: on ? C.navyP : C.canvas } }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Typography title={t.table} sx={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: '0.8rem', color: on ? C.navy : C.slate, fontFamily: MONO,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.table}
                        </Typography>
                        {t.source === 'S3' && <span title={t.s3_path ?? 'served live from S3'}
                          style={{ flexShrink: 0, fontSize: '0.55rem', fontWeight: 800, letterSpacing: '.04em', color: C.gold,
                            border: `1px solid ${C.gold}`, borderRadius: 3, padding: '0 4px', lineHeight: 1.5 }}>S3</span>}
                      </Box>
                      <Box sx={{ display: 'flex', gap: 0.5, mt: 0.45, alignItems: 'center' }}>
                        <span style={{ fontSize: '0.6rem', color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{nf(t.rows)} rows</span>
                        <Box sx={{ flex: 1 }} />
                        {(['schema', 'data'] as const).map((m) => {
                          const active = on && view === m;
                          return (
                            <Box key={m} onClick={(e) => { e.stopPropagation(); setSel(t.table); setView(m); setOpened(true); }}
                              sx={{ fontSize: '0.56rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em',
                                px: 0.7, py: 0.2, borderRadius: `${RADIUS.sm}px`, cursor: 'pointer', border: `1px solid ${active ? C.navy : C.border}`,
                                bgcolor: active ? C.navy : 'transparent', color: active ? '#fff' : C.muted,
                                '&:hover': { bgcolor: active ? C.navy : C.grayP, color: active ? '#fff' : C.navy } }}>
                              {m}
                            </Box>
                          );
                        })}
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            ); })}
          </Box>
        </Box>

        {/* ---- selected table ---- */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, p: 1.5, mb: 1.5, display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap', background: C.white }}>
            <StorageIcon sx={{ color: C.navy, fontSize: 22 }} />
            <Box sx={{ flex: 1, minWidth: 200 }}>
              <Typography sx={{ fontFamily: 'Consolas, monospace', fontWeight: 700, color: C.navy, fontSize: '1.05rem', lineHeight: 1.2 }}>{sel}</Typography>
              {(data?.s3_path ?? selInfo?.s3_path) && (
                <Typography title="Click to select · validate this source with the data team"
                  onClick={() => navigator.clipboard?.writeText((data?.s3_path ?? selInfo?.s3_path) ?? '')}
                  sx={{ fontFamily: 'Consolas, monospace', fontSize: '0.72rem', color: C.muted, mt: 0.35,
                    wordBreak: 'break-all', cursor: 'copy', '&:hover': { color: C.navy } }}>
                  <span style={{ color: C.gold, fontWeight: 800 }}>S3 SOURCE · </span>{data?.s3_path ?? selInfo?.s3_path}
                </Typography>
              )}
            </Box>
            {selInfo?.group && <Chip label={selInfo.group} size="small" sx={{ fontWeight: 700, bgcolor: groupChip(selInfo.group).bg, color: groupChip(selInfo.group).fg }} />}
            <Chip label={`${nf(data?.total_rows ?? selInfo?.rows ?? 0)} rows`} size="small" sx={{ fontWeight: 700, bgcolor: C.navyP, color: C.navy }} />
            {data && <Chip label={`${visIdx.length} cols`} size="small" sx={{ bgcolor: C.grayP, color: C.muted, fontWeight: 700 }} />}
          </Box>

          {dataErr ? (
            <ErrorState error={dataErr} onRetry={() => setDataNonce((n) => n + 1)} />
          ) : detailLoading ? (
            <PageSkeleton kpis={0} rows={9} />
          ) : !sel ? (
            <EmptyState title="Pick a table on the left"
              hint="Choose any table in the list to read its schema and page through its rows." />
          ) : !data ? (
            <EmptyState title={`Nothing came back for ${sel}`}
              hint="The API returned no payload for this table. Retry, or pick another table on the left." />
          ) : view === 'schema' ? (
            <Box sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'hidden', background: C.white }}>
              <Box sx={{ px: 2, py: 1.25, bgcolor: C.navy }}>
                <Typography sx={{ fontFamily: SERIF, fontWeight: 700, color: '#fff', fontSize: '1rem' }}>{sel} · schema</Typography>
                <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.72)' }}>{visIdx.length} columns</Typography>
              </Box>
              <Box sx={{ p: 2, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 1 }}>
                {visIdx.map((ci, i) => (
                  <Box key={ci} sx={{ display: 'flex', alignItems: 'baseline', gap: 1, p: 0.85, border: `1px solid ${C.border}`, borderRadius: 1, bgcolor: i % 2 ? C.grayP : '#fff' }}>
                    <span style={{ color: C.muted, fontSize: 11, minWidth: 20, textAlign: 'right' }}>{i + 1}</span>
                    <span style={{ fontFamily: 'Consolas, monospace', fontSize: 13, color: C.navy, fontWeight: 600 }}>{data.columns[ci]}</span>
                  </Box>
                ))}
              </Box>
            </Box>
          ) : (
            <>
              {/* search-any-field + pager */}
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 1, flexWrap: 'wrap' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flex: 1, minWidth: 240,
                  border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, px: 1.25, py: 0.35, bgcolor: C.white }}>
                  <SearchIcon sx={{ fontSize: 18, color: C.muted }} />
                  <InputBase value={dataQ} onChange={(e) => setDataQ(e.target.value)}
                    placeholder={`Search ${sel} — space-separate to match multiple fields…`} sx={{ flex: 1, fontSize: 13, fontFamily: SANS }} />
                  {dataQ && <Box onClick={() => setDataQ('')} sx={{ cursor: 'pointer', color: C.muted, fontSize: 18, lineHeight: 1, px: 0.4, '&:hover': { color: C.navy } }}>×</Box>}
                </Box>
                <Pager total={data.total_rows} page={page} loading={loading}
                  onPrev={() => setPage((p) => Math.max(0, p - 1))}
                  onNext={() => setPage((p) => ((p + 1) * PAGE_SIZE < data.total_rows ? p + 1 : p))} />
                <ExportXlsxButton label="Export all rows" disabled={!data.total_rows}
                  href={api.tableXlsxUrl(sel ?? '', dataQ)} filename={`${sel ?? 'table'}.xlsx`} />
              </Box>
              {/* one page of rows */}
              <Box sx={{ overflow: 'auto', maxHeight: 560, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`,
                boxShadow: SHADOW.sm, background: C.white, opacity: loading ? 0.55 : 1, transition: 'opacity .12s' }}>
                <table className="mtbl" style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
                  <thead><tr>{visIdx.map((i) => <th key={i} style={{ ...thCell, textAlign: numCols.has(i) ? 'right' : 'left' }}>{data.columns[i]}</th>)}</tr></thead>
                  <tbody>
                    {data.rows.map((r, i) => (
                      <tr key={i} style={{ background: '#fff' }}>
                        {visIdx.map((ci, ci_i) => {
                          const v = r[ci];
                          const first = ci_i === 0;
                          return <td key={ci} style={{ ...tdCell, textAlign: numCols.has(ci) ? 'right' : 'left',
                            ...(first ? { fontWeight: 600, color: C.navy } : null) }}>{v == null ? '' : String(v)}</td>;
                        })}
                      </tr>
                    ))}
                    {data.rows.length === 0 && (
                      <tr><td colSpan={visIdx.length} style={{ ...tdCell, textAlign: 'center', color: C.muted, padding: '28px 12px' }}>
                        {dataQ ? <>No rows match “<b>{dataQ}</b>”.</> : 'No rows.'}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </Box>
            </>
          )}
        </Box>
      </Box>

      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.border}`, marginTop: 22, paddingTop: 8, fontSize: 9, color: C.muted }}>
        <span>AI Order Optimizer · sample data</span>
        <span>{totals.tables} tables</span>
      </div>
    </Shell>
  );
}
