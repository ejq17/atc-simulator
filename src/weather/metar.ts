/**
 * METAR parser (US/ICAO style) producing the shared `Weather` contract.
 *
 * Conventions
 * - Wind direction is stored TRUE (METAR winds are true). Use `windMagnetic`
 *   to obtain the magnetic direction an ATIS/tower would speak.
 * - Visibility is statute miles. "P6SM" -> 6, "M1/4SM" -> 0.25 (the bound is
 *   stored, not the qualifier). 4-digit metre visibilities are converted.
 * - Phenomena keep their intensity/proximity prefix: "-RA", "+TSRA", "VCTS".
 * - SKC/CLR/NCD/NSC are recorded as a single `{cover:'SKC'|'CLR', baseFtAgl:0}`
 *   entry (base is meaningless). Ceiling logic ignores them.
 * - Remarks are never interpreted; the full raw string is kept in `rawMetar`
 *   and the remark text is returned by `parseMetarDetailed`.
 * - Groups that are missing get documented defaults (vis 10 SM, temperature
 *   15 C, dewpoint 10 C, altimeter 29.92) and are listed in `missing`.
 */
import type { Weather } from '../sim/types';

export type FlightCategory = Weather['flightCategory'];
export type CloudLayer = Weather['clouds'][number];

/** Magnetic variation at KACY, east-positive (NASR: 10 deg W). */
export const KACY_MAGNETIC_VARIATION_DEG = -10;

export interface ParsedMetar {
  weather: Weather;
  station?: string;
  /** Day of month and UTC time as reported (undefined if absent). */
  day?: number;
  hour?: number;
  minute?: number;
  type: 'METAR' | 'SPECI';
  auto: boolean;
  corrected: boolean;
  /** Variable wind sector from the dddVddd group, TRUE degrees. */
  variableWind?: { fromDeg: number; toDeg: number };
  /** Everything after the RMK token (without the token). */
  remarks?: string;
  /** Names of core groups that were absent and defaulted. */
  missing: string[];
  /** Tokens that were not understood (before RMK). */
  unparsed: string[];
}

export interface ParseOptions {
  /**
   * Reference "now" used to resolve the day/time group into a full ISO
   * timestamp (`Weather.observedAt`). If omitted, `observedAt` is left unset.
   */
  referenceDate?: Date;
}

const PHENOMENA_CODES = new Set([
  // descriptors
  'MI', 'PR', 'BC', 'DR', 'BL', 'SH', 'TS', 'FZ',
  // precipitation
  'DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP',
  // obscuration
  'BR', 'FG', 'FU', 'VA', 'DU', 'SA', 'HZ', 'PY',
  // other
  'PO', 'SQ', 'FC', 'SS', 'DS',
]);

export function isPhenomenonToken(tok: string): boolean {
  let rest = tok;
  if (rest.startsWith('+') || rest.startsWith('-')) rest = rest.slice(1);
  else if (rest.startsWith('VC')) rest = rest.slice(2);
  if (rest.length < 2 || rest.length % 2 !== 0) return false;
  for (let i = 0; i < rest.length; i += 2) {
    if (!PHENOMENA_CODES.has(rest.slice(i, i + 2))) return false;
  }
  return true;
}

/** Lowest BKN/OVC/VV base in feet AGL, or undefined when there is no ceiling. */
export function ceilingFt(clouds: readonly CloudLayer[]): number | undefined {
  let lowest: number | undefined;
  for (const c of clouds) {
    if (c.cover === 'BKN' || c.cover === 'OVC' || c.cover === 'VV') {
      if (lowest === undefined || c.baseFtAgl < lowest) lowest = c.baseFtAgl;
    }
  }
  return lowest;
}

/** Visibility-only category (FAA thresholds). */
export function visibilityCategory(visibilitySm: number): FlightCategory {
  if (visibilitySm < 1) return 'LIFR';
  if (visibilitySm < 3) return 'IFR';
  if (visibilitySm <= 5) return 'MVFR';
  return 'VFR';
}

/** Ceiling-only category (FAA thresholds). No ceiling => VFR. */
export function ceilingCategory(ceiling: number | undefined): FlightCategory {
  if (ceiling === undefined) return 'VFR';
  if (ceiling < 500) return 'LIFR';
  if (ceiling < 1000) return 'IFR';
  if (ceiling <= 3000) return 'MVFR';
  return 'VFR';
}

const CAT_RANK: Record<FlightCategory, number> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };

/**
 * FAA flight category: the worse of the visibility and ceiling categories.
 * LIFR: ceil < 500 or vis < 1; IFR: 500..<1000 or 1..<3; MVFR: 1000..3000 or
 * 3..5; VFR: ceil > 3000 and vis > 5.
 */
export function computeFlightCategory(
  visibilitySm: number,
  clouds: readonly CloudLayer[],
): FlightCategory {
  const v = visibilityCategory(visibilitySm);
  const c = ceilingCategory(ceilingFt(clouds));
  return CAT_RANK[v] >= CAT_RANK[c] ? v : c;
}

function parseFraction(s: string): number | undefined {
  const m = /^(\d+)\/(\d+)$/.exec(s);
  if (!m) return undefined;
  const den = Number(m[2]);
  return den === 0 ? undefined : Number(m[1]) / den;
}

function parseTempPart(s: string): number {
  const neg = s.startsWith('M');
  const n = Number(neg ? s.slice(1) : s);
  return neg ? -n : n;
}

function resolveObservedAt(day: number, hour: number, minute: number, ref: Date): string {
  // Most recent occurrence of that day-of-month at/before ref (with 1 day slack).
  const candidates: Date[] = [];
  for (const monthOffset of [0, -1, -2]) {
    const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + monthOffset, day, hour, minute));
    // reject overflow (e.g. day 31 in a 30-day month rolls into next month)
    if (d.getUTCDate() === day) candidates.push(d);
  }
  const slack = ref.getTime() + 24 * 3600 * 1000;
  const best = candidates.find((d) => d.getTime() <= slack) ?? candidates[0];
  return (best ?? new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), day, hour, minute))).toISOString();
}

const WIND_RE = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/;
const VAR_WIND_RE = /^(\d{3})V(\d{3})$/;
const VIS_SM_RE = /^([PM])?(\d+(?:\/\d+)?)SM$/;
const CLOUD_RE = /^(FEW|SCT|BKN|OVC)(\d{3}|\/\/\/)(CB|TCU)?$/;
const VV_RE = /^VV(\d{3}|\/\/\/)$/;
const TEMP_RE = /^(M?\d{2}|\/\/)\/(M?\d{2}|\/\/)?$/;
const ALT_A_RE = /^A(\d{4})$/;
const ALT_Q_RE = /^Q(\d{4})$/;
const TIME_RE = /^(\d{2})(\d{2})(\d{2})Z$/;

function toKnots(value: number, unit: string): number {
  if (unit === 'MPS') return Math.round(value * 1.943844);
  if (unit === 'KMH') return Math.round(value * 0.539957);
  return value;
}

/** Full parse with all auxiliary information. Never throws on odd input. */
export function parseMetarDetailed(raw: string, options: ParseOptions = {}): ParsedMetar {
  const rawMetar = raw.trim().replace(/\s+/g, ' ');
  const rmkIdx = rawMetar.search(/(^|\s)RMK(\s|$)/);
  const body = rmkIdx >= 0 ? rawMetar.slice(0, rmkIdx).trim() : rawMetar;
  const remarks = rmkIdx >= 0 ? rawMetar.slice(rmkIdx).trim().replace(/^RMK\s*/, '') : undefined;
  const tokens = body.split(' ').filter(Boolean);

  const out: ParsedMetar = {
    weather: undefined as unknown as Weather,
    type: 'METAR',
    auto: false,
    corrected: false,
    missing: [],
    unparsed: [],
    remarks,
  };

  let windDir: number | 'VRB' | undefined;
  let windSpeed: number | undefined;
  let gust: number | undefined;
  let visibility: number | undefined;
  let pendingWholeVis: number | undefined;
  const clouds: CloudLayer[] = [];
  const phenomena: string[] = [];
  let temp: number | undefined;
  let dew: number | undefined;
  let altimeter: number | undefined;
  let skyReported = false;

  tokens.forEach((tok, i) => {
    if (tok === 'METAR' || tok === 'SPECI') { out.type = tok; return; }
    if (tok === 'AUTO') { out.auto = true; return; }
    if (tok === 'COR') { out.corrected = true; return; }
    if (tok === 'NIL') return;
    if (i <= 2 && !out.station && /^[A-Z][A-Z0-9]{3}$/.test(tok) && !TIME_RE.test(tok)) {
      out.station = tok; return;
    }
    let m = TIME_RE.exec(tok);
    if (m) {
      out.day = Number(m[1]); out.hour = Number(m[2]); out.minute = Number(m[3]);
      return;
    }
    if ((m = WIND_RE.exec(tok))) {
      windDir = m[1] === 'VRB' ? 'VRB' : Number(m[1]);
      windSpeed = toKnots(Number(m[2]), m[4]);
      gust = m[3] ? toKnots(Number(m[3]), m[4]) : undefined;
      return;
    }
    if ((m = VAR_WIND_RE.exec(tok))) {
      out.variableWind = { fromDeg: Number(m[1]), toDeg: Number(m[2]) };
      return;
    }
    if (tok === 'CAVOK') {
      visibility = 10; skyReported = true; return;
    }
    // Visibility: "1 1/2SM" arrives as two tokens, a bare whole number then "1/2SM".
    if (/^\d$/.test(tok) && /^\d+\/\d+SM$/.test(tokens[i + 1] ?? '')) {
      pendingWholeVis = Number(tok); return;
    }
    if ((m = VIS_SM_RE.exec(tok))) {
      const base = m[2].includes('/') ? parseFraction(m[2]) : Number(m[2]);
      if (base !== undefined) {
        visibility = base + (pendingWholeVis ?? 0);
        pendingWholeVis = undefined;
      }
      return;
    }
    if (/^\d{4}$/.test(tok) && visibility === undefined && windSpeed !== undefined) {
      // metres (ICAO style). 9999 = 10 km or more.
      visibility = tok === '9999' ? 10 : Math.round((Number(tok) / 1609.344) * 100) / 100;
      return;
    }
    if (/^R\d{2}[LRC]?\//.test(tok)) return; // RVR, ignored
    if (isPhenomenonToken(tok)) { phenomena.push(tok); return; }
    if (tok === 'SKC' || tok === 'CLR') {
      clouds.push({ cover: tok, baseFtAgl: 0 }); skyReported = true; return;
    }
    if (tok === 'NCD' || tok === 'NSC') { clouds.push({ cover: 'CLR', baseFtAgl: 0 }); skyReported = true; return; }
    if ((m = CLOUD_RE.exec(tok))) {
      skyReported = true;
      if (m[2] !== '///') clouds.push({ cover: m[1] as CloudLayer['cover'], baseFtAgl: Number(m[2]) * 100 });
      return;
    }
    if ((m = VV_RE.exec(tok))) {
      skyReported = true;
      if (m[1] !== '///') clouds.push({ cover: 'VV', baseFtAgl: Number(m[1]) * 100 });
      return;
    }
    if ((m = TEMP_RE.exec(tok))) {
      if (m[1] !== '//') temp = parseTempPart(m[1]);
      if (m[2] && m[2] !== '//') dew = parseTempPart(m[2]);
      return;
    }
    if ((m = ALT_A_RE.exec(tok))) { altimeter = Number(m[1]) / 100; return; }
    if ((m = ALT_Q_RE.exec(tok))) {
      altimeter = Math.round(Number(m[1]) * 0.0295300 * 100) / 100; return;
    }
    if (/^(NOSIG|NSW|TEMPO|BECMG)$/.test(tok)) return;
    out.unparsed.push(tok);
  });

  if (windSpeed === undefined) out.missing.push('wind');
  if (visibility === undefined) out.missing.push('visibility');
  if (!skyReported) out.missing.push('sky');
  if (temp === undefined) out.missing.push('temperature');
  if (dew === undefined) out.missing.push('dewpoint');
  if (altimeter === undefined) out.missing.push('altimeter');

  const finalVis = visibility ?? 10;
  const finalTemp = temp ?? 15;
  const finalDew = dew ?? (temp !== undefined ? temp : 10);

  const weather: Weather = {
    source: 'live',
    rawMetar,
    windDirDeg: windDir ?? 0,
    windSpeedKt: windSpeed ?? 0,
    visibilitySm: finalVis,
    clouds,
    temperatureC: finalTemp,
    dewpointC: finalDew,
    altimeterInHg: altimeter ?? 29.92,
    phenomena,
    flightCategory: computeFlightCategory(finalVis, clouds),
  };
  if (gust !== undefined) weather.windGustKt = gust;
  if (out.day !== undefined && options.referenceDate) {
    weather.observedAt = resolveObservedAt(out.day, out.hour ?? 0, out.minute ?? 0, options.referenceDate);
  }
  out.weather = weather;
  return out;
}

/** Parse a raw METAR into the shared `Weather` contract (wind direction TRUE). */
export function parseMetar(raw: string, options: ParseOptions = {}): Weather {
  return parseMetarDetailed(raw, options).weather;
}

function normDeg(d: number): number {
  const r = Math.round(((d % 360) + 360) % 360);
  return r === 0 ? 360 : r;
}

/**
 * Convert the stored TRUE wind direction to MAGNETIC for ATIS/tower use.
 * `variationDeg` is east-positive (KACY = -10, i.e. 10 deg W):
 * magnetic = true - variation. Returns 'VRB' for variable wind and 0 for calm.
 * Result is an integer in 1..360 (or 0 for calm). Pass `roundTo: 10` for
 * ATIS-style tens-of-degrees rounding.
 */
export function windMagnetic(
  weather: Pick<Weather, 'windDirDeg' | 'windSpeedKt'>,
  variationDeg: number,
  roundTo = 1,
): number | 'VRB' {
  if (weather.windDirDeg === 'VRB') return 'VRB';
  if (weather.windSpeedKt === 0) return 0;
  const mag = weather.windDirDeg - variationDeg;
  if (roundTo > 1) {
    const r = Math.round((((mag % 360) + 360) % 360) / roundTo) * roundTo;
    return r % 360 === 0 ? 360 : r % 360;
  }
  return normDeg(mag);
}
