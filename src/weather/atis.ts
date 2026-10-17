/**
 * Simulated ATIS generation.
 *
 * Produces two renderings of the same broadcast:
 *  - `text`        display text with numerals ("Wind 220 at 8").
 *  - `spokenText`  TTS-ready text with aviation number pronunciation
 *                  ("Wind two two zero at eight", altimeter "two niner niner two").
 *
 * The broadcast is ALWAYS flagged `simulated: true` and carries
 * `simulatedLabel` ("SIMULATED - not the real KACY ATIS") for the UI to show.
 * Cloud heights are AGL, so `elevationFt` is only echoed back as metadata.
 *
 * Content and order follow FAA JO 7110.65 2-9-3 (Content) and AIM 4-1-13: facility name, phonetic letter, time of the
 * weather (UTC), wind, visibility / obstructions, sky condition, temperature, dew point, altimeter, instrument or
 * visual approach in use (which names the landing runway), departure runway only when it differs from the landing
 * runway, NOTAMs, the hold-short readback statement, then "Advise on initial contact you have information X".
 * Numbers follow 2-4-17 (separate digits; "niner"). See docs/PHRASEOLOGY-AUDIT.md.
 */
import type { Atis, Weather } from '../sim/types';
import { ceilingCategory, ceilingFt, visibilityCategory, windMagnetic } from './metar';

export type ActiveRunways = Atis['activeRunways'];

export interface SimulatedAtis extends Atis {
  icao: string;
  /** Phonetic word for `letter`, e.g. "Alpha". */
  phonetic: string;
  /** "HHMM" UTC the broadcast was recorded. */
  timeZulu: string;
  spokenText: string;
  /** Prominent label the UI must show with the text. */
  simulatedLabel: string;
  /** Snapshot of the weather this ATIS was generated from (for `atisNeedsUpdate`). */
  weather: Weather;
  approachesInUse: string[];
  notams: string[];
  fieldElevationFt: number;
}

export interface GenerateAtisInput {
  airportName: string;
  icao: string;
  weather: Weather;
  /** East-positive magnetic variation (KACY = -10). */
  variationDeg: number;
  activeRunways: ActiveRunways;
  letter: string;
  /** UTC time of the broadcast: a Date, epoch ms, or an "HHMM" string. */
  timeUtc: Date | number | string;
  /**
   * Approaches in use, each phrased as it should be spoken including the word
   * "approach", e.g. "ILS runway 13 approach". If omitted: VFR -> visual
   * approach on each landing runway, otherwise ILS.
   */
  approachesInUse?: string[];
  notams?: string[];
  /**
   * Add "Read back all runway hold short instructions." (7110.65 2-9-3; the KACY airport diagram requires readback of
   * all runway holding instructions). Default true.
   */
  holdShortReadback?: boolean;
  elevationFt: number;
  /** Simulation clock seconds at issue (stored as `issuedAtSec`). Default 0. */
  issuedAtSec?: number;
}

export const PHONETIC_ALPHABET = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India',
  'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo',
  'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey', 'X-ray', 'Yankee', 'Zulu',
] as const;

export function phoneticForLetter(letter: string): string {
  const i = letter.toUpperCase().charCodeAt(0) - 65;
  return PHONETIC_ALPHABET[i] ?? PHONETIC_ALPHABET[0];
}

/** Next ATIS information letter: A -> B ... Z -> A. Invalid input restarts at A. */
export function nextAtisLetter(prev: string | undefined): string {
  if (!prev || !/^[A-Za-z]$/.test(prev.trim())) return 'A';
  const i = prev.trim().toUpperCase().charCodeAt(0) - 65;
  return String.fromCharCode(65 + ((i + 1) % 26));
}

export function simulatedLabelFor(icao: string): string {
  return `SIMULATED – not the real ${icao} ATIS`;
}

// ---------------------------------------------------------------------------
// Number / phrase rendering
// ---------------------------------------------------------------------------

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];

/** "220" -> "two two zero"; "9" -> "niner"; "." -> "point"; "-" -> "minus". */
export function spokenDigits(s: string | number): string {
  return String(s)
    .split('')
    .map((ch) => {
      if (/\d/.test(ch)) return DIGIT_WORDS[Number(ch)];
      if (ch === '.') return 'point';
      if (ch === '-') return 'minus';
      return ch;
    })
    .join(' ');
}

/** Altimeter 29.92 -> "two niner niner two" (decimal point not spoken). */
export function spokenAltimeter(inHg: number): string {
  return spokenDigits((Math.round(inHg * 100)).toString().padStart(4, '0'));
}

/** 3800 -> "three thousand eight hundred"; 12000 -> "one two thousand"; 600 -> "six hundred". */
export function spokenAltitude(ft: number): string {
  const rounded = Math.max(0, Math.round(ft / 100) * 100);
  const thousands = Math.floor(rounded / 1000);
  const hundreds = Math.floor((rounded % 1000) / 100);
  const parts: string[] = [];
  if (thousands > 0) parts.push(`${spokenDigits(thousands)} thousand`);
  if (hundreds > 0) parts.push(`${DIGIT_WORDS[hundreds]} hundred`);
  return parts.length ? parts.join(' ') : 'zero';
}

function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }

/** Break visibility into whole miles and a reduced fraction (nearest 1/16 below 3 SM). */
function visParts(vis: number): { whole: number; num: number; den: number } {
  if (vis >= 3) return { whole: Math.round(vis), num: 0, den: 1 };
  const sixteenths = Math.round(vis * 16);
  const whole = Math.floor(sixteenths / 16);
  let num = sixteenths % 16;
  let den = 16;
  if (num > 0) { const g = gcd(num, den); num /= g; den /= g; } else den = 1;
  return { whole, num, den };
}

export function displayVisibility(vis: number): string {
  const { whole, num, den } = visParts(vis);
  if (num === 0) return String(whole);
  return whole > 0 ? `${whole} ${num}/${den}` : `${num}/${den}`;
}

const FRACTION_WORDS: Record<number, [string, string]> = {
  2: ['half', 'halves'], 4: ['quarter', 'quarters'], 8: ['eighth', 'eighths'], 16: ['sixteenth', 'sixteenths'],
};

export function spokenVisibility(vis: number): string {
  const { whole, num, den } = visParts(vis);
  if (num === 0) return spokenDigits(whole);
  const [sing, plur] = FRACTION_WORDS[den] ?? [`${den}th`, `${den}ths`];
  const frac = num === 1 ? (den === 2 ? 'one half' : `one ${sing}`) : `${spokenDigits(num)} ${plur}`;
  return whole > 0 ? `${spokenDigits(whole)} and ${frac}` : frac;
}

/** "13" -> "one three"; "22L" -> "two two left". */
export function spokenRunway(id: string): string {
  const m = /^(\d{1,2})([LRC]?)$/i.exec(id.trim());
  if (!m) return id;
  const side = { L: 'left', R: 'right', C: 'center' }[m[2].toUpperCase() as 'L' | 'R' | 'C'];
  return spokenDigits(m[1]) + (side ? ` ${side}` : '');
}

/** Make arbitrary free text (NOTAMs, approach names) TTS friendly. */
export function speakFreeText(text: string): string {
  return text
    .replace(/\b(\d{1,2})([LRC])\b/g, (_m, d: string, s: string) => spokenRunway(d + s))
    .replace(/\bILS\b/g, 'I L S')
    .replace(/\bRNAV\b/g, 'R NAV')
    .replace(/\bGPS\b/g, 'G P S')
    .replace(/\bVOR\b/g, 'V O R')
    .replace(/\bTWY\b/gi, 'taxiway')
    .replace(/\bRWY\b/gi, 'runway')
    .replace(/\bNOTAMs?\b/g, 'Notices to air missions')
    .replace(/(\d)\/(?=\d)/g, '$1 slash ')
    .replace(/\d+(?:\.\d+)?/g, (n) => spokenDigits(n))
    .replace(/[()]/g, ' ')
    .replace(/\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pad3(n: number): string { return String(n).padStart(3, '0'); }

function formatTimeZulu(t: Date | number | string): string {
  if (typeof t === 'string') {
    if (/^\d{4}$/.test(t)) return t;
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return formatTimeZulu(d);
    throw new Error(`generateAtis: invalid timeUtc "${t}"`);
  }
  const d = typeof t === 'number' ? new Date(t) : t;
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Weather phenomena wording
// ---------------------------------------------------------------------------

const DESCRIPTORS: Record<string, string> = {
  MI: 'shallow', PR: 'partial', BC: 'patches of', DR: 'low drifting', BL: 'blowing', SH: 'showers', TS: 'thunderstorm', FZ: 'freezing',
};
const PRECIP: Record<string, string> = {
  DZ: 'drizzle', RA: 'rain', SN: 'snow', SG: 'snow grains', IC: 'ice crystals', PL: 'ice pellets', GR: 'hail', GS: 'small hail', UP: 'unknown precipitation',
};
const OBSC: Record<string, string> = {
  BR: 'mist', FG: 'fog', FU: 'smoke', VA: 'volcanic ash', DU: 'dust', SA: 'sand', HZ: 'haze', PY: 'spray',
  PO: 'dust whirls', SQ: 'squalls', FC: 'funnel cloud', SS: 'sandstorm', DS: 'duststorm',
};

/** "-RA" -> "light rain"; "+TSRA" -> "thunderstorm with heavy rain"; "VCTS" -> "thunderstorm in the vicinity". */
export function describePhenomenon(token: string): string {
  let rest = token;
  let intensity = '';
  let vicinity = false;
  if (rest.startsWith('+')) { intensity = 'heavy'; rest = rest.slice(1); }
  else if (rest.startsWith('-')) { intensity = 'light'; rest = rest.slice(1); }
  else if (rest.startsWith('VC')) { vicinity = true; rest = rest.slice(2); }

  const codes: string[] = rest.match(/../g) ?? [];
  const has = (c: string) => codes.includes(c);
  const precip = codes.filter((c) => c in PRECIP).map((c) => PRECIP[c]);
  const obsc = codes.filter((c) => c in OBSC).map((c) => OBSC[c]);
  const withIntensity = (s: string) => (intensity ? `${intensity} ${s}` : s);

  let phrase: string;
  if (has('TS')) {
    phrase = precip.length ? `thunderstorm with ${withIntensity(precip.join(' and '))}` : withIntensity('thunderstorm');
  } else if (has('SH')) {
    phrase = precip.length ? withIntensity(`${precip.join(' and ')} showers`) : withIntensity('showers');
  } else {
    const descr = codes.filter((c) => c in DESCRIPTORS && c !== 'TS' && c !== 'SH').map((c) => DESCRIPTORS[c]);
    phrase = withIntensity([...descr, ...precip, ...obsc].join(' ') || token);
  }
  return vicinity ? `${phrase} in the vicinity` : phrase;
}

// ---------------------------------------------------------------------------
// Sentence assembly
// ---------------------------------------------------------------------------

interface Segment { display: string; spoken: string }

function windSegment(w: Weather, variationDeg: number): Segment {
  if (w.windSpeedKt === 0 || w.windDirDeg === 0) return { display: 'Wind calm.', spoken: 'Wind calm.' };
  const dir = windMagnetic(w, variationDeg, 10);
  const gust = w.windGustKt && w.windGustKt > w.windSpeedKt ? w.windGustKt : undefined;
  const gustD = gust ? `, gusts ${gust}` : '';
  const gustS = gust ? `, gusts ${spokenDigits(gust)}` : '';
  if (dir === 'VRB') {
    return { display: `Wind variable at ${w.windSpeedKt}${gustD}.`, spoken: `Wind variable at ${spokenDigits(w.windSpeedKt)}${gustS}.` };
  }
  const d = pad3(dir as number);
  return { display: `Wind ${d} at ${w.windSpeedKt}${gustD}.`, spoken: `Wind ${spokenDigits(d)} at ${spokenDigits(w.windSpeedKt)}${gustS}.` };
}

function visibilitySegment(w: Weather): Segment {
  const wx = w.phenomena.map(describePhenomenon);
  const tail = wx.length ? `, ${wx.join(', ')}` : '';
  return {
    display: `Visibility ${displayVisibility(w.visibilitySm)}${tail}.`,
    spoken: `Visibility ${spokenVisibility(w.visibilitySm)}${tail}.`,
  };
}

function skySegment(w: Weather): Segment {
  const layers = w.clouds
    .filter((c) => c.cover !== 'SKC' && c.cover !== 'CLR')
    .slice()
    .sort((a, b) => a.baseFtAgl - b.baseFtAgl);
  if (layers.length === 0) return { display: 'Sky clear.', spoken: 'Sky clear.' };

  const disp: string[] = [];
  const spok: string[] = [];
  let ceilingGiven = false;
  for (const l of layers) {
    const hD = String(Math.round(l.baseFtAgl / 100) * 100);
    const hS = spokenAltitude(l.baseFtAgl);
    switch (l.cover) {
      case 'FEW': disp.push(`few clouds at ${hD}`); spok.push(`few clouds at ${hS}`); break;
      case 'SCT': disp.push(`scattered clouds at ${hD}`); spok.push(`scattered clouds at ${hS}`); break;
      case 'BKN':
      case 'OVC': {
        const word = l.cover === 'BKN' ? 'broken' : 'overcast';
        if (!ceilingGiven) {
          ceilingGiven = true;
          disp.push(`ceiling ${hD} ${word}`); spok.push(`ceiling ${hS} ${word}`);
        } else { disp.push(`${word} ${hD}`); spok.push(`${word} ${hS}`); }
        break;
      }
      case 'VV':
        ceilingGiven = true;
        disp.push(`sky obscured, vertical visibility ${hD}`); spok.push(`sky obscured, vertical visibility ${hS}`);
        break;
      default: break;
    }
  }
  return { display: `Sky condition ${disp.join(', ')}.`, spoken: `Sky condition ${spok.join(', ')}.` };
}

function tempSegment(w: Weather): Segment {
  const fmtD = (t: number) => (t < 0 ? `minus ${Math.abs(Math.round(t))}` : String(Math.round(t)));
  const fmtS = (t: number) => (t < 0 ? `minus ${spokenDigits(Math.abs(Math.round(t)))}` : spokenDigits(Math.round(t)));
  return {
    display: `Temperature ${fmtD(w.temperatureC)}, dew point ${fmtD(w.dewpointC)}.`,
    spoken: `Temperature ${fmtS(w.temperatureC)}, dew point ${fmtS(w.dewpointC)}.`,
  };
}

function altimeterSegment(w: Weather): Segment {
  return {
    display: `Altimeter ${w.altimeterInHg.toFixed(2)}.`,
    spoken: `Altimeter ${spokenAltimeter(w.altimeterInHg)}.`,
  };
}

function uniq(a: readonly string[]): string[] { return [...new Set(a)]; }

function defaultApproaches(w: Weather, landing: readonly string[]): string[] {
  return uniq(landing).map((r) => (w.flightCategory === 'VFR' ? `visual approach runway ${r}` : `ILS runway ${r} approach`));
}

function runwayList(ids: string[], speak: boolean): string {
  const names = ids.map((r) => (speak ? spokenRunway(r) : r));
  const word = ids.length > 1 ? 'runways' : 'runway';
  return `${word} ${names.join(' and ')}`;
}

/** True when one of the approach phrases already names runway `rwy` ("ILS runway 13 approach"). */
function approachNamesRunway(approaches: readonly string[], rwy: string): boolean {
  const re = new RegExp(`\\brunway\\s+${rwy}\\b`, 'i');
  return approaches.some((a) => re.test(a));
}

/**
 * 7110.65 2-9-3: the approach in use names the landing runway ("specify landing runway/s unless the runway is that to
 * which the instrument approach is made") and the departure runway is "given only if different from landing runway/s".
 * Returns '' when nothing needs to be added after the approach statement.
 */
function runwaySegment(active: ActiveRunways, speak: boolean, approaches: readonly string[]): string {
  const land = uniq(active.landing);
  const dep = uniq(active.departing);
  if (land.length === 0 && dep.length === 0) return 'Runway information not available.';
  const same = land.length > 0 && land.length === dep.length && land.every((r) => dep.includes(r));
  const unnamed = land.filter((r) => !approachNamesRunway(approaches, r));
  if (same && unnamed.length === land.length) return `Landing and departing ${runwayList(land, speak)}.`;
  const parts: string[] = [];
  if (unnamed.length) parts.push(`Landing ${runwayList(unnamed, speak)}`);
  if (dep.length && !same) parts.push(`${parts.length ? 'departing' : 'Departing'} ${runwayList(dep, speak)}`);
  return parts.length ? `${parts.join(', ')}.` : '';
}

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

/** Generate a simulated ATIS broadcast for the given weather and runway configuration. */
export function generateAtis(input: GenerateAtisInput): SimulatedAtis {
  const { icao, weather, variationDeg, activeRunways } = input;
  const letter = (input.letter || 'A').trim().toUpperCase().charAt(0) || 'A';
  const phonetic = phoneticForLetter(letter);
  const timeZulu = formatTimeZulu(input.timeUtc);
  const name = /airport$/i.test(input.airportName.trim()) ? input.airportName.trim() : `${input.airportName.trim()} Airport`;
  const approaches = input.approachesInUse?.length ? input.approachesInUse : defaultApproaches(weather, activeRunways.landing);
  const notams = (input.notams ?? []).map((n) => n.trim().replace(/[.\s]+$/, '')).filter(Boolean);

  const disp: string[] = [];
  const spok: string[] = [];
  const push = (s: Segment) => { disp.push(s.display); spok.push(s.spoken); };

  disp.push(`${name} information ${phonetic}, ${timeZulu} Zulu.`);
  spok.push(`${name} information ${phonetic}, ${spokenDigits(timeZulu)} Zulu.`);
  push(windSegment(weather, variationDeg));
  push(visibilitySegment(weather));
  push(skySegment(weather));
  push(tempSegment(weather));
  push(altimeterSegment(weather));
  if (approaches.length) {
    const joined = approaches.join(' and ');
    disp.push(`${capitalize(joined)} in use.`);
    spok.push(`${capitalize(speakFreeText(joined))} in use.`);
  }
  const rwyDisp = runwaySegment(activeRunways, false, approaches);
  const rwySpok = runwaySegment(activeRunways, true, approaches);
  if (rwyDisp) { disp.push(rwyDisp); spok.push(rwySpok); }
  if (notams.length) {
    disp.push(`NOTAMs: ${notams.join('. ')}.`);
    spok.push(`Notices to air missions: ${notams.map(speakFreeText).join('. ')}.`);
  }
  if (input.holdShortReadback ?? true) {
    disp.push('Read back all runway hold short instructions.');
    spok.push('Read back all runway hold short instructions.');
  }
  disp.push(`Advise on initial contact you have information ${phonetic}.`);
  spok.push(`Advise on initial contact you have information ${phonetic}.`);

  return {
    letter,
    phonetic,
    icao,
    timeZulu,
    text: disp.join(' '),
    spokenText: spok.join(' '),
    issuedAtSec: input.issuedAtSec ?? 0,
    activeRunways: { departing: [...activeRunways.departing], landing: [...activeRunways.landing] },
    simulated: true,
    simulatedLabel: simulatedLabelFor(icao),
    weather: structuredClone(weather),
    approachesInUse: approaches,
    notams,
    fieldElevationFt: input.elevationFt,
  };
}

// ---------------------------------------------------------------------------
// Update criteria
// ---------------------------------------------------------------------------

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

const hasThunder = (w: Weather) => w.phenomena.some((p) => p.includes('TS'));

/**
 * Reasons a new ATIS letter is warranted. Criteria: wind direction change >= 30
 * deg (ignored while both calm), wind speed (steady or gust) change >= 5 kt,
 * altimeter change >= 0.02 inHg, visibility or ceiling crossing a flight
 * category boundary, thunderstorm appearing/disappearing, or a runway change.
 */
export function atisUpdateReasons(
  prev: Pick<SimulatedAtis, 'weather' | 'activeRunways'>,
  next: Weather,
  nextRunways?: ActiveRunways,
): string[] {
  const p = prev.weather;
  const reasons: string[] = [];

  const pv = p.windDirDeg === 'VRB';
  const nv = next.windDirDeg === 'VRB';
  const bothCalm = p.windSpeedKt === 0 && next.windSpeedKt === 0;
  if (!bothCalm) {
    if (pv !== nv) reasons.push('wind direction (variable)');
    else if (!pv && !nv && angleDiff(p.windDirDeg as number, next.windDirDeg as number) >= 30) reasons.push('wind direction');
  }
  if (Math.abs(p.windSpeedKt - next.windSpeedKt) >= 5) reasons.push('wind speed');
  const pg = p.windGustKt ?? p.windSpeedKt;
  const ng = next.windGustKt ?? next.windSpeedKt;
  if (Math.abs(pg - ng) >= 5 && !reasons.includes('wind speed')) reasons.push('wind gusts');
  if (Math.round(Math.abs(p.altimeterInHg - next.altimeterInHg) * 100) >= 2) reasons.push('altimeter');
  if (visibilityCategory(p.visibilitySm) !== visibilityCategory(next.visibilitySm)) reasons.push('visibility category');
  if (ceilingCategory(ceilingFt(p.clouds)) !== ceilingCategory(ceilingFt(next.clouds))) reasons.push('ceiling category');
  if (hasThunder(p) !== hasThunder(next)) reasons.push('thunderstorm');
  if (nextRunways && (!sameSet(prev.activeRunways.landing, nextRunways.landing) || !sameSet(prev.activeRunways.departing, nextRunways.departing))) {
    reasons.push('runway change');
  }
  return reasons;
}

/** True when the weather (or runway configuration) changed enough to issue a new ATIS letter. */
export function atisNeedsUpdate(
  prev: Pick<SimulatedAtis, 'weather' | 'activeRunways'>,
  nextWeather: Weather,
  nextRunways?: ActiveRunways,
): boolean {
  return atisUpdateReasons(prev, nextWeather, nextRunways).length > 0;
}
