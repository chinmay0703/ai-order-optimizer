import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Box } from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import CheckIcon from '@mui/icons-material/Check';
import { C, MONO, RADIUS, SHADOW } from '../theme/pdartTokens';

/* Themed dropdown for the run-context header (Run date · CFA scope).
   Deliberately NOT a native <select> (its popup is OS-styled, off-theme) and NOT a MUI Popover/Menu
   (those portal to <body> and position with getBoundingClientRect + fixed, which mis-aligns under the
   app-wide `body { zoom: 0.9 }`). This menu is absolutely positioned relative to its own trigger, so it
   stays glued to the field at any zoom, and every surface is themed (navy/gold, cream hover, gold check). */
export default function RunContextSelect({
  label, value, options, onChange, icon, accent = C.navy,
  format = (v) => v, align = 'left', minMenuWidth = 150, title, emptyText = '—',
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  icon?: ReactNode;
  accent?: string;
  format?: (v: string) => string;
  align?: 'left' | 'right';
  minMenuWidth?: number;
  title?: string;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // when opening, highlight the current value
  useEffect(() => { if (open) setActive(Math.max(0, options.indexOf(value))); }, [open, value, options]);

  const choose = (v: string) => { onChange(v); setOpen(false); };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) { e.preventDefault(); setOpen(true); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (options[active] != null) choose(options[active]); }
  };

  return (
    <Box ref={wrapRef} sx={{ position: 'relative' }}>
      <Box role="button" tabIndex={0} aria-haspopup="listbox" aria-expanded={open} aria-label={label} title={title ?? label}
        onClick={() => setOpen((o) => !o)} onKeyDown={onKey}
        sx={{ display: 'flex', alignItems: 'center', gap: 0.7, bgcolor: '#fff', borderRadius: '9px', pl: 1.1, pr: 0.7, py: 0.6,
          boxShadow: open ? `0 0 0 2px ${accent}66, 0 2px 8px rgba(0,0,0,0.28)` : '0 1px 4px rgba(0,0,0,0.2)',
          cursor: 'pointer', userSelect: 'none', outline: 'none', transition: 'box-shadow .15s',
          '&:focus-visible': { boxShadow: `0 0 0 2px ${accent}99, 0 2px 8px rgba(0,0,0,0.28)` } }}>
        {icon}
        <Box sx={{ fontSize: 14, fontWeight: 800, color: accent, fontFamily: MONO, lineHeight: 1.15 }}>{value ? format(value) : emptyText}</Box>
        <KeyboardArrowDownIcon sx={{ fontSize: 18, color: accent, transition: 'transform .18s', transform: open ? 'rotate(180deg)' : 'none' }} />
      </Box>

      {open && (
        <Box role="listbox" sx={{ position: 'absolute', top: 'calc(100% + 6px)', [align]: 0, zIndex: 1300,
          minWidth: minMenuWidth, maxHeight: 182, overflowY: 'auto', bgcolor: '#fff',
          border: `1px solid ${C.border}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.lg, py: 0.5,
          animation: 'rcsIn .13s ease-out' }}>
          <style>{`@keyframes rcsIn { from { opacity:0; transform: translateY(-4px) } to { opacity:1; transform:none } }
            @media (prefers-reduced-motion: reduce){ [role=listbox]{ animation:none !important } }`}</style>
          {options.length === 0 && <Box sx={{ px: 1.5, py: 1, fontSize: 12.5, color: C.muted }}>— no runs yet —</Box>}
          {options.map((o, i) => {
            const sel = o === value;
            return (
              <Box key={o} role="option" aria-selected={sel} onClick={() => choose(o)} onMouseEnter={() => setActive(i)}
                sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1.25, py: 0.85, cursor: 'pointer',
                  fontFamily: MONO, fontSize: 13, fontWeight: sel ? 800 : 600, color: sel ? accent : C.slate,
                  bgcolor: i === active ? (sel ? `${accent}22` : C.cream) : (sel ? `${accent}14` : 'transparent') }}>
                <CheckIcon sx={{ fontSize: 15, color: sel ? accent : 'transparent' }} />
                {format(o)}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
