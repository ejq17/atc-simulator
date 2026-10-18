/**
 * Scenario traffic generator (`createTrafficGenerator`).
 *
 * Poisson-ish, seeded, deterministic: exponential inter-arrival clocks run separately for arrivals and departures
 * at the scenario's hourly rates scaled by a difficulty ramp. When a clock fires a spawn becomes "due"; the generator
 * releases due spawns one at a time, alternating arrival/departure, subject to hard rules:
 *
 *  - never more than `traffic.maxAircraft` aircraft in the sim,
 *  - at least `MIN_SPAWN_SPACING_SEC` (45 s) between generated spawns,
 *  - arrivals 10-12 nm out on the active landing runway's final or a base-leg offset, 2,500-3,000 ft, never within
 *    3 nm of another arrival (5 nm when a faster aircraft would sit behind a slower one on the same final),
 *  - the airline mix, equipment, destinations and VFR neighbours come from the airport's traffic profile (`airportProfile.ts`): KACY
 *    Spirit/American A320s, KMHT Southwest B738, Breeze BCS3, American/United regionals (CRJ9, E175), UPS/FedEx B752 (night-weighted
 *    in real-time mode), Wiggins C208 (day-weighted) and GA,
 *  - departures on a free parking position (GA ramp / FBO for GA and the C208, gates for airliners, the cargo apron for freighters); an
 *    airliner departs only when the active departure runway is long enough for its type (A320 not on KACY 4/22 from an intersection),
 *  - IFR flows (`resolveIfrFlows`, ifr.ts): airline arrivals appear over the fix of the procedure serving the landing runway (ILS 13 via
 *    CARYL, ILS 31 via STEVV, RNAV 22 via KOPCE, RNAV 4 via JEDOB; sometimes from the first feeder such as VCN) at 3,000-5,000 ft on the Approach
 *    frequency, never within 5 nm of another airborne aircraft and never less than 90 s after the previous arrival on the same procedure; airline
 *    departures are parked IFR departures with a flight plan that call Clearance Delivery. GA stays VFR. Without APP (Tower-only sessions) arrivals
 *    keep appearing on final and airline departures keep calling Ground,
 *  - unique callsigns (never one already used in the scenario or session, never one that sounds like an active aircraft).
 *
 * The generator keeps all its state in the closure; `update(state)` is called every engine tick, so the fast path is
 * a couple of comparisons.
 */
import type { Airport, Scenario, SimulationState } from '../sim/types';
import type { SpawnSpec, TrafficGenerator } from '../sim/traffic';
import { createNullTrafficGenerator } from '../sim/traffic';
import { mulberry32 } from '../sim/rng';
import type { Rng } from '../sim/rng';
import { NM, callsignTail, randomNNumber, runwayLongEnoughFor } from './world';
import { pickFlight, pickGaType, pickLeg, profileFor, resolveTypeSelection, usableAirlines } from './airportProfile';
import type { Flight } from './airportProfile';
import { localHourAt } from './trafficDensity';
import { simUtcMs } from '../sim/solar';
import { pickArrivalStart, pickParking } from './placement';
import type { AirbornePoint } from './placement';
import type { Difficulty, GameScenario } from './types';
import { arrivalJoinNm, arrivalProcedure, ifrArrivalSpawn, ifrDepartureSpawn, resolveIfrFlows } from './ifr';
import { alongCross, findRunwayEnd } from '../sim/runways';
import { mToNm } from '../sim/geo';
import { findNavFix } from '../sim/navigation';

export const MIN_SPAWN_SPACING_SEC = 45;
/** IFR arrivals on the same procedure: at least this long apart in time ... */
export const IFR_ARRIVAL_SPACING_SEC = 90;
/** ... and this far from any other airborne aircraft at the moment they appear. */
export const IFR_ARRIVAL_SPACING_NM = 5;
/** Share of generated IFR arrivals that start at the first feeder (VCN for ILS 13) instead of the initial fix, when the procedure has one. */
export const IFR_FEEDER_START_SHARE = 0.25;
/** Minimum distance (nm along the course) between the engine's in-trail measuring point for a new IFR arrival and any other arrival of the runway. */
export const IFR_JOIN_CLEAR_NM = 3.5;

/** Intensity ramp: multiplier on the hourly rates, rising linearly from `start` to `end` over `rampSec`, then flat. */
export const DIFFICULTY_RAMP: Record<Difficulty, { start: number; end: number; rampSec: number }> = {
  easy: { start: 0.5, end: 1.0, rampSec: 20 * 60 },
  normal: { start: 0.6, end: 1.25, rampSec: 15 * 60 },
  hard: { start: 0.8, end: 1.8, rampSec: 10 * 60 },
};

export function rampFactor(difficulty: Difficulty, timeSec: number): number {
  const r = DIFFICULTY_RAMP[difficulty];
  const f = Math.min(1, Math.max(0, timeSec / r.rampSec));
  return r.start + (r.end - r.start) * f;
}

const exp = (rng: Rng, meanSec: number): number => -Math.log(1 - rng() * 0.999999) * meanSec;

export interface TrafficGeneratorOptions {
  /**
   * Time-of-day density in 0..1 (see `trafficDensity.ts`), read from the state each time a spawn clock fires. The scenario's hourly rates are the
   * peak-bank rates; a firing is kept with probability `densityAt(state)` (thinning of a Poisson process, so the arrival rate follows the curve
   * exactly and no long night-time gap lingers after the morning bank starts). Unset = constant rate (tests, scripted scenarios).
   */
  densityAt?: (state: Readonly<SimulationState>) => number;
}

export function createTrafficGenerator(scenario: Scenario, airport: Airport, options: TrafficGeneratorOptions = {}): TrafficGenerator {
  const cfg = scenario.traffic;
  if (!cfg || !cfg.enabled) return createNullTrafficGenerator();
  const gs = scenario as GameScenario;
  const difficulty: Difficulty = gs.difficulty ?? 'normal';
  const icao = airport.icao;
  const sel = resolveTypeSelection(icao, gs.aircraftTypes);
  const allowGA = sel.ga;
  const allowJet = sel.jets;
  const gaFraction = allowGA && allowJet ? cfg.gaFraction : allowGA ? 1 : 0;
  const towerOnly = !scenario.controllerPositions.includes('GND');
  const flows = resolveIfrFlows(gs);
  const arrivalFreq = scenario.controllerPositions.includes('TWR') || !scenario.controllerPositions.includes('APP') ? 'TWR' : 'APP';
  const departureFreq = towerOnly ? 'TWR' : 'GND';

  const profile = profileFor(icao);
  let rng: Rng | undefined;
  let nextArr = Infinity;
  let nextDep = Infinity;
  let dueArr = 0;
  let dueDep = 0;
  let lastSpawnAt = -Infinity;
  let lastKind: 'arr' | 'dep' = 'dep';
  let retryAt = 0;
  /** runway end -> time of the last IFR arrival generated for its procedure. */
  const lastIfrArrival = new Map<string, number>();
  const used = new Set<string>(scenario.spawns.map((s) => s.callsign.toUpperCase()));
  /** parking id -> time reserved; released once an aircraft stands there or after 20 s. */
  const reserved = new Map<string, number>();
  let counter = 0;

  const gap = (kind: 'arr' | 'dep', now: number): number => {
    const perHour = kind === 'arr' ? cfg.arrivalsPerHour : cfg.departuresPerHour;
    if (perHour <= 0) return Infinity;
    return exp(rng!, 3600 / (perHour * rampFactor(difficulty, now)));
  };

  /**
   * Next flight (callsign + type), unique among callsigns used so far and not sounding like an active aircraft. Not marked as used until
   * `commit`, so a spawn that is dropped (no parking, no spacing) wastes no callsign. `fits` restricts airliner types (runway length).
   */
  const nextFlight = (ga: boolean, state: Readonly<SimulationState>, fits?: (type: string) => boolean): Flight | undefined => {
    const tails = new Set(Object.values(state.aircraft).map((a) => callsignTail(a.callsign)));
    let allowedTypes: ReadonlySet<string> | undefined = sel.allowed;
    if (!ga && fits) {
      const cand = new Set(usableAirlines(profile, sel.allowed).flatMap((e) => e.types).filter((t) => (!sel.allowed || sel.allowed.has(t)) && fits(t)));
      if (!cand.size) return undefined;
      allowedTypes = cand;
    }
    const localHour = options.densityAt ? localHourAt(simUtcMs(state)) : undefined;
    let last: Flight | undefined;
    for (let i = 0; i < 80; i++) {
      const f: Flight | undefined = ga ? { callsign: randomNNumber(rng!), type: pickGaType(rng!, icao) } : pickFlight(rng!, icao, { allowedTypes, localHour });
      if (!f) return undefined;
      last = f;
      if (used.has(f.callsign) || tails.has(callsignTail(f.callsign))) continue;
      return f;
    }
    let cs: string;
    const prefix = last?.entry?.icao3 ?? profile.airlines[0].icao3;
    do cs = ga ? `N${100 + ++counter}ZZ` : `${prefix}${9000 + ++counter}`;
    while (used.has(cs));
    return { ...last!, callsign: cs };
  };
  const commit = (f: Flight): string => {
    used.add(f.callsign);
    return f.callsign;
  };

  const trySpawnArrival = (state: Readonly<SimulationState>): SpawnSpec | undefined => {
    const ends = state.activeRunways.landing.length ? state.activeRunways.landing : state.activeRunways.departing;
    if (!ends.length) return undefined;
    const ga = rng!() < gaFraction;
    const flight = nextFlight(ga, state);
    if (!flight) return undefined;
    const type = flight.type;
    const endId = ends[Math.min(ends.length - 1, Math.floor(rng!() * ends.length))];
    if (!ga && flows.arrivals && arrivalProcedure(airport, endId)) return trySpawnIfrArrival(state, flight, endId);
    const others: AirbornePoint[] = Object.values(state.aircraft)
      .filter((a) => !a.onGround)
      .map((a) => ({ pos: a.pos, type: a.type, runwayEnd: a.isDeparture ? undefined : a.assignedRunwayEnd }));
    const start = pickArrivalStart(airport, endId, type, rng!, others);
    if (!start) return undefined;
    const leg = pickLeg(rng!, icao, flight);
    return {
      atSec: state.clock.timeSec, callsign: commit(flight), type, flightRules: ga ? 'VFR' : 'IFR', start,
      isDeparture: false, initialFrequencyId: arrivalFreq, initialRequest: 'LANDING', ...(leg.remoteAirport ? { remoteAirport: leg.remoteAirport } : {}),
    };
  };

  /** An airline arrival over the procedure fix, or undefined while spacing does not allow one (the caller retries). */
  const trySpawnIfrArrival = (state: Readonly<SimulationState>, flight: Flight, endId: string): SpawnSpec | undefined => {
    const proc = arrivalProcedure(airport, endId)!;
    const now = state.clock.timeSec;
    const last = lastIfrArrival.get(endId);
    if (last !== undefined && now - last < IFR_ARRIVAL_SPACING_SEC) return undefined;
    // Candidate start points: the initial fix and (when the procedure has one) the first feeder. A candidate is usable when every other airborne
    // aircraft is 5 nm away and no arrival of this runway sits within 3.5 nm of the point where the engine will measure the new aircraft's
    // in-trail gap (see `arrivalJoinNm`), so an approach clearance at check-in is never flagged as an unsafe clearance.
    const g = findRunwayEnd(airport, endId);
    const usable = (fromFeeder: boolean): boolean => {
      const fixPos = findNavFix(airport, fromFeeder ? proc.feederFix : proc.ifFix)?.pos;
      if (!fixPos || !g) return false;
      const join = arrivalJoinNm(proc, fromFeeder);
      for (const a of Object.values(state.aircraft)) {
        if (a.onGround) continue;
        if (Math.hypot(a.pos.x - fixPos.x, a.pos.y - fixPos.y) / NM < IFR_ARRIVAL_SPACING_NM) return false;
        if (!a.isDeparture && a.assignedRunwayEnd === endId && Math.abs(join - mToNm(-alongCross(g, a.pos).along)) < IFR_JOIN_CLEAR_NM) return false;
      }
      return true;
    };
    const options = [false, ...(proc.feederFix ? [true] : [])].filter(usable);
    if (!options.length) return undefined;
    const fromFeeder = options.length > 1 ? rng!() < IFR_FEEDER_START_SHARE : options[0];
    const spec = ifrArrivalSpawn(airport, rng!, { callsign: flight.callsign, type: flight.type, runwayEnd: endId, atSec: now, fromFeeder });
    if (!spec) return undefined;
    commit(flight);
    lastIfrArrival.set(endId, now);
    const leg = pickLeg(rng!, icao, flight);
    return leg.remoteAirport ? { ...spec, remoteAirport: leg.remoteAirport } : spec;
  };

  const trySpawnDeparture = (state: Readonly<SimulationState>): SpawnSpec | undefined => {
    const depEnds = state.activeRunways.departing.length ? state.activeRunways.departing : state.activeRunways.landing;
    let ga = rng!() < gaFraction;
    let flight: Flight | undefined;
    // An airliner needs a runway long enough for its type; fall back to a GA aircraft (if allowed) when the departure runway is short.
    if (!ga) {
      flight = nextFlight(false, state, (t) => depEnds.length === 0 || depEnds.some((e) => runwayLongEnoughFor(airport, t, e)));
      if (!flight) {
        if (!allowGA) return undefined;
        ga = true;
      }
    }
    if (ga) flight = nextFlight(true, state);
    if (!flight) return undefined;
    const type = flight.type;
    const occupied = Object.values(state.aircraft).filter((a) => a.onGround).map((a) => a.pos);
    const parking = pickParking(airport, type, rng!, occupied, new Set(reserved.keys()));
    if (!parking) return undefined;
    reserved.set(parking.id, state.clock.timeSec);
    const leg = pickLeg(rng!, icao, flight);
    const remote = leg.remoteAirport ? { remoteAirport: leg.remoteAirport } : {};
    if (!ga && flows.departures) {
      const spec = ifrDepartureSpawn(airport, rng!, {
        callsign: commit(flight), type, parkingId: parking.id, atSec: state.clock.timeSec, destination: leg.destination, cruiseAltitudeFt: leg.cruiseAltitudeFt,
      });
      return { ...spec, ...remote };
    }
    return {
      atSec: state.clock.timeSec, callsign: commit(flight), type, flightRules: ga ? 'VFR' : 'IFR',
      start: { kind: 'parked', parkingId: parking.id }, isDeparture: true, initialFrequencyId: departureFreq, initialRequest: 'TAXI', ...remote,
    };
  };

  /** Thinning by time of day; consumes no random number without a density curve (seeded runs stay identical). */
  const keep = (state: Readonly<SimulationState>): boolean => {
    if (!options.densityAt) return true;
    return rng!() < options.densityAt(state);
  };

  return {
    update(state) {
      const now = state.clock.timeSec;
      if (!rng) {
        rng = mulberry32((state.seed ^ 0x7a3c91d5) >>> 0);
        // The first generated aircraft appears after a short lull so the player can read the briefing.
        nextArr = now + 20 + gap('arr', now) * 0.5;
        nextDep = now + 35 + gap('dep', now) * 0.5;
      }
      if (now >= nextArr) {
        if (keep(state)) dueArr = Math.min(2, dueArr + 1);
        nextArr = now + gap('arr', now);
      }
      if (now >= nextDep) {
        if (keep(state)) dueDep = Math.min(2, dueDep + 1);
        nextDep = now + gap('dep', now);
      }
      if ((dueArr === 0 && dueDep === 0) || now < retryAt || now - lastSpawnAt < MIN_SPAWN_SPACING_SEC) return [];
      if (Object.keys(state.aircraft).length >= cfg.maxAircraft) {
        retryAt = now + 5;
        return [];
      }
      // Release parking reservations once the aircraft exists (it blocks via the occupied check) or the spawn was dropped.
      for (const [id, t] of reserved) if (now - t > 20) reserved.delete(id);

      const order: ('arr' | 'dep')[] = [];
      const wantArr = dueArr > 0;
      const wantDep = dueDep > 0;
      if (wantArr && wantDep) order.push(lastKind === 'arr' ? 'dep' : 'arr', lastKind === 'arr' ? 'arr' : 'dep');
      else if (wantArr) order.push('arr');
      else order.push('dep');
      for (const kind of order) {
        const spec = kind === 'arr' ? trySpawnArrival(state) : trySpawnDeparture(state);
        if (spec) {
          if (kind === 'arr') dueArr--;
          else dueDep--;
          lastKind = kind;
          lastSpawnAt = now;
          return [spec];
        }
      }
      retryAt = now + 10;
      return [];
    },
  };
}
