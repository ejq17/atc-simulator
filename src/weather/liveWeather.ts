/**
 * Browser client for live METARs, two sources tried in order:
 *
 * 1. The local backend (`npm run server`, `server/index.ts`, reached as same-origin `/api` through the Vite dev/preview proxy to :8787, or VITE_API_BASE), which proxies and
 *    caches the Aviation Weather Center (AWC). aviationweather.gov sends no CORS headers (checked with curl, 2026-10-17),
 *    so the browser never calls AWC directly. Skipped on the static GitHub Pages build, which has no backend.
 * 2. The National Weather Service API (`https://api.weather.gov/stations/<ICAO>/observations/latest`), which does send
 *    `access-control-allow-origin: *` and is called straight from the browser. For KMHT the 5-minute observations carry an
 *    empty `rawMessage`, so the structured fields are converted into a `Weather` and a METAR-style string is synthesised.
 *    When `rawMessage` is present (hourly METAR-type observations) it is parsed with `parseMetar` instead.
 *
 * The NWS fallback is used when the backend is unreachable, times out or returns an error (and always on static hosting).
 */
import type { Weather } from '../sim/types';
import { isStaticHosting } from '../hosting';
import { computeFlightCategory, parseMetar } from './metar';

export type LiveWeatherErrorCode =
  | 'BACKEND_UNREACHABLE'
  | 'BACKEND_ERROR'
  | 'STATIC_HOSTING'
  | 'NO_DATA'
  | 'BAD_RESPONSE'
  | 'TIMEOUT';

export const BACKEND_HINT = 'Optional: start the local backend with `npm run server` (http://localhost:8787) to use the Aviation Weather Center feed.';

/** The NWS API only has US stations (K..., P... ids); a station elsewhere (EGLL) is reachable only through the local backend's AWC proxy. */
export function isNwsStation(icao: string): boolean {
  return /^[KP][A-Z0-9]{3}$/.test(icao.toUpperCase());
}

export const NON_US_STATIC_MESSAGE =
  'Live weather for this airport is unavailable on the static build: the National Weather Service API covers US stations only and the Aviation Weather Center sends no CORS headers, so it is reachable only through the local backend (`npm run server`). Simulated weather is used.';

export const STATIC_HOSTING_MESSAGE =
  'Live weather on this hosted build comes straight from the National Weather Service API (no local backend).';

export type LiveMetarSource = 'awc-backend' | 'nws-direct';

export const NWS_BASE_URL = 'https://api.weather.gov';

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
  /** Where it came from: the local backend (AWC) or the NWS API called directly. */
  source?: LiveMetarSource;
}

export interface FetchLiveMetarOptions {
  /** Backend origin, no trailing slash. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Client-side timeout; default 15 s (backend upstream timeout is 10 s). */
  timeoutMs?: number;
  /** NWS API origin, no trailing slash (default https://api.weather.gov). */
  nwsBaseUrl?: string;
  /** Try the NWS API when the backend fails (default true). */
  nwsFallback?: boolean;
  /** Override static-hosting detection (tests). Static hosting skips the backend entirely. */
  staticHosting?: boolean;
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
  // Same origin: `vite dev` and `vite preview` both proxy `/api` to the backend on :8787 (vite.config.ts), exactly as the chart,
  // Deepgram and phrase-interpreter requests do. A direct http://localhost:8787 request is cross-origin and the backend only
  // allows the 5173 dev origin, so it failed with a CORS console error on any other port (e.g. `vite preview`).
  return '';
}

// ---- shared request helper ---------------------------------------------------------------------------------------

async function timedFetch(url: string, accept: string, options: FetchLiveMetarOptions, what: string, hint: string): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 15000;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);
  try {
    return await doFetch(url, { signal: controller.signal, headers: { Accept: accept } });
  } catch (err) {
    if (timedOut) throw new LiveWeatherError('TIMEOUT', `${what} timed out.${hint}`);
    if (options.signal?.aborted) throw err;
    throw new LiveWeatherError('BACKEND_UNREACHABLE', `Could not reach ${what}.${hint}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

// ---- source 1: local backend (AWC) -------------------------------------------------------------------------------

async function fetchFromBackend(id: string, options: FetchLiveMetarOptions): Promise<LiveMetar> {
  const base = (options.baseUrl ?? defaultBaseUrl()).replace(/\/$/, '');
  const url = `${base}/api/weather/metar?ids=${encodeURIComponent(id)}`;
  const res = await timedFetch(url, 'application/json', options, `the local weather backend${base ? ` at ${base}` : ''}`, ` ${BACKEND_HINT}`);

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
  return { weather, raw: record.rawOb, observedAt, source: 'awc-backend' };
}

// ---- source 2: NWS API, straight from the browser ----------------------------------------------------------------

interface NwsValue { value?: number | null; unitCode?: string }
interface NwsObservation {
  timestamp?: string | null;
  rawMessage?: string | null;
  windDirection?: NwsValue | null;
  windSpeed?: NwsValue | null;
  windGust?: NwsValue | null;
  visibility?: NwsValue | null;
  barometricPressure?: NwsValue | null;
  temperature?: NwsValue | null;
  dewpoint?: NwsValue | null;
  cloudLayers?: { base?: NwsValue | null; amount?: string | null }[] | null;
  presentWeather?: { rawString?: string | null }[] | null;
}

const KMH_PER_KT = 1.852;
const M_PER_SM = 1609.344;
const PA_PER_INHG = 3386.389;
const FT_PER_M = 3.28084;

const num = (v: NwsValue | null | undefined): number | undefined =>
  v && typeof v.value === 'number' && Number.isFinite(v.value) ? v.value : undefined;

/** Speed in the unit the API says (km/h is what it sends; m/s and kt handled for safety), as knots. */
function speedKt(v: NwsValue | null | undefined): number | undefined {
  const x = num(v);
  if (x === undefined) return undefined;
  const unit = v?.unitCode ?? '';
  if (unit.includes('m_s-1')) return Math.round(x * 1.943844);
  if (unit.includes('knot') || unit.endsWith('kt')) return Math.round(x);
  return Math.round(x / KMH_PER_KT);
}

function visibilitySmFromM(m: number): number {
  const sm = m / M_PER_SM;
  if (sm >= 9.5) return 10;
  return sm < 3 ? Math.round(sm * 4) / 4 : Math.round(sm);
}

function fmtVisibility(sm: number): string {
  if (Number.isInteger(sm)) return String(sm);
  const whole = Math.floor(sm);
  const frac = Math.round((sm - whole) * 4);
  const f = frac === 2 ? '1/2' : frac === 1 ? '1/4' : '3/4';
  return whole > 0 ? `${whole} ${f}` : f;
}

const pad = (n: number, w: number) => String(Math.abs(n)).padStart(w, '0');
const fmtTemp = (c: number) => `${c < 0 ? 'M' : ''}${pad(c, 2)}`;

/** True when the observation has enough structured data to build a Weather from. */
function hasStructuredData(o: NwsObservation): boolean {
  return num(o.windSpeed) !== undefined || num(o.temperature) !== undefined || num(o.barometricPressure) !== undefined;
}

export function nwsObservationToLiveMetar(o: NwsObservation, icao: string): LiveMetar {
  const id = icao.toUpperCase();
  const ts = o.timestamp ? new Date(o.timestamp) : undefined;
  if (!ts || Number.isNaN(ts.getTime())) throw new LiveWeatherError('BAD_RESPONSE', 'NWS observation has no valid timestamp.');
  const observedAt = ts.toISOString();

  const rawMessage = typeof o.rawMessage === 'string' ? o.rawMessage.trim() : '';
  if (rawMessage) {
    const weather = parseMetar(rawMessage, { referenceDate: ts });
    weather.source = 'live';
    weather.observedAt = observedAt;
    return { weather, raw: rawMessage, observedAt, source: 'nws-direct' };
  }
  if (!hasStructuredData(o)) throw new LiveWeatherError('NO_DATA', `The NWS observation for ${id} has no usable data.`);

  const spd = speedKt(o.windSpeed) ?? 0;
  const dirRaw = num(o.windDirection);
  const gustRaw = speedKt(o.windGust);
  const windDirDeg: number | 'VRB' = spd === 0 ? 0 : dirRaw === undefined ? 'VRB' : (Math.round(dirRaw) % 360 === 0 ? 360 : Math.round(dirRaw) % 360);
  const windGustKt = gustRaw !== undefined && gustRaw > spd && spd > 0 ? gustRaw : undefined;

  const visM = num(o.visibility);
  const visibilitySm = visM === undefined ? 10 : visibilitySmFromM(visM);

  const layers = o.cloudLayers ?? [];
  const clouds: Weather['clouds'] = [];
  for (const l of layers) {
    const cover = (l.amount ?? '').toUpperCase();
    if (cover === 'CLR' || cover === 'SKC') {
      if (!clouds.length) clouds.push({ cover: 'CLR', baseFtAgl: 0 });
    } else if (cover === 'FEW' || cover === 'SCT' || cover === 'BKN' || cover === 'OVC' || cover === 'VV') {
      const m = num(l.base);
      clouds.push({ cover, baseFtAgl: m === undefined ? 0 : Math.round((m * FT_PER_M) / 100) * 100 });
    }
  }
  if (!clouds.length) clouds.push({ cover: 'CLR', baseFtAgl: 0 });

  const t = num(o.temperature);
  const d = num(o.dewpoint);
  const temperatureC = t === undefined ? 15 : Math.round(t);
  const dewpointC = d === undefined ? temperatureC : Math.round(d);
  const pa = num(o.barometricPressure);
  const altimeterInHg = pa === undefined ? 29.92 : Math.round((pa / PA_PER_INHG) * 100) / 100;
  const phenomena = (o.presentWeather ?? []).map((p) => (p.rawString ?? '').trim()).filter(Boolean);

  // Synthesised METAR-form string so the UI's raw display shows something sensible.
  const windGroup = spd === 0 ? '00000KT' : `${windDirDeg === 'VRB' ? 'VRB' : pad(windDirDeg, 3)}${pad(spd, 2)}${windGustKt ? `G${pad(windGustKt, 2)}` : ''}KT`;
  const cloudGroups = clouds.map((c) => (c.cover === 'CLR' ? 'CLR' : `${c.cover}${pad(Math.round(c.baseFtAgl / 100), 3)}`));
  const raw = [
    id,
    `${pad(ts.getUTCDate(), 2)}${pad(ts.getUTCHours(), 2)}${pad(ts.getUTCMinutes(), 2)}Z`,
    windGroup,
    `${fmtVisibility(visibilitySm)}SM`,
    ...phenomena,
    ...cloudGroups,
    `${fmtTemp(temperatureC)}/${fmtTemp(dewpointC)}`,
    `A${pad(Math.round(altimeterInHg * 100), 4)}`,
    '(NWS)',
  ].join(' ');

  const weather: Weather = {
    source: 'live',
    observedAt,
    rawMetar: raw,
    windDirDeg,
    windSpeedKt: spd,
    ...(windGustKt !== undefined ? { windGustKt } : {}),
    visibilitySm,
    clouds,
    temperatureC,
    dewpointC,
    altimeterInHg,
    phenomena,
    flightCategory: computeFlightCategory(visibilitySm, clouds),
  };
  return { weather, raw, observedAt, source: 'nws-direct' };
}

async function nwsGet(path: string, id: string, options: FetchLiveMetarOptions): Promise<NwsObservation[]> {
  const base = (options.nwsBaseUrl ?? NWS_BASE_URL).replace(/\/$/, '');
  const res = await timedFetch(`${base}${path}`, 'application/geo+json', options, 'the National Weather Service API', '');
  if (res.status === 404 || res.status === 204) throw new LiveWeatherError('NO_DATA', `The NWS API has no observation for ${id}.`, res.status);
  if (!res.ok) throw new LiveWeatherError('BACKEND_ERROR', `NWS API returned HTTP ${res.status}`, res.status);
  let data: { properties?: NwsObservation; features?: { properties?: NwsObservation }[] };
  try {
    data = await res.json();
  } catch {
    throw new LiveWeatherError('BAD_RESPONSE', 'NWS API returned a response that is not valid JSON.');
  }
  if (!data || typeof data !== 'object') throw new LiveWeatherError('NO_DATA', `The NWS API has no observation for ${id}.`);
  const list = data.features ? data.features.map((f) => f?.properties) : [data.properties];
  return list.filter((p): p is NwsObservation => !!p && typeof p === 'object');
}

async function fetchFromNws(id: string, options: FetchLiveMetarOptions): Promise<LiveMetar> {
  const station = encodeURIComponent(id);
  let firstError: unknown;
  try {
    const [latest] = await nwsGet(`/stations/${station}/observations/latest`, id, options);
    if (latest && (latest.rawMessage?.trim() || hasStructuredData(latest))) return nwsObservationToLiveMetar(latest, id);
  } catch (err) {
    if (options.signal?.aborted || !(err instanceof LiveWeatherError)) throw err;
    firstError = err;
  }
  // Latest is missing or all-null: look at the few most recent observations for a usable one.
  try {
    const recent = await nwsGet(`/stations/${station}/observations?limit=4`, id, options);
    for (const o of recent) {
      if (o.rawMessage?.trim() || hasStructuredData(o)) return nwsObservationToLiveMetar(o, id);
    }
  } catch (err) {
    if (options.signal?.aborted || !(err instanceof LiveWeatherError)) throw err;
    throw firstError ?? err;
  }
  throw firstError ?? new LiveWeatherError('NO_DATA', `No current observation is available for ${id} from the NWS API.`);
}

// ---- public entry point ------------------------------------------------------------------------------------------

export async function fetchLiveMetar(icao = 'KACY', options: FetchLiveMetarOptions = {}): Promise<LiveMetar> {
  const id = icao.toUpperCase();
  const staticHost = options.staticHosting ?? isStaticHosting();
  const fallback = options.nwsFallback !== false && isNwsStation(id);
  if (staticHost && !isNwsStation(id)) throw new LiveWeatherError('STATIC_HOSTING', NON_US_STATIC_MESSAGE);

  let backendError: LiveWeatherError | undefined;
  if (!staticHost) {
    try {
      return await fetchFromBackend(id, options);
    } catch (err) {
      const recoverable = err instanceof LiveWeatherError && (err.code === 'BACKEND_UNREACHABLE' || err.code === 'TIMEOUT' || err.code === 'BACKEND_ERROR');
      if (!recoverable || !fallback) throw err;
      backendError = err;
    }
  }

  try {
    return await fetchFromNws(id, options);
  } catch (err) {
    if (!(err instanceof LiveWeatherError)) throw err;
    const nwsMsg = err.message;
    const message = backendError
      ? `Live weather unavailable. Local backend: ${backendError.message} NWS API: ${nwsMsg}`
      : `Live weather unavailable. NWS API: ${nwsMsg}`;
    throw new LiveWeatherError(err.code, message, err.status);
  }
}
