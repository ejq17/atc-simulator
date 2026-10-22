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
import { resolvePilotBehaviour } from '../sim/pilotBehaviour';
import { NM, callsignTail, randomNNumber, runwayLongEnoughFor } from './world';
import { pickFlight, pickGaType, pickLeg, profileFor, resolveTypeSelection, usableAirlines } from './airportProfile';
import type { Flight } from './airportProfile';
import { CARGO_PREFIXES } from './airportProfile';
import { airportTimeZone, localHourAt } from './trafficDensity';
import { simUtcMs } from '../sim/solar';
import { pickArrivalStart, pickParking } from './placement';
import type { AirbornePoint } from './placement';
import type { Difficulty, GameScenario } from './types';
import { arrivalJoinNm, arrivalProcedure, ifrArrivalSpawn, ifrDepartureSpawn, isTurbojet, resolveIfrFlows, starArrival, starArrivalSpawn } from './ifr';
import { alongCross, crossingRunways, findRunwayEnd } from '../sim/runways';
import { getPerformance } from '../sim/performance';
import { mToNm } from '../sim/geo';
import { findNavFix } from '../sim/navigation';
import { createSpecialTrafficGenerator, isTrainingFlight, trainingCircuits } from './specialGenerator';
import { profileFor as profileForSpecial } from './airportProfile';
import { resolveSpecialTraffic } from './specialTraffic';

export const MIN_SPAWN_SPACING_SEC = 45;
/**
 * Arrival flow control (design values; nothing in the FAA order fixes them). A new arrival is held back (the clock stays due and the generator
 * retries) while it would reach the threshold within `ARRIVAL_SLOT_SEC` of another arrival for the same runway, or while `MAX_ARRIVALS_IN_FLIGHT`
 * arrivals are airborne and not yet landed. This is the acceptance rate of one runway shared with departures, crossings and taxiing arrivals
 * (docs/PROGRESS.md, "Free-play jam"): without it the Poisson clock puts several light aircraft on the same final within minutes, and the
 * Tower can only send them around or hold them on an extended downwind.
 */
export const ARRIVAL_SLOT_SEC = 200;
/**
 * ... and, while departures stand at a hold line of the runway waiting for it, `ARRIVAL_SLOT_BASE_SEC + n * ARRIVAL_SLOT_PER_DEPARTURE_SEC` for n waiting departures
 * (n capped at 3, never below `ARRIVAL_SLOT_SEC`): the runway then needs a gap for each of them as well, which Approach leaves when it spaces arrivals (JO 7110.65
 * 3-9-5 anticipating separation, 3-8-1 sequencing). The figures are the engine's own: a light aircraft that rolls out to the far exit holds the runway about 130 s
 * (KACY 4/22, exit A at 1,860 m), and a jet departure behind a light arrival needs `neededEtaSec` = 143 s (ai/tower.ts), rounded up to 150 s, before the next arrival
 * crosses the threshold: one departure 130 + 150 = 280 s. DESIGN VALUES (nothing in the order fixes a slot). The soak showed departures waiting 1,490 s at a 200 s slot
 * (docs/DESIGN-VALUES.md section 9).
 */
export const ARRIVAL_SLOT_BASE_SEC = 130;
export const ARRIVAL_SLOT_PER_DEPARTURE_SEC = 150;
/** The arrival slot (s) while `departuresWaiting` departures have stood ready at the hold line for `DEPARTURE_WAIT_FOR_SLOT_SEC`. */
export const arrivalSlotSec = (departuresWaiting: number): number => Math.max(ARRIVAL_SLOT_SEC, ARRIVAL_SLOT_BASE_SEC + Math.min(3, departuresWaiting) * ARRIVAL_SLOT_PER_DEPARTURE_SEC);
/** A departure counts as waiting for a gap after standing ready at the hold line this long (s). DESIGN VALUE. */
export const DEPARTURE_WAIT_FOR_SLOT_SEC = 120;
export const MAX_ARRIVALS_IN_FLIGHT = 6;
/**
 * Departure flow control (design value): no new departure appears at a gate while this many departures are on the ground and not yet airborne
 * (parked and calling, pushing back, taxiing, at the hold). The airline would hold the flight at the gate with an "expect a delay" message.
 */
export const MAX_DEPARTURES_ON_GROUND = 5;
/** Nominal minutes-to-threshold of a new arrival (it appears 10-12 nm out at 100 kt and slows to its approach speed; an airliner appears at the procedure fix). */
const NOMINAL_ETA_LIGHT_SEC = 520;
const NOMINAL_ETA_JET_SEC = 330;
const EXPECTED_SPEED_LIGHT_KT = 70;
const EXPECTED_SPEED_JET_KT = 145;
/** Seconds counted for an arrival already in the pattern or on a missed approach (it is at the field and will land within a few minutes). */
const NEAR_FIELD_ETA_SEC = 150;
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
  const similarRate = resolvePilotBehaviour(scenario.pilotBehaviour, scenario.mode, scenario.pilotRealism).realism.similarCallsignRate;
  const specialSel = resolveSpecialTraffic(icao, gs.specialTraffic);
  const trainingShare = profileForSpecial(icao).special?.training?.gaShare ?? 0;
  const specialGen = createSpecialTrafficGenerator(gs, airport, options);
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
    const localHour = options.densityAt ? localHourAt(simUtcMs(state), airportTimeZone(airport)) : undefined;
    let last: Flight | undefined;
    for (let i = 0; i < 80; i++) {
      let f: Flight | undefined = ga ? { callsign: randomNNumber(rng!), type: pickGaType(rng!, icao) } : pickFlight(rng!, icao, { allowedTypes, localHour });
      if (!f) return undefined;
      // pilot realism: now and then a flight whose callsign sounds like one already on the airport (AIM 4-2-4 acknowledges that this happens;
      // JO 7110.65 2-4-20 / 2-4-15 give the controller the tools). The random draws happen only when the rate is set.
      const alike = similarRate > 0 && rng!() < similarRate ? soundAlike(f, ga, state) : undefined;
      if (alike) f = alike;
      last = f;
      if (used.has(f.callsign)) continue;
      if (!alike && tails.has(callsignTail(f.callsign))) continue;
      return f;
    }
    let cs: string;
    const prefix = last?.entry?.icao3 ?? profile.airlines[0].icao3;
    do cs = ga ? `N${100 + ++counter}ZZ` : `${prefix}${9000 + ++counter}`;
    while (used.has(cs));
    return { ...last!, callsign: cs };
  };
  /** The flight with a callsign that shares its last two characters / digits with an active aircraft of the same kind; undefined when there is none. */
  const soundAlike = (f: Flight, ga: boolean, state: Readonly<SimulationState>): Flight | undefined => {
    const active = Object.values(state.aircraft).map((a) => a.callsign).filter((c) => (ga ? /^N\d/.test(c) : !/^N\d/.test(c)));
    if (!active.length) return undefined;
    const base = active[Math.min(active.length - 1, Math.floor(rng!() * active.length))];
    if (ga) {
      const m = /^N(\d{1,5})([A-Z]{1,2})$/.exec(base);
      if (!m) return undefined;
      const digits = String(1 + Math.floor(rng!() * 9)) + Array.from({ length: Math.max(0, m[1].length - 1) }, () => String(Math.floor(rng!() * 10))).join('');
      return { ...f, callsign: `N${digits}${m[2]}` };
    }
    const m = /^([A-Z]{3})(\d{2,4})$/.exec(base);
    if (!m || !f.entry || f.entry.icao3 !== m[1]) return undefined;
    const lead = m[2].length > 2 ? String(1 + Math.floor(rng!() * 9)) : '';
    return { ...f, callsign: `${m[1]}${lead}${m[2].slice(-2)}` };
  };
  const commit = (f: Flight): string => {
    used.add(f.callsign);
    return f.callsign;
  };

  /** Would an arrival of `type` for `endId` fit the runway's arrival slots (see `ARRIVAL_SLOT_SEC`)? */
  const arrivalFits = (state: Readonly<SimulationState>, endId: string, type: string): boolean => {
    if (cfg.flowControl === false) return true;
    const g = findRunwayEnd(airport, endId);
    if (!g) return true;
    const light = getPerformance(type).category === 'light';
    const mine = light ? NOMINAL_ETA_LIGHT_SEC : NOMINAL_ETA_JET_SEC;
    const rws = [g.runway.id, ...crossingRunways(airport, g.runway.id).map((r) => r.id)];
    const waitingDepartures = Object.values(state.aircraft).filter((a) => a.isDeparture && a.onGround && a.phase === 'HOLDING_SHORT' && a.assignedRunwayEnd !== undefined && state.clock.timeSec - (a.pendingRequest?.sinceSec ?? state.clock.timeSec) >= DEPARTURE_WAIT_FOR_SLOT_SEC
      && rws.includes(findRunwayEnd(airport, a.assignedRunwayEnd)?.runway.id ?? ''));
    const slot = arrivalSlotSec(waitingDepartures.length);
    let inFlight = 0;
    for (const a of Object.values(state.aircraft)) {
      if (a.onGround || a.isDeparture || a.assignedRunwayEnd === undefined || a.flags.transit || a.type === 'H65') continue;
      if (a.phase === 'DEPARTURE' || a.phase === 'INITIAL_CLIMB') continue;
      inFlight++;
      if (a.assignedRunwayEnd !== endId) continue;
      const near = a.phase === 'PATTERN' || a.phase === 'GO_AROUND' || a.phase === 'HOLDING';
      const kt = getPerformance(a.type).category === 'light' ? EXPECTED_SPEED_LIGHT_KT : EXPECTED_SPEED_JET_KT;
      const eta = near ? NEAR_FIELD_ETA_SEC : (mToNm(Math.hypot(a.pos.x - g.end.threshold.x, a.pos.y - g.end.threshold.y)) / kt) * 3600;
      if (Math.abs(eta - mine) < slot) return false;
    }
    return inFlight < MAX_ARRIVALS_IN_FLIGHT;
  };

  /**
   * Freight flights park at the cargo apron when the airport has one: UPS / FedEx jets, and the Wiggins Caravan (a FedEx feeder; its departures
   * leave from the GA ramp / FBO, as `parkingPoolFor` has always chosen, only the arrival is bound for the cargo apron). The engine resolves the stand.
   */
  const withParkingIntent = (spec: SpawnSpec, flight: Flight): SpawnSpec => {
    const cargo = CARGO_PREFIXES.has(flight.callsign.slice(0, 3)) || flight.entry?.icao3 === 'WIG';
    return cargo && airport.parking.some((p) => p.category === 'cargo') ? { ...spec, parkingCategory: 'cargo' } : spec;
  };

  const withParkingOpt = (spec: SpawnSpec | undefined, flight: Flight): SpawnSpec | undefined => (spec ? withParkingIntent(spec, flight) : spec);

  /** Landing runway ends an arrival of `type` may be given: long enough (declared LDA), approach available first, arrival slot free. */
  const arrivalEndsFor = (state: Readonly<SimulationState>, ends: readonly string[], type: string, ga: boolean): string[] => {
    if (ends.length === 1) return arrivalFits(state, ends[0], type) ? [ends[0]] : [];
    const ldaOk = (e: string): boolean => {
      const g = findRunwayEnd(airport, e);
      return !g || getPerformance(type).landingDistanceFt <= g.ldaM / 0.3048;
    };
    const long = ends.filter(ldaOk);
    const base = long.length ? long : [...ends];
    const withApproach = !ga && flows.arrivals ? base.filter((e) => (isTurbojet(type) && starArrival(airport, e)) || arrivalProcedure(airport, e)) : [];
    const preferred = withApproach.length ? withApproach : base;
    return preferred.filter((e) => arrivalFits(state, e, type));
  };

  const trySpawnArrival = (state: Readonly<SimulationState>): SpawnSpec | undefined => {
    const ends = state.activeRunways.landing.length ? state.activeRunways.landing : state.activeRunways.departing;
    if (!ends.length) return undefined;
    const ga = rng!() < gaFraction;
    const flight = nextFlight(ga, state);
    if (!flight) return undefined;
    const type = flight.type;
    // Several landing runways (a published configuration, e.g. KBOS 4R + 4L or KPHL 27R): the arrival goes to one of the runways that can take
    // the type (landing distance available), preferring runways with an IFR procedure for an airliner when IFR flows are on, and whose arrival
    // slot is free. One random number is drawn whatever the count, so single-runway seeds are unchanged.
    const pool = arrivalEndsFor(state, ends, type, ga);
    const draw = rng!(); // drawn even when no runway can take the arrival (keeps the seeded stream of single-runway runs unchanged)
    if (!pool.length) return undefined;
    const endId = pool[Math.min(pool.length - 1, Math.floor(draw * pool.length))];
    if (!ga && flows.arrivals && isTurbojet(type) && starArrival(airport, endId)) return withParkingOpt(trySpawnStarArrival(state, flight, endId), flight);
    if (!ga && flows.arrivals && arrivalProcedure(airport, endId)) return withParkingOpt(trySpawnIfrArrival(state, flight, endId), flight);
    const others: AirbornePoint[] = Object.values(state.aircraft)
      .filter((a) => !a.onGround)
      .map((a) => ({ pos: a.pos, type: a.type, runwayEnd: a.isDeparture ? undefined : a.assignedRunwayEnd }));
    const start = pickArrivalStart(airport, endId, type, rng!, others);
    if (!start) return undefined;
    const leg = pickLeg(rng!, icao, flight);
    // Flight training: a seeded share of the GA arrivals fly touch-and-go circuits (decided from the callsign: no random number is drawn)
    const training = ga && specialSel.training && isTrainingFlight(flight.callsign, trainingShare);
    return withParkingIntent({
      atSec: state.clock.timeSec, callsign: commit(flight), type, flightRules: ga ? 'VFR' : 'IFR', start,
      isDeparture: false, initialFrequencyId: arrivalFreq, initialRequest: 'LANDING', ...(leg.remoteAirport ? { remoteAirport: leg.remoteAirport } : {}),
      ...(training ? { behavior: { kind: 'training' as const, circuits: trainingCircuits(flight.callsign) } } : {}),
    }, flight);
  };

  /**
   * A turbojet arrival over a STAR entry fix (KMHT ROZZE TWO; `starArrival` in ifr.ts), or undefined while spacing does not allow one: no other
   * airborne aircraft within 5 nm of the entry fix and at least 90 s since the previous IFR arrival to the runway. The arrivals share the STAR route
   * at the same speed, so the in-trail gap at the entry fix stays the gap on final until the Approach controller changes it.
   */
  const trySpawnStarArrival = (state: Readonly<SimulationState>, flight: Flight, endId: string): SpawnSpec | undefined => {
    const sa = starArrival(airport, endId)!;
    const now = state.clock.timeSec;
    const last = lastIfrArrival.get(endId);
    if (last !== undefined && now - last < IFR_ARRIVAL_SPACING_SEC) return undefined;
    const usable = sa.entries.filter((e) => {
      const p = findNavFix(airport, e.fix)?.pos;
      if (!p) return false;
      return Object.values(state.aircraft).every((a) => a.onGround || Math.hypot(a.pos.x - p.x, a.pos.y - p.y) / NM >= IFR_ARRIVAL_SPACING_NM);
    });
    if (!usable.length) return undefined;
    const entry = usable[Math.min(usable.length - 1, Math.floor(rng!() * usable.length))];
    const spec = starArrivalSpawn(airport, rng!, { callsign: flight.callsign, type: flight.type, runwayEnd: endId, atSec: now, entry: entry.fix });
    if (!spec) return undefined;
    commit(flight);
    lastIfrArrival.set(endId, now);
    const leg = pickLeg(rng!, icao, flight);
    return leg.remoteAirport ? { ...spec, remoteAirport: leg.remoteAirport } : spec;
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
    let waiting = 0;
    for (const a of Object.values(state.aircraft)) if (a.isDeparture && a.onGround && !['TAKEOFF_ROLL', 'INITIAL_CLIMB', 'DEPARTURE'].includes(a.phase) && !a.flags.vehicleTask && a.type !== 'H65') waiting++;
    if (cfg.flowControl !== false && waiting >= MAX_DEPARTURES_ON_GROUND) return undefined;
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

  const base: TrafficGenerator = {
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
  if (!specialGen) return base;
  return { update: (state) => [...base.update(state), ...specialGen.update(state)] };
}
