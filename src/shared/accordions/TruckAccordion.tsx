import {
  Accordion, AccordionSummary, AccordionDetails, Box, Chip, LinearProgress, Stack, Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { Truck } from '../../types';
import { tierTone, fillTone, status } from '../../theme/muiTheme';
import LineTable from '../tables/LineTable';
import SkuTable from '../tables/SkuTable';
import FillerTable from '../tables/FillerTable';
import { isTracked, trackedSxFor, TRACK_STAR } from '../../demo';
import { useOeParams, pct } from '../OeParams';
import Metric from '../Metric';
import type { ReactNode } from 'react';

// a clean collapsible sub-section (ZSKU level / SKU level)
function Section({ title, subtitle, count, color, tint, defaultOpen, extra, children }: {
  title: string; subtitle?: string; count: number; color: string; tint: string;
  defaultOpen?: boolean; extra?: ReactNode; children: ReactNode;
}) {
  return (
    <Accordion disableGutters elevation={0} defaultExpanded={defaultOpen}
      slotProps={{ transition: { unmountOnExit: true } }}
      sx={{ bgcolor: 'transparent', boxShadow: 'none', '&:before': { display: 'none' }, mt: 1.25 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ fontSize: 18, color }} />}
        sx={{
          minHeight: 0, borderRadius: 1.5, px: 1.25,
          bgcolor: tint, border: '1px solid', borderColor: 'divider',
          transition: 'filter .12s', '&:hover': { filter: 'brightness(0.97)' },
          '& .MuiAccordionSummary-content': { my: 0.9, alignItems: 'center', gap: 1 },
        }}>
        <Box sx={{ width: 3, height: 15, borderRadius: 2, bgcolor: color, flexShrink: 0 }} />
        <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, color,
          textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography sx={{ fontSize: '0.7rem', color: 'text.secondary', whiteSpace: 'nowrap',
            display: { xs: 'none', sm: 'block' } }}>
            · {subtitle}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {extra}
        <Chip label={`${count} lines`} size="small"
          sx={{ height: 19, fontSize: '0.66rem', fontWeight: 600, bgcolor: 'background.paper',
            color, border: '1px solid', borderColor: 'divider' }} />
      </AccordionSummary>
      <AccordionDetails sx={{ p: 0, pt: 1 }}>{children}</AccordionDetails>
    </Accordion>
  );
}

const ordinal = (n: number) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

export default function TruckAccordion({ truck, cap, expanded, onToggle }: {
  truck: Truck; cap: number; expanded: boolean; onToggle: () => void;
}) {
  const P = useOeParams();   // engine thresholds (oe_parameters) — never hardcode 0.65 / 50% / tier 4
  const ntrucks = truck.loads.length;                           // actual dispatched trucks (0 = held)
  const ncap = ntrucks * cap;                                   // total dispatched capacity
  const capPct = ncap > 0 ? Math.round((truck.tot / ncap) * 100) : 0;   // overall utilization
  const demandPct = truck.soq > 0 ? Math.round((truck.tot / truck.soq) * 100) : 0;
  const tone = fillTone(demandPct);
  const tier = tierTone[truck.tier] ?? tierTone[P.DEFAULT_TIER] ?? tierTone[4];
  // Step-3 filler DRAW SEQUENCE — the EXACT values the engine used (or_filler_sequence); nothing is recomputed here.
  // priority = (Σnorm ÷ Σheld) × tier weight, Σheld = stock + Original + Substitute; rank 1 = drew the pool first.
  const drawRank = truck.rank ?? 0;
  const nRank = truck.nRank ?? 0;
  const fillPriority = truck.priority ?? 0;
  const seqTip = `Filler draw sequence in this CFA — this DB drew ${drawRank > 0 ? ordinal(drawRank) : '—'}${nRank ? ` of ${nRank}` : ''}. `
    + `Priority ${fillPriority.toFixed(3)} = (Σnorm ${truck.sumNorm ?? 0} ÷ Σheld ${truck.sumHeld ?? 0}) × T${truck.tier} weight. `
    + `Σheld = stock + Original + Substitute. Higher priority draws the shared CFA filler pool first — this is the EXACT order Step 3 used.`;
  // per-step allocated cases for THIS DB: l[3]=Step-1 Original, l[4]=Step-2 Substitute, l[6]=Step-3 Filler.
  // For a DROPPED lane (cancelled at Step 3 — fillers couldn't reach 65%), the shipped lines are all 0 because
  // or_output_allocation excludes it; the Steps 1+2 it DID get come from the pre-drop trim (or_output_truck_trim).
  const dropped = !!truck.dropped;
  const cascaded = truck.cascaded ?? 0;   // TRUCK_TAIL_CASCADE: overflow off a lane that STILL shipped → next run
  const stepOrig = dropped ? (truck.dropOrig ?? 0) : truck.lines.reduce((s, l) => s + l[3], 0);
  const stepSub = dropped ? (truck.dropSub ?? 0) : truck.lines.reduce((s, l) => s + l[4], 0);
  const stepFil = dropped ? 0 : truck.lines.reduce((s, l) => s + l[6], 0);
  const preFiller = stepOrig + stepSub;
  // truck type + capacity + "how much more is required": for a dropped lane, cases still needed to lift its trucks to
  // ≥65% and ship; for a shipped lane, the spare room left in the dispatched trucks. n_base mirrors the engine.
  const nBaseFor = (load: number) => (cap > 0 ? Math.max(Math.floor(load / (P.TRUCK_KEEP_PCT * cap)), Math.ceil(load / cap)) : 0);
  const nBase = dropped ? Math.max(1, nBaseFor(preFiller)) : ntrucks;
  const moreToShip = dropped ? Math.max(0, Math.ceil(P.TRUCK_KEEP_PCT * nBase * cap) - preFiller) : 0;
  const spareToFill = !dropped && ntrucks > 0 ? Math.max(0, ntrucks * cap - truck.tot) : 0;
  // SO disposition comes from the BACKEND ONLY (truck_plan_by_run.SO_Flag, surfaced as truck.soFlag): the engine
  // sets SO_CREATION only when the truck is ≥90% full AND ≥50% of the DB's combined SOQ was served, otherwise RLM
  // (a partial truck, or a full truck that served <50% of SOQ). Never recomputed from truck fill here.
  const soFlag = truck.soFlag ?? '';
  const isSoCreation = soFlag === 'SO_CREATION';
  const isSecondCfa = soFlag === 'RLM_FOR_SECOND_CFA';   // Original < 50% of SOQ → source shortfall from a 2nd CFA
  const soLabel = !soFlag ? ''
    : isSoCreation ? 'SO_CREATION'
      : isSecondCfa ? 'RLM · SECOND CFA' : 'RLM · TRUCK APPROVAL';
  const soTone = isSoCreation ? status.success : isSecondCfa ? status.error : status.warning;
  const loadPct = (cases: number) => Math.round((cases / cap) * 100);   // physical fill % of one truck load (display only)
  // ORIGINAL ÷ SOQ % (own-demand service) — the EXACT rate the engine's SO disposition keys on (backend-served,
  // truck_plan_by_run.original_fill_pct; never recomputed here). ≥50% → SO_CREATION / RLM truck approval; <50% →
  // RLM for a 2nd CFA. Distinct from the "% of SOQ" chip, which is the COMBINED fill (orig + substitute + filler).
  const origPct = truck.origFillPct ?? null;
  const origTone = origPct == null ? null
    : origPct >= P.SO_CREATION_ORIGINAL_FLOOR_PCT * 100 ? { bg: '#E9F4EC', fg: '#1B7346' }   // ≥ floor% own-demand served
      : { bg: '#F8E9E6', fg: '#E0301E' };                // <50% → routes to a 2nd CFA
  const origTip = origPct == null ? ''
    : `Original ÷ SOQ = ${origPct}% — the share of this DB's SOQ served by its OWN Step-1 demand (Original). `
      + `This is the EXACT rate the SO disposition keys on: ≥${pct(P.SO_CREATION_ORIGINAL_FLOOR_PCT)} → SO_CREATION (truck ≥${pct(P.TRUCK_FILL_TARGET_PCT)}) or RLM truck approval; `
      + `<${pct(P.SO_CREATION_ORIGINAL_FLOOR_PCT)} → RLM for a 2nd CFA (if the DB has one). Combined fill (orig+sub+filler) is ${truck.combinedFillPct ?? demandPct}% of SOQ.`;

  return (
    <Accordion
      disableGutters elevation={0} expanded={expanded} onChange={onToggle}
      slotProps={{ transition: { unmountOnExit: true } }}
      sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, my: 1, '&:before': { display: 'none' }, overflow: 'hidden', ...trackedSxFor(truck.db) }}
    >
      <AccordionSummary
        expandIcon={<ChevronRightIcon sx={{ fontSize: 18, transform: 'rotate(90deg)' }} />}
        sx={{
          flexDirection: 'row-reverse', gap: 1, px: 1.75,
          '& .MuiAccordionSummary-expandIconWrapper': { transform: 'rotate(-90deg)' },
          '& .MuiAccordionSummary-expandIconWrapper.Mui-expanded': { transform: 'rotate(0deg)' },
          '&:hover': { bgcolor: '#F5F7F8' },
          '& .MuiAccordionSummary-content': { alignItems: 'center', my: 1.15, minWidth: 0 },
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.95, width: '100%', minWidth: 0 }}>
          {/* Row 1 — identity + truck / status chips */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', fontSize: '0.95rem', color: '#303236' }}>
              {isTracked(truck.db) ? TRACK_STAR + ' ' : ''}DB {truck.db}
            </Typography>
            {truck.name && (
              <Typography variant="body2" sx={{ color: '#5C616A', fontWeight: 600, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {truck.name}
              </Typography>
            )}
            <Chip label={`T${truck.tier}`} size="small"
              sx={{ height: 21, fontSize: '0.72rem', fontWeight: 700, bgcolor: tier.bg, color: tier.fg }} />
            {/* SO disposition (backend truck_plan_by_run.SO_Flag) — hidden for transshipment (ships via cluster primary). */}
            {soLabel && !truck.isTranship && (
              <Chip label={soLabel} size="small"
                title={`SO disposition (backend · truck_plan_by_run.SO_Flag): SO_CREATION = truck ≥${pct(P.TRUCK_FILL_TARGET_PCT)} full & ≥${pct(P.SO_CREATION_ORIGINAL_FLOOR_PCT)} own-demand served; RLM · TRUCK APPROVAL = partial truck (<${pct(P.TRUCK_FILL_TARGET_PCT)}) needs RLM sign-off; RLM · SECOND CFA = <${pct(P.SO_CREATION_ORIGINAL_FLOOR_PCT)} own-demand, routed to a 2nd CFA.`}
                sx={{ height: 21, fontSize: '0.72rem', fontWeight: 800, letterSpacing: '.02em',
                  bgcolor: soTone.bg, color: soTone.fg, border: `1px solid ${soTone.border}` }} />
            )}
            <Chip label={ntrucks === 0 ? 'held · no truck' : `🚚 ${ntrucks} truck${ntrucks > 1 ? 's' : ''}`} size="small"
              sx={{ height: 21, fontSize: '0.72rem', fontWeight: 700,
                bgcolor: ntrucks === 0 ? '#F5F7F8' : '#F5F7F8', color: ntrucks === 0 ? '#5C616A' : '#2D2D2D' }} />
            {truck.truckType && (
              <Chip label={`${truck.truckType} · ${cap} cs`} size="small" title={`Truck type for this lane · ${cap} cases per truck`}
                sx={{ height: 21, fontSize: '0.72rem', fontWeight: 600, bgcolor: '#FAFAFA', color: '#2D2D2D', border: '1px solid #DFE3E6' }} />
            )}
            {truck.isTranship && (
              <Chip label={`▸ secondary${truck.cluster ? ` · cluster ${truck.cluster}` : ''}${truck.primaryTruckCount ? ` · ${truck.primaryTruckCount.toFixed(1)} primary` : ''}`} size="small"
                title="Ships on the transshipment SECONDARY truck. Cluster = shared primary route; primary trucks = Σ cluster total ÷ cluster primary max (decimal, e.g. 1.3)."
                sx={{ height: 21, fontSize: '0.72rem', fontWeight: 700, bgcolor: '#FFE8D4', color: '#C52B09', border: '1px solid #FFCDA8' }} />
            )}
          </Box>
          {/* Row 2 — every number as a labeled metric cell, so each value is readable for validation */}
          <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Box sx={{ width: 132, mr: 1.25, flexShrink: 0 }}>
              <LinearProgress variant="determinate" value={Math.min(capPct, 100)}
                sx={{ height: 9, borderRadius: 5, bgcolor: '#EEEFF1', '& .MuiLinearProgress-bar': { bgcolor: tone.solid, borderRadius: 5 } }} />
            </Box>
            {ntrucks === 0 ? (
              <Metric label="Shipped" color="#E0301E">held · 0 cs</Metric>
            ) : (
              <>
                <Metric label="Allocated" color="#303236">{truck.tot} cs</Metric>
                <Metric label="Truck cap" tip={`Capacity of one truck for this lane (cases). Trucks are NOT built as a flat N×cap — the engine uses the ${pct(P.TRUCK_KEEP_PCT)} floor + collapse/trim, so only the per-truck cap is shown.`}>{cap} cs</Metric>
                <Metric label="Utilization" color={tone.fg} tip="Total allocated ÷ dispatched truck capacity">{capPct}%</Metric>
              </>
            )}
            <Metric label="SOQ · demand">{truck.soq} cs</Metric>
            <Metric label="Combined ÷ SOQ" color={tone.fg}
              tip={`Combined fill = (Original + Substitute + Filler) ÷ SOQ = ${demandPct}%. The SO disposition keys on the ORIGINAL-only rate → see "Original ÷ SOQ".`}>{demandPct}%</Metric>
            {origPct != null && origTone && (
              <Metric label="Original ÷ SOQ" color={origTone.fg} tip={origTip}>{origPct}%</Metric>
            )}
            <Metric label="Reg-zskus">{truck.n}</Metric>
            {drawRank > 0 && (
              <Metric label="Filler draw" color="#C52B09" tip={seqTip}>{ordinal(drawRank)}{nRank ? ` / ${nRank}` : ''}</Metric>
            )}
            {drawRank > 0 && (
              <Metric label="Filler score" color="#2D2D2D" tip={seqTip}>{fillPriority.toFixed(3)}</Metric>
            )}
          </Box>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 1.25, pb: 1.25, pt: 0.75, bgcolor: '#FAFAFA' }}>
        {/* per-step allocated qty for this DB — Step 1 Original → Step 2 Substitute → Step 3 Filler = Total.
            For a dropped lane, Steps 1+2 come from the pre-drop trim; Step 3 was eliminated and nothing shipped. */}
        {dropped && (
          <Box sx={{ px: 1.25, py: 0.85, mb: 1, bgcolor: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 1.5, fontSize: '0.8rem', color: '#602320' }}>
            <b style={{ color: '#E0301E' }}>⚠ Lane cancelled at Step 3.</b> Steps 1+2 allocated <b>{preFiller}</b> cs, but even one truck couldn&apos;t reach ≥{pct(P.TRUCK_KEEP_PCT)} — so the whole lane was <b>dropped (not shipped)</b> and this stock cascades to the next run.
          </Box>
        )}
        {!dropped && cascaded > 0 && (
          <Box sx={{ px: 1.25, py: 0.85, mb: 1, bgcolor: '#F5F7F8', border: '1px solid #DFE3E6', borderRadius: 1.5, fontSize: '0.8rem', color: '#2D2D2D' }}>
            <b style={{ color: '#2D2D2D' }}>↷ Shipped {ntrucks} full truck{ntrucks > 1 ? 's' : ''} ({truck.tot} cs).</b> A <b>{cascaded} cs</b> overflow beyond the {ntrucks}×{cap} = {ntrucks * cap} cap couldn&apos;t fill another ≥{pct(P.TRUCK_KEEP_PCT)} truck, so only that tail <b>cascades to the next run</b> (the truck still ships at 100%).
          </Box>
        )}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', px: 1.25, py: 1, mb: 1,
          bgcolor: '#fff', border: '1px solid', borderColor: 'divider', borderRadius: 1.5, fontSize: '0.82rem', color: '#2D2D2D' }}>
          <Box><span style={{ color: '#5C616A' }}>Step 1 · Original</span> <b style={{ color: '#2D2D2D' }}>{stepOrig}</b> cs</Box>
          <span style={{ color: '#DFE3E6' }}>＋</span>
          <Box><span style={{ color: '#5C616A' }}>Step 2 · Substitute</span> <b style={{ color: '#1B7346' }}>{stepSub}</b> cs</Box>
          <span style={{ color: '#DFE3E6' }}>＋</span>
          <Box><span style={{ color: '#5C616A' }}>Step 3 · Filler</span> <b style={{ color: dropped ? '#E0301E' : '#C52B09' }}>{stepFil}</b> cs{dropped ? ' · eliminated' : ''}</Box>
          <span style={{ color: '#5C616A' }}>＝</span>
          <Box sx={{ px: 1, py: 0.25, bgcolor: dropped ? '#FEF2F2' : '#ECFDF5', borderRadius: 1 }}>
            {dropped
              ? <><span style={{ color: '#E0301E' }}>shipped</span> <b style={{ color: '#E0301E' }}>0</b> cs · cancelled</>
              : <><span style={{ color: '#1B7346' }}>Total allocated</span> <b style={{ color: '#1B7346' }}>{truck.tot}</b> cs</>}
          </Box>
        </Box>
        {/* truck type + capacity + how much more is required to ship (dropped) / to fill (shipped) */}
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center', px: 1.25, py: 0.85, mb: 1,
          bgcolor: '#fff', border: '1px solid', borderColor: 'divider', borderRadius: 1.5, fontSize: '0.82rem', color: '#2D2D2D' }}>
          <Box><span style={{ color: '#5C616A' }}>Truck type</span> <b style={{ color: '#2D2D2D' }}>{truck.truckType || '—'}</b></Box>
          <span style={{ color: '#DFE3E6' }}>·</span>
          <Box><span style={{ color: '#5C616A' }}>Capacity</span> <b style={{ color: '#2D2D2D' }}>{cap}</b> cs/truck{nBase > 1 ? ` × ${nBase} = ${nBase * cap} cs` : ''}</Box>
          <span style={{ color: '#DFE3E6' }}>·</span>
          {dropped
            ? <Box sx={{ color: '#E0301E', fontWeight: 700 }}>needs {moreToShip} more cs to reach {pct(P.TRUCK_KEEP_PCT)} &amp; ship</Box>
            : ntrucks > 0
              ? <Box><span style={{ color: '#5C616A' }}>spare room</span> <b style={{ color: '#C52B09' }}>{spareToFill}</b> cs left to fill</Box>
              : <Box sx={{ color: '#5C616A' }}>no truck dispatched</Box>}
        </Box>
        {truck.clusterCombine && (() => {
          const cc = truck.clusterCombine!;
          const trimAtPrimary = Math.max(0, cc.combined_load - cc.primary_ships);
          return (
            <Box sx={{ px: 1.25, py: 1, mb: 1, bgcolor: '#FFE8D4', border: '1px solid #FFCDA8', borderLeft: '3px solid #C52B09', borderRadius: 1.5, fontSize: '0.8rem', color: '#2D2D2D' }}>
              <Box sx={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.03em', fontSize: '0.68rem', color: '#8A3A0C', mb: 0.5 }}>
                ▸ Cluster {cc.code} primary truck · combine view (visualization)
              </Box>
              <Box sx={{ mb: 0.5 }}>
                The per-DB <b>secondary trucks below are the ACTUAL final trucks that ship</b> — their reg-zsku &amp; SKU detail
                is the <b>final (post-trim) cases</b>. This primary truck is the <b>cluster-level combine</b> (built last from
                those secondary trucks), and its capacity is what caps the shipment:
              </Box>
              <Box sx={{ fontFamily: 'monospace', display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
                <span>cluster combined <b>{cc.combined_load}</b> cs</span><span style={{ color: '#A1A8B3' }}>÷</span>
                <span>primary cap <b>{cc.primary_cap}</b></span><span style={{ color: '#A1A8B3' }}>=</span>
                <span style={{ color: '#1B7346', fontWeight: 800 }}>{cc.primary_trucks} full primary truck{cc.primary_trucks === 1 ? '' : 's'}</span>
                <span style={{ color: '#A1A8B3' }}>→ ships</span><span style={{ fontWeight: 800 }}>{cc.primary_ships} cs</span>
                {trimAtPrimary > 0 && <span style={{ color: '#C52B09', fontWeight: 800 }}>· trim {trimAtPrimary} cs at cluster level</span>}
              </Box>
              {cc.db_trimmed > 0 && (
                <Box sx={{ mt: 0.5 }}>
                  This DB: secondary built <b>{cc.db_sec_built}</b> → <b style={{ color: '#C52B09' }}>−{cc.db_trimmed}</b> (its share of the cluster trim) → ships <b style={{ color: '#1B7346' }}>{cc.db_ships}</b> cs.
                </Box>
              )}
              <Box sx={{ mt: 0.5, fontWeight: 700, color: '#1B7346' }}>
                Only this <b>transshipment (secondary) truck</b> goes to <b>SO_CREATION</b> — the primary truck is the combine view, not a separate order.
              </Box>
            </Box>
          );
        })()}
        <Section title="reg-zsku level" count={truck.lines.length}
          color="#2D2D2D" tint="#F5F7F8" defaultOpen
          subtitle={truck.clusterCombine ? 'final (post-trim) shipped cases on the secondary truck — after the cluster primary combine' : undefined}>
          <LineTable lines={truck.lines} />
        </Section>
        {(truck.filler_calc?.length ?? 0) > 0 && (
          <Section title="filler fill · how each is calculated" count={truck.filler_calc!.length}
            color="#2D2D2D" tint="#F5F7F8"
            subtitle={`${truck.filler_calc!.filter((f) => f.alloc > 0).length} filled · spare truck room, no solver`}>
            <FillerTable rows={truck.filler_calc!} />
          </Section>
        )}
        {truck.loads.map((ld) => {
          // secondary truck: show the PRE-cluster-trim planned fill → shipped fill when the cluster pass trimmed it
          // (planned differs from cases). This is the "how the secondary truck filled before the primary combine".
          const trimmed = ld.planned != null && ld.planned !== ld.cases;
          const sub = trimmed
            ? `built ${ld.planned} / ${cap} cs (${loadPct(ld.planned!)}%) → ships ${ld.cases} / ${cap} cs (${loadPct(ld.cases)}%) after the cluster primary combine · order ${ld.order} · FEFO`
            : `${ld.cases} / ${cap} cs · ${loadPct(ld.cases)}% · order ${ld.order} · FEFO`;
          // Transshipment ships on the PRIMARY (cluster) truck — the only truck sent to the order — so the
          // SECONDARY truck's SO disposition is meaningless; hide the SO flag on transshipment secondary trucks.
          const showSoFlag = soLabel && !truck.isTranship;
          return (
          <Section key={ld.no} title={`Truck ${ld.no} · ${ld.truckid}`}
            subtitle={sub}
            count={ld.skus.length} color="#C52B09" tint="#FFE8D4" defaultOpen={ld.no === 1}
            extra={showSoFlag ? <Chip label={soLabel} size="small"
              sx={{ height: 18, fontSize: '0.62rem', fontWeight: 700, letterSpacing: '.02em',
                bgcolor: soTone.bg, color: soTone.fg, border: `1px solid ${soTone.border}` }} /> : undefined}>
            <SkuTable skus={ld.skus} dbCode={truck.db} dbName={truck.name} order={ld.order} />
          </Section>
        ); })}
      </AccordionDetails>
    </Accordion>
  );
}
