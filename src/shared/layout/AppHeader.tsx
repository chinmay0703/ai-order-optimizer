import { Box, IconButton, Tooltip } from '@mui/material';
import ProfileMenu from './ProfileMenu';
import VersionChip from './VersionChip';
import type { AuthUser } from '../auth';
import MenuIcon from '@mui/icons-material/Menu';
import MenuOpenIcon from '@mui/icons-material/MenuOpen';
import { SERIF } from '../../theme/pdartTokens';

/* App masthead — styled like the pwc.com header: a clean WHITE bar with the black PwC wordmark, the product name in
   ITC Charter (serif, regular weight) and a thin grey rule along the bottom edge. */

const NAVY = '#2D2D2D';       // masthead navy
const GOLD = '#FD5108';       // PwC signature orange (matches the logo bars) — the "AI" of the product name

export default function AppHeader({ sidebarOpen = true, onToggleSidebar, user }:
  { sidebarOpen?: boolean; onToggleSidebar?: () => void; user?: AuthUser | null }) {
  return (
    <div style={{
      position: 'relative', overflow: 'hidden', zIndex: 10,
      background: '#FFFFFF',
      borderBottom: '1px solid #DFE3E6', padding: '12px 24px',
      display: 'flex', alignItems: 'center', gap: 'clamp(8px, 2.5vw, 18px)', flexWrap: 'nowrap',
      boxShadow: '0 2px 10px -6px rgba(0,0,0,0.18)',
    }}>

      {/* hamburger — collapse / expand the left sidebar (frees width for wide pages & the detail drawer) */}
      <Tooltip title={sidebarOpen ? 'Hide menu' : 'Show menu'} arrow>
        <IconButton onClick={onToggleSidebar} aria-label="toggle menu"
          sx={{ position: 'relative', zIndex: 2, color: '#2D2D2D', border: '1px solid #DFE3E6', borderRadius: '9px',
            display: { xs: 'none', md: 'inline-flex' },   // no sidebar to toggle on mobile — MobileNav is the nav there
            bgcolor: '#FFFFFF', '&:hover': { bgcolor: '#FFF5ED', borderColor: GOLD, color: '#CC3D07' } }}>
          {sidebarOpen ? <MenuOpenIcon /> : <MenuIcon />}
        </IconButton>
      </Tooltip>

      {/* PwC logo — black wordmark on the white masthead (relative path: works under any base URL) */}
      <div style={{ position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <img src="brand/pwc-logo.svg" alt="PwC"
          style={{ height: 'clamp(30px, 7vw, 48px)', width: 'auto', display: 'block' }} />
      </div>
      {/* divider */}
      <Box sx={{ width: '1px', alignSelf: 'stretch', minHeight: 46, background: '#DFE3E6', position: 'relative', zIndex: 2,
        display: { xs: 'none', sm: 'block' } }} />
      {/* product title — the repo name, with "AI" in solid theme gold */}
      <div style={{ position: 'relative', zIndex: 2, fontFamily: SERIF, fontSize: 'clamp(17px, 4vw, 28px)', fontWeight: 400, color: '#000', letterSpacing: '-.5px', whiteSpace: 'nowrap' }}>
        <span style={{ color: GOLD }}>AI</span> Order Optimizer
      </div>

      {/* right cluster — the build-version chip + the signed-in user, ALWAYS top-right. ml:'auto' pushes the whole
          group to the right edge; the group is content-sized so ProfileMenu's own ml:'auto' is a harmless no-op here. */}
      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 'clamp(8px, 2vw, 14px)',
        position: 'relative', zIndex: 2 }}>
        <VersionChip />
        {user && <ProfileMenu user={user} />}
      </Box>

    </div>
  );
}
