import { useEffect, useMemo, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Box,
  Table, TableBody, TableCell, TableHead, TableRow,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';

/* ---------------------------------------------------------------------------
   Data Model — every table · column · data type, sample data, grouped
   by the 6 logical domains (masters · transaction · processed · engine · orders · rlm) +
   the SAP hand-off. App tables are shown under the production schema ds_app.
--------------------------------------------------------------------------- */
interface Col { column: string; type: string; }
interface Tbl { table: string; schema: string; columns: Col[]; }
interface Dom { domain: string; desc: string; tables: Tbl[]; }
interface Payload { app_schema: string; sap_schema: string; total_tables: number; total_columns: number; domains: Dom[]; }

const DOMAIN_COLOR: Record<string, string> = {
  masters: '#2D2D2D', transaction: '#1B7346', processed: '#D93954', engine: '#5C616A',
  orders: '#C52B09', rlm: '#C52B09', sap: '#E0301E',
};

const Shell = ({ children }: { children: React.ReactNode }) => (
  <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
    <Box sx={{ maxWidth: 1200, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
      <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>
        Data Model · Production
      </Box>
      <Box component="h1" sx={{ fontFamily: SANS, fontWeight: 800, color: C.navy, fontSize: 30, letterSpacing: '-.01em', m: '6px 0 8px' }}>
        Data Model — ds_app
      </Box>
      {children}
    </Box>
  </Box>
);

export default function SchemaPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);   // NEVER infer "in flight" from data===null: an empty payload
  const [err, setErr] = useState<string | null>(null);   // or a failure would then spin forever
  const [nonce, setNonce] = useState(0);            // bumped by the error Retry to re-run the effect
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    setErr(null); setLoading(true);
    api.schemaReference().then((r) => { if (alive) setData(r as Payload); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [nonce]);

  const needle = q.trim().toLowerCase();
  const domains = useMemo(() => {
    if (!data) return [];
    if (!needle) return data.domains;
    return data.domains
      .map((d) => ({ ...d, tables: d.tables.filter((t) => t.table.toLowerCase().includes(needle)
        || t.columns.some((c) => c.column.toLowerCase().includes(needle))) }))
      .filter((d) => d.tables.length);
  }, [data, needle]);

  if (err) return <Shell><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Shell>;
  if (loading) return <Shell><PageSkeleton kpis={0} rows={8} /></Shell>;
  // finished, but there is nothing to show: no payload, no domains, or every domain came back with 0 tables.
  // Deliberately reads the RAW payload, not the filtered `domains` memo — a filter that matches nothing is a
  // filtered view, not an empty load.
  if (!data || !data.domains.some((d) => d.tables.length)) return <Shell><EmptyState title="No data model to show"
    hint="Postgres returned no tables for ds_app / de_sap. Check the database connection, then try again." /></Shell>;

  return (
    <Shell>
      <Box sx={{ fontSize: 14, color: C.slate, lineHeight: 1.5, maxWidth: 940, mb: 1.5 }}>
        Every table used end to end, <b>sample data</b> — grouped by the six logical domains plus the SAP
        hand-off. App tables live in schema <b>ds_app</b>; the SAP order table lives in <b>de_sap</b>.
        &nbsp;<b>{data.total_tables}</b> tables · <b>{data.total_columns}</b> columns.
      </Box>

      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter table or column…"
        style={{ width: '100%', maxWidth: 380, padding: '8px 12px', fontSize: 13, fontFamily: SANS,
          border: `1px solid ${C.rule}`, borderRadius: RADIUS.sm, marginBottom: 18 }} />

      {domains.map((d) => (
        <Box key={d.domain} sx={{ mb: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: DOMAIN_COLOR[d.domain] ?? C.navy }} />
            <Box sx={{ fontFamily: SANS, fontSize: 18, fontWeight: 800, color: C.navy, textTransform: 'capitalize' }}>
              {d.domain}
            </Box>
            <Box sx={{ fontSize: 12, color: C.muted }}>· {d.tables.length} table{d.tables.length === 1 ? '' : 's'}</Box>
          </Box>
          <Box sx={{ fontSize: 12.5, color: C.muted, mb: 1 }}>{d.desc}</Box>

          {d.tables.map((t) => (
            <Accordion key={t.table} disableGutters elevation={0}
              sx={{ border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px !important`, mb: 0.75,
                boxShadow: SHADOW.sm, '&:before': { display: 'none' }, overflow: 'hidden' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: C.navy }} />}
                sx={{ bgcolor: C.white, minHeight: 46, '&:hover': { bgcolor: 'rgba(45,45,45,0.04)' },
                  '& .MuiAccordionSummary-content': { alignItems: 'center', gap: 1.25, my: 0.75 } }}>
                <Box component="span" sx={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: C.navy }}>{t.table}</Box>
                <Box component="span" sx={{ fontFamily: MONO, fontSize: 10, px: 0.7, py: 0.15, borderRadius: 1,
                  bgcolor: '#F5F7F8', color: C.muted, border: `1px solid ${C.rule}` }}>{t.schema}</Box>
                <Box sx={{ flex: 1 }} />
                <Box component="span" sx={{ fontSize: 11.5, color: C.muted }}>{t.columns.length} cols</Box>
              </AccordionSummary>
              <AccordionDetails sx={{ p: 0 }}>
                <Box sx={{ overflow: 'auto' }}>
                  <Table size="small" sx={{ minWidth: 420 }}>
                    <TableHead><TableRow>
                      <TableCell sx={{ fontFamily: SANS, width: '55%' }}>Column</TableCell>
                      <TableCell sx={{ fontFamily: SANS }}>Data Type</TableCell>
                    </TableRow></TableHead>
                    <TableBody>
                      {t.columns.map((c) => (
                        <TableRow key={c.column} sx={{ bgcolor: C.white }}>
                          <TableCell sx={{ fontFamily: MONO, fontSize: 12.5, color: C.slate, fontWeight: 600, whiteSpace: 'nowrap' }}>{c.column}</TableCell>
                          <TableCell sx={{ fontFamily: MONO, fontSize: 12.5, color: C.muted, whiteSpace: 'nowrap' }}>{c.type}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      ))}

      <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.rule}`, mt: 3, pt: 1, fontSize: 9, color: C.muted }}>
        <span>AI Order Optimizer · Data Model (ds_app · de_sap) · sample data</span>
        <span>{data.total_tables} tables · {data.total_columns} columns</span>
      </Box>
    </Shell>
  );
}
