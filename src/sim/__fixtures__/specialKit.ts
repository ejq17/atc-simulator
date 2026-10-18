import type { ScenarioAircraftSpawn } from '../types';

/** Spawn specs of the special traffic for the engine tests. */
export function createTrafficKit() {
  return {
    overhead: (callsign: string, endId = '13', distanceNm = 8): ScenarioAircraftSpawn => ({
      atSec: 0, callsign, type: 'F16', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
      start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 1600, headingDeg: 118, speedKt: 200, runwayEnd: endId, distanceNm }, behavior: { kind: 'military', overhead: true },
    }),
  };
}
