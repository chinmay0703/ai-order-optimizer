import { useEffect, useMemo, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Box, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import { useOeParams } from '../../shared/OeParams';
import { useRegZskuDesc } from '../../shared/RegZskuDesc';

/* The FINAL cluster PRIMARY truck (transshipment) — the long-haul CFA→cluster-hub truck that carries the whole
   cluster's combined shipment, then the per-DB secondary trucks fan it out. Live from /api/v1/cluster_primary_trucks:
   combined reg-zsku level + packed SKU level, all post-trim final cases. */
interface SkuRow { reg_zsku: string; sku: string; batch: string; days_to_expiry: number; qty: number; source: string; db: string; }
interface PTruck { no: number; cases: number; capacity: number; fill: number; skus: SkuRow[]; reg: { reg_zsku: string; cases: number }[]; }
interface RegLine { reg_zsku: string; original: number; substitute: number; filler: number; total: number; }
interface Member { db: string; channel: string; soq: number; ships: number; }
interface Cluster { cfa: string; cluster_code: string; primary_cap: number; primary_trucks: number; combined_cases: number; n_dbs: number; channels: string[]; members: Member[]; reg: RegLine[]; trucks: PTruck[]; }

const nf = (n: number) => Math.round(Number(n) || 0).toLocaleString();
const num = { textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums', fontFamily: MONO, fontSize: 12, whiteSpace: 'nowrap' as const };

export default function ClusterPrimaryTrucks({ date, cfa }: { date?: string; cfa?: string }) {
  const P = useOeParams();   // engine thresholds (oe_parameters) — never hardcode 90 / 65
  const descOf = useRegZskuDesc();
  const fillClr = (p: number) => (p >= P.TRUCK_FILL_TARGET_PCT * 100 ? C.success : p >= P.TRUCK_KEEP_PCT * 100 ? C.warnText : '#A32020');
  const [data, setData] = useState<Cluster[] | null>(null);
  const [loading, setLoading] = useState(true);           // NEVER infer "in flight" from data===null: an empty cluster
  const [err, setErr] = useState<string | null>(null);    // list, or a failure, would then spin forever.
                                                          // Starts TRUE: the fetch below is unconditional on mount, so
                                                          // the first paint must be the skeleton, never a false "no data".
  const [nonce, setNonce] = useState(0);                  // bumped by the error Retry to re-run the effect
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null); setLoading(true);
    api.clusterPrimaryTrucks(date, cfa).then((r) => { if (alive) setData(((r as { clusters?: Cluster[] }).clusters) ?? []); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, on an EMPTY payload AND on failure
    return () => { alive = false; };
  }, [date, cfa, nonce]);

  const ships = useMemo(() => (data ?? []).filter((c) => c.primary_trucks > 0), [data]);

  if (err) return <ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} />;
  if (loading) return <PageSkeleton kpis={0} rows={6} />;
  if (ships.length === 0) return <EmptyState title="No cluster primary trucks for this date"
    hint="No transshipment cluster shipped a long-haul primary truck on this date — either no cluster DB was allocated, or the combined cases never reached a truck. Pick another run date, or run the pipeline first." />;

  return (
    <Box sx={{ mb: 2 }}>
      <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.gold, mb: 0.5 }}>
        Transshipment · final cluster primary trucks
      </Box>
      <Box sx={{ fontSize: 12.5, color: C.slate, mb: 1, maxWidth: 980, lineHeight: 1.5 }}>
        The long-haul <b>CFA → cluster-hub PRIMARY truck</b> — the cluster's DBs are combined onto it (built last, after each
        DB's secondary trucks), and it is the truck count carried to the order. Its reg-zsku + SKU level below are the
        <b> final post-trim cases</b>; the per-DB secondary trucks then fan this out. <b>Not run-wise on purpose:</b> a
        cluster's DBs are allocated in <b>different channel runs</b>, so the primary truck combines <b>across runs</b> (post-cascade)
        — that's why this is a date-level view, not tied to the run selected above.
      </Box>
      {ships.map((c) => {
        const key = `${c.cfa}-${c.cluster_code}`;
        return (
          <Accordion key={key} disableGutters elevation={0} expanded={open[key] ?? false}
            onChange={(_, ex) => setOpen((p) => ({ ...p, [key]: ex }))}
            slotProps={{ transition: { unmountOnExit: true } }}
            sx={{ border: `1px solid ${C.rule}`, borderLeft: `4px solid ${C.success}`, borderRadius: `${RADIUS.sm}px`, boxShadow: SHADOW.sm, mb: 0.6, '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ChevronRightIcon sx={{ fontSize: 18 }} />}
              sx={{ flexDirection: 'row-reverse', gap: 1, px: 1.5, bgcolor: '#F6FAF7',
                '& .MuiAccordionSummary-expandIconWrapper.Mui-expanded': { transform: 'rotate(90deg)' },
                '& .MuiAccordionSummary-content': { alignItems: 'center', gap: 1.25, flexWrap: 'wrap', my: 0.8 } }}>
              <LocalShippingIcon sx={{ color: C.success, fontSize: 19 }} />
              <Box sx={{ fontFamily: MONO, fontWeight: 800, fontSize: 14, color: C.navy }}>{c.cluster_code}</Box>
              <Box sx={{ fontFamily: MONO, fontSize: 12, color: C.muted }}>CFA {c.cfa} · {c.n_dbs} DB{c.n_dbs !== 1 ? 's' : ''}</Box>
              {c.channels.length > 0 && (
                <Box component="span" title="Channel runs this cluster's DBs came from — combined across runs onto one primary truck"
                  sx={{ px: 0.8, py: 0.2, borderRadius: 1, fontSize: 11, fontWeight: 700, bgcolor: '#F6F6F6', color: C.navy }}>
                  {c.channels.join(' + ')}{c.channels.length > 1 ? ' · cross-run' : ''}
                </Box>
              )}
              <Box sx={{ flex: 1 }} />
              <Box sx={{ fontSize: 12.5, color: C.slate }}>
                <b style={{ color: C.success }}>{c.primary_trucks}</b> primary truck{c.primary_trucks !== 1 ? 's' : ''} · <b>{nf(c.combined_cases)}</b> cs combined · cap {nf(c.primary_cap)}
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 1.5, pb: 1.5, pt: 0, bgcolor: '#FDFDFD' }}>
              {/* member DBs combined onto the primary truck */}
              <Box sx={{ display: 'flex', gap: 0.6, flexWrap: 'wrap', my: 1 }}>
                <Box sx={{ fontSize: 11, color: C.muted, alignSelf: 'center', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>combined DBs:</Box>
                {c.members.map((m) => (
                  <Box key={m.db} sx={{ px: 0.9, py: 0.35, borderRadius: `${RADIUS.sm}px`, border: `1px solid ${C.rule}`, bgcolor: '#fff', ...num, textAlign: 'left', color: m.ships > 0 ? C.navy : C.muted }}>
                    {m.db} · <Box component="span" sx={{ color: C.muted }}>{m.channel || '—'}</Box> · SOQ {nf(m.soq)} · ships <b style={{ color: m.ships > 0 ? C.success : C.muted }}>{nf(m.ships)}</b>
                  </Box>
                ))}
              </Box>
              {/* combined reg-zsku level */}
              <Box sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: C.navy, mb: 0.4, mt: 0.5 }}>
                reg-zsku level · cluster-combined (final cases) · {c.reg.length} lines
              </Box>
              <Box sx={{ overflowX: 'auto', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px`, mb: 1.25 }}>
                <Table size="small" sx={{ minWidth: 'max-content' }}>
                  <TableHead><TableRow>
                    {['Reg-ZSKU', 'Description', 'Original', 'Substitute', 'Filler', 'Total'].map((h, i) =>
                      <TableCell key={h} align={i <= 1 ? 'left' : 'right'} sx={{ fontFamily: SANS, whiteSpace: 'nowrap', fontSize: 11 }}>{h}</TableCell>)}
                  </TableRow></TableHead>
                  <TableBody>
                    {c.reg.map((r) => (
                      <TableRow key={r.reg_zsku}>
                        <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: C.navy }}>{r.reg_zsku}</TableCell>
                        <TableCell sx={{ whiteSpace: 'normal' }} title={descOf(r.reg_zsku)}>{descOf(r.reg_zsku) || '—'}</TableCell>
                        <TableCell sx={{ ...num, color: C.navy }}>{nf(r.original)}</TableCell>
                        <TableCell sx={{ ...num, color: r.substitute ? C.success : C.muted }}>{r.substitute || '—'}</TableCell>
                        <TableCell sx={{ ...num, color: r.filler ? C.warnText : C.muted }}>{r.filler || '—'}</TableCell>
                        <TableCell sx={{ ...num, fontWeight: 800, color: C.success }}>{nf(r.total)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
              {/* per primary truck · SKU level */}
              {c.trucks.map((t) => (
                <Box key={t.no} sx={{ mb: 1 }}>
                  <Box sx={{ fontSize: 12.5, fontWeight: 800, color: C.navy, mb: 0.4 }}>
                    Primary truck {t.no} · <b>{nf(t.cases)}</b> / {nf(t.capacity)} cs · <Box component="span" sx={{ color: fillClr(t.fill) }}>{t.fill}%</Box> · {t.skus.length} SKU picks · {t.reg.length} reg-zskus
                  </Box>
                  <Box sx={{ overflowX: 'auto', border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.sm}px` }}>
                    <Table size="small" sx={{ minWidth: 'max-content' }}>
                      <TableHead><TableRow>
                        {['Reg-ZSKU', 'Description', 'SKU', 'Batch', 'Days→exp', 'Qty', 'Source', 'DB'].map((h, i) =>
                          <TableCell key={h} align={i === 5 || i === 4 ? 'right' : 'left'} sx={{ fontFamily: SANS, whiteSpace: 'nowrap', fontSize: 11 }}>{h}</TableCell>)}
                      </TableRow></TableHead>
                      <TableBody>
                        {t.skus.map((s, i) => (
                          <TableRow key={`${s.sku}-${s.batch}-${i}`}>
                            <TableCell sx={{ fontFamily: MONO, fontSize: 11.5, color: C.navy }}>{s.reg_zsku}</TableCell>
                            <TableCell sx={{ whiteSpace: 'normal' }} title={descOf(s.reg_zsku)}>{descOf(s.reg_zsku) || '—'}</TableCell>
                            <TableCell sx={{ fontFamily: MONO, fontSize: 11.5, color: C.slate }}>{s.sku}</TableCell>
                            <TableCell sx={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>{s.batch}</TableCell>
                            <TableCell sx={{ ...num, color: C.muted }}>{nf(s.days_to_expiry)}</TableCell>
                            <TableCell sx={{ ...num, fontWeight: 700 }}>{nf(s.qty)}</TableCell>
                            <TableCell sx={{ fontSize: 11.5, color: s.source === 'Filler' ? C.warnText : s.source === 'Substitute' ? C.success : C.slate }}>{s.source || 'Original'}</TableCell>
                            <TableCell sx={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>{s.db}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Box>
                </Box>
              ))}
            </AccordionDetails>
          </Accordion>
        );
      })}
    </Box>
  );
}
