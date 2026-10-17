/**
 * FAA d-TPP chart proxy.
 *
 *   GET /api/charts/pdf?url=https://aeronav.faa.gov/d-tpp/2610/00669AD.PDF
 *
 * Why it exists: aeronav.faa.gov serves the PDFs with HTTP 200 but sends no
 * `Access-Control-Allow-Origin` header, so a browser page cannot fetch them
 * with fetch()/XHR (which pdf.js uses). This tiny same-origin-ish proxy fetches
 * them server-side and re-serves them with the dev CORS header.
 *
 * Safety: only URLs accepted by `isAllowedChartUrl` are fetched (anything else
 * is a 400), redirects are never followed (so the allow-list cannot be
 * bypassed by an upstream 30x), the body must start with `%PDF`, and size is
 * capped. Responses are cached in memory (LRU, 50 MB cap, 12 h TTL); a PDF is
 * identified by its URL, which contains the d-TPP cycle, so a new cycle is a new
 * cache key.
 *
 * Mount in server/index.ts:
 *   import { handleChartProxy } from './charts/chartProxy';
 *   if (path === '/api/charts/pdf') { await handleChartProxy(req, res); return; }
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAllowedChartUrl } from './chartUrl';

export { isAllowedChartUrl, CHART_URL_PATTERN } from './chartUrl';

export const DEV_ORIGIN = 'http://localhost:5173';
export const CACHE_MAX_BYTES = 50 * 1024 * 1024;
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 20_000;
export const USER_AGENT = 'kacy-atc-sim/0.1 (local single-player ATC simulator; non-commercial; cached chart proxy)';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ChartProxyOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
  corsOrigin?: string;
  maxCacheBytes?: number;
  ttlMs?: number;
  maxPdfBytes?: number;
  timeoutMs?: number;
}

export type ChartProxyErrorCode =
  | 'INVALID_CHART_URL'
  | 'CHART_NOT_FOUND'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_BAD_RESPONSE'
  | 'UPSTREAM_UNREACHABLE';

export class ChartProxyError extends Error {
  readonly code: ChartProxyErrorCode;
  readonly httpStatus: number;
  constructor(code: ChartProxyErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = 'ChartProxyError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

interface CacheEntry {
  body: Buffer;
  storedAt: number;
}

export interface ChartProxy {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Fetch (or serve from cache) the PDF bytes for an allow-listed URL. */
  getPdf(url: string): Promise<{ body: Buffer; cache: 'HIT' | 'MISS' }>;
  stats(): { entries: number; bytes: number; upstreamRequests: number };
  clear(): void;
}

export function createChartProxy(options: ChartProxyOptions = {}): ChartProxy {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const corsOrigin = options.corsOrigin ?? DEV_ORIGIN;
  const maxCacheBytes = options.maxCacheBytes ?? CACHE_MAX_BYTES;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const maxPdfBytes = options.maxPdfBytes ?? MAX_PDF_BYTES;
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;

  /** Map iteration order == recency order (re-insert on hit). */
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<Buffer>>();
  let cacheBytes = 0;
  let upstreamRequests = 0;

  function evict(url: string): void {
    const e = cache.get(url);
    if (e) {
      cacheBytes -= e.body.length;
      cache.delete(url);
    }
  }

  function store(url: string, body: Buffer): void {
    if (body.length > maxCacheBytes) return; // never cacheable
    evict(url);
    cache.set(url, { body, storedAt: now() });
    cacheBytes += body.length;
    while (cacheBytes > maxCacheBytes) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      evict(oldest.value);
    }
  }

  async function fetchUpstream(url: string): Promise<Buffer> {
    upstreamRequests += 1;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let upstream: Response;
      try {
        upstream = await fetchImpl(url, {
          signal: ctrl.signal,
          redirect: 'manual',
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf' },
        });
      } catch (err) {
        if (ctrl.signal.aborted) throw new ChartProxyError('UPSTREAM_TIMEOUT', 504, 'aeronav.faa.gov did not answer in time.');
        throw new ChartProxyError('UPSTREAM_UNREACHABLE', 502, `Could not reach aeronav.faa.gov (${err instanceof Error ? err.message : 'network error'}).`);
      }
      if (upstream.status === 404) throw new ChartProxyError('CHART_NOT_FOUND', 404, 'The FAA does not publish a chart at that URL (it may belong to an old cycle).');
      if (upstream.status !== 200) throw new ChartProxyError('UPSTREAM_ERROR', 502, `aeronav.faa.gov answered HTTP ${upstream.status}.`);
      const declared = Number(upstream.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxPdfBytes) {
        throw new ChartProxyError('UPSTREAM_BAD_RESPONSE', 502, 'Upstream PDF is larger than the proxy limit.');
      }
      let buf: Buffer;
      try {
        buf = Buffer.from(await upstream.arrayBuffer());
      } catch {
        throw new ChartProxyError(ctrl.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE', ctrl.signal.aborted ? 504 : 502, 'Download from aeronav.faa.gov was interrupted.');
      }
      if (buf.length > maxPdfBytes) throw new ChartProxyError('UPSTREAM_BAD_RESPONSE', 502, 'Upstream PDF is larger than the proxy limit.');
      if (buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new ChartProxyError('UPSTREAM_BAD_RESPONSE', 502, 'Upstream response was not a PDF.');
      }
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getPdf(url: string): Promise<{ body: Buffer; cache: 'HIT' | 'MISS' }> {
    if (!isAllowedChartUrl(url)) throw new ChartProxyError('INVALID_CHART_URL', 400, 'Only official aeronav.faa.gov d-TPP PDF URLs can be proxied.');
    const hit = cache.get(url);
    if (hit) {
      if (now() - hit.storedAt <= ttlMs) {
        cache.delete(url);
        cache.set(url, hit); // refresh recency
        return { body: hit.body, cache: 'HIT' };
      }
      evict(url);
    }
    let pending = inflight.get(url);
    if (!pending) {
      pending = fetchUpstream(url)
        .then((buf) => {
          store(url, buf);
          return buf;
        })
        .finally(() => inflight.delete(url));
      inflight.set(url, pending);
    }
    return { body: await pending, cache: 'MISS' };
  }

  function sendError(res: ServerResponse, status: number, code: string, message: string): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code, message } }));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      res.end();
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD, OPTIONS');
      return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET.');
    }
    const target = new URL(req.url ?? '/', 'http://localhost').searchParams.get('url');
    if (!isAllowedChartUrl(target)) {
      return sendError(res, 400, 'INVALID_CHART_URL', 'Only official aeronav.faa.gov d-TPP PDF URLs can be proxied.');
    }
    try {
      const { body, cache: state } = await getPdf(target);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(body.length));
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Cache', state);
      res.setHeader('X-Chart-Source', 'aeronav.faa.gov');
      res.end(method === 'HEAD' ? undefined : body);
    } catch (err) {
      if (err instanceof ChartProxyError) return sendError(res, err.httpStatus, err.code, err.message);
      console.error('[charts] unexpected error:', err);
      sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected chart proxy error.');
    }
  }

  return {
    handle,
    getPdf,
    stats: () => ({ entries: cache.size, bytes: cacheBytes, upstreamRequests }),
    clear: () => {
      cache.clear();
      cacheBytes = 0;
    },
  };
}

const defaultProxy = createChartProxy();

/** Mount point for server/index.ts. */
export function handleChartProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return defaultProxy.handle(req, res);
}
