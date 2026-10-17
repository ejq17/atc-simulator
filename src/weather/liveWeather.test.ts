import { describe, expect, it, vi } from 'vitest';
import { fetchLiveMetar, LiveWeatherError } from './liveWeather';

const KACY_JSON = [{
  icaoId: 'KACY', obsTime: 1792198440, reportTime: '2026-10-17T01:00:00.000Z',
  rawOb: 'METAR KACY 170054Z 29017G23KT 10SM FEW018 BKN038 OVC049 21/17 A2983 RMK AO2 RAB38E49 PRESRR SLP100 P0000 T02060172',
  fltCat: 'VFR',
}];

const respond = (body: unknown, init: ResponseInit = { status: 200 }) =>
  vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), init)) as unknown as typeof fetch;

describe('fetchLiveMetar', () => {
  it('calls the local backend, not aviationweather.gov, and parses rawOb', async () => {
    const f = respond(KACY_JSON);
    const r = await fetchLiveMetar('KACY', { baseUrl: 'http://localhost:8787', fetchImpl: f });
    const url = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toBe('http://localhost:8787/api/weather/metar?ids=KACY');
    expect(url).not.toContain('aviationweather.gov');
    expect(r.raw).toBe(KACY_JSON[0].rawOb);
    expect(r.observedAt).toBe('2026-10-17T00:54:00.000Z');
    expect(r.weather.source).toBe('live');
    expect(r.weather.observedAt).toBe(r.observedAt);
    expect(r.weather.windDirDeg).toBe(290);
    expect(r.weather.windGustKt).toBe(23);
    expect(r.weather.flightCategory).toBe('VFR');
  });

  it('uppercases the id', async () => {
    const f = respond(KACY_JSON);
    await fetchLiveMetar('kacy', { baseUrl: 'http://x:1', fetchImpl: f });
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://x:1/api/weather/metar?ids=KACY');
  });

  it('BACKEND_UNREACHABLE with a message telling the user to run the backend', async () => {
    const f = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const err = await fetchLiveMetar('KACY', { fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(LiveWeatherError);
    expect(err.code).toBe('BACKEND_UNREACHABLE');
    expect(err.message).toContain('npm run server');
  });

  it('BACKEND_ERROR carries status and backend message', async () => {
    const f = respond({ error: { code: 'UPSTREAM_TIMEOUT', message: 'slow' } }, { status: 504 });
    const err = await fetchLiveMetar('KACY', { fetchImpl: f }).catch((e) => e);
    expect(err.code).toBe('BACKEND_ERROR');
    expect(err.status).toBe(504);
    expect(err.message).toContain('slow');
  });

  it('NO_DATA for an empty array', async () => {
    const err = await fetchLiveMetar('KACY', { fetchImpl: respond([]) }).catch((e) => e);
    expect(err.code).toBe('NO_DATA');
  });

  it('BAD_RESPONSE for non-JSON and wrong shapes', async () => {
    expect((await fetchLiveMetar('KACY', { fetchImpl: respond('<html>') }).catch((e) => e)).code).toBe('BAD_RESPONSE');
    expect((await fetchLiveMetar('KACY', { fetchImpl: respond({ a: 1 }) }).catch((e) => e)).code).toBe('BAD_RESPONSE');
  });

  it('TIMEOUT when the backend hangs', async () => {
    const f = vi.fn((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const err = await fetchLiveMetar('KACY', { fetchImpl: f, timeoutMs: 20 }).catch((e) => e);
    expect(err.code).toBe('TIMEOUT');
  });
});
