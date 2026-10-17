/**
 * Browser client for live METARs.
 *
 * aviationweather.gov sends no CORS headers, so the browser never calls it
 * directly. It calls the local backend (`npm run server`, `server/index.ts`),
 * which proxies and caches AWC. Backend origin defaults to
 * http://localhost:8787 and can be overridden with VITE_API_BASE.
 */
import type { Weather } from '../sim/types';
import { parseMetar } from './metar';

export type LiveWeatherErrorCode =
  | 'BACKEND_UNREACHABLE'
  | 'BACKEND_ERROR'
  | 'NO_DATA'
  | 'BAD_RESPONSE'
  | 'TIMEOUT';

export const BACKEND_HINT = 'Start the local backend with `npm run server` (it listens on http://localhost:8787), then try again.';

export class LiveWeatherError extends Error {
  code: LiveWeatherErrorCode;
  status?: number;
  constructor(code: LiveWeatherErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'LiveWeatherError';
    this.code = code;
    this.status = status;
  }
}

export interface LiveMetar {
  weather: Weather;
  raw: string;
  /** ISO timestamp of the observation. */
  observedAt: string;
}

export interface FetchLiveMetarOptions {
  /** Backend origin, no trailing slash. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Client-side timeout; default 15 s (backend upstream timeout is 10 s). */
  timeoutMs?: number;
}

interface AwcMetarRecord {
  icaoId?: string;
  rawOb?: string;
  obsTime?: number;
  reportTime?: string;
}

function defaultBaseUrl(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    if (env?.VITE_API_BASE) return env.VITE_API_BASE.replace(/\/$/, '');
  } catch { /* not in a Vite context */ }
  return 'http://localhost:8787';
}

export async function fetchLiveMetar(icao = 'KACY', options: FetchLiveMetarOptions = {}): Promise<LiveMetar> {
  const base = (options.baseUrl ?? defaultBaseUrl()).replace(/\/$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const id = icao.toUpperCase();
  const url = `${base}/api/weather/metar?ids=${encodeURIComponent(id)}`;

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 15000;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await doFetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if (timedOut) {
      throw new LiveWeatherError('TIMEOUT', `Live weather request timed out. ${BACKEND_HINT}`);
    }
    if (options.signal?.aborted) throw err;
    throw new LiveWeatherError(
      'BACKEND_UNREACHABLE',
      `Could not reach the local weather backend at ${base}. ${BACKEND_HINT}`,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ? `: ${body.error.message}` : '';
    } catch { /* non-JSON error body */ }
    throw new LiveWeatherError('BACKEND_ERROR', `Weather backend returned HTTP ${res.status}${detail}`, res.status);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new LiveWeatherError('BAD_RESPONSE', 'Weather backend returned a response that is not valid JSON.');
  }
  if (!Array.isArray(data)) {
    throw new LiveWeatherError('BAD_RESPONSE', 'Weather backend returned an unexpected response shape (expected a JSON array).');
  }
  const record = (data as AwcMetarRecord[]).find((r) => r?.rawOb && (!r.icaoId || r.icaoId === id));
  if (!record?.rawOb) {
    throw new LiveWeatherError('NO_DATA', `No current METAR is available for ${id}.`);
  }

  const observedAt =
    typeof record.obsTime === 'number'
      ? new Date(record.obsTime * 1000).toISOString()
      : record.reportTime ?? new Date().toISOString();
  const weather = parseMetar(record.rawOb, { referenceDate: new Date(observedAt) });
  weather.source = 'live';
  weather.observedAt = observedAt;
  return { weather, raw: record.rawOb, observedAt };
}
