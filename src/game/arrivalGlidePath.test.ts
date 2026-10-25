/** Generated arrivals placed on a final start on its glide path (a start above it floated down the runway, see sim/touchdownZone.test.ts). */
import { describe, expect, it } from 'vitest';
import { airportOrDefault } from '../airport';
import { createEngine } from '../sim/engine';
import { getPerformance } from '../sim/performance';
import { glideAltitudeFt, glidePathFor } from '../sim/flightDynamics';
import { findRunwayEnd } from '../sim/runways';
import type { SpawnSpec, TrafficGenerator } from '../sim/traffic';
import type { Airport, Scenario } from '../sim/types';
import { game } from './game';
import { NM } from './world';

/** Design tolerance (ft) between the start altitude and the glide path at the start distance: 100 ft rounding of the altitude plus margin. DESIGN VALUE. */
const TOLERANCE_FT = 300;

function offPath(airport: Airport, specs: readonly (SpawnSpec | Scenario['spawns'][number])[]): string[] {
  const bad: string[] = [];
  for (const s of specs) {
    if (s.isDeparture || s.start.kind !== 'airborne' || s.start.distanceNm === undefined || !s.start.runwayEnd) continue;
    const g = findRunwayEnd(airport, s.start.runwayEnd)!;
    const path = glideAltitudeFt(g.elevationFt, s.start.distanceNm * NM, glidePathFor(airport, undefined, g, getPerformance(s.type)));
    if (Math.abs(s.start.altitudeFt - path) > TOLERANCE_FT) bad.push(`${s.callsign} ${s.type} rwy ${s.start.runwayEnd}: ${s.start.altitudeFt} ft at ${s.start.distanceNm.toFixed(1)} nm, path ${Math.round(path)} ft`);
  }
  return bad;
}

describe('arrivals on a final start on the glide path', () => {
  for (const icao of ['KACY', 'KMHT', 'KBOS', 'KPHL', 'KPGD', 'EGLL']) {
    it(`${icao}: opening population and 2 simulated hours of generated arrivals`, () => {
      const airport = airportOrDefault(icao);
      const sc = game.buildFreePlay(airport, { seed: 3, weather: 'clear', aircraftCount: 6, arrivalsPerHour: 30, departuresPerHour: 5, maxAircraft: 400 });
      sc.traffic = { ...sc.traffic!, flowControl: false };
      const inner = game.createTrafficGenerator(sc, airport);
      const out: SpawnSpec[] = [];
      const wrapped: TrafficGenerator = { update(state) { const s = inner.update(state); out.push(...s); return s; } };
      const e = createEngine({ airport, scenario: sc, trafficGenerator: wrapped });
      for (let i = 0; i < 7200 * 10; i++) e.step();
      const onFinal = [...sc.spawns, ...out].filter((s) => !s.isDeparture && s.start.kind === 'airborne' && s.start.distanceNm !== undefined);
      expect(onFinal.length, 'arrivals placed on a final').toBeGreaterThan(5);
      expect(offPath(airport, [...sc.spawns, ...out])).toEqual([]);
    }, 600000);
  }
});
