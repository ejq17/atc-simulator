/**
 * Runway surface condition derived from the METAR present weather and temperature, and the braking action terms.
 *
 * Sources:
 *  - FAA AC 150/5200-30D, Table 5-2 "Runway Condition Assessment Matrix (RCAM)" (airport operators' assessment criteria and the
 *    pilot reported braking action column): code 6 dry; 5 wet (includes damp and 1/8 inch or less of water), 1/8 inch or less of
 *    slush / dry snow / wet snow = Good; 4 = Good to Medium; 3 = Medium (slippery when wet, dry or wet snow over 1/8 inch, ...);
 *    2 = Medium to Poor (water or slush over 1/8 inch); 1 = Poor (ice); 0 = Nil (wet ice, slush over ice, ...).
 *  - FAA JO 7110.65 3-3-4: the braking action terms "good", "good to medium", "medium", "medium to poor", "poor", "nil".
 *  - FAA JO 7110.65 3-3-5: "Braking Action Advisories are in effect" when reports of medium, poor or nil have been received or
 *    "weather conditions are conducive to deteriorating or rapidly changing runway conditions".
 *
 * SIMPLIFICATION (documented in docs/BEHAVIOUR-ACCURACY.md): the real code comes from an airport operator's assessment of contaminant
 * type and depth per runway third (AC 150/5200-30D 5.3); a METAR carries neither depth nor runway state. The simulator therefore
 * derives one code for the whole runway from the CURRENT present weather only: no precipitation = dry (6); light rain, drizzle or
 * light snow = 5; heavy rain or moderate/heavy snow with temperature above freezing = 2 (taken as more than 1/8 inch of water or
 * slush); moderate/heavy snow at or below freezing = 3 (more than 1/8 inch of dry snow); freezing rain/drizzle = 1 (ice); ice pellets
 * = 3. A runway that is wet after the rain stopped, frost, and treatment are not modelled. Precipitation reported only in the vicinity
 * (VC) does not wet the runway.
 */
import type { BrakingTerm, Weather } from '../sim/types';

export const BRAKING_TERMS: readonly BrakingTerm[] = ['good', 'good to medium', 'medium', 'medium to poor', 'poor', 'nil'];

/** RCAM code (0..5) -> pilot reported braking action term (AC 150/5200-30D Table 5-2, "Pilot Reported Braking Action"). */
export const RCAM_BRAKING_TERM: Readonly<Record<number, BrakingTerm>> = {
  5: 'good', 4: 'good to medium', 3: 'medium', 2: 'medium to poor', 1: 'poor', 0: 'nil',
};

/** Braking term -> an RCAM code in the same row (for ordering terms: 5 best, 0 worst). */
export function termRank(t: BrakingTerm): number {
  return 5 - BRAKING_TERMS.indexOf(t);
}

/** Terms that start "Braking Action Advisories are in effect" (JO 7110.65 3-3-5: medium, poor or nil; good to medium is also relayed to the operator). */
export function isAdvisoryTerm(t: BrakingTerm): boolean {
  return t === 'medium' || t === 'poor' || t === 'nil' || t === 'medium to poor';
}

export type RunwaySurface = 'dry' | 'wet' | 'slush' | 'snow' | 'ice';

export interface RunwayCondition {
  /** RCAM runway condition code 0..6 (6 = dry). */
  code: number;
  surface: RunwaySurface;
  /** Contaminant words for the log / panel ("wet", "snow over 1/8 inch"). */
  description: string;
  /** Braking action term the code corresponds to; undefined for a dry runway. */
  term?: BrakingTerm;
}

const DRY: RunwayCondition = { code: 6, surface: 'dry', description: 'dry' };

const PRECIP_CODES = ['DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP'] as const;

interface Parsed { intensity: -1 | 0 | 1; codes: string[]; vicinity: boolean }

function parseToken(token: string): Parsed {
  let rest = token.trim();
  let intensity: -1 | 0 | 1 = 0;
  let vicinity = false;
  if (rest.startsWith('+')) { intensity = 1; rest = rest.slice(1); }
  else if (rest.startsWith('-')) { intensity = -1; rest = rest.slice(1); }
  else if (rest.startsWith('VC')) { vicinity = true; rest = rest.slice(2); }
  return { intensity, codes: rest.match(/../g) ?? [], vicinity };
}

/** True when the present weather has precipitation (or a shower / thunderstorm) AT the airport. */
export function hasPrecipitation(w: Pick<Weather, 'phenomena'>): boolean {
  return w.phenomena.some((p) => {
    const t = parseToken(p);
    return !t.vicinity && (t.codes.includes('TS') || t.codes.includes('SH') || PRECIP_CODES.some((c) => t.codes.includes(c)));
  });
}

/** The RCAM condition derived from the present weather (see the SIMPLIFICATION note above). */
export function runwayCondition(w: Pick<Weather, 'phenomena' | 'temperatureC'>): RunwayCondition {
  let worst: RunwayCondition = DRY;
  const consider = (c: RunwayCondition) => { if (c.code < worst.code) worst = c; };
  for (const p of w.phenomena) {
    const t = parseToken(p);
    if (t.vicinity) continue;
    const has = (c: string) => t.codes.includes(c);
    const cold = w.temperatureC <= 0;
    if (has('FZ') && (has('RA') || has('DZ'))) { consider({ code: 1, surface: 'ice', description: 'ice (freezing precipitation)' }); continue; }
    if (has('SN') || has('SG')) {
      if (t.intensity < 0) consider({ code: 5, surface: cold ? 'snow' : 'slush', description: cold ? 'snow, 1/8 inch or less' : 'slush, 1/8 inch or less' });
      else consider(cold ? { code: 3, surface: 'snow', description: 'dry snow over 1/8 inch' } : { code: 2, surface: 'slush', description: 'slush over 1/8 inch' });
      continue;
    }
    if (has('PL')) { consider({ code: 3, surface: 'snow', description: 'ice pellets' }); continue; }
    if (has('RA') || has('DZ')) {
      consider(t.intensity > 0 ? { code: 2, surface: 'wet', description: 'water over 1/8 inch' } : { code: 5, surface: 'wet', description: 'wet' });
      continue;
    }
    if (has('TS') || has('SH') || has('GR') || has('GS') || has('UP')) consider({ code: 5, surface: 'wet', description: 'wet' });
  }
  if (worst.code < 6) worst = { ...worst, term: RCAM_BRAKING_TERM[worst.code] };
  return worst;
}

/** True when the runway is dry for LAHSO / braking purposes (no precipitation at the airport). */
export function runwayIsDry(w: Pick<Weather, 'phenomena' | 'temperatureC'>): boolean {
  return runwayCondition(w).code === 6;
}

/**
 * Whether "Braking Action Advisories are in effect" (JO 7110.65 3-3-5): a pilot report of medium, poor or nil is on file, or the
 * weather is "conducive to deteriorating or rapidly changing runway conditions" (here: precipitation with a temperature of 3 C or
 * lower, or any runway condition code of 3 or below).
 */
export function brakingAdvisoriesInEffect(w: Pick<Weather, 'phenomena' | 'temperatureC'>, reports: readonly { term: BrakingTerm }[]): boolean {
  if (reports.some((r) => r.term === 'medium' || r.term === 'medium to poor' || r.term === 'poor' || r.term === 'nil')) return true;
  const c = runwayCondition(w);
  return c.code <= 3 || (c.code < 6 && w.temperatureC <= 3);
}
