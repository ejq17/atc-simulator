/**
 * KACY-specific geometry and naming helpers shared by scenarios and the traffic generator.
 * Everything resolves against the real `Airport` object; nothing here hard-codes coordinates except the
 * (approximate) positions of the neighbouring airports used to derive inbound bearings.
 */
import type { Airport, ParkingPosition, RunwayEnd, ScenarioAircraftSpawn, TaxiNode, Vec2 } from '../sim/types';
import { holdingPositionsForRunway, runwayEntryNodes } from '../airport';
import { findTaxiRoute } from '../sim/pathfinding';
import { getPerformance, patternAltitudeFt } from '../sim/performance';
import { CARGO_TYPES, findNeighbour, pickFlight, profileFor } from './airportProfile';
import type { PickFlightOptions } from './airportProfile';

export const NM = 1852;
const rad = (d: number): number => (d * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;
export const norm360 = (h: number): number => ((h % 360) + 360) % 360;

// ---------------------------------------------------------------------------
// Runway ends
// ---------------------------------------------------------------------------

export function endOf(airport: Airport, endId: string): RunwayEnd {
  for (const r of airport.runways) for (const e of r.ends) if (e.id === endId) return e;
  throw new Error(`Unknown runway end ${endId}`);
}

export function runwayIdOf(airport: Airport, endId: string): string {
  for (const r of airport.runways) if (r.ends.some((e) => e.id === endId)) return r.id;
  throw new Error(`Unknown runway end ${endId}`);
}

/** The opposite end of the runway ("13" -> "31"). */
export function oppositeEnd(airport: Airport, endId: string): string {
  for (const r of airport.runways) {
    const i = r.ends.findIndex((e) => e.id === endId);
    if (i >= 0) return r.ends[1 - i].id;
  }
  throw new Error(`Unknown runway end ${endId}`);
}

export function runwayLengthFt(airport: Airport, endId: string): number {
  return airport.runways.find((r) => r.id === runwayIdOf(airport, endId))!.lengthFt;
}

/** Position `nm` nautical miles out on the extended centreline of a runway end (TRUE heading, as in the engine). */
export function finalPosition(airport: Airport, endId: string, nm: number): Vec2 {
  const e = endOf(airport, endId);
  const back = rad(e.trueHeadingDeg + 180);
  return { x: e.threshold.x + Math.sin(back) * nm * NM, y: e.threshold.y + Math.cos(back) * nm * NM };
}

/** Airborne spawn on the extended centreline, `nm` out, flying the runway's TRUE heading. */
export function onFinal(
  airport: Airport,
  endId: string,
  nm: number,
  o: { altitudeFt?: number; speedKt: number },
): Extract<ScenarioAircraftSpawn['start'], { kind: 'airborne' }> {
  const e = endOf(airport, endId);
  return {
    kind: 'airborne',
    pos: finalPosition(airport, endId, nm),
    altitudeFt: o.altitudeFt ?? glideFt(airport, endId, nm),
    headingDeg: e.trueHeadingDeg,
    speedKt: o.speedKt,
    runwayEnd: endId,
    distanceNm: nm,
  };
}

/** 3 degree glidepath altitude (ft MSL) `nm` out, rounded to 100 ft. */
export function glideFt(airport: Airport, endId: string, nm: number): number {
  const e = endOf(airport, endId);
  const elev = e.tdzeFt ?? airport.elevationFt;
  return Math.round((elev + 50 + nm * NM * 3.28084 * Math.tan(rad(3))) / 100) * 100;
}

/**
 * Airborne spawn `nm` from the airport reference point on a TRUE bearing *from* the airport, flying straight toward the
 * landing threshold. No `distanceNm`, so the engine does not snap it to the centreline.
 */
export function inboundFromBearing(
  airport: Airport,
  endId: string,
  bearingFromAirportDeg: number,
  nm: number,
  o: { altitudeFt: number; speedKt: number },
): Extract<ScenarioAircraftSpawn['start'], { kind: 'airborne' }> {
  const b = rad(bearingFromAirportDeg);
  const pos = { x: Math.sin(b) * nm * NM, y: Math.cos(b) * nm * NM };
  const thr = endOf(airport, endId).threshold;
  const hdg = norm360(deg(Math.atan2(thr.x - pos.x, thr.y - pos.y)));
  return { kind: 'airborne', pos, altitudeFt: o.altitudeFt, headingDeg: hdg, speedKt: o.speedKt, runwayEnd: endId };
}

/**
 * Airborne spawn on the downwind leg of a rectangular pattern: `alongNm` past the threshold (positive = toward the far end,
 * so 1.5 is roughly abeam the touchdown zone), 0.8 nm to the left or right of the landing direction (the offset the engine
 * flies), heading opposite to landing, at pattern altitude. The engine's pattern logic only handles a nearby entry like this
 * (it does not fly to the pattern from far away), so pattern scenarios start here.
 */
export function onDownwind(
  airport: Airport,
  endId: string,
  side: 'left' | 'right',
  alongNm: number,
  o: { speedKt: number; altitudeFt?: number; type?: string },
): Extract<ScenarioAircraftSpawn['start'], { kind: 'airborne' }> {
  const e = endOf(airport, endId);
  const h = rad(e.trueHeadingDeg);
  const dir = { x: Math.sin(h), y: Math.cos(h) };
  const right = { x: dir.y, y: -dir.x };
  const lateral = (side === 'left' ? -0.8 : 0.8) * NM;
  const pos = { x: e.threshold.x + dir.x * alongNm * NM + right.x * lateral, y: e.threshold.y + dir.y * alongNm * NM + right.y * lateral };
  const elev = e.tdzeFt ?? airport.elevationFt;
  return {
    kind: 'airborne', pos, altitudeFt: o.altitudeFt ?? Math.round(patternAltitudeFt(getPerformance(o.type ?? 'C172'), elev, airport.trafficPatternAltitudeFt) / 100) * 100,
    headingDeg: norm360(e.trueHeadingDeg + 180), speedKt: o.speedKt, runwayEnd: endId,
  };
}

// ---------------------------------------------------------------------------
// Neighbouring airports (approximate coordinates, used only for inbound bearings)
// ---------------------------------------------------------------------------

/** KACY's neighbours (approximate coordinates, degrees; ~0.01 deg is plenty for choosing an inbound bearing). Other airports: airportProfile.ts. */
export const NEIGHBOURS = profileFor('KACY').neighbours;
/** ICAO / FAA id of a neighbouring airfield (any airport's profile). */
export type NeighbourId = string;

/** True bearing from the airport reference point to a neighbouring airfield (initial great-circle course). */
export function bearingTo(airport: Airport, n: NeighbourId): number {
  const p = findNeighbour(airport.icao, n);
  if (!p) throw new Error(`Unknown neighbouring airport ${n}`);
  const f1 = rad(airport.arp.lat);
  const f2 = rad(p.lat);
  const dl = rad(p.lon - airport.arp.lon);
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return norm360(deg(Math.atan2(y, x)));
}

// ---------------------------------------------------------------------------
// Holding positions and taxi routes
// ---------------------------------------------------------------------------

/** Full-length departure hold for a runway end (the entry nearest its threshold: B for 13/31, A for 4/22). */
export function fullLengthHold(airport: Airport, endId: string): TaxiNode {
  const n = runwayEntryNodes(airport, endId)[0];
  if (!n) throw new Error(`No holding position for runway ${endId}`);
  return n;
}

/** The hold on `taxiway` that serves departures from `endId` (protectsRunwayEnd must match or be unset). */
export function holdOn(airport: Airport, endId: string, taxiway: string): TaxiNode {
  const rid = runwayIdOf(airport, endId);
  const n = holdingPositionsForRunway(airport, rid).find(
    (h) => h.taxiways.includes(taxiway) && (!h.protectsRunwayEnd || h.protectsRunwayEnd === endId),
  );
  if (!n) throw new Error(`No hold on taxiway ${taxiway} for runway end ${endId}`);
  return n;
}

export function parkingById(airport: Airport, id: string): ParkingPosition {
  const p = airport.parking.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown parking position ${id}`);
  return p;
}

export interface Crossing {
  runwayId: string;
  holdBeforeId: string;
  holdAfterId: string;
}

/** Runway surfaces a node path crosses (hold -> runway centreline vertex -> hold on the same runway). */
export function crossingsAlong(airport: Airport, nodeIds: string[]): Crossing[] {
  const g = airport.taxiwayGraph;
  const out: Crossing[] = [];
  for (let i = 1; i < nodeIds.length - 1; i++) {
    const n = g.nodes[nodeIds[i]];
    const a = g.nodes[nodeIds[i - 1]];
    const b = g.nodes[nodeIds[i + 1]];
    if (n.kind === 'runway' && a.kind === 'holding_position' && b.kind === 'holding_position' && a.runwayId === n.runwayId && b.runwayId === n.runwayId) {
      out.push({ runwayId: n.runwayId!, holdBeforeId: a.id, holdAfterId: b.id });
    }
  }
  return out;
}

export interface PlannedRoute {
  nodeIds: string[];
  taxiways: string[];
  lengthM: number;
  crossings: Crossing[];
  holdNodeId: string;
}

/**
 * The route the engine would give a parked aircraft told "taxi to runway <end> [via ...]". Mirrors `planTaxi`:
 * candidate holds are the ones protecting the end (narrowed to the last `via` taxiway), shortest wins.
 */
export function planDepartureTaxi(airport: Airport, parkingId: string, endId: string, via?: string[]): PlannedRoute | undefined {
  const g = airport.taxiwayGraph;
  const start = parkingById(airport, parkingId).nodeId;
  const rid = runwayIdOf(airport, endId);
  const holds = holdingPositionsForRunway(airport, rid).filter((h) => !h.protectsRunwayEnd || h.protectsRunwayEnd === endId);
  const lastVia = via?.[via.length - 1];
  const narrowed = lastVia ? holds.filter((h) => h.taxiways.includes(lastVia)) : [];
  const cands = narrowed.length ? narrowed : holds;
  let best: PlannedRoute | undefined;
  for (const h of cands) {
    const r = findTaxiRoute(g, start, h.id, { via, avoidRunways: true, allowedRunwayIds: airport.runways.map((x) => x.id) });
    if (r.route && (!best || r.route.lengthM < best.lengthM)) {
      best = { nodeIds: r.route.nodeIds, taxiways: r.route.taxiways, lengthM: r.route.lengthM, crossings: crossingsAlong(airport, r.route.nodeIds), holdNodeId: h.id };
    }
  }
  return best;
}

/** Spoken-style route, e.g. ["L","N","P","D","A"] -> "Lima, November, Papa, Delta, Alpha" (named lanes only). */
export function routeWords(taxiways: string[]): string {
  const NATO: Record<string, string> = { A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', G: 'Golf', H: 'Hotel', J: 'Juliet', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', P: 'Papa' };
  return taxiways.filter((t) => t).map((t) => NATO[t] ?? t).join(', ');
}

/**
 * Can this aircraft type take off from `hold` toward `endId`? Compares the type's `takeoffDistanceFt` (engine performance data, source-verified)
 * with the declared runway length (`Runway.lengthFt`, used as the TORA) minus the distance from the threshold to where the aircraft enters
 * the runway. No type is hard-coded as "13/31 only": an A320 (5,000 ft) can use 4/22 (6,145 ft) from full length but not from an intersection
 * with less than 5,000 ft remaining, exactly as the engine's `runwayLengthCheck` decides.
 */
export function canDepartFrom(airport: Airport, type: string, endId: string, hold: TaxiNode): boolean {
  const perf = getPerformance(type);
  const e = endOf(airport, endId);
  const runway = airport.runways.find((r) => r.ends.some((x) => x.id === endId))!;
  const other = runway.ends.find((x) => x.id !== endId)!;
  const total = Math.hypot(other.threshold.x - e.threshold.x, other.threshold.y - e.threshold.y);
  const dir = { x: (other.threshold.x - e.threshold.x) / total, y: (other.threshold.y - e.threshold.y) / total };
  const entryId = (hold as TaxiNode & { entryNodeId?: string }).entryNodeId;
  const entry = (entryId && airport.taxiwayGraph.nodes[entryId]) || hold;
  const alongFt = Math.max(0, (entry.pos.x - e.threshold.x) * dir.x + (entry.pos.y - e.threshold.y) * dir.y) / 0.3048;
  return runway.lengthFt - alongFt >= perf.takeoffDistanceFt;
}

/** Can the type take off from the *full length* of this runway end? (KACY: an A320 can on every end, 4/22 only from the end of the pavement.) */
export function runwayLongEnoughFor(airport: Airport, type: string, endId: string): boolean {
  return canDepartFrom(airport, type, endId, fullLengthHold(airport, endId));
}

// ---------------------------------------------------------------------------
// Parking
// ---------------------------------------------------------------------------

export const GA_RAMP_IDS = ['GA-1', 'GA-2', 'GA-3', 'GA-4', 'GA-5', 'GA-6', 'GA-7', 'GA-8'] as const;
export const FBO_IDS = ['FBO-1', 'FBO-2'] as const;
export const GATE_IDS = ['GATE-1', 'GATE-2', 'GATE-3', 'GATE-4', 'GATE-5', 'GATE-6', 'GATE-7', 'GATE-8', 'GATE-9', 'GATE-10'] as const;

/** Parking spots a generated departure of this type may use (GA ramp/FBO for light aircraft incl. the C208, gates for airliners, the cargo apron for freighters when the airport has one). */
export function parkingPoolFor(airport: Airport, type: string): ParkingPosition[] {
  const light = getPerformance(type).category === 'light';
  if (!light && CARGO_TYPES.has(type)) {
    const cargo = airport.parking.filter((p) => p.category === 'cargo');
    if (cargo.length) return cargo;
  }
  const cats = light ? ['ga', 'fbo'] : ['airline'];
  return airport.parking.filter((p) => cats.includes(p.category));
}

// ---------------------------------------------------------------------------
// Callsigns
// ---------------------------------------------------------------------------

/** Letters used in N-numbers (I and O are never issued). */
const N_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function randomNNumber(rng: () => number): string {
  const pick = (s: string): string => s[Math.min(s.length - 1, Math.floor(rng() * s.length))];
  const digit = (): string => String(Math.floor(rng() * 10));
  const first = String(1 + Math.floor(rng() * 9));
  const r = rng();
  if (r < 0.5) return `N${first}${digit()}${digit()}${pick(N_LETTERS)}${pick(N_LETTERS)}`; // N723EJ
  if (r < 0.8) return `N${first}${digit()}${pick(N_LETTERS)}${pick(N_LETTERS)}`; // N45PX
  return `N${first}${digit()}${digit()}${digit()}${pick(N_LETTERS)}`; // N1234Z
}

/**
 * Airline callsign from the airport's traffic profile (`airportProfile.ts`). Without an airport: KACY's mix, Spirit 80 % / American 20 %.
 * Flight numbers are 3-4 digits.
 */
export function randomAirlineCallsign(rng: () => number, icao?: string, o: PickFlightOptions = {}): string {
  return pickFlight(rng, icao, o)!.callsign;
}

/** The part a controller hears last: used to avoid two active aircraft that sound alike. */
export function callsignTail(callsign: string): string {
  return callsign.slice(-3);
}
