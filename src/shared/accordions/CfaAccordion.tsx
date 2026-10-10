import { useState } from 'react';
import {
  Accordion, AccordionSummary, AccordionDetails, Box, Chip, Stack, Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import type { Cfa } from '../../types';
import TruckAccordion from './TruckAccordion';
import Metric from '../Metric';
import { fillTone } from '../../theme/muiTheme';
import { useOeParams, pct } from '../OeParams';

const fmt = (n: number) => n.toLocaleString();

export default function CfaAccordion({ cfa, defaultOpen }: { cfa: Cfa; defaultOpen: boolean }) {
  const P = useOeParams();
  const [open, setOpen] = useState(defaultOpen);
  const [openTruck, setOpenTruck] = useState<string | null>(null);
  const fill = cfa.soq > 0 ? Math.round((cfa.tot / cfa.soq) * 100) : 0;
  const nTrucks = cfa.trucks.reduce((s, t) => s + t.loads.length, 0);   // actual dispatched trucks (not lane count)
  const held = cfa.trucks.filter((t) => t.dropped).length;              // lanes CANCELLED at the ≥65% truck rule (no truck)
  const shipped = cfa.trucks.length - held;                             // lanes that actually got a truck
  const rlmApproval = cfa.trucks.filter((t) => t.soFlag === 'RLM_TRUCK_APPROVAL' && !t.isTranship).length;  // partial-truck DBs → RLM sign-off
  const rlmSecCfa = cfa.trucks.filter((t) => t.soFlag === 'RLM_FOR_SECOND_CFA' && !t.isTranship).length;    // <50% own-demand → routed to a 2nd CFA
  const atp = cfa.atp ?? 0;                                             // CFA stock before allocation (all ZSKUs)
  const drawn = atp > 0 ? Math.round((cfa.tot / atp) * 100) : 0;        // % of the CFA's stock used
  const fillT = fillTone(fill);

  return (
    <Accordion
      disableGutters elevation={0} expanded={open} onChange={() => setOpen((v) => !v)}
      slotProps={{ transition: { unmountOnExit: true } }}
      sx={{
        border: '1px solid', borderColor: 'divider', borderRadius: 2.5, mb: 1.25,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)', '&:before': { display: 'none' }, overflow: 'hidden',
        borderLeft: '4px solid', borderLeftColor: 'primary.main',
      }}
    >
      <AccordionSummary
        expandIcon={<ChevronRightIcon sx={{ fontSize: 18 }} />}
        sx={{
          flexDirection: 'row-reverse', gap: 1.25, px: 2.25,
          '& .MuiAccordionSummary-expandIconWrapper.Mui-expanded': { transform: 'rotate(90deg)' },
          '&:hover': { bgcolor: '#F5F5F5' },
          '& .MuiAccordionSummary-content': { alignItems: 'center', gap: 1.5, my: 1.5, flexWrap: 'wrap' },
        }}
      >
        <Typography sx={{ fontWeight: 700, fontSize: '1rem', color: '#1C1C1C' }}>CFA {cfa.cfa}</Typography>
        {/* alerts stay as colored chips — they're exceptions worth surfacing */}
        {held > 0 && (
          <Chip label={`🚫 ${held} held`} size="small"
            title={`Lanes cancelled at the ≥${pct(P.TRUCK_KEEP_PCT)}-per-truck rule — Steps 1+2 allocated then released; cases cascade to the next run`}
            sx={{ height: 22, fontSize: '0.72rem', fontWeight: 700, bgcolor: '#FEF2F2', color: '#E0301E' }} />
        )}
        {rlmApproval > 0 && (
          <Chip label={`⚠ ${rlmApproval} RLM truck approval`} size="small"
            title={`DBs whose truck is a partial (<${pct(P.TRUCK_FILL_TARGET_PCT)}) load — needs RLM sign-off before the SO is created (RLM_TRUCK_APPROVAL)`}
            sx={{ height: 22, fontSize: '0.72rem', fontWeight: 700, bgcolor: '#FBEBE0', color: '#D04A02' }} />
        )}
        {rlmSecCfa > 0 && (
          <Chip label={`⚠ ${rlmSecCfa} RLM 2nd CFA`} size="small"
            title={`DBs served <${pct(P.SO_CREATION_ORIGINAL_FLOOR_PCT)} by their own demand — the shortfall is routed to a second CFA (RLM_FOR_SECOND_CFA)`}
            sx={{ height: 22, fontSize: '0.72rem', fontWeight: 700, bgcolor: '#FDECEA', color: '#A32020' }} />
        )}
        <Box sx={{ flex: 1, minWidth: 8 }} />
        {/* the numbers as a clean labeled strip */}
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', rowGap: 0.75 }}>
          <Metric label="DBs">{shipped}</Metric>
          {nTrucks > 0 && <Metric label="Trucks">{nTrucks}</Metric>}
          <Metric label="Allocated" color="#1C1C1C">{fmt(cfa.tot)} cs</Metric>
          <Metric label="SOQ · demand">{fmt(cfa.soq)} cs</Metric>
          <Metric label="Fill" color={fillT.fg}>{fill}%</Metric>
          {atp > 0 && (
            <Metric label="Stock drawn" color="#21A366" tip={`CFA stock ${fmt(atp)} → ${fmt(atp - cfa.tot)} remaining after allocation`}>{drawn}%</Metric>
          )}
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 1.5, py: 1 }}>
        <Stack>
          {cfa.trucks.map((t) => (
            <TruckAccordion
              key={t.db} truck={t} cap={t.cap}
              expanded={openTruck === t.db}
              onToggle={() => setOpenTruck((v) => (v === t.db ? null : t.db))}
            />
          ))}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
