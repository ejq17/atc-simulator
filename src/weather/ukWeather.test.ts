import { describe, expect, it, vi } from 'vitest';
import { generateAtis } from './atis';
import { fetchLiveMetar, isNwsStation, LiveWeatherError } from './liveWeather';
import { parseMetar } from './metar';
import { hpaToInHg, inHgToHpa, visibilityMetres, visibilityText } from './units';

// METAR returned by https://aviationweather.gov/api/data/metar?ids=EGLL&format=json on 2026-10-22 (rawOb field)
const EGLL_RAW = 'METAR EGLL 220050Z AUTO 20008KT 9999 -RA FEW048 10/07 Q1007';

describe('UK METAR (QNH in hPa, visibility in metres)', () => {
  it('parses the live EGLL observation', () => {
    const w = parseMetar(EGLL_RAW);
    expect(w.windSpeedKt).toBe(8);
    expect(w.visibilitySm).toBe(10);
    expect(w.phenomena).toEqual(['-RA']);
    expect(inHgToHpa(w.altimeterInHg)).toBe(1007);
    expect(w.temperatureC).toBe(10);
  });
  it('Q group, CAVOK and metres, with RVR ignored', () => {
    expect(inHgToHpa(parseMetar('EGLL 121250Z 24008KT CAVOK 18/09 Q1013').altimeterInHg)).toBe(1013);
    const fog = parseMetar('EGLL 121250Z 00000KT 0350 R27R/0400N FG VV001 09/09 Q0995');
    expect(fog.visibilitySm).toBeCloseTo(0.22, 1);
    expect(inHgToHpa(fog.altimeterInHg)).toBe(995);
  });
  it('hPa <-> inHg round trip is exact in whole hectopascals', () => {
    for (let h = 950; h <= 1050; h++) expect(inHgToHpa(hpaToInHg(h))).toBe(h);
    for (let h = 950; h <= 1050; h++) expect(inHgToHpa(Math.round(hpaToInHg(h) * 100) / 100)).toBeGreaterThanOrEqual(h - 1);
  });
  it('visibility wording', () => {
    expect(visibilityMetres(10).tenKmOrMore).toBe(true);
    expect(visibilityText(10)).toBe('10 kilometres or more');
    expect(visibilityText(3.73)).toBe('6000 metres');
    expect(visibilityText(0.5)).toBe('800 metres');
  });
});

describe('ATIS in hPa', () => {
  const w = parseMetar(EGLL_RAW);
  const input = { airportName: 'Heathrow', icao: 'EGLL', weather: w, variationDeg: 1.23, activeRunways: { departing: ['27L'], landing: ['27R'] }, letter: 'B', timeUtc: new Date('2026-10-22T01:00:00Z'), elevationFt: 83 };
  it('reads QNH and metric visibility, no FAA hold short sentence', () => {
    const a = generateAtis({ ...input, altimeterUnit: 'hPa' });
    expect(a.text).toContain('QNH 1007.');
    expect(a.text).toContain('Visibility 10 kilometres or more');
    expect(a.text).not.toMatch(/Altimeter|hold short|Airport information/);
    expect(a.spokenText).toContain('QNH one zero zero seven');
    expect(a.text.trim().endsWith('Acknowledge receipt of information Bravo on first contact.')).toBe(true);
  });
  it('keeps the FAA wording without the unit', () => {
    const a = generateAtis({ ...input, airportName: 'Atlantic City' });
    expect(a.text).toMatch(/Altimeter/);
    expect(a.text).toMatch(/hold short/);
  });
});

describe('live weather for a station outside the US', () => {
  it('is only reachable through the backend; no NWS fallback', () => {
    expect(isNwsStation('KACY')).toBe(true);
    expect(isNwsStation('EGLL')).toBe(false);
  });
  it('static build: clear message, no request', async () => {
    const f = vi.fn();
    await expect(fetchLiveMetar('EGLL', { staticHosting: true, fetchImpl: f as unknown as typeof fetch })).rejects.toMatchObject({ code: 'STATIC_HOSTING', message: expect.stringContaining('unavailable on the static build') });
    expect(f).not.toHaveBeenCalled();
  });
  it('backend: parses the AWC record; a backend failure does not fall back to the NWS API', async () => {
    const rec = [{ icaoId: 'EGLL', rawOb: EGLL_RAW, obsTime: 1792630200 }];
    const ok = vi.fn(async () => new Response(JSON.stringify(rec), { status: 200 }));
    const live = await fetchLiveMetar('EGLL', { staticHosting: false, fetchImpl: ok as unknown as typeof fetch, baseUrl: 'http://b' });
    expect(live.source).toBe('awc-backend');
    expect(live.weather.windDirDeg).toBe(200);
    const bad = vi.fn(async () => new Response('x', { status: 502 }));
    await expect(fetchLiveMetar('EGLL', { staticHosting: false, fetchImpl: bad as unknown as typeof fetch, baseUrl: 'http://b' })).rejects.toBeInstanceOf(LiveWeatherError);
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
