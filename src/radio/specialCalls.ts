/**
 * Pilot and vehicle-operator calls of the special traffic (airport vehicles, Coast Guard helicopters, VFR transitions, flight training,
 * fighters). Same conventions as readback.ts: callsign FIRST in pilot-initiated calls, the facility called by the name of the frequency
 * the aircraft is tuned to.
 *
 * Sources: FAA AC 150/5210-20A Appendix B para 4.3 (vehicle operators tell the controller WHO, WHERE and WHAT; sample calls "this is Airport 21
 * vehicle at Taxiway Alpha. Request clearance south on runway 19 right for a light inspection" and "Airport 21 vehicle is off of runway 19
 * right"); JO 7110.65 3-11-1 / 3-11-2 and AIM 4-3-17 (helicopter taxi / takeoff vocabulary); AIM 3-2-4 (Class C: "give their position,
 * altitude, radar beacon code, destination, and request Class C service"); JO 7110.65 3-10-12 ("report initial", "report break").
 */
import type { Aircraft } from '../sim/types';
import { cardinal } from '../sim/geo';
import { facilityCallName } from './frequencies';
import { digitsSpoken, spokenAirportName, spokenAltitude, spokenRunway, spokenTaxiway, spokenText } from './spoken';
import type { ReadbackEnv } from './readback';

const facility = (ac: Aircraft, env: ReadbackEnv): string => facilityCallName(env.airport, ac.frequencyMhz, ac.frequencyId);
const miles = (nm: number): string => {
  const n = Math.max(1, Math.round(nm));
  return `${digitsSpoken(String(n))} ${n === 1 ? 'mile' : 'miles'}`;
};

// --- airport vehicles ---------------------------------------------------------------------------------------------------

/** What the vehicle operator wants: the purpose words of the request ("a runway inspection", "a pavement inspection"). */
export type VehiclePurpose = 'runway inspection' | 'pavement inspection' | 'ops errand';

/**
 * First call to Ground from the parking area (AC 150/5210-20A B 4.3: who / where / what):
 * "Atlantic City Ground, Airport two one vehicle at FAA ramp one, request taxi to runway one three for a runway inspection."
 */
export function vehicleTaxiRequestCall(ac: Aircraft, env: ReadbackEnv, o: { at?: string; purpose: VehiclePurpose; runwayEnd?: string; toWhere?: string }): string {
  const at = o.at ? ` at ${spokenText(o.at)}` : '';
  if (o.purpose === 'runway inspection' && o.runwayEnd) return `${facility(ac, env)}, ${ac.spokenCallsign}${at}, request taxi to runway ${spokenRunway(o.runwayEnd)} for a runway inspection.`;
  if (o.purpose === 'pavement inspection') return `${facility(ac, env)}, ${ac.spokenCallsign}${at}, request permission on the taxiways for a pavement inspection.`;
  return `${facility(ac, env)}, ${ac.spokenCallsign}${at}, request to proceed to ${o.toWhere ?? 'the other ramp'}.`;
}

/** Check-in with Tower holding short of the runway the vehicle wants to use (3-1-3: runway use other than crossing is requested from local control). */
export function vehicleAtHoldCall(ac: Aircraft, env: ReadbackEnv, o: { runwayEnd: string; taxiway?: string }): string {
  const at = o.taxiway ? ` at ${spokenTaxiway(o.taxiway)}` : '';
  return `${facility(ac, env)}, ${ac.spokenCallsign}, holding short of runway ${spokenRunway(o.runwayEnd)}${at}, request clearance on runway ${spokenRunway(o.runwayEnd)} for a runway inspection.`;
}

/** "Atlantic City Tower, Airport two one vehicle is off of runway one three, runway inspection complete." (AC 150/5210-20A B 4.3 sample: "is off of runway 19 right") */
export function vehicleOffRunwayCall(ac: Aircraft, env: ReadbackEnv, o: { runwayEnd: string; inspectionComplete: boolean }): string {
  return `${facility(ac, env)}, ${ac.spokenCallsign} is off of runway ${spokenRunway(o.runwayEnd)}${o.inspectionComplete ? ', runway inspection complete' : ''}.`;
}

/** Pilot readback of a vehicle runway clearance ("proceed on runway one three, report runway inspection complete"). */
export function vehicleProceedReadback(o: { runwayEnd: string; reportClear?: boolean; reportInspection?: boolean; taxiways?: boolean }): string {
  if (o.taxiways) return 'Proceeding on the taxiways, will hold short of all runways';
  return `Proceeding on runway ${spokenRunway(o.runwayEnd)}${o.reportInspection ? ', will report runway inspection complete' : o.reportClear ? ', will report clear' : ''}`;
}

// --- helicopters --------------------------------------------------------------------------------------------------------

/** Departure request from a helipad: "Atlantic City Tower, Coast Guard six one three two seven, at the Coast Guard helipad one, request departure to the south, VFR." */
export function heliDepartureRequestCall(ac: Aircraft, env: ReadbackEnv, o: { padName: string; direction: string }): string {
  return `${facility(ac, env)}, ${ac.spokenCallsign}, at ${spokenText(o.padName)}, request departure to the ${o.direction}, VFR.`;
}

/** Inbound to a helipad (JO 7110.65 3-11-6: the controller issues the approach and landing instructions): "... five miles northeast, inbound for the Coast Guard ramp, request landing." */
export function heliInboundCall(ac: Aircraft, env: ReadbackEnv, o: { distanceNm: number; bearingFromAirportDeg: number; padName: string; atisLetter?: string }): string {
  const info = o.atisLetter ? ` with information ${digitsSpoken(o.atisLetter)}` : '';
  return `${facility(ac, env)}, ${ac.spokenCallsign}, ${miles(o.distanceNm)} ${cardinal(o.bearingFromAirportDeg)}, inbound for ${spokenText(o.padName)}, request landing${info}.`;
}

/** Request to move between pads: "Atlantic City Ground, Coast Guard six one three two seven, at Coast Guard helipad one, request air taxi to Coast Guard helipad three." */
export function heliAirTaxiRequestCall(ac: Aircraft, env: ReadbackEnv, o: { from: string; to: string }): string {
  return `${facility(ac, env)}, ${ac.spokenCallsign}, at ${spokenText(o.from)}, request air taxi to ${spokenText(o.to)}.`;
}

/** The helicopter is on its pad again after an air taxi / landing: "... on the Coast Guard helipad one." */
export function heliDownCall(ac: Aircraft, env: ReadbackEnv, o: { padName: string }): string {
  return `${facility(ac, env)}, ${ac.spokenCallsign}, landed at ${spokenText(o.padName)}.`;
}

/** Readback of an air-taxi instruction (3-11-1 "AIR-TAXI VIA (route) TO (location)"). */
export function airTaxiReadback(o: { mode?: 'air' | 'hover'; route?: string[]; where: string }): string {
  const via = o.route?.length ? ` via ${o.route.map(spokenTaxiway).join(', ')}` : '';
  return `${o.mode === 'hover' ? 'Hover taxi' : 'Air taxi'}${via} to ${o.where}`;
}

// --- VFR transitions and flight training ----------------------------------------------------------------------------------

/**
 * AIM 3-2-4 (Class C entry): position, altitude, radar beacon code, destination, request for Class C service.
 * "Atlantic City Approach, Cessna seven two three echo juliet, twelve miles north, three thousand five hundred, squawking one two zero zero, request transition, destination Millville."
 */
export function transitionRequestCall(ac: Aircraft, env: ReadbackEnv, o: { distanceNm: number; bearingFromAirportDeg: number; altitudeFt: number; destination: string }): string {
  return `${facility(ac, env)}, ${ac.spokenCallsign}, ${miles(o.distanceNm)} ${cardinal(o.bearingFromAirportDeg)}, ${spokenAltitude(Math.round(o.altitudeFt / 100) * 100)}, squawking ${digitsSpoken(ac.squawk ?? '1200')}, request Class Charlie transition, destination ${spokenAirportName(o.destination)}.`;
}

/** Pilot reply when told to remain outside the Class C or to stand by is not needed; the leaving call: "Atlantic City Approach, N723EJ, leaving your airspace, thank you." */
export function transitionLeavingCall(ac: Aircraft, env: ReadbackEnv): string {
  return `${facility(ac, env)}, ${ac.spokenCallsign}, leaving your airspace, request frequency change.`;
}

/** Flight training arrival (touch-and-go circuits): "... ten miles north, inbound for touch and go." */
export function trainingInboundCall(ac: Aircraft, env: ReadbackEnv, o: { distanceNm: number; bearingFromAirportDeg: number; atisLetter?: string }): string {
  const info = o.atisLetter ? ` with information ${digitsSpoken(o.atisLetter)}` : '';
  return `${facility(ac, env)}, ${ac.spokenCallsign}, ${miles(o.distanceNm)} ${cardinal(o.bearingFromAirportDeg)}, inbound for touch and go${info}.`;
}

/** Downwind call of a circuit: "... left downwind runway one three, touch and go." */
export function trainingDownwindCall(ac: Aircraft, env: ReadbackEnv, o: { side: 'left' | 'right'; runwayEnd: string }): string {
  return `${facility(ac, env)}, ${ac.spokenCallsign}, ${o.side} downwind runway ${spokenRunway(o.runwayEnd)}, touch and go.`;
}

/** After the last touch-and-go the student makes a full stop and asks to taxi back (the controller has no "taxi back" phrase: it is a pilot request). */
export function taxiBackRequestCall(ac: Aircraft, env: ReadbackEnv, o: { taxiway?: string }): string {
  const at = o.taxiway ? `, at ${spokenTaxiway(o.taxiway)}` : '';
  return `${facility(ac, env)}, ${ac.spokenCallsign}${at}, clear of the runway, request taxi back to the ramp.`;
}

// --- fighters ---------------------------------------------------------------------------------------------------------------

/** Inbound for the overhead maneuver (3-10-12): "... ten miles northwest, inbound for the overhead, request pattern altitude and direction of traffic." */
export function overheadInboundCall(ac: Aircraft, env: ReadbackEnv, o: { distanceNm: number; bearingFromAirportDeg: number; atisLetter?: string }): string {
  const info = o.atisLetter ? ` with information ${digitsSpoken(o.atisLetter)}` : '';
  return `${facility(ac, env)}, ${ac.spokenCallsign}, ${miles(o.distanceNm)} ${cardinal(o.bearingFromAirportDeg)}, inbound for the overhead${info}.`;
}

/** The 3-10-12 reports: "initial" (runway end, at the initial point) and "break". */
export function overheadReportCall(ac: Aircraft, env: ReadbackEnv, o: { what: 'INITIAL' | 'BREAK'; runwayEnd: string }): string {
  return o.what === 'INITIAL'
    ? `${facility(ac, env)}, ${ac.spokenCallsign}, initial runway ${spokenRunway(o.runwayEnd)}.`
    : `${facility(ac, env)}, ${ac.spokenCallsign}, break.`;
}

/** Readback of the overhead maneuver instructions ("Runway 13, pattern altitude one thousand five hundred, right turns, will report initial"). */
export function overheadReadback(o: { runwayEnd: string; altitudeFt?: number; turnDirection?: 'left' | 'right'; reports: string[] }): string {
  const parts = [`Runway ${spokenRunway(o.runwayEnd)}`];
  if (o.altitudeFt !== undefined) parts.push(`pattern altitude ${spokenAltitude(o.altitudeFt)}`);
  if (o.turnDirection === 'right') parts.push('right turns');
  if (o.reports.length) parts.push(`will report ${o.reports.join(' and ')}`);
  return parts.join(', ');
}
