/**
 * IFR flows for the gameplay layer: which published procedure serves a landing runway (read from `airport.procedures` and
 * `airport.navaids` through the engine's own `analyzeProcedure`, never hard-coded), what an IFR departure's flight plan
 * looks like, and the rules deciding when a session runs IFR flows (`resolveIfrFlows`).
 *
 * Arrival flow: the aircraft appears over the procedure's initial/intermediate fix (`at_fix`) on the Approach frequency and
 * flies the published fixes until the controller clears it for the approach (or vectors it).
 * Departure flow: a parked airline aircraft with a `flightPlan` calls Clearance Delivery first, then Ground, Tower and Departure.
 */
import type { Airport, ApproachType, ControllerPositionId, FlightPlan, ScenarioAircraftSpawn } from '../sim/types';
import type { Rng } from '../sim/rng';
import { analyzeProcedure, matchingProcedures } from '../sim/approach';
import { findNavFix } from '../sim/navigation';
import { findRunwayEnd } from '../sim/runways';
import { mToNm } from '../sim/geo';
import { findStar, starRouteFrom, starRunwayLeg } from '../sim/star';
import type { StarRef } from '../sim/star';
import { getPerformance } from '../sim/performance';
import type { GameScenario } from './types';
import { profileDestinations, profileFor } from './airportProfile';

// ---------------------------------------------------------------------------
// Which sessions run IFR flows
// ---------------------------------------------------------------------------

export interface IfrFlowSwitches {
  /** Airline arrivals appear at the procedure fix on the Approach frequency. */
  arrivals: boolean;
  /** Airline departures are parked IFR departures that start with Clearance Delivery. */
  departures: boolean;
}

/**
 * `scenario.ifrArrivals` / `ifrDepartures` win (career steps use them); else an explicit `scenario.ifrFlows` boolean switches both;
 * else the session decides from its controller positions: arrivals when it includes APP, departures when it includes CLNC.
 * Tower-only (and Tower + Ground) sessions therefore keep the classic arrivals-on-final / VFR-style departures.
 */
export function resolveIfrFlows(scenario: Pick<GameScenario, 'controllerPositions' | 'ifrFlows' | 'ifrArrivals' | 'ifrDepartures'>): IfrFlowSwitches {
  const pos: readonly ControllerPositionId[] = scenario.controllerPositions ?? [];
  const both = scenario.ifrFlows;
  return {
    arrivals: scenario.ifrArrivals ?? both ?? pos.includes('APP'),
    departures: scenario.ifrDepartures ?? both ?? pos.includes('CLNC'),
  };
}

// ---------------------------------------------------------------------------
// Arrival procedures
// ---------------------------------------------------------------------------

export interface ArrivalProcedure {
  runwayEnd: string;
  approachType: Extract<ApproachType, 'ILS' | 'RNAV'>;
  procedureId: string;
  procedureName: string;
  /** Feeders (before the initial fix) followed by the straight-in fixes, in flying order. */
  route: string[];
  /** Initial / intermediate fix of the straight-in segment (CARYL for ILS 13). */
  ifFix: string;
  /** Final approach fix (MAYBN for ILS 13). */
  fafFix?: string;
  /** Distance from the threshold to the FAF (nm). */
  fafNm?: number;
  /** Distance before the threshold of each straight-in fix along the course (nm), by fix id. */
  courseNm: Record<string, number>;
  /** First feeder, when the procedure has one close enough to start from (VCN for ILS 13). */
  feederFix?: string;
  /** Distance from the runway threshold to the IF / the feeder (nm). */
  ifNm: number;
  feederNm?: number;
}

const FEEDER_START_MAX_NM = 22;
const cache = new WeakMap<Airport, Map<string, ArrivalProcedure | null>>();

/**
 * The procedure arrivals fly to `runwayEnd`: ILS when one is published (KACY: 13 and 31), else RNAV (22 and 4).
 * Among several candidates the one with the longest straight-in segment wins, like the engine's own pick.
 */
export function arrivalProcedure(airport: Airport, runwayEnd: string): ArrivalProcedure | undefined {
  let per = cache.get(airport);
  if (!per) cache.set(airport, (per = new Map()));
  if (per.has(runwayEnd)) return per.get(runwayEnd) ?? undefined;
  const g = findRunwayEnd(airport, runwayEnd);
  let found: ArrivalProcedure | undefined;
  if (g) {
    for (const approachType of ['ILS', 'RNAV'] as const) {
      const infos = matchingProcedures(airport, approachType, g.end.id)
        .map((p) => analyzeProcedure(airport, p, g))
        .filter((i) => i.onCourse.length > 0);
      if (!infos.length) continue;
      const best = [...infos].sort((a, b) => b.onCourse.length - a.onCourse.length)[0];
      const keep = new Set([...best.feeders, ...best.onCourse.map((f) => f.id)].map((s) => s.toUpperCase()));
      const route = (best.procedure.fixes ?? []).map((id) => findNavFix(airport, id)?.id ?? id).filter((id) => keep.has(id.toUpperCase()));
      const ifFix = best.onCourse[0].id;
      const feeder = route.length && route[0] !== ifFix ? route[0] : undefined;
      const feederPos = feeder ? findNavFix(airport, feeder)?.pos : undefined;
      const feederNm = feederPos ? mToNm(Math.hypot(feederPos.x - g.end.threshold.x, feederPos.y - g.end.threshold.y)) : undefined;
      found = {
        runwayEnd: g.end.id, approachType, procedureId: best.procedure.id, procedureName: best.procedure.name, route, ifFix,
        fafFix: best.faf?.id, courseNm: Object.fromEntries(best.onCourse.map((f) => [f.id, mToNm(f.dM)])), fafNm: best.faf ? mToNm(best.faf.dM) : undefined, ifNm: mToNm(best.onCourse[0].dM),
        ...(feeder && feederNm !== undefined && feederNm <= FEEDER_START_MAX_NM ? { feederFix: feeder, feederNm } : {}),
      };
      break;
    }
  }
  per.set(runwayEnd, found ?? null);
  return found;
}

/**
 * Where the engine's approach-clearance check (`conflicts.ts`, 3 nm in trail) puts an aircraft that has just appeared at the IF or at the first
 * feeder: at the next fix of its route when that is a straight-in fix, else at the IF. Distance before the threshold, nm. The generator keeps other
 * arrivals of the same runway at least 3.5 nm from this point so that clearing the new aircraft at check-in is never flagged unsafe.
 */
export function arrivalJoinNm(proc: ArrivalProcedure, fromFeeder: boolean): number {
  const start = fromFeeder && proc.feederFix ? proc.feederFix : proc.ifFix;
  const i = proc.route.findIndex((f) => f.toUpperCase() === start.toUpperCase());
  const next = proc.route[i + 1];
  return (next !== undefined ? proc.courseNm[next] : undefined) ?? proc.courseNm[proc.ifFix] ?? proc.ifNm;
}

/** Spawn start at a fix of the arrival procedure. `fromFeeder` starts at the first feeder (when there is one), else at the initial fix. */
export function arrivalAtFix(
  airport: Airport, proc: ArrivalProcedure, o: { altitudeFt: number; speedKt: number; fromFeeder?: boolean },
): Extract<ScenarioAircraftSpawn['start'], { kind: 'at_fix' }> {
  const startFix = o.fromFeeder && proc.feederFix ? proc.feederFix : proc.ifFix;
  const i = Math.max(0, proc.route.findIndex((f) => f.toUpperCase() === startFix.toUpperCase()));
  const route = proc.route.slice(i);
  if (!findNavFix(airport, startFix)) throw new Error(`Unknown fix ${startFix} for ${proc.procedureName}`);
  return { kind: 'at_fix', fix: startFix, altitudeFt: o.altitudeFt, speedKt: o.speedKt, route, runwayEnd: proc.runwayEnd };
}

/** Altitude for a generated IFR arrival: 3,000 (50 %), 4,000 (30 %), 5,000 ft (20 %); feeders start 1,000 ft higher (never above 5,000). */
export function pickArrivalAltitudeFt(rng: Rng, fromFeeder: boolean): number {
  const r = rng();
  const base = r < 0.5 ? 3000 : r < 0.8 ? 4000 : 5000;
  return fromFeeder ? Math.min(5000, base + 1000) : base;
}

/** Cruise-speed for a generated IFR arrival at the fix (kt). */
export const IFR_ARRIVAL_SPEED_KT: Record<'light' | 'jet', number> = { light: 110, jet: 180 };
export function ifrArrivalSpeedKt(type: string): number {
  return getPerformance(type).category === 'light' ? IFR_ARRIVAL_SPEED_KT.light : IFR_ARRIVAL_SPEED_KT.jet;
}

// ---------------------------------------------------------------------------
// Standard terminal arrivals (KMHT ROZZE TWO)
// ---------------------------------------------------------------------------

/**
 * Where STAR arrivals appear. The published transitions start far outside the simulated area (SMYTH is about 100 nm out, QUINZ 71 nm, CRIBB
 * 47 nm, MUCOW 72 nm from KMHT), so the simulator starts a flight where Boston Center would hand it to Boston Approach on the arrival: over
 * CRIBB (the entry fix of the CRIBB transition, "ATC assigned") or FLYZZ (on the QUINZ / PONCT / SMYTH transitions). Everything from there on
 * is the published route (JO 7110.65 4-7-1) to the end of the runway leg and the approach join fixes. Documented simplification.
 */
export const STAR_SIM_ENTRY_FIXES: readonly string[] = ['CRIBB', 'FLYZZ'];
/** Speed of a STAR arrival at its entry fix (kt): the engine's own en-route default (250 kt). */
export const STAR_ENTRY_SPEED_KT = 250;

export interface StarEntry {
  fix: string;
  transition: string;
  /** Fixes flown from the entry fix to the end of the route (runway leg + approach join). */
  route: string[];
  /** Published altitude window at the entry fix (ft); the spawn altitude lies within it. */
  minAltitudeFt: number;
  maxAltitudeFt: number;
}

export interface StarArrival {
  ref: StarRef;
  runwayEnd: string;
  entries: StarEntry[];
}

const starCache = new WeakMap<Airport, Map<string, StarArrival | null>>();

/** The STAR serving a landing runway end (turbojets only, per the chart note), or undefined (KACY: no STARs). */
export function starArrival(airport: Airport, runwayEnd: string): StarArrival | undefined {
  let per = starCache.get(airport);
  if (!per) starCache.set(airport, (per = new Map()));
  if (per.has(runwayEnd)) return per.get(runwayEnd) ?? undefined;
  let found: StarArrival | undefined;
  const g = findRunwayEnd(airport, runwayEnd);
  const ref = findStar(airport);
  if (g && ref && starRunwayLeg(ref.star, g.end.id)) {
    const entries: StarEntry[] = [];
    for (const fix of STAR_SIM_ENTRY_FIXES) {
      const r = starRouteFrom(airport, ref, fix, g.end.id);
      const nav = findNavFix(airport, fix);
      if (!r || !nav) continue;
      const restr = ref.star.restrictions.find((x) => x.fix.toUpperCase() === nav.id.toUpperCase());
      const min = restr?.atFt ?? restr?.atOrAboveFt ?? 10000;
      const max = restr?.atFt ?? restr?.atOrBelowFt ?? min + 2000;
      entries.push({ fix: nav.id, transition: r.transition, route: r.fixes, minAltitudeFt: min, maxAltitudeFt: max });
    }
    if (entries.length) found = { ref, runwayEnd: g.end.id, entries };
  }
  per.set(runwayEnd, found ?? null);
  return found;
}

/** The ROZZE TWO arrival is "turbojet aircraft only" (chart note): a turboprop or piston aircraft does not use it. */
export function isTurbojet(type: string): boolean {
  return getPerformance(type).category !== 'light';
}

/** An altitude in the entry window, in whole thousands (seeded). */
export function pickStarEntryAltitudeFt(rng: Rng, e: StarEntry): number {
  const lo = Math.ceil(e.minAltitudeFt / 1000);
  const hi = Math.max(lo, Math.floor(e.maxAltitudeFt / 1000));
  return (lo + Math.floor(rng() * (hi - lo + 1))) * 1000;
}

/** A flight that appears over a STAR entry fix on the Approach frequency, already on the arrival (lateral route; descend via still to come). */
export function starArrivalSpawn(
  airport: Airport, rng: Rng,
  o: { callsign: string; type: string; runwayEnd: string; atSec: number; entry?: string },
): ScenarioAircraftSpawn | undefined {
  const sa = starArrival(airport, o.runwayEnd);
  if (!sa || !isTurbojet(o.type)) return undefined;
  const e = (o.entry ? sa.entries.find((x) => x.fix === o.entry) : undefined) ?? sa.entries[Math.min(sa.entries.length - 1, Math.floor(rng() * sa.entries.length))];
  return {
    atSec: o.atSec, callsign: o.callsign, type: o.type, flightRules: 'IFR',
    start: { kind: 'at_fix', fix: e.fix, altitudeFt: pickStarEntryAltitudeFt(rng, e), speedKt: STAR_ENTRY_SPEED_KT, route: e.route, runwayEnd: sa.runwayEnd, star: { procedureId: sa.ref.procedure.id, transition: e.transition || undefined } },
    isDeparture: false, initialFrequencyId: 'APP', initialRequest: 'APPROACH',
  };
}

// ---------------------------------------------------------------------------
// Departure flight plans
// ---------------------------------------------------------------------------

interface Destination {
  icao: string;
  /** Cruise altitude choices for an A320 on this leg (ft). */
  jet: number[];
  /** Departure exit fix, resolved against `airport.navaids` (dropped when the fix is not in the dataset). */
  exit: string;
}

/** Realistic short hops from KACY. The parser knows all of these airport names (src/commands/airports.ts). */
export const IFR_DESTINATIONS: readonly Destination[] = [
  { icao: 'KPHL', jet: [10000, 12000], exit: 'CYN' },
  { icao: 'KBWI', jet: [14000, 16000], exit: 'ENO' },
  { icao: 'KDCA', jet: [16000, 18000], exit: 'ENO' },
  { icao: 'KEWR', jet: [12000, 14000], exit: 'COL' },
  { icao: 'KJFK', jet: [13000, 15000], exit: 'COL' },
  { icao: 'KBOS', jet: [21000, 23000], exit: 'COL' },
];

/**
 * Gameplay destinations for airports other than KACY: the union of the legs the airlines of the airport's traffic profile fly
 * (`airportProfile.ts`; Southwest to Baltimore, American to Charlotte, ...). Not aeronautical data: just airports the command parser knows
 * (src/commands/airports.ts); no departure exit fix is named (the filed route is empty, the departure frequency is the airport's first DEP
 * frequency). The airline entries themselves choose destination and cruise altitude at generation time; this list serves the lookups.
 */
const KMHT_PROFILE_DESTINATIONS: readonly Destination[] = profileDestinations(profileFor('KMHT')).map((d) => ({ icao: d.icao, jet: [...d.altitudesFt], exit: '' }));

/** The destination list for an airport (KACY: the short hops above). */
export function ifrDestinationsFor(airport: Pick<Airport, 'icao'>): readonly Destination[] {
  return airport.icao === 'KMHT' ? KMHT_PROFILE_DESTINATIONS : IFR_DESTINATIONS;
}

/** C172 IFR cruise: 4,000-6,000 ft. */
export const C172_IFR_CRUISE_FT: readonly number[] = [4000, 5000, 6000];

export function ifrFlightPlan(
  airport: Airport, rng: Rng, type: string, o: { destination?: string; cruiseAltitudeFt?: number } = {},
): Omit<FlightPlan, 'ifrClearance'> {
  const light = getPerformance(type).category === 'light';
  const all = ifrDestinationsFor(airport);
  const pool = light ? all.slice(0, 2) : all; // a Cessna flies the short hops (the first two destinations)
  const dest = (o.destination ? pool.concat(all).find((d) => d.icao === o.destination) : undefined) ?? pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  const alts = light ? C172_IFR_CRUISE_FT : dest.jet;
  const cruise = o.cruiseAltitudeFt ?? alts[Math.min(alts.length - 1, Math.floor(rng() * alts.length))];
  const exit = dest.exit ? findNavFix(airport, dest.exit)?.id : undefined;
  return { flightRules: 'IFR', origin: airport.icao, destination: dest.icao, cruiseAltitudeFt: cruise, route: exit ? [exit] : [] };
}

/** A parked IFR departure that starts on Clearance Delivery. */
export function ifrDepartureSpawn(
  airport: Airport, rng: Rng, o: { callsign: string; type: string; parkingId: string; atSec: number; destination?: string; cruiseAltitudeFt?: number },
): ScenarioAircraftSpawn {
  return {
    atSec: o.atSec, callsign: o.callsign, type: o.type, flightRules: 'IFR',
    start: { kind: 'parked', parkingId: o.parkingId }, isDeparture: true, initialFrequencyId: 'CLNC', initialRequest: 'IFR_CLEARANCE',
    flightPlan: ifrFlightPlan(airport, rng, o.type, { destination: o.destination, cruiseAltitudeFt: o.cruiseAltitudeFt }),
  };
}

/** An IFR arrival over a fix of the runway's procedure, on the Approach frequency. */
export function ifrArrivalSpawn(
  airport: Airport, rng: Rng,
  o: { callsign: string; type: string; runwayEnd: string; atSec: number; fromFeeder?: boolean; altitudeFt?: number; speedKt?: number },
): ScenarioAircraftSpawn | undefined {
  const viaStar = starArrivalSpawn(airport, rng, { callsign: o.callsign, type: o.type, runwayEnd: o.runwayEnd, atSec: o.atSec });
  if (viaStar) return viaStar;
  const proc = arrivalProcedure(airport, o.runwayEnd);
  if (!proc) return undefined;
  const fromFeeder = !!o.fromFeeder && !!proc.feederFix;
  const alt = o.altitudeFt ?? pickArrivalAltitudeFt(rng, fromFeeder);
  return {
    atSec: o.atSec, callsign: o.callsign, type: o.type, flightRules: 'IFR',
    start: arrivalAtFix(airport, proc, { altitudeFt: alt, speedKt: o.speedKt ?? ifrArrivalSpeedKt(o.type), fromFeeder }),
    isDeparture: false, initialFrequencyId: 'APP', initialRequest: 'APPROACH',
  };
}
