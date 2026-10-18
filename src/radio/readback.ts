/**
 * Deterministic pilot phraseology: clearance readbacks (callsign LAST), pilot-initiated
 * calls (callsign FIRST), and seeded readback mistakes.
 */
import type { Aircraft, Airport, Clearance, ParkingPosition } from '../sim/types';
import { airportCallName, facilityCallName, frequencyById, frequencyByMhz, positionWord } from './frequencies';
import {
  capitalize, digitsSpoken, numberWords, phonetic, spokenAltitude, spokenFrequency, spokenFrequencyDecimal,
  spokenAirportName, spokenHeading, spokenRunway, spokenSpeed, spokenTaxiway, spokenText, titleCase,
} from './spoken';
import { cardinal } from '../sim/geo';
import { seeded01 } from '../sim/rng';
import { findNavFix } from '../sim/navigation';
import type { ApproachType } from '../sim/types';
import { isVehicleType } from '../sim/performance';
import { airTaxiReadback, overheadReadback, vehicleProceedReadback } from './specialCalls';

export interface ReadbackEnv {
  airport: Airport;
  /** Seeded random source; omitted = no errors. */
  rng?: () => number;
  /** Probability per eligible clearance of a readback mistake (default 0). */
  errorRate?: number;
  /** Share of pilots (seeded per aircraft and clearance) who leave the hold-short part out of a taxi readback (JO 7110.65 2-4-3). Default 0. */
  holdShortOmitFraction?: number;
  /** Probability of a wrong taxiway in the route read back, as a share of `errorRate`. Default 0. */
  taxiwayErrorShare?: number;
  /** Key of the seeded per-clearance draws (default: the clearance id). The engine passes the aircraft's own command ordinal, so a given seed and command sequence always draws the same, whatever else happened on the airport or when the command was sent. */
  drawKey?: string;
  /** Pilot realism (src/sim/pilotBehaviour.ts): more kinds of readback error, each with its own rate. Omitted = only the digit / taxiway / hold-short errors above. */
  realism?: ReadbackRealism;
}

/**
 * Readback error rates of one aircraft and a deterministic draw per (clearance, label) so the same seed makes the same mistakes
 * without consuming the engine's shared random stream.
 */
export interface ReadbackRealism {
  rand: (label: string) => number;
  altitude: number;
  frequency: number;
  squawk: number;
  /** Already multiplied by the student factor. */
  pattern: number;
}

export interface ReadbackError {
  /** `callsign`, `no_readback` are produced by the command executor (another aircraft answers / nobody answers); the rest here. */
  kind: 'runway' | 'heading' | 'taxiway' | 'altitude' | 'frequency' | 'squawk' | 'pattern' | 'callsign' | 'no_readback';
  /** What the pilot understood, as `ParsedCommand` fields that replace the controller's (`runwayEnd`, `route`, `headingDeg`, `altitudeFt`, `frequencyMhz`, `squawk`, `patternLeg`, `destination`...; `ifrSquawk` / `ifrAltitudeFt` / `ifrFrequencyMhz` for an IFR clearance). An uncorrected error is flown (src/sim/readbackConsequence.ts). */
  wrong?: Record<string, unknown>;
  /** What should have been read back, e.g. "runway 13" / "heading 270". */
  correct: string;
  /** What the pilot actually said, e.g. "runway 31" / "heading 260". */
  spoken: string;
}

export interface ReadbackResult {
  text: string;
  error?: ReadbackError;
  /** TAXI / TAXI_TO_PARKING: the hold-short references (runway ids as given, taxiway letters) the pilot left out of the readback. */
  omittedHoldShort?: string[];
}

/** Taxiway designators of the airport, sorted ("A", "A1", "B" ...): the pool for a wrong-taxiway readback. */
function airportTaxiways(airport: Airport): string[] {
  const set = new Set<string>();
  for (const e of airport.taxiwayGraph.edges) if (/^[A-Z]{1,2}\d{0,2}$/.test(e.taxiway)) set.add(e.taxiway);
  return [...set].sort();
}

const isRunwayRef = (r: string): boolean => /^(RWY|RUNWAY)?\s*\d/i.test(r);

/** The hold-short instructions as read back: "Hold short of runway one three, hold short of Charlie". */
export function holdShortReadbackText(hs: string[] | undefined): string {
  return (hs ?? []).map((r) => (isRunwayRef(r) ? `hold short of runway ${runwayRef(r)}` : `hold short of ${spokenTaxiway(r.replace(/^TWY\s*/i, ''))}`)).join(', ');
}

/** Spoken form of a runway reference that may be an end ("13"), a pair ("13/31") or "RWY22". */
function runwayRef(ref: string): string {
  return spokenRunway(ref);
}

/** Destination such as "RWY22" / "22" -> runway end id, else undefined. */
export function runwayFromDestination(dest: string | undefined): string | undefined {
  if (!dest) return undefined;
  const m = /^(?:RWY|RUNWAY)\s*(\d{1,2}[LRC]?)$/i.exec(dest.trim());
  if (m) return m[1].toUpperCase();
  return undefined;
}

/** "gate three" for an airline gate (digits of its id), "the ramp" for GA/FBO/other spots. */
export function spokenParking(p: ParkingPosition): string {
  if (p.category === 'airline') {
    const digits = /(\d+)/.exec(p.id)?.[1] ?? /(\d+)/.exec(p.name)?.[1];
    return digits ? `gate ${digitsSpoken(String(Number(digits)))}` : 'the gate';
  }
  return 'the ramp';
}

function viaPhrase(route?: string[]): string {
  if (!route || !route.length) return '';
  return ` via ${route.map(spokenTaxiway).join(', ')}`;
}

function holdShortPhrase(hs?: string[]): string {
  if (!hs || !hs.length) return '';
  return hs.map((r) => (isRunwayRef(r) ? `, hold short of runway ${runwayRef(r)}` : `, hold short of ${spokenTaxiway(r.replace(/^TWY\s*/i, ''))}`)).join('');
}

function allEndIds(airport: Airport): string[] {
  return airport.runways.flatMap((r) => r.ends.map((e) => e.id));
}

/** Pick a plausible wrong runway end (different from `correct`). */
function wrongRunway(correct: string, env: ReadbackEnv): string | undefined {
  const ids = allEndIds(env.airport).filter((id) => id.toUpperCase() !== correct.toUpperCase());
  if (!ids.length || !env.rng) return undefined;
  return ids[Math.min(ids.length - 1, Math.floor(env.rng() * ids.length))];
}

function wrongHeading(h: number, env: ReadbackEnv): number {
  const rng = env.rng!;
  const delta = rng() < 0.5 ? -10 : 10;
  let w = Math.round(h) + delta;
  if (w <= 0) w += 360;
  if (w > 360) w -= 360;
  return w;
}

function shouldErr(env: ReadbackEnv): boolean {
  return !!env.rng && (env.errorRate ?? 0) > 0 && env.rng() < (env.errorRate ?? 0);
}

/** One seeded draw: does the error of this label happen? */
function roll(env: ReadbackEnv, label: string, rate: number | undefined): boolean {
  return !!env.realism && !!rate && rate > 0 && env.realism.rand(label) < rate;
}

/** A different but plausible number: 1..3 steps of `step` up or down, never below `min`. */
function nudged(value: number, step: number, min: number, env: ReadbackEnv, label: string): number {
  const r = env.realism!;
  const dir = r.rand(`${label}:dir`) < 0.5 ? -1 : 1;
  const n = 1 + Math.floor(r.rand(`${label}:n`) * 3);
  const v = value + dir * n * step;
  return v >= min ? v : value + n * step;
}

/** One octal digit of a squawk code changed. */
export function wrongSquawk(code: string, env: ReadbackEnv): string {
  const r = env.realism!;
  const i = Math.min(code.length - 1, Math.floor(r.rand('sq:pos') * code.length));
  const d = Number(code[i]);
  const nd = (d + 1 + Math.floor(r.rand('sq:d') * 6)) % 8;
  return code.slice(0, i) + String(nd) + code.slice(i + 1);
}

function frequencyPhrase(c: Clearance, env: ReadbackEnv, overrideMhz?: number): string {
  const f = c.frequencyId ? frequencyById(env.airport, c.frequencyId) : c.frequencyMhz ? frequencyByMhz(env.airport, c.frequencyMhz) : undefined;
  const mhz = overrideMhz ?? c.frequencyMhz ?? f?.mhz;
  if (mhz === undefined) return 'frequency change';
  const word = f && f.position !== 'OTHER' ? positionWord(f.position) : '';
  // Ground control (121.6-121.99) is conventionally abbreviated: "Ground point niner".
  const abbreviated = f?.position === 'GND' && mhz >= 121.6 && mhz < 122 && overrideMhz === undefined;
  const freq = abbreviated ? spokenFrequencyDecimal(mhz) : spokenFrequency(mhz);
  return word ? `${word} ${freq}` : freq;
}

/**
 * Build the pilot readback for an issued clearance. The aircraft's spokenCallsign is appended last.
 * May inject a seeded mistake (runway or heading digit) which is reported in `error`.
 */
export function buildReadback(aircraft: Aircraft, c: Clearance, env: ReadbackEnv): ReadbackResult {
  const cs = aircraft.spokenCallsign;
  let error: ReadbackError | undefined;
  let omittedHoldShort: string[] | undefined;
  const runwaySpoken = (endId: string): string => {
    if (!error && shouldErr(env)) {
      const w = wrongRunway(endId, env);
      if (w) {
        error = { kind: 'runway', correct: `runway ${endId}`, spoken: `runway ${w}`, wrong: { runwayEnd: w } };
        return runwayRef(w);
      }
    }
    return runwayRef(endId);
  };
  const body = ((): string => {
    switch (c.kind) {
      case 'TAKEOFF':
        // Helicopter takeoff from a helipad / taxiway / present position (JO 7110.65 3-11-2; AIM 4-3-17: "CLEARED FOR TAKEOFF FROM (taxiway, helipad, runway number, etc.)")
        if (!c.runwayEnd && !c.runwayId) return `Cleared for takeoff${c.destination ? ` from ${helipadWords(env, c.destination)}` : ' from present position'}${c.turnDirection ? `, make ${c.turnDirection} turn` : ''}`;
        // Departure heading with the takeoff clearance (JO 7110.65 5-8-2): read back first, as it is given ("Heading one eight zero, runway one three,
        // cleared for takeoff"); AIM 4-4-7 b lists headings and runway assignments among the elements to read back. A digit slip is drawn before the
        // runway's, so the one error per readback can fall on the heading.
        if (c.headingDeg !== undefined && c.runwayEnd) {
          let spoken = spokenHeading(c.headingDeg);
          if (!error && shouldErr(env)) {
            const wh = wrongHeading(c.headingDeg, env);
            error = { kind: 'heading', correct: `heading ${spokenHeading(c.headingDeg)}`, spoken: `heading ${spokenHeading(wh)}`, wrong: { headingDeg: wh } };
            spoken = spokenHeading(wh);
          }
          const dir = c.turnDirection === 'left' ? 'Left heading' : c.turnDirection === 'right' ? 'Right heading' : 'Heading';
          return `${dir} ${spoken}, runway ${runwaySpoken(c.runwayEnd ?? c.runwayId ?? '')}, cleared for takeoff`;
        }
        return `Runway ${runwaySpoken(c.runwayEnd ?? c.runwayId ?? '')}, cleared for takeoff`;
      case 'LAND':
        if (!c.runwayEnd && !c.runwayId && c.destination) return `Cleared to land ${helipadWords(env, c.destination)}`; // helicopter landing clearance (3-11-6)
        // land and hold short (JO 7110.65 3-10-5; AIM 4-3-11: the readback includes "hold short of ...")
        return `Runway ${runwaySpoken(c.runwayEnd ?? c.runwayId ?? '')}, cleared to land${c.holdShort?.length ? `, hold short of runway ${runwayRef(c.holdShort[0])}` : ''}`;
      case 'LINE_UP_AND_WAIT':
        return `Runway ${runwaySpoken(c.runwayEnd ?? c.runwayId ?? '')}, line up and wait`;
      case 'TAXI':
      case 'TAXI_TO_PARKING': {
        const rwy = c.runwayEnd ?? runwayFromDestination(c.destination);
        const verb = isVehicleType(aircraft.type) ? 'proceed' : 'taxi'; // vehicles are told to "proceed", never "taxi" (JO 7110.65 3-7-2)
        let head: string;
        if (rwy) head = isVehicleType(aircraft.type) ? `Proceed to runway ${runwaySpoken(rwy)}` : `Runway ${runwaySpoken(rwy)}, taxi`; // 7110.65 3-7-2: RUNWAY (number), TAXI VIA ...
        else if (c.destination) {
          const up = c.destination.toUpperCase();
          const twy = /^TWY\s*([A-Z]{1,2}\d{0,2})$/.exec(up)?.[1];
          const park = env.airport.parking.find((p) => p.id.toUpperCase() === up || p.name.toUpperCase() === up);
          head = `${capitalize(verb)} to ${park ? spokenParking(park) : twy ? spokenTaxiway(twy) : spokenText(c.destination)}`;
        }
        else head = c.kind === 'TAXI_TO_PARKING' ? `${capitalize(verb)} to parking` : capitalize(verb);
        let route = c.route;
        // A wrong taxiway in the route read back (seeded from the aircraft, so the shared random stream is untouched).
        if (!error && route?.length && env.rng && (env.errorRate ?? 0) > 0 && (env.taxiwayErrorShare ?? 0) > 0
          && seeded01(aircraft.seed, `twy-err:${env.drawKey ?? c.id}`) < (env.errorRate ?? 0) * (env.taxiwayErrorShare ?? 0)) {
          const pool = airportTaxiways(env.airport).filter((t) => !route!.some((x) => x.toUpperCase() === t));
          if (pool.length) {
            const idx = Math.min(route.length - 1, Math.floor(seeded01(aircraft.seed, `twy-idx:${env.drawKey ?? c.id}`) * route.length));
            const wrong = pool[Math.min(pool.length - 1, Math.floor(seeded01(aircraft.seed, `twy-wrong:${env.drawKey ?? c.id}`) * pool.length))];
            error = { kind: 'taxiway', correct: `via ${route.map(spokenTaxiway).join(', ')}`, spoken: `via ${route.map((t, k) => spokenTaxiway(k === idx ? wrong : t)).join(', ')}`, wrong: { route: route.map((t, k) => (k === idx ? wrong : t)) } };
            route = route.map((t, k) => (k === idx ? wrong : t));
          }
        }
        // Some pilots leave the hold-short out of the readback; the controller must obtain it (JO 7110.65 2-4-3, 3-7-2).
        const omit = !!c.holdShort?.some(isRunwayRef) && (env.holdShortOmitFraction ?? 0) > 0 && seeded01(aircraft.seed, `hs-omit:${env.drawKey ?? c.id}`) < (env.holdShortOmitFraction ?? 0);
        if (omit) omittedHoldShort = [...c.holdShort!];
        // A progressive-taxi step (JO 7110.65 3-7-2 "continue taxiing via ..."; AIM 4-3-18) is read back as it was given: "Left on Bravo", "continue to
        // Charlie". Several steps and a hold short of one transmission are joined into ONE readback by `addReadbackFragment` (sim/radioDiscipline.ts).
        if (c.kind === 'TAXI' && c.segment) {
          const twyDest = /^TWY\s*([A-Z]{1,2}\d{0,2})$/.exec((c.destination ?? '').toUpperCase())?.[1];
          const turn = c.turnTaxiway ? `${c.turnDirection ? `${capitalize(c.turnDirection)} on` : 'Taxi via'} ${spokenTaxiway(c.turnTaxiway)}` : '';
          const onward = twyDest ? `${turn ? 'continue' : 'Continue'}${route?.length ? ` via ${route.map(spokenTaxiway).join(', ')}` : ''} to ${spokenTaxiway(twyDest)}` : '';
          const seg = [turn, onward].filter(Boolean).join(', ');
          if (seg) return `${seg}${omit ? '' : holdShortPhrase(c.holdShort)}`;
        }
        return `${head}${viaPhrase(route)}${omit ? '' : holdShortPhrase(c.holdShort)}`;
      }
      case 'HOLD_POSITION':
        return 'Holding position';
      case 'HOLD_SHORT': {
        const ref = (c.holdShort && c.holdShort[0]) ?? c.runwayId ?? c.runwayEnd ?? '';
        return /^(RWY|RUNWAY)?\s*\d/i.test(ref) ? `Hold short of runway ${runwayRef(ref)}` : `Hold short of ${spokenTaxiway(ref.replace(/^TWY\s*/i, ''))}`;
      }
      case 'CROSS_RUNWAY':
        return `Cross runway ${runwaySpoken(c.runwayId ?? c.runwayEnd ?? '')}`;
      case 'GO_AROUND':
        return 'Going around';
      case 'CONTINUE_APPROACH':
        return 'Continuing approach';
      case 'CONTACT_FREQUENCY': {
        const right = frequencyPhrase(c, env);
        const mhz = c.frequencyMhz ?? (c.frequencyId ? frequencyById(env.airport, c.frequencyId)?.mhz : undefined);
        if (!error && mhz !== undefined && roll(env, 'freq', env.realism?.frequency)) {
          const wrong = Math.round(nudged(Math.round(mhz * 10), 1, 1080, env, 'freq') ) / 10;
          const bad = frequencyPhrase(c, env, wrong);
          error = { kind: 'frequency', correct: right, spoken: bad, wrong: { frequencyMhz: wrong } };
          return bad;
        }
        return right;
      }
      case 'HEADING': {
        const h = c.headingDeg ?? 0;
        let spoken = spokenHeading(h);
        if (shouldErr(env)) {
          const wh = wrongHeading(h, env);
          error = { kind: 'heading', correct: `heading ${spokenHeading(h)}`, spoken: `heading ${spokenHeading(wh)}`, wrong: { headingDeg: wh } };
          spoken = spokenHeading(wh);
        }
        const dir = c.turnDirection === 'left' ? 'Left heading' : c.turnDirection === 'right' ? 'Right heading' : 'Heading';
        return `${dir} ${spoken}`;
      }
      case 'ALTITUDE': {
        const target = c.altitudeFt ?? 0;
        const verb = Math.abs(target - aircraft.altitudeFt) < 100 ? 'Maintain' : target > aircraft.altitudeFt ? 'Climb and maintain' : 'Descend and maintain';
        if (!error && roll(env, 'alt', env.realism?.altitude)) {
          const wrong = nudged(target, 1000, 500, env, 'alt');
          error = { kind: 'altitude', correct: spokenAltitude(target), spoken: spokenAltitude(wrong), wrong: { altitudeFt: wrong } };
          return `${verb} ${spokenAltitude(wrong)}`;
        }
        return `${verb} ${spokenAltitude(target)}`;
      }
      case 'SPEED':
        return `Speed ${spokenSpeed(c.speedKt ?? 0)}`;
      case 'ENTER_PATTERN': {
        const rwy = runwayRef(c.runwayEnd ?? c.runwayId ?? '');
        const leg =
          c.patternLeg === 'left_downwind' ? 'Left downwind' : c.patternLeg === 'right_downwind' ? 'Right downwind' : c.patternLeg === 'base' ? 'Base' : 'Straight in';
        if (!error && roll(env, 'pat', env.realism?.pattern)) {
          const options = ['Left downwind', 'Right downwind', 'Base', 'Straight in'].filter((o) => o !== leg);
          const bad = options[Math.min(options.length - 1, Math.floor(env.realism!.rand('pat:pick') * options.length))];
          error = { kind: 'pattern', correct: `${leg} runway ${rwy}`, spoken: `${bad} runway ${rwy}`, wrong: { patternLeg: { 'Left downwind': 'left_downwind', 'Right downwind': 'right_downwind', Base: 'base', 'Straight in': 'straight_in' }[bad] } };
          return `${bad} runway ${rwy}`;
        }
        return `${leg} runway ${rwy}`;
      }
      case 'PUSHBACK':
        return c.pushTailDeg !== undefined ? `Pushing back, tail ${cardinal(c.pushTailDeg)}` : c.pushFaceDeg !== undefined ? `Pushing back, facing ${cardinal(c.pushFaceDeg)}` : 'Pushing back';
      case 'IFR_CLEARANCE': {
        const ifr = c.ifr;
        if (ifr && !error) {
          if (roll(env, 'sq', env.realism?.squawk)) {
            const bad = wrongSquawk(ifr.squawk, env);
            error = { kind: 'squawk', correct: digitsSpoken(ifr.squawk), spoken: digitsSpoken(bad), wrong: { ifrSquawk: bad } };
            return ifrClearanceReadback({ ...c, ifr: { ...ifr, squawk: bad } });
          }
          if (roll(env, 'alt', env.realism?.altitude)) {
            const bad = nudged(ifr.initialAltitudeFt, 1000, 1000, env, 'alt');
            error = { kind: 'altitude', correct: spokenAltitude(ifr.initialAltitudeFt), spoken: spokenAltitude(bad), wrong: { ifrAltitudeFt: bad } };
            return ifrClearanceReadback({ ...c, ifr: { ...ifr, initialAltitudeFt: bad } });
          }
          if (roll(env, 'freq', env.realism?.frequency)) {
            const bad = Math.round(nudged(Math.round(ifr.departureFrequencyMhz * 10), 1, 1080, env, 'freq')) / 10;
            error = { kind: 'frequency', correct: spokenFrequency(ifr.departureFrequencyMhz), spoken: spokenFrequency(bad), wrong: { ifrFrequencyMhz: bad } };
            return ifrClearanceReadback({ ...c, ifr: { ...ifr, departureFrequencyMhz: bad } });
          }
        }
        return ifrClearanceReadback(c);
      }
      case 'APPROACH': {
        const rwy = runwaySpoken(c.runwayEnd ?? c.runwayId ?? '');
        return c.approachType === 'VISUAL' ? `Cleared visual approach runway ${rwy}` : `Cleared ${approachWord(c.approachType)} runway ${rwy} approach`;
      }
      case 'DIRECT_FIX':
        return `Direct ${spokenFix(env.airport, c.fix ?? '')}`;
      case 'RESUME_OWN_NAVIGATION':
        return 'Resuming own navigation';
      case 'RADAR_CONTACT':
        return ''; // informational: the pilot does not read it back
      case 'HOLD_AT_FIX':
        return holdReadback(env.airport, c);
      case 'MISSED_APPROACH':
        return 'Executing the published missed approach';
      case 'STAR': {
        // 7110.65 4-7-1: "(STAR name and number) ARRIVAL, (transition name) TRANSITION"; 4-5-7: "DESCEND VIA the (STAR) ARRIVAL"
        const name = spokenStarName(env.airport, c.starName);
        const trans = c.starTransition ? `, ${spokenFix(env.airport, c.starTransition)} transition` : '';
        return c.descendVia ? `Descend via the ${name} arrival${trans}` : `Cleared ${name} arrival${trans}`;
      }
      case 'ADVISORY':
        return c.advisory === 'BIRDS' ? "Roger, we'll watch for the birds" : 'Roger';
      case 'RUNWAY_LIGHTS':
        return 'Roger, thank you';
      case 'EXIT_RUNWAY':
        return exitReadback(c);
      case 'CANCEL_TAKEOFF':
        return 'Cancelling takeoff clearance, stopping';
      case 'TURN_AROUND':
        return 'Making a one eighty';
      case 'TRAFFIC_ADVISORY':
        return c.trafficResponse === 'in_sight' ? 'Traffic in sight' : c.trafficResponse === 'looking' ? 'Looking for traffic' : 'Negative contact';
      case 'FOLLOW_TRAFFIC': {
        const n = c.sequenceNumber !== undefined ? `Number ${numberWords(c.sequenceNumber)}, ` : '';
        return `Traffic in sight, ${n}will follow`;
      }
      case 'PATTERN_INSTRUCTION': {
        const right = patternInstructionReadback(c);
        if (!error && roll(env, 'pat', env.realism?.pattern)) {
          const options = ['Extending downwind', 'Turning base', 'Short approach', 'Left three sixty'].filter((o) => o !== right);
          const bad = options[Math.min(options.length - 1, Math.floor(env.realism!.rand('pat:pick') * options.length))];
          error = { kind: 'pattern', correct: right, spoken: bad, wrong: bad === 'Extending downwind' ? { destination: 'EXTEND_DOWNWIND' } : bad === 'Turning base' ? { destination: 'TURN_BASE_NOW' } : bad === 'Short approach' ? { destination: 'SHORT_APPROACH' } : { destination: 'CIRCLE', turnDirection: 'left', turnDegrees: 360 } };
          return bad;
        }
        return right;
      }
      case 'REPORT_POSITION':
        return c.destination === 'REPORT_MIDFIELD_DOWNWIND'
          ? 'Will report midfield downwind'
          : c.destination === 'REPORT_BASE'
            ? 'Will report base'
            : c.distanceNm !== undefined ? `Will report ${numberWords(c.distanceNm)} mile final` : 'Will report final';
      case 'FREQUENCY_CHANGE_APPROVED':
        return 'Frequency change approved, good day';
      case 'SQUAWK': {
        const code = c.squawk ?? '1200';
        if (!error && roll(env, 'sq', env.realism?.squawk)) {
          const bad = wrongSquawk(code, env);
          error = { kind: 'squawk', correct: digitsSpoken(code), spoken: digitsSpoken(bad), wrong: { squawk: bad } };
          return `Squawk ${digitsSpoken(bad)}`;
        }
        return `Squawk ${digitsSpoken(code)}`;
      }
      case 'PROCEED':
        return vehicleProceedReadback({ taxiways: c.destination === 'TAXIWAYS', runwayEnd: c.runwayEnd ?? c.runwayId ?? '', reportClear: c.reportClear, reportInspection: c.reportClear && c.destination === 'INSPECTION' });
      case 'AIR_TAXI':
        return airTaxiReadback({ mode: c.taxiMode, route: c.route, where: c.destination ? helipadWords(env, c.destination) : 'as requested' });
      case 'OVERHEAD':
        return overheadReadback({ runwayEnd: c.runwayEnd ?? c.runwayId ?? '', altitudeFt: c.altitudeFt, turnDirection: c.turnDirection, reports: c.destination === 'BREAK' ? ['initial', 'break'] : ['initial'] });
      case 'AIRPORT_INFO':
        return c.info?.altimeterInHg !== undefined ? `Altimeter ${digitsSpoken(String(Math.round(c.info.altimeterInHg * 100)))}` : 'Roger';
      default:
        return 'Roger';
    }
  })();
  const result: ReadbackResult = { text: body === '' ? '' : `${body}, ${cs}` };
  if (error) result.error = error;
  if (omittedHoldShort) result.omittedHoldShort = omittedHoldShort;
  return result;
}

/** Spoken name of a helicopter destination: a parking id ("USCG-1" -> "Coast Guard helipad one"), a taxiway ("TWY A") or free text. */
function helipadWords(env: ReadbackEnv, dest: string): string {
  const up = dest.toUpperCase();
  const park = env.airport.parking.find((p) => p.id.toUpperCase() === up || p.name.toUpperCase() === up);
  if (park) return park.id.startsWith('USCG') ? spokenText(park.name.replace(/^USCG/i, 'Coast Guard')) : spokenText(park.name);
  const twy = /^TWY\s*([A-Z]{1,2}\d{0,2})$/.exec(up)?.[1];
  if (twy) return `taxiway ${spokenTaxiway(twy)}`;
  const rwy = runwayFromDestination(dest);
  if (rwy) return `runway ${runwayRef(rwy)}`;
  return spokenText(dest);
}

/** Pilot readback of a runway exit instruction (JO 7110.65 3-10-9: "TURN LEFT/RIGHT (taxiway)", "IF ABLE, TURN LEFT/RIGHT (taxiway)"). */
function exitReadback(c: Clearance): string {
  if (c.destination === 'END') return 'Continuing to the end';
  const twy = c.exitTaxiway ? spokenTaxiway(c.exitTaxiway) : undefined;
  const where = twy ? `at ${twy}` : 'next taxiway';
  const verb = c.turnDirection ? `turn ${c.turnDirection}` : 'exit';
  const head = c.ifAble ? `Will ${verb} ${where} if able` : `${capitalize(verb)} ${where}`;
  return head;
}

function patternInstructionReadback(c: Clearance): string {
  switch (c.destination) {
    case 'EXTEND_DOWNWIND':
      return 'Extending downwind';
    case 'TURN_BASE_NOW':
      return 'Turning base';
    case 'SHORT_APPROACH':
      return 'Short approach';
    case 'CIRCLE':
      return `${capitalize(c.turnDirection ?? 'left')} ${c.turnDegrees === 270 ? 'two seventy' : 'three sixty'}`;
    case 'CLOSED_TRAFFIC':
      return `${c.turnDirection ? `${capitalize(c.turnDirection)} c` : 'C'}losed traffic`;
    default:
      return 'Roger';
  }
}

/** Cleared for a touch-and-go but too little runway is left for the type's takeoff distance: the pilot makes a full stop. */
export function touchAndGoRefusedCall(aircraft: Aircraft, env: ReadbackEnv): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, unable touch and go, not enough runway, full stop.`;
}

/** Landing roll: the pilot cannot make the instructed exit (the call is made on touchdown). */
export function exitUnableCall(aircraft: Aircraft, env: ReadbackEnv, wanted: { taxiway?: string; side?: 'left' | 'right'; toEnd?: boolean }, actual?: string): string {
  const what = wanted.taxiway ? ` ${spokenTaxiway(wanted.taxiway)}` : wanted.toEnd ? ' to the end' : ' that exit';
  const then = actual ? `, will exit at ${spokenTaxiway(actual)}` : ', will exit when able';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, unable${what}${then}.`;
}

/** "ILS", "localizer", "RNAV", "VOR" as spoken in an approach clearance. */
export function approachWord(type: ApproachType | undefined): string {
  return type === 'LOC' ? 'localizer' : type === 'VISUAL' ? 'visual' : (type ?? 'ILS');
}

/**
 * "Hold east of SMITS on the zero nine zero radial, right turns, one minute legs, expect further clearance one two four five"
 * or "Hold at SMITS as published" (callsign appended by the caller).
 */
function holdReadback(airport: Airport, c: Clearance): string {
  const h = c.hold;
  if (!h) return 'Roger';
  const fix = spokenFix(airport, h.fix);
  if (h.asPublished) return `Hold at ${fix} as published${h.efcZulu ? `, expect further clearance ${digitsSpoken(h.efcZulu)}` : ''}`;
  const parts: string[] = [];
  if (h.inboundCourseDeg !== undefined) {
    const radial = (h.inboundCourseDeg + 180) % 360;
    parts.push(`Hold ${cardinal(radial)} of ${fix} on the ${spokenHeading(radial)} radial`);
  } else parts.push(`Hold at ${fix}`);
  parts.push(`${h.turns} turns`);
  if (h.legNm !== undefined) parts.push(`${numberWords(Math.round(h.legNm))} mile legs`);
  else if (h.legMinutes !== undefined) parts.push(`${h.legMinutes === 1 ? 'one' : h.legMinutes === 1.5 ? 'one and a half' : numberWords(Math.round(h.legMinutes))} minute legs`);
  if (h.efcZulu) parts.push(`expect further clearance ${digitsSpoken(h.efcZulu)}`);
  return parts.join(', ');
}

/** "ROZZE2" -> "Rozze two": the procedure's spoken name from the airport data (`InstrumentProcedure.star.spokenName`), else name + digit words. */
export function spokenStarName(airport: Airport, ident: string | undefined): string {
  const id = (ident ?? '').toUpperCase().replace(/\s+/g, '');
  const proc = airport.procedures.find((p) => p.star && (p.star.ident.toUpperCase() === id || p.star.spokenName.toUpperCase().replace(/\s+/g, '') === id));
  if (proc?.star) return titleCase(proc.star.spokenName);
  const m = /^([A-Z]+?)(\d+)$/.exec(id);
  return m ? `${titleCase(m[1])} ${digitsSpoken(m[2])}` : titleCase(id);
}

/** Navaid name when the airport data has one ("Cedar Lake"), else the identifier as written ("CARYL"). */
export function spokenFix(airport: Airport, fix: string): string {
  const n = findNavFix(airport, fix);
  return n?.name ? titleCase(n.name) : (n?.id ?? fix);
}

/**
 * "Cleared to Philadelphia airport, Atlantic City Three departure, radar vectors, maintain two thousand, expect one zero thousand,
 * one zero minutes after departure, departure frequency one two four point six, squawk four two one five" (callsign appended by the
 * caller). Forms: 7110.65 4-2-1 / 4-3-2 ("CLEARED TO (destination) AIRPORT"), 4-3-3 (expect ..., "one zero minutes after
 * departure"), 3-9-3 ("DEPARTURE FREQUENCY (frequency), SQUAWK (code)").
 */
function ifrClearanceReadback(c: Clearance): string {
  const i = c.ifr;
  if (!i) return 'Roger';
  const parts = [`Cleared to ${spokenAirportName(i.destination)} airport`];
  parts.push(i.departureProcedure ? `${titleCase(i.departureProcedure)} departure, radar vectors` : 'as filed');
  parts.push(`maintain ${spokenAltitude(i.initialAltitudeFt)}`);
  if (i.expectAltitudeFt) parts.push(`expect ${spokenAltitude(i.expectAltitudeFt)}, one zero minutes after departure`);
  parts.push(`departure frequency ${spokenFrequency(i.departureFrequencyMhz)}`);
  parts.push(`squawk ${digitsSpoken(i.squawk)}`);
  return parts.join(', ');
}

/** "Unable, <reason>, <callsign>" */
export function buildUnable(aircraft: Aircraft, reasonPhrase: string): string {
  return `Unable, ${reasonPhrase}, ${aircraft.spokenCallsign}`;
}

export function buildSayAgain(aircraft: Aircraft): string {
  return `Say again, ${aircraft.spokenCallsign}`;
}

// ---------------------------------------------------------------------------
// Pilot-initiated calls (callsign FIRST)
// ---------------------------------------------------------------------------

function facility(aircraft: Aircraft, env: ReadbackEnv): string {
  return facilityCallName(env.airport, aircraft.frequencyMhz, aircraft.frequencyId);
}

export function readyToTaxiCall(aircraft: Aircraft, env: ReadbackEnv, parking?: ParkingPosition, o: { atisLetter?: string; pushedBack?: boolean; progressive?: boolean } = {}): string {
  const where = parking ? spokenText(parking.name) : 'the ramp';
  const at = o.pushedBack ? `pushed back from ${where}` : parking ? `at ${where}` : 'on the ramp';
  const rules = aircraft.flightRules === 'IFR' ? 'IFR' : 'VFR';
  // AIM 4-3-18: aircraft identification, location, type of operation (VFR / IFR) and the point of first intended landing.
  // "with information <letter>": AIM 4-1-13 (the pilot states the ATIS code on initial contact).
  const info = o.atisLetter ? `, with information ${phonetic(o.atisLetter)}` : '';
  const prog = o.progressive ? ', request progressive taxi' : '';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, ${at}, ready to taxi, ${rules} to ${spokenAirportName(aircraft.flightPlan?.destination ?? aircraft.destination)}${info}${prog}.`;
}

/**
 * Airliner at its gate asks to push back. NOT FAA phraseology: JO 7110.65 has no pushback phrase (pushback is normally a ramp / company
 * function; the simulator lets Ground approve it). Form: callsign, location, request, destination and ATIS code as in AIM 4-3-18 / 4-1-13.
 */
export function pushbackRequestCall(aircraft: Aircraft, env: ReadbackEnv, parking?: ParkingPosition, o: { atisLetter?: string; repeat?: boolean } = {}): string {
  const at = parking ? `at ${spokenText(parking.name)}` : 'at the gate';
  const rules = aircraft.flightRules === 'IFR' ? 'IFR' : 'VFR';
  const info = o.atisLetter ? `, with information ${phonetic(o.atisLetter)}` : '';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, ${at}, ${o.repeat ? 'still requesting pushback' : 'request pushback'}, ${rules} to ${spokenAirportName(aircraft.flightPlan?.destination ?? aircraft.destination)}${info}.`;
}

/** The pilot of a taxi instruction without a route asks for it. "Say route" is plain language (JO 7110.65 has no phrase for the request). */
export function sayRouteCall(aircraft: Aircraft, runwayEnd: string | undefined): string {
  return `${runwayEnd ? `Runway ${runwayRef(runwayEnd)}, ` : ''}say route, ${aircraft.spokenCallsign}`;
}

/** The pilot stopped short of an unconfirmed hold-short and asks for the instruction again (plain language; JO 7110.65 2-4-3, 3-7-2). */
export function holdShortQueryCall(aircraft: Aircraft, env: ReadbackEnv, o: { where?: string } = {}): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, holding position${o.where ? ` at ${o.where}` : ''}, say again hold short instructions.`;
}

/** Progressive taxi: the pilot has reached the end of the segment and waits for the next one (AIM 4-3-18; plain language). */
export function nextSegmentCall(aircraft: Aircraft, env: ReadbackEnv, taxiway?: string): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, ${taxiway ? `at ${spokenTaxiway(taxiway)}, ` : ''}request next progressive taxi instructions.`;
}

export function holdingShortCall(aircraft: Aircraft, env: ReadbackEnv, runwayEnd: string, readyForDeparture: boolean, o: { requestFullLengthAt?: string } = {}): string {
  if (o.requestFullLengthAt) {
    return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, holding short runway ${runwayRef(runwayEnd)} at ${spokenTaxiway(o.requestFullLengthAt)}, unable intersection departure, request full length.`;
  }
  const tail = readyForDeparture ? ', ready for departure' : '';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, holding short runway ${runwayRef(runwayEnd)}${tail}.`;
}

/** Check-in on Tower while still taxiing to the hold: "Atlantic City Tower, Cessna 723, approaching the hold runway one three, ready for departure." */
export function approachingHoldCall(aircraft: Aircraft, env: ReadbackEnv, runwayEnd: string): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, approaching the hold runway ${runwayRef(runwayEnd)}, ready for departure.`;
}

export function holdingShortCrossingCall(aircraft: Aircraft, env: ReadbackEnv, runwayId: string, taxiway?: string): string {
  const at = taxiway ? ` at ${spokenTaxiway(taxiway)}` : '';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, holding short of runway ${runwayRef(runwayId)}${at}.`;
}

export function inboundCall(aircraft: Aircraft, env: ReadbackEnv, o: { distanceNm: number; bearingFromAirportDeg: number; atisLetter?: string }): string {
  const n = Math.max(1, Math.round(o.distanceNm));
  const miles = `${digitsSpoken(String(n))} ${n === 1 ? 'mile' : 'miles'}`; // 7110.65 2-4-17: separate digits of the mileage
  const info = o.atisLetter ? ` with information ${phonetic(o.atisLetter)}` : '';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, ${miles} ${cardinal(o.bearingFromAirportDeg)}, inbound for landing${info}.`;
}

export function finalCall(aircraft: Aircraft, env: ReadbackEnv, runwayEnd: string, distanceNm: number): string {
  const n = Math.max(1, Math.round(distanceNm));
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, ${digitsSpoken(String(n))} mile final runway ${runwayRef(runwayEnd)}, full stop.`;
}

export function goingAroundCall(aircraft: Aircraft, env: ReadbackEnv, runwayEnd: string, reason?: string, o: { published?: boolean } = {}): string {
  // At the decision altitude without the runway in sight the pilot says "going missed approach".
  const head = reason === 'runway not in sight' ? `going missed approach, ${reason}` : `going around runway ${runwayRef(runwayEnd)}${reason ? `, ${reason}` : ''}`;
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, ${head}${o.published ? ', flying the published missed approach' : ''}.`;
}

export function goAroundEstablishedCall(aircraft: Aircraft, env: ReadbackEnv, altitudeFt: number, o: { vectors?: boolean; published?: boolean } = {}): string {
  if (o.published) {
    return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, flying the published missed approach, level ${spokenAltitude(altitudeFt)}, request frequency change.`;
  }
  const ask = o.vectors ? 'request vectors for another approach' : 'request another approach';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, runway heading, level ${spokenAltitude(altitudeFt)}, ${ask}.`;
}

export function clearOfRunwayCall(aircraft: Aircraft, env: ReadbackEnv, runwayRef_: string, taxiway?: string): string {
  const at = taxiway ? ` at ${spokenTaxiway(taxiway)}` : '';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, clear of runway ${runwayRef(runwayRef_)}${at}.`;
}

export function requestFrequencyChangeCall(aircraft: Aircraft, env: ReadbackEnv): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, request frequency change.`;
}

/** Initial call after a frequency change (airborne: "level <altitude>", AIM 5-3-1). */
export function checkInCall(aircraft: Aircraft, env: ReadbackEnv, o: { taxiway?: string; wantsTaxiToParking?: boolean; taxiBackRunway?: string } = {}): string {
  const f = facility(aircraft, env);
  if (aircraft.onGround) {
    const at = o.taxiway ? `, at ${spokenTaxiway(o.taxiway)}` : '';
    const ask = o.taxiBackRunway ? `, request taxi back to runway ${runwayRef(o.taxiBackRunway)} for departure` : o.wantsTaxiToParking ? ', request taxi to parking' : '';
    return `${f}, ${aircraft.spokenCallsign}${at}${ask}.`;
  }
  const alt = spokenAltitude(Math.round(aircraft.altitudeFt / 100) * 100);
  return `${f}, ${aircraft.spokenCallsign}, level ${alt}.`;
}

// --- IFR calls ---------------------------------------------------------------

/** Clearance Delivery request: "Atlantic City Clearance, Spirit four fifty one, IFR to Philadelphia, with information bravo, ready to copy." */
export function ifrClearanceRequestCall(aircraft: Aircraft, env: ReadbackEnv, o: { destination: string; atisLetter?: string }): string {
  const info = o.atisLetter ? `, with information ${phonetic(o.atisLetter)}` : '';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, IFR to ${spokenAirportName(o.destination)}${info}, ready to copy.`;
}

/** First call of an arrival that enters the area at a fix: "Atlantic City Approach, Spirit four fifty one, five thousand, information bravo." */
export function approachCheckInCall(aircraft: Aircraft, env: ReadbackEnv, o: { altitudeFt: number; atisLetter?: string }): string {
  const info = o.atisLetter ? `, information ${phonetic(o.atisLetter)}` : '';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, level ${spokenAltitude(Math.round(o.altitudeFt / 100) * 100)}${info}.`;
}

/** IFR departure checking in with Departure: "Atlantic City Departure, Spirit four fifty one, one thousand two hundred climbing two thousand." */
export function departureCheckInCall(aircraft: Aircraft, env: ReadbackEnv, o: { targetAltitudeFt?: number } = {}): string {
  const alt = spokenAltitude(Math.round(aircraft.altitudeFt / 100) * 100);
  const climbing = o.targetAltitudeFt !== undefined && o.targetAltitudeFt > aircraft.altitudeFt + 100;
  // AIM 5-3-1 / 5-2-9: "leaving (exact altitude), climbing to (altitude)"
  return climbing
    ? `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, leaving ${alt}, climbing to ${spokenAltitude(o.targetAltitudeFt!)}.`
    : `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, level ${alt}.`;
}

/** After landing on a wet or contaminated runway: "Manchester Tower, Southwest 123, braking action medium." (terms of JO 7110.65 3-3-4). */
export function brakingActionCall(aircraft: Aircraft, env: ReadbackEnv, term: string): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, braking action ${term}.`;
}

/**
 * "Manchester Tower, Southwest 123, request lights up." JO 7110.65 3-4-10 d / 3-4-11 allow a pilot request for the runway light intensity;
 * the manual prescribes no phraseology for the request, so this is plain English (no invented phraseology beyond "request").
 */
export function lightsRequestCall(aircraft: Aircraft, env: ReadbackEnv, direction: 'up' | 'down'): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, request lights ${direction}.`;
}

/**
 * Stopped short of a taxiway that closed after the taxi instruction: "Atlantic City Ground, Cessna one two three, holding short of Bravo, taxiway
 * closed, request taxi instructions." NON-STANDARD plain English: JO 7110.65 3-7-2 gives no pilot phraseology for this; the content (where, why,
 * what is wanted) follows the position / request order of AIM 4-3-18.
 */
export function closedTaxiwayHoldCall(aircraft: Aircraft, env: ReadbackEnv, taxiway: string): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, holding short of ${spokenTaxiway(taxiway)}, taxiway closed, request taxi instructions.`;
}

/** Established on the approach course while still on the Approach frequency (asks for the tower). */
export function establishedCall(aircraft: Aircraft, env: ReadbackEnv, o: { type?: ApproachType; runwayEnd: string }): string {
  const what = o.type === 'VISUAL' ? 'visual approach' : approachWord(o.type);
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, established on the ${what} runway ${runwayRef(o.runwayEnd)}.`;
}

/** Arrival checking in with Tower after the Approach handoff. */
export function arrivalTowerCheckInCall(aircraft: Aircraft, env: ReadbackEnv, o: { distanceNm: number; runwayEnd: string }): string {
  const n = Math.min(99, Math.max(1, Math.round(o.distanceNm)));
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, ${digitsSpoken(String(n))} mile final runway ${runwayRef(o.runwayEnd)}, full stop.`;
}

/**
 * Arrival checking in with Approach after a missed approach / go-around. With the published missed approach:
 * "missed approach, climbing two thousand, direct SMITS, request further clearance" (or "holding at SMITS" once established).
 */
export function missedApproachCheckInCall(aircraft: Aircraft, env: ReadbackEnv, o: { published?: { climbToFt: number; fix: string; holding: boolean } } = {}): string {
  const f = facility(aircraft, env);
  const pub = o.published;
  if (!pub) return `${f}, ${aircraft.spokenCallsign}, missed approach, ${spokenAltitude(Math.round(aircraft.altitudeFt / 100) * 100)}.`;
  const where = spokenFix(env.airport, pub.fix);
  const what = pub.holding
    ? `holding at ${where}, ${spokenAltitude(Math.round(aircraft.altitudeFt / 100) * 100)}`
    : `climbing ${spokenAltitude(pub.climbToFt)}, direct ${where}`;
  return `${f}, ${aircraft.spokenCallsign}, missed approach, ${what}, request further clearance.`;
}

export function stoppedOnRunwayCall(aircraft: Aircraft, env: ReadbackEnv, runwayId: string): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, stopped on runway ${runwayRef(runwayId)}, unable to exit, request taxi instructions.`;
}

/** After a rejected takeoff (JO 7110.65 3-9-11): the pilot reports stopped. Wording is the pilot's own; 7110.65 gives the controller phrase only. */
export function stoppedAfterRejectCall(aircraft: Aircraft, env: ReadbackEnv, runwayEnd: string): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, stopped on runway ${runwayRef(runwayEnd)}, holding position.`;
}

/**
 * Position reports requested by the controller (JO 7110.65 3-10-1: "requests for additional position reports", 3-10-11 "REPORT (position)"):
 * midfield downwind, turning base, N-mile final.
 */
export function positionReportCall(aircraft: Aircraft, env: ReadbackEnv, kind: 'MIDFIELD_DOWNWIND' | 'BASE' | 'FINAL', runwayEnd: string, o: { side?: 'left' | 'right'; distanceNm?: number } = {}): string {
  const f = facility(aircraft, env);
  const cs = aircraft.spokenCallsign;
  const rwy = runwayRef(runwayEnd);
  if (kind === 'MIDFIELD_DOWNWIND') return `${f}, ${cs}, midfield ${o.side ?? 'left'} downwind runway ${rwy}.`;
  if (kind === 'BASE') return `${f}, ${cs}, ${o.side ?? 'left'} base runway ${rwy}.`;
  const n = Math.max(1, Math.round(o.distanceNm ?? 1));
  return `${f}, ${cs}, ${digitsSpoken(String(n))} mile final runway ${rwy}.`;
}

/** The pilot acquires traffic he was looking for (JO 7110.65 7-2-1: "report traffic in sight") or loses it ("negative contact", P/CG). */
export function trafficAcquiredCall(aircraft: Aircraft, env: ReadbackEnv, sighted: boolean): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, ${sighted ? 'traffic in sight' : 'negative contact'}.`;
}

/** A pilot who did not report the ATIS code asks for the numbers (JO 7110.65 3-9-1 / 3-10-1: runway, wind, altimeter unless the code or "have numbers" is given). */
export function requestNumbersCall(aircraft: Aircraft, env: ReadbackEnv): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, request wind and altimeter.`;
}

/** Line up and wait for more than 90 s (JO 7110.65 3-9-4 NOTE): the pilot asks what to do. */
export function luawIntentionsCall(aircraft: Aircraft, env: ReadbackEnv, runwayEnd: string): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, holding in position runway ${runwayRef(runwayEnd)}, say intentions.`;
}

export { capitalize, airportCallName };
