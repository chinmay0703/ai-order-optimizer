import { Box } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import type { AuthUser } from '../auth';
import { HOME, MENU_SECTIONS, USERS, type Item, type Page } from './Sidebar';
import { MOBILE_NAV_H, hideScrollbar } from '../../theme/responsive';

/**
 * The mobile nav: a FIXED bottom bar that scrolls horizontally through every page the
 * sidebar shows on desktop. Below `md` the sidebar is not rendered at all, so this is the
 * only nav — it therefore carries the same items, in the same order, driven by the same
 * MENU_SECTIONS constant so the two can never drift apart.
 */
export default function MobileNav({ page, onNav, user }: {
  page: Page; onNav: (p: Page) => void; user?: AuthUser | null;
}) {
  const isAdmin = !!user?.is_admin;

  // same order as the sidebar: Home, then every section's items, then admin-only User Management
  const items: Item[] = [HOME, ...MENU_SECTIONS.flatMap((s) => s.items), ...(isAdmin ? [USERS] : [])];

  return (
    <Box component="nav" aria-label="Main navigation"
      sx={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1200,
        height: `${MOBILE_NAV_H}px`, display: { xs: 'flex', md: 'none' }, alignItems: 'stretch',
        background: 'linear-gradient(178deg, #2D2D2D 0%, #262626 55%, #222222 100%)',
        borderTop: '1px solid rgba(208,74,2,0.28)',
        boxShadow: '0 -6px 20px -8px rgba(0,0,0,0.65)',
        overflowX: 'auto', overflowY: 'hidden',
        // the bar sits above the iOS home indicator
        pb: 'env(safe-area-inset-bottom)',
        // scroll affordance: a soft fade on the right edge so it reads as "more to the side"
        WebkitMaskImage: 'linear-gradient(90deg, #000 0, #000 calc(100% - 28px), transparent 100%)',
        maskImage: 'linear-gradient(90deg, #000 0, #000 calc(100% - 28px), transparent 100%)',
        scrollSnapType: 'x proximity',
        ...hideScrollbar,
      }}>
      {items.map((it) => {
        const active = page === it.key;
        const locked = false;   // the Run page opens for everyone; its Run button is disabled without run access
        return (
          <Box key={it.key} role="button" tabIndex={locked ? -1 : 0}
            aria-current={active ? 'page' : undefined} aria-disabled={locked || undefined}
            onClick={() => { if (!locked) onNav(it.key); }}
            onKeyDown={(e) => { if (!locked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onNav(it.key); } }}
            sx={{
              flex: '0 0 auto', minWidth: 76, minHeight: 44, px: 1.25, py: 0.75, scrollSnapAlign: 'start',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 0.25,
              cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.42 : 1,
              color: active ? '#FFB600' : 'rgba(255,255,255,0.78)',
              borderTop: active ? '2px solid #D04A02' : '2px solid transparent',
              bgcolor: active ? 'rgba(208,74,2,0.14)' : 'transparent',
              '&:focus-visible': { outline: '2px solid #FFB600', outlineOffset: '-2px' },
              '& svg': { fontSize: 20 },
            }}>
            {locked ? <LockOutlinedIcon /> : it.icon}
            <Box sx={{ fontSize: 10.5, fontWeight: active ? 800 : 600, lineHeight: 1.15, textAlign: 'center',
              maxWidth: 84, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</Box>
          </Box>
        );
      })}
    </Box>
  );
}
