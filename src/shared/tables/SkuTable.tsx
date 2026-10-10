import { Table, TableBody, TableCell, TableHead, TableRow, Box, Chip } from '@mui/material';
import type { Sku } from '../../types';
import { status } from '../../theme/muiTheme';
import { useRegZskuDesc } from '../RegZskuDesc';

// One row per material/batch on the truck. reg-zsku = the material's OWNER; "Used As" = the role(s) that material's
// cases serve here — Original (its own demand), Sub / Filler (lent to another demand). So a material never looks like
// it belongs to the reg-zsku that only borrowed it.
const HEAD = ['Order ID', 'DB Code', 'DB Name', 'reg-zsku', 'Description', 'Used As', 'SKU', 'Qty (cs) in this truck', 'MRP', 'Batch No', 'Days to Expiry', 'PDP'];

const expTone = (d: number) => (d < 30 ? status.error : d < 60 ? status.warning : null);
const roleOf = (isSub: number, isFil: number) => (isFil ? 'Filler' : isSub ? 'Sub' : 'Original');
const ROLE: Record<string, { bg: string; fg: string; rank: number }> = {
  Original: { bg: '#EEEFF1', fg: '#2D2D2D', rank: 0 },
  Sub:      { bg: '#E6F3EC', fg: '#1B7346', rank: 1 },
  Filler:   { bg: '#FFE8D4', fg: '#C52B09', rank: 2 },
};

interface Grp { owner: string; sku: string; batch: string; mrp: number | null; days: number; pdp: string; qty: number; roles: Set<string>; }

export default function SkuTable({ skus, dbCode, dbName, order }: {
  skus: Sku[]; dbCode: string; dbName: string; order: string;
}) {
  const descOf = useRegZskuDesc();
  if (!skus.length)
    return <Box sx={{ p: 1.5, color: 'text.secondary', fontSize: '0.8rem' }}>No SKU lines.</Box>;

  // aggregate the truck's picks by (owner reg-zsku · SKU · batch): sum the cases, collect the roles it's used as.
  const m = new Map<string, Grp>();
  for (const l of skus) {
    const owner = String(l[9] ?? l[0]);
    const key = `${owner}|${l[1]}|${l[5]}`;
    let g = m.get(key);
    if (!g) { g = { owner, sku: String(l[1]), batch: String(l[5]), mrp: l[4], days: l[6], pdp: String(l[10]), qty: 0, roles: new Set() }; m.set(key, g); }
    g.qty += l[2];
    g.roles.add(roleOf(l[7], l[8]));
  }
  const rows = [...m.values()].sort((a, b) => a.owner.localeCompare(b.owner) || (a.days - b.days));

  return (
    <Box sx={{ bgcolor: '#fff', borderRadius: 1, overflowX: 'auto' }}>
      <Table size="small" sx={{ '& td, & th': { py: 0.75, px: 1.25, fontSize: '0.8rem', whiteSpace: 'nowrap' } }}>
        <TableHead>
          <TableRow sx={{ bgcolor: '#F5F7F8' }}>
            {HEAD.map((h, i) => (
              <TableCell key={h} align={i <= 6 ? 'left' : 'right'}
                sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', fontSize: '0.68rem' }}>
                {h}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((g, i) => {
            const tone = expTone(g.days);
            const roles = [...g.roles].sort((x, y) => ROLE[x].rank - ROLE[y].rank);
            return (
              <TableRow key={i} hover>
                <TableCell sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: '#1B7346' }}>{order}</TableCell>
                <TableCell sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{dbCode}</TableCell>
                <TableCell sx={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', color: 'text.secondary' }} title={dbName}>{dbName}</TableCell>
                <TableCell sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: '#2D2D2D' }}>{g.owner}</TableCell>
                <TableCell sx={{ color: 'text.secondary', whiteSpace: 'normal' }} title={descOf(g.owner)}>{descOf(g.owner) || '—'}</TableCell>
                <TableCell>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                    {roles.map((r) => (
                      <Chip key={r} label={r} size="small"
                        sx={{ height: 18, fontSize: '0.64rem', fontWeight: 800, letterSpacing: '.02em', bgcolor: ROLE[r].bg, color: ROLE[r].fg }} />
                    ))}
                  </Box>
                </TableCell>
                <TableCell sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{g.sku}</TableCell>
                <TableCell align="right"><b>{g.qty}</b></TableCell>
                <TableCell align="right" sx={{ color: 'text.secondary' }}>{g.mrp != null ? `₹${g.mrp}` : '—'}</TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: '#5C616A' }}>{g.batch}</TableCell>
                <TableCell align="right">
                  {tone
                    ? <Chip label={`${g.days} d`} size="small" sx={{ height: 18, fontSize: '0.68rem', fontWeight: 700, bgcolor: tone.bg, color: tone.fg }} />
                    : <span style={{ color: '#2D2D2D' }}>{g.days} d</span>}
                </TableCell>
                <TableCell align="right">
                  {g.pdp.toLowerCase() === 'yes'
                    ? <Chip label="PDP" size="small" sx={{ height: 18, fontSize: '0.64rem', fontWeight: 700, bgcolor: '#E9F4EC', color: '#1B7346' }} />
                    : <span style={{ color: '#5C616A', fontSize: '0.72rem' }}>{g.pdp ? 'non-PDP' : '—'}</span>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Box>
  );
}
