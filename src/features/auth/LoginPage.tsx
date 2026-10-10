import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Box, Button, CircularProgress, IconButton, InputAdornment, TextField } from '@mui/material';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import { api } from '../../api';
import { setSession, type AuthUser } from '../../shared/auth';

// The login gate — a faithful match of the oe-frontend "Final Designs" login: full-bleed navy (#2D2D2D) with the brand
// pattern + a bottom-up gradient, the product hero on the left, the white auth card on the right, and a footer.
// SSO is intentionally omitted (this deployment is simple username/password only). Colors are the oe-frontend tokens:
// surface-auth #2D2D2D · brand-secondary #4C5056 (accent bar) · brand-primary #2D2D2D (button) · card #FFFFFF.
const NAVY = '#FFF5ED';            // PwC orange-50 peach stage (pwc.com section tint)
const ACCENT = '#FD5108';          // PwC signature orange
const PRIMARY = '#FFAA72';         // pwc.com CTA: soft orange (orange300) with BLACK text (11:1)
const PRIMARY_HOVER = '#FE7C39';
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

function useIstClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'short' }).format(now).toUpperCase();
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
  return `${date} · IST ${time}`;
}

// deploy branch → env label (matches the header VersionChip): prod/main → PROD, qa → QA, develop → DEV.
function envLabel(branch?: string): string {
  const b = (branch || '').trim().toLowerCase();
  if (['prod', 'production', 'main'].includes(b)) return 'PROD';
  if (b === 'qa') return 'QA';
  if (['develop', 'dev', 'development'].includes(b)) return 'DEV';
  return (branch || '').toUpperCase();
}

// The running build's version for the login footer — the ACTUAL version from GET /api/v1/version (open, pre-auth),
// same source as the header chip. Renders nothing until it resolves / if unreachable, so it can never block login.
function useAppVersion(): { version?: string; branch?: string } | null {
  const [v, setV] = useState<{ version?: string; branch?: string } | null>(null);
  useEffect(() => { api.version().then((d) => setV(d as { version?: string; branch?: string })).catch(() => { /* silent */ }); }, []);
  return v;
}

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const clock = useIstClock();
  const ver = useAppVersion();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) { setErr('Enter your username and password'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.login(username.trim(), password) as { access_token: string; user: AuthUser };
      // land on Home after an actual sign-in. A plain refresh must still restore the last page, so this is a
      // one-shot marker rather than clearing the remembered page.
      sessionStorage.setItem('aoo.justLoggedIn', '1');
      setSession(r.access_token, r.user);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Login failed');
      setBusy(false);
    }
  };

  return (
    <Box sx={{ position: 'relative', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', overflowX: 'hidden',
      bgcolor: NAVY, fontFamily: FONT }}>
      {/* backdrop: plain — the right half is white, the left half the peach tint (pwc.com section style) */}
      <Box aria-hidden sx={{ position: 'absolute', inset: 0, background: { xs: '#FFFFFF', lg: 'linear-gradient(90deg, #FFF5ED 0 50%, #FFFFFF 50% 100%)' } }} />

      <Box component="main" sx={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: { xs: 'column', lg: 'row' }, gap: { xs: 5, lg: 0 }, px: { xs: 3, lg: 0 }, py: 6 }}>
        {/* LEFT — product hero */}
        <Box sx={{ width: { xs: '100%', lg: '50%' }, display: { xs: 'none', lg: 'flex' }, alignItems: 'center', justifyContent: 'center', px: { lg: 8 } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 1.5, sm: 2.5, md: 3 }, maxWidth: 520 }}>
            <Box sx={{ width: 8, height: 150, borderRadius: 999, bgcolor: ACCENT, flexShrink: 0 }} />
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Box sx={{ color: '#000', fontFamily: "'ITC Charter', Charter, Georgia, serif", fontSize: { lg: 64 }, fontWeight: 400, lineHeight: 1.05, letterSpacing: '-1px' }}>AI Order Optimizer</Box>
            </Box>
          </Box>
        </Box>

        {/* RIGHT — auth card */}
        <Box sx={{ width: { xs: '100%', lg: '50%' }, display: 'flex', alignItems: 'center', justifyContent: 'center', px: { lg: 8 } }}>
          <Box component="form" onSubmit={submit} noValidate sx={{ width: '100%', maxWidth: 416, bgcolor: '#fff', borderRadius: '6px',
            border: '1px solid #DFE3E6', boxShadow: '0 18px 48px -24px rgba(0,0,0,0.25)', p: { xs: 4, sm: 5 } }}>
            {/* logo + live IST clock */}
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
              <Box component="img" src="brand/pwc-logo.svg" alt="PwC" sx={{ height: 52 }} />
              <Box aria-hidden sx={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.08em', color: '#6B7280', fontVariantNumeric: 'tabular-nums' }}>{clock}</Box>
            </Box>

            <Box sx={{ mt: 3, mb: 2.5, textAlign: 'center', fontFamily: FONT, fontSize: 15, fontWeight: 700, letterSpacing: '.08em', color: '#6B7280' }}>Sign in to AI Order Optimizer</Box>

            {err && (
              <Box role="alert" sx={{ mb: 2, px: 1.5, py: 1, borderRadius: '6px', bgcolor: '#FDECEC', color: '#D02818',
                fontSize: 13, fontWeight: 600, border: '1px solid #F3C7C4' }}>{err}</Box>
            )}

            <Box sx={{ mb: 0.5, fontSize: 13, fontWeight: 600, color: '#4C5056' }}>Username</Box>
            <TextField fullWidth value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username"
              size="small" placeholder="Enter your username" sx={{ mb: 2 }} />

            <Box sx={{ mb: 0.5, fontSize: 13, fontWeight: 600, color: '#4C5056' }}>Password</Box>
            <TextField fullWidth type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password" size="small" placeholder="Enter your password" sx={{ mb: 3 }}
              InputProps={{ endAdornment: <InputAdornment position="end"><IconButton size="small" edge="end" onClick={() => setShow((s) => !s)} aria-label="toggle password visibility">
                {show ? <VisibilityOff sx={{ fontSize: 18, color: '#6B7280' }} /> : <Visibility sx={{ fontSize: 18, color: '#6B7280' }} />}</IconButton></InputAdornment> }} />

            <Button type="submit" fullWidth disabled={busy} variant="contained" sx={{ py: 1.15, fontWeight: 700, fontSize: 14.5,
              textTransform: 'none', borderRadius: '6px', bgcolor: PRIMARY, color: '#000', boxShadow: 'none',
              '&:hover': { bgcolor: PRIMARY_HOVER, boxShadow: 'none' }, '&.Mui-disabled': { bgcolor: '#DFE3E6', color: '#4C5056' } }}>
              {busy ? <CircularProgress size={20} sx={{ color: '#000' }} /> : 'Sign in'}
            </Button>
          </Box>
        </Box>
      </Box>

      {/* footer */}
      <Box component="footer" sx={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 1,
        px: 3, py: 3, color: '#4C5056' }}>
        {ver?.version && (
          <Box sx={{ textAlign: 'center', fontSize: 11.5, fontWeight: 600, letterSpacing: '.05em', color: '#5C616A' }}>
            App version {ver.version}{ver.branch ? ` · ${envLabel(ver.branch)}` : ''}
          </Box>
        )}
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 0.5, fontSize: 12 }}>
          <Box sx={{ width: { xs: '100%', lg: '50%' }, textAlign: 'center', px: { lg: 8 } }}>© {new Date().getFullYear()} PwC. All rights reserved. · Demo build with sample data</Box>
          <Box sx={{ width: { xs: '100%', lg: '50%' }, textAlign: 'center', px: { lg: 8 } }}>AI Order Optimizer</Box>
        </Box>
      </Box>
    </Box>
  );
}
