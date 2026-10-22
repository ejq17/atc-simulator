/**
 * IFR clearance helpers (Clearance Delivery): fills the elements the controller did not state from the
 * flight plan and the airport, and assigns transponder codes.
 *
 * Source of every default:
 *   destination            flightPlan.destination (a different stated destination is refused)
 *   departureProcedure     `airport.procedures` entry of type 'DP' (name without its trailing "DEPARTURE")
 *   initialAltitudeFt      the command, else the DP's maintain altitude (`defaultInitialAltitudeFt`: ATLANTIC CITY THREE 2000, MANCHESTER ONE 3000)
 *   expectAltitudeFt       the command, else flightPlan.cruiseAltitudeFt
 *   departureFrequencyMhz  the command, else the DEP frequency whose sector (RadioFrequency.sectorBearings, magnetic bearings from the
 *                          airport) contains the bearing to the first fix of the filed route, else the first DEP frequency, else APP
 *   squawk                 the command (validated), else a seeded random 4-digit octal code not in use
 */
import type { Aircraft, Airport, InstrumentProcedure, IfrClearanceDetails, ParsedCommand, SimulationState } from './types';
import type { SimContext } from './context';
import { rngInt } from './rng';
import { frequencyForPosition } from '../radio/frequencies';
import { findNavFix } from './navigation';
import { bearingDeg, trueToMagnetic } from './geo';
import type { RadioFrequency } from './types';
import { spokenAirportName } from '../radio/spoken';

/** Initial altitude when the airport's DP data states none (KACY: ATLANTIC CITY THREE says maintain 2000). */
export const DEFAULT_INITIAL_ALTITUDE_FT = 2000;

/** The altitude a clearance says to maintain: the departure procedure's own (`maintainAltitudeFt`, KMHT: 3000), else the default. */
export function defaultInitialAltitudeFt(airport: Airport, o: { runwayEnd?: string; key?: string } = {}): number {
  return departureProcedureFor(airport, o)?.maintainAltitudeFt ?? DEFAULT_INITIAL_ALTITUDE_FT;
}
export const RESERVED_SQUAWKS: ReadonlySet<string> = new Set(['0000', '1200', '7500', '7600', '7700']);

export function isAssignableSquawk(code: string): boolean {
  return /^[0-7]{4}$/.test(code) && !RESERVED_SQUAWKS.has(code);
}

export function squawksInUse(state: Pick<SimulationState, 'aircraft'>, except?: string): Set<string> {
  const used = new Set<string>();
  for (const a of Object.values(state.aircraft)) if (a.id !== except && a.squawk) used.add(a.squawk);
  return used;
}

/** Next code from the seeded stream: 4 octal digits, not reserved, not in use. */
export function assignSquawk(ctx: SimContext, exceptId?: string): string {
  const used = squawksInUse(ctx.state, exceptId);
  for (let i = 0; i < 200; i++) {
    const code = `${rngInt(ctx.rng, 0, 7)}${rngInt(ctx.rng, 0, 7)}${rngInt(ctx.rng, 0, 7)}${rngInt(ctx.rng, 0, 7)}`;
    if (isAssignableSquawk(code) && !used.has(code)) return code;
  }
  for (let n = 0o1000; n < 0o7777; n++) {
    const code = n.toString(8).padStart(4, '0');
    if (isAssignableSquawk(code) && !used.has(code)) return code;
  }
  return '2000';
}

const SID_LETTERS: Record<string, string> = { F: 'FOXTROT', G: 'GOLF', J: 'JULIET', K: 'KILO', H: 'HOTEL', X: 'X-RAY', Y: 'YANKEE', Z: 'ZULU' };
const SID_DIGITS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];

/** UK SID designator in words: "MODMI 1J DEPARTURE (SID)" -> "MODMI ONE JULIET" (the name is spoken with its number and letter, CAP 413). */
export function spokenSidName(chartName: string, airport?: Pick<Airport, 'navaids'>): string {
  const base = chartName.replace(/\(.*?\)/g, '').replace(/\s+(DEPARTURE|DEP)\s*$/i, '').trim();
  // a SID named after a navaid ident (CPT, BPK, DET) is spoken with the navaid's name ("Compton", "Brookmans Park")
  const first = base.split(' ')[0];
  const nav = airport?.navaids.find((n) => n.id === first && n.name && n.type !== 'FIX' && n.type !== 'LOC' && n.type !== 'ILS' && n.type !== 'DME');
  const named = nav ? base.replace(first, nav.name!) : base;
  return named.replace(/\b(\d)([A-Z])\b/, (_m, d: string, l: string) => `${SID_DIGITS[Number(d)]} ${SID_LETTERS[l] ?? l}`);
}

/**
 * The departure procedure a clearance names. Airports with one DP (KACY, KMHT): that one. Airports whose DPs each serve one runway end (EGLL SIDs,
 * `InstrumentProcedure.runwayEnd`): one of the SIDs of the departure runway, chosen by a stable hash of `key` (DESIGN VALUE: the AIP gives no
 * destination-to-SID table here, so the family is not tied to the route).
 */
export function departureProcedureFor(airport: Pick<Airport, 'procedures'>, o: { runwayEnd?: string; key?: string } = {}): InstrumentProcedure | undefined {
  const dps = airport.procedures.filter((p) => p.type === 'DP');
  const byRunway = o.runwayEnd ? dps.filter((p) => p.runwayEnd === o.runwayEnd) : [];
  const pool = byRunway.length ? byRunway : dps;
  if (pool.length <= 1) return pool[0];
  let h = 0;
  for (const ch of o.key ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

/** "ATLANTIC CITY THREE DEPARTURE" -> "ATLANTIC CITY THREE". */
export function departureProcedureName(airport: Airport, o: { runwayEnd?: string; key?: string } = {}): string | undefined {
  const dp = departureProcedureFor(airport, o);
  if (!dp) return undefined;
  return dp.runwayEnd ? spokenSidName(dp.name, airport) : dp.name.replace(/\s+(DEPARTURE|DEP)\s*$/i, '').trim();
}

const stripK = (icao: string) => icao.trim().toUpperCase().replace(/^K(?=[A-Z0-9]{3}$)/, '');
export const sameAirportId = (a: string, b: string): boolean => stripK(a) === stripK(b);

/** `sayAgain`: the pilot asks for the element again ("Say again the squawk code") instead of saying "Unable". */
export type IfrBuild = { ok: true; ifr: IfrClearanceDetails } | { ok: false; reason: string; pilot: string; sayAgain?: boolean };

/** Is the magnetic bearing inside the sector (inclusive; the sector may wrap through north: 310-129)? */
export function bearingInSector(bearingMag: number, fromDeg: number, toDeg: number): boolean {
  const b = ((bearingMag % 360) + 360) % 360;
  return fromDeg <= toDeg ? b >= fromDeg && b <= toDeg : b >= fromDeg || b <= toDeg;
}

/**
 * The Departure frequency for a flight plan: the DEP-position frequency whose `sectorBearings` contain the MAGNETIC bearing from
 * the ARP to the first resolvable fix of the route (KACY: 310-129 north -> 134.25, 130-309 south -> 124.6); without sector data
 * or a usable route fix: the first DEP frequency, else the first APP frequency.
 */
export function departureFrequencyFor(airport: Airport, route: string[]): RadioFrequency | undefined {
  const deps = airport.frequencies.filter((f) => f.position === 'DEP');
  for (const id of route) {
    const fix = findNavFix(airport, id);
    if (!fix) continue;
    const brg = trueToMagnetic(bearingDeg({ x: 0, y: 0 }, fix.pos), airport.magneticVariationDeg);
    const hit = deps.find((f) => f.sectorBearings && bearingInSector(brg, f.sectorBearings.fromDeg, f.sectorBearings.toDeg));
    if (hit) return hit;
    break; // only the first fix decides
  }
  return deps[0] ?? airport.frequencies.find((f) => f.position === 'APP');
}

export function buildIfrClearance(ctx: SimContext, ac: Aircraft, given: ParsedCommand['ifr']): IfrBuild {
  const { airport } = ctx.state;
  const fp = ac.flightPlan!;
  const p = given ?? {};

  if (p.destination && !sameAirportId(p.destination, fp.destination)) {
    return { ok: false, reason: `${ac.callsign} filed to ${fp.destination}; the clearance limit ${p.destination} does not match the flight plan.`, pilot: `we filed to ${spokenAirportName(fp.destination)}` };
  }
  const depKey = { runwayEnd: ctx.state.activeRunways.departing[0], key: ac.callsign };
  const dpName = departureProcedureName(airport, depKey);
  const allDpNames = airport.procedures.filter((x) => x.type === 'DP').map((x) => (x.runwayEnd ? spokenSidName(x.name, airport) : x.name.replace(/\s+(DEPARTURE|DEP)\s*$/i, '').trim()).toUpperCase());
  const named = p.departureProcedure?.toUpperCase().replace(/\s+DEPARTURE\s*$/, '').trim();
  if (p.departureProcedure && dpName && !(allDpNames.length > 1 ? allDpNames.some((n) => n === named) : dpName.toUpperCase().includes(named!))) {
    return { ok: false, reason: `Unknown departure procedure "${p.departureProcedure}" (this airport has ${dpName}).`, pilot: `we don't have that departure procedure` };
  }
  if (p.initialAltitudeFt !== undefined && !(p.initialAltitudeFt >= airport.elevationFt + 500 && p.initialAltitudeFt <= 18000)) {
    return { ok: false, reason: `Initial altitude ${p.initialAltitudeFt} ft is not usable.`, pilot: 'say again the initial altitude', sayAgain: true };
  }
  let squawk = p.squawk;
  if (squawk !== undefined) {
    if (!isAssignableSquawk(squawk)) return { ok: false, reason: `Squawk ${squawk} is not an assignable transponder code.`, pilot: 'say again the squawk code', sayAgain: true };
    if (squawksInUse(ctx.state, ac.id).has(squawk)) return { ok: false, reason: `Squawk ${squawk} is already assigned to another aircraft.`, pilot: 'say again the squawk code', sayAgain: true };
  } else {
    squawk = assignSquawk(ctx, ac.id);
  }
  const depFreq = p.departureFrequencyMhz ?? departureFrequencyFor(airport, fp.route)?.mhz ?? frequencyForPosition(airport, 'TWR')?.mhz;
  if (depFreq === undefined) return { ok: false, reason: `${airport.icao} has no departure frequency to assign.`, pilot: 'say again the departure frequency', sayAgain: true };

  const dp = p.departureProcedure && allDpNames.length > 1 ? p.departureProcedure.replace(/\s+DEPARTURE\s*$/i, '').trim() : dpName;
  const ifr: IfrClearanceDetails = {
    destination: fp.destination,
    routeText: dp ? `${dp} departure, radar vectors, then as filed` : 'as filed',
    departureProcedure: dp,
    initialAltitudeFt: p.initialAltitudeFt ?? defaultInitialAltitudeFt(airport, depKey),
    expectAltitudeFt: p.expectAltitudeFt ?? fp.cruiseAltitudeFt,
    departureFrequencyMhz: depFreq,
    squawk,
  };
  return { ok: true, ifr };
}
