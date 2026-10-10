import { useState } from 'react';
import {
  Box, Button, Dialog, DialogActions, DialogContent, Divider, IconButton, ListItemIcon,
  Menu, MenuItem, Stack, TextField, Tooltip,
} from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import { api } from '../../api';
import { clearSession, refreshUser, type AuthUser } from '../auth';
import { C, RADIUS, SANS, SERIF } from '../../theme/pdartTokens';

/**
 * The signed-in user's avatar in the masthead — on EVERY screen size, always top-right.
 *
 * Replaces the sidebar-footer logout, which was unreachable on mobile once the sidebar became a bottom nav.
 * Two actions only, as specified: My profile (edit username / password) and Sign out.
 *
 * The avatar is a GOLD PASTEL disc (soft #FBEBC8 fill) with the deep gold partner tone for the initial, so the
 * contrast still reads on the navy masthead — a pastel is a surface, never the text colour.
 */

const PASTEL_GOLD = '#FBEBC8';   // soft tint — the surface
const DEEP_GOLD = '#7A5210';     // its partner tone — the ink on top (AA on the pastel)

export default function ProfileMenu({ user }: { user: AuthUser }) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [open, setOpen] = useState(false);           // the profile dialog
  const [username, setUsername] = useState(user.username);
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const initial = (user.username || '?').trim().charAt(0).toUpperCase();

  const openProfile = () => {
    setAnchor(null);
    setUsername(user.username); setCurrentPassword(''); setPassword(''); setConfirm('');
    setErr(null); setOk(null); setOpen(true);
  };

  const save = async () => {
    setErr(null); setOk(null);
    const changingPassword = !!password;
    if (changingPassword && password !== confirm) { setErr('The two new passwords do not match'); return; }
    if (changingPassword && !currentPassword) { setErr('Enter your current password to set a new one'); return; }
    const body: Record<string, string> = {};
    if (username.trim() && username.trim() !== user.username) body.username = username.trim();
    if (changingPassword) { body.password = password; body.current_password = currentPassword; }
    if (Object.keys(body).length === 0) { setErr('Nothing to change'); return; }

    setBusy(true);
    try {
      const updated = (await api.updateMe(body)) as AuthUser;
      refreshUser(updated);                        // keep the header/sidebar in step without a reload
      setOk('Saved');
      setCurrentPassword(''); setPassword(''); setConfirm('');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', position: 'relative', zIndex: 2 }}>
        <Tooltip title={user.username} arrow>
          <IconButton onClick={(e) => setAnchor(e.currentTarget)} aria-label="Account menu"
            aria-haspopup="menu" aria-expanded={!!anchor}
            sx={{ p: 0.4, border: '1px solid rgba(255,255,255,0.28)',
              '&:hover': { borderColor: PASTEL_GOLD, bgcolor: 'rgba(251,235,200,0.14)' } }}>
            <Box sx={{
              width: { xs: 30, sm: 34 }, height: { xs: 30, sm: 34 }, borderRadius: '50%',
              bgcolor: PASTEL_GOLD, color: DEEP_GOLD, fontFamily: SANS, fontWeight: 800,
              fontSize: { xs: 13.5, sm: 15 }, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{initial}</Box>
          </IconButton>
        </Tooltip>
      </Box>

      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { minWidth: { xs: 196, sm: 232 }, borderRadius: `${RADIUS.md}px`, mt: 0.75 } } }}>
        <Box sx={{ px: { xs: 1.5, sm: 2 }, py: { xs: 1, sm: 1.25 } }}>
          <Box sx={{ fontFamily: SANS, fontWeight: 800, fontSize: { xs: 13, sm: 14 }, color: C.navy,
            overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.username}</Box>
          <Box sx={{ fontFamily: SANS, fontSize: { xs: 10.5, sm: 11.5 }, color: C.muted }}>
            {user.is_admin ? 'Administrator' : (user.can_access_run ? 'User · run access' : 'User')}
          </Box>
        </Box>
        <Divider />
        <MenuItem onClick={openProfile} sx={{ py: 1.1 }}>
          <ListItemIcon><PersonOutlineIcon sx={{ fontSize: 19, color: C.navy }} /></ListItemIcon>
          <Box sx={{ fontFamily: SANS, fontSize: 14 }}>My profile</Box>
        </MenuItem>
        <MenuItem onClick={() => { setAnchor(null); clearSession(); }} sx={{ py: 1.1 }}>
          <ListItemIcon><LogoutIcon sx={{ fontSize: 19, color: C.alertRed }} /></ListItemIcon>
          <Box sx={{ fontFamily: SANS, fontSize: 14, color: C.alertRed }}>Sign out</Box>
        </MenuItem>
      </Menu>

      <Dialog open={open} onClose={() => !busy && setOpen(false)} maxWidth="xs" fullWidth
        slotProps={{ paper: { sx: { borderRadius: `${RADIUS.md}px` } } }}>
        <Box sx={{ px: 2.5, py: 1.75, bgcolor: PASTEL_GOLD, borderBottom: `1px solid ${C.border}` }}>
          <Box sx={{ fontFamily: SERIF, fontWeight: 700, fontSize: 17, color: DEEP_GOLD }}>My profile</Box>
          <Box sx={{ fontFamily: SANS, fontSize: 12, color: DEEP_GOLD, opacity: 0.85 }}>
            Change your username, or set a new password
          </Box>
        </Box>
        <DialogContent sx={{ pt: 2.5 }}>
          <Stack spacing={2}>
            <TextField label="Username" size="small" fullWidth value={username}
              onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
            <Divider sx={{ '&::before, &::after': { borderColor: C.border } }}>
              <Box sx={{ fontFamily: SANS, fontSize: 11, color: C.muted, letterSpacing: '.06em' }}>
                CHANGE PASSWORD (OPTIONAL)
              </Box>
            </Divider>
            <TextField label="Current password" type="password" size="small" fullWidth value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
            <TextField label="New password" type="password" size="small" fullWidth value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
              helperText="At least 8 characters" />
            <TextField label="Confirm new password" type="password" size="small" fullWidth value={confirm}
              onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password"
              error={!!confirm && confirm !== password}
              helperText={confirm && confirm !== password ? 'Does not match' : ' '} />
            {err && <Box sx={{ fontFamily: SANS, fontSize: 13, color: C.alertRed }}>{err}</Box>}
            {ok && <Box sx={{ fontFamily: SANS, fontSize: 13, color: C.success }}>{ok}</Box>}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 2.5, pb: 2 }}>
          <Button onClick={() => setOpen(false)} disabled={busy}
            sx={{ textTransform: 'none', color: C.muted }}>Close</Button>
          <Button onClick={save} disabled={busy} variant="contained"
            sx={{ textTransform: 'none', bgcolor: C.navy, '&:hover': { bgcolor: C.navyDark } }}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
