/**
 * IFR clearance helpers (Clearance Delivery): fills the elements the controller did not state from the
 * flight plan and the airport, and assigns transponder codes.
 *
 * Source of every default:
 *   destination            flightPlan.destination (a different stated destination is refused)
 *   departureProcedure     `airport.procedures` entry of type 'DP' (name without its trailing "DEPARTURE")
 *   initialAltitudeFt      the command, else 2000 (ATLANTIC CITY THREE says maintain 2000)
 *   expectAltitudeFt       the command, else flightPlan.cruiseAltitudeFt
 *   departureFrequencyMhz  the command, else the airport's DEP frequency, else APP
 *   squawk                 the command (validated), else a seeded random 4-digit octal code not in use
 */
import type { Aircraft, Airport, IfrClearanceDetails, ParsedCommand, SimulationState } from './types';
import type { SimContext } from './context';
import { rngInt } from './rng';
import { frequencyForPosition } from '../radio/frequencies';
import { spokenAirportName } from '../radio/spoken';

export const DEFAULT_INITIAL_ALTITUDE_FT = 2000;
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

/** "ATLANTIC CITY THREE DEPARTURE" -> "ATLANTIC CITY THREE". */
export function departureProcedureName(airport: Airport): string | undefined {
  const dp = airport.procedures.find((p) => p.type === 'DP');
  return dp ? dp.name.replace(/\s+(DEPARTURE|DEP)\s*$/i, '').trim() : undefined;
}

const stripK = (icao: string) => icao.trim().toUpperCase().replace(/^K(?=[A-Z0-9]{3}$)/, '');
export const sameAirportId = (a: string, b: string): boolean => stripK(a) === stripK(b);

/** `sayAgain`: the pilot asks for the element again ("Say again the squawk code") instead of saying "Unable". */
export type IfrBuild = { ok: true; ifr: IfrClearanceDetails } | { ok: false; reason: string; pilot: string; sayAgain?: boolean };

export function buildIfrClearance(ctx: SimContext, ac: Aircraft, given: ParsedCommand['ifr']): IfrBuild {
  const { airport } = ctx.state;
  const fp = ac.flightPlan!;
  const p = given ?? {};

  if (p.destination && !sameAirportId(p.destination, fp.destination)) {
    return { ok: false, reason: `${ac.callsign} filed to ${fp.destination}; the clearance limit ${p.destination} does not match the flight plan.`, pilot: `we filed to ${spokenAirportName(fp.destination)}` };
  }
  const dpName = departureProcedureName(airport);
  if (p.departureProcedure && dpName && !dpName.toUpperCase().includes(p.departureProcedure.toUpperCase().replace(/\s+DEPARTURE\s*$/, '').trim())) {
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
  const depFreq = p.departureFrequencyMhz ?? frequencyForPosition(airport, 'DEP')?.mhz ?? frequencyForPosition(airport, 'APP')?.mhz ?? frequencyForPosition(airport, 'TWR')?.mhz;
  if (depFreq === undefined) return { ok: false, reason: `${airport.icao} has no departure frequency to assign.`, pilot: 'say again the departure frequency', sayAgain: true };

  const dp = dpName;
  const ifr: IfrClearanceDetails = {
    destination: fp.destination,
    routeText: dp ? `${dp} departure, radar vectors, then as filed` : 'as filed',
    departureProcedure: dp,
    initialAltitudeFt: p.initialAltitudeFt ?? DEFAULT_INITIAL_ALTITUDE_FT,
    expectAltitudeFt: p.expectAltitudeFt ?? fp.cruiseAltitudeFt,
    departureFrequencyMhz: depFreq,
    squawk,
  };
  return { ok: true, ifr };
}
