/**
 * The Tower keeps pattern traffic, straight-ins and go-arounds outside the near-miss alert (1.5 nm and 500 ft) of each other: the sequence weighs
 * extend / 360 / turn base now against the projected paths (patternPath.ts, pathWorld.ts).
 */
import { describe, expect, it } from 'vitest';
import { cmd, createHarness, kacy } from './testkit';
import type { ScenarioAircraftSpawn } from '../sim/types';
import { findRunwayEnd } from '../sim/runways';
import { nmToM } from '../sim/geo';

const g22 = findRunwayEnd(kacy, '22')!;

/** A VFR aircraft on the left downwind of 22 `alongM` metres from the threshold (positive: beyond it in the landing direction), pattern altitude. */
function downwind(callsign: string, alongM: number, type = 'C172'): ScenarioAircraftSpawn {
  const left = { x: -g22.right.x, y: -g22.right.y };
  const pos = { x: g22.end.threshold.x + g22.dir.x * alongM + left.x * nmToM(0.8), y: g22.end.threshold.y + g22.dir.y * alongM + left.y * nmToM(0.8) };
  return { atSec: 0, callsign, type, flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', start: { kind: 'airborne', pos, altitudeFt: 1000, headingDeg: (g22.headingDeg + 180) % 360, speedKt: 80, runwayEnd: '22' } };
}
const straightIn = (callsign: string, distanceNm: number, type = 'C172'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type, flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
  start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: Math.round(76 + 320 * distanceNm + 300), headingDeg: 0, speedKt: 90, runwayEnd: '22', distanceNm },
});

function alerts(h: ReturnType<typeof createHarness>): string[] {
  return h.events.filter((e) => e.kind === 'SEPARATION_VIOLATION' && /Near-miss/.test(e.text)).map((e) => `${Math.round(e.timeSec)} ${e.text}`);
}

describe('pattern traffic, straight-ins and go-arounds stay outside the near-miss alert', () => {
  for (const [name, alongM, inNm, seed] of [['abeam the threshold, straight-in 6 nm', 0, 6, 3], ['early downwind, straight-in 4.5 nm', 900, 4.5, 4], ['late downwind, straight-in 8 nm', -1500, 8, 5], ['abeam, straight-in 5.5 nm', 300, 5.5, 6]] as const) {
    it(name, () => {
      const h = createHarness({
        player: [], spawns: [downwind('N1PA', alongM), straightIn('N2SI', inNm)], activeRunways: { departing: ['22'], landing: ['22'] }, seed,
      });
      h.say('TWR', cmd('ENTER_PATTERN', 'N1PA', { runwayEnd: '22', patternLeg: 'left_downwind', turnDirection: 'left' }));
      h.run(1100);
      expect(alerts(h)).toEqual([]);
      const landed = (c: string): boolean => ['ROLLOUT', 'RUNWAY_EXIT', 'TAXI_TO_PARKING', 'ARRIVED'].includes(h.find(c)?.phase ?? 'ARRIVED');
      expect(landed('N1PA') && landed('N2SI')).toBe(true);
    }, 120_000);
  }
});

describe('a departure is not starved by a busy pattern, and nothing comes within the alert of it', () => {
  const g13 = findRunwayEnd(kacy, '13')!;
  const pat = (callsign: string, alongM: number, speed = 80): ScenarioAircraftSpawn => {
    const left = { x: -g13.right.x, y: -g13.right.y };
    const pos = { x: g13.end.threshold.x + g13.dir.x * alongM + left.x * nmToM(0.8), y: g13.end.threshold.y + g13.dir.y * alongM + left.y * nmToM(0.8) };
    return { atSec: 0, callsign, type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', start: { kind: 'airborne', pos, altitudeFt: 1000, headingDeg: (g13.headingDeg + 180) % 360, speedKt: speed, runwayEnd: '13' } };
  };
  for (const seed of [21, 22, 23]) {
    it(`two pattern aircraft, a straight-in and an A320 at the hold of 13 (seed ${seed})`, () => {
      const h = createHarness({
        player: [], seed, mode: 'career', activeRunways: { departing: ['13'], landing: ['13'] },
        spawns: [
          pat('N1PA', 2800), pat('N2PB', -100), { ...pat('N3PC', 0), start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 2500, headingDeg: 0, speedKt: 90, runwayEnd: '13', distanceNm: 7.5 } },
          { atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'holding_short', nodeId: 'HP13-31-B-1', runwayEnd: '13' }, flightPlan: { flightRules: 'IFR', origin: 'KACY', destination: 'KPHL', cruiseAltitudeFt: 10000, route: ['VCN'] } },
        ],
      });
      for (const c of ['N1PA', 'N2PB']) h.say('TWR', cmd('ENTER_PATTERN', c, { runwayEnd: '13', patternLeg: 'left_downwind', turnDirection: 'left' }));
      let airborneAt = -1;
      h.run(900, () => { const a = h.find('NKS451'); if (airborneAt < 0 && a && !a.onGround) airborneAt = h.now(); });
      expect(alerts(h)).toEqual([]);
      expect(airborneAt).toBeGreaterThan(0);
      expect(airborneAt).toBeLessThan(600);
    }, 120_000);
  }
});
