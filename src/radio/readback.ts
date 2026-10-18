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
import { findNavFix } from '../sim/navigation';
import type { ApproachType } from '../sim/types';

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
  return hs.map((r) => (/^(RWY|RUNWAY)?\s*\d/i.test(r) ? `, hold short of runway ${runwayRef(r)}` : `, hold short of ${spokenTaxiway(r.replace(/^TWY\s*/i, ''))}`)).join('');
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
        // land and hold short (JO 7110.65 3-10-5; AIM 4-3-11: the readback includes "hold short of ...")
        return `Runway ${runwaySpoken(c.runwayEnd ?? c.runwayId ?? '')}, cleared to land${c.holdShort?.length ? `, hold short of runway ${runwayRef(c.holdShort[0])}` : ''}`;
      case 'LINE_UP_AND_WAIT':
        return `Runway ${runwaySpoken(c.runwayEnd ?? c.runwayId ?? '')}, line up and wait`;
      case 'TAXI':
      case 'TAXI_TO_PARKING': {
        const rwy = c.runwayEnd ?? runwayFromDestination(c.destination);
        let head: string;
        if (rwy) head = `Runway ${runwaySpoken(rwy)}, taxi`; // 7110.65 3-7-2: RUNWAY (number), TAXI VIA ...
        else if (c.destination) {
          const up = c.destination.toUpperCase();
          const twy = /^TWY\s*([A-Z]{1,2}\d{0,2})$/.exec(up)?.[1];
          const park = env.airport.parking.find((p) => p.id.toUpperCase() === up || p.name.toUpperCase() === up);
          head = `Taxi to ${park ? spokenParking(park) : twy ? spokenTaxiway(twy) : spokenText(c.destination)}`;
        }
        else head = c.kind === 'TAXI_TO_PARKING' ? 'Taxi to parking' : 'Taxi';
        return `${head}${viaPhrase(c.route)}${holdShortPhrase(c.holdShort)}`;
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
      case 'IFR_CLEARANCE':
        return ifrClearanceReadback(c);
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
      case 'TRAFFIC_ADVISORY':
        return c.trafficResponse === 'in_sight' ? 'Traffic in sight' : c.trafficResponse === 'looking' ? 'Looking for traffic' : 'Negative contact';
      case 'FOLLOW_TRAFFIC': {
        const n = c.sequenceNumber !== undefined ? `Number ${numberWords(c.sequenceNumber)}, ` : '';
        return `Traffic in sight, ${n}will follow`;
      }
      case 'PATTERN_INSTRUCTION':
        return patternInstructionReadback(c);
      case 'REPORT_POSITION':
        return c.destination === 'REPORT_MIDFIELD_DOWNWIND'
          ? 'Will report midfield downwind'
          : c.destination === 'REPORT_BASE'
            ? 'Will report base'
            : c.distanceNm !== undefined ? `Will report ${numberWords(c.distanceNm)} mile final` : 'Will report final';
      case 'FREQUENCY_CHANGE_APPROVED':
        return 'Frequency change approved, good day';
      case 'SQUAWK':
        return `Squawk ${digitsSpoken(c.squawk ?? '1200')}`;
      case 'AIRPORT_INFO':
        return c.info?.altimeterInHg !== undefined ? `Altimeter ${digitsSpoken(String(Math.round(c.info.altimeterInHg * 100)))}` : 'Roger';
      default:
        return 'Roger';
    }
  })();
  const result: ReadbackResult = { text: body === '' ? '' : `${body}, ${cs}` };
  if (error) result.error = error;
  return result;
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

export function readyToTaxiCall(aircraft: Aircraft, env: ReadbackEnv, parking?: ParkingPosition): string {
  const at = parking ? `at ${spokenText(parking.name)}` : 'on the ramp';
  const rules = aircraft.flightRules === 'IFR' ? 'IFR' : 'VFR';
  // AIM 4-3-18: aircraft identification, location, type of operation (VFR / IFR) and the point of first intended landing
  return `${facility(aircraft, env)}, ${aircraft.spokenCallsign}, ${at}, ready to taxi, ${rules} to ${spokenAirportName(aircraft.flightPlan?.destination ?? aircraft.destination)}.`;
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
export function checkInCall(aircraft: Aircraft, env: ReadbackEnv, o: { taxiway?: string; wantsTaxiToParking?: boolean } = {}): string {
  const f = facility(aircraft, env);
  if (aircraft.onGround) {
    const at = o.taxiway ? `, at ${spokenTaxiway(o.taxiway)}` : '';
    return `${f}, ${aircraft.spokenCallsign}${at}${o.wantsTaxiToParking ? ', request taxi to parking' : ''}.`;
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
