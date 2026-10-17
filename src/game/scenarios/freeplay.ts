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
 *  aircraftTypes    subset of ['C172', 'A320'].
 *  startingScenario quiet | busy_departures | busy_arrivals | mixed: initial mix and default rates.
 */
import type { Airport, Scenario, Vec2, Weather } from '../../sim/types';
import type { FreePlayOptions } from '../index';
import { mulberry32 } from '../../sim/rng';
import type { Rng } from '../../sim/rng';
import { getPresetWeather, randomWeather, WEATHER_PRESET_IDS } from '../../weather/presets';
import type { WeatherPresetId } from '../../weather/presets';
import { recommendRunways } from '../../weather/runwaySelection';
import type { GameScenario } from '../types';
import { randomAirlineCallsign, randomNNumber, runwayIdOf, runwayLongEnoughFor, callsignTail } from '../world';
import { pickArrivalStart, pickParking } from '../placement';
import type { AirbornePoint } from '../placement';

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

/** Preferred runway order when the wind does not decide (13/31 is the primary pair, and is the only one an A320 can depart). */
const PREFERRED_ORDER = ['13', '31', '22', '4'];

export function resolveWeather(w: FreePlayOptions['weather'], seed: number): Weather | 'live' {
  if (w === undefined || w === null) return getPresetWeather('clear');
  if (typeof w === 'object') return w;
  if (w === 'live') return 'live';
  if (w === 'random') return randomWeather(seed);
  if ((WEATHER_PRESET_IDS as readonly string[]).includes(w)) return getPresetWeather(w as WeatherPresetId);
  return getPresetWeather('clear');
}

/** Runway config for the weather. `jets` restricts the choice to ends an A320 can depart from. */
export function recommendConfig(airport: Airport, weather: Weather | 'live', jets: boolean): { departing: string[]; landing: string[] } {
  const ends = airport.runways.flatMap((r) => r.ends.map((e) => ({ id: e.id, magneticHeadingDeg: e.magneticHeadingDeg })));
  const usable = jets ? ends.filter((e) => runwayLongEnoughFor(airport, 'A320', e.id)) : ends;
  const pool = usable.length ? usable : ends;
  const w = weather === 'live' ? { windDirDeg: 0 as const, windSpeedKt: 0 } : weather;
  const rec = recommendRunways(w, pool, { preferredOrder: PREFERRED_ORDER, variationDeg: airport.magneticVariationDeg });
  return { departing: [rec.primary], landing: [rec.primary] };
}

export function buildFreePlay(airport: Airport, options: FreePlayOptions = {}): GameScenario {
  const seed = (options.seed ?? 1) >>> 0;
  const rng = mulberry32(seed ^ 0x5eed1234);
  const start: Start = options.startingScenario ?? 'mixed';
  const difficulty: Diff = options.difficulty ?? 'normal';
  const prof = START_PROFILE[start];
  const dprof = DIFF_PROFILE[difficulty];

  const requested = (options.aircraftTypes ?? ['C172', 'A320']).filter((t) => t === 'C172' || t === 'A320');
  const types = requested.length ? [...new Set(requested)] : ['C172', 'A320'];
  const jets = types.includes('A320');
  const ga = types.includes('C172');
  const gaFraction = ga && jets ? Math.min(1, Math.max(0, options.gaFraction ?? 0.5)) : ga ? 1 : 0;

  const weather = resolveWeather(options.weather, seed);
  const active = options.activeRunways ?? recommendConfig(airport, weather, jets);
  const maxAircraft = Math.max(1, Math.round(options.maxAircraft ?? dprof.max));
  const arrivalsPerHour = Math.max(0, options.arrivalsPerHour ?? Math.round(prof.arr * dprof.rate));
  const departuresPerHour = Math.max(0, options.departuresPerHour ?? Math.round(prof.dep * dprof.rate));
  const count = Math.max(0, Math.min(maxAircraft, Math.round(options.aircraftCount ?? prof.count)));

  const spawns = initialAircraft(airport, rng, {
    count, depShare: prof.depShare, gaFraction, jets, ga, active, departureFreq: 'GND', arrivalFreq: 'TWR',
  });

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
    controllerPositions: ['TWR', 'GND'],
    spawns,
    traffic: { enabled: true, arrivalsPerHour, departuresPerHour, gaFraction, maxAircraft },
    difficulty,
    aircraftTypes: types,
  };
  return sc;
}

interface InitialOpts {
  count: number; depShare: number; gaFraction: number; jets: boolean; ga: boolean;
  active: { departing: string[]; landing: string[] }; departureFreq: string; arrivalFreq: string;
}

/**
 * Initial population: parked departures on distinct parking spots plus arrivals placed at least 3 nm apart
 * (5 nm when a faster aircraft would trail a slower one on the same final). Jets are placed closer in than
 * Cessnas so nobody overtakes. All at t = 0 so the session opens with traffic to work.
 */
export function initialAircraft(airport: Airport, rng: Rng, o: InitialOpts): Scenario['spawns'] {
  const out: Scenario['spawns'] = [];
  const used = new Set<string>();
  const callsign = (isGa: boolean): string => {
    const tails = new Set(out.map((s) => callsignTail(s.callsign)));
    for (let i = 0; i < 100; i++) {
      const cs = isGa ? randomNNumber(rng) : randomAirlineCallsign(rng);
      if (!used.has(cs) && !tails.has(callsignTail(cs))) {
        used.add(cs);
        return cs;
      }
    }
    const cs = isGa ? `N${100 + used.size}ZZ` : `NKS${9000 + used.size}`;
    used.add(cs);
    return cs;
  };
  const chooseType = (): 'C172' | 'A320' => {
    if (!o.jets) return 'C172';
    if (!o.ga) return 'A320';
    return rng() < o.gaFraction ? 'C172' : 'A320';
  };

  const nDep = Math.round(o.count * o.depShare);
  const nArr = o.count - nDep;
  const landingEnds = o.active.landing.length ? o.active.landing : o.active.departing;
  const depEnds = o.active.departing.length ? o.active.departing : o.active.landing;

  // Departures first (they occupy parking spots only).
  const occupied: Vec2[] = [];
  const reserved = new Set<string>();
  for (let i = 0; i < nDep; i++) {
    let type = chooseType();
    if (type === 'A320' && depEnds.length && !depEnds.some((e) => runwayLongEnoughFor(airport, 'A320', e))) type = o.ga ? 'C172' : 'A320';
    const p = pickParking(airport, type, rng, occupied, reserved);
    if (!p) continue;
    reserved.add(p.id);
    occupied.push(p.pos);
    out.push({
      atSec: 0, callsign: callsign(type === 'C172'), type, flightRules: type === 'C172' ? 'VFR' : 'IFR',
      start: { kind: 'parked', parkingId: p.id }, isDeparture: true, initialFrequencyId: o.departureFreq, initialRequest: 'TAXI',
    });
  }

  // Arrivals: decide types, put jets nearest the field, then place outward.
  const arrTypes = Array.from({ length: nArr }, chooseType).sort((a, b) => (a === b ? 0 : a === 'A320' ? -1 : 1));
  const placed: AirbornePoint[] = [];
  arrTypes.forEach((type, i) => {
    const endId = landingEnds[i % landingEnds.length];
    const minNm = 7 + i * 4;
    const st = pickArrivalStart(airport, endId, type, rng, placed, { minNm, maxNm: minNm + 2, tries: 60, forceFinal: i === 0 });
    if (!st) return;
    placed.push({ pos: st.pos, type, runwayEnd: endId });
    out.push({
      atSec: 0, callsign: callsign(type === 'C172'), type, flightRules: type === 'C172' ? 'VFR' : 'IFR',
      start: st, isDeparture: false, initialFrequencyId: o.arrivalFreq, initialRequest: 'LANDING',
    });
  });
  // Sanity: every runway id must exist (config typos fail loudly).
  for (const e of [...landingEnds, ...depEnds]) runwayIdOf(airport, e);
  return out;
}
