import { Box, IconButton, Tooltip } from '@mui/material';
import ProfileMenu from './ProfileMenu';
import VersionChip from './VersionChip';
import type { AuthUser } from '../auth';
import MenuIcon from '@mui/icons-material/Menu';
import MenuOpenIcon from '@mui/icons-material/MenuOpen';
import { SANS } from '../../theme/pdartTokens';

/* PepsiCo masthead — an ELEVATED bar that sits clearly ABOVE the (also-navy) sidebar and page: its own deep-navy
   gradient + drop shadow lift it off the L-shape, and a slow "aurora" glow + faint tech grid give it a premium,
   modern feel. NO functional/marketing "AI" claim text (the engine is a deterministic optimiser, not AI) — the look
   is ambient only. The AIDEN acronym letters stay the SOLID theme gold (#D98A00). Motion respects prefers-reduced-motion. */

const NAVY = '#10365A';       // masthead navy — sampled from the logo crop's background
const GOLD = '#D98A00';       // brand accent rule + the AIDEN acronym letters, on-theme

export default function PepsicoHeader({ sidebarOpen = true, onToggleSidebar, user }:
  { sidebarOpen?: boolean; onToggleSidebar?: () => void; user?: AuthUser | null }) {
  return (
    <div style={{
      position: 'relative', overflow: 'hidden', zIndex: 10,
      background: `linear-gradient(112deg, #0A2038 0%, ${NAVY} 46%, #164274 100%)`,
      borderBottom: `3px solid ${GOLD}`, padding: '13px 24px',
      display: 'flex', alignItems: 'center', gap: 'clamp(8px, 2.5vw, 18px)', flexWrap: 'nowrap',
      boxShadow: '0 10px 26px -8px rgba(6,20,38,0.60)',   // depth = separation from the sidebar/page
    }}>
      {/* animated AI aurora + faint tech grid, behind the content */}
      <div className="aiden-aurora" aria-hidden="true" />
      <div className="aiden-grid" aria-hidden="true" />

      {/* hamburger — collapse / expand the left sidebar (frees width for wide pages & the detail drawer) */}
      <Tooltip title={sidebarOpen ? 'Hide menu' : 'Show menu'} arrow>
        <IconButton onClick={onToggleSidebar} aria-label="toggle menu"
          sx={{ position: 'relative', zIndex: 2, color: '#fff', border: '1px solid rgba(255,255,255,0.20)', borderRadius: '9px',
            display: { xs: 'none', md: 'inline-flex' },   // no sidebar to toggle on mobile — MobileNav is the nav there
            bgcolor: 'rgba(255,255,255,0.06)', '&:hover': { bgcolor: 'rgba(217,138,0,0.22)', borderColor: GOLD, color: GOLD } }}>
          {sidebarOpen ? <MenuOpenIcon /> : <MenuIcon />}
        </IconButton>
      </Tooltip>

      {/* official PepsiCo logo — the PNG has a baked-in flat-navy background, so it's framed in a matching-navy rounded
          tile (same #10365A) so it stays SEAMLESS on the gradient header instead of showing a mismatched box */}
      <div style={{ position: 'relative', zIndex: 2, background: NAVY, borderRadius: 10, border: '1px solid rgba(255,255,255,0.14)',
        padding: 'clamp(3px, 1vw, 6px) clamp(7px, 2vw, 14px)', display: 'flex', alignItems: 'center', flexShrink: 0, boxShadow: '0 2px 12px -5px rgba(0,0,0,0.55)' }}>
        <img src="/pepsico-logo.png" alt="PepsiCo — Food. Drinks. Smiles."
          style={{ height: 'clamp(30px, 7vw, 50px)', width: 'auto', display: 'block' }} />
      </div>
      {/* divider */}
      <Box sx={{ width: '1px', alignSelf: 'stretch', minHeight: 46, background: 'rgba(255,255,255,0.24)', position: 'relative', zIndex: 2,
        display: { xs: 'none', sm: 'block' } }} />
      {/* product title — AIDEN spelled out in solid theme gold (AI-assisted Distribution ENgine) */}
      <div style={{ position: 'relative', zIndex: 2, fontFamily: SANS, fontSize: 'clamp(15px, 4vw, 27px)', fontWeight: 800, color: '#fff', letterSpacing: '-.005em', whiteSpace: 'nowrap' }}>
        <span style={{ color: GOLD, letterSpacing: '.03em' }}>AIDEN</span>
        {/* the spelled-out tagline needs room — it is dropped on phones so the title can't clip mid-word */}
        <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}> — the{' '}
          <span style={{ color: GOLD }}>AI</span>-assisted <span style={{ color: GOLD }}>D</span>istribution <span style={{ color: GOLD }}>EN</span>gine
        </Box>
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
            radial-gradient(38% 130% at 16% 42%, rgba(217,138,0,.22), transparent 60%),
            radial-gradient(34% 140% at 58% 72%, rgba(33,163,102,.16), transparent 62%),
            radial-gradient(30% 130% at 90% 28%, rgba(83,146,224,.22), transparent 60%);
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
