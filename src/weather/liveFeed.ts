/**
 * Live METAR feed for a running session. Polls the backend proxy on the real METAR cadence (every 5 minutes: hourly routine
 * reports and specials both show up within one poll), applies a report only when its OBSERVATION TIME is new, and degrades
 * visibly: the last good METAR keeps being used while the backend is down ("stale"); with none at all the session keeps the
 * simulated weather it started with ("fallback"). Failed polls retry sooner (default 60 s).
 */
import type { Weather } from '../sim/types';
import type { LiveMetar } from './liveWeather';

export type LiveFeedStatus =
  | { kind: 'live'; observedAt: string; raw: string; checkedAtMs: number }
  /** Backend unreachable now; the last good METAR (observed `observedAt`) is still in use. */
  | { kind: 'stale'; observedAt: string; raw: string; error: string; failedAtMs: number }
  /** Never had a live METAR: the simulated weather stays. */
  | { kind: 'fallback'; error: string; failedAtMs: number };

export const METAR_POLL_MS = 5 * 60 * 1000;
export const METAR_RETRY_MS = 60 * 1000;

export interface LiveFeedOptions {
  fetchMetar(): Promise<LiveMetar>;
  /** A METAR with a new observation time arrived (not called for a repeat of the one already applied). */
  onWeather(weather: Weather, metar: LiveMetar): void;
  onStatus(status: LiveFeedStatus): void;
  pollMs?: number;
  retryMs?: number;
  nowMs?: () => number;
  /** The METAR the session already started with, so the first poll does not re-announce it. */
  initial?: LiveMetar;
}

export interface LiveFeed {
  /** Begin polling; the first poll is `firstDelayMs` away (default: the poll interval; pass 0 to poll at once). */
  start(firstDelayMs?: number): void;
  /** Poll now (also reschedules the next one). */
  refresh(): Promise<void>;
  stop(): void;
  status(): LiveFeedStatus | undefined;
}

export function createLiveFeed(o: LiveFeedOptions): LiveFeed {
  const poll = o.pollMs ?? METAR_POLL_MS;
  const retry = o.retryMs ?? METAR_RETRY_MS;
  const now = o.nowMs ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  let last: LiveMetar | undefined = o.initial;
  let status: LiveFeedStatus | undefined;
  let inFlight = false;

  const set = (s: LiveFeedStatus) => {
    status = s;
    o.onStatus(s);
  };
  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void feed.refresh(); }, ms);
  };

  const feed: LiveFeed = {
    start(firstDelayMs = poll) {
      stopped = false;
      if (last) set({ kind: 'live', observedAt: last.observedAt, raw: last.raw, checkedAtMs: now() });
      schedule(firstDelayMs);
    },
    async refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const m = await o.fetchMetar();
        if (stopped) return;
        const isNew = !last || m.observedAt !== last.observedAt;
        // An older report than the one in use (proxy cache race) is ignored.
        const older = last && Date.parse(m.observedAt) < Date.parse(last.observedAt);
        if (isNew && !older) {
          last = m;
          o.onWeather(m.weather, m);
        }
        set({ kind: 'live', observedAt: last!.observedAt, raw: last!.raw, checkedAtMs: now() });
        schedule(poll);
      } catch (err) {
        if (stopped) return;
        const error = err instanceof Error ? err.message : String(err);
        set(last ? { kind: 'stale', observedAt: last.observedAt, raw: last.raw, error, failedAtMs: now() } : { kind: 'fallback', error, failedAtMs: now() });
        schedule(retry);
      } finally {
        inFlight = false;
      }
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    status: () => status,
  };
  return feed;
}
