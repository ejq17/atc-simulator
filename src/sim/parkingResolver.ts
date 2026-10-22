/**
 * Parking destination resolution (airport-agnostic).
 *
 * A spoken/parsed destination such as "GATE1", "GATE", "RAMP", "FBO" is matched against the airport's
 * parking list by, in order: exact id, id with punctuation removed, name, then category keyword.
 * Category (or no) destinations are resolved to the nearest UNOCCUPIED spot by the executor, which
 * ranks the candidates returned here by taxi-route length.
 */
import type { Aircraft, Airport, ParkingPosition, SimulationState } from './types';
import { dist } from './geo';
import { perfOf } from './context';
import { isBusinessJetType } from './performance';

export type ParkingCategory = ParkingPosition['category'];

export type ParkingQuery =
  | { kind: 'spot'; parking: ParkingPosition }
  | { kind: 'category'; category: ParkingCategory; idPrefix?: string }
  | { kind: 'default' }
  | { kind: 'unknown' };

const CATEGORY_KEYWORDS: Record<string, ParkingCategory> = {
  GATE: 'airline', GATES: 'airline', TERMINAL: 'airline',
  RAMP: 'ga', GA: 'ga', GENERALAVIATION: 'ga', TIEDOWN: 'ga', TIEDOWNS: 'ga',
  FBO: 'fbo',
  CARGO: 'cargo', FAA: 'cargo',
  ANG: 'military', MILITARY: 'military',
};

/** Words naming one military zone: the ids of its parking positions start with the prefix (USCG helipads, ANG ramp). */
const ZONE_KEYWORDS: Record<string, string> = { USCG: 'USCG-', COASTGUARD: 'USCG-', COASTGUARDRAMP: 'USCG-', HELIPAD: 'USCG-', ANGRAMP: 'ANG-', ANG: 'ANG-' };

/** Words meaning "somewhere to park": resolved from the aircraft, not a fixed category. */
const GENERIC = new Set(['', 'PARKING', 'PARK', 'PARKINGSPOT']);

export function normalizeParkingKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function resolveParkingQuery(airport: Airport, query: string | undefined): ParkingQuery {
  const raw = (query ?? '').trim();
  const key = normalizeParkingKey(raw);
  if (GENERIC.has(key)) return { kind: 'default' };
  const up = raw.toUpperCase();
  const byId = airport.parking.find((p) => p.id.toUpperCase() === up) ?? airport.parking.find((p) => normalizeParkingKey(p.id) === key);
  if (byId) return { kind: 'spot', parking: byId };
  const byName = airport.parking.find((p) => p.name.toUpperCase() === up) ?? airport.parking.find((p) => normalizeParkingKey(p.name) === key);
  if (byName) return { kind: 'spot', parking: byName };
  const zone = ZONE_KEYWORDS[key];
  if (zone && airport.parking.some((p) => p.id.startsWith(zone))) return { kind: 'category', category: 'military', idPrefix: zone };
  const cat = CATEGORY_KEYWORDS[key];
  if (cat) return { kind: 'category', category: cat };
  return { kind: 'unknown' };
}

/** Another aircraft standing on, or already cleared to, this parking position. */
export function parkingOccupant(state: SimulationState, parking: ParkingPosition, exceptId?: string): Aircraft | undefined {
  for (const o of Object.values(state.aircraft)) {
    if (o.id === exceptId || !o.onGround) continue;
    if (o.groundSpeedKt < 1 && dist(o.pos, parking.pos) < 8) return o;
    const last = o.route?.nodeIds[o.route.nodeIds.length - 1];
    if (last === parking.nodeId && o.phase !== 'PARKED') return o;
  }
  return undefined;
}

/** Category a type of aircraft normally parks in (airline callsign or large type -> airline). */
export function naturalCategory(ac: Aircraft): ParkingCategory {
  if (perfOf(ac).military) return 'military'; // Coast Guard helicopters (helipads) and Air National Guard fighters (the ANG ramp)
  // Freighters (UPS, FedEx) use the cargo apron; a light aircraft with an airline-style callsign (Wiggins' Caravan) parks on the GA ramp.
  if (perfOf(ac).category !== 'light' && /^(UPS|FDX)\d/.test(ac.callsign)) return 'cargo';
  if (perfOf(ac).category === 'light') return 'ga';
  if (isBusinessJetType(ac.type)) return 'fbo'; // Citation, Challenger, Gulfstream, Global: the FBO ramp, not an airline gate
  return 'airline';
}

/**
 * Candidate free spots for an aircraft. `category` given -> only that category. Otherwise preference
 * order: the category it parked in at spawn (unless that is a GA/airline mismatch), its natural
 * category, then anything free.
 */
export function freeParkingCandidates(
  state: SimulationState,
  ac: Aircraft,
  category: ParkingCategory | undefined,
  homeCategory: ParkingCategory | undefined,
  idPrefix?: string,
): ParkingPosition[] {
  const free = state.airport.parking.filter((p) => !parkingOccupant(state, p, ac.id)).filter((p) => !p.id.startsWith('USCG-') || ac.type === 'H65' || idPrefix === 'USCG-');
  if (category) return free.filter((p) => p.category === category && (!idPrefix || p.id.startsWith(idPrefix)));
  const natural = naturalCategory(ac);
  // A GA<->airline mismatch (e.g. a jet spawned on a ramp spot) says nothing about preference.
  const home = homeCategory && (homeCategory === 'ga' || homeCategory === 'airline') && homeCategory !== natural ? undefined : homeCategory;
  // An airport without an FBO ramp parks a business jet on the GA ramp.
  for (const c of [home, natural, natural === 'fbo' ? 'ga' : undefined] as (ParkingCategory | undefined)[]) {
    if (!c) continue;
    // military types park in their own zone: helicopters at the USCG helipads, fighters on the ANG ramp
    const zone = c === 'military' ? (ac.type === 'H65' ? 'USCG-' : 'ANG-') : undefined;
    const m = free.filter((p) => p.category === c && (!zone || p.id.startsWith(zone)));
    if (m.length) return m;
  }
  return free;
}

// ---------------------------------------------------------------------------------------------------------------------
// An arrival's own stand
// ---------------------------------------------------------------------------------------------------------------------

/** The stand an inbound arrival is bound for, when it is assigned, still exists and nothing stands on it (or is cleared to it). */
export function assignedStandOf(state: SimulationState, ac: Aircraft): ParkingPosition | undefined {
  const id = ac.assignedStand?.parkingId;
  const p = id ? state.airport.parking.find((x) => x.id === id) : undefined;
  return p && !parkingOccupant(state, p, ac.id) ? p : undefined;
}

/** Stands other inbound aircraft are bound for. */
export function standsReservedByOthers(state: SimulationState, exceptId: string): Set<string> {
  const out = new Set<string>();
  for (const o of Object.values(state.aircraft)) if (o.id !== exceptId && !o.isDeparture && o.assignedStand) out.add(o.assignedStand.parkingId);
  return out;
}
