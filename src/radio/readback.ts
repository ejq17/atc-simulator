/**
 * Deterministic pilot phraseology: clearance readbacks (callsign LAST), pilot-initiated
 * calls (callsign FIRST), and seeded readback mistakes.
 */
import type { Aircraft, Airport, Clearance, ParkingPosition } from '../sim/types';
import { airportCallName, facilityCallName, frequencyById, frequencyByMhz, positionWord } from './frequencies';
import {
  capitalize, digitsSpoken, numberWords, phonetic, spokenAltitude, spokenFrequency, spokenFrequencyDecimal,
  spokenHeading, spokenRunway, spokenSpeed, spokenTaxiway, spokenText,
} from './spoken';
import { cardinal } from '../sim/geo';

export interface ReadbackEnv {
  airport: Airport;
  /** Seeded random source; omitted = no errors. */
  rng?: () => number;
  /** Probability per eligible clearance of a readback mistake (default 0). */
  errorRate?: number;
}

export interface ReadbackError {
  kind: 'runway' | 'heading';
  /** What should have been read back, e.g. "runway 13" / "heading 270". */
  correct: string;
  /** What the pilot actually said, e.g. "runway 31" / "heading 260". */
  spoken: string;
}

export interface ReadbackResult {
  text: string;
  error?: ReadbackError;
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
  return hs.map((r) => `, hold short of runway ${runwayRef(r)}`).join('');
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

function frequencyPhrase(c: Clearance, env: ReadbackEnv): string {
  const f = c.frequencyId ? frequencyById(env.airport, c.frequencyId) : c.frequencyMhz ? frequencyByMhz(env.airport, c.frequencyMhz) : undefined;
  const mhz = c.frequencyMhz ?? f?.mhz;
  if (mhz === undefined) return 'frequency change';
  const word = f && f.position !== 'OTHER' ? positionWord(f.position) : '';
  // Ground control (121.6-121.99) is conventionally abbreviated: "Ground point niner".
  const abbreviated = f?.position === 'GND' && mhz >= 121.6 && mhz < 122;
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
  const runwaySpoken = (endId: string): string => {
    if (!error && shouldErr(env)) {
      const w = wrongRunway(endId, env);
      if (w) {
        error = { kind: 'runway', correct: `runway ${endId}`, spoken: `runway ${w}` };
        return runwayRef(w);
      }
    }
    return runwayRef(endId);
  };
  const body = ((): string => {
    switch (c.kind) {
      case 'TAKEOFF':
        return `Runway ${runwaySpoken(c.runwayEnd ?? c.runwayId ?? '')}, cleared for takeoff`;
      case 'LAND':
        return `Runway ${runwaySpoken(c.runwayEnd ?? c.runwayId ?? '')}, cleared to land`;
      case 'LINE_UP_AND_WAIT':
        return `Runway ${runwaySpoken(c.runwayEnd ?? c.runwayId ?? '')}, line up and wait`;
      case 'TAXI':
      case 'TAXI_TO_PARKING': {
        const rwy = c.runwayEnd ?? runwayFromDestination(c.destination);
        let head: string;
        if (rwy) head = `Runway ${runwaySpoken(rwy)}`;
        else if (c.destination) {
          const up = c.destination.toUpperCase();
          const park = env.airport.parking.find((p) => p.id.toUpperCase() === up || p.name.toUpperCase() === up);
          head = `Taxi to ${park ? spokenParking(park) : spokenText(c.destination)}`;
        }
        else head = c.kind === 'TAXI_TO_PARKING' ? 'Taxi to parking' : 'Taxi';
        return `${head}${viaPhrase(c.route)}${holdShortPhrase(c.holdShort)}`;
      }
      case 'HOLD_POSITION':
        return 'Holding position';
      case 'HOLD_SHORT':
        return `Hold short of runway ${runwayRef((c.holdShort && c.holdShort[0]) ?? c.runwayId ?? c.runwayEnd ?? '')}`;
      case 'CROSS_RUNWAY':
        return `Cross runway ${runwaySpoken(c.runwayId ?? c.runwayEnd ?? '')}`;
      case 'GO_AROUND':
        return 'Going around';
      case 'CONTINUE_APPROACH':
        return 'Continuing approach';
      case 'CONTACT_FREQUENCY':
        return frequencyPhrase(c, env);
      case 'HEADING': {
        const h = c.headingDeg ?? 0;
        let spoken = spokenHeading(h);
        if (shouldErr(env)) {
          const wh = wrongHeading(h, env);
          error = { kind: 'heading', correct: `heading ${spokenHeading(h)}`, spoken: `heading ${spokenHeading(wh)}` };
          spoken = spokenHeading(wh);
        }
        const dir = c.turnDirection === 'left' ? 'Left heading' : c.turnDirection === 'right' ? 'Right heading' : 'Heading';
        return `${dir} ${spoken}`;
      }
      case 'ALTITUDE': {
        const target = c.altitudeFt ?? 0;
        const verb = Math.abs(target - aircraft.altitudeFt) < 100 ? 'Maintain' : target > aircraft.altitudeFt ? 'Climb and maintain' : 'Descend and maintain';
        return `${verb} ${spokenAltitude(target)}`;
      }
      case 'SPEED':
        return `Speed ${spokenSpeed(c.speedKt ?? 0)}`;
      case 'ENTER_PATTERN': {
        const rwy = runwayRef(c.runwayEnd ?? c.runwayId ?? '');
        const leg =
          c.patternLeg === 'left_downwind' ? 'Left downwind' : c.patternLeg === 'right_downwind' ? 'Right downwind' : c.patternLeg === 'base' ? 'Base' : 'Straight in';
        return `${leg} runway ${rwy}`;
      }
      case 'PUSHBACK':
        return 'Pushing back';
      default:
        return 'Roger';
    }
  })();
  const result: ReadbackResult = { text: `${body}, ${cs}` };
  if (error) result.error = error;
  return result;
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
  return facilityCallName(env.airport, aircraft.frequencyMhz);
}

export function readyToTaxiCall(aircraft: Aircraft, env: ReadbackEnv, parking?: ParkingPosition): string {
  const at = parking ? `at ${spokenText(parking.name)}` : 'on the ramp';
  const rules = aircraft.flightRules === 'IFR' ? 'IFR' : 'VFR';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, ${at}, ready to taxi, ${rules} departure.`;
}

export function holdingShortCall(aircraft: Aircraft, env: ReadbackEnv, runwayEnd: string, readyForDeparture: boolean): string {
  const tail = readyForDeparture ? ', ready for departure' : '';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, holding short runway ${runwayRef(runwayEnd)}${tail}.`;
}

export function holdingShortCrossingCall(aircraft: Aircraft, env: ReadbackEnv, runwayId: string, taxiway?: string): string {
  const at = taxiway ? ` at ${spokenTaxiway(taxiway)}` : '';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, holding short of runway ${runwayRef(runwayId)}${at}.`;
}

export function inboundCall(aircraft: Aircraft, env: ReadbackEnv, o: { distanceNm: number; bearingFromAirportDeg: number; atisLetter?: string }): string {
  const n = Math.max(1, Math.round(o.distanceNm));
  const miles = `${n < 100 ? numberWords(n) : digitsSpoken(String(n))} ${n === 1 ? 'mile' : 'miles'}`;
  const info = o.atisLetter ? ` with information ${phonetic(o.atisLetter)}` : '';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, ${miles} ${cardinal(o.bearingFromAirportDeg)}, inbound for landing${info}.`;
}

export function finalCall(aircraft: Aircraft, env: ReadbackEnv, runwayEnd: string, distanceNm: number): string {
  const n = Math.max(1, Math.round(distanceNm));
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, ${numberWords(n)} mile final runway ${runwayRef(runwayEnd)}, full stop.`;
}

export function goingAroundCall(aircraft: Aircraft, env: ReadbackEnv, runwayEnd: string, reason?: string): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, going around runway ${runwayRef(runwayEnd)}${reason ? `, ${reason}` : ''}.`;
}

export function goAroundEstablishedCall(aircraft: Aircraft, env: ReadbackEnv, altitudeFt: number): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, runway heading, level ${spokenAltitude(altitudeFt)}, request another approach.`;
}

export function clearOfRunwayCall(aircraft: Aircraft, env: ReadbackEnv, runwayRef_: string, taxiway?: string): string {
  const at = taxiway ? ` at ${spokenTaxiway(taxiway)}` : '';
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, clear of runway ${runwayRef(runwayRef_)}${at}.`;
}

export function requestFrequencyChangeCall(aircraft: Aircraft, env: ReadbackEnv): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, request frequency change.`;
}

/** Initial call after a frequency change. */
export function checkInCall(aircraft: Aircraft, env: ReadbackEnv, o: { taxiway?: string; wantsTaxiToParking?: boolean } = {}): string {
  const f = facility(aircraft, env);
  if (aircraft.onGround) {
    const at = o.taxiway ? `, at ${spokenTaxiway(o.taxiway)}` : '';
    return `${f}, ${aircraft.spokenCallsign}${at}${o.wantsTaxiToParking ? ', request taxi to parking' : ''}.`;
  }
  const alt = spokenAltitude(Math.round(aircraft.altitudeFt / 100) * 100);
  return `${f}, ${aircraft.spokenCallsign}, passing ${alt}.`;
}

export function stoppedOnRunwayCall(aircraft: Aircraft, env: ReadbackEnv, runwayId: string): string {
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, stopped on runway ${runwayRef(runwayId)}, unable to exit, request taxi instructions.`;
}

export { capitalize, airportCallName };
