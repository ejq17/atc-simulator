import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveFeed, METAR_POLL_MS, METAR_RETRY_MS } from './liveFeed';
import type { LiveFeedStatus } from './liveFeed';
import { fetchLiveMetar } from './liveWeather';
import type { Weather } from '../sim/types';

const rec = (raw: string, obsTime: number) => ({ icaoId: 'KACY', obsTime, rawOb: raw });
const R1 = rec('METAR KACY 170054Z 29017G23KT 10SM FEW018 BKN038 21/17 A2983', 1792198440); // 00:54Z
const R2 = rec('METAR KACY 170154Z 18006KT 3SM BR OVC008 19/18 A2991', 1792202040); // 01:54Z
const ok = (r: unknown) => vi.fn(async () => new Response(JSON.stringify([r]), { status: 200 }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function harness(fetchImpl: typeof fetch) {
  const weather: Weather[] = [];
  const statuses: LiveFeedStatus[] = [];
  const feed = createLiveFeed({
    fetchMetar: () => fetchLiveMetar('KACY', { baseUrl: 'http://x', nwsFallback: false, fetchImpl }),
    onWeather: (w) => weather.push(w),
    onStatus: (s) => statuses.push(s),
  });
  return { feed, weather, statuses };
}

describe('live METAR feed', () => {
  it('polls every 5 minutes through the proxy and applies only reports with a new observation time', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([R1])))
      .mockResolvedValueOnce(new Response(JSON.stringify([R1]))) // same observation again
      .mockResolvedValueOnce(new Response(JSON.stringify([R2]))); // the next hourly report
    const { feed, weather, statuses } = harness(f as unknown as typeof fetch);
    feed.start(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(weather).toHaveLength(1);
    expect(weather[0]).toMatchObject({ windDirDeg: 290, windGustKt: 23, flightCategory: 'VFR', source: 'live' });
    await vi.advanceTimersByTimeAsync(METAR_POLL_MS);
    expect(f).toHaveBeenCalledTimes(2);
    expect(weather).toHaveLength(1); // unchanged observation: not re-applied
    await vi.advanceTimersByTimeAsync(METAR_POLL_MS);
    expect(weather).toHaveLength(2);
    expect(weather[1]).toMatchObject({ windDirDeg: 180, visibilitySm: 3, flightCategory: 'IFR', altimeterInHg: 29.91 });
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe('http://x/api/weather/metar?ids=KACY');
    expect(statuses.at(-1)).toMatchObject({ kind: 'live', observedAt: '2026-10-17T01:54:00.000Z' });
    feed.stop();
  });

  it('ignores an older report than the one in use', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([R2]))).mockResolvedValueOnce(new Response(JSON.stringify([R1])));
    const { feed, weather } = harness(f as unknown as typeof fetch);
    feed.start(0);
    await vi.advanceTimersByTimeAsync(METAR_POLL_MS);
    expect(weather).toHaveLength(1);
    expect(weather[0].windDirDeg).toBe(180);
    feed.stop();
  });

  it('keeps the last good METAR when the backend goes down ("stale"), retries sooner, and recovers', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([R1])))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify([R2])));
    const { feed, weather, statuses } = harness(f as unknown as typeof fetch);
    feed.start(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(METAR_POLL_MS);
    expect(statuses.at(-1)).toMatchObject({ kind: 'stale', observedAt: '2026-10-17T00:54:00.000Z' });
    expect((statuses.at(-1) as { error: string }).error).toMatch(/Could not reach the local weather backend/);
    expect(weather).toHaveLength(1); // nothing applied: the sim keeps the last good METAR
    await vi.advanceTimersByTimeAsync(METAR_RETRY_MS); // 2nd failure
    expect(statuses.at(-1)?.kind).toBe('stale');
    await vi.advanceTimersByTimeAsync(METAR_RETRY_MS); // backing off: the 3rd attempt is 2 x the retry interval after the 2nd failure
    expect(f).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(METAR_RETRY_MS); // recovered
    expect(statuses.at(-1)).toMatchObject({ kind: 'live', observedAt: '2026-10-17T01:54:00.000Z' });
    expect(weather).toHaveLength(2);
    feed.stop();
  });

  it('with no METAR ever received the status is "fallback" (simulated weather stays) until the backend answers', async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError('down')).mockResolvedValueOnce(new Response(JSON.stringify([R1])));
    const { feed, weather, statuses } = harness(f as unknown as typeof fetch);
    feed.start(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.kind).toBe('fallback');
    expect(weather).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(METAR_RETRY_MS);
    expect(statuses.at(-1)?.kind).toBe('live');
    expect(weather).toHaveLength(1);
    feed.stop();
  });

  it('a METAR the session started with is not announced again; stop() ends polling', async () => {
    const f = ok(R1);
    const weather: Weather[] = [];
    const initial = await fetchLiveMetar('KACY', { baseUrl: 'http://x', nwsFallback: false, fetchImpl: f as unknown as typeof fetch });
    const feed = createLiveFeed({ fetchMetar: () => fetchLiveMetar('KACY', { baseUrl: 'http://x', nwsFallback: false, fetchImpl: f as unknown as typeof fetch }), initial, onWeather: (w) => weather.push(w), onStatus: () => {} });
    feed.start();
    await vi.advanceTimersByTimeAsync(METAR_POLL_MS);
    expect(f).toHaveBeenCalledTimes(2);
    expect(weather).toHaveLength(0);
    feed.stop();
    await vi.advanceTimersByTimeAsync(METAR_POLL_MS * 3);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
