import { useEffect, useMemo, useState } from 'react';
import { Box, Typography, Button, CircularProgress, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { api } from '../../api';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';
import PageIntro from '../../shared/PageIntro';

/* OE Parameters — view / edit / reset the engine's DB-backed thresholds (the oe_parameters table).
   Edits persist to the DB on Save; they reach the running engine on the next server restart. */
interface Param { key: string; value: number; default: number; value_type: string; description: string; min: number | null; max: number | null; }

// friendly label + group per key (mirrors the sections in or_engine/rules/thresholds.py)
const META: Record<string, { label: string; group: string }> = {
  ADDON_CAP_PCT:                  { label: 'Add-on cap · Substitute + Filler',  group: 'Step 2 + 3 · Caps' },
  NORM_MULTIPLIER:                { label: 'Norm multiplier · base-stock room', group: 'Step 2 + 3 · Caps' },
  TRUCK_KEEP_PCT:                 { label: 'Truck keep floor',                  group: 'Step 3 · Truck rules' },
  TRUCK_FILL_TARGET_PCT:          { label: 'Filler fill target',               group: 'Step 3 · Truck rules' },
  SO_CREATION_ORIGINAL_FLOOR_PCT: { label: 'SO · original floor',              group: 'SAP order disposition' },
  SO_CREATION_TRUCK_FILL_PCT:     { label: 'SO · truck-fill gate',             group: 'SAP order disposition' },
};
const GROUP_ORDER = ['Step 1 · Water-fill priority', 'Step 2 + 3 · Caps', 'Step 3 · Truck rules', 'SAP order disposition'];
const isPct = (p: Param) => p.value_type === 'float' && p.key.endsWith('_PCT');

export default function OeParametersPage() {
  const [params, setParams] = useState<Param[] | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});   // key -> raw input text while editing
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);    // init TRUE: the fetch fires on mount, so the FIRST paint is the
  const [nonce, setNonce] = useState(0);           // skeleton, never a flash of "no parameters stored". NEVER infer
                                                   // "in flight" from params===null: an empty table, or a failed
                                                   // read, would then spin forever.
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);   // themed confirm dialog for "reset to defaults"

  useEffect(() => {
    let alive = true;
    setErr(null); setLoading(true);
    api.oeParameters()
      .then((r) => { if (alive) { setParams((r as { parameters: Param[] }).parameters); setEdited({}); } })
      .catch((e) => { if (alive) setErr(String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, empty AND failure
    return () => { alive = false; };
  }, [nonce]);

  // keys with a pending, valid value that differs from what's stored
  const dirty = useMemo(() => {
    const d: Record<string, number> = {};
    for (const p of params ?? []) {
      const raw = edited[p.key];
      if (raw === undefined || raw === '') continue;
      const v = Number(raw);
      if (!Number.isNaN(v) && v !== p.value) d[p.key] = v;
    }
    return d;
  }, [params, edited]);
  const dirtyCount = Object.keys(dirty).length;

  const save = async () => {
    if (!dirtyCount) return;
    setSaving(true); setErr(null); setMsg(null);
    try {
      const r = await api.setOeParameters(dirty) as { parameters: Param[] };
      setParams(r.parameters); setEdited({});
      setMsg(`Saved ${dirtyCount} change${dirtyCount > 1 ? 's' : ''} to the database — applies to the engine on the next run.`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  const reset = () => setResetOpen(true);   // open the themed confirm dialog (not window.confirm)
  const doReset = async () => {
    setResetOpen(false);
    setSaving(true); setErr(null); setMsg(null);
    try {
      const r = await api.resetOeParameters() as { parameters: Param[] };
      setParams(r.parameters); setEdited({});
      setMsg('All parameters reset to their coded defaults — applies on the next run.');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  // same page frame as the loaded view, so the three states sit exactly where the form does
  const frameSx = { p: { xs: 2, md: 4 }, maxWidth: 1040, mx: 'auto', fontFamily: SANS } as const;
  if (err && !params) return <Box sx={frameSx}><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Box>;
  if (loading) return <Box sx={frameSx}><PageSkeleton kpis={0} rows={5} /></Box>;
  if (!params || params.length === 0) return <Box sx={frameSx}><EmptyState title="No engine parameters stored yet"
    hint={<>The <code>oe_parameters</code> table came back with no rows. It seeds itself from the coded defaults the first time the backend starts — restart the API, then retry.</>} /></Box>;

  return (
    <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: 1040, mx: 'auto', fontFamily: SANS }}>
      <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>Configuration · engine thresholds</Typography>
      <Typography sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 30, mb: 0.5, lineHeight: 1.1 }}>OE Parameters</Typography>
      <PageIntro>
        The engine's tunable business thresholds, stored in the <code>oe_parameters</code> table. Edit a value and
        <b> Save</b> to persist it to the database, or <b>Reset</b> to restore every knob to its coded default. Values are
        validated on save (a fraction must be 0–1, the norm multiplier ≥ 1). A saved change is written to the table
        immediately and takes effect in the engine on the <b>next run</b>. Any knob whose value differs from its coded
        default stays <b style={{ color: C.warnText }}>gold-highlighted</b> — including after a refresh.
      </PageIntro>

      {/* action bar */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
        <Button onClick={save} disabled={!dirtyCount || saving} variant="contained"
          startIcon={saving ? <CircularProgress size={15} sx={{ color: '#fff' }} /> : <SaveIcon />}
          sx={{ bgcolor: C.green, fontWeight: 700, textTransform: 'none', px: 2.5, boxShadow: SHADOW.sm, '&:hover': { bgcolor: '#1c8f57' } }}>
          {dirtyCount ? `Save ${dirtyCount} change${dirtyCount > 1 ? 's' : ''}` : 'Save'}
        </Button>
        <Button onClick={reset} disabled={saving} variant="outlined" startIcon={<RestartAltIcon />}
          sx={{ color: C.navy, borderColor: C.border, fontWeight: 700, textTransform: 'none', '&:hover': { borderColor: C.navy, bgcolor: C.cream } }}>
          Reset to defaults
        </Button>
        <Box sx={{ flex: 1 }} />
        {msg && <Typography sx={{ fontSize: 12.5, color: C.green, fontWeight: 700 }}>✓ {msg}</Typography>}
        {err && params && <Typography sx={{ fontSize: 12.5, color: C.red, fontWeight: 700 }}>⚠ {err}</Typography>}
      </Box>

      {/* grouped parameters */}
      {GROUP_ORDER.map((group) => {
        const rows = params.filter((p) => (META[p.key]?.group ?? '') === group);
        if (!rows.length) return null;
        return (
          <Box key={group} sx={{ mb: 2.5 }}>
            <Typography sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.gold, mb: 1 }}>{group}</Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {rows.map((p) => {
                const raw = edited[p.key];
                const shownVal = raw !== undefined ? raw : String(p.value);
                const isDirty = p.key in dirty;
                const off = Number(p.value) !== Number(p.default);   // SAVED value differs from the coded default — persists across refreshes
                const gold = isDirty || off;                          // same golden highlight for an active edit OR an overridden knob
                return (
                  <Box key={p.key} sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
                    border: `1px solid ${gold ? C.gold : C.border}`,
                    borderLeft: `3px solid ${gold ? C.gold : C.border}`,
                    borderRadius: `${RADIUS.md}px`, bgcolor: gold ? '#FEFBF3' : '#fff', boxShadow: SHADOW.sm, p: 1.5 }}>
                    <Box sx={{ flex: '1 1 340px', minWidth: 280 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <Typography sx={{ fontWeight: 700, color: C.navy, fontSize: 14 }}>{META[p.key]?.label ?? p.key}</Typography>
                        <Box component="code" sx={{ fontFamily: MONO, fontSize: 10.5, color: C.muted, bgcolor: 'rgba(16,54,90,0.06)', px: 0.6, py: 0.1, borderRadius: '4px' }}>{p.key}</Box>
                        {gold && <Box sx={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: C.navy, bgcolor: '#FEFBF3', border: `1px solid ${C.gold}`, px: 0.6, py: 0.1, borderRadius: '4px' }}>{isDirty ? 'unsaved' : 'edited'}</Box>}
                      </Box>
                      <Typography sx={{ fontSize: 11.5, color: C.muted, mt: 0.3, lineHeight: 1.4 }}>{p.description}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                      <Box sx={{ textAlign: 'right' }}>
                        <input type="number" value={shownVal}
                          step={p.value_type === 'int' ? 1 : 0.01}
                          min={p.min ?? undefined} max={p.max ?? undefined}
                          onChange={(e) => setEdited((s) => ({ ...s, [p.key]: e.target.value }))}
                          style={{ width: 96, padding: '7px 10px', fontSize: 14, fontWeight: 700, fontFamily: MONO,
                            color: C.navy, background: '#fff', border: `1.5px solid ${gold ? C.gold : C.border}`, borderRadius: 6, outline: 'none', textAlign: 'right' }} />
                        {isPct(p) && <Typography sx={{ fontSize: 10, color: C.muted, mt: 0.2 }}>{Math.round(Number(shownVal || 0) * 100)}%</Typography>}
                      </Box>
                      <Box sx={{ minWidth: 96 }}>
                        <Typography sx={{ fontSize: 10.5, color: C.muted }}>default <b style={{ color: C.slate, fontFamily: MONO }}>{p.default}</b></Typography>
                        <Typography sx={{ fontSize: 10.5, color: C.muted }}>range <span style={{ fontFamily: MONO }}>{p.min ?? '−∞'}…{p.max ?? '∞'}</span></Typography>
                      </Box>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Box>
        );
      })}

      {/* themed reset-confirm dialog (replaces window.confirm) */}
      <Dialog open={resetOpen} onClose={() => setResetOpen(false)}
        PaperProps={{ sx: { borderRadius: `${RADIUS.lg}px`, border: `1px solid ${C.border}`, boxShadow: SHADOW.lg, maxWidth: 440 } }}>
        <DialogTitle sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 20, pb: 0.5 }}>
          Reset all parameters?
        </DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 13.5, color: C.slate, lineHeight: 1.5 }}>
            This restores <b>all {params?.length ?? ''} engine parameters</b> to their coded defaults and
            discards every saved override. The reset is written to the database and takes effect on the next run.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5, pt: 1, gap: 1 }}>
          <Button onClick={() => setResetOpen(false)} variant="outlined"
            sx={{ color: C.navy, borderColor: C.border, fontWeight: 700, textTransform: 'none', '&:hover': { borderColor: C.navy, bgcolor: C.cream } }}>
            Cancel
          </Button>
          <Button onClick={doReset} variant="contained" startIcon={<RestartAltIcon />}
            sx={{ bgcolor: C.red, color: '#fff', fontWeight: 700, textTransform: 'none', boxShadow: 'none', '&:hover': { bgcolor: '#B0201A', boxShadow: 'none' } }}>
            Reset to defaults
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
