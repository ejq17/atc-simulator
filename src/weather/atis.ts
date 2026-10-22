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
 * runway, closures / NOTAMs / bird activity, braking action advisories and the latest braking action report, runway condition codes,
 * the hold-short readback statement, then "Advise on initial contact you have information X". RVR (2-8-2, 2-8-3) follows the
 * visibility ("transmit these values in the normal sequence used for weather reporting").
 * Numbers follow 2-4-17 (separate digits; "niner"). See docs/PHRASEOLOGY-AUDIT.md.
 */
import type { Atis, BrakingTerm, Weather } from '../sim/types';
import { inHgToHpa, qnhDigits, visibilityMetres, visibilityText } from './units';
import { ceilingCategory, ceilingFt, visibilityCategory, windMagnetic } from './metar';
import { termRank } from './runwayCondition';
import { isNewObservation } from './observation';
import { rvrPhrase } from './rvr';
import type { RvrReport } from './rvr';

export type ActiveRunways = Atis['activeRunways'];

/** Airport-state content of an ATIS (see `src/sim/airportOps.ts`); every field optional. */
export interface AtisOps {
  /** Closures in force (2-9-3: "taxiway closures which affect the entrance or exit of active runways, other closures"). */
  closures?: { kind: 'RUNWAY' | 'TAXIWAY'; ident: string }[];
  /** RVR for the runway(s) in use (2-8-2 / 2-8-3), only where required. */
  rvr?: { runwayEnd: string; report: RvrReport }[];
  /** Runway condition codes (RwyCC) as the airport operator reports them (2-9-3, 3-3-1): one code per runway end, same for the three thirds here. */
  rwyCondition?: { runwayEnd: string; code: number; atUtc: string }[];
  /** "Braking Action Advisories are in effect" (3-3-5). */
  brakingAdvisories?: boolean;
  /** Latest pilot braking action report (3-3-4 wording: "Braking action medium, reported by a Boeing Seven Thirty-Seven"). */
  braking?: { term: BrakingTerm; aircraftSpoken: string };
  /** Bird activity (2-1-23, 2-9-3): detail clause ("flocks of geese, altitude unknown"), '' for the bare advisory. */
  birds?: string;
}

/** What the ATIS said about the airport state, kept for `atisUpdateReasons` (2-9-2: new recording on new or canceled NOTAMs, worse braking action). */
export interface AtisOpsSnapshot {
  closures: string[];
  brakingTerm?: BrakingTerm;
  brakingAdvisories: boolean;
  birds: boolean;
  rwyCondition: string;
}

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
  ops: AtisOpsSnapshot;
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
  /** 'hPa' (EGLL): QNH in hectopascals, visibility in metres, UK ATIS wording (see `src/weather/units.ts`). Default 'inHg'. */
  altimeterUnit?: 'inHg' | 'hPa';
  /**
   * Add "Read back all runway hold short instructions." (7110.65 2-9-3; the KACY airport diagram requires readback of
   * all runway holding instructions). Default true.
   */
  holdShortReadback?: boolean;
  /** Closures, RVR, braking action, runway condition codes and bird activity (see `AtisOps`). */
  ops?: AtisOps;
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

function visibilitySegment(w: Weather, metric = false): Segment {
  const wx = w.phenomena.map(describePhenomenon);
  const tail = wx.length ? `, ${wx.join(', ')}` : '';
  if (metric) {
    const v = visibilityMetres(w.visibilitySm);
    return { display: `Visibility ${visibilityText(w.visibilitySm)}${tail}.`, spoken: `Visibility ${v.tenKmOrMore ? 'ten kilometres or more' : `${spokenDigits(v.metres)} metres`}${tail}.` };
  }
  return {
    display: `Visibility ${displayVisibility(w.visibilitySm)}${tail}.`,
    spoken: `Visibility ${spokenVisibility(w.visibilitySm)}${tail}.`,
  };
}

function rvrSegment(ops: AtisOps | undefined): Segment | undefined {
  if (!ops?.rvr?.length) return undefined;
  const parts = ops.rvr.map((r) => rvrPhrase(r.runwayEnd, r.report));
  return { display: parts.map((p) => p.display).join(' '), spoken: parts.map((p) => p.spoken).join(' ') };
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

function altimeterSegment(w: Weather, hpa = false): Segment {
  if (hpa) return { display: `QNH ${inHgToHpa(w.altimeterInHg)}.`, spoken: `QNH ${spokenDigits(qnhDigits(w.altimeterInHg))}.` };
  return {
    display: `Altimeter ${w.altimeterInHg.toFixed(2)}.`,
    spoken: `Altimeter ${spokenAltimeter(w.altimeterInHg)}.`,
  };
}

function uniq(a: readonly string[]): string[] { return [...new Set(a)]; }

/** "Runway 4/22 closed" / spoken "Runway four slash two two closed"; "Taxiway B closed" / "Taxiway Bravo closed" (2-4-16 phonetics). */
function closureSegment(c: { kind: 'RUNWAY' | 'TAXIWAY'; ident: string }): Segment {
  if (c.kind === 'RUNWAY') return { display: `Runway ${c.ident} closed`, spoken: `Runway ${c.ident.split('/').map((e) => spokenRunway(e)).join(' slash ')} closed` };
  return { display: `Taxiway ${c.ident} closed`, spoken: `Taxiway ${c.ident.replace(/[A-Za-z]/g, (ch) => ` ${phoneticForLetter(ch)} `).replace(/\d/g, (d) => ` ${DIGIT_WORDS[Number(d)]} `).replace(/\s+/g, ' ').trim()} closed` };
}

/** "Runway one three condition codes five, five, five at one three five two Zulu" (2-9-3; the three thirds carry the same code here). */
function rwyCcSegment(r: { runwayEnd: string; code: number; atUtc: string }): Segment {
  const c = `${r.code}, ${r.code}, ${r.code}`;
  const cs = `${spokenDigits(r.code)}, ${spokenDigits(r.code)}, ${spokenDigits(r.code)}`;
  return { display: `Runway ${r.runwayEnd} condition codes ${c} at ${r.atUtc} Zulu.`, spoken: `Runway ${spokenRunway(r.runwayEnd)} condition codes ${cs} at ${spokenDigits(r.atUtc)} Zulu.` };
}

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
  const name = input.altimeterUnit === 'hPa' || /airport$/i.test(input.airportName.trim()) ? input.airportName.trim() : `${input.airportName.trim()} Airport`;
  const approaches = input.approachesInUse?.length ? input.approachesInUse : defaultApproaches(weather, activeRunways.landing);
  const notams = (input.notams ?? []).map((n) => n.trim().replace(/[.\s]+$/, '')).filter(Boolean);

  const disp: string[] = [];
  const spok: string[] = [];
  const push = (s: Segment) => { disp.push(s.display); spok.push(s.spoken); };

  disp.push(`${name} information ${phonetic}, ${timeZulu} Zulu.`);
  spok.push(`${name} information ${phonetic}, ${spokenDigits(timeZulu)} Zulu.`);
  push(windSegment(weather, variationDeg));
  const hpa = input.altimeterUnit === 'hPa';
  push(visibilitySegment(weather, hpa));
  const rvr = rvrSegment(input.ops);
  if (rvr) push(rvr);
  push(skySegment(weather));
  push(tempSegment(weather));
  push(altimeterSegment(weather, hpa));
  if (approaches.length) {
    const joined = approaches.join(' and ');
    disp.push(`${capitalize(joined)} in use.`);
    spok.push(`${capitalize(speakFreeText(joined))} in use.`);
  }
  const rwyDisp = runwaySegment(activeRunways, false, approaches);
  const rwySpok = runwaySegment(activeRunways, true, approaches);
  if (rwyDisp) { disp.push(rwyDisp); spok.push(rwySpok); }
  const closures = (input.ops?.closures ?? []).map(closureSegment);
  if (closures.length || notams.length) {
    disp.push(`NOTAMs: ${[...closures.map((c) => c.display), ...notams].join('. ')}.`);
    spok.push(`Notices to air missions: ${[...closures.map((c) => c.spoken), ...notams.map(speakFreeText)].join('. ')}.`);
  }
  if (input.ops?.birds !== undefined) {
    const detail = input.ops.birds ? `, ${input.ops.birds}` : '';
    disp.push(`Bird activity in the vicinity of the airport${detail}.`);
    spok.push(`Bird activity in the vicinity of the airport${detail}.`);
  }
  if (input.ops?.brakingAdvisories) {
    disp.push('Braking action advisories are in effect.');
    spok.push('Braking action advisories are in effect.');
  }
  if (input.ops?.braking) {
    const b = `Braking action ${input.ops.braking.term}, reported by ${input.ops.braking.aircraftSpoken}.`;
    disp.push(b);
    spok.push(b);
  }
  for (const r of input.ops?.rwyCondition ?? []) {
    const seg = rwyCcSegment(r);
    disp.push(seg.display);
    spok.push(seg.spoken);
  }
  if (!hpa && (input.holdShortReadback ?? true)) {
    disp.push('Read back all runway hold short instructions.');
    spok.push('Read back all runway hold short instructions.');
  }
  if (hpa) {
    // CAP 413 4.214: the UK ATIS example ends "Acknowledge receipt of information Alpha on first contact with <unit>"; the pilot quotes the
    // letter with type, stand and QNH on first contact with Heathrow Delivery (AD 2.20 para 2)
    disp.push(`Acknowledge receipt of information ${phonetic} on first contact.`);
    spok.push(`Acknowledge receipt of information ${phonetic} on first contact.`);
  } else {
    disp.push(`Advise on initial contact you have information ${phonetic}.`);
    spok.push(`Advise on initial contact you have information ${phonetic}.`);
  }

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
    ops: opsSnapshot(input.ops),
  };
}

export function opsSnapshot(ops: AtisOps | undefined): AtisOpsSnapshot {
  return {
    closures: (ops?.closures ?? []).map((c) => `${c.kind}:${c.ident}`).sort(),
    brakingTerm: ops?.braking?.term,
    brakingAdvisories: !!ops?.brakingAdvisories,
    birds: ops?.birds !== undefined,
    rwyCondition: (ops?.rwyCondition ?? []).map((r) => `${r.runwayEnd}:${r.code}`).sort().join(','),
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
  prev: Pick<SimulatedAtis, 'weather' | 'activeRunways'> & { ops?: AtisOpsSnapshot },
  next: Weather,
  nextRunways?: ActiveRunways,
  nextOps?: AtisOps,
): string[] {
  const p = prev.weather;
  const reasons: string[] = [];
  if (isNewObservation(p, next)) reasons.push('new weather observation');

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
  if (nextOps && prev.ops) {
    const n = opsSnapshot(nextOps);
    const o = prev.ops;
    if (n.closures.join(',') !== o.closures.join(',')) reasons.push('closures (NOTAMs)');
    if (n.brakingTerm !== undefined && (o.brakingTerm === undefined || termRank(n.brakingTerm) < termRank(o.brakingTerm))) reasons.push('braking action worse');
    else if (n.brakingAdvisories !== o.brakingAdvisories) reasons.push('braking action advisories');
    if (n.birds !== o.birds) reasons.push('bird activity');
    if (n.rwyCondition !== o.rwyCondition) reasons.push('runway condition codes');
  }
  return reasons;
}

/** True when the weather (or runway configuration) changed enough to issue a new ATIS letter. */
export function atisNeedsUpdate(
  prev: Pick<SimulatedAtis, 'weather' | 'activeRunways'> & { ops?: AtisOpsSnapshot },
  nextWeather: Weather,
  nextRunways?: ActiveRunways,
  nextOps?: AtisOps,
): boolean {
  return atisUpdateReasons(prev, nextWeather, nextRunways, nextOps).length > 0;
}
