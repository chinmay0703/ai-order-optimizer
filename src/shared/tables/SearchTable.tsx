import { useEffect, useMemo, useState } from 'react';
import {
  Box, Pagination, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { C } from '../../theme/pdartTokens';

type Cell = string | number;
const PAGE = 400;

// Searches across ALL rows; renders one 400-row page at a time (robust for very large sets).
export default function SearchTable({ head, rows, placeholder = 'Search…', maxHeight = 460 }: {
  head: string[]; rows: Cell[][]; placeholder?: string; maxHeight?: number;
}) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? rows.filter((r) => r.some((c) => String(c).toLowerCase().includes(s))) : rows;
  }, [rows, q]);

  useEffect(() => { setPage(1); }, [q, rows]);

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const cur = Math.min(page, pages);
  const slice = filtered.slice((cur - 1) * PAGE, cur * PAGE);

  return (
    <Box>
      <TextField size="small" fullWidth value={q} placeholder={placeholder}
        onChange={(e) => setQ(e.target.value)} sx={{ mb: 1 }} />
      <Box sx={{ maxHeight, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1.5 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {head.map((h) => (
                <TableCell key={h} sx={{ fontWeight: 700, fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase',
                  color: C.muted, bgcolor: C.headBg, borderBottom: `1px solid ${C.rule}`, whiteSpace: 'nowrap', py: 1 }}>
                  {h}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {slice.map((r, i) => (
              <TableRow key={(cur - 1) * PAGE + i} hover>
                {r.map((c, j) => (
                  <TableCell key={j} sx={{ fontSize: '0.8rem', whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums', fontWeight: j === 0 ? 600 : 400 }}>
                    {c}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="caption" color="text.secondary">
          {total.toLocaleString()} {q ? `match${total === 1 ? '' : 'es'} of ${rows.length.toLocaleString()}` : 'rows'}
          {' · '}page {cur} / {pages} ({slice.length} shown)
        </Typography>
        {pages > 1 && (
          <Pagination count={pages} page={cur} onChange={(_, p) => setPage(p)} size="small"
            siblingCount={1} boundaryCount={1} showFirstButton showLastButton />
        )}
      </Stack>
    </Box>
  );
}
