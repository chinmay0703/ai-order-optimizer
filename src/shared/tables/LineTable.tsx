import { Table, TableBody, TableCell, TableHead, TableRow, Box } from '@mui/material';
import { useRegZskuDesc } from '../RegZskuDesc';
import type { Line } from '../../types';

const HEAD = ['reg-zsku', 'Description', 'Brand', 'Norm', 'DB Stk', 'SOQ', 'Orig', 'As Sub', 'As Filler', 'Shipped', 'Fill'];

// item-oriented column meanings (every reg-zsku physically on the trucks is its own row)
const TIPS: Record<string, string> = {
  Orig: 'Cases of this reg-zsku shipped for its OWN demand.',
  'As Sub': 'Cases of this reg-zsku lent as a SUBSTITUTE to another line (shows which demand it filled). Own-demand-first: a product only lends itself in DBs where it has no demand of its own.',
  'As Filler': 'Cases of this reg-zsku used as a FILLER to top up spare TRUCK space (shows the truck) — not tied to any demand.',
  Shipped: 'Physical cases of this reg-zsku on the trucks = Orig + As Sub + As Filler.',
  Fill: "This reg-zsku's OWN-demand fill = (original + substitutes it received) ÷ SOQ. Fillers do not count toward demand.",
};

export default function LineTable({ lines }: { lines: Line[] }) {
  const descOf = useRegZskuDesc();   // reg-zsku old_material_description (from region_sku_master, via API)
  return (
    <Box sx={{ bgcolor: '#fff', borderRadius: 1, overflowX: 'auto' }}>
      <Table size="small" sx={{ '& td, & th': { py: 0.75, px: 1.25, fontSize: '0.8rem', whiteSpace: 'nowrap' } }}>
        <TableHead>
          <TableRow sx={{ bgcolor: '#F5F7F8' }}>
            {HEAD.map((h, i) => (
              <TableCell
                key={h}
                align={i < 3 ? 'left' : 'right'}
                title={TIPS[h] || undefined}
                sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', fontSize: '0.68rem', cursor: TIPS[h] ? 'help' : undefined }}
              >
                {h}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {lines.map((l, i) => {
            const fill = l[2] > 0 ? Math.round((l[14] / l[2]) * 100) + '%' : '';
            return (
              <TableRow key={i} hover>
                <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{l[0]}</TableCell>
                <TableCell sx={{ whiteSpace: 'normal' }} title={descOf(l[0]) || String(l[12] ?? '')}>{descOf(l[0]) || l[12]}</TableCell>
                <TableCell>{l[1]}</TableCell>
                <TableCell align="right" sx={{ color: 'text.secondary' }}>{l[11]}</TableCell>
                <TableCell align="right" sx={{ color: 'text.secondary' }}>{l[10]}</TableCell>
                <TableCell align="right">{l[2]}</TableCell>
                <TableCell align="right">{l[3]}</TableCell>
                <TableCell align="right" sx={{ color: 'primary.main' }}>
                  {l[4] || ''}
                  {l[5] && <Box component="span" sx={{ color: '#5C616A', fontSize: '0.72rem', ml: 0.5 }}>({l[5]})</Box>}
                </TableCell>
                <TableCell align="right" sx={{ color: '#C52B09' }}>
                  {l[6] || ''}
                  {l[7] && <Box component="span" sx={{ color: '#C9A27E', fontSize: '0.72rem', ml: 0.5 }}>({l[7]})</Box>}
                </TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>{l[8]}</TableCell>
                <TableCell align="right" sx={{ color: 'text.secondary' }}>{fill}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Box>
  );
}
