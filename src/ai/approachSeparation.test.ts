/**
 * Approach keeps the arrivals it vectors apart (JO 7110.65 5-5-1 / 5-5-4, `approachSeparation.ts`): two IFR arrivals converging at the same altitude are not both left
 * to meet; the one that is descending into the other is stopped at its level, and between level aircraft the follower is climbed 1,000 ft.
 */
import { describe, expect, it } from 'vitest';
import { findRunwayEnd } from '../sim/runways';
import { nmToM } from '../sim/geo';
import { distToThresholdNm } from './world';
import { createHarness, kacy } from './testkit';
import type { Harness } from './testkit';
import { separationAltitude, separationAt, APPROACH_SEP_RATIO } from './approachSeparation';
import type { ScenarioAircraftSpawn } from '../sim/types';
import { holdAtFix } from './phrase';

const g13 = findRunwayEnd(kacy, '13')!;

function converging(altA: number, altB: number, targetBFt?: number): Harness {
  // A flies the final course of 13 from 9 nm; B crosses it from the left, both reach the same point 3 nm ahead of A at the same time
  const at = (alongNm: number, crossNm: number) => ({ x: g13.end.threshold.x + g13.dir.x * nmToM(alongNm) + g13.right.x * nmToM(crossNm), y: g13.end.threshold.y + g13.dir.y * nmToM(alongNm) + g13.right.y * nmToM(crossNm) });
  const spawn = (cs: string, pos: { x: number; y: number }, hdg: number, alt: number): ScenarioAircraftSpawn => ({
    atSec: 0, callsign: cs, type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP',
    start: { kind: 'airborne', pos, altitudeFt: alt, headingDeg: hdg, speedKt: 150, runwayEnd: '13' },
  });
  const h = createHarness({
    player: [], ai: [], activeRunways: { departing: ['13'], landing: ['13'] }, seed: 3,
    spawns: [spawn('AAL1', at(-9, 0), g13.headingDeg, altA), spawn('DAL2', at(-6, -3), (g13.headingDeg + 90) % 360, altB)],
  });
  if (targetBFt !== undefined) h.find('DAL2')!.target.altitudeFt = targetBFt;
  h.run(1);
  return h;
}

const worked = () => true;
const distOf = (h: Harness) => (o: { id: string }) => distToThresholdNm(h.engine.getState().aircraft[o.id], g13);

describe('Approach separation of converging arrivals', () => {
  it('two arrivals at the same altitude on crossing courses: the separation is below the standard and exactly one of them is given an altitude', () => {
    const h = converging(3000, 3000);
    const s = h.engine.getState();
    const a = s.aircraft[h.find('AAL1')!.id];
    const b = s.aircraft[h.find('DAL2')!.id];
    expect(separationAt(s, a, 3000).ratio).toBeLessThan(APPROACH_SEP_RATIO);
    const altA = separationAltitude(s, a, worked, distOf(h));
    const altB = separationAltitude(s, b, worked, distOf(h));
    expect([altA, altB].filter((x) => x !== undefined)).toHaveLength(1);
    const alt = (altA ?? altB)!;
    expect(alt - 3000).toBeGreaterThanOrEqual(1000);
    expect(alt - 3000).toBeLessThanOrEqual(2000);
  });

  it('an arrival descending into the level of the other is stopped at its level, not the one below', () => {
    const h = converging(3000, 4200, 3000);
    const s = h.engine.getState();
    const b = s.aircraft[h.find('DAL2')!.id];
    const a = s.aircraft[h.find('AAL1')!.id];
    expect(separationAltitude(s, a, worked, distOf(h))).toBeUndefined();
    const alt = separationAltitude(s, b, worked, distOf(h));
    expect(alt).toBeDefined();
    expect(alt!).toBeGreaterThanOrEqual(4000);
  });

  it('arrivals 1,000 ft apart are left alone', () => {
    const h = converging(3000, 4100);
    const s = h.engine.getState();
    for (const cs of ['AAL1', 'DAL2']) expect(separationAltitude(s, s.aircraft[h.find(cs)!.id], worked, distOf(h))).toBeUndefined();
  });
});

describe('the hold Approach gives an aircraft whose clearance is withheld at the fix it is about to reach', () => {
  it('is worded as a holding instruction with the inbound course, turns and leg length (JO 7110.65 4-6-4)', () => {
    const p = holdAtFix(kacy, 'CARYL', 133, 'right');
    expect(p.text).toBe('hold at CARYL, 133 inbound, right turns, one minute legs');
    expect(p.spoken).toMatch(/inbound, right turns, one minute legs$/);
    expect(p.spoken).toMatch(/one three three inbound/);
  });
});
