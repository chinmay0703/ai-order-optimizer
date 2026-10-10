// router.ts — the demo backend's route table. Handlers register a METHOD + path pattern and return plain JSON
// (or an xlsxFile(...) marker for downloads). A LATER registration of the same method+pattern REPLACES an earlier one.
//
// Paths are matched WITHOUT the query string and WITHOUT the /api prefix's host, e.g. '/api/v1/dates',
// '/api/v1/rca/db/:dbid', '/api/production/run/start'. `:name` segments land in ctx.params.

export interface Ctx {
  method: string;
  path: string;                       // e.g. /api/v1/rca/db/0000710001
  params: Record<string, string>;     // :name captures
  query: URLSearchParams;
  body: unknown;                      // parsed JSON body (POST/PUT) or undefined
  date: string;                       // ?date= or the latest run date
  token: string;                      // bearer token (header or ?token=)
}
export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

/** Throw this from a handler to answer with an HTTP error + {detail} (the app shows `detail`). */
export class HttpError extends Error {
  constructor(public status: number, public detail: string) { super(detail); }
}

/** Return this from a handler (when ?format=xlsx or a /xlsx path) to answer with a real .xlsx download. */
export interface XlsxFile { __xlsx: true; filename: string; sheets: { name: string; rows: (string | number | null)[][] }[] }
export const xlsxFile = (filename: string, sheets: XlsxFile['sheets']): XlsxFile => ({ __xlsx: true, filename, sheets });
/** Convenience: one sheet from a header row + data rows. */
export const xlsxTable = (filename: string, header: string[], rows: (string | number | null)[][], sheet = 'Sheet1') =>
  xlsxFile(filename, [{ name: sheet, rows: [header, ...rows] }]);
/** Convenience: one sheet from an array of flat objects (keys of the first row become the header). */
export const xlsxObjects = (filename: string, objs: Record<string, unknown>[], sheet = 'Sheet1') => {
  const header = objs.length ? Object.keys(objs[0]) : [];
  return xlsxTable(filename, header, objs.map((o) => header.map((h) => {
    const v = o[h];
    return v == null ? null : typeof v === 'number' ? v : String(v);
  })), sheet);
};

interface Route { method: string; re: RegExp; keys: string[]; pattern: string; fn: Handler }
const routes: Route[] = [];

export function on(method: string, pattern: string, fn: Handler): void {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/\/+$/, '').replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  const m = method.toUpperCase();
  const i = routes.findIndex((r) => r.method === m && r.pattern === pattern);
  const route = { method: m, re, keys, pattern, fn };
  if (i >= 0) routes[i] = route; else routes.push(route);
}
export const get = (p: string, fn: Handler) => on('GET', p, fn);
export const post = (p: string, fn: Handler) => on('POST', p, fn);
export const put = (p: string, fn: Handler) => on('PUT', p, fn);
export const del = (p: string, fn: Handler) => on('DELETE', p, fn);

export function match(method: string, path: string): { fn: Handler; params: Record<string, string> } | null {
  const m = method.toUpperCase();
  for (const r of routes) {
    if (r.method !== m) continue;
    const hit = r.re.exec(path);
    if (!hit) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(hit[i + 1]); });
    return { fn: r.fn, params };
  }
  return null;
}

// ───────── streams (EventSource) ─────────
/** A stream handler pushes SSE messages via `send` until it calls `close` (or the page closes the EventSource).
 *  Return a cleanup fn. `event` defaults to 'message'. */
export type StreamHandler = (ctx: Ctx, send: (data: unknown, event?: string, id?: string) => void, close: () => void) => (() => void) | void;
const streams: { re: RegExp; pattern: string; fn: StreamHandler }[] = [];
export function stream(pattern: string, fn: StreamHandler): void {
  const re = new RegExp('^' + pattern.replace(/\/+$/, '') + '/?$');
  const i = streams.findIndex((s) => s.pattern === pattern);
  if (i >= 0) streams[i] = { re, pattern, fn }; else streams.push({ re, pattern, fn });
}
export const matchStream = (path: string) => streams.find((s) => s.re.test(path))?.fn ?? null;
