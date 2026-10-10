// admin.ts — Administration + reference-data routes for the demo backend (see ../router.ts):
//   • auth / users      — login, /auth/me (profile edit), /auth/users CRUD. Overrides core.ts: the Users page reads a
//                         bare ARRAY, the profile dialog expects the plain AuthUser back, and admin/admin is locked.
//   • /version          — the header chip + login footer build identity
//   • /oe_parameters    — view / edit / reset, with value_type + min/max + who/when (the OE Parameters page contract)
//   • /tables           — the Data page catalog + paginated, searchable rows + whole-table .xlsx export
//   • /schema_reference — the Data Model page: every table · column · type by domain (same column defs as /tables)
// Every row is built from ../dataset (1 CFA · 10 distributors · 40 reg-zskus), so the Data page agrees with every
// other screen. Registered after core.ts, so a same METHOD + pattern here replaces core's.
import { get, post, put, del, HttpError, xlsxTable, type Ctx } from '../router';
import {
  rng, CFA, CFA_NAME, ALT_CFA, REGION, PLANTS, DISTRIBUTORS, REG_ZSKUS, DEMAND, RUNS, RUN_RESULTS, LANES, CLUSTERS,
  PRIMARY_CAP, OE_PARAM_DEFS, RUN_DATES, LATEST_DATE, SOQ_DATE, RUN_TIMESTAMP, dbByCode, rzByCode, tierWeight,
  type Distributor,
} from '../dataset';
import { loadUsers, saveUsers, publicUser, requireUser, requireAdmin, loadParams, type DemoUser } from './core';

// ═════════════════════════════════════════ auth · users ═════════════════════════════════════════
type U = DemoUser & { updated_at?: string };
const ADMIN = 'admin';
const MIN_PW = 8;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const nowIso = () => new Date().toISOString();
const tokenFor = (u: U) => {
  let tag = u.username;
  try { tag = btoa(u.username); } catch { /* non-latin1 name — the id is what the token check reads anyway */ }
  return `demo.${u.id}.${tag}`;
};
const userRow = (u: U) => ({ ...publicUser(u), updated_at: u.updated_at ?? u.created_at });

/** The stored users, with the demo admin healed back to admin/admin so the documented sign-in always works. */
function users(): U[] {
  const us = loadUsers() as U[];
  const a = us.find((x) => x.username === ADMIN);
  if (a && (a.password !== ADMIN || !a.is_admin || !a.can_access_run)) {
    a.password = ADMIN; a.is_admin = true; a.can_access_run = true;
    saveUsers(us);
  }
  return us.sort((x, y) => x.id - y.id);
}
function cleanUsername(raw: unknown, us: U[], selfId?: number): string {
  const n = String(raw ?? '').trim();
  if (!n) throw new HttpError(400, 'Username is required');
  if (!USERNAME_RE.test(n)) throw new HttpError(400, 'Username must be 3–32 characters: letters, digits, dot, underscore or hyphen');
  if (us.some((x) => x.id !== selfId && x.username.toLowerCase() === n.toLowerCase())) {
    throw new HttpError(409, `Username "${n}" is already taken`);
  }
  return n;
}
function cleanPassword(raw: unknown): string {
  const p = String(raw ?? '');
  if (p.length < MIN_PW) throw new HttpError(400, `Password must be at least ${MIN_PW} characters`);
  return p;
}
const ADMIN_LOCKED = 'Demo mode: the admin sign-in is fixed at admin / admin, so its username and password can’t be changed. '
  + 'Try it with another account (e.g. planner / planner).';

post('/api/v1/auth/login', (ctx) => {
  const b = (ctx.body ?? {}) as { username?: unknown; password?: unknown };
  const name = String(b.username ?? '').trim();
  const pw = String(b.password ?? '');
  if (!name || !pw) throw new HttpError(400, 'Enter your username and password');
  const u = users().find((x) => x.username.toLowerCase() === name.toLowerCase());
  if (!u || u.password !== pw) throw new HttpError(401, 'Incorrect username or password');
  return { access_token: tokenFor(u), token_type: 'bearer', user: publicUser(u) };
});

get('/api/v1/auth/me', (ctx) => publicUser(requireUser(ctx)));

// the signed-in user's own profile: { username?, password?, current_password? } → the updated AuthUser
put('/api/v1/auth/me', (ctx) => {
  const me = requireUser(ctx);
  const b = (ctx.body ?? {}) as { username?: unknown; password?: unknown; current_password?: unknown };
  const us = users();
  const u = us.find((x) => x.id === me.id)!;
  const wantsName = b.username !== undefined && String(b.username).trim() !== u.username;
  const wantsPw = b.password !== undefined && String(b.password) !== '';
  if (!wantsName && !wantsPw) throw new HttpError(400, 'Nothing to change');
  if (u.username === ADMIN) throw new HttpError(403, ADMIN_LOCKED);
  if (wantsPw) {
    if (String(b.current_password ?? '') !== u.password) throw new HttpError(400, 'Current password is incorrect');
    const pw = cleanPassword(b.password);
    if (pw === u.password) throw new HttpError(400, 'The new password must differ from the current one');
  }
  if (wantsName) u.username = cleanUsername(b.username, us, u.id);
  if (wantsPw) u.password = String(b.password);
  u.updated_at = nowIso();
  saveUsers(us);
  return publicUser(u);
});

// Users page: a bare array of rows (id · username · is_admin · can_access_run · created_at · updated_at)
get('/api/v1/auth/users', (ctx) => { requireAdmin(ctx); return users().map(userRow); });

post('/api/v1/auth/users', (ctx) => {
  requireAdmin(ctx);
  const b = (ctx.body ?? {}) as { username?: unknown; password?: unknown; is_admin?: unknown; can_access_run?: unknown };
  const us = users();
  const username = cleanUsername(b.username, us);
  const password = cleanPassword(b.password);
  const isAdmin = !!b.is_admin;
  const t = nowIso();
  const u: U = { id: Math.max(0, ...us.map((x) => x.id)) + 1, username, password, is_admin: isAdmin,
    can_access_run: isAdmin || !!b.can_access_run, created_at: t, updated_at: t };
  us.push(u); saveUsers(us);
  return userRow(u);
});

put('/api/v1/auth/users/:id', (ctx) => {
  const me = requireAdmin(ctx);
  const us = users();
  const u = us.find((x) => x.id === Number(ctx.params.id));
  if (!u) throw new HttpError(404, 'User not found');
  const b = (ctx.body ?? {}) as { username?: unknown; password?: unknown; is_admin?: unknown; can_access_run?: unknown };
  const isAdminAcct = u.username === ADMIN;
  const nextName = b.username !== undefined ? String(b.username).trim() : u.username;
  const wantsPw = b.password !== undefined && String(b.password) !== '';
  if (isAdminAcct && (nextName !== u.username || wantsPw)) throw new HttpError(403, ADMIN_LOCKED);
  const nextAdmin = b.is_admin !== undefined ? !!b.is_admin : u.is_admin;
  if (!nextAdmin && u.is_admin && (isAdminAcct || u.id === me.id)) {
    throw new HttpError(400, isAdminAcct ? 'The admin account is always an administrator' : 'You can’t remove your own admin rights');
  }
  if (nextName !== u.username) u.username = cleanUsername(nextName, us, u.id);
  if (wantsPw) u.password = cleanPassword(b.password);
  u.is_admin = nextAdmin;
  u.can_access_run = nextAdmin || (b.can_access_run !== undefined ? !!b.can_access_run : u.can_access_run);
  u.updated_at = nowIso();
  saveUsers(us);
  return userRow(u);
});

del('/api/v1/auth/users/:id', (ctx) => {
  const me = requireAdmin(ctx);
  const id = Number(ctx.params.id);
  const us = users();
  const u = us.find((x) => x.id === id);
  if (!u) throw new HttpError(404, 'User not found');
  if (id === me.id) throw new HttpError(400, 'You can’t delete your own account');
  if (u.username === ADMIN) throw new HttpError(400, 'The admin account can’t be deleted');
  saveUsers(us.filter((x) => x.id !== id));
  return { ok: true, deleted: id, username: u.username };
});

// ═════════════════════════════════════════ build identity ═════════════════════════════════════════
// version = the clean nearest tag (already 'v'-prefixed), describe = full git-describe; branch 'demo' → the chip reads "DEMO · v1.4.2"
get('/api/v1/version', () => ({
  version: 'v1.4.2', describe: 'v1.4.2-6-g3f9c2ab', branch: 'demo', build: '418', commit: '3f9c2ab',
  built_at: '2026-10-10T08:30:00+05:30', env: 'demo',
}));

// ═════════════════════════════════════════ OE parameters ═════════════════════════════════════════
// Values live under core.ts's key (other handlers read them via loadParams); who/when lives beside them.
const PARAMS_KEY = 'aiden.demo.oe_params';
const PARAMS_META_KEY = 'aiden.demo.oe_params_meta';
const PARAM_RULES: Record<string, { value_type: 'int' | 'float'; min: number | null; max: number | null; label: string }> = {
  DEFAULT_TIER: { value_type: 'int', min: 1, max: 4, label: 'Default tier' },
  ADDON_CAP_PCT: { value_type: 'float', min: 0, max: 1, label: 'Add-on cap' },
  NORM_MULTIPLIER: { value_type: 'float', min: 1, max: 3, label: 'Norm multiplier' },
  TRUCK_KEEP_PCT: { value_type: 'float', min: 0, max: 1, label: 'Truck keep floor' },
  TRUCK_FILL_TARGET_PCT: { value_type: 'float', min: 0, max: 1, label: 'Filler fill target' },
  SO_CREATION_ORIGINAL_FLOOR_PCT: { value_type: 'float', min: 0, max: 1, label: 'SO original floor' },
  SO_CREATION_TRUCK_FILL_PCT: { value_type: 'float', min: 0, max: 1, label: 'SO truck-fill gate' },
};
type ParamMeta = Record<string, { updated_at: string; updated_by: string }>;
function loadParamMeta(): ParamMeta {
  try { return (JSON.parse(localStorage.getItem(PARAMS_META_KEY) || '{}') as ParamMeta) ?? {}; } catch { return {}; }
}
function storeParams(values: Record<string, number> | null, meta: ParamMeta | null): void {
  try {
    if (values) localStorage.setItem(PARAMS_KEY, JSON.stringify(values)); else localStorage.removeItem(PARAMS_KEY);
    if (meta) localStorage.setItem(PARAMS_META_KEY, JSON.stringify(meta)); else localStorage.removeItem(PARAMS_META_KEY);
  } catch { /* private mode — nothing persists */ }
}
const SEEDED_AT = '2026-09-01T09:00:00+05:30';
function paramsPayload() {
  const cur = loadParams();
  const meta = loadParamMeta();
  return {
    parameters: OE_PARAM_DEFS.map((p) => {
      const r = PARAM_RULES[p.key] ?? { value_type: 'float' as const, min: null, max: null };
      return {
        key: p.key, value: cur[p.key] ?? p.default, default: p.default, value_type: r.value_type,
        description: p.description, min: r.min, max: r.max,
        updated_at: meta[p.key]?.updated_at ?? SEEDED_AT, updated_by: meta[p.key]?.updated_by ?? 'system',
      };
    }),
  };
}
get('/api/v1/oe_parameters', () => paramsPayload());
put('/api/v1/oe_parameters', (ctx) => {
  const me = requireAdmin(ctx);
  const upd = ((ctx.body ?? {}) as { updates?: Record<string, unknown> }).updates;
  if (!upd || typeof upd !== 'object' || !Object.keys(upd).length) throw new HttpError(400, 'No parameter updates were sent');
  const cur = loadParams();
  const meta = loadParamMeta();
  const t = nowIso();
  for (const [k, raw] of Object.entries(upd)) {
    const rule = PARAM_RULES[k];
    if (!rule || !(k in cur)) throw new HttpError(400, `Unknown parameter ${k}`);
    const v = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(v)) throw new HttpError(400, `${k} must be a number`);
    if (rule.value_type === 'int' && !Number.isInteger(v)) throw new HttpError(400, `${k} must be a whole number`);
    if ((rule.min != null && v < rule.min) || (rule.max != null && v > rule.max)) {
      throw new HttpError(400, `${k} must be between ${rule.min ?? '−∞'} and ${rule.max ?? '∞'} (got ${v})`);
    }
    cur[k] = v;
    meta[k] = { updated_at: t, updated_by: me.username };
  }
  storeParams(cur, meta);
  return paramsPayload();
});
post('/api/v1/oe_parameters/reset', (ctx) => {
  requireAdmin(ctx);
  storeParams(null, null);
  return paramsPayload();
});

// ═════════════════════════════════════════ data catalog (/tables) ═════════════════════════════════════════
type Cell = string | number | null;
type Group = 'Masters' | 'Orphan Masters' | 'Transactional' | 'Processed' | 'Engine Output';
type Domain = 'masters' | 'transaction' | 'processed' | 'engine' | 'orders' | 'rlm' | 'sap';
interface TableDef {
  table: string; schema: string; group: Group | null; domain: Domain; label: string; description: string;
  source: 'Postgres' | 'S3'; s3: ((date: string) => string) | null;
  cols: [string, string][];                 // [column, Postgres type]
  rows: ((date: string) => Cell[][]) | null; // null → schema-only (Data Model page), not in the Data catalog
}
const GROUPS: Group[] = ['Masters', 'Orphan Masters', 'Transactional', 'Processed', 'Engine Output'];

// Postgres column types
const CODE = 'varchar(10)', PLANT = 'varchar(4)', RZ = 'varchar(16)', MAT = 'varchar(12)', TXT = 'text', INT = 'integer',
  NUM = 'numeric(12,2)', PCT = 'numeric(6,2)', DATE = 'date', TS = 'timestamptz', BOOL = 'boolean', SINT = 'smallint',
  FLAG = 'varchar(3)', UUID = 'uuid', JSONB = 'jsonb';

// dates
const MON: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const runDate = (d: string) => (RUN_DATES.includes(d) ? d : LATEST_DATE);
const isoRun = (d: string) => { const [dd, mm, yy] = runDate(d).split('-'); return `${yy}-${MON[mm] ?? '01'}-${dd.padStart(2, '0')}`; };
const isoSoq = (d: string) => { const [dd, mm, yy] = (SOQ_DATE[runDate(d)] ?? '').split('-'); return `${yy}-${mm}-${dd}`; };
const MASTER_LOAD = '2026-10-10';
const LOADED_AT = '2026-10-10 05:12:40+05:30';
const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;
const yn = (b: boolean) => (b ? 'Yes' : 'No');
const tf = (b: boolean) => (b ? 'true' : 'false');
const s3Master = (name: string) => () => `s3://demo-landing/masters/${name}/load_date=${MASTER_LOAD}/${name}.parquet`;
const s3Daily = (name: string) => (d: string) => `s3://demo-landing/daily/${name}/data_date=${isoSoq(d)}/part-00000.parquet`;

// per-distributor reference attributes (fictional)
const PIN: Record<string, string> = { Pune: '411001', Pimpri: '411018', Chakan: '410501', Hadapsar: '411028', Lonavala: '410401',
  Kothrud: '411038', Wakad: '411057', Baramati: '413102', Satara: '415001', Karad: '415110' };
const KM: Record<string, number> = { Pune: 12, Pimpri: 22, Chakan: 34, Hadapsar: 15, Lonavala: 66, Kothrud: 14, Wakad: 24, Baramati: 102, Satara: 115, Karad: 168 };
const STREET = ['MG Road', 'Old Mumbai Highway', 'Talegaon Chakan Road', 'Solapur Road', 'Station Road', 'Paud Road',
  'Hinjewadi Road', 'Bhigwan Road', 'Powai Naka', 'Krishna Naka'];
const VEH: Record<string, string> = { '19-20 FT Container': 'S5', '17 FT Container': 'C8', 'ACE Container': 'A1' };
const dbIdx = (d: Distributor) => DISTRIBUTORS.indexOf(d);
const pdpOf = (d: Distributor) => {
  const f = d.channel === 'Non-PACE'
    ? (d.tier === 1 ? ['Daily', 1] : d.tier === 2 ? ['Thrice a week', 2] : ['Twice a week', 3])
    : (d.tier === 1 ? ['Thrice a week', 2] : d.tier === 2 ? ['Twice a week', 3] : ['Weekly', 7]);
  return { freq: f[0] as string, rf: f[1] as number, today: d.tier <= 2 };
};
const tierScore = (d: Distributor) => r2((d.tier === 1 ? 0.88 : d.tier === 2 ? 0.71 : 0.52) - dbIdx(d) * 0.011);
const BRANDS = [...new Set(REG_ZSKUS.map((z) => z.brand))];

// per demand line: daily run rate (L3M primary ÷ 90), in-transit, below-threshold flag — deterministic
const LINE_X = (() => {
  const R = rng(4242);
  return DEMAND.map((dm) => {
    const normDays = 3 + R.int(0, 30) / 10;
    const drr = r2(dm.norm / normDays);
    return { drr, l3m: Math.round(drr * 90), normDays: r1(normDays), inTransit: R.chance(0.18) ? R.int(1, 6) : 0,
      below: dm.dbStock < 0.15 * dm.norm };
  });
})();
// a non-PDP distributor enters the run on a below-threshold line — make sure each has at least one
for (const d of DISTRIBUTORS) {
  if (pdpOf(d).today) continue;
  const idx = DEMAND.map((dm, i) => (dm.db === d.code ? i : -1)).filter((i) => i >= 0);
  if (!idx.some((i) => LINE_X[i].below)) {
    const lo = idx.sort((a, b) => DEMAND[a].dbStock / DEMAND[a].norm - DEMAND[b].dbStock / DEMAND[b].norm)[0];
    if (lo !== undefined) LINE_X[lo].below = true;
  }
}
// alternate-CFA stock (it has stock, no own demand): a slice of the catalogue
const ALT_STOCK = (() => {
  const R = rng(9002);
  return REG_ZSKUS.map((z, i) => (i % 3 === 0 || R.chance(0.3) ? R.int(18, 140) : 0));
})();

const TABLES: TableDef[] = [
  // ───────── Masters (13 — fully re-loaded every run) ─────────
  { table: 'db_master', schema: 'ds_app', group: 'Masters', domain: 'masters', label: 'DB Master',
    description: 'Distributor universe & attributes (customer code, location, channel, sales office)',
    source: 'Postgres', s3: s3Master('db_master'),
    cols: [['Customer Code', CODE], ['Customer Name', TXT], ['City', TXT], ['Street', TXT], ['Postal Code', 'varchar(6)'],
      ['Region', PLANT], ['Sales Office', TXT], ['Sub Channel', 'varchar(20)'], ['Customer Type', 'varchar(20)'], ['GSTIN', 'varchar(15)'],
      ['Telephone', 'varchar(15)'], ['Sales Organization', PLANT], ['Dist. Channel', 'varchar(2)'], ['Price Zone', 'varchar(8)'],
      ['is_active_flag', SINT], ['created_date', DATE], ['updated_date', DATE]],
    rows: () => DISTRIBUTORS.map((d, i) => [d.code, d.name, d.city, `${12 + i * 7}, ${STREET[i]}`, PIN[d.city] ?? '411001', REGION,
      d.salesOffice, d.channel, d.transship ? 'Sub-stockist' : 'Distributor', d.gstin, `+91 98${String(22013570 + i * 104729).slice(0, 8)}`,
      '1000', '10', d.salesOffice === 'Pune City' ? 'PZ-MH1' : 'PZ-MH2', 1, '2025-04-01', MASTER_LOAD]) },
  { table: 'material_master', schema: 'ds_app', group: 'Masters', domain: 'masters', label: 'Material Master',
    description: 'SKU (SAP material) attributes — pack, case size, MRP; one row per material',
    source: 'Postgres', s3: s3Master('material_master'),
    cols: [['Material_no', MAT], ['Material_description', TXT], ['Old_Material_Number', CODE], ['Brand', TXT], ['Product_Category', TXT],
      ['Material_type', PLANT], ['Base_unit', 'varchar(3)'], ['Numerator', INT], ['Denominator', INT], ['Gramage_Value', NUM],
      ['MRP_Value', NUM], ['Region', PLANT], ['Sales_Org', PLANT], ['created_date', DATE]],
    rows: () => REG_ZSKUS.flatMap((z) => z.skus.map((v) => [v.sku, v.desc, z.zsku, z.brand, z.category, 'FERT', 'CS',
      v.unitsPerCase, 1, z.packG, v.mrp, REGION, '1000', MASTER_LOAD])) },
  { table: 'region_sku_master', schema: 'ds_app', group: 'Masters', domain: 'masters', label: 'Region SKU Master',
    description: 'reg-zsku → primary material, description and MRP (one row per reg-zsku)',
    source: 'Postgres', s3: s3Master('region_sku_master'),
    cols: [['reg_zsku', RZ], ['region', PLANT], ['zsku', CODE], ['material_no', MAT], ['old_material_description', TXT],
      ['mrp', NUM], ['units_per_case', INT], ['variants', SINT], ['is_active', BOOL]],
    rows: () => REG_ZSKUS.map((z) => [z.rz, REGION, z.zsku, z.skus[0].sku, z.desc, z.mrp, z.unitsPerCase, z.skus.length, tf(true)]) },
  { table: 'aiden_brand_material_master', schema: 'ds_app', group: 'Masters', domain: 'masters', label: 'Brand Material Master',
    description: 'zsku → brand, AIDEN category and segment (the Step-2 substitute match key)',
    source: 'Postgres', s3: s3Master('aiden_brand_material_master'),
    cols: [['zsku', CODE], ['brand', TXT], ['aiden_category', TXT], ['aiden_segment', TXT], ['pack_size', 'varchar(8)'], ['price_point', NUM]],
    rows: () => REG_ZSKUS.map((z) => {
      const drink = /Drink|Juice/.test(z.category);
      const size = drink ? (z.packG >= 1000 ? `${z.packG / 1000}L` : `${z.packG}ml`) : (z.packG >= 1000 ? `${z.packG / 1000}kg` : `${z.packG}g`);
      return [z.zsku, z.brand, z.category, drink ? 'Beverages' : z.category === 'Oats & Cereal' ? 'Foods' : 'Snacks', size, z.mrp];
    }) },
  { table: 'plant_master', schema: 'ds_app', group: 'Masters', domain: 'masters', label: 'Plant Master',
    description: 'Every plant / CFA in the warehouse universe, with demand + inventory flags',
    source: 'Postgres', s3: s3Master('plant_master'),
    cols: [['Plant', PLANT], ['Plant_Name', TXT], ['Plant_Type', 'varchar(8)'], ['Region', PLANT], ['City', TXT],
      ['has_demand', BOOL], ['has_inventory', BOOL], ['Company_Code', PLANT]],
    rows: () => PLANTS.map((p) => [p.plant, p.name, 'CFA', p.region, p.city, tf(p.has_demand), tf(p.has_inventory), '1000']) },
  { table: 'network_master', schema: 'ds_app', group: 'Masters', domain: 'masters', label: 'Network Master',
    description: 'Distributor × brand → serving plant, with the secondary CFA used for a 2nd-CFA shift',
    source: 'Postgres', s3: s3Master('network_master'),
    cols: [['Distributor_Code', CODE], ['Brand', TXT], ['Plant_Code', PLANT], ['Secondary_CFA', PLANT]],
    rows: () => DISTRIBUTORS.flatMap((d) => BRANDS
      .filter((b) => DEMAND.some((dm) => dm.db === d.code && rzByCode.get(dm.rz)?.brand === b))
      .map((b) => [d.code, b, CFA, ALT_CFA])) },
  { table: 'truck_master', schema: 'ds_app', group: 'Masters', domain: 'masters', label: 'Truck Master',
    description: 'Lane truck type and billed-case stats per CFA × distributor (Max = the lane truck capacity)',
    source: 'Postgres', s3: s3Master('truck_master'),
    cols: [['Source_Plant_Key', PLANT], ['Customer_No', CODE], ['Vehicle_Type_Key', 'varchar(2)'], ['Truck_description', TXT],
      ['Max_cases', INT], ['Median_cases', INT], ['Min_cases', INT], ['effective_from', DATE], ['effective_to', DATE], ['is_current', SINT]],
    rows: () => [CFA, ALT_CFA].flatMap((plant) => DISTRIBUTORS.map((d) => [plant, d.code, VEH[d.truckType] ?? 'S5', d.truckType,
      d.truckCap, Math.round(d.truckCap * 0.93), Math.round(d.truckCap * 0.7), '2026-07-01', '9999-12-31', 1])) },
  { table: 'transhipment_master', schema: 'ds_app', group: 'Masters', domain: 'masters', label: 'Transhipment Master',
    description: 'Cluster master — CFA × distributor transshipment clusters with primary and secondary truck capacities',
    source: 'Postgres', s3: s3Master('transhipment_master'),
    cols: [['Distributor Code', CODE], ['Distributor Name', TXT], ['Plant Code', PLANT], ['Plant Description', TXT],
      ['Cluster Code', 'varchar(12)'], ['Cluster Name', TXT], ['Unit', 'varchar(3)'], ['Primary Truck Type', TXT],
      ['Min Cases', INT], ['Median Cases', INT], ['Max Cases', INT], ['Secondary Truck Type', TXT],
      ['Secondary Min Cases', INT], ['Secondary Median Cases', INT], ['Secondary Max Cases', INT]],
    rows: () => DISTRIBUTORS.filter((d) => d.transship).map((d) => [d.code, d.name, CFA, CFA_NAME, d.cluster, 'Pune South Cluster', 'CS',
      '32 FT MXL', Math.round(PRIMARY_CAP * 0.7), Math.round(PRIMARY_CAP * 0.94), PRIMARY_CAP, d.truckType,
      Math.round(d.truckCap * 0.7), Math.round(d.truckCap * 0.93), d.truckCap]) },
  { table: 'substitution_master', schema: 'ds_app', group: 'Masters', domain: 'masters', label: 'Substitution Master',
    description: 'Ranked substitute reg-zskus per distributor × distinct MRP (latest load)',
    source: 'Postgres', s3: s3Master('substitution_master'),
    cols: [['DB ID', CODE], ['MRP', NUM], ['reg_zsku', RZ], ['rank', SINT]],
    rows: () => DISTRIBUTORS.flatMap((d) => {
      const mine = DEMAND.filter((dm) => dm.db === d.code).map((dm) => rzByCode.get(dm.rz)!);
      const mrps = [...new Set(mine.map((z) => z.mrp))].sort((a, b) => a - b);
      return mrps.flatMap((mrp) => REG_ZSKUS.filter((z) => z.mrp === mrp)
        .sort((a, b) => b.cfaStock - a.cfaStock).slice(0, 6)
        .map((z, i): Cell[] => [d.code, mrp, z.rz, i + 1]));
    }) },
  { table: 'filler_master', schema: 'ds_app', group: 'Masters', domain: 'masters', label: 'Filler Master',
    description: 'Filler-eligible reg-zskus per distributor, ranked by last-3-month filler quantity (latest load)',
    source: 'Postgres', s3: s3Master('filler_master'),
    cols: [['DIST_CD', CODE], ['reg_zsku', RZ], ['filler_qty', INT], ['filler_rank', SINT]],
    rows: () => {
      const R = rng(3131);
      return DISTRIBUTORS.flatMap((d) => REG_ZSKUS.filter((z) => z.isFiller)
        .map((z) => ({ z, q: Math.round((40 + R.int(0, 260)) * tierWeight(d.tier)) }))
        .sort((a, b) => b.q - a.q)
        .map((x, i): Cell[] => [d.code, x.z.rz, x.q, i + 1]));
    } },
  { table: 'db_tier', schema: 'ds_app', group: 'Masters', domain: 'masters', label: 'DB Tier',
    description: 'Distributor tiering (1 = best) — the Step-1 water-fill weight',
    source: 'Postgres', s3: s3Master('db_tier'),
    cols: [['DB ID', CODE], ['Distributor_Name', TXT], ['DB_Tier', SINT], ['Final_Tier_Score', NUM], ['Tier_Weight', NUM]],
    rows: () => DISTRIBUTORS.map((d) => [d.code, d.name, d.tier, tierScore(d), tierWeight(d.tier)]) },
  { table: 'pdp_master', schema: 'ds_app', group: 'Masters', domain: 'masters', label: 'PDP Master',
    description: 'Distributor PDP (planned delivery) frequency → the Step-1 RF in days',
    source: 'Postgres', s3: s3Master('pdp_master'),
    cols: [['DB ID', CODE], ['Distributor_Name', TXT], ['PDP_Frequency', 'varchar(20)'], ['RF_Days', SINT], ['Effective_From', DATE]],
    rows: () => DISTRIBUTORS.map((d) => { const p = pdpOf(d); return [d.code, d.name, p.freq, p.rf, '2026-08-01']; }) },
  { table: 'lead_time_master', schema: 'ds_app', group: 'Masters', domain: 'masters', label: 'Lead Time Master',
    description: 'Plant → distributor road distance and lead time',
    source: 'Postgres', s3: s3Master('lead_time_master'),
    cols: [['Source_Plant', PLANT], ['Customer_No', CODE], ['Distance_km', INT], ['Lead_Time_Days', SINT]],
    rows: () => [CFA, ALT_CFA].flatMap((plant) => DISTRIBUTORS.map((d) => {
      const km = (KM[d.city] ?? 40) + (plant === ALT_CFA ? 205 : 0);
      return [plant, d.code, km, km > 250 ? 2 : 1];
    })) },

  // ───────── Orphan Masters (delivered, not read by the engine) ─────────
  { table: 'db_zsku_inventory_norms', schema: 'ds_app', group: 'Orphan Masters', domain: 'masters', label: 'Norms Master (ZSKU level)',
    description: 'Suggested vs final stock norms per distributor × zsku — served live from S3 (the engine reads norms from the SOQ)',
    source: 'S3', s3: s3Master('db_zsku_inventory_norms'),
    cols: [['Distributor_Code', CODE], ['Distributor_Name', TXT], ['ZSKU', CODE], ['ZSKU_Description', TXT],
      ['Suggested_Norm_in_Days', NUM], ['Suggested_Norms_in_Qty', NUM], ['Final_Norm_in_Days', NUM], ['Final_Norms_in_Qty', NUM]],
    rows: () => DEMAND.map((dm, i) => {
      const d = dbByCode.get(dm.db)!, z = rzByCode.get(dm.rz)!, x = LINE_X[i];
      const sugg = Math.round(dm.norm * (i % 4 === 0 ? 0.9 : 1));
      return [d.code, d.name, z.zsku, z.desc, x.normDays, sugg, x.normDays, dm.norm];
    }) },
  { table: 'cfa_db_truck_load_master', schema: 'ds_app', group: 'Orphan Masters', domain: 'masters', label: 'Truck Load Register',
    description: 'Truck IDs registered per CFA × distributor lane (read for the truck ID only)',
    source: 'S3', s3: s3Master('cfa_db_truck_load_master'),
    cols: [['Plant', PLANT], ['DB ID', CODE], ['Truck_ID', 'varchar(16)'], ['Vehicle_Type_Key', 'varchar(2)'], ['Capacity_Cases', INT], ['Registered_On', DATE]],
    rows: () => LANES.flatMap((l) => l.loads.map((ld) => [CFA, l.db.code, ld.truckid, VEH[l.db.truckType] ?? 'S5', l.db.truckCap, '2026-07-01'])) },

  // ───────── Transactional (dated feeds, by data date) ─────────
  { table: 'raw_soq', schema: 'ds_app', group: 'Transactional', domain: 'transaction', label: 'SOQ',
    description: 'Suggested order quantity per distributor × reg-zsku, with norms, stock and the demand-gate flags',
    source: 'Postgres', s3: s3Daily('soq'),
    cols: [['DB ID', CODE], ['reg_zsku', RZ], ['SOQ_Case', INT], ['Max_Norm', INT], ['Norm_Qty_Cases', INT], ['DB_Stock_Cases', INT],
      ['In_Transit_Cases', INT], ['Date', DATE], ['is_below_threshold', FLAG], ['is_pdp', FLAG],
      ['is_combined_soq_greater_than_65_percentage', FLAG], ['CFA ID', PLANT], ['Brand', TXT]],
    rows: (date) => DEMAND.map((dm, i) => {
      const d = dbByCode.get(dm.db)!, z = rzByCode.get(dm.rz)!, x = LINE_X[i];
      return [dm.db, dm.rz, dm.soq, Math.ceil(dm.norm * 1.2), dm.norm, dm.dbStock, x.inTransit, isoSoq(date),
        yn(x.below), yn(pdpOf(d).today), 'Yes', CFA, z.brand];
    }) },
  { table: 'cfa_inventory', schema: 'ds_app', group: 'Transactional', domain: 'transaction', label: 'CFA Inventory',
    description: 'Batch-level sellable CFA stock in cases (FEFO source; only stock with >15 days to expiry)',
    source: 'Postgres', s3: s3Daily('cfa_inventory'),
    cols: [['Plant', PLANT], ['region', PLANT], ['zsku', CODE], ['reg_zsku', RZ], ['Material_no', MAT], ['Batch', 'varchar(10)'],
      ['Days_to_Expiry', INT], ['Date', DATE], ['Qty_in_Cases', INT]],
    rows: (date) => {
      const out: Cell[][] = [];
      REG_ZSKUS.forEach((z, zi) => {
        for (const [plant, total] of [[CFA, z.cfaStock], [ALT_CFA, ALT_STOCK[zi]]] as [string, number][]) {
          if (total <= 0) continue;
          const split = z.skus.length === 2 ? [Math.ceil(total * 0.7), total - Math.ceil(total * 0.7)] : [total];
          split.forEach((q, vi) => {
            if (q <= 0) return;
            const v = z.skus[vi];
            out.push([plant, REGION, z.zsku, z.rz, v.sku, v.batch, v.daysToExpiry, isoSoq(date), q]);
          });
        }
      });
      return out;
    } },
  { table: 'db_inventory', schema: 'ds_app', group: 'Transactional', domain: 'transaction', label: 'DB Inventory',
    description: 'Distributor closing stock per reg-zsku in cases (pieces → cases via the material case size)',
    source: 'Postgres', s3: s3Daily('db_inventory'),
    cols: [['DB ID', CODE], ['region', PLANT], ['zsku', CODE], ['reg_zsku', RZ], ['Date', DATE], ['Qty_in_Cases', INT], ['In_Transit_Cases', INT]],
    rows: (date) => DEMAND.map((dm, i) => [dm.db, REGION, rzByCode.get(dm.rz)!.zsku, dm.rz, isoSoq(date), dm.dbStock, LINE_X[i].inTransit]) },
  { table: 'daily_run_rate', schema: 'ds_app', group: 'Transactional', domain: 'transaction', label: 'Daily Run Rate',
    description: 'DRR per CFA × distributor × reg-zsku = last-3-month primary cases ÷ 90 (exact data date only)',
    source: 'Postgres', s3: s3Daily('daily_run_rate'),
    cols: [['Plant', PLANT], ['DB ID', CODE], ['reg_zsku', RZ], ['L3M_Primary_Cases', INT], ['DRR', NUM], ['Data_Date', DATE]],
    rows: (date) => DEMAND.map((dm, i) => [CFA, dm.db, dm.rz, LINE_X[i].l3m, LINE_X[i].drr, isoSoq(date)]) },
  { table: 'sub_channel_reservation', schema: 'ds_app', group: 'Transactional', domain: 'transaction', label: 'Sub-Channel Reservation',
    description: 'CFA stock reservation % per sub-channel, stored date-wise under each run date. Priority 1 = highest; runs execute in reverse priority',
    source: 'Postgres', s3: () => 's3://demo-landing/daily/sub_channel_reservation/latest/part-00000.parquet',
    cols: [['Run_Date', DATE], ['CFA', PLANT], ['Priority', SINT], ['Sub_Channel', 'varchar(20)'], ['Reservation_Pct', PCT],
      ['MRP_Bands', 'varchar(8)'], ['Cascade_Run', SINT], ['S3_Run_Date', DATE]],
    rows: () => [...RUN_DATES].reverse().flatMap((rd) => [...RUNS].sort((a, b) => b.run - a.run)
      .map((r, i): Cell[] => [isoRun(rd), CFA, i + 1, r.channel, r.pct, r.band, r.run, isoSoq(rd)])) },

  // ───────── Processed (the filtered SOQ the engine runs on) ─────────
  { table: 'filtered_soq', schema: 'ds_app', group: 'Processed', domain: 'processed', label: 'Filtered SOQ',
    description: 'The SOQ after the demand gate — (PDP or below-threshold) AND combined > 65%, clusters need ≥2 distributors',
    source: 'Postgres', s3: null,
    cols: [['Run_Date', DATE], ['CFA ID', PLANT], ['DB ID', CODE], ['Distributor_Name', TXT], ['Sub_Channel', 'varchar(20)'],
      ['Cascade_Run', SINT], ['DB_Tier', SINT], ['Cluster_Code', 'varchar(12)'], ['reg_zsku', RZ], ['SOQ_Case', INT],
      ['Norm_Qty_Cases', INT], ['Max_Norm', INT], ['DB_Stock_Cases', INT], ['Gate_Reason', TXT]],
    rows: (date) => DEMAND.map((dm) => {
      const d = dbByCode.get(dm.db)!;
      const reason = pdpOf(d).today ? 'PDP + combined > 65%' : 'below-threshold + combined > 65%';
      return [isoRun(date), CFA, d.code, d.name, d.channel, d.run, d.tier, d.cluster, dm.rz, dm.soq, dm.norm,
        Math.floor(dm.norm * 1.2), dm.dbStock, reason];
    }) },

  // ───────── Engine Output (hidden on the Data page; listed on the Data Model page) ─────────
  { table: 'or_output_reservation', schema: 'ds_app', group: 'Engine Output', domain: 'engine', label: 'Run Reservation',
    description: 'Per cascade run × reg-zsku: CFA stock, pool reserved for the run, pool left after it',
    source: 'Postgres', s3: null,
    cols: [['Run_Date', DATE], ['CFA', PLANT], ['Run', SINT], ['Sub_Channel', 'varchar(20)'], ['reg_zsku', RZ], ['CFA_Stock', INT],
      ['Reserved', INT], ['Leftover', INT]],
    rows: (date) => RUN_RESULTS.flatMap((rr) => REG_ZSKUS.map((z) => [isoRun(date), CFA, rr.run.run, rr.run.channel, z.rz,
      z.cfaStock, rr.reserved[z.rz] ?? 0, Math.max(0, rr.leftover[z.rz] ?? 0)])) },
  { table: 'or_output_allocation', schema: 'ds_app', group: 'Engine Output', domain: 'engine', label: 'Allocation',
    description: 'Per distributor × reg-zsku: Step-1 original, Step-2 substitute, Step-3 filler — planned and shipped',
    source: 'Postgres', s3: null,
    cols: [['Run_Date', DATE], ['CFA', PLANT], ['Run', SINT], ['DB ID', CODE], ['reg_zsku', RZ], ['SOQ', INT], ['Norm', INT],
      ['DB_Stock', INT], ['Original', INT], ['Substitute', INT], ['Filler', INT], ['Ship_Original', INT], ['Ship_Substitute', INT],
      ['Ship_Filler', INT], ['Shipped', INT]],
    rows: (date) => LANES.flatMap((l) => l.lines.map((x) => [isoRun(date), CFA, l.run, l.db.code, x.rz, x.soq, x.norm, x.dbStock,
      x.orig, x.sub, x.filler, x.shipOrig, x.shipSub, x.shipFil, x.shipOrig + x.shipSub + x.shipFil])) },
  { table: 'or_output_filler_sequence', schema: 'ds_app', group: 'Engine Output', domain: 'engine', label: 'Filler Sequence',
    description: 'Step-3 filler draw sequence per distributor — every candidate, its caps and the binding reason',
    source: 'Postgres', s3: null,
    cols: [['Run_Date', DATE], ['CFA', PLANT], ['DB ID', CODE], ['Draw_Rank', SINT], ['Seq', SINT], ['reg_zsku', RZ], ['Norm', INT],
      ['Max_Norm', INT], ['On_Hand', INT], ['Room', INT], ['Addon_Left', INT], ['Truck_Room', INT], ['Pool', INT], ['Alloc', INT], ['Reason', TXT]],
    rows: (date) => LANES.flatMap((l) => l.fillerCalc.map((f) => [isoRun(date), CFA, l.db.code, l.rank, f.rank, f.z, f.norm, f.max,
      f.onhand, f.room, f.addon, f.truck, f.pool, f.alloc, f.reason])) },
  { table: 'or_output_truck_trim', schema: 'ds_app', group: 'Engine Output', domain: 'engine', label: 'Truck Trim',
    description: 'What the truck rules cut — remainder-truck tails, dropped lanes and cluster primary trims',
    source: 'Postgres', s3: null,
    cols: [['Run_Date', DATE], ['CFA', PLANT], ['Run', SINT], ['DB ID', CODE], ['Reason', 'varchar(32)'], ['Cases', INT]],
    rows: (date) => LANES.flatMap((l) => {
      const out: Cell[][] = [];
      if (l.dropped) out.push([isoRun(date), CFA, l.run, l.db.code, 'LANE_DROP_BELOW_KEEP', l.dropOrig + l.dropSub + l.dropFil]);
      if (l.cascaded > 0) out.push([isoRun(date), CFA, l.run, l.db.code, 'TRUCK_TAIL_CASCADE', l.cascaded]);
      if (l.clusterTrim > 0) out.push([isoRun(date), CFA, l.run, l.db.code, 'CLUSTER_PRIMARY_TRIM', l.clusterTrim]);
      return out;
    }) },
  { table: 'or_output_cluster_primary', schema: 'ds_app', group: 'Engine Output', domain: 'engine', label: 'Cluster Primary',
    description: 'Transshipment clusters combined onto primary trucks — per distributor built / trimmed / shipped',
    source: 'Postgres', s3: null,
    cols: [['Run_Date', DATE], ['CFA', PLANT], ['Cluster_Code', 'varchar(12)'], ['DB ID', CODE], ['Built', INT], ['Trimmed', INT],
      ['Ships', INT], ['Primary_Cap', INT], ['Primary_Trucks', SINT]],
    rows: (date) => CLUSTERS.flatMap((c) => c.perDb.map((p) => [isoRun(date), CFA, c.code, p.db, p.built, p.trimmed, p.ships, c.primaryCap, c.primaryTrucks])) },
  { table: 'pipeline_run_meta', schema: 'ds_app', group: null, domain: 'engine', label: 'Pipeline Run Meta',
    description: 'One row per run — run date, SOQ date, CFAs, start / finish', source: 'Postgres', s3: null,
    cols: [['run_id', UUID], ['run_date', DATE], ['soq_date', DATE], ['cfas', 'text[]'], ['status', 'varchar(12)'], ['started_at', TS],
      ['finished_at', TS], ['triggered_by', 'varchar(32)']], rows: null },
  { table: 'oe_parameters', schema: 'ds_app', group: null, domain: 'engine', label: 'OE Parameters',
    description: 'The engine’s tunable thresholds (OE Parameters page)', source: 'Postgres', s3: null,
    cols: [['key', 'varchar(64)'], ['value', NUM], ['default_value', NUM], ['value_type', 'varchar(8)'], ['min_value', NUM],
      ['max_value', NUM], ['description', TXT], ['updated_at', TS], ['updated_by', 'varchar(32)']], rows: null },
  { table: 'app_users', schema: 'ds_app', group: null, domain: 'engine', label: 'App Users',
    description: 'Sign-in accounts and access flags (User Management page)', source: 'Postgres', s3: null,
    cols: [['id', 'serial'], ['username', 'varchar(32)'], ['password_hash', TXT], ['is_admin', BOOL], ['can_access_run', BOOL],
      ['created_at', TS], ['updated_at', TS]], rows: null },

  // orders
  { table: 'or_output_final_order', schema: 'ds_app', group: 'Engine Output', domain: 'orders', label: 'Final Order',
    description: 'The shipped order per CFA × distributor × reg-zsku, with its SO disposition',
    source: 'Postgres', s3: null,
    cols: [['Run_Date', DATE], ['CFA', PLANT], ['DB ID', CODE], ['reg_zsku', RZ], ['Original', INT], ['Substitute', INT], ['Filler', INT],
      ['Total_Cases', INT], ['Trucks', SINT], ['Truck_Fill_Pct', PCT], ['SO_Flag', 'varchar(24)']],
    rows: (date) => LANES.filter((l) => !l.dropped).flatMap((l) => l.lines
      .filter((x) => x.shipOrig + x.shipSub + x.shipFil > 0)
      .map((x) => [isoRun(date), CFA, l.db.code, x.rz, x.shipOrig, x.shipSub, x.shipFil, x.shipOrig + x.shipSub + x.shipFil,
        l.trucks, l.fillPct, l.soFlag])) },
  { table: 'or_output_truck_loads', schema: 'ds_app', group: 'Engine Output', domain: 'orders', label: 'Truck Loads',
    description: 'Physical trucks per lane — truck ID, order number, planned vs loaded cases',
    source: 'Postgres', s3: null,
    cols: [['Run_Date', DATE], ['CFA', PLANT], ['DB ID', CODE], ['Truck_No', SINT], ['Truck_ID', 'varchar(16)'], ['Order_ID', CODE],
      ['Capacity', INT], ['Planned_Cases', INT], ['Loaded_Cases', INT]],
    rows: (date) => LANES.flatMap((l) => l.loads.map((ld) => [isoRun(date), CFA, l.db.code, ld.no, ld.truckid, ld.order, l.db.truckCap, ld.planned, ld.cases])) },
  { table: 'order_line_items', schema: 'ds_app', group: 'Engine Output', domain: 'orders', label: 'Order Line Items',
    description: 'SKU-level lines on each truck (the S3 hand-off parquet)',
    source: 'Postgres', s3: (d) => `s3://demo-handoff/order_line_items/run_date=${isoRun(d)}/part-00000.parquet`,
    cols: [['Run_Date', DATE], ['Order_ID', CODE], ['Truck_ID', 'varchar(16)'], ['CFA', PLANT], ['DB ID', CODE], ['reg_zsku', RZ],
      ['Material_no', MAT], ['Batch', 'varchar(10)'], ['Cases', INT], ['Units', INT], ['MRP', NUM], ['Days_to_Expiry', INT],
      ['is_substitute', SINT], ['is_filler', SINT]],
    rows: (date) => LANES.flatMap((l) => l.loads.flatMap((ld) => ld.skus.map((s) => [isoRun(date), ld.order, ld.truckid, CFA, l.db.code,
      s.rz, s.sku, s.batch, s.cases, s.units, s.mrp, s.daysToExpiry, s.isSub, s.isFiller]))) },

  // rlm
  { table: 'rlm_truck_approval', schema: 'ds_app', group: 'Engine Output', domain: 'rlm', label: 'RLM Truck Approval',
    description: 'Lanes that could not fill a truck — held for RLM approval, with their planned lines',
    source: 'Postgres', s3: null,
    cols: [['Run_Date', DATE], ['CFA', PLANT], ['DB ID', CODE], ['reg_zsku', RZ], ['Planned_Original', INT], ['Planned_Substitute', INT],
      ['Planned_Filler', INT], ['Lane_Planned', INT], ['Truck_Cap', INT], ['Status', 'varchar(16)']],
    rows: (date) => LANES.filter((l) => l.soFlag === 'RLM_TRUCK_APPROVAL').flatMap((l) => l.lines
      .filter((x) => x.orig + x.sub + x.filler > 0)
      .map((x) => [isoRun(date), CFA, l.db.code, x.rz, x.orig, x.sub, x.filler, l.planned, l.db.truckCap, 'PENDING'])) },
  { table: 'rlm_second_cfa', schema: 'ds_app', group: 'Engine Output', domain: 'rlm', label: 'RLM Second CFA',
    description: 'Distributors whose original fill fell below the SO floor — shifted from the preferred to the alternate CFA',
    source: 'Postgres', s3: null,
    cols: [['Run_Date', DATE], ['Preferred_CFA', PLANT], ['Alternate_CFA', PLANT], ['DB ID', CODE], ['reg_zsku', RZ], ['SOQ', INT],
      ['Original', INT], ['Original_Fill_Pct', PCT], ['Status', 'varchar(16)']],
    rows: (date) => LANES.filter((l) => l.soFlag === 'RLM_FOR_SECOND_CFA').flatMap((l) => l.lines
      .filter((x) => x.soq > 0)
      .map((x) => [isoRun(date), CFA, ALT_CFA, l.db.code, x.rz, x.soq, x.orig, l.origFillPct, 'PENDING'])) },

  // SAP hand-off (schema de_sap) — Data Model page only
  { table: 'orders', schema: 'de_sap', group: null, domain: 'sap', label: 'SAP Orders',
    description: 'Sales-order lines handed to SAP (SO_CREATION lanes only)', source: 'Postgres', s3: null,
    cols: [['order_id', CODE], ['order_item', SINT], ['sales_org', PLANT], ['plant', PLANT], ['customer_code', CODE],
      ['material_no', MAT], ['batch', 'varchar(10)'], ['quantity_cases', INT], ['quantity_units', INT], ['truck_id', 'varchar(16)'],
      ['order_date', DATE], ['requested_delivery_date', DATE], ['created_at', TS]], rows: null },
  { table: 'order_status', schema: 'de_sap', group: null, domain: 'sap', label: 'SAP Order Status',
    description: 'SAP’s acknowledgement per order — SO number, status and message', source: 'Postgres', s3: null,
    cols: [['order_id', CODE], ['sap_so_number', 'varchar(12)'], ['status', 'varchar(16)'], ['message', TXT], ['payload', JSONB],
      ['received_at', TS], ['updated_at', TS]], rows: null },
];

const DATA_TABLES = TABLES.filter((t): t is TableDef & { group: Group; rows: (date: string) => Cell[][] } => !!t.group && !!t.rows);
const byName = new Map(DATA_TABLES.map((t) => [t.table, t]));
const rowCache = new Map<string, Cell[][]>();
function rowsOf(t: TableDef & { rows: (date: string) => Cell[][] }, date: string): Cell[][] {
  const k = `${t.table}@${runDate(date)}`;
  let rows = rowCache.get(k);
  if (!rows) { rows = t.rows(runDate(date)); rowCache.set(k, rows); }
  return rows;
}
function findTable(name: string) {
  const t = byName.get(name) ?? byName.get(name.replace(/^ds_app\./, ''));
  if (!t) throw new HttpError(404, `Table ${name} not found`);
  return t;
}
/** search across EVERY field: space-separated tokens, each must appear in some cell (case-insensitive) */
function search(rows: Cell[][], q: string): Cell[][] {
  const toks = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return rows;
  return rows.filter((r) => {
    const cells = r.map((c) => (c == null ? '' : String(c).toLowerCase()));
    return toks.every((t) => cells.some((c) => c.includes(t)));
  });
}
const intParam = (ctx: Ctx, k: string, dflt: number, lo: number, hi: number) => {
  const v = Number(ctx.query.get(k));
  return Number.isFinite(v) && ctx.query.get(k) !== null ? Math.min(hi, Math.max(lo, Math.floor(v))) : dflt;
};

// catalog: { groups, tables: [{ table, label, group, description, rows, columns, source, s3_path, updated_at, run_date }] }
get('/api/v1/tables', (ctx) => {
  requireUser(ctx);
  const date = runDate(ctx.date);
  return {
    groups: GROUPS.filter((g) => DATA_TABLES.some((t) => t.group === g)),
    tables: DATA_TABLES.map((t) => ({
      table: t.table, label: t.label, group: t.group, description: t.description, rows: rowsOf(t, date).length,
      columns: t.cols.length, source: t.source, s3_path: t.s3 ? t.s3(date) : null,
      updated_at: t.group === 'Masters' || t.group === 'Orphan Masters' ? LOADED_AT : RUN_TIMESTAMP[date] ?? null,
      run_date: t.group === 'Masters' || t.group === 'Orphan Masters' ? null : date,
    })),
  };
});

// one page: { table, label, group, description, columns, types, rows (array of arrays), total_rows, limit, offset, q, source, s3_path, sampled }
get('/api/v1/tables/:name', (ctx) => {
  requireUser(ctx);
  const t = findTable(ctx.params.name);
  const date = runDate(ctx.date);
  const q = (ctx.query.get('q') ?? '').trim();
  const limit = intParam(ctx, 'limit', 25, 1, 1000);
  const offset = intParam(ctx, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const hits = search(rowsOf(t, date), q);
  return {
    table: t.table, label: t.label, group: t.group, description: t.description,
    columns: t.cols.map((c) => c[0]), types: t.cols.map((c) => c[1]),
    rows: hits.slice(offset, offset + limit), total_rows: hits.length, unfiltered_rows: rowsOf(t, date).length,
    limit, offset, q, source: t.source, s3_path: t.s3 ? t.s3(date) : null, sampled: false,
  };
});

// whole table (every row matching q) as .xlsx
get('/api/v1/tables/:name/xlsx', (ctx) => {
  requireUser(ctx);
  const t = findTable(ctx.params.name);
  const hits = search(rowsOf(t, ctx.date), ctx.query.get('q') ?? '');
  return xlsxTable(`${t.table}.xlsx`, t.cols.map((c) => c[0]), hits, t.table.slice(0, 31));
});

// ═════════════════════════════════════════ Data Model (/schema_reference) ═════════════════════════════════════════
const DOMAINS: { domain: Domain; desc: string }[] = [
  { domain: 'masters', desc: 'Reference data re-loaded in full every run — distributors, materials, network, trucks, clusters, substitutes, fillers, tiers, PDP — plus the delivered masters the engine does not read.' },
  { domain: 'transaction', desc: 'Dated feeds staged for the data date — SOQ demand, CFA and distributor inventory, daily run rate, sub-channel reservation %.' },
  { domain: 'processed', desc: 'The SOQ after the demand gate — the only demand the engine runs on.' },
  { domain: 'engine', desc: 'Engine outputs per run (reservation, allocation, filler sequence, truck trims, cluster primary) and the app’s control tables.' },
  { domain: 'orders', desc: 'The shipped order — per reg-zsku, per truck and per SKU line (the S3 hand-off).' },
  { domain: 'rlm', desc: 'Lanes routed to RLM — truck-approval holds and second-CFA shifts.' },
  { domain: 'sap', desc: 'The SAP hand-off in schema de_sap — sales-order lines out, order status back.' },
];
get('/api/v1/schema_reference', (ctx) => {
  requireUser(ctx);
  const domains = DOMAINS.map((d) => ({
    domain: d.domain, desc: d.desc,
    tables: TABLES.filter((t) => t.domain === d.domain).map((t) => ({
      table: t.table, schema: t.schema, label: t.label, description: t.description,
      columns: t.cols.map(([column, type]) => ({ column, type })),
    })),
  })).filter((d) => d.tables.length);
  return {
    app_schema: 'ds_app', sap_schema: 'de_sap',
    total_tables: TABLES.length, total_columns: TABLES.reduce((s, t) => s + t.cols.length, 0),
    domains,
  };
});
