import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AwcError,
  buildAwcUrl,
  createAwcClient,
  fetchAwc,
  METAR_TTL_MS,
  parseIds,
  TAF_TTL_MS,
  UPSTREAM_TIMEOUT_MS,
  USER_AGENT,
} from './awc';

const KACY = { icaoId: 'KACY', rawOb: 'METAR KACY 170054Z 29017G23KT 10SM FEW018 BKN038 OVC049 21/17 A2983', fltCat: 'VFR' };
const KPHL = { icaoId: 'KPHL', rawOb: 'SPECI KPHL 170124Z 29006KT 10SM -RA FEW030 19/16 A2980', fltCat: 'VFR' };
const TAF_KACY = { icaoId: 'KACY', rawTAF: 'TAF KACY 170145Z 1702/1724 28012G18KT P6SM -SHRA BKN040' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Mock fetch that answers with the records whose icaoId appears in the requested ids. */
function stationFetch(db: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const ids = new URL(url).searchParams.get('ids')!.split(',');
    return json(ids.filter((i) => i in db).map((i) => db[i]));
  });
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('parseIds', () => {
  it('accepts valid ids and de-duplicates', () => {
    expect(parseIds('KACY')).toEqual(['KACY']);
    expect(parseIds('KACY,KPHL,KACY')).toEqual(['KACY', 'KPHL']);
    expect(parseIds('K1B1')).toEqual(['K1B1']);
  });
  it.each([undefined, null, '', 'kacy', 'KAC', 'KACY KPHL', 'KACY;rm', 'KACY&format=raw', 'K'.repeat(41), 'KACY%2CKPHL', '../etc', 'KACY\n'])('rejects %j', (v) => {
    expect(() => parseIds(v as string)).toThrow(AwcError);
    try { parseIds(v as string); } catch (e) { expect((e as AwcError).code).toBe('INVALID_IDS'); expect((e as AwcError).httpStatus).toBe(400); }
  });
  it('rejects more than 10 stations', () => {
    expect(() => parseIds(Array.from({ length: 11 }, (_, i) => `K00${String.fromCharCode(65 + i)}`).join(','))).toThrow(AwcError);
  });
});

describe('buildAwcUrl', () => {
  it('targets the AWC data API with JSON format', () => {
    expect(buildAwcUrl('metar', ['KACY'])).toBe('https://aviationweather.gov/api/data/metar?ids=KACY&format=json');
    expect(buildAwcUrl('taf', ['KACY', 'KPHL'])).toBe('https://aviationweather.gov/api/data/taf?ids=KACY,KPHL&format=json');
  });
});

describe('fetchAwc', () => {
  it('sends an identifying User-Agent and returns the JSON array', async () => {
    const f = vi.fn(async () => json([KACY]));
    const r = await fetchAwc('metar', ['KACY'], f);
    expect(r).toEqual([KACY]);
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; signal: AbortSignal }];
    expect(url).toContain('/api/data/metar?ids=KACY&format=json');
    expect(init.headers['User-Agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/kacy-atc-sim/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats 204 and empty bodies as an empty list', async () => {
    expect(await fetchAwc('metar', ['KACY'], async () => new Response(null, { status: 204 }))).toEqual([]);
    expect(await fetchAwc('metar', ['KACY'], async () => new Response('', { status: 200 }))).toEqual([]);
  });

  it('maps 429, 5xx, bad JSON, non-arrays and network failures to typed errors', async () => {
    const code = async (f: Parameters<typeof fetchAwc>[2]) => (await fetchAwc('metar', ['KACY'], f).catch((e) => e) as AwcError);
    expect((await code(async () => new Response('', { status: 429 }))).code).toBe('UPSTREAM_RATE_LIMITED');
    expect((await code(async () => new Response('', { status: 503 }))).code).toBe('UPSTREAM_ERROR');
    expect((await code(async () => new Response('<html>', { status: 200 }))).code).toBe('UPSTREAM_BAD_RESPONSE');
    expect((await code(async () => json({ a: 1 }))).code).toBe('UPSTREAM_BAD_RESPONSE');
    const net = await code(async () => { throw new TypeError('ECONNREFUSED'); });
    expect(net.code).toBe('UPSTREAM_UNREACHABLE');
    expect(net.httpStatus).toBe(502);
  });

  it('aborts after the 10 second upstream timeout', async () => {
    expect(UPSTREAM_TIMEOUT_MS).toBe(10_000);
    const hang = vi.fn((_u: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_r, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const p = fetchAwc('metar', ['KACY'], hang).catch((e) => e);
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const err = (await p) as AwcError;
    expect(err.code).toBe('UPSTREAM_TIMEOUT');
    expect(err.httpStatus).toBe(504);
  });
});

describe('createAwcClient caching', () => {
  it('serves the second request from cache within the 5 minute METAR TTL', async () => {
    const f = stationFetch({ KACY });
    const c = createAwcClient({ fetch: f });
    const a = await c.getMetar(['KACY']);
    expect(a.cache).toBe('MISS');
    expect(a.data).toEqual([KACY]);
    await vi.advanceTimersByTimeAsync(METAR_TTL_MS - 1000);
    const b = await c.getMetar(['KACY']);
    expect(b.cache).toBe('HIT');
    expect(b.data).toEqual([KACY]);
    expect(b.ageMs).toBe(METAR_TTL_MS - 1000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('refetches once the METAR TTL has passed', async () => {
    const f = stationFetch({ KACY });
    const c = createAwcClient({ fetch: f });
    await c.getMetar(['KACY']);
    await vi.advanceTimersByTimeAsync(METAR_TTL_MS);
    const r = await c.getMetar(['KACY']);
    expect(r.cache).toBe('MISS');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('TAF TTL is 30 minutes and independent of METAR', async () => {
    expect(TAF_TTL_MS).toBe(30 * 60 * 1000);
    const f = vi.fn(async (url: string) => json(url.includes('/taf') ? [TAF_KACY] : [KACY]));
    const c = createAwcClient({ fetch: f });
    await c.getTaf(['KACY']);
    await c.getMetar(['KACY']);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect((await c.getTaf(['KACY'])).cache).toBe('HIT');
    expect((await c.getMetar(['KACY'])).cache).toBe('MISS');
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect((await c.getTaf(['KACY'])).cache).toBe('MISS');
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('coalesces concurrent requests into ONE upstream call', async () => {
    let release!: (r: Response) => void;
    const f = vi.fn(() => new Promise<Response>((res) => { release = res; }));
    const c = createAwcClient({ fetch: f });
    const calls = Array.from({ length: 25 }, () => c.getMetar(['KACY']));
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    release(json([KACY]));
    const results = await Promise.all(calls);
    expect(f).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.data.length === 1)).toBe(true);
    expect(results.filter((r) => r.cache === 'MISS')).toHaveLength(1);
    expect(results.filter((r) => r.cache === 'COALESCED')).toHaveLength(24);
    // and afterwards it is a plain cache hit
    expect((await c.getMetar(['KACY'])).cache).toBe('HIT');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('multi-station requests only fetch stations that are not fresh or in flight', async () => {
    const f = stationFetch({ KACY, KPHL });
    const c = createAwcClient({ fetch: f });
    await c.getMetar(['KACY']);
    const r = await c.getMetar(['KACY', 'KPHL']);
    expect(f).toHaveBeenCalledTimes(2);
    expect(new URL(f.mock.calls[1][0] as string).searchParams.get('ids')).toBe('KPHL');
    expect(r.data).toEqual([KACY, KPHL]);
    expect(r.cache).toBe('MISS');
    expect((await c.getMetar(['KPHL', 'KACY'])).data).toEqual([KPHL, KACY]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('concurrent overlapping multi-station requests still fetch each station once', async () => {
    const f = stationFetch({ KACY, KPHL });
    const c = createAwcClient({ fetch: f });
    const [a, b] = await Promise.all([c.getMetar(['KACY']), c.getMetar(['KACY', 'KPHL'])]);
    expect(a.data).toEqual([KACY]);
    expect(b.data).toEqual([KACY, KPHL]);
    const fetchedIds = f.mock.calls.flatMap((call) => (new URL(call[0] as string).searchParams.get('ids') as string).split(','));
    expect(fetchedIds.sort()).toEqual(['KACY', 'KPHL']);
  });

  it('caches empty results so an unknown station does not hammer upstream', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    const c = createAwcClient({ fetch: f });
    expect((await c.getMetar(['KZZZ'])).data).toEqual([]);
    expect((await c.getMetar(['KZZZ'])).data).toEqual([]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('serves a stale copy when upstream fails after expiry', async () => {
    let fail = false;
    const f = vi.fn(async () => (fail ? new Response('', { status: 503 }) : json([KACY])));
    const c = createAwcClient({ fetch: f });
    await c.getMetar(['KACY']);
    await vi.advanceTimersByTimeAsync(METAR_TTL_MS + 1000);
    fail = true;
    const r = await c.getMetar(['KACY']);
    expect(r.cache).toBe('STALE');
    expect(r.data).toEqual([KACY]);
    expect(r.ageMs).toBeGreaterThan(METAR_TTL_MS);
  });

  it('does not serve data older than staleMaxMs', async () => {
    let fail = false;
    const f = vi.fn(async () => (fail ? new Response('', { status: 500 }) : json([KACY])));
    const c = createAwcClient({ fetch: f, staleMaxMs: 10 * 60 * 1000 });
    await c.getMetar(['KACY']);
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    fail = true;
    await expect(c.getMetar(['KACY'])).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('propagates errors when there is nothing cached, to every concurrent caller, and backs off', async () => {
    const f = vi.fn(async () => new Response('', { status: 500 }));
    const c = createAwcClient({ fetch: f });
    const results = await Promise.allSettled([c.getMetar(['KACY']), c.getMetar(['KACY']), c.getMetar(['KACY'])]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    // within the error backoff: fail fast without calling upstream
    await expect(c.getMetar(['KACY'])).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(f).toHaveBeenCalledTimes(1);
    // after the backoff: try again
    await vi.advanceTimersByTimeAsync(16_000);
    await expect(c.getMetar(['KACY'])).rejects.toBeInstanceOf(AwcError);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('recovers after an error once upstream works again', async () => {
    let fail = true;
    const f = vi.fn(async () => (fail ? new Response('', { status: 502 }) : json([KACY])));
    const c = createAwcClient({ fetch: f });
    await c.getMetar(['KACY']).catch(() => undefined);
    fail = false;
    await vi.advanceTimersByTimeAsync(16_000);
    expect((await c.getMetar(['KACY'])).data).toEqual([KACY]);
  });

  it('times out hung upstream calls through the client (10 s) and frees the in-flight slot', async () => {
    const hang = vi.fn((_u: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_r, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const c = createAwcClient({ fetch: hang });
    const p = c.getMetar(['KACY']).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(((await p) as AwcError).code).toBe('UPSTREAM_TIMEOUT');
    await vi.advanceTimersByTimeAsync(16_000);
    const ok = vi.fn(async () => json([KACY]));
    const c2 = createAwcClient({ fetch: ok });
    expect((await c2.getMetar(['KACY'])).data).toEqual([KACY]);
  });

  it('stats and clear', async () => {
    const f = stationFetch({ KACY });
    const c = createAwcClient({ fetch: f });
    await c.getMetar(['KACY']);
    expect(c.stats()).toEqual({ upstreamRequests: 1, cachedStations: 1 });
    c.clear();
    await c.getMetar(['KACY']);
    expect(c.stats().upstreamRequests).toBe(2);
  });
});
