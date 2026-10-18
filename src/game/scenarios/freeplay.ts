/**
 * Free play builder. Honours every `FreePlayOptions` field:
 *
 *  seed             PRNG seed for placement, callsigns and (via scenario.seed) the engine/traffic generator.
 *  weather          preset id ('clear', 'imc', ...), 'random' (seeded), 'live' (left as 'live'; the UI fetches the METAR),
 *                   or a full Weather object.
 *  activeRunways    explicit config, else `recommendRunways` on the weather (A320-capable ends only when jets are in play).
 *  aircraftCount    initial aircraft: parked departures + inbound arrivals that do not conflict at spawn.
 *  arrivalsPerHour / departuresPerHour / gaFraction / maxAircraft   continuous traffic (see ../traffic.ts).
 *  difficulty       easy | normal | hard: default rates, max aircraft and the intensity ramp over time.
 *  aircraftTypes    subset of the airport's traffic types (airportProfile.ts; 'C172' stands for GA). Default: KACY ['C172', 'A320']; KMHT adds
 *                   B738, BCS3, E175, CRJ9, B752 and C208. A selection that allows nothing at the airport means "everything".
 *  startingScenario quiet | busy_departures | busy_arrivals | mixed: initial mix and default rates.
 *  ifrFlows         true: airline arrivals start over the published approach fix on the Approach frequency (staggered 270 s apart; Cessna arrivals are left to the generator) and airline
 *                   departures are parked IFR departures calling Clearance Delivery; the scenario lists CLNC/APP/DEP positions. false/undefined:
 *                   the classic Tower/Ground session (arrivals on final, no flight plans). The traffic generator applies the same switch
 *                   (or, when it is unset, the controller positions) to the aircraft it creates later - see ../ifr.ts.
 */
import type { Airport, ControllerPositionId, Scenario, Vec2, Weather } from '../../sim/types';
import type { FreePlayOptions } from '../index';
import { closedEndsOf } from '../../sim/airportOps';
import { buildAirportEvents } from './airportEvents';
import { mulberry32 } from '../../sim/rng';
import type { Rng } from '../../sim/rng';
import { getPresetWeather, randomWeather, WEATHER_PRESET_IDS } from '../../weather/presets';
import type { WeatherPresetId } from '../../weather/presets';
import { preferredEndOrder, recommendRunways } from '../../weather/runwaySelection';
import type { GameScenario } from '../types';
import { randomNNumber, runwayIdOf, runwayLongEnoughFor, callsignTail } from '../world';
import { pickFlight, pickGaType, pickLeg, profileFor, profileTypes, resolveTypeSelection, usableAirlines } from '../airportProfile';
import type { Flight } from '../airportProfile';
import { pickArrivalStart, pickParking } from '../placement';
import type { AirbornePoint } from '../placement';
import { arrivalProcedure, ifrArrivalSpawn, ifrDepartureSpawn, isTurbojet, starArrival } from '../ifr';
import { findNavFix } from '../../sim/navigation';

type Start = NonNullable<FreePlayOptions['startingScenario']>;
type Diff = NonNullable<FreePlayOptions['difficulty']>;

const START_PROFILE: Record<Start, { arr: number; dep: number; count: number; depShare: number; label: string; blurb: string }> = {
  quiet: { arr: 4, dep: 4, count: 2, depShare: 0.5, label: 'Quiet morning', blurb: 'A couple of aircraft and a slow trickle of traffic.' },
  busy_departures: { arr: 4, dep: 16, count: 5, depShare: 0.8, label: 'Departure push', blurb: 'The ramp is full of aircraft asking to taxi; a few arrivals mixed in.' },
  busy_arrivals: { arr: 16, dep: 4, count: 5, depShare: 0.2, label: 'Arrival push', blurb: 'A stream of inbound traffic with only a few departures.' },
  mixed: { arr: 9, dep: 9, count: 4, depShare: 0.5, label: 'Typical day', blurb: 'A steady mix of arrivals, departures, GA and airline traffic.' },
};

const DIFF_PROFILE: Record<Diff, { rate: number; max: number }> = {
  easy: { rate: 0.7, max: 6 },
  normal: { rate: 1.0, max: 10 },
  hard: { rate: 1.5, max: 16 },
};

/**
 * Preferred runway order when the wind does not decide (calm wind, or headwinds within the tolerance of each other). 13/31 comes first because it is the
 * longer pair (10,001 ft against 6,145 ft): an operator preference, not a limitation - an A320 can depart 4/22 from full length.
 */
// (KACY: ['13', '31', '22', '4']; see `preferredEndOrder`)

export function resolveWeather(w: FreePlayOptions['weather'], seed: number): Weather | 'live' {
  if (w === undefined || w === null) return getPresetWeather('clear');
  if (typeof w === 'object') return w;
  if (w === 'live') return 'live';
  if (w === 'random') return randomWeather(seed);
  if ((WEATHER_PRESET_IDS as readonly string[]).includes(w)) return getPresetWeather(w as WeatherPresetId);
  return getPresetWeather('clear');
}

/** Runway config for the weather. `jets` restricts the choice to ends the airport's reference airliner (KACY A320, KMHT B738) can depart from (engine performance data vs the declared runway length). */
export function recommendConfig(airport: Airport, weather: Weather | 'live', jets: boolean, closedEnds: readonly string[] = []): { departing: string[]; landing: string[] } {
  const ends = airport.runways.flatMap((r) => r.ends.map((e) => ({ id: e.id, magneticHeadingDeg: e.magneticHeadingDeg })));
  const open = ends.filter((e) => !closedEnds.includes(e.id)); // never a closed runway (JO 7110.65 3-3-2)
  const usable = jets ? open.filter((e) => runwayLongEnoughFor(airport, profileFor(airport.icao).referenceJet, e.id)) : open;
  const pool = usable.length ? usable : open;
  const w = weather === 'live' ? { windDirDeg: 0 as const, windSpeedKt: 0 } : weather;
  const rec = recommendRunways(w, pool, { preferredOrder: preferredEndOrder(airport, 'low'), variationDeg: airport.magneticVariationDeg });
  return { departing: [rec.primary], landing: [rec.primary] };
}

/** Builder-internal overrides (career steps): which IFR flows the initial population uses and the positions the scenario lists. */
export interface FreePlayInternal {
  ifrArrivals?: boolean;
  ifrDepartures?: boolean;
  controllerPositions?: ControllerPositionId[];
}

export function buildFreePlay(airport: Airport, options: FreePlayOptions = {}, internal: FreePlayInternal = {}): GameScenario {
  const seed = (options.seed ?? 1) >>> 0;
  const rng = mulberry32(seed ^ 0x5eed1234);
  const start: Start = options.startingScenario ?? 'mixed';
  const difficulty: Diff = options.difficulty ?? 'normal';
  const prof = START_PROFILE[start];
  const dprof = DIFF_PROFILE[difficulty];

  const sel = resolveTypeSelection(airport.icao, options.aircraftTypes);
  const types = sel.allowed ? [...new Set(options.aircraftTypes)] : profileTypes(airport.icao);
  const jets = sel.jets;
  const ga = sel.ga;
  const gaFraction = ga && jets ? Math.min(1, Math.max(0, options.gaFraction ?? 0.5)) : ga ? 1 : 0;

  const weather = resolveWeather(options.weather, seed);
  const closedEnds = closedEndsOf(airport, options.closures ?? []);
  const requested = options.activeRunways;
  const active = requested && ![...requested.landing, ...requested.departing].some((e) => closedEnds.includes(e)) ? requested : recommendConfig(airport, weather, jets, closedEnds);
  const maxAircraft = Math.max(1, Math.round(options.maxAircraft ?? dprof.max));
  const arrivalsPerHour = Math.max(0, options.arrivalsPerHour ?? Math.round(prof.arr * dprof.rate));
  const departuresPerHour = Math.max(0, options.departuresPerHour ?? Math.round(prof.dep * dprof.rate));
  const count = Math.max(0, Math.min(maxAircraft, Math.round(options.aircraftCount ?? prof.count)));

  const ifrArrivals = internal.ifrArrivals ?? options.ifrFlows === true;
  const ifrDepartures = internal.ifrDepartures ?? options.ifrFlows === true;
  const spawns = initialAircraft(airport, rng, {
    count, depShare: prof.depShare, gaFraction, jets, ga, allowedTypes: sel.allowed, active, departureFreq: 'GND', arrivalFreq: 'TWR', ifrArrivals, ifrDepartures,
  });
  const positions: ControllerPositionId[] = internal.controllerPositions ?? (options.ifrFlows === true ? ['TWR', 'GND', 'CLNC', 'APP', 'DEP'] : ['TWR', 'GND']);

  const presetId = options.startingScenario ? `free-play-${start.replace('_', '-')}` : 'free-play';
  const sc: GameScenario = {
    id: presetId,
    name: options.startingScenario ? `Free play: ${prof.label}` : 'Free play',
    description: `${prof.blurb} Runways ${active.landing.join('/')} (arrivals) and ${active.departing.join('/')} (departures), ${difficulty} difficulty, ` +
      `up to ${maxAircraft} aircraft. Runs until you end the session.`,
    mode: 'free_play',
    seed,
    weather,
    activeRunways: { departing: [...active.departing], landing: [...active.landing] },
    controllerPositions: positions,
    ...(options.playerPositions?.length ? { playerPositions: [...new Set(options.playerPositions)] } : {}),
    spawns,
    traffic: { enabled: true, arrivalsPerHour, departuresPerHour, gaFraction, maxAircraft },
    difficulty,
    aircraftTypes: types,
    ...(options.ifrFlows !== undefined ? { ifrFlows: options.ifrFlows } : {}),
    ...(internal.ifrArrivals !== undefined ? { ifrArrivals: internal.ifrArrivals } : {}),
    ...(internal.ifrDepartures !== undefined ? { ifrDepartures: internal.ifrDepartures } : {}),
    ...(options.closures?.length ? { closures: options.closures.map((c) => ({ ...c })) } : {}),
    ...(options.airportEvents !== false ? { pilotRequests: { lights: true }, events: buildAirportEvents(airport, seed, { startUtcMs: options.startUtcMs, active, closures: options.closures }) } : {}),
  };
  return sc;
}

interface InitialOpts {
  count: number; depShare: number; gaFraction: number; jets: boolean; ga: boolean;
  active: { departing: string[]; landing: string[] }; departureFreq: string; arrivalFreq: string;
  /** The setup screen's type selection resolved against the airport profile (undefined = everything the profile offers). */
  allowedTypes?: ReadonlySet<string>;
  /** IFR flows for the initial population (see ../ifr.ts). */
  ifrArrivals?: boolean; ifrDepartures?: boolean;
}

/**
 * Initial IFR arrivals on one procedure start this far apart in time, all at the initial fix: long enough for the leader to be about to land
 * when the next one checks in, so clearing the follower at check-in is never an unsafe in-trail clearance (see ../ifr.ts `arrivalJoinNm`).
 */
export const INITIAL_IFR_ARRIVAL_STAGGER_SEC = 270;

/**
 * Initial population: parked departures on distinct parking spots plus arrivals placed at least 3 nm apart
 * (5 nm when a faster aircraft would trail a slower one on the same final). Jets are placed closer in than
 * Cessnas so nobody overtakes. All at t = 0 so the session opens with traffic to work.
 */
export function initialAircraft(airport: Airport, rng: Rng, o: InitialOpts): Scenario['spawns'] {
  const out: Scenario['spawns'] = [];
  const used = new Set<string>();
  const icao = airport.icao;
  const profile = profileFor(icao);
  /** A unique flight (not used before, tail not sounding like one already in the scenario). Marked used by `commit`. */
  const flight = (isGa: boolean, fits?: (type: string) => boolean): Flight | undefined => {
    const tails = new Set(out.map((s) => callsignTail(s.callsign)));
    let allowedTypes = o.allowedTypes;
    if (!isGa && fits) {
      const cand = new Set(usableAirlines(profile, o.allowedTypes).flatMap((e) => e.types).filter((t) => (!o.allowedTypes || o.allowedTypes.has(t)) && fits(t)));
      if (!cand.size) return undefined;
      allowedTypes = cand;
    }
    let last: Flight | undefined;
    for (let i = 0; i < 100; i++) {
      const f: Flight | undefined = isGa ? { callsign: randomNNumber(rng), type: pickGaType(rng, icao) } : pickFlight(rng, icao, { allowedTypes });
      if (!f) return undefined;
      last = f;
      if (!used.has(f.callsign) && !tails.has(callsignTail(f.callsign))) return f;
    }
    const cs = isGa ? `N${100 + used.size}ZZ` : `${last?.entry?.icao3 ?? profile.airlines[0].icao3}${9000 + used.size}`;
    return { ...last!, callsign: cs };
  };
  const commit = (f: Flight): string => {
    used.add(f.callsign);
    return f.callsign;
  };
  /** 'ga' or 'jet' (airline flight, which includes the C208 feeder). Draws one random number only when both are in play, as before. */
  const chooseKind = (): 'ga' | 'jet' => {
    if (!o.jets) return 'ga';
    if (!o.ga) return 'jet';
    return rng() < o.gaFraction ? 'ga' : 'jet';
  };

  const nDep = Math.round(o.count * o.depShare);
  const nArr = o.count - nDep;
  const landingEnds = o.active.landing.length ? o.active.landing : o.active.departing;
  const depEnds = o.active.departing.length ? o.active.departing : o.active.landing;

  // Departures first (they occupy parking spots only).
  const occupied: Vec2[] = [];
  const reserved = new Set<string>();
  for (let i = 0; i < nDep; i++) {
    let kind = chooseKind();
    let f: Flight | undefined;
    if (kind === 'jet') {
      const fits = (t: string): boolean => !depEnds.length || depEnds.some((e) => runwayLongEnoughFor(airport, t, e));
      f = flight(false, fits);
      if (!f) {
        if (o.ga) kind = 'ga';
        else f = flight(false); // jets only and no runway fits: proceed as before
      }
    }
    if (kind === 'ga') f = flight(true);
    if (!f) continue;
    const type = f.type;
    const p = pickParking(airport, type, rng, occupied, reserved);
    if (!p) continue;
    reserved.add(p.id);
    occupied.push(p.pos);
    const leg = pickLeg(rng, icao, f);
    const remote = leg.remoteAirport ? { remoteAirport: leg.remoteAirport } : {};
    if (kind === 'jet' && o.ifrDepartures) {
      out.push({ ...ifrDepartureSpawn(airport, rng, { callsign: commit(f), type, parkingId: p.id, atSec: 0, destination: leg.destination, cruiseAltitudeFt: leg.cruiseAltitudeFt }), ...remote });
      continue;
    }
    out.push({
      atSec: 0, callsign: commit(f), type, flightRules: kind === 'ga' ? 'VFR' : 'IFR',
      start: { kind: 'parked', parkingId: p.id }, isDeparture: true, initialFrequencyId: o.departureFreq, initialRequest: 'TAXI', ...remote,
    });
  }

  // Arrivals: decide kinds, put airliners nearest the field, then place outward.
  const arrKinds = Array.from({ length: nArr }, chooseKind).sort((a, b) => (a === b ? 0 : a === 'jet' ? -1 : 1));
  const placed: AirbornePoint[] = [];
  const ifrFixes: Vec2[] = [];
  const ifrCount = new Map<string, number>();
  arrKinds.forEach((kind, i) => {
    const endId = landingEnds[i % landingEnds.length];
    const f = flight(kind === 'ga');
    if (!f) return;
    const type = f.type;
    if (kind === 'jet' && o.ifrArrivals && ((isTurbojet(type) && starArrival(airport, endId)) || arrivalProcedure(airport, endId))) {
      const k = ifrCount.get(endId) ?? 0;
      const spec = ifrArrivalSpawn(airport, rng, { callsign: f.callsign, type, runwayEnd: endId, atSec: k * INITIAL_IFR_ARRIVAL_STAGGER_SEC });
      if (spec && spec.start.kind === 'at_fix') {
        commit(f);
        ifrCount.set(endId, k + 1);
        const pos = findNavFix(airport, spec.start.fix)!.pos;
        ifrFixes.push(pos);
        placed.push({ pos, type, runwayEnd: endId });
        const leg = pickLeg(rng, icao, f);
        out.push(leg.remoteAirport ? { ...spec, remoteAirport: leg.remoteAirport } : spec);
      }
      return;
    }
    // With IFR arrivals in the opening population the Cessnas stay out (they would sit inside the in-trail window of the first jet and be
    // overtaken by the later ones); the generator brings Cessnas in once the jets are established.
    if (ifrFixes.length) return;
    const minNm = 7 + i * 4;
    const st = pickArrivalStart(airport, endId, type, rng, placed, { minNm, maxNm: minNm + 2, tries: 60, forceFinal: i === 0 });
    if (!st) return;
    placed.push({ pos: st.pos, type, runwayEnd: endId });
    const leg = pickLeg(rng, icao, f);
    out.push({
      atSec: 0, callsign: commit(f), type, flightRules: kind === 'ga' ? 'VFR' : 'IFR',
      start: st, isDeparture: false, initialFrequencyId: o.arrivalFreq, initialRequest: 'LANDING', ...(leg.remoteAirport ? { remoteAirport: leg.remoteAirport } : {}),
    });
  });
  // Sanity: every runway id must exist (config typos fail loudly).
  for (const e of [...landingEnds, ...depEnds]) runwayIdOf(airport, e);
  return out;
}
