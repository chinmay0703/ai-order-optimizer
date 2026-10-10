import { Table, TableBody, TableCell, TableHead, TableRow, Box } from '@mui/material';
import type { FillerCalc } from '../../types';
import { useOeParams, pct } from '../OeParams';
import { useRegZskuDesc } from '../RegZskuDesc';
import { isUncappedRoom, NO_CAP_LABEL, NO_CAP_TIP } from '../roomCap';

// Step-3 filler "show your work": every eligible filler competes for the lane's spare truck room under FOUR caps;
// allocated = the MIN of them, and "Limited by" is whichever cap bound it. There is no solver — this is the exact min.
// The cap labels (Norm room, add-on %) are read from oe_parameters — never hardcode 1.2 / 35%.
const GREEN = '#21A366', RED = '#DC2C25', MUTED = '#7A756D', RULE = '#E5E2DB', ROWLINE = '#EFEEEB', CREAM = '#FAF9F7', INK = '#1C1C1C';

// which of the four caps bound this filler — matches the reason substring so it stays correct when the % values change.
function isBound(reason: string, key: string): boolean {
  const hit = (reason || '').toLowerCase();
  return (key === 'pool' && hit.includes('cfa stock')) ||
    (key === 'room' && hit.includes('norm')) ||
    (key === 'addon' && hit.includes('add-on')) ||
    (key === 'truck' && hit.includes('truck'));
}

// a cap value's style: the BINDING cap (the one equal to the min) gets a filled pill — green if it still yielded cases,
// red if it was the 0 that blocked the filler. The other caps are quiet numbers, faded to the hairline when 0.
function capSx(v: number, reason: string, k: string, alloc: number) {
  if (isBound(reason, k)) {
    const on = alloc > 0;
    return { display: 'inline-block', px: 0.7, py: '1px', borderRadius: '999px', fontVariantNumeric: 'tabular-nums' as const,
      bgcolor: on ? '#E7F3E7' : '#FBEAEA', color: on ? GREEN : RED, fontWeight: 800, border: `1px solid ${on ? '#B7E0C0' : '#F0C9C7'}` };
  }
  return { color: v <= 0 ? RULE : MUTED, fontWeight: 400, fontVariantNumeric: 'tabular-nums' as const };
}

export default function FillerTable({ rows }: { rows: FillerCalc[] }) {
  const P = useOeParams();
  const descOf = useRegZskuDesc();   // reg-zsku old_material_description (from region_sku_master, via API)
  const normLbl = `${P.NORM_MULTIPLIER}×Norm`;      // e.g. "1.2×Norm" / "1.4×Norm" — live from oe_parameters
  const addonLbl = pct(P.ADDON_CAP_PCT);            // e.g. "35%" / "40%"
  const COLS: { h: string; tip?: string }[] = [
    { h: 'Filler' }, { h: 'Description' }, { h: 'Rank' },
    { h: 'CFA pool → left', tip: 'Reserved CFA stock for THIS run, already net of the originals + substitutes drawn upstream. Shown as "pool when this DB\'s turn came → what is left after this DB" — so the running depletion across DBs is visible. Lanes fill in CFA→DB order, so an earlier DB can leave 0 for a later one.' },
    { h: `${normLbl} room`, tip: `How many more cases the DB may hold of this SKU: ceil(${normLbl}) − on-hand − Step-1 own − substitute already received.` },
    { h: `${addonLbl} left`, tip: `Remaining (Substitution + Filler) ≤ ${addonLbl}-of-Combined-SOQ add-on budget — shared with the substitutes.` },
    { h: 'Truck room', tip: "Spare capacity left on this lane's trucks after originals + substitutes." },
    { h: 'Allocated', tip: `Filler cases = min( CFA pool, ${normLbl} room, ${addonLbl} left, Truck room ). Then this much is drawn from the CFA pool.` },
    { h: 'Limited by', tip: 'Which of the four caps stopped this filler (0 = a cap was already exhausted).' },
  ];
  return (
    <Box sx={{ bgcolor: '#fff', borderRadius: '8px', overflowX: 'auto', border: `1px solid ${RULE}` }}>
      <Box sx={{ px: 1.25, py: 0.75, fontSize: '0.72rem', color: MUTED, borderBottom: `1px solid ${RULE}` }}>
        Allocated&nbsp;=&nbsp;<b style={{ color: INK }}>min(</b>&nbsp;CFA pool&nbsp;·&nbsp;{normLbl} room&nbsp;·&nbsp;{addonLbl} left&nbsp;·&nbsp;Truck room&nbsp;<b style={{ color: INK }}>)</b>
        &nbsp;— no solver; the <b style={{ color: GREEN }}>binding cap</b> is the highlighted pill and is named under <b>Limited by</b>.
      </Box>
      <Table size="small" sx={{ '& td, & th': { py: 0.7, px: 1.25, fontSize: '0.8rem', whiteSpace: 'nowrap', borderBottom: `1px solid ${ROWLINE}` } }}>
        <TableHead>
          <TableRow sx={{ bgcolor: '#F1F1F0' }}>
            {COLS.map((c, i) => (
              <TableCell key={c.h} align={i < 2 ? 'left' : i === COLS.length - 1 ? 'left' : 'right'}
                title={c.tip || undefined}
                sx={{ color: MUTED, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
                  fontSize: '0.68rem', cursor: c.tip ? 'help' : undefined }}>
                {c.h}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r, i) => {
            const on = r.alloc > 0;
            return (
              <TableRow key={i} hover sx={{ bgcolor: i % 2 ? CREAM : '#fff',
                '& td:first-of-type': { borderLeft: `3px solid ${on ? GREEN : 'transparent'}` } }}>
                <TableCell sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: INK }}>{r.z}</TableCell>
                <TableCell sx={{ color: MUTED, minWidth: 220, '&&': { whiteSpace: 'normal' } }} title={descOf(r.z) || r.name}>{descOf(r.z) || r.name || '—'}</TableCell>
                <TableCell align="right" sx={{ color: MUTED }}>{r.rank}</TableCell>
                <TableCell align="right" title={`reserved for this run, already net of orig+sub — ${r.pool} when this DB's turn came, ${r.poolAfter} left for the next DB`}>
                  <Box component="span" sx={capSx(r.pool, r.reason, 'pool', r.alloc)}>{r.pool}</Box>
                  <Box component="span" sx={{ color: MUTED, fontWeight: 400, ml: 0.5 }}>→ {r.poolAfter}</Box>
                </TableCell>
                <TableCell align="right" title={isUncappedRoom(r.room) ? NO_CAP_TIP : `ceil(${normLbl}×${r.norm}) − on-hand ${r.onhand} − Step-1 ${r.step1} − sub ${r.sub}`}>
                  {isUncappedRoom(r.room)
                    ? <Box component="span" sx={{ color: GREEN, fontWeight: 700 }}>{NO_CAP_LABEL}</Box>
                    : <Box component="span" sx={capSx(r.room, r.reason, 'room', r.alloc)}>{r.room}</Box>}
                </TableCell>
                <TableCell align="right"><Box component="span" sx={capSx(r.addon, r.reason, 'addon', r.alloc)}>{r.addon}</Box></TableCell>
                <TableCell align="right"><Box component="span" sx={capSx(r.truck, r.reason, 'truck', r.alloc)}>{r.truck}</Box></TableCell>
                <TableCell align="right">
                  <Box component="span" sx={{ display: 'inline-block', minWidth: 22, textAlign: 'center', px: 0.7, py: '1px', borderRadius: '999px',
                    bgcolor: on ? GREEN : '#EDEBE6', color: on ? '#fff' : MUTED, fontWeight: 800, fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' }}>{r.alloc}</Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-block', px: 0.85, py: '2px', borderRadius: '999px', fontSize: '0.64rem', fontWeight: 700,
                    maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle',
                    bgcolor: on ? '#E7F3E7' : '#F1F1F0', color: on ? GREEN : MUTED, border: `1px solid ${on ? '#B7E0C0' : RULE}` }}>{r.reason}</Box>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Box>
  );
}
