// install.ts — turns the browser into the demo backend. Every request the app makes to /api/* is answered in-page
// from the synthetic dataset, so the UI runs with NO server: fetch() is wrapped, EventSource is replaced for the live
// run-progress stream, and <a href="/api/...xlsx"> download links are built client-side with the xlsx library.
// Nothing in the pages changes — they still call api.ts exactly as against the real FastAPI backend.
import { match, matchStream, HttpError, type Ctx, type XlsxFile } from './router';
import { LATEST_DATE } from './dataset';
import './handlers';   // registers every route

const LATENCY_MS = 140;   // a little network-ish delay so loading states read naturally
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toUrl(input: RequestInfo | URL): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(raw, window.location.href);
}
const isApi = (u: URL) => u.origin === window.location.origin && /^\/api\//.test(u.pathname);

function ctxFor(method: string, u: URL, body: unknown, headers?: HeadersInit): Ctx {
  const h = new Headers(headers);
  const bearer = (h.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return {
    method: method.toUpperCase(), path: u.pathname.replace(/\/+$/, ''), params: {}, query: u.searchParams, body,
    date: u.searchParams.get('date') || LATEST_DATE, token: bearer || u.searchParams.get('token') || '',
  };
}

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function xlsxBlob(f: XlsxFile): Promise<Blob> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const s of f.sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name.slice(0, 31));
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const isXlsx = (v: unknown): v is XlsxFile => !!v && typeof v === 'object' && (v as XlsxFile).__xlsx === true;

/** Answer one demo request → a real Response (JSON, or an .xlsx attachment). */
export async function dispatch(method: string, u: URL, body: unknown, headers?: HeadersInit): Promise<Response> {
  const ctx = ctxFor(method, u, body, headers);
  const hit = match(ctx.method, ctx.path);
  await sleep(LATENCY_MS);
  if (!hit) {
    console.warn('[demo] no mock for', ctx.method, ctx.path + u.search);
    return json(404, { detail: `Demo mode: no data for ${ctx.method} ${ctx.path}` });
  }
  ctx.params = hit.params;
  try {
    const out = await hit.fn(ctx);
    if (isXlsx(out)) {
      return new Response(await xlsxBlob(out), { status: 200, headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${out.filename}"`,
      } });
    }
    return json(200, out);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { detail: e.detail });
    console.error('[demo] handler crashed for', ctx.method, ctx.path, e);
    return json(500, { detail: `Demo handler error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSED = 2;
  readyState = 0;
  readonly url: string;
  readonly withCredentials = false;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private cleanup: (() => void) | void = undefined;
  constructor(url: string | URL) {
    super();
    const u = toUrl(url);
    this.url = u.href;
    const fn = matchStream(u.pathname.replace(/\/+$/, ''));
    setTimeout(() => {
      if (this.readyState === 2) return;
      if (!fn) { this.readyState = 2; const ev = new Event('error'); this.onerror?.(ev); this.dispatchEvent(ev); return; }
      this.readyState = 1;
      const open = new Event('open'); this.onopen?.(open); this.dispatchEvent(open);
      const send = (data: unknown, event = 'message', id?: string) => {
        if (this.readyState !== 1) return;
        const ev = new MessageEvent(event, { data: typeof data === 'string' ? data : JSON.stringify(data), lastEventId: id ?? '' });
        if (event === 'message') this.onmessage?.(ev);
        this.dispatchEvent(ev);
      };
      const close = () => { this.close(); };
      this.cleanup = fn(ctxFor('GET', u, undefined), send, close);
    }, LATENCY_MS);
  }
  close() {
    if (this.readyState === 2) return;
    this.readyState = 2;
    if (typeof this.cleanup === 'function') this.cleanup();
  }
}

let installed = false;
export function installMock(): void {
  if (installed) return;
  installed = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = toUrl(input);
    if (!isApi(u)) return realFetch(input, init);
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    let body: unknown;
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    return dispatch(method, u, body, init?.headers);
  };
  (window as unknown as { EventSource: unknown }).EventSource = DemoEventSource;
  // download links (<a href="/api/...?format=xlsx">) can't be served by a fetch shim — build the file and save it
  document.addEventListener('click', async (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    const u = toUrl(a.href);
    if (!isApi(u)) return;
    e.preventDefault();
    const res = await dispatch('GET', u, undefined);
    if (!res.ok) { const j = await res.json().catch(() => ({})); alert((j as { detail?: string }).detail || `Download failed (${res.status})`); return; }
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1]
      || a.getAttribute('download') || 'export.xlsx';
    const href = URL.createObjectURL(blob);
    const tmp = Object.assign(document.createElement('a'), { href, download: name });
    document.body.appendChild(tmp); tmp.click(); tmp.remove();
    setTimeout(() => URL.revokeObjectURL(href), 4000);
  }, true);
  console.info('[demo] sample-data mode — every /api call is answered in the browser (no backend)');
}
