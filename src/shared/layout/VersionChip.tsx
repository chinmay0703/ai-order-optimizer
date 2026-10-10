import { useEffect, useState } from 'react';
import { Box, Tooltip } from '@mui/material';
import { api } from '../../api';
import { SANS, MONO } from '../../theme/pdartTokens';

/* VersionChip — the running build's identity, shown top-right in the masthead. Minimal: ENVIRONMENT (DEV/QA/PROD from
   the deploy branch), the VERSION (the git semver tag), and the build TIME. Data is GET /api/v1/version:
   {version, describe, branch, built_at}. `version` is the clean nearest tag (v1.1.0); `describe` is the full
   git-describe (v1.1.0-3-gabc123 when commits past the tag) shown in the tooltip. Best-effort — if the call fails or
   returns nothing it renders NOTHING, so it can never break the header. */

type VersionInfo = { version?: string; describe?: string; branch?: string; built_at?: string };

const GOLD = '#D98A00';

/** Deploy branch → environment label. Production is the `prod` branch (NOT `main`) — handled ahead of it existing;
    any other/unknown branch shows its own name uppercased. */
function envLabel(branch?: string): string {
  const b = (branch || '').trim().toLowerCase();
  if (['prod', 'production'].includes(b)) return 'PROD';
  if (b === 'qa') return 'QA';
  if (['develop', 'dev', 'development'].includes(b)) return 'DEV';
  return (branch || '').toUpperCase() || '—';
}

function fmtBuilt(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined,
    { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function VersionChip() {
  const [v, setV] = useState<VersionInfo | null>(null);

  useEffect(() => {
    let alive = true;
    api.version().then((d) => { if (alive) setV(d as VersionInfo); }).catch(() => { /* silent — never break the header */ });
    return () => { alive = false; };
  }, []);

  if (!v || (!v.version && !v.branch)) return null;

  const env = envLabel(v.branch);
  const ver = (v.version || '').trim();            // already carries the leading 'v' (a git tag) — do NOT re-prefix
  const describe = (v.describe || '').trim();       // full identity: tag-N-gsha when past a tag
  const label = [env, ver].filter(Boolean).join(' · ');
  const built = fmtBuilt(v.built_at);

  const tip = (
    <Box sx={{ fontFamily: SANS, fontSize: 12, lineHeight: 1.6, py: 0.25 }}>
      <Box sx={{ fontWeight: 800, letterSpacing: '.04em' }}>{env}</Box>
      {ver && <Box>AIDEN {ver}</Box>}
      {describe && describe !== ver && <Box sx={{ fontFamily: MONO, opacity: 0.8 }}>{describe}</Box>}
      {built && <Box sx={{ opacity: 0.85 }}>{built}</Box>}
    </Box>
  );

  return (
    <Tooltip title={tip} arrow>
      <Box sx={{
        display: { xs: 'none', sm: 'inline-flex' }, alignItems: 'center', gap: 0.75, flexShrink: 0,
        fontFamily: MONO, fontSize: 11, lineHeight: 1, letterSpacing: '.02em', whiteSpace: 'nowrap',
        color: 'rgba(255,255,255,0.82)', bgcolor: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.20)', borderRadius: '7px', padding: '5px 9px', cursor: 'default',
        '&:hover': { borderColor: GOLD, bgcolor: 'rgba(217,138,0,0.14)' },
      }}>
        <Box component="span" sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: GOLD, flexShrink: 0,
          boxShadow: '0 0 0 2px rgba(217,138,0,0.28)' }} />
        {label}
      </Box>
    </Tooltip>
  );
}
