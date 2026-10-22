/**
 * Aviation Weather Center (aviationweather.gov) client + cache.
 *
 * Pure functions / small factory with injectable `fetch` and clock so the
 * behaviour (TTL, request coalescing, timeout, stale-on-error) is unit
 * testable with a mocked fetch and fake timers.
 *
 * Guarantees
 *  - At most ONE upstream request per station per TTL, even under concurrent
 *    callers (in-flight requests are shared).
 *  - Multi-station requests only fetch the stations that are not already
 *    fresh or in flight, in a single upstream call.
 *  - 10 s upstream timeout, identifying User-Agent, validated ids.
 *  - If upstream fails and a stale copy (< `staleMaxMs`) exists, the stale copy
 *    is served and flagged. Failures are remembered for `errorBackoffMs` so a
 *    flapping upstream is not hammered.
 */

export const AWC_BASE_URL = 'https://aviationweather.gov/api/data';
export const METAR_TTL_MS = 5 * 60 * 1000;
export const TAF_TTL_MS = 30 * 60 * 1000;
export const UPSTREAM_TIMEOUT_MS = 10_000;
export const USER_AGENT = 'kacy-atc-sim/0.1 (local single-player ATC simulator; non-commercial; low-volume cached proxy)';
export const ID_PATTERN = /^[A-Z0-9,]{4,40}$/;

export type AwcProduct = 'metar' | 'taf';

export type AwcErrorCode =
  | 'INVALID_IDS'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_BAD_RESPONSE'
  | 'UPSTREAM_UNREACHABLE';

const STATUS_FOR_CODE: Record<AwcErrorCode, number> = {
  INVALID_IDS: 400,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  UPSTREAM_BAD_RESPONSE: 502,
  UPSTREAM_UNREACHABLE: 502,
};

export class AwcError extends Error {
  code: AwcErrorCode;
  httpStatus: number;
  constructor(code: AwcErrorCode, message: string) {
    super(message);
    this.name = 'AwcError';
    this.code = code;
    this.httpStatus = STATUS_FOR_CODE[code];
  }
}

/** Validate and split `ids`. Throws AwcError('INVALID_IDS'). Returns de-duplicated stations. */
export function parseIds(raw: string | null | undefined): string[] {
  if (!raw || !ID_PATTERN.test(raw)) {
    throw new AwcError('INVALID_IDS', 'ids must match ^[A-Z0-9,]{4,40}$ (comma-separated ICAO ids, upper case).');
  }
  const ids = [...new Set(raw.split(',').filter(Boolean))];
  if (ids.length === 0 || ids.some((id) => id.length < 3 || id.length > 5)) {
    throw new AwcError('INVALID_IDS', 'Each station id must be 3-5 characters.');
  }
  if (ids.length > 10) throw new AwcError('INVALID_IDS', 'At most 10 stations per request.');
  return ids;
}

export function buildAwcUrl(product: AwcProduct, ids: readonly string[]): string {
  return `${AWC_BASE_URL}/${product}?ids=${ids.join(',')}&format=json`;
}

type FetchFn = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

/** One upstream call with timeout. Returns the parsed JSON array ([] for 204). */
export async function fetchAwc(
  product: AwcProduct,
  ids: readonly string[],
  fetchImpl: FetchFn = fetch as unknown as FetchFn,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<unknown[]> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(buildAwcUrl(product, ids), {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
    } catch (err) {
      if (timedOut) throw new AwcError('UPSTREAM_TIMEOUT', `aviationweather.gov did not respond within ${timeoutMs / 1000} s.`);
      throw new AwcError('UPSTREAM_UNREACHABLE', `Could not reach aviationweather.gov: ${(err as Error)?.message ?? 'network error'}`);
    }
    if (res.status === 204) return [];
    if (res.status === 429) throw new AwcError('UPSTREAM_RATE_LIMITED', 'aviationweather.gov rate limit hit (max 100 requests/minute). Try again shortly.');
    if (!res.ok) throw new AwcError('UPSTREAM_ERROR', `aviationweather.gov returned HTTP ${res.status}.`);
    let body: unknown;
    try {
      const text = await res.text();
      body = text.trim() === '' ? [] : JSON.parse(text);
    } catch {
      if (timedOut) throw new AwcError('UPSTREAM_TIMEOUT', `aviationweather.gov did not respond within ${timeoutMs / 1000} s.`);
      throw new AwcError('UPSTREAM_BAD_RESPONSE', 'aviationweather.gov returned a body that is not valid JSON.');
    }
    if (!Array.isArray(body)) throw new AwcError('UPSTREAM_BAD_RESPONSE', 'aviationweather.gov returned JSON that is not an array.');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export interface AwcClientOptions {
  fetch?: FetchFn;
  now?: () => number;
  metarTtlMs?: number;
  tafTtlMs?: number;
  timeoutMs?: number;
  /** Max age at which a stale entry may be served when upstream fails. Default 2 h. */
  staleMaxMs?: number;
  /** After a failed upstream call, fail fast for this long (unless stale data exists). Default 15 s. */
  errorBackoffMs?: number;
}

export interface AwcResult {
  data: unknown[];
  /** HIT: all stations from fresh cache; MISS: at least one upstream call made; COALESCED: joined an in-flight call; STALE: upstream failed, stale copy served. */
  cache: 'HIT' | 'MISS' | 'COALESCED' | 'STALE';
  ageMs: number;
}

interface Entry { data: unknown[]; storedAt: number }
interface ErrEntry { error: AwcError; at: number }

export interface AwcClient {
  get(product: AwcProduct, ids: readonly string[]): Promise<AwcResult>;
  getMetar(ids: readonly string[]): Promise<AwcResult>;
  getTaf(ids: readonly string[]): Promise<AwcResult>;
  clear(): void;
  stats(): { upstreamRequests: number; cachedStations: number };
}

export function createAwcClient(options: AwcClientOptions = {}): AwcClient {
  const fetchImpl = options.fetch ?? (fetch as unknown as FetchFn);
  const now = options.now ?? (() => Date.now());
  const ttl: Record<AwcProduct, number> = { metar: options.metarTtlMs ?? METAR_TTL_MS, taf: options.tafTtlMs ?? TAF_TTL_MS };
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const staleMaxMs = options.staleMaxMs ?? 2 * 60 * 60 * 1000;
  const errorBackoffMs = options.errorBackoffMs ?? 15_000;

  const cache = new Map<string, Entry>();
  const errors = new Map<string, ErrEntry>();
  const inflight = new Map<string, Promise<unknown[]>>();
  let upstreamRequests = 0;

  const key = (product: AwcProduct, id: string) => `${product}:${id}`;

  async function get(product: AwcProduct, ids: readonly string[]): Promise<AwcResult> {
    const t = now();
    const results = new Map<string, unknown[]>();
    const waits: Promise<void>[] = [];
    const toFetch: string[] = [];
    let stale = false;
    let coalesced = false;
    let oldest = 0;
    let backoffError: AwcError | undefined;

    /** Await a per-station promise, falling back to a stale copy if it rejects. */
    const attach = (id: string, promise: Promise<unknown[]>) => {
      const k = key(product, id);
      waits.push(
        promise.then(
          (d) => { results.set(id, d); },
          (e: unknown) => {
            const entry = cache.get(k);
            if (entry && now() - entry.storedAt < staleMaxMs) {
              stale = true;
              results.set(id, entry.data);
              oldest = Math.max(oldest, now() - entry.storedAt);
              return;
            }
            throw e;
          },
        ),
      );
    };

    for (const id of ids) {
      const k = key(product, id);
      const entry = cache.get(k);
      if (entry && t - entry.storedAt < ttl[product]) {
        results.set(id, entry.data);
        oldest = Math.max(oldest, t - entry.storedAt);
        continue;
      }
      const running = inflight.get(k);
      if (running) {
        coalesced = true;
        attach(id, running);
        continue;
      }
      const err = errors.get(k);
      if (err && t - err.at < errorBackoffMs) {
        if (entry && t - entry.storedAt < staleMaxMs) {
          stale = true;
          results.set(id, entry.data);
          oldest = Math.max(oldest, t - entry.storedAt);
        } else {
          backoffError = err.error;
        }
        continue;
      }
      toFetch.push(id);
    }

    const missed = toFetch.length > 0;
    if (missed) {
      upstreamRequests += 1;
      const batch = fetchAwc(product, toFetch, fetchImpl, timeoutMs).then((records) => {
        const stored = now();
        const byStation = new Map<string, unknown[]>(toFetch.map((id) => [id, []]));
        for (const rec of records) {
          const sid = (rec as { icaoId?: string })?.icaoId;
          if (typeof sid === 'string' && byStation.has(sid)) byStation.get(sid)!.push(rec);
        }
        for (const [id, data] of byStation) {
          cache.set(key(product, id), { data, storedAt: stored });
          errors.delete(key(product, id));
        }
        return byStation;
      });
      batch.catch((e: unknown) => {
        for (const id of toFetch) errors.set(key(product, id), { error: e as AwcError, at: now() });
      });
      for (const id of toFetch) {
        const k = key(product, id);
        const perStation = batch.then((m) => m.get(id) ?? []);
        inflight.set(k, perStation);
        const cleanup = () => { if (inflight.get(k) === perStation) inflight.delete(k); };
        perStation.then(cleanup, cleanup);
        attach(id, perStation);
      }
    }

    if (backoffError) {
      await Promise.allSettled(waits);
      throw backoffError;
    }
    await Promise.all(waits);
    const data = ids.flatMap((id) => results.get(id) ?? []);
    return {
      data,
      cache: stale ? 'STALE' : missed ? 'MISS' : coalesced ? 'COALESCED' : 'HIT',
      ageMs: missed && !stale ? 0 : oldest,
    };
  }

  return {
    get,
    getMetar: (ids) => get('metar', ids),
    getTaf: (ids) => get('taf', ids),
    clear: () => { cache.clear(); errors.clear(); },
    stats: () => ({ upstreamRequests, cachedStations: cache.size }),
  };
}
