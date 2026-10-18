/** Pattern instructions and visual sequencing: extend downwind, turn base now, short approach, 360s, follow, position reports, closed traffic (JO 7110.65 3-8-1, 3-10-11, 3-1-6, 7-2-1; AIM 4-3-3). */
import { describe, expect, it } from 'vitest';
import type { SimulationEngine } from './api';
import type { ScenarioAircraftSpawn } from './types';
import { createTestAirport } from './__fixtures__/testAirport';
import { createEngine } from './engine';
import { loadKacy } from '../airport';
import { ARRIVING, cmd, find, makeEngine, makeScenario, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import { alongCross, findRunwayEnd } from './runways';
import { headingDiff, mToNm, nmToM } from './geo';

const airport = createTestAirport();
const g13 = findRunwayEnd(airport, '13')!;

/** An aircraft on the left downwind of 13 at `alongM` metres from the threshold (positive = beyond the threshold in the landing direction). */
function downwind(callsign: string, alongM: number, type = 'C172', over: Partial<ScenarioAircraftSpawn> = {}): ScenarioAircraftSpawn {
  const left = { x: -g13.right.x, y: -g13.right.y };
  const pos = {
    x: g13.end.threshold.x + g13.dir.x * alongM + left.x * nmToM(0.8),
    y: g13.end.threshold.y + g13.dir.y * alongM + left.y * nmToM(0.8),
  };
  return {
    atSec: 0, callsign, type, flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
    start: { kind: 'airborne', pos, altitudeFt: 1075, headingDeg: (g13.headingDeg + 180) % 360, speedKt: 90, runwayEnd: '13' },
    ...over,
  };
}

const enterDownwind = (e: SimulationEngine, cs: string) =>
  e.applyCommand(cmd('ENTER_PATTERN', cs, { runwayEnd: '13', patternLeg: 'left_downwind', turnDirection: 'left' }));

const alongNm = (e: SimulationEngine, cs: string) => mToNm(alongCross(g13, find(e, cs).pos).along);
const downwindHeading = (g13.headingDeg + 180) % 360;
const onBaseHeading = (hdg: number): boolean => Math.abs(headingDiff(hdg, downwindHeading)) > 45;

describe('extend downwind / turn base now / short approach', () => {
  it('without an instruction the base turn is made about 1.2 nm behind the threshold', () => {
    const e = makeEngine({ scenario: { spawns: [downwind('N1AA', 800)] } });
    enterDownwind(e, 'N1AA');
    const ac = find(e, 'N1AA');
    let turnedAt = NaN;
    runUntil(e, () => { if (Number.isNaN(turnedAt) && onBaseHeading(ac.trackDeg)) turnedAt = alongNm(e, 'N1AA'); return ac.phase === 'FINAL'; }, 400);
    expect(turnedAt).toBeLessThan(-1.0);
    expect(turnedAt).toBeGreaterThan(-1.9);
  });

  it('"extend downwind": the aircraft keeps flying downwind past the normal base turn; "turn base now" then brings it to base and final', () => {
    const e = makeEngine({ scenario: { spawns: [downwind('N1AA', 800)] } });
    enterDownwind(e, 'N1AA');
    const out = say(e, cmd('PATTERN_INSTRUCTION', 'N1AA', { destination: 'EXTEND_DOWNWIND' }), 'TWR');
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') expect(out.readback).toBe('Extending downwind, Cessna one alpha alpha');
    const ac = find(e, 'N1AA');
    expect(runUntil(e, () => alongNm(e, 'N1AA') < -3, 400)).toBe(true);
    expect(onBaseHeading(ac.trackDeg)).toBe(false); // still downwind at 3 nm
    expect(ac.phase).toBe('PATTERN');
    expect(say(e, cmd('PATTERN_INSTRUCTION', 'N1AA', { destination: 'TURN_BASE_NOW' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'FINAL', 600)).toBe(true);
  });

  it('"turn base now" before the aircraft is far enough past the threshold: "unable, too close"', () => {
    const e = makeEngine({ scenario: { spawns: [downwind('N1AA', 800)] } });
    enterDownwind(e, 'N1AA');
    const out = say(e, cmd('PATTERN_INSTRUCTION', 'N1AA', { destination: 'TURN_BASE_NOW' }), 'TWR');
    expect(out.status).toBe('rejected');
    expect(pilotTexts(e).at(-1)).toMatch(/too close to turn base now/);
  });

  it('"make short approach": the base turn is made earlier than the standard 1.2 nm', () => {
    const turn = (short: boolean): number => {
      const e = makeEngine({ scenario: { spawns: [downwind('N1AA', 800)] } });
      enterDownwind(e, 'N1AA');
      if (short) expect(say(e, cmd('PATTERN_INSTRUCTION', 'N1AA', { destination: 'SHORT_APPROACH' }), 'TWR').status).toBe('accepted');
      const ac = find(e, 'N1AA');
      let at = NaN;
      runUntil(e, () => { if (Number.isNaN(at) && onBaseHeading(ac.trackDeg)) at = alongNm(e, 'N1AA'); return ac.phase === 'FINAL'; }, 400);
      return at;
    };
    expect(turn(true)).toBeGreaterThan(turn(false) + 0.2);
  });

  it('extend downwind outside the pattern is refused', () => {
    const e = makeEngine({ scenario: { spawns: [downwind('N1AA', 800)] } });
    expect(say(e, cmd('PATTERN_INSTRUCTION', 'N1AA', { destination: 'EXTEND_DOWNWIND' }), 'TWR').status).toBe('rejected');
  });
});

describe('three-sixty', () => {
  it('"make left three sixty" on downwind: a full left turn, then the pattern is resumed and the aircraft reaches final', () => {
    const e = makeEngine({ scenario: { spawns: [downwind('N1AA', 2000)] } });
    enterDownwind(e, 'N1AA');
    const ac = find(e, 'N1AA');
    run(e, 3);
    const out = say(e, cmd('PATTERN_INSTRUCTION', 'N1AA', { destination: 'CIRCLE', turnDirection: 'left', turnDegrees: 360 }), 'TWR');
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') expect(out.readback).toBe('Left three sixty, Cessna one alpha alpha');
    let total = 0;
    let last = ac.headingDeg;
    for (let i = 0; i < 1500 && total > -330; i++) {
      e.step();
      total += headingDiff(last, ac.headingDeg);
      last = ac.headingDeg;
    }
    expect(total).toBeLessThan(-330); // turned left through (almost) a full circle
    expect(runUntil(e, () => ac.phase === 'FINAL', 900)).toBe(true);
  });

  it('refused outside the pattern', () => {
    const e = makeEngine({ scenario: { spawns: [downwind('N1AA', 800)] } });
    expect(say(e, cmd('PATTERN_INSTRUCTION', 'N1AA', { destination: 'CIRCLE', turnDirection: 'left', turnDegrees: 360 }), 'TWR').status).toBe('rejected');
  });
});

describe('follow traffic', () => {
  const finalLeader = (cs: string, nm: number): ScenarioAircraftSpawn => ({
    atSec: 0, callsign: cs, type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
    start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 70, runwayEnd: '13', distanceNm: nm },
  });
  /** Seconds at which the follower turns base, and the leader's distance from the threshold then. */
  function baseTurn(follow: boolean): { leaderNm: number; accepted: boolean } {
    const e = makeEngine({ scenario: { spawns: [finalLeader('N1AA', 4.5), downwind('N2BB', 300)] } });
    enterDownwind(e, 'N2BB');
    const fol = find(e, 'N2BB');
    let accepted = false;
    if (follow) {
      // the pilot sees the Cessna ahead on final (retry while it is still looking)
      for (let tries = 0; tries < 6 && !accepted; tries++) {
        const out = say(e, cmd('FOLLOW_TRAFFIC', 'N2BB', { traffic: { desc: 'cessna', position: 'final', distanceNm: 4.5 - tries * 0.2 }, sequenceNumber: 2 }), 'TWR');
        accepted = out.status === 'accepted';
        if (!accepted) run(e, 1);
      }
    }
    let leaderNm = NaN;
    for (let i = 0; i < 6000 && Number.isNaN(leaderNm); i++) {
      e.step();
      if (onBaseHeading(fol.trackDeg)) leaderNm = -mToNm(alongCross(g13, find(e, 'N1AA').pos).along);
    }
    return { leaderNm, accepted };
  }

  it('without the instruction the Skyhawk turns base while the leader is still over 3 nm out; told to follow it waits until the leader is inside its join point', () => {
    const free = baseTurn(false);
    const follow = baseTurn(true);
    expect(follow.accepted).toBe(true);
    expect(free.leaderNm).toBeGreaterThan(2.5);
    expect(follow.leaderNm).toBeLessThan(1.8);
  });

  it('traffic that is not there (or out of sight): negative contact, no follow', () => {
    const e = makeEngine({ scenario: { spawns: [downwind('N2BB', 1500)] } });
    enterDownwind(e, 'N2BB');
    const out = say(e, cmd('FOLLOW_TRAFFIC', 'N2BB', { traffic: { desc: 'boeing 737', position: 'base' } }), 'TWR');
    expect(out.status).toBe('rejected');
    expect(pilotTexts(e).at(-1)).toMatch(/^Negative contact/);
  });
});

describe('position reports', () => {
  it('"report midfield downwind", "report base" and "report two mile final" are made at the right points', () => {
    const e = makeEngine({ scenario: { spawns: [downwind('N1AA', g13.lengthM + 600)] } });
    enterDownwind(e, 'N1AA');
    const ac = find(e, 'N1AA');
    for (const [dest, extra] of [['REPORT_MIDFIELD_DOWNWIND', {}], ['REPORT_BASE', {}], ['REPORT_FINAL', { distanceNm: 2 }]] as const) {
      expect(say(e, cmd('REPORT_POSITION', 'N1AA', { destination: dest, ...extra }), 'TWR').status).toBe('accepted');
    }
    let midAlong = NaN;
    let baseAlong = NaN;
    let finalAlong = NaN;
    let seen = 0;
    for (let i = 0; i < 12000 && seen < 3; i++) {
      e.step();
      const texts = pilotTexts(e, 'N1AA');
      if (Number.isNaN(midAlong) && texts.some((t) => /midfield left downwind runway one three/.test(t))) { midAlong = alongNm(e, 'N1AA'); seen++; }
      if (Number.isNaN(baseAlong) && texts.some((t) => /left base runway one three/.test(t))) { baseAlong = alongNm(e, 'N1AA'); seen++; }
      if (Number.isNaN(finalAlong) && texts.some((t) => /two mile final runway one three/.test(t))) { finalAlong = alongNm(e, 'N1AA'); seen++; }
      if (ac.phase === 'ROLLOUT') break;
    }
    expect(seen).toBe(3);
    expect(midAlong).toBeCloseTo(mToNm(g13.lengthM / 2), 0); // abeam the middle of the runway
    expect(baseAlong).toBeLessThan(-1.0); // turning base behind the threshold
    expect(finalAlong).toBeCloseTo(-2, 0);
  });
});

describe('closed traffic, touch-and-go, low approach, option', () => {
  const finalSpawn = (cs: string, nm: number): ScenarioAircraftSpawn => ({
    atSec: 0, callsign: cs, type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
    start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 70, runwayEnd: '13', distanceNm: nm },
  });

  it('cleared touch-and-go: it touches down, rolls (runway occupied), lifts off and flies the closed-traffic pattern', () => {
    const e = makeEngine({ scenario: { spawns: [finalSpawn('N1AA', 2)] } });
    expect(say(e, cmd('LAND', 'N1AA', { runwayEnd: '13', destination: 'touch_and_go' }), 'TWR').status).toBe('accepted');
    const ac = find(e, 'N1AA');
    const phases: string[] = [];
    let rolledOnGround = 0;
    let occupied = 0;
    let maxAlong = 0;
    let startAlong = NaN;
    runUntil(e, () => {
      if (phases.at(-1) !== ac.phase) phases.push(ac.phase);
      if (ac.phase === 'ROLLOUT' && ac.onGround) {
        rolledOnGround++;
        if (Number.isNaN(startAlong)) startAlong = alongCross(g13, ac.pos).along;
        maxAlong = alongCross(g13, ac.pos).along;
        if (ac.occupyingRunways.includes('13/31') && e.getState().runwayOccupancy['13/31'].occupants.includes(ac.id)) occupied++;
      }
      return ac.phase === 'PATTERN';
    }, 400);
    expect(phases.slice(-3)).toEqual(['LANDING', 'ROLLOUT', 'PATTERN']);
    expect(rolledOnGround).toBeGreaterThan(80); // several seconds on the runway (design: 3 s decel + 3 s reconfigure + acceleration)
    expect(occupied).toBe(rolledOnGround); // the runway is occupied for the whole roll
    expect(maxAlong - startAlong).toBeGreaterThan(150);
    expect(ac.onGround).toBe(false);
    expect(e.getState().events.some((x) => /touched down runway 13.*touch and go: rolling/.test(x.text))).toBe(true);
    expect(e.getState().events.some((x) => /touch and go runway 13/.test(x.text))).toBe(true);
    // it climbs to pattern altitude, turns crosswind beyond the departure end (AIM 4-3-3) and is on downwind about 0.8 nm to the left
    expect(runUntil(e, () => Math.abs(alongCross(g13, ac.pos).cross) > nmToM(0.7) && Math.abs(headingDiff(ac.trackDeg, downwindHeading)) < 20, 600)).toBe(true);
    expect(alongCross(g13, ac.pos).cross).toBeLessThan(0); // left side
    expect(ac.altitudeFt - g13.elevationFt).toBeGreaterThan(700);
  });

  it('a departure cleared for takeoff is refused (training) while the touch-and-go aircraft is rolling on the runway', () => {
    const e = makeEngine({ scenario: { mode: 'training', spawns: [finalSpawn('N1AA', 2), { atSec: 0, callsign: 'N2BB', type: 'C172', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'holding_short', nodeId: 'H13', runwayEnd: '13' } }] } });
    say(e, cmd('LAND', 'N1AA', { runwayEnd: '13', destination: 'touch_and_go' }), 'TWR');
    const ac = find(e, 'N1AA');
    expect(runUntil(e, () => ac.phase === 'ROLLOUT' && ac.onGround, 400)).toBe(true);
    run(e, 1);
    const out = say(e, cmd('TAKEOFF', 'N2BB', { runwayEnd: '13' }), 'TWR');
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.unsafe).toBe(true);
  });

  it('too little runway for the type\'s takeoff distance: the pilot makes a full stop instead and says so (A320 on KACY 4)', () => {
    const kacy = loadKacy();
    const e = createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: ['4'], landing: ['4'] }, spawns: [ARRIVING('X1', '4', 4, 'A320', 'TWR')] }) });
    expect(say(e, cmd('LAND', 'X1', { runwayEnd: '4', destination: 'touch_and_go' }), 'TWR').status).toBe('accepted');
    const ac = find(e, 'X1');
    const phases = new Set<string>();
    runUntil(e, () => { phases.add(ac.phase); return ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt < 0.1; }, 900);
    expect(phases.has('PATTERN')).toBe(false);
    expect(pilotTexts(e, 'X1').some((t) => /unable touch and go, not enough runway, full stop/.test(t))).toBe(true);
  });

  it('cleared low approach: it crosses the runway without touching down and climbs out into the pattern', () => {
    const e = makeEngine({ scenario: { spawns: [finalSpawn('N1AA', 2)] } });
    expect(say(e, cmd('LAND', 'N1AA', { runwayEnd: '13', destination: 'low_approach' }), 'TWR').status).toBe('accepted');
    const ac = find(e, 'N1AA');
    expect(runUntil(e, () => ac.phase === 'PATTERN', 400)).toBe(true);
    expect(e.getState().events.some((x) => /low approach runway 13/.test(x.text))).toBe(true);
    expect(e.getState().events.some((x) => x.aircraftId === ac.id && /touched down/.test(x.text))).toBe(false);
  });

  it('cleared for the option: seeded choice between a touch-and-go and a full stop, identical on a rerun', () => {
    const outcome = (seed: number): string => {
      const e = makeEngine({ scenario: { seed, spawns: [finalSpawn('N1AA', 2)] } });
      say(e, cmd('LAND', 'N1AA', { runwayEnd: '13', destination: 'option' }), 'TWR');
      const ac = find(e, 'N1AA');
      runUntil(e, () => ac.phase === 'PATTERN' || ac.phase === 'RUNWAY_EXIT', 600);
      return ac.phase;
    };
    const results = [11, 12, 13, 14, 15, 16, 17, 18].map(outcome);
    expect(new Set(results).size).toBe(2); // both choices occur across seeds
    expect(results.map((_, i) => outcome(11 + i))).toEqual(results);
  });

  it('"left closed traffic" with the takeoff clearance: the departure stays in the pattern', () => {
    const e = makeEngine({ scenario: { spawns: [{ atSec: 0, callsign: 'N1AA', type: 'C172', flightRules: 'VFR', start: { kind: 'holding_short', nodeId: 'H13', runwayEnd: '13' }, isDeparture: true, initialFrequencyId: 'TWR' }] } });
    run(e, 2);
    expect(say(e, cmd('PATTERN_INSTRUCTION', 'N1AA', { destination: 'CLOSED_TRAFFIC', turnDirection: 'left' }), 'TWR').status).toBe('accepted');
    expect(say(e, cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' }), 'TWR').status).toBe('accepted');
    const ac = find(e, 'N1AA');
    expect(runUntil(e, () => ac.phase === 'PATTERN', 200)).toBe(true);
    expect(runUntil(e, () => Math.abs(alongCross(g13, ac.pos).cross) > nmToM(0.7), 600)).toBe(true);
    expect(ac.phase).toBe('PATTERN');
  });

  it('"go around, enter left downwind": the go-around climbs straight ahead and joins the pattern from the upwind leg', () => {
    const e = makeEngine({ scenario: { spawns: [finalSpawn('N1AA', 3)] } });
    run(e, 5);
    const ac = find(e, 'N1AA');
    expect(say(e, cmd('GO_AROUND', 'N1AA'), 'TWR').status).toBe('accepted');
    expect(say(e, cmd('ENTER_PATTERN', 'N1AA', { runwayEnd: '13', patternLeg: 'left_downwind', turnDirection: 'left' }), 'TWR').status).toBe('accepted');
    expect(ac.phase).toBe('PATTERN');
    expect(runUntil(e, () => Math.abs(alongCross(g13, ac.pos).cross) > nmToM(0.7) && Math.abs(headingDiff(ac.trackDeg, downwindHeading)) < 20, 900)).toBe(true);
  });
});

describe('traffic advisories', () => {
  const two = (vis: number) =>
    makeEngine({
      scenario: {
        weather: { source: 'simulated', windDirDeg: 0, windSpeedKt: 0, visibilitySm: vis, clouds: [{ cover: 'SKC', baseFtAgl: 0 }], temperatureC: 15, dewpointC: 5, altimeterInHg: 29.92, phenomena: [], flightCategory: 'VFR' },
        spawns: [
          { atSec: 0, callsign: 'N1AA', type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 70, runwayEnd: '13', distanceNm: 6 } },
          { atSec: 0, callsign: 'N2BB', type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 70, runwayEnd: '13', distanceNm: 3 } },
        ],
      },
    });
  const advisory = (e: SimulationEngine) => say(e, cmd('TRAFFIC_ADVISORY', 'N1AA', { traffic: { desc: 'cessna', position: 'final', distanceNm: 3 } }), 'TWR');

  it('visibility 1/2 sm: the traffic 3 nm ahead cannot be seen: "negative contact"', () => {
    const e = two(0.5);
    const out = advisory(e);
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') expect(out.readback).toBe('Negative contact, Cessna one alpha alpha');
  });

  it('unlimited visibility, traffic ahead: "traffic in sight" now, or "looking for traffic" and then "traffic in sight" a few seconds later; deterministic', () => {
    const run1 = () => {
      const e = two(10);
      const out = advisory(e);
      expect(out.status).toBe('accepted');
      const first = out.status === 'accepted' ? out.readback : '';
      run(e, 30);
      return [first, ...pilotTexts(e, 'N1AA')].join(' | ');
    };
    const a = run1();
    expect(a).toMatch(/Traffic in sight|Looking for traffic/);
    if (/Looking for traffic/.test(a)) expect(a).toMatch(/traffic in sight/);
    expect(run1()).toBe(a);
  });

  it('traffic that does not exist: "negative contact"', () => {
    const e = two(10);
    const out = say(e, cmd('TRAFFIC_ADVISORY', 'N1AA', { traffic: { desc: 'boeing 737', position: 'base' } }), 'TWR');
    expect(out.status === 'accepted' && out.readback).toMatch(/^Negative contact/);
  });

  it('acceptance of a following instruction needs the traffic in sight (7-2-1)', () => {
    const e = two(0.5);
    const out = say(e, cmd('FOLLOW_TRAFFIC', 'N1AA', { traffic: { desc: 'cessna', position: 'final', distanceNm: 3 } }), 'TWR');
    expect(out.status).toBe('rejected');
    expect(pilotTexts(e).at(-1)).toMatch(/^Negative contact/);
  });
});
