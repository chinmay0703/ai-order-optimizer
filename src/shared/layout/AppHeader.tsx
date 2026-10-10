import { Box, IconButton, Tooltip } from '@mui/material';
import ProfileMenu from './ProfileMenu';
import VersionChip from './VersionChip';
import type { AuthUser } from '../auth';
import MenuIcon from '@mui/icons-material/Menu';
import MenuOpenIcon from '@mui/icons-material/MenuOpen';
import { SANS } from '../../theme/pdartTokens';

/* App masthead — an ELEVATED bar that sits clearly ABOVE the (also-navy) sidebar and page: its own deep-navy
   gradient + drop shadow lift it off the L-shape, and a slow "aurora" glow + faint tech grid give it a premium,
   modern feel. NO functional/marketing "AI" claim text (the engine is a deterministic optimiser, not AI) — the look
   is ambient only. The "AI" of the product name stays the SOLID PwC orange (#FD5108). Motion respects prefers-reduced-motion. */

const NAVY = '#2D2D2D';       // masthead navy
const GOLD = '#FD5108';       // PwC signature orange (matches the logo bars) — accent rule + the "AI" of the product name

export default function AppHeader({ sidebarOpen = true, onToggleSidebar, user }:
  { sidebarOpen?: boolean; onToggleSidebar?: () => void; user?: AuthUser | null }) {
  return (
    <div style={{
      position: 'relative', overflow: 'hidden', zIndex: 10,
      background: `linear-gradient(112deg, #1A1A1A 0%, ${NAVY} 46%, #3A3A3A 100%)`,
      borderBottom: `3px solid ${GOLD}`, padding: '13px 24px',
      display: 'flex', alignItems: 'center', gap: 'clamp(8px, 2.5vw, 18px)', flexWrap: 'nowrap',
      boxShadow: '0 10px 26px -8px rgba(0,0,0,0.60)',   // depth = separation from the sidebar/page
    }}>
      {/* animated AI aurora + faint tech grid, behind the content */}
      <div className="aiden-aurora" aria-hidden="true" />
      <div className="aiden-grid" aria-hidden="true" />

      {/* hamburger — collapse / expand the left sidebar (frees width for wide pages & the detail drawer) */}
      <Tooltip title={sidebarOpen ? 'Hide menu' : 'Show menu'} arrow>
        <IconButton onClick={onToggleSidebar} aria-label="toggle menu"
          sx={{ position: 'relative', zIndex: 2, color: '#fff', border: '1px solid rgba(255,255,255,0.20)', borderRadius: '9px',
            display: { xs: 'none', md: 'inline-flex' },   // no sidebar to toggle on mobile — MobileNav is the nav there
            bgcolor: 'rgba(255,255,255,0.06)', '&:hover': { bgcolor: 'rgba(208,74,2,0.22)', borderColor: GOLD, color: GOLD } }}>
          {sidebarOpen ? <MenuOpenIcon /> : <MenuIcon />}
        </IconButton>
      </Tooltip>

      {/* PwC logo — white wordmark variant so it reads on the navy masthead (relative path: works under any base URL) */}
      <div style={{ position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <img src="brand/pwc-logo-white.svg" alt="PwC"
          style={{ height: 'clamp(30px, 7vw, 48px)', width: 'auto', display: 'block' }} />
      </div>
      {/* divider */}
      <Box sx={{ width: '1px', alignSelf: 'stretch', minHeight: 46, background: 'rgba(255,255,255,0.24)', position: 'relative', zIndex: 2,
        display: { xs: 'none', sm: 'block' } }} />
      {/* product title — the repo name, with "AI" in solid theme gold */}
      <div style={{ position: 'relative', zIndex: 2, fontFamily: SANS, fontSize: 'clamp(15px, 4vw, 27px)', fontWeight: 800, color: '#fff', letterSpacing: '-.005em', whiteSpace: 'nowrap' }}>
        <span style={{ color: GOLD }}>AI</span> Order Optimizer
      </div>

      {/* right cluster — the build-version chip + the signed-in user, ALWAYS top-right. ml:'auto' pushes the whole
          group to the right edge; the group is content-sized so ProfileMenu's own ml:'auto' is a harmless no-op here. */}
      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 'clamp(8px, 2vw, 14px)',
        position: 'relative', zIndex: 2 }}>
        <VersionChip />
        {user && <ProfileMenu user={user} />}
      </Box>

      <style>{`
        .aiden-aurora{position:absolute;inset:-45% -12%;z-index:1;pointer-events:none;opacity:.55;filter:blur(8px);
          background:
            radial-gradient(38% 130% at 16% 42%, rgba(208,74,2,.22), transparent 60%),
            radial-gradient(34% 140% at 58% 72%, rgba(33,163,102,.16), transparent 62%),
            radial-gradient(30% 130% at 90% 28%, rgba(235,140,0,.22), transparent 60%);
          animation:aidenFloat 17s ease-in-out infinite alternate;}
        @keyframes aidenFloat{0%{transform:translate3d(-3%,0,0)}100%{transform:translate3d(3%,-9px,0)}}
        .aiden-grid{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.055;
          background-image:linear-gradient(rgba(255,255,255,.7) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.7) 1px,transparent 1px);
          background-size:26px 26px;
          -webkit-mask-image:linear-gradient(90deg,transparent,#000 28%,#000 72%,transparent);
                  mask-image:linear-gradient(90deg,transparent,#000 28%,#000 72%,transparent);}
        @media (prefers-reduced-motion: reduce){.aiden-aurora{animation:none}}
      `}</style>
    </div>
  );
}
