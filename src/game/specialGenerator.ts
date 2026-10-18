/**
 * Generator of the special traffic kinds (specialTraffic.ts): Coast Guard helicopters, Air National Guard fighters, VFR transitions through the
 * Class C, airport vehicles. Flight-training circuits are not a separate flow: a seeded share of the ordinary GA arrivals is training (`isTrainingFlight`,
 * used by traffic.ts).
 *
 * Own random stream (seed xor a constant) and own clocks, so switching a kind on or off never changes the airline / GA traffic of a seed. Rates are the
 * peak-bank rates of the airport profile scaled by the free-play density curve and the difficulty ramp, like the airline rates. All counts are bounded
 * by `maxAircraft` of the scenario and a few kind-specific limits. Callsigns follow JO 7110.65 2-4-20 (CGD / ANG + five digits) and AC 150/5210-20A
 * (APT + number); the digits are drawn here, no real serial number is used (docs/FAA-REFERENCES.md "Traffic variety").
 */
import type { Aircraft, Airport, ScenarioAircraftSpawn, SimulationState, Vec2 } from '../sim/types';
import type { SpawnSpec } from '../sim/traffic';
import { mulberry32 } from '../sim/rng';
import type { Rng } from '../sim/rng';
import { activeClosures } from '../sim/airportOps';
import { getPerformance, patternAltitudeFt } from '../sim/performance';
import { clearBearingFrom } from '../sim/rotorcraft';
import { bearingDeg, dist, headingToVec, trueToMagnetic } from '../sim/geo';
import { finalPosition, NM, norm360, randomNNumber } from './world';
import { profileFor } from './airportProfile';
import type { SpecialTrafficProfile } from './airportProfile';
import { resolveSpecialTraffic } from './specialTraffic';
import type { SpecialTrafficSelection } from './specialTraffic';
import type { Difficulty, GameScenario } from './types';
import { rampFactor } from './traffic';

const exp = (rng: Rng, meanSec: number): number => -Math.log(1 - rng() * 0.999999) * meanSec;
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];

/** Hash of a callsign to 0..1 (no shared random stream is consumed): which GA arrivals are flight-training circuits. */
export function isTrainingFlight(callsign: string, gaShare: number): boolean {
  let h = 2166136261;
  for (let i = 0; i < callsign.length; i++) h = Math.imul(h ^ callsign.charCodeAt(i), 16777619);
  return mulberry32(h >>> 0)() < gaShare;
}

/** Touch-and-go circuits of a training flight: 2 to 4, from the callsign. */
export function trainingCircuits(callsign: string): number {
  let h = 5381;
  for (let i = 0; i < callsign.length; i++) h = (Math.imul(h, 33) + callsign.charCodeAt(i)) >>> 0;
  return 2 + (h % 3);
}

/** Limits of simultaneous special traffic (design values). */
export const SPECIAL_LIMITS = { helicopter: 2, military: 2, transition: 3, vehicles: 2 } as const;
/** Distance of transit entry and exit points from the airport (nm) and the track offset range (nm). */
export const TRANSIT_RADIUS_NM = 22;
export const TRANSIT_OFFSET_NM = [1, 6] as const;
/** An airborne special spawn keeps this far from every other airborne aircraft (nm). */
export const SPECIAL_SPAWN_CLEAR_NM = 5;

export interface SpecialGeneratorOptions {
  densityAt?: (state: Readonly<SimulationState>) => number;
}

function airborneClear(state: Readonly<SimulationState>, pos: Vec2): boolean {
  return Object.values(state.aircraft).every((a) => a.onGround || dist(a.pos, pos) / NM >= SPECIAL_SPAWN_CLEAR_NM);
}

function parkingFree(state: Readonly<SimulationState>, p: { id: string; pos: Vec2 }, reserved: Map<string, number>): boolean {
  return !reserved.has(p.id) && !Object.values(state.aircraft).some((a) => a.onGround && dist(a.pos, p.pos) < 20);
}

/** Five digits of a serial number (first digit 1-9, digits not repeating a whole callsign tail of an active aircraft is checked by the caller). */
const serialDigits = (rng: Rng): string => String(10000 + Math.floor(rng() * 89999));

export function createSpecialTrafficGenerator(scenario: GameScenario, airport: Airport, options: SpecialGeneratorOptions = {}): { update(state: Readonly<SimulationState>): SpawnSpec[] } | undefined {
  const sel: SpecialTrafficSelection = resolveSpecialTraffic(airport.icao, scenario.specialTraffic);
  const profile: SpecialTrafficProfile | undefined = profileFor(airport.icao).special;
  if (!profile || !scenario.traffic?.enabled) return undefined;
  const kinds = (['helicopter', 'military', 'transition', 'vehicles'] as const).filter((k) => sel[k] && profile[k]);
  if (!kinds.length) return undefined;
  const difficulty: Difficulty = scenario.difficulty ?? 'normal';
  const has = (p: string) => scenario.controllerPositions.includes(p as never);
  const towerFreq = has('TWR') ? 'TWR' : undefined;
  const groundFreq = has('GND') ? 'GND' : undefined;
  const maxAircraft = scenario.traffic.maxAircraft;
  let rng: Rng | undefined;
  const next: Partial<Record<(typeof kinds)[number], number>> = {};
  const reserved = new Map<string, number>();
  const used = new Set<string>(scenario.spawns.map((s) => s.callsign.toUpperCase()));
  const served = new Set<string>();
  let lastAt = -Infinity;

  const perHour = (k: (typeof kinds)[number]): number => (profile[k] as { perHour: number }).perHour;
  const gap = (k: (typeof kinds)[number], now: number): number => exp(rng!, 3600 / (perHour(k) * rampFactor(difficulty, now)));

  const callsign = (prefix: string, digits: () => string, state: Readonly<SimulationState>): string => {
    const tails = new Set(Object.values(state.aircraft).map((a) => a.callsign.slice(-3)));
    for (let i = 0; i < 40; i++) {
      const cs = `${prefix}${digits()}`;
      if (!used.has(cs) && !tails.has(cs.slice(-3))) return cs;
    }
    return `${prefix}${digits()}`;
  };

  const count = (state: Readonly<SimulationState>, pred: (a: Aircraft) => boolean): number => Object.values(state.aircraft).filter(pred).length;

  const heliSpawn = (state: Readonly<SimulationState>): SpawnSpec | undefined => {
    const h = profile.helicopter!;
    if (!towerFreq) return undefined;
    const pads = airport.parking.filter((p) => p.id.startsWith(h.padPrefix));
    const free = pads.filter((p) => parkingFree(state, p, reserved));
    if (!free.length) return undefined;
    const r = rng!();
    const now = state.clock.timeSec;
    const cs = callsign('CGD', () => serialDigits(rng!), state);
    if (r < 0.4) {
      const pad = pick(rng!, free);
      reserved.set(pad.id, now);
      used.add(cs);
      return { atSec: now, callsign: cs, type: 'H65', flightRules: 'VFR', start: { kind: 'parked', parkingId: pad.id }, isDeparture: true, initialFrequencyId: towerFreq, initialRequest: 'DEPARTURE', behavior: { kind: 'helicopter', padId: pad.id, mission: 'DEPARTURE' } };
    }
    if (r < 0.8) {
      const pad = pick(rng!, free);
      const brg = clearBearingFrom(airport, pad.pos, 180);
      if (brg === undefined) return undefined;
      const v = headingToVec(brg);
      const pos = { x: pad.pos.x + v.x * 5 * NM, y: pad.pos.y + v.y * 5 * NM };
      if (!airborneClear(state, pos)) return undefined;
      reserved.set(pad.id, now);
      used.add(cs);
      return {
        atSec: now, callsign: cs, type: 'H65', flightRules: 'VFR', isDeparture: false, initialFrequencyId: towerFreq, initialRequest: 'LANDING',
        start: { kind: 'airborne', pos, altitudeFt: Math.round((airport.elevationFt + 1000) / 100) * 100, headingDeg: norm360(brg + 180), speedKt: 100 },
        behavior: { kind: 'helicopter', padId: pad.id, mission: 'ARRIVAL' },
      };
    }
    if (!groundFreq || free.length < 2) return undefined;
    // reposition: an air taxi from one free pad to another free pad (JO 7110.65 3-11-1)
    const from = pick(rng!, free);
    const to = pick(rng!, free.filter((p) => p.id !== from.id));
    reserved.set(from.id, now);
    reserved.set(to.id, now);
    used.add(cs);
    return { atSec: now, callsign: cs, type: 'H65', flightRules: 'VFR', start: { kind: 'parked', parkingId: from.id }, isDeparture: true, initialFrequencyId: groundFreq, initialRequest: 'TAXI', behavior: { kind: 'helicopter', padId: to.id, mission: 'REPOSITION' } };
  };

  const militarySpawn = (state: Readonly<SimulationState>): SpawnSpec | undefined => {
    const m = profile.military!;
    const now = state.clock.timeSec;
    const size = rng!() < m.formationShare ? 2 : 1;
    const cs = callsign('ANG', () => serialDigits(rng!), state);
    const departure = rng!() < 0.5;
    if (departure) {
      if (!groundFreq) return undefined;
      const free = airport.parking.filter((p) => p.id.startsWith(m.rampPrefix) && !p.id.includes('PAD') && parkingFree(state, p, reserved));
      if (!free.length) return undefined;
      const spot = pick(rng!, free);
      reserved.set(spot.id, now);
      used.add(cs);
      return { atSec: now, callsign: cs, type: 'F16', flightRules: 'VFR', start: { kind: 'parked', parkingId: spot.id }, isDeparture: true, initialFrequencyId: groundFreq, initialRequest: 'TAXI', behavior: { kind: 'military', size } };
    }
    if (!towerFreq) return undefined;
    const ends = state.activeRunways.landing.length ? state.activeRunways.landing : state.activeRunways.departing;
    if (!ends.length) return undefined;
    const endId = pick(rng!, ends);
    const pos = finalPosition(airport, endId, 10);
    if (!airborneClear(state, pos)) return undefined;
    const g = airport.runways.flatMap((r) => r.ends).find((e) => e.id === endId)!;
    used.add(cs);
    const alt = Math.round(patternAltitudeFt(getPerformance('F16'), airport.elevationFt, airport.trafficPatternAltitudeFt) / 100) * 100;
    return {
      atSec: now, callsign: cs, type: 'F16', flightRules: 'VFR', isDeparture: false, initialFrequencyId: towerFreq, initialRequest: 'LANDING',
      start: { kind: 'airborne', pos, altitudeFt: alt, headingDeg: g.trueHeadingDeg, speedKt: 200, runwayEnd: endId, distanceNm: 10 },
      behavior: { kind: 'military', size, overhead: true },
    };
  };

  const transitSpawn = (state: Readonly<SimulationState>): SpawnSpec | undefined => {
    const freq = has('APP') ? 'APP' : towerFreq;
    if (!freq) return undefined;
    const now = state.clock.timeSec;
    const angle = rng!() * 360;
    const off = TRANSIT_OFFSET_NM[0] + rng!() * (TRANSIT_OFFSET_NM[1] - TRANSIT_OFFSET_NM[0]);
    const side = rng!() < 0.5 ? -1 : 1;
    // a chord of the circle of radius TRANSIT_RADIUS_NM at distance `off` from the airport
    const R = TRANSIT_RADIUS_NM * NM;
    const along = Math.sqrt(R * R - (off * NM) ** 2);
    const u = headingToVec(angle); // direction of the track
    const n = { x: -u.y * side, y: u.x * side }; // normal
    const entry = { x: n.x * off * NM - u.x * along, y: n.y * off * NM - u.y * along };
    const exit = { x: n.x * off * NM + u.x * along, y: n.y * off * NM + u.y * along };
    if (!airborneClear(state, entry)) return undefined;
    const hdg = norm360(bearingDeg(entry, exit));
    const magHdg = norm360(trueToMagnetic(hdg, airport.magneticVariationDeg));
    // 14 CFR 91.159: above 3,000 ft AGL, magnetic course 0-179 odd thousands + 500, 180-359 even thousands + 500; not below 5,500 so as to stay 500 ft over IFR arrivals (7110.65 7-8-3)
    const alts = magHdg < 180 ? [5500, 7500] : [6500, 8500];
    const alt = pick(rng!, alts);
    const cs = callsign('N', () => randomNNumber(rng!).slice(1), state);
    used.add(cs);
    const dest = pick(rng!, Object.keys(profileFor(airport.icao).neighbours));
    return {
      atSec: now, callsign: cs, type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: freq, initialRequest: 'OTHER', remoteAirport: dest,
      start: { kind: 'airborne', pos: entry, altitudeFt: alt, headingDeg: hdg, speedKt: 110 },
      behavior: { kind: 'transit', exitPos: exit, altitudeFt: alt },
    };
  };

  const vehicleSpawn = (state: Readonly<SimulationState>, inspectionRunway?: string): SpawnSpec | undefined => {
    if (!groundFreq) return undefined;
    const now = state.clock.timeSec;
    const homes = airport.parking.filter((p) => (p.category === 'fbo' || p.category === 'cargo') && parkingFree(state, p, reserved));
    if (!homes.length) return undefined;
    const home = pick(rng!, homes);
    const cs = callsign('APT', () => String(1 + Math.floor(rng!() * 99)), state);
    const r = rng!();
    let behavior: NonNullable<ScenarioAircraftSpawn['behavior']>;
    if (inspectionRunway || r < 0.4) {
      const quiet = airport.runways.filter((rw) => !state.activeRunways.landing.concat(state.activeRunways.departing).some((e) => rw.ends.some((x) => x.id === e)));
      const rw = inspectionRunway ? airport.runways.find((x) => x.id === inspectionRunway)! : pick(rng!, quiet.length ? quiet : airport.runways);
      behavior = { kind: 'vehicle', task: 'RUNWAY_INSPECTION', runwayId: rw.id };
    } else if (r < 0.7) {
      behavior = { kind: 'vehicle', task: 'PAVEMENT_INSPECTION' };
    } else {
      behavior = { kind: 'vehicle', task: 'ERRAND', errandCategory: 'ga' };
    }
    reserved.set(home.id, now);
    used.add(cs);
    return { atSec: now, callsign: cs, type: 'VEH', flightRules: 'VFR', start: { kind: 'parked', parkingId: home.id }, isDeparture: true, initialFrequencyId: groundFreq, initialRequest: 'TAXI', behavior };
  };

  return {
    update(state) {
      const now = state.clock.timeSec;
      if (!rng) {
        rng = mulberry32((state.seed ^ 0x2d5e7a31) >>> 0);
        for (const k of kinds) next[k] = now + 60 + gap(k, now) * 0.5;
      }
      const out: SpawnSpec[] = [];
      for (const [id, t] of reserved) if (now - t > 20) reserved.delete(id);
      // an inspection closure of the airport operations is performed by a vehicle (vehicles.ts)
      if (kinds.includes('vehicles')) {
        for (const c of activeClosures(state, now)) {
          if (c.kind !== 'RUNWAY' || !/inspection/i.test(c.reason) || served.has(c.id)) continue;
          if (count(state, (a) => a.type === 'VEH') >= SPECIAL_LIMITS.vehicles || Object.keys(state.aircraft).length >= maxAircraft) continue;
          const spec = vehicleSpawn(state, c.ident);
          if (spec) {
            served.add(c.id);
            out.push(spec);
          }
        }
      }
      if (now - lastAt < 20 && !out.length) return out;
      for (const k of kinds) {
        if (now < (next[k] ?? Infinity)) continue;
        next[k] = now + gap(k, now);
        if (options.densityAt && rng() >= options.densityAt(state)) continue;
        if (Object.keys(state.aircraft).length + out.length >= maxAircraft) continue;
        const limit = SPECIAL_LIMITS[k];
        const type = k === 'helicopter' ? 'H65' : k === 'military' ? 'F16' : k === 'vehicles' ? 'VEH' : undefined;
        if (type && count(state, (a) => a.type === type) >= limit) continue;
        if (k === 'transition' && count(state, (a) => !!a.flags.transit) >= limit) continue;
        const spec = k === 'helicopter' ? heliSpawn(state) : k === 'military' ? militarySpawn(state) : k === 'transition' ? transitSpawn(state) : vehicleSpawn(state);
        if (spec) {
          out.push(spec);
          lastAt = now;
        }
      }
      return out;
    },
  };
}
