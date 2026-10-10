// core.ts — auth, users, run dates, CFA list, served lookups (names / descriptions / categories), OE parameters, version.
import { get, post, put, del, HttpError, type Ctx } from '../router';
import {
  RUN_DATES, LATEST_DATE, SOQ_DATE, CFA, PLANTS, DISTRIBUTORS, REG_ZSKUS, OE_PARAM_DEFS,
} from '../dataset';

// ───────── users (persisted in this browser so admin edits survive a refresh) ─────────
export interface DemoUser { id: number; username: string; password: string; is_admin: boolean; can_access_run: boolean; created_at: string }
const USERS_KEY = 'aiden.demo.users';
const SEED_USERS: DemoUser[] = [
  { id: 1, username: 'admin', password: 'admin', is_admin: true, can_access_run: true, created_at: '2026-09-01T09:00:00+05:30' },
  { id: 2, username: 'planner', password: 'planner', is_admin: false, can_access_run: true, created_at: '2026-09-12T10:15:00+05:30' },
  { id: 3, username: 'viewer', password: 'viewer', is_admin: false, can_access_run: false, created_at: '2026-09-20T16:40:00+05:30' },
];
export function loadUsers(): DemoUser[] {
  try {
    const u = JSON.parse(localStorage.getItem(USERS_KEY) || 'null') as DemoUser[] | null;
    if (Array.isArray(u) && u.some((x) => x.username === 'admin')) return u;
  } catch { /* fall through to the seed */ }
  return SEED_USERS.map((u) => ({ ...u }));
}
export function saveUsers(us: DemoUser[]): void {
  try { localStorage.setItem(USERS_KEY, JSON.stringify(us)); } catch { /* private mode — keep in memory only */ }
}
export const publicUser = (u: DemoUser) => ({ id: u.id, username: u.username, is_admin: u.is_admin, can_access_run: u.can_access_run, created_at: u.created_at });
const tokenFor = (u: DemoUser) => `demo.${u.id}.${btoa(u.username)}`;
/** The signed-in user for this request, or 401. */
export function requireUser(ctx: Ctx): DemoUser {
  const m = /^demo\.(\d+)\./.exec(ctx.token);
  const u = m ? loadUsers().find((x) => x.id === Number(m[1])) : undefined;
  if (!u) throw new HttpError(401, 'Not authenticated');
  return u;
}
export function requireAdmin(ctx: Ctx): DemoUser {
  const u = requireUser(ctx);
  if (!u.is_admin) throw new HttpError(403, 'Admin access required');
  return u;
}

post('/api/v1/auth/login', (ctx) => {
  const b = (ctx.body ?? {}) as { username?: string; password?: string };
  const u = loadUsers().find((x) => x.username === String(b.username ?? '').trim());
  if (!u || u.password !== b.password) throw new HttpError(401, 'Incorrect username or password');
  return { access_token: tokenFor(u), token_type: 'bearer', user: publicUser(u) };
});
get('/api/v1/auth/me', (ctx) => publicUser(requireUser(ctx)));
put('/api/v1/auth/me', (ctx) => {
  const me = requireUser(ctx);
  const b = (ctx.body ?? {}) as { username?: string; password?: string; current_password?: string };
  const us = loadUsers();
  const u = us.find((x) => x.id === me.id)!;
  if (b.username && b.username !== u.username) {
    if (us.some((x) => x.username === b.username)) throw new HttpError(400, 'Username already taken');
    u.username = b.username;
  }
  if (b.password) u.password = b.password;
  saveUsers(us);
  return { ...publicUser(u), access_token: tokenFor(u), user: publicUser(u) };
});
get('/api/v1/auth/users', (ctx) => { requireAdmin(ctx); return { users: loadUsers().map(publicUser) }; });
post('/api/v1/auth/users', (ctx) => {
  requireAdmin(ctx);
  const b = (ctx.body ?? {}) as Partial<DemoUser>;
  const us = loadUsers();
  if (!b.username || !b.password) throw new HttpError(400, 'Username and password are required');
  if (us.some((x) => x.username === b.username)) throw new HttpError(400, 'Username already exists');
  const u: DemoUser = { id: Math.max(0, ...us.map((x) => x.id)) + 1, username: b.username, password: b.password,
    is_admin: !!b.is_admin, can_access_run: !!b.can_access_run, created_at: new Date().toISOString() };
  us.push(u); saveUsers(us);
  return publicUser(u);
});
put('/api/v1/auth/users/:id', (ctx) => {
  requireAdmin(ctx);
  const us = loadUsers();
  const u = us.find((x) => x.id === Number(ctx.params.id));
  if (!u) throw new HttpError(404, 'User not found');
  const b = (ctx.body ?? {}) as Partial<DemoUser>;
  if (b.username !== undefined && b.username !== u.username) {
    if (us.some((x) => x.username === b.username)) throw new HttpError(400, 'Username already exists');
    u.username = b.username;
  }
  if (b.password) u.password = b.password;
  if (b.is_admin !== undefined) u.is_admin = !!b.is_admin;
  if (b.can_access_run !== undefined) u.can_access_run = !!b.can_access_run;
  if (u.username === 'admin') { u.is_admin = true; }
  saveUsers(us);
  return publicUser(u);
});
del('/api/v1/auth/users/:id', (ctx) => {
  const me = requireAdmin(ctx);
  const id = Number(ctx.params.id);
  if (id === me.id) throw new HttpError(400, 'You cannot delete your own account');
  const us = loadUsers();
  if (us.find((x) => x.id === id)?.username === 'admin') throw new HttpError(400, 'The admin account cannot be deleted');
  saveUsers(us.filter((x) => x.id !== id));
  return { ok: true, deleted: id };
});

// ───────── app shell ─────────
get('/api/v1/health', () => ({ status: 'ok', db: 'ok', mode: 'demo' }));
get('/api/v1/version', () => ({ version: '1.0.0', branch: 'main', build: 'demo', commit: 'demo', built_at: '2026-10-10T09:00:00+05:30', env: 'demo' }));
get('/api/v1/app_config', () => ({ run_disabled: false, demo: true }));
get('/api/v1/dates', () => ({ dates: RUN_DATES, latest: LATEST_DATE, data_date: SOQ_DATE }));
get('/api/v1/cfa/list', () => ({ cfas: [CFA] }));
get('/api/v1/plants', () => ({ plants: PLANTS }));

// ───────── served lookups ─────────
get('/api/v1/distributor_names', () => ({ names: Object.fromEntries(DISTRIBUTORS.map((d) => [d.code, d.name])) }));
get('/api/v1/reg_zsku_descriptions', () => ({ descriptions: Object.fromEntries(REG_ZSKUS.map((z) => [z.rz, z.desc])) }));
get('/api/v1/reg_zsku_aiden_categories', () => ({ aiden_categories: Object.fromEntries(REG_ZSKUS.map((z) => [z.rz, z.category])) }));

// ───────── OE parameters (editable; persisted in this browser) ─────────
const PARAMS_KEY = 'aiden.demo.oe_params';
export function loadParams(): Record<string, number> {
  const base = Object.fromEntries(OE_PARAM_DEFS.map((p) => [p.key, p.default]));
  try { return { ...base, ...(JSON.parse(localStorage.getItem(PARAMS_KEY) || '{}') as Record<string, number>) }; } catch { return base; }
}
const paramsPayload = () => {
  const cur = loadParams();
  return { parameters: OE_PARAM_DEFS.map((p) => ({ key: p.key, value: cur[p.key], default: p.default, description: p.description,
    updated_at: cur[p.key] !== p.default ? new Date().toISOString() : null, updated_by: cur[p.key] !== p.default ? 'admin' : null })) };
};
get('/api/v1/oe_parameters', () => paramsPayload());
put('/api/v1/oe_parameters', (ctx) => {
  requireUser(ctx);
  const upd = ((ctx.body ?? {}) as { updates?: Record<string, number> }).updates ?? {};
  const cur = loadParams();
  for (const [k, v] of Object.entries(upd)) {
    if (!(k in cur)) throw new HttpError(400, `Unknown parameter ${k}`);
    if (typeof v !== 'number' || !isFinite(v) || v < 0) throw new HttpError(400, `${k} must be a non-negative number`);
    cur[k] = v;
  }
  try { localStorage.setItem(PARAMS_KEY, JSON.stringify(cur)); } catch { /* ignore */ }
  return paramsPayload();
});
post('/api/v1/oe_parameters/reset', (ctx) => {
  requireUser(ctx);
  try { localStorage.removeItem(PARAMS_KEY); } catch { /* ignore */ }
  return paramsPayload();
});
