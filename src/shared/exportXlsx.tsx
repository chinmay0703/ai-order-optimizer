/* Shared "Export to Excel" helper + button. Uses SheetJS (xlsx) fully client-side.
   CONTRACT: callers pass the COMPLETE dataset (every row), never a paginated / sliced / visible-only
   subset — the whole point is that the sheet carries ALL rows, not just the on-screen page.

   PERF: SheetJS (xlsx, ~430 KB) is loaded LAZILY via `import('xlsx')` inside each builder, so it is NOT in any
   page's initial chunk — it downloads only the first time someone actually clicks an Export button. That keeps it
   off the app's first-load path entirely. The builders are therefore async; every caller either fires-and-forgets
   or is a `() => downloadXlsx(...)` handler awaited by ExportXlsxButton, so the returned Promise is handled. */
import { useState } from 'react';
import { Box, CircularProgress } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { C, RADIUS, SHADOW } from '../theme/pdartTokens';

type Cell = string | number | boolean | null | undefined;

/** Build + download an .xlsx from a header row and ALL data rows (array-of-arrays). Loads xlsx on first use. */
export async function downloadXlsx(filename: string, headers: Cell[], rows: Cell[][], sheetName = 'Data'): Promise<void> {
  const XLSX = await import('xlsx');
  const clean = (v: Cell): string | number | boolean => (v == null ? '' : v);
  const aoa: (string | number | boolean)[][] = [headers.map(clean), ...rows.map((r) => r.map(clean))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Data').slice(0, 31));
  const name = filename.toLowerCase().endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  XLSX.writeFile(wb, name);
}

/** One workbook, MANY sheets — for a page that shows several tables (one sheet each). Sheet names deduped/trimmed. */
export async function downloadXlsxMulti(filename: string, sheets: { name: string; headers: Cell[]; rows: Cell[][] }[]): Promise<void> {
  const XLSX = await import('xlsx');
  const clean = (v: Cell): string | number | boolean => (v == null ? '' : v);
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  sheets.forEach((s, i) => {
    let nm = (s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`;
    while (used.has(nm)) nm = (nm.slice(0, 29) + i).slice(0, 31);
    used.add(nm);
    const aoa: (string | number | boolean)[][] = [s.headers.map(clean), ...s.rows.map((r) => r.map(clean))];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), nm);
  });
  const name = filename.toLowerCase().endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  XLSX.writeFile(wb, name);
}

/** Convenience for array-of-objects: ordered {key,label} columns → sheet with every row. */
export async function downloadXlsxFromObjects<T extends Record<string, unknown>>(
  filename: string, columns: { key: keyof T; label: string }[], rows: T[], sheetName = 'Data',
): Promise<void> {
  const headers = columns.map((c) => c.label);
  const body: Cell[][] = rows.map((r) => columns.map((c) => {
    const v = r[c.key];
    if (v == null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return v as Cell;
  }));
  await downloadXlsx(filename, headers, body, sheetName);
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Navy download button matching the Final Order / SAP Orders "Download Excel" affordance.
   Pass `onClick` for a client-side export (may be async — fetch-all then downloadXlsx), OR `href` for a
   server-side .xlsx endpoint (fetched as a blob so the loading state is accurate). Shows a spinner +
   "Exporting…" while the export runs, and is disabled during it. */
export function ExportXlsxButton({ onClick, href, filename = 'export.xlsx', label = 'Export Excel',
  disabled = false, size = 'md' }:
  { onClick?: () => void | Promise<void>; href?: string; filename?: string; label?: string;
    disabled?: boolean; size?: 'sm' | 'md' }) {
  const [busy, setBusy] = useState(false);
  const sm = size === 'sm';
  const run = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      if (onClick) await onClick();
      else if (href) {
        const res = await fetch(href);
        if (!res.ok) throw new Error(`export failed (HTTP ${res.status})`);
        const cd = res.headers.get('Content-Disposition') || '';
        const m = /filename="?([^";]+)"?/.exec(cd);
        saveBlob(await res.blob(), m ? m[1] : filename);
      }
    } catch (e) {
      console.error('Excel export failed:', e);
    } finally {
      setBusy(false);
    }
  };
  const off = disabled || busy;
  return (
    <Box component="button" type="button" disabled={off} onClick={() => { void run(); }}
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.6, cursor: off ? 'default' : 'pointer',
        border: 'none', px: sm ? 1.25 : 2, py: sm ? 0.5 : 1, fontSize: sm ? 12 : 13, fontWeight: 800,
        color: '#fff', fontFamily: 'inherit', whiteSpace: 'nowrap', lineHeight: 1.2,
        bgcolor: C.navy, borderRadius: `${RADIUS.sm}px`, boxShadow: SHADOW.sm, opacity: off ? 0.6 : 1,
        '&:hover': { bgcolor: off ? C.navy : C.navyDark } }}>
      {busy ? <CircularProgress size={sm ? 13 : 15} thickness={5} sx={{ color: '#fff' }} />
        : <DownloadIcon sx={{ fontSize: sm ? 15 : 17 }} />}
      {busy ? 'Exporting…' : label}
    </Box>
  );
}
