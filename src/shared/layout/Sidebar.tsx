import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../api';
import type { AuthUser } from '../auth';
import { Box, Collapse, List, ListItemButton, ListItemIcon, ListItemText, Tooltip } from '@mui/material';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import StorefrontIcon from '@mui/icons-material/Storefront';
import StorageIcon from '@mui/icons-material/Storage';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import CallMergeIcon from '@mui/icons-material/CallMerge';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import TuneIcon from '@mui/icons-material/Tune';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import SchemaIcon from '@mui/icons-material/Schema';
import ViewListIcon from '@mui/icons-material/ViewList';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import GridViewIcon from '@mui/icons-material/GridView';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumbered';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import SummarizeIcon from '@mui/icons-material/Summarize';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import AppsIcon from '@mui/icons-material/Apps';
import RuleIcon from '@mui/icons-material/Rule';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';

export type Page = 'home' | 'run' | 'flow' | 'pdp' | 'soq' | 'filteredsoq' | 'combined' | 'dbmaster' | 'cfainv' | 'cfastock' | 'dbstock' | 'subs' | 'fillers' | 'masters' | 'resruns' | 'cfaregzsku' | 'cfares' | 'resprefilter' | 'drilldown' | 'subseq' | 'fillerseq' | 'cfadb' | 'clusterprimary' | 'rca' | 'trucktrim' | 'cfawalk' | 'finalorder' | 'saporders' | 'orderstatus' | 'datatests' | 'schema' | 's3out' | 'finalorderreport' | 'uatreportv2' | 'orderjourney' | 'rlmapproval' | 'seccfashift' | 'oeparams' | 'users';

export interface Item { key: Page; label: string; sub: string; icon: ReactNode; }
const PREFILTERS: Item[] = [
  { key: 'dbmaster', label: 'DB Master', sub: '1 · DB universe', icon: <StorefrontIcon /> },
  { key: 'pdp', label: 'PDP', sub: '2 · delivery plan', icon: <CalendarMonthIcon /> },
  { key: 'cfainv', label: 'CFA Inventory', sub: '3 · expiry / ATP', icon: <Inventory2Icon /> },
  { key: 'cfastock', label: 'CFA Stock → reg-zsku', sub: '4 · CFA SKU → reg-zsku', icon: <Inventory2Icon /> },
  { key: 'dbstock', label: 'DB Stock → reg-zsku', sub: '5 · DB SKU → reg-zsku', icon: <StorageIcon /> },
  { key: 'soq', label: 'Filtered SOQ', sub: '6 · DBs to allocate', icon: <FilterAltIcon /> },
  { key: 'combined', label: 'Combined SOQ', sub: '7 · 65% truck + 120% applic.', icon: <CallMergeIcon /> },
  { key: 'subs', label: 'Substitution', sub: '8 · reg-zsku subs (120%)', icon: <CallMergeIcon /> },
  { key: 'fillers', label: 'Filler', sub: '9 · reg-zsku fillers (120%)', icon: <CallSplitIcon /> },
];
// which per-run pre-processing tab each pre-filter step maps to (in ReservationPrefilterPage)
const PRETAB: Partial<Record<Page, number>> = { dbmaster: 0, cfainv: 1, cfastock: 1, soq: 2, pdp: 3, dbstock: 4, combined: 5, subs: 6, fillers: 7 };
interface RunOpt { k: string; label: string; }
// the cascade's runs are fetched live (api.reservationRuns) so the dropdown never drifts from sub_channel_reservation.
// fallback = the 4-channel order, smallest-reservation first: Non-PACE (Run 1 = Priority 4) … Retail (Run 4).
// each channel combines all three MRP bands into a single truck per DB.
const FALLBACK_RUNS: RunOpt[] = [
  { k: '1', label: 'Run 1 · Non-PACE' }, { k: '2', label: 'Run 2 · Hub & Spoke' },
  { k: '3', label: 'Run 3 · AFH (Away From Home)' }, { k: '4', label: 'Run 4 · Retail' },
];

export const HOME: Item = { key: 'home', label: 'Home', sub: 'all pages · what each one does', icon: <AppsIcon /> };
const RUN: Item = { key: 'run', label: 'Run', sub: 'run the engine · by date', icon: <PlayCircleOutlineIcon /> };
const FLOW: Item = { key: 'flow', label: 'How it works', sub: 'process story', icon: <SchemaIcon /> };
const UATREPORTV2: Item = { key: 'uatreportv2', label: 'Allocation Report', sub: 'reg-zsku × DB × truck · download', icon: <FactCheckIcon /> };
const ORDERJOURNEY: Item = { key: 'orderjourney', label: 'Order Journey', sub: 'end-to-end · distributor → truck → reg-zsku → batch', icon: <AccountTreeIcon /> };
const FILTEREDSOQ: Item = { key: 'filteredsoq', label: 'Filtered SOQ', sub: 'demand gate · (PDP/below) & 65%', icon: <FilterAltIcon /> };
const PREPROC: Item = { key: 'resprefilter', label: 'Pre-processing', sub: 'reserve → run-by-run (workflow)', icon: <TuneIcon /> };
const MASTERS: Item = { key: 'masters', label: 'Data', sub: 'every table, sample data', icon: <StorageIcon /> };
const RESRUNS: Item = { key: 'resruns', label: 'Allocation Summary', sub: 'cascade · CFA × truck × DB', icon: <ViewListIcon /> };
const CFARES: Item = { key: 'cfares', label: 'CFA Stock Reservation', sub: 'step 1 · reserve · MRP validation', icon: <Inventory2Icon /> };
const DRILLDOWN: Item = { key: 'drilldown', label: 'Step-1 Fair Share', sub: 'per reg-zsku · Step 1 (v2) + 2', icon: <AccountTreeIcon /> };   // was 'Water-Fill' (retired Step-1 logic)
const SUBSEQ: Item = { key: 'subseq', label: 'Substitution Sequence', sub: 'step 2 · New-score order', icon: <FormatListNumberedIcon /> };
const FILLERSEQ: Item = { key: 'fillerseq', label: 'Filler Sequence', sub: 'step 3 · draw order · truck fill', icon: <CallSplitIcon /> };
const CFADB: Item = { key: 'cfadb', label: 'CFA × DB', sub: 'combined · per DB · per truck', icon: <GridViewIcon /> };
const CLUSTER: Item = { key: 'clusterprimary', label: 'Cluster Truck Fill', sub: 'transshipment · combine → full trucks → trim', icon: <LocalShippingIcon /> };
const RCA: Item = { key: 'rca', label: 'Allocation Trace', sub: 'search DB / reg-zsku / CFA · end-to-end story', icon: <ManageSearchIcon /> };
const TRUCKTRIM: Item = { key: 'trucktrim', label: 'Truck Trims', sub: 'trimmed / dropped by truck rule', icon: <ContentCutIcon /> };
const SAPORDERS: Item = { key: 'saporders', label: 'SAP Orders', sub: 'the orders table · SO_CREATION hand-off · download', icon: <Inventory2Icon /> };
const ORDERSTATUS: Item = { key: 'orderstatus', label: 'Order Status', sub: 'SAP status write-back · de_sap.order_status · per date', icon: <FactCheckIcon /> };
const DATATESTS: Item = { key: 'datatests', label: 'Data QA', sub: '~100 live checks · masters & feeds · per date', icon: <FactCheckIcon /> };
const CFAWALK: Item = { key: 'cfawalk', label: 'CFA Walkthrough', sub: 'one CFA · per run', icon: <FactCheckIcon /> };
// APPROVALS — open the Allocation Summary page directly at its RLM tab (rlmptl / seccfa)
const RLMAPPROVAL: Item = { key: 'rlmapproval', label: 'RLM Truck Approval', sub: 'held below fill target · planner sign-off', icon: <RuleIcon /> };
const SECCFASHIFT: Item = { key: 'seccfashift', label: '2nd-CFA Shift', sub: 'reroute to an alternate CFA · RLM', icon: <SwapHorizIcon /> };
const OEPARAMS: Item = { key: 'oeparams', label: 'OE Parameters', sub: 'engine thresholds · edit · reset', icon: <TuneIcon /> };
export const USERS: Item = { key: 'users', label: 'User Management', sub: 'add · edit · delete users · run access', icon: <ManageAccountsIcon /> };

// Grouped page directory for the Home / menu landing (features/overview/HomePage maps over this). It reuses the SAME
// Item objects the sidebar renders below, so a page's label + one-line description never drift between the two. Only
// pages that App.tsx actually renders are listed, and in the same top→bottom pipeline order as the sidebar.
export interface MenuSection { title: string; blurb: string; items: Item[]; }
export const MENU_SECTIONS: MenuSection[] = [
  { title: 'Run', blurb: 'start a run · understand the flow · tune the engine', items: [RUN, FLOW, OEPARAMS] },
  { title: 'Data & demand', blurb: 'delivered masters · demand gate · reservation', items: [MASTERS, FILTEREDSOQ, PREPROC, CFARES] },
  { title: 'Engine · Steps 1–3 & truck rule', blurb: 'water-fill → substitute → filler → truck fill → trims', items: [DRILLDOWN, SUBSEQ, FILLERSEQ, CLUSTER, TRUCKTRIM] },
  { title: 'Allocation roll-ups', blurb: 'per channel run · per DB', items: [RESRUNS, CFADB] },
  { title: 'Approvals', blurb: 'RLM holds · truck sign-off · 2nd-CFA shift', items: [RLMAPPROVAL, SECCFASHIFT] },
  { title: 'Output & hand-off', blurb: 'the order → SAP', items: [SAPORDERS, ORDERSTATUS] },
  { title: 'Reports', blurb: 'allocation report · QA checks · end-to-end trace', items: [UATREPORTV2, DATATESTS, RCA, ORDERJOURNEY] },
];

// NON-clickable showcase items (planned phases) — rendered on the sidebar AND the Home page (below Reports), never
// routed. Kept as a separate list from MENU_SECTIONS since these have no Page/route behind them.
export interface ShowItem { label: string; sub: string; icon: ReactNode; href?: string; }
export interface ShowSection { title: string; blurb: string; items: ShowItem[]; }
export const SHOWCASE_SECTIONS: ShowSection[] = [];   // no planned-phase placeholders in this build

interface SidebarProps {
  page: Page; onNav: (p: Page) => void;
  preRun: string; setPreRun: (s: string) => void; setPreTab: (n: number) => void;
  open?: boolean;   // collapsed (width 0) when false — toggled by the header hamburger
  user?: AuthUser | null;   // the logged-in user — gates the Run button + the admin-only User Management item
  isMobile?: boolean;       // below md the sidebar is not rendered — MobileNav (bottom bar) is the nav instead
}

export default function Sidebar({ page, onNav, preRun, setPreRun, setPreTab, open = true, user, isMobile = false }: SidebarProps) {
  const isAdmin = !!user?.is_admin;                            // only admins see User Management
  const [preOpen, setPreOpen] = useState(true);
  const [runOpts, setRunOpts] = useState<RunOpt[]>(FALLBACK_RUNS);
  useEffect(() => {
    api.reservationRuns().then((res) => {
      const runs = (res as { runs?: Array<{ meta?: { run: number; channel: string; band: number; pct?: number } }> }).runs ?? [];
      const opts: RunOpt[] = [];
      for (const r of runs) {
        const m = r.meta;
        if (m) opts.push({ k: String(m.run), label: `Run ${m.run} · ${m.channel}${m.pct != null ? ` · ${Math.round(m.pct)}%` : ''}` });
      }
      opts.sort((a, b) => Number(a.k) - Number(b.k));
      if (opts.length) setRunOpts(opts);
    }).catch(() => {});
  }, []);
  const preActive = PREFILTERS.some((i) => i.key === page) || page === 'resprefilter';
  const perRun = preRun !== 'overall';

  const navBtn = (n: Item, indent = false, onClick?: () => void, selOverride?: boolean, disabled = false) => {
    const sel = selOverride ?? page === n.key;
    return (
      <Tooltip key={n.key} title={disabled ? 'You do not have access — ask an admin to grant Run access' : ''} placement="right" arrow disableHoverListener={!disabled}>
        <span>
        <ListItemButton selected={sel} disabled={disabled} onClick={disabled ? undefined : (onClick ?? (() => onNav(n.key)))}
          sx={{ mx: 1, my: 0.3, pl: indent ? 3 : 2, borderRadius: '9px', borderLeft: '3px solid transparent',
            color: sel ? '#FFFFFF' : 'rgba(255,255,255,0.88)', transition: 'background-color .12s, color .12s',
            '&.Mui-selected': { bgcolor: 'rgba(253,81,8,0.30)', borderLeftColor: '#FFB600' },
            '&.Mui-selected:hover': { bgcolor: 'rgba(253,81,8,0.38)' },
            '&:hover': { bgcolor: 'rgba(255,255,255,0.07)', color: '#FFFFFF' },
            '&:hover .MuiListItemIcon-root': { color: '#FFB600' },
            '&.Mui-disabled': { opacity: 0.42 } }}>
          <ListItemIcon sx={{ minWidth: 32, color: sel ? '#FFB600' : 'rgba(255,255,255,0.72)' }}>{disabled ? <LockOutlinedIcon fontSize="small" /> : n.icon}</ListItemIcon>
          <ListItemText primary={n.label} secondary={disabled ? 'run access required' : n.sub}
            primaryTypographyProps={{ fontWeight: sel ? 700 : 600, fontSize: indent ? '0.85rem' : '0.9rem' }}
            secondaryTypographyProps={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.72)' }} />
        </ListItemButton>
        </span>
      </Tooltip>
    );
  };

  // a pre-filter step: in per-run mode it opens the per-run page at the matching tab; else the shared page
  const preStep = (i: Item) => navBtn(i, true, () => {
    if (perRun && PRETAB[i.key] !== undefined) { setPreTab(PRETAB[i.key]!); onNav('resprefilter'); }
    else onNav(i.key);
  }, !perRun && page === i.key);

  // a visible section divider label (gold uppercase) for the new grouped sections
  const sectionHead = (label: string) => (
    <Box key={`sec-${label}`} sx={{ px: 2.5, pt: 2, pb: 0.5, display: 'flex', alignItems: 'center', gap: 1 }}>
      <Box component="span" sx={{ fontSize: '0.62rem', fontWeight: 800, letterSpacing: '.11em', textTransform: 'uppercase', color: '#FFB600', whiteSpace: 'nowrap' }}>{label}</Box>
      <Box sx={{ flex: 1, height: '1px', background: 'linear-gradient(90deg, #EB8C00, rgba(253,81,8,0.0))' }} />
    </Box>
  );
  // a showcase item: with an `href` it opens that app in a NEW TAB (tagged OPEN ↗); without one it's the greyed,
  // non-clickable "SOON" placeholder (planned / not yet live).
  const soonBtn = (it: ShowItem) => {
    const linked = !!it.href;
    return (
      <ListItemButton key={it.label} disabled={!linked}
        onClick={linked ? () => window.open(it.href, '_blank', 'noopener,noreferrer') : undefined}
        sx={{ mx: 1, my: 0.25, pl: 2, borderRadius: '9px',
          ...(linked
            ? { '&:hover': { bgcolor: 'rgba(255,255,255,0.07)' }, '&:hover .MuiListItemIcon-root': { color: '#FFAA72' } }
            : { '&.Mui-disabled': { opacity: 0.75 } }) }}>
        <ListItemIcon sx={{ minWidth: 32, color: linked ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.55)' }}>{it.icon}</ListItemIcon>
        <ListItemText primary={it.label} secondary={it.sub}
          primaryTypographyProps={{ fontWeight: 600, fontSize: '0.9rem', color: linked ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.75)' }}
          secondaryTypographyProps={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.72)' }} />
        <Box component="span" sx={{ fontSize: '0.52rem', fontWeight: 800, letterSpacing: '.08em', color: '#FFAA72', bgcolor: 'rgba(255,170,114,0.10)', border: '1px solid rgba(255,170,114,0.45)', borderRadius: '4px', px: 0.6, py: 0.15 }}>{linked ? 'OPEN ↗' : 'SOON'}</Box>
      </ListItemButton>
    );
  };

  if (isMobile) return null;   // below md the fixed bottom MobileNav is the only nav
  return (
    <Box sx={{ width: open ? 236 : 0, flexShrink: 0, color: '#FFFFFF', display: 'flex', flexDirection: 'column',
      background: 'linear-gradient(165deg, #1A1A1A 0%, #2D2D2D 55%, #404246 100%)',   // PwC charcoal — same as the How it works header
      borderRight: '1px solid rgba(0,0,0,0.35)',
      height: '100%', minHeight: 0, overflow: 'hidden', transition: 'width .22s ease' }}>
      {/* scrolling nav area (fixed width so labels wrap normally + no reflow while the sidebar collapses) */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: open ? 'auto' : 'hidden', overflowX: 'hidden',
        '&::-webkit-scrollbar': { width: 8 }, '&::-webkit-scrollbar-thumb': { bgcolor: 'rgba(255,255,255,0.2)', borderRadius: 8 },
        '&::-webkit-scrollbar-track': { bgcolor: 'transparent' } }}>
        <List sx={{ py: 1, width: 236, boxSizing: 'border-box' }}>
          {/* Home pinned at top, then EVERY section with its header — driven by MENU_SECTIONS so it matches the Home page.
              Every user can open the Run page; without run access its Run BUTTON is disabled (not the nav item). */}
          {navBtn(HOME)}
          {MENU_SECTIONS.flatMap((s) => [sectionHead(s.title), ...s.items.map((it) => navBtn(it))])}
          {/* Administration — admins only: user management */}
          {isAdmin && [sectionHead('Administration'), navBtn(USERS)]}
          {/* planned phases · showcase only (non-clickable) — same list the Home page renders below Reports */}
          {SHOWCASE_SECTIONS.flatMap((s) => [sectionHead(s.title), ...s.items.map((it) => soonBtn(it))])}
        </List>
      </Box>
    </Box>
  );
}
