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
    expect(r.source).toBe('awc-backend');
  });

  it('uppercases the id', async () => {
    const f = respond(KACY_JSON);
    await fetchLiveMetar('kacy', { baseUrl: 'http://x:1', fetchImpl: f });
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://x:1/api/weather/metar?ids=KACY');
  });

  it('BACKEND_UNREACHABLE with a message telling the user to run the backend', async () => {
    const f = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const err = await fetchLiveMetar('KACY', { fetchImpl: f, nwsFallback: false }).catch((e) => e);
    expect(err).toBeInstanceOf(LiveWeatherError);
    expect(err.code).toBe('BACKEND_UNREACHABLE');
    expect(err.message).toContain('npm run server');
    expect(err.message).not.toContain('NWS');
  });

  it('BACKEND_ERROR carries status and backend message', async () => {
    const f = respond({ error: { code: 'UPSTREAM_TIMEOUT', message: 'slow' } }, { status: 504 });
    const err = await fetchLiveMetar('KACY', { fetchImpl: f, nwsFallback: false }).catch((e) => e);
    expect(err.code).toBe('BACKEND_ERROR');
    expect(err.status).toBe(504);
    expect(err.message).toContain('slow');
  });

  it('NO_DATA for an empty array', async () => {
    const err = await fetchLiveMetar('KACY', { fetchImpl: respond([]), nwsFallback: false }).catch((e) => e);
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
    const err = await fetchLiveMetar('KACY', { fetchImpl: f, timeoutMs: 20, nwsFallback: false }).catch((e) => e);
    expect(err.code).toBe('TIMEOUT');
  });
});

// ---- NWS direct ------------------------------------------------------------------------------------------------

const NWS_OBS = {
  timestamp: '2026-10-18T00:40:00+00:00',
  rawMessage: '',
  textDescription: 'Clear',
  windDirection: { value: 350, unitCode: 'wmoUnit:degree_(angle)' },
  windSpeed: { value: 7.416, unitCode: 'wmoUnit:km_h-1' },
  windGust: { value: null, unitCode: 'wmoUnit:km_h-1' },
  visibility: { value: 16093.44, unitCode: 'wmoUnit:m' },
  barometricPressure: { value: 102709.16, unitCode: 'wmoUnit:Pa' },
  temperature: { value: 3.3, unitCode: 'wmoUnit:degC' },
  dewpoint: { value: -4.6, unitCode: 'wmoUnit:degC' },
  cloudLayers: [{ base: { value: 3810, unitCode: 'wmoUnit:m' }, amount: 'CLR' }],
  presentWeather: [],
};
const nwsJson = (props: unknown) => ({ properties: props });

/** Routes by URL: backend (localhost) vs api.weather.gov. */
function router(handlers: { backend?: () => Response | Promise<Response>; latest?: () => Response | Promise<Response>; list?: () => Response | Promise<Response> }) {
  const calls: string[] = [];
  const f = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('localhost') || url.includes('x:1')) {
      if (!handlers.backend) throw new TypeError('refused');
      return handlers.backend();
    }
    if (url.includes('/observations/latest')) return handlers.latest ? handlers.latest() : new Response('{}', { status: 404 });
    if (url.includes('/observations?limit=4')) return handlers.list ? handlers.list() : new Response('{}', { status: 404 });
    throw new Error('unexpected url ' + url);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('fetchLiveMetar NWS fallback', () => {
  it('converts the structured NWS observation (KMHT fixture)', async () => {
    const { f, calls } = router({ latest: () => ok(nwsJson(NWS_OBS)) });
    const r = await fetchLiveMetar('KMHT', { fetchImpl: f, baseUrl: 'http://localhost:8787' });
    expect(calls[0]).toBe('http://localhost:8787/api/weather/metar?ids=KMHT');
    expect(calls[1]).toBe('https://api.weather.gov/stations/KMHT/observations/latest');
    expect(r.source).toBe('nws-direct');
    expect(r.observedAt).toBe('2026-10-18T00:40:00.000Z');
    const w = r.weather;
    expect(w.source).toBe('live');
    expect(w.windDirDeg).toBe(350);
    expect(w.windSpeedKt).toBe(4);
    expect(w.windGustKt).toBeUndefined();
    expect(w.visibilitySm).toBe(10);
    expect(w.altimeterInHg).toBe(30.33);
    expect(w.temperatureC).toBe(3);
    expect(w.dewpointC).toBe(-5);
    expect(w.clouds).toEqual([{ cover: 'CLR', baseFtAgl: 0 }]);
    expect(w.flightCategory).toBe('VFR');
    expect(r.raw).toBe('KMHT 180040Z 35004KT 10SM CLR 03/M05 A3033 (NWS)');
    expect(w.rawMetar).toBe(r.raw);
  });

  it('converts gusts, layers (m -> ft rounded to 100), weather and category', async () => {
    const obs = {
      ...NWS_OBS,
      windSpeed: { value: 27.78, unitCode: 'wmoUnit:km_h-1' },
      windGust: { value: 42.6, unitCode: 'wmoUnit:km_h-1' },
      visibility: { value: 4828, unitCode: 'wmoUnit:m' },
      cloudLayers: [{ base: { value: 213, unitCode: 'wmoUnit:m' }, amount: 'BKN' }, { base: { value: 610, unitCode: 'wmoUnit:m' }, amount: 'OVC' }],
      presentWeather: [{ rawString: '-RA' }, { rawString: 'BR' }],
    };
    const { f } = router({ latest: () => ok(nwsJson(obs)) });
    const w = (await fetchLiveMetar('KMHT', { fetchImpl: f, staticHosting: true })).weather;
    expect(w.windSpeedKt).toBe(15);
    expect(w.windGustKt).toBe(23);
    expect(w.visibilitySm).toBe(3);
    expect(w.clouds).toEqual([{ cover: 'BKN', baseFtAgl: 700 }, { cover: 'OVC', baseFtAgl: 2000 }]);
    expect(w.phenomena).toEqual(['-RA', 'BR']);
    expect(w.flightCategory).toBe('IFR');
  });

  it('prefers a non-empty rawMessage through parseMetar', async () => {
    const raw = 'METAR KMHT 180051Z 34005KT 10SM CLR 03/M05 A3033 RMK AO2 SLP271';
    const { f } = router({ latest: () => ok(nwsJson({ ...NWS_OBS, rawMessage: raw })) });
    const r = await fetchLiveMetar('KMHT', { fetchImpl: f, staticHosting: true });
    expect(r.raw).toBe(raw);
    expect(r.weather.windDirDeg).toBe(340);
    expect(r.source).toBe('nws-direct');
  });

  it('static hosting goes straight to NWS and never touches the backend', async () => {
    const { f, calls } = router({ latest: () => ok(nwsJson(NWS_OBS)) });
    await fetchLiveMetar('KMHT', { fetchImpl: f, staticHosting: true });
    expect(calls).toEqual(['https://api.weather.gov/stations/KMHT/observations/latest']);
  });

  it('a working backend is used and NWS is not called', async () => {
    const { f, calls } = router({ backend: () => ok(KACY_JSON) });
    const r = await fetchLiveMetar('KACY', { fetchImpl: f, baseUrl: 'http://localhost:8787' });
    expect(r.source).toBe('awc-backend');
    expect(calls).toHaveLength(1);
  });

  it('falls back to NWS on backend HTTP error and on timeout', async () => {
    const a = router({ backend: () => new Response('{}', { status: 502 }), latest: () => ok(nwsJson(NWS_OBS)) });
    expect((await fetchLiveMetar('KMHT', { fetchImpl: a.f, baseUrl: 'http://localhost:8787' })).source).toBe('nws-direct');

    const f = vi.fn((url: string, init?: RequestInit) => url.includes('localhost')
      ? new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); })
      : Promise.resolve(ok(nwsJson(NWS_OBS)))) as unknown as typeof fetch;
    const r = await fetchLiveMetar('KMHT', { fetchImpl: f, baseUrl: 'http://localhost:8787', timeoutMs: 20 });
    expect(r.source).toBe('nws-direct');
  });

  it('does not fall back when the backend answers with NO_DATA or garbage', async () => {
    const a = router({ backend: () => ok([]), latest: () => ok(nwsJson(NWS_OBS)) });
    expect((await fetchLiveMetar('KMHT', { fetchImpl: a.f, baseUrl: 'http://localhost:8787' }).catch((e) => e)).code).toBe('NO_DATA');
    expect(a.calls).toHaveLength(1);
  });

  it('uses the recent-observations list when latest is all nulls', async () => {
    const empty = { timestamp: NWS_OBS.timestamp, rawMessage: '', windSpeed: { value: null }, temperature: { value: null }, barometricPressure: { value: null } };
    const { f, calls } = router({ latest: () => ok(nwsJson(empty)), list: () => ok({ features: [{ properties: empty }, { properties: NWS_OBS }] }) });
    const r = await fetchLiveMetar('KMHT', { fetchImpl: f, staticHosting: true });
    expect(calls).toHaveLength(2);
    expect(r.weather.windSpeedKt).toBe(4);
  });

  it('NO_DATA for 404, 204 and all-null observations', async () => {
    const empty = { timestamp: NWS_OBS.timestamp, rawMessage: '', windSpeed: { value: null }, temperature: { value: null }, barometricPressure: { value: null } };
    for (const h of [
      { latest: () => new Response('{}', { status: 404 }) },
      { latest: () => new Response(null, { status: 204 }), list: () => new Response(null, { status: 204 }) },
      { latest: () => ok(nwsJson(empty)), list: () => ok({ features: [] }) },
    ]) {
      const { f } = router(h);
      const err = await fetchLiveMetar('KMHT', { fetchImpl: f, staticHosting: true }).catch((e) => e);
      expect(err).toBeInstanceOf(LiveWeatherError);
      expect(err.code).toBe('NO_DATA');
    }
  });

  it('backend failure followed by NWS failure throws a LiveWeatherError naming both sources', async () => {
    const { f } = router({ latest: () => new Response('{}', { status: 500 }), list: () => new Response('{}', { status: 500 }) });
    const err = await fetchLiveMetar('KMHT', { fetchImpl: f, baseUrl: 'http://localhost:8787' }).catch((e) => e);
    expect(err).toBeInstanceOf(LiveWeatherError);
    expect(err.code).toBe('BACKEND_ERROR');
    expect(err.message).toContain('Local backend');
    expect(err.message).toContain('NWS API');
  });

  it('NWS network failure is BACKEND_UNREACHABLE', async () => {
    const f = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    const err = await fetchLiveMetar('KMHT', { fetchImpl: f, staticHosting: true }).catch((e) => e);
    expect(err.code).toBe('BACKEND_UNREACHABLE');
    expect(err.message).toContain('National Weather Service');
  });
});
