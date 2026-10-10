import { useEffect, useState, lazy, Suspense } from 'react';
import { Box, LinearProgress } from '@mui/material';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import StorageIcon from '@mui/icons-material/Storage';
import { api } from './api';
import RunContextSelect from './shared/RunContextSelect';
import { OeParamsProvider } from './shared/OeParams';
import { RegZskuDescProvider } from './shared/RegZskuDesc';
import { BrandCategoryProvider } from './shared/BrandCategory';
import { DistributorNameProvider } from './shared/DistributorName';
import { RUN_DONE_EVENT } from './shared/servedLookup';
import Sidebar, { type Page } from './shared/layout/Sidebar';
import { MOBILE_NAV_H, useIsMobile } from './theme/responsive';
import MobileNav from './shared/layout/MobileNav';
import AppHeader from './shared/layout/AppHeader';
import KeepAlive from './shared/KeepAlive';
import PageFallback from './shared/PageFallback';
import HomePage from './features/overview/HomePage';   // landing view — eager (tiny, no heavy deps) so first paint has no spinner
import LoginPage from './features/auth/LoginPage';      // auth gate — eager (shown before the app boots)

// Every OTHER page is CODE-SPLIT via React.lazy: its JS chunk downloads only the first time you open it (when
// KeepAlive mounts it). So the initial load ships the shell + Home, NOT all ~30 pages in one 2 MB bundle — which
// is what made first load take a second or two. The heavy libs ride along in their own pages' chunks and stay out
// of the initial download: mermaid (~1 MB) only in the Story/flow chunk, xlsx (~430 KB) loads on Export-click.
const RunPage = lazy(() => import('./features/run/RunPage'));
const StoryPage = lazy(() => import('./features/overview/StoryPage'));
const MastersPage = lazy(() => import('./features/masters/MastersPage'));
const ReservationRunsPage = lazy(() => import('./features/reservations/ReservationRunsPage'));
const ReservationPrefilterPage = lazy(() => import('./features/pre_processing/ReservationPrefilterPage'));
const FilteredSoqPage = lazy(() => import('./features/pre_processing/FilteredSoqPage'));
const CfaStockReservationPage = lazy(() => import('./features/pre_processing/CfaStockReservationPage'));
const DrilldownPage = lazy(() => import('./features/or_engine/DrilldownPage'));
const SubstitutionSequencePage = lazy(() => import('./features/or_engine/SubstitutionSequencePage'));
const FillerSequencePage = lazy(() => import('./features/or_engine/FillerSequencePage'));
const CfaDbPage = lazy(() => import('./features/or_engine/CfaDbPage'));
const UatReportV2Page = lazy(() => import('./features/validate/UatReportV2Page'));
const OrderJourneyPage = lazy(() => import('./features/validate/OrderJourneyPage'));
const ClusterPrimaryPage = lazy(() => import('./features/or_engine/ClusterPrimaryPage'));
const SapOrdersPage = lazy(() => import('./features/or_engine/SapOrdersPage'));
const OrderStatusPage = lazy(() => import('./features/or_engine/OrderStatusPage'));
const SchemaPage = lazy(() => import('./features/or_engine/SchemaPage'));
const DataTestsPage = lazy(() => import('./features/qa/DataTestsPage'));
const RcaPage = lazy(() => import('./features/or_engine/RcaPage'));
const TruckTrimsPage = lazy(() => import('./features/disaggregation/TruckTrimsPage'));
const CfaWalkthroughPage = lazy(() => import('./features/reservations/CfaWalkthroughPage'));
const OeParametersPage = lazy(() => import('./features/config/OeParametersPage'));
const UserManagementPage = lazy(() => import('./features/admin/UserManagementPage'));
import { useAuth, getToken, refreshUser, clearSession, type AuthUser } from './shared/auth';

// AUTH GATE: no valid session → the login screen; otherwise the full app. On mount (with a token) we re-confirm the
// user via /auth/me so access/role changes an admin made take effect on the next load, and an expired token → login.
export default function App() {
  const { user } = useAuth();
  useEffect(() => {
    if (getToken()) api.me().then((u) => refreshUser(u as AuthUser)).catch(() => { /* 401 → api clears the session */ });
  }, []);
  if (!user) return <LoginPage />;
  return <AuthedApp user={user} />;
}

// Every view reads live from the FastAPI backend (Postgres). No static JSON anywhere.
function AuthedApp({ user }: { user: AuthUser }) {
  // remember the open page across refresh — restore it on load (default Home), persist on every nav
  const [page, setPage] = useState<Page>(() => {
    // a fresh SIGN-IN always lands on Home; a refresh restores wherever the user was
    if (sessionStorage.getItem('aoo.justLoggedIn')) {
      sessionStorage.removeItem('aoo.justLoggedIn');
      return 'home';
    }
    const saved = localStorage.getItem('aoo.page');
    if (saved === 'uatreport') return 'uatreportv2';   // the original UAT Report page was retired → its successor
    if (saved && ['finalorder', 'cfaregzsku', 'finalorderreport', 's3out'].includes(saved)) return 'home';   // removed pages
    return (saved as Page) || 'home';
  });
  useEffect(() => { localStorage.setItem('aoo.page', page); }, [page]);
  // left sidebar collapse — remembered across refresh; the hamburger in the header toggles it (frees width for wide pages / drawers)
  const isMobile = useIsMobile();
  // Desktop remembers the collapse preference; mobile always starts with the Drawer shut so the page owns the screen.
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => localStorage.getItem('aoo.sidebar') !== 'closed');
  useEffect(() => { if (isMobile) setSidebarOpen(false); }, [isMobile]);
  useEffect(() => { localStorage.setItem('aoo.sidebar', sidebarOpen ? 'open' : 'closed'); }, [sidebarOpen]);
  // page-access guards — every user may OPEN the Run page (audit + live progress); only users with run access get an
  // enabled Run button (the backend enforces it too). Only ADMINS can open User Management.
  const canRun = user.can_access_run || user.is_admin;
  useEffect(() => {
    if (page === 'users' && !user.is_admin) setPage('home');
  }, [page, user.is_admin]);
  const [preRun, setPreRun] = useState('1');
  const [preTab, setPreTab] = useState(0);
  const [date, setDate] = useState('');            // the run date every view page reads (blank -> backend latest)
  const [dates, setDates] = useState<string[]>([]);
  const [dataDate, setDataDate] = useState<Record<string, string>>({});   // run date -> SOQ-snapshot date it processed
  const [cfa, setCfa] = useState('');              // the ONE global CFA scope (header dropdown) — CFA-scoped pages read this
  const [cfaOpts, setCfaOpts] = useState<string[]>([]);
  const [paramNonce, setParamNonce] = useState(0); // bump after a run → OeParamsProvider re-fetches so labels reflect param edits
  const [booting, setBooting] = useState(true);    // INITIAL app boot: the first api.dates() is in-flight. Drives the top
                                                   // progress bar + "Loading…" date pill so first load never looks hung.

  const loadDates = () => api.dates()
    .then((j) => { const d = j as { dates?: string[]; latest?: string; data_date?: Record<string, string> };
      setDates(d.dates ?? []); setDataDate(d.data_date ?? {}); return d; })
    .catch(() => ({} as { dates?: string[]; latest?: string }));

  useEffect(() => {
    loadDates()
      .then((d) => setDate((cur) => cur || d.latest || (d.dates?.[d.dates.length - 1] ?? '')))
      .finally(() => setBooting(false));   // boot done (success OR failure) → drop the top bar / "Loading…" pill
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // keep the run-date list + SOQ chips fresh: a run started elsewhere (API / cron / another tab) changes them, and the
  // list loaded at boot would otherwise stay stale — re-load when the tab regains focus / becomes visible again.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') loadDates(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // the CFA list for the GLOBAL header dropdown — refreshes with the run date; default to the first CFA
  useEffect(() => {
    if (!date) return;
    api.cfaList(date).then((r) => {
      const cs = (r as { cfas?: string[] }).cfas ?? [];
      setCfaOpts(cs); setCfa((cur) => (cs.includes(cur) ? cur : (cs[0] ?? '')));
    }).catch(() => {});
  }, [date]);

  return (
    <OeParamsProvider nonce={paramNonce}>
    <RegZskuDescProvider>
    <BrandCategoryProvider>
    <DistributorNameProvider>
    <Box sx={{ display: 'flex', flexDirection: 'column', bgcolor: 'background.default',
      // Desktop: a fixed-height shell with its own inner scroller. Mobile: let the document scroll
      // (a nested scroller under `zoom` cannot be scrolled on phones).
      height: { xs: 'auto', md: '100%' }, minHeight: { xs: '100dvh', md: 0 },
      overflow: { xs: 'visible', md: 'hidden' } }}>
      <AppHeader sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((o) => !o)} user={user} />
      {/* BOOT bar: while the first api.dates() is loading (server can be slow to wake), a thin animated bar tells the
          user the app is starting — so first load never reads as a hang. Drops the moment the run dates resolve. */}
      {booting && (
        <LinearProgress sx={{ height: 3, bgcolor: 'transparent', '& .MuiLinearProgress-bar': { bgcolor: '#FD5108' } }} />
      )}
      <Box sx={{ display: 'flex', flex: 1, minWidth: 0, minHeight: { xs: 'auto', md: 0 } }}>
      <Sidebar open={sidebarOpen} page={page} onNav={setPage}
        preRun={preRun} setPreRun={setPreRun} setPreTab={setPreTab} user={user}
        isMobile={isMobile} />
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: { xs: 'visible', md: 'auto' },
        // clears the fixed MobileNav so the last row of ANY page is never hidden behind it
        pb: { xs: `${MOBILE_NAV_H + 28}px`, md: 0 } }}>
        {page !== 'home' && (
        <Box sx={{ position: 'sticky', top: 0, zIndex: 20, background: '#FFF5ED', color: '#2D2D2D',
          px: { xs: 1, sm: 2.5 }, py: { xs: 0.5, sm: 0.9 }, display: 'flex', gap: { xs: 0.6, sm: 1.25 }, alignItems: 'center', flexWrap: 'wrap',
          borderBottom: '1px solid #FFCDA8', boxShadow: '0 2px 8px -6px rgba(0,0,0,0.25)' }}>
          <Box component="span" sx={{ fontWeight: 800, fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase',
            color: '#C52B09', display: { xs: 'none', sm: 'inline' } }}>▶&nbsp;Run&nbsp;context</Box>

          {/* RUN DATE — themed dropdown (not a native <select>, whose popup is off-theme) */}
          <RunContextSelect label="Run date" title="The run date every page below reads" value={date} options={dates}
            onChange={setDate} accent="#C52B09" align="left" minMenuWidth={150} emptyText={booting ? 'Loading…' : '—'}
            icon={<CalendarTodayIcon sx={{ fontSize: 16, color: '#C52B09' }} />} />

          {dataDate[date] && <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontWeight: 700,
            fontSize: { xs: 10.5, sm: 12 }, bgcolor: '#FFFFFF', border: '1px solid #FFCDA8', px: { xs: 0.7, sm: 1 }, py: { xs: 0.35, sm: 0.6 },
            borderRadius: '8px', whiteSpace: 'nowrap' }} title="the SOQ snapshot (data date) this run processed">SOQ&nbsp;<b style={{ fontFamily: 'Consolas, monospace' }}>{dataDate[date]}</b></Box>}
          <Box component="span" sx={{ fontSize: 12, color: '#4C5056', display: { xs: 'none', md: 'inline' } }}>· every page below reads this date</Box>

          <Box sx={{ flex: { xs: '0 0 0px', sm: 1 } }} />

          {/* GLOBAL CFA scope — the CFA-scoped pages read THIS, not a per-page dropdown */}
          {cfaOpts.length > 0 && (
            <RunContextSelect label="CFA scope" title="Scope every CFA-scoped page to one CFA" value={cfa} options={cfaOpts}
              onChange={setCfa} accent="#2D2D2D" align="right" minMenuWidth={140} format={(v) => `CFA ${v}`}
              icon={<StorageIcon sx={{ fontSize: 16, color: '#2D2D2D' }} />} />
          )}
        </Box>
        )}
        {/* Home + Run stay OUTSIDE the refresh key. Home has no date; Run must NOT remount on the date its own onRan
            just set (that would wipe the just-finished run's results). Both are wrapped in KeepAlive like everything else. */}
        <KeepAlive active={page === 'home'}><HomePage onNav={setPage} /></KeepAlive>
        <KeepAlive active={page === 'run'}><RunPage viewDate={date} canRun={!!canRun} onRan={(ranDate) => { setDate(ranDate); loadDates(); setParamNonce((n) => n + 1); window.dispatchEvent(new Event(RUN_DONE_EVENT)); }} /></KeepAlive>
        {/* Every OTHER page is keyed on (run date + run nonce): selecting a NEW header date OR completing a re-run
            (paramNonce bumps on every run, so even a SAME-date re-run counts) REMOUNTS them all → guaranteed fresh
            data. Navigating at the same date/run leaves the key unchanged, so KeepAlive keeps them mounted and their
            search / sort / pagination persist. */}
        <div key={`pg-${date}-${paramNonce}`} style={{ display: 'contents' }}>
        {/* NOT kept alive (rendered plain-conditional): the Allocation Summary holds the heavy per-run allocation
            tree, so it unmounts on navigate-away to free that memory and remounts fresh on return, rather than
            lingering hidden. The RLM / 2nd-CFA-shift entries below still use ReservationRunsPage but stay kept alive. */}
        {page === 'resruns' && <Suspense fallback={<PageFallback />}><ReservationRunsPage date={date} /></Suspense>}
        <KeepAlive active={page === 'rlmapproval'}><ReservationRunsPage date={date} initialTab="rlmptl" /></KeepAlive>
        <KeepAlive active={page === 'seccfashift'}><ReservationRunsPage date={date} initialTab="seccfa" /></KeepAlive>
        <KeepAlive active={page === 'cfares'}><CfaStockReservationPage date={date} cfa={cfa} /></KeepAlive>
        <KeepAlive active={page === 'drilldown'}><DrilldownPage date={date} cfa={cfa} /></KeepAlive>
        <KeepAlive active={page === 'subseq'}><SubstitutionSequencePage date={date} cfa={cfa} /></KeepAlive>
        <KeepAlive active={page === 'fillerseq'}><FillerSequencePage date={date} cfa={cfa} /></KeepAlive>
        <KeepAlive active={page === 'cfadb'}><CfaDbPage date={date} /></KeepAlive>
        <KeepAlive active={page === 'clusterprimary'}><ClusterPrimaryPage date={date} cfa={cfa} /></KeepAlive>
        <KeepAlive active={page === 'saporders'}><SapOrdersPage date={date} /></KeepAlive>
        {/* NOT kept alive: Order Status is a heavy server-paginated table — unmount on leave, refetch fresh on return. */}
        {page === 'orderstatus' && <Suspense fallback={<PageFallback />}><OrderStatusPage date={date} /></Suspense>}
        <KeepAlive active={page === 'datatests'}><DataTestsPage date={date} /></KeepAlive>
        <KeepAlive active={page === 'rca'}><RcaPage date={date} /></KeepAlive>
        <KeepAlive active={page === 'trucktrim'}><TruckTrimsPage date={date} cfa={cfa} /></KeepAlive>
        <KeepAlive active={page === 'cfawalk'}><CfaWalkthroughPage date={date} /></KeepAlive>
        <KeepAlive active={page === 'filteredsoq'}><FilteredSoqPage date={date} cfa={cfa} /></KeepAlive>
        <KeepAlive active={page === 'resprefilter'}><ReservationPrefilterPage runProp={preRun} tabProp={preTab} date={date} cfa={cfa} /></KeepAlive>
        <KeepAlive active={page === 'masters'}><MastersPage /></KeepAlive>
        <KeepAlive active={page === 'uatreportv2'}><UatReportV2Page date={date} cfa={cfa} /></KeepAlive>
        <KeepAlive active={page === 'orderjourney'}><OrderJourneyPage date={date} cfa={cfa} /></KeepAlive>
        <KeepAlive active={page === 'flow'}><StoryPage onNav={setPage} /></KeepAlive>
        <KeepAlive active={page === 'schema'}><SchemaPage /></KeepAlive>
        <KeepAlive active={page === 'oeparams'}><OeParametersPage /></KeepAlive>
        <KeepAlive active={page === 'users' && user.is_admin}><UserManagementPage /></KeepAlive>
        </div>
      </Box>
      </Box>
      {/* mobile only: the fixed bottom nav that replaces the sidebar below md */}
      <MobileNav page={page} onNav={setPage} user={user} />
    </Box>
    </DistributorNameProvider>
    </BrandCategoryProvider>
    </RegZskuDescProvider>
    </OeParamsProvider>
  );
}
