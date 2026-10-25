/** The pattern projection (`patternPath.ts`) against the engine's own flight: positions every 10 s and the threshold time. */
import { describe, expect, it } from 'vitest';
import { createTestAirport } from '../sim/__fixtures__/testAirport';
import { cmd, find, makeEngine, run, say } from '../sim/__fixtures__/testHelpers';
import { findRunwayEnd } from '../sim/runways';
import { nmToM } from '../sim/geo';
import { patternProjection } from './patternPath';
import type { PatternPlan } from './patternPath';
import type { ScenarioAircraftSpawn } from '../sim/types';

const airport = createTestAirport();
const g13 = findRunwayEnd(airport, '13')!;

function downwind(callsign: string, alongM: number, type = 'C172'): ScenarioAircraftSpawn {
  const left = { x: -g13.right.x, y: -g13.right.y };
  const pos = { x: g13.end.threshold.x + g13.dir.x * alongM + left.x * nmToM(0.8), y: g13.end.threshold.y + g13.dir.y * alongM + left.y * nmToM(0.8) };
  return { atSec: 0, callsign, type, flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', start: { kind: 'airborne', pos, altitudeFt: 1075, headingDeg: (g13.headingDeg + 180) % 360, speedKt: 90, runwayEnd: '13' } };
}

/** Largest distance (m) between the projection and the engine's aircraft over the first `secs` seconds, and the threshold-crossing times of both. */
function compare(plan: PatternPlan, apply: (e: ReturnType<typeof makeEngine>, t: number) => void, secs: number, along = 800): { maxM: number; projThr: number; realThr: number } {
  const e = makeEngine({ scenario: { spawns: [downwind('N1AA', along)] } });
  e.applyCommand(cmd('ENTER_PATTERN', 'N1AA', { runwayEnd: '13', patternLeg: 'left_downwind', turnDirection: 'left' }));
  run(e, 1);
  const ac = find(e, 'N1AA');
  const proj = patternProjection(e.getState(), ac, g13, plan, secs + 60);
  let maxM = 0;
  let realThr = Infinity;
  for (let t = 0; t <= secs; t++) {
    apply(e, t);
    const p = proj.path[t];
    if (p && t % 5 === 0 && ac.phase !== 'LANDING') maxM = Math.max(maxM, Math.hypot(p.x - ac.pos.x, p.y - ac.pos.y));
    const cur = find(e, 'N1AA');
    if (realThr === Infinity && cur.phase === 'LANDING') realThr = t;
    run(e, 1);
  }
  return { maxM, projThr: proj.thresholdSec, realThr };
}

describe('pattern projection', () => {
  it('follows a C172 on downwind through the normal base turn to the threshold', () => {
    const r = compare({}, () => undefined, 175);
    expect(r.maxM).toBeLessThan(250);
  });
  it('extend downwind, then turn base at 60 s', () => {
    const r = compare({ extend: true, baseAtSec: 60 }, (e, t) => {
      if (t === 0) say(e, cmd('PATTERN_INSTRUCTION', 'N1AA', { destination: 'EXTEND_DOWNWIND' }), 'TWR');
      if (t === 60) say(e, cmd('PATTERN_INSTRUCTION', 'N1AA', { destination: 'TURN_BASE_NOW' }), 'TWR');
    }, 200);
    expect(r.maxM).toBeLessThan(300);
  });
  it('a 360 on downwind', () => {
    const r = compare({ circles: 1 }, (e, t) => {
      if (t === 0) say(e, cmd('PATTERN_INSTRUCTION', 'N1AA', { destination: 'CIRCLE', turnDirection: 'right', turnDegrees: 360 }), 'TWR');
    }, 200, 0);
    expect(r.maxM).toBeLessThan(400);
  });
});
