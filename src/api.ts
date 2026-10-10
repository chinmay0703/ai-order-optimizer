// api.ts — the ONE place the frontend talks to the backend (FastAPI, Postgres). The backend URL comes ONLY from
// config.apiBase (VITE_API_BASE), read at RUNTIME from /config.js (window.__APP_CONFIG__) with a build-time .env
// fallback for local dev — no hardcoded URL. When it's unset/blank the app calls the SAME ORIGIN "/api/*", which the
// Vite dev server and the prod nginx both reverse-proxy to the backend. The v1 router is at /api/v1, so the value is
// normalised to end in /api/v1:
//   unset / "" (same-origin) -> /api/v1              (vite/nginx proxies /api/* to the backend)
//   "https://host"           -> https://host/api/v1  (direct to the backend)
//   "https://host/api/v1"    -> unchanged
import { config } from './config';
import { authHeader, clearSession, getToken } from './shared/auth';

const ENV_BASE = config.apiBase;   // RUNTIME value (window.__APP_CONFIG__ from /config.js) → build-time .env fallback
if (!ENV_BASE) console.info('[api] VITE_API_BASE not set — using same-origin /api/v1 (proxied to the backend)');
const _base = ENV_BASE.replace(/\/+$/, '');
const BASE = _base === '' ? '/api/v1' : (/\/api\/v1$/.test(_base) ? _base : `${_base}/api/v1`);

// EVERY request carries the Bearer token (api.authHeader). A 401 means no/expired token → drop the session so the
// app falls back to the login screen; a 4xx body's {detail} becomes the thrown message so dialogs show a real reason.
async function fail(r: Response, path: string): Promise<never> {
  if (r.status === 401) clearSession();
  let detail = `${r.status} ${r.statusText} — ${path}`;
  try { const j = await r.json(); if (j?.detail) detail = String(j.detail); } catch { /* keep status text */ }
  throw new Error(detail);
}

async function get<T = unknown>(path: string): Promise<T> {
  const r = await fetch(BASE + path, { headers: { ...authHeader() } });
  if (!r.ok) return fail(r, path);
  return r.json() as Promise<T>;
}

async function post<T = unknown>(path: string): Promise<T> {
  const r = await fetch(BASE + path, { method: 'POST', headers: { ...authHeader() } });
  if (!r.ok) return fail(r, path);
  return r.json() as Promise<T>;
}

async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify(body) });
  if (!r.ok) return fail(r, path);
  return r.json() as Promise<T>;
}

async function putJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify(body) });
  if (!r.ok) return fail(r, path);
  return r.json() as Promise<T>;
}

async function del<T = unknown>(path: string): Promise<T> {
  const r = await fetch(BASE + path, { method: 'DELETE', headers: { ...authHeader() } });
  if (!r.ok) return fail(r, path);
  return r.json() as Promise<T>;
}

// PRODUCTION contract lives at /api/production/* (sibling of /api/v1) — run · orders · health
const PROD_BASE = BASE.replace(/\/api\/v1\/?$/, '/api/production');
async function prodReq<T = unknown>(path: string, method: 'GET' | 'POST'): Promise<T> {
  const r = await fetch(PROD_BASE + path, { method, headers: { ...authHeader() } });
  if (!r.ok) return fail(r, path);
  return r.json() as Promise<T>;
}
const cfaQ = (date: string, cfa?: string) => `?date=${encodeURIComponent(date)}${cfa ? `&cfa=${encodeURIComponent(cfa)}` : ''}`;
// append ?date= / &date= only when a date is chosen (blank/undefined -> backend uses the latest run date)
const wd = (path: string, date?: string) => (date ? path + (path.includes('?') ? '&' : '?') + `date=${encodeURIComponent(date)}` : path);
// Download links are plain <a href> navigations that CAN'T send the Authorization header, so the token rides as a
// ?token= query param (the backend's auth accepts it there) — without it every xlsx download 401s "Not authenticated".
const withTok = (u: string) => u + (u.includes('?') ? '&' : '?') + `token=${encodeURIComponent(getToken())}`;

export const api = {
  base: BASE,
  health: () => get('/health'),
  appConfig: () => get('/app_config'),   // backend-sourced UI flags (run_disabled) — the Run button reads this, not a build var
  version: () => get('/version'),        // running build identity (semver · branch · build# · commit) — the header chip
  dates: () => get('/dates'),   // available run dates + latest, for the global date selector
  // Data page
  tables: () => get('/tables'),
  updateMe: (body: Record<string, string>) => putJson('/auth/me', body),   // the signed-in user's own username / password
  schemaReference: () => get('/schema_reference'),   // Data Model page — every table · column · type, by domain
  regZskuDescriptions: () => get('/reg_zsku_descriptions'),   // reg-zsku -> old_material_description (one per reg-zsku, from region_sku_master)
  regZskuAidenCategories: () => get('/reg_zsku_aiden_categories'),   // reg-zsku -> AIDEN category (aiden_brand_material_master ⋈ region_sku_master)
  distributorNames: () => get('/distributor_names'),          // db code -> Customer Name (served off db_master; nothing stored)
  s3OrderLineItems: (date?: string) => get(wd('/s3_order_line_items', date)),   // S3 hand-off — order_line_items parquet read back from S3
  table: (name: string, limit = 25, offset = 0, q = '') =>
    get(`/tables/${encodeURIComponent(name)}?limit=${limit}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  tableXlsxUrl: (name: string, q = '') =>   // WHOLE table (all rows matching q) as .xlsx — server-side, no 1000-row cap
    withTok(BASE + `/tables/${encodeURIComponent(name)}/xlsx${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  // THE run
  runEngine: (cfa = '5710', date = '30-Jan-2026') =>
    post(`/run?cfa=${encodeURIComponent(cfa)}&date=${encodeURIComponent(date)}`),
  // PRODUCTION contract — run the full pipeline (cfa optional → all CFAs), read the last run, health
  prodRun: (date: string, cfa?: string) => prodReq(`/run${cfaQ(date, cfa)}`, 'POST'),
  // WORKER-BASED run: start it in the backend (returns at once), then TAIL its live progress. Both are decoupled from
  // the page — a refresh just reconnects to /run/progress, and a cron run streams here too.
  runStart: (date: string, cfa?: string) => prodReq(`/run/start${cfaQ(date, cfa)}`, 'POST'),   // fire the background worker
  runCurrent: (since = 0) => prodReq(`/run/current?since=${since}`, 'GET'),                     // one-shot snapshot (status + events)
  // EventSource can't set headers, so the token rides as ?token= (the backend accepts it there) — without it every
  // reconnect after a refresh would 401 and the live progress would die.
  runProgressUrl: (since = 0) => PROD_BASE + `/run/progress?since=${since}&token=${encodeURIComponent(getToken())}`,
  prodOrders: (date: string, cfa?: string) => prodReq(`/orders${cfaQ(date, cfa)}`, 'GET'),
  prodHealth: () => prodReq('/health', 'GET'),
  pipelineAudit: (date?: string) => prodReq(`/audit${date ? `?date=${encodeURIComponent(date)}` : ''}`, 'GET'),   // run-audit: slim header + per-CFA stage detail
  // OE Parameters — the engine's DB-backed thresholds (oe_parameters): view · edit · reset
  oeParameters: () => get('/oe_parameters'),
  setOeParameters: (updates: Record<string, number>) => putJson('/oe_parameters', { updates }),
  resetOeParameters: () => post('/oe_parameters/reset'),
  // engine-view pages — every one takes the selected run date (omitted -> latest)
  reservationRuns: (date?: string) => get(wd('/reservation/runs', date)),
  rlmPtl: (date?: string) => get(wd('/reservation/rlm_ptl', date)),               // RLM truck-approval trucks + SKU line items (date-wise)
  rlmSecondCfa: (date?: string) => get(wd('/reservation/rlm_second_cfa', date)),  // 2nd-CFA shift: preferred vs alternate CFA + line items (date-wise)
  ledger: (date?: string, cfa?: string) => get(wd('/ledger' + (cfa ? `?cfa=${encodeURIComponent(cfa)}` : ''), date)),   // CFA stock ledger + reservation detail — scope to one CFA at scale
  fillerSequence: (date?: string) => get(wd('/filler_sequence', date)),   // Step-3 filler draw sequence, CFA × DB wise (exact engine numbers)
  reservationData: (date?: string) => get(wd('/reservation/data', date)),
  reservationPrefilter: (date?: string) => get(wd('/reservation/prefilter', date)),
  filteredSoq: (date?: string, cfa?: string) => get(wd('/filtered_soq' + (cfa ? `?cfa=${encodeURIComponent(cfa)}` : ''), date)),   // Filtered SOQ demand gate — scope to one CFA at scale
  filteredSoqDropped: (date?: string, cfa?: string, limit = 20, offset = 0, q = '') =>              // dropped distributors — server-paginated + any-field search (DB name/code, CFA, reg-zsku, reason)
    get(wd(`/filtered_soq/dropped?limit=${limit}&offset=${offset}${cfa ? `&cfa=${encodeURIComponent(cfa)}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`, date)),
  lastRunSummary: (date?: string) => get(wd('/last_run_summary', date)),   // Run page: last run's per-CFA summary, live from DB (survives refresh)
  shortfall: (run?: number, date?: string) => get(wd(`/reservation/shortfall${run ? `?run=${run}` : ''}`, date)),
  waterfill: (run = 0, date?: string) => get(wd(`/waterfill?run=${run}`, date)),
  truckTrim: (run = 0, date?: string) => get(wd(`/truck_trim?run=${run}`, date)),
  cfaDb: (date?: string) => get(wd('/cfadb', date)),
  step1TruckFill: (date?: string) => get(wd('/step1_truck_fill', date)),   // CFA×DB Step-1-only truck fill (water-fill tab ②)
  // Final Order — the shipped order per CFA × DB × reg-zsku (table JSON); + the .xlsx download URL (same endpoint)
  clusterPrimary: (date?: string, cfa?: string) => get(wd('/cluster_primary' + (cfa ? `?cfa=${encodeURIComponent(cfa)}` : ''), date)),   // transshipment cluster primary-truck build + trim
  clusterPrimaryTrucks: (date?: string, cfa?: string) => get(wd('/cluster_primary_trucks' + (cfa ? `?cfa=${encodeURIComponent(cfa)}` : ''), date)),   // the FINAL cluster primary truck(s): combined reg-zsku + SKU level
  finalOrder: (date?: string) => get(wd('/final_order', date)),
  finalOrderXlsxUrl: (date?: string) => withTok(BASE + wd('/final_order?format=xlsx', date)),
  cfaRegzskuSummary: (date?: string) => get(wd('/cfa_regzsku_summary', date)),   // CFA×Reg-ZSKU SO-created roll-up (Inventory · SOQ · AOQ)
  // SIT page — the full 32-col final-allocation report, live. CFA-scoped + PAGINATED server-side (cfa/q/sort/limit/offset);
  // KPIs + total + filtered are computed over the whole cfa-scoped set, `rows` is the requested page slice.

  // Reporting-Format validation sheet — one row per CFA × DB (every SOQ distributor incl. pre-engine drops). Screen
  // scopes to the header CFA + paginated; the Excel download OMITS cfa on purpose so it exports EVERY CFA.
  finalOrderReport: (o: { date?: string; cfa?: string; q?: string; sort?: number; dir?: 'asc' | 'desc'; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (o.cfa) p.set('cfa', o.cfa);
    if (o.q && o.q.trim()) p.set('q', o.q.trim());
    if (o.sort != null && o.sort >= 0) { p.set('sort', String(o.sort)); p.set('dir', o.dir ?? 'asc'); }
    if (o.limit != null) p.set('limit', String(o.limit));
    if (o.offset != null) p.set('offset', String(o.offset));
    const qs = p.toString();
    return get(wd(`/final_order_report${qs ? `?${qs}` : ''}`, o.date));
  },
  // Excel = the FULL sheet for ALL CFAs (cfa deliberately omitted) — the on-screen table stays CFA-scoped for reading
  finalOrderReportXlsxUrl: (date?: string) => withTok(BASE + wd('/final_order_report?format=xlsx', date)),
  // Allocation Report (shown as "Allocation Report"; backend path /uat_report_v2 kept) — the original UAT Report page was retired
  uatReportV2: (o: { date?: string; cfa?: string; q?: string; sort?: number; dir?: 'asc' | 'desc'; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (o.cfa) p.set('cfa', o.cfa);
    if (o.q && o.q.trim()) p.set('q', o.q.trim());
    if (o.sort != null && o.sort >= 0) { p.set('sort', String(o.sort)); p.set('dir', o.dir ?? 'asc'); }
    if (o.limit != null) p.set('limit', String(o.limit));
    if (o.offset != null) p.set('offset', String(o.offset));
    const qs = p.toString();
    return get(wd(`/uat_report_v2${qs ? `?${qs}` : ''}`, o.date));
  },
  uatReportV2XlsxUrl: (date?: string) => withTok(BASE + wd('/uat_report_v2?format=xlsx', date)),
  // Order Journey — real trucks per DB with the owner-centric reg-zsku lines each carried (standalone from UAT V2)
  orderJourneyTrucks: (o: { date?: string; cfa?: string } = {}) => {
    const p = new URLSearchParams();
    if (o.cfa) p.set('cfa', o.cfa);
    const qs = p.toString();
    return get(wd(`/order_journey_trucks${qs ? `?${qs}` : ''}`, o.date));
  },
  sapOrders: (date?: string) => get(wd('/sap_orders', date)),                       // the SAP `orders` hand-off table
  sapOrdersXlsxUrl: (date?: string) => withTok(BASE + wd('/sap_orders?format=xlsx', date)),
  orderStatus: (date?: string, limit = 100, offset = 0, q = '') =>                    // SAP `order_status` — server-paginated page
    get(wd(`/order_status?limit=${limit}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ''}`, date)),
  orderStatusXlsxUrl: (date?: string, q = '') =>                                       // whole result (all matching rows), not a page
    withTok(BASE + wd(`/order_status?format=xlsx${q ? `&q=${encodeURIComponent(q)}` : ''}`, date)),
  dataTests: (date?: string) => get(wd('/data_tests', date)),                        // QA — live data-quality checks
  dataTestDetail: (id: string, date?: string) => get(wd(`/data_tests/detail?id=${encodeURIComponent(id)}`, date)),  // the offending rows for one check (Excel download)
  cfaList: (date?: string) => get(wd('/cfa/list', date)),
  plants: () => get('/plants'),   // every plant/CFA in the warehouse universe (+ has_demand / has_inventory flags)
  cfaRun: (cfa: string, run: number, runDay?: string, date?: string) =>
    get(wd(`/cfa/${encodeURIComponent(cfa)}/run/${run}${runDay ? `?run_day=${runDay}` : ''}`, date)),
  // RCA drill-through
  rcaIndex: (date?: string) => get(wd('/rca/index', date)),
  rcaDb: (dbid: string, date?: string) => get(wd(`/rca/db/${encodeURIComponent(dbid)}`, date)),
  rcaRegzsku: (z: string, date?: string) => get(wd(`/rca/regzsku/${encodeURIComponent(z)}`, date)),
  rcaCfa: (cfa: string, date?: string) => get(wd(`/rca/cfa/${encodeURIComponent(cfa)}`, date)),
  // AUTH + user management
  login: (username: string, password: string) => postJson('/auth/login', { username, password }),
  me: () => get('/auth/me'),
  listUsers: () => get('/auth/users'),
  createUser: (body: { username: string; password: string; is_admin: boolean; can_access_run: boolean }) => postJson('/auth/users', body),
  updateUser: (id: number, body: Record<string, unknown>) => putJson(`/auth/users/${id}`, body),
  deleteUser: (id: number) => del(`/auth/users/${id}`),
};
