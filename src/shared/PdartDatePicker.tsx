import { useMemo, useState } from 'react';
import { Box, Typography, Popover, IconButton } from '@mui/material';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../theme/pdartTokens';

/* P-DART themed date picker — a fully custom calendar (NOT the browser's native <input type="date">).
   Value + emitted string are DD-Mon-YYYY (e.g. "23-Aug-2026", day NOT zero-padded), the exact format the
   run API already accepts. TODAY is highlighted in gold; the selected day is navy. */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function parse(value: string): Date | null {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3,})-(\d{4})\s*$/.exec(value || '');
  if (!m) return null;
  const mi = MON.findIndex((x) => x.toLowerCase() === m[2].slice(0, 3).toLowerCase());
  if (mi < 0) return null;
  const d = new Date(Number(m[3]), mi, Number(m[1]));
  return isNaN(d.getTime()) ? null : d;
}
/** Format a Date as DD-Mon-YYYY (day NOT zero-padded), e.g. "3-Sep-2026" — the exact string the run API accepts. */
export const fmtDate = (d: Date) => `${d.getDate()}-${MON[d.getMonth()]}-${d.getFullYear()}`;
/** DD-Mon-YYYY for TODAY — use as the default run date. */
export const todayStr = () => fmtDate(new Date());
const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export default function PdartDatePicker({ value, onChange, label, helper = 'format: DD-Mon-YYYY',
  disabled = false, minWidth = 190 }: {
  value: string; onChange: (v: string) => void; label?: string; helper?: string;
  disabled?: boolean; minWidth?: number;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const today = useMemo(() => new Date(), []);
  const selected = useMemo(() => parse(value), [value]);
  const [view, setView] = useState<Date>(() => monthStart(parse(value) ?? new Date()));

  const openCal = (el: HTMLElement) => {
    if (disabled) return;
    setView(monthStart(parse(value) ?? new Date()));   // always open on the selected month (or today)
    setAnchor(el);
  };

  const cells = useMemo(() => {
    const first = monthStart(view);
    const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < first.getDay(); i++) out.push(null);
    for (let d = 1; d <= days; d++) out.push(new Date(view.getFullYear(), view.getMonth(), d));
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [view]);

  const pick = (d: Date) => { onChange(fmtDate(d)); setAnchor(null); };
  const shift = (n: number) => setView(new Date(view.getFullYear(), view.getMonth() + n, 1));

  return (
    <Box sx={{ minWidth }}>
      {label && (
        <Typography sx={{ fontSize: 11, fontFamily: SANS, color: C.muted, mb: 0.4, lineHeight: 1 }}>{label}</Typography>
      )}
      <Box onClick={(e) => openCal(e.currentTarget)} role="button" tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openCal(e.currentTarget); } }}
        sx={{
          display: 'flex', alignItems: 'center', gap: 1, px: 1.25, height: 40, boxSizing: 'border-box',
          cursor: disabled ? 'default' : 'pointer', bgcolor: C.white, borderRadius: `${RADIUS.sm}px`,
          border: `1px solid ${anchor ? C.navy : C.rule}`, transition: 'border-color .15s',
          opacity: disabled ? 0.6 : 1,
          '&:hover': disabled ? {} : { borderColor: C.navy },
          '&:focus-visible': { outline: `2px solid ${C.gold}`, outlineOffset: 1 },
        }}>
        <CalendarMonthIcon sx={{ fontSize: 18, color: C.gold }} />
        <Typography sx={{ flex: 1, fontFamily: MONO, fontWeight: 700, fontSize: 15, color: C.navy }}>
          {value?.trim() || '—'}
        </Typography>
      </Box>
      {helper && <Typography sx={{ fontSize: 11, fontFamily: SANS, color: C.muted, mt: 0.4, lineHeight: 1 }}>{helper}</Typography>}

      <Popover open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { mt: 0.75, borderRadius: `${RADIUS.md}px`, border: `1px solid ${C.rule}`,
          boxShadow: SHADOW.lg, overflow: 'hidden' } } }}>
        <Box sx={{ width: 288, bgcolor: C.white, fontFamily: SANS }}>
          {/* navy header · month + year + prev/next */}
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            bgcolor: C.navy, color: '#fff', px: 0.75, py: 0.6 }}>
            <IconButton size="small" onClick={() => shift(-1)} aria-label="previous month"
              sx={{ color: '#fff', '&:hover': { bgcolor: 'rgba(255,255,255,.14)' } }}><ChevronLeftIcon fontSize="small" /></IconButton>
            <Typography sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 14.5 }}>
              {MON_FULL[view.getMonth()]} {view.getFullYear()}
            </Typography>
            <IconButton size="small" onClick={() => shift(1)} aria-label="next month"
              sx={{ color: '#fff', '&:hover': { bgcolor: 'rgba(255,255,255,.14)' } }}><ChevronRightIcon fontSize="small" /></IconButton>
          </Box>
          {/* weekday row */}
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', px: 1, pt: 1 }}>
            {WD.map((w) => (
              <Typography key={w} sx={{ textAlign: 'center', py: 0.5, fontSize: 10.5, fontWeight: 700,
                letterSpacing: '.04em', color: C.muted }}>{w}</Typography>
            ))}
          </Box>
          {/* day grid */}
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', px: 1, pb: 1 }}>
            {cells.map((d, i) => {
              if (!d) return <Box key={`e${i}`} />;
              const isToday = sameDay(d, today);
              const isSel = !!selected && sameDay(d, selected);
              return (
                <Box key={d.getTime()} onClick={() => pick(d)}
                  aria-label={fmtDate(d)} aria-current={isToday ? 'date' : undefined}
                  sx={{
                    textAlign: 'center', py: 0.65, fontFamily: MONO, fontSize: 12.5, cursor: 'pointer',
                    borderRadius: `${RADIUS.sm}px`, fontWeight: isSel || isToday ? 700 : 500,
                    color: isSel ? '#fff' : isToday ? C.navy : C.slate,
                    bgcolor: isSel ? C.navy : isToday ? C.goldLight : 'transparent',
                    border: `1px solid ${isToday ? C.gold : 'transparent'}`,   // gold ring marks TODAY (even when selected)
                    transition: 'background-color .1s',
                    '&:hover': { bgcolor: isSel ? C.navy : C.cream },
                  }}>{d.getDate()}</Box>
              );
            })}
          </Box>
          {/* footer · format hint + Today shortcut */}
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            borderTop: `1px solid ${C.rule}`, bgcolor: C.cream, px: 1.25, py: 0.75 }}>
            <Typography sx={{ fontSize: 10.5, fontFamily: SANS, color: C.muted }}>DD-Mon-YYYY</Typography>
            <Box component="button" onClick={() => { setView(monthStart(today)); pick(today); }}
              sx={{ border: 'none', bgcolor: 'transparent', cursor: 'pointer', fontFamily: SANS, fontSize: 11.5,
                fontWeight: 800, letterSpacing: '.03em', color: C.gold, p: 0,
                '&:hover': { textDecoration: 'underline' } }}>● Today</Box>
          </Box>
        </Box>
      </Popover>
    </Box>
  );
}
