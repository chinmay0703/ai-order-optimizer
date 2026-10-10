import { useEffect, useState } from 'react';
import {
  Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControlLabel, IconButton, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField, Tooltip,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { api } from '../../api';
import { useAuth, type AuthUser } from '../../shared/auth';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { C, SERIF, SANS, MONO, RADIUS, SHADOW } from '../../theme/pdartTokens';

interface Row extends AuthUser { created_at: string; updated_at?: string; }
type Editing = { mode: 'new' } | { mode: 'edit'; row: Row } | null;

const chip = (label: string, bg: string, fg: string) => (
  <Box component="span" sx={{ px: 0.9, py: 0.25, borderRadius: `${RADIUS.sm}px`, bgcolor: bg, color: fg, fontSize: 11, fontWeight: 800,
    letterSpacing: '.03em', fontFamily: SANS, display: 'inline-block' }}>{label}</Box>
);

export default function UserManagementPage() {
  const { user: me } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);   // NEVER infer "in flight" from an empty list: a run with 0 users, or a
  const [err, setErr] = useState('');             // failure, would then spin forever. Starts TRUE because the fetch below
                                                  // is unconditional on mount — the first paint must be the skeleton.
  const [nonce, setNonce] = useState(0);          // bumped by the error Retry to re-run the effect
  const [editing, setEditing] = useState<Editing>(null);
  const [confirmDel, setConfirmDel] = useState<Row | null>(null);

  const load = () => {
    setErr(''); setLoading(true);
    api.listUsers().then((u) => { setRows(u as Row[]); setErr(''); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));   // finally: settles on success, on an EMPTY list AND on failure
  };
  useEffect(load, [nonce]);

  const th = { color: C.navy, fontWeight: 800, fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.05em', fontFamily: SANS };

  return (
    <Box sx={{ background: C.canvas, minHeight: '100vh', fontFamily: SANS, color: C.slate }}>
      <Box sx={{ maxWidth: 1100, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, py: { xs: 2, sm: 2.5, md: 3.5 }, pb: 8 }}>
        <Box sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.gold }}>Administration</Box>
        <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
          <Box component="h1" sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 28, m: '6px 0 0' }}>User Management</Box>
          <Box sx={{ flex: 1 }} />
          <Button startIcon={<AddIcon />} onClick={() => setEditing({ mode: 'new' })} variant="contained"
            sx={{ textTransform: 'none', fontWeight: 800, bgcolor: C.navy, boxShadow: 'none', borderRadius: `${RADIUS.sm}px`,
              '&:hover': { bgcolor: C.navyDark, boxShadow: 'none' } }}>Add user</Button>
        </Box>
        <Box sx={{ fontSize: 13, color: C.muted, mb: 2.5 }}>
          Add, edit, or remove users. Grant <b>Run access</b> to let a user trigger the pipeline; without it their Run button is disabled.
          <b> Admins</b> can manage users and always have run access.
        </Box>

        <Box sx={{ bgcolor: C.white, border: `1px solid ${C.rule}`, borderRadius: `${RADIUS.md}px`, boxShadow: SHADOW.sm, overflow: 'hidden' }}>
          {err ? (
            <ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} />
          ) : loading ? (
            <Box sx={{ px: 2, py: 1 }}><PageSkeleton kpis={0} rows={5} /></Box>
          ) : rows.length === 0 ? (
            <EmptyState title="No users yet"
              hint={'Nobody has been given access yet. Use "Add user" above to create the first account.'} />
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" sx={{ '& td, & th': { py: 1, px: 2 } }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={th}>Username</TableCell>
                    <TableCell sx={th}>Role</TableCell>
                    <TableCell sx={th}>Run access</TableCell>
                    <TableCell sx={th}>Created</TableCell>
                    <TableCell sx={{ ...th, textAlign: 'right' }}>Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((u) => (
                    <TableRow key={u.id} hover>
                      <TableCell sx={{ fontFamily: MONO, fontWeight: 700, color: C.navy }}>
                        {u.username}{me && u.id === me.id && <Box component="span" sx={{ ml: 0.8, fontSize: 10.5, color: C.muted, fontFamily: SANS }}>(you)</Box>}
                      </TableCell>
                      <TableCell>{u.is_admin ? chip('ADMIN', '#EEEEEE', C.navy) : chip('USER', C.headBg, C.muted)}</TableCell>
                      <TableCell>{u.can_access_run || u.is_admin ? chip('YES', C.successLight, C.success) : chip('NO', C.redP, C.alertRed)}</TableCell>
                      <TableCell sx={{ color: C.muted, fontSize: 12.5, whiteSpace: 'nowrap' }}>{String(u.created_at).slice(0, 19)}</TableCell>
                      <TableCell sx={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Tooltip title="Edit"><IconButton size="small" onClick={() => setEditing({ mode: 'edit', row: u })}><EditIcon sx={{ fontSize: 18, color: C.navy }} /></IconButton></Tooltip>
                        <Tooltip title={me && u.id === me.id ? "You can't delete your own account" : 'Delete'}>
                          <span><IconButton size="small" disabled={!!me && u.id === me.id} onClick={() => setConfirmDel(u)}>
                            <DeleteOutlineIcon sx={{ fontSize: 18, color: (me && u.id === me.id) ? C.rule : C.alertRed }} /></IconButton></span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && <TableRow><TableCell colSpan={5} sx={{ textAlign: 'center', color: C.muted, py: 4 }}>No users.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </Box>
          )}
        </Box>
      </Box>

      {editing && <UserDialog editing={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {confirmDel && <DeleteDialog row={confirmDel} onClose={() => setConfirmDel(null)} onDone={() => { setConfirmDel(null); load(); }} />}
    </Box>
  );
}

// ── add / edit dialog ────────────────────────────────────────────────────────────────────────────────────────────
function UserDialog({ editing, onClose, onSaved }: { editing: Exclude<Editing, null>; onClose: () => void; onSaved: () => void }) {
  const isNew = editing.mode === 'new';
  const existing = editing.mode === 'edit' ? editing.row : null;
  const [username, setUsername] = useState(existing?.username ?? '');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(existing?.is_admin ?? false);
  const [canRun, setCanRun] = useState(existing ? existing.can_access_run : false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (isNew) {
        await api.createUser({ username: username.trim(), password, is_admin: isAdmin, can_access_run: canRun });
      } else {
        const body: Record<string, unknown> = { username: username.trim(), is_admin: isAdmin, can_access_run: canRun };
        if (password) body.password = password;                    // blank = keep current password
        await api.updateUser(existing!.id, body);
      }
      onSaved();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Save failed'); setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: `${RADIUS.md}px` } }}>
      <DialogTitle sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy }}>{isNew ? 'Add user' : `Edit ${existing?.username}`}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        {err && <Box sx={{ px: 1.5, py: 1, borderRadius: `${RADIUS.sm}px`, bgcolor: C.redP, color: C.alertRed, fontSize: 13, fontWeight: 600 }}>{err}</Box>}
        <TextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} size="small" autoFocus fullWidth />
        <TextField label={isNew ? 'Password' : 'New password (leave blank to keep)'} type="password" value={password}
          onChange={(e) => setPassword(e.target.value)} size="small" fullWidth autoComplete="new-password" />
        <FormControlLabel control={<Switch checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />}
          label={<Box sx={{ fontSize: 13.5 }}>Administrator <Box component="span" sx={{ color: C.muted, fontSize: 12 }}>· manage users, full access</Box></Box>} />
        <FormControlLabel control={<Switch checked={canRun || isAdmin} disabled={isAdmin} onChange={(e) => setCanRun(e.target.checked)} />}
          label={<Box sx={{ fontSize: 13.5 }}>Run access <Box component="span" sx={{ color: C.muted, fontSize: 12 }}>· can trigger the pipeline{isAdmin ? ' (admins always)' : ''}</Box></Box>} />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} sx={{ textTransform: 'none', color: C.muted }}>Cancel</Button>
        <Button onClick={save} disabled={busy || !username.trim() || (isNew && !password)} variant="contained"
          sx={{ textTransform: 'none', fontWeight: 800, bgcolor: C.navy, boxShadow: 'none', '&:hover': { bgcolor: C.navyDark, boxShadow: 'none' } }}>
          {busy ? <CircularProgress size={18} sx={{ color: '#fff' }} /> : (isNew ? 'Create' : 'Save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── delete confirm ───────────────────────────────────────────────────────────────────────────────────────────────
function DeleteDialog({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const del = async () => {
    setBusy(true); setErr('');
    try { await api.deleteUser(row.id); onDone(); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : 'Delete failed'); setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: `${RADIUS.md}px` } }}>
      <DialogTitle sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy }}>Delete user</DialogTitle>
      <DialogContent>
        {err && <Box sx={{ mb: 1.5, px: 1.5, py: 1, borderRadius: `${RADIUS.sm}px`, bgcolor: C.redP, color: C.alertRed, fontSize: 13, fontWeight: 600 }}>{err}</Box>}
        <Box sx={{ fontSize: 14 }}>Delete <b style={{ fontFamily: MONO, color: C.navy }}>{row.username}</b>? This cannot be undone.</Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} sx={{ textTransform: 'none', color: C.muted }}>Cancel</Button>
        <Button onClick={del} disabled={busy} variant="contained"
          sx={{ textTransform: 'none', fontWeight: 800, bgcolor: C.alertRed, boxShadow: 'none', '&:hover': { bgcolor: '#A32020', boxShadow: 'none' } }}>
          {busy ? <CircularProgress size={18} sx={{ color: '#fff' }} /> : 'Delete'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
