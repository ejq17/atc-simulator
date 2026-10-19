/**
 * Tools for a Ground controller whose lander is pointed at a queue: hold position anywhere (also on the exit), a new route or a turn onto another
 * taxiway, a one eighty where there is room (JO 7110.65 3-7-2 has no phrase for it: non-standard), and the engine's wait short of the exit stub a lander is about to use.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import { loadKacy } from '../airport';
import { ARRIVING, GA_PARKED, cmd, find, makeScenario, run, runUntil, say } from './__fixtures__/testHelpers';
import { headingDiff } from './geo';
import { findLeader } from './groundMovement';
import { landerStubs, landerStubOnRoute } from './exitStubs';
import { parseTransmission } from '../commands';
import { CTX } from '../commands/testkit';

const kacy = loadKacy();

/** A C172 / A320 landed on 22 and told to take the wrong side of Bravo (the old default), now on Ground's frequency, stopped at the hold line. */
function lander(type = 'C172', end = '22', twy = 'B', side: 'left' | 'right' = 'right'): { e: SimulationEngine; cs: string } {
  const e = createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: [end], landing: [end] }, spawns: [ARRIVING('X1', end, 4, type, 'TWR')] }) });
  e.applyCommand(cmd('LAND', 'X1', { runwayEnd: end }));
  say(e, cmd('EXIT_RUNWAY', 'X1', { exitTaxiway: twy, turnDirection: side }), 'TWR');
  return { e, cs: 'X1' };
}
/** To Ground's frequency: `moving` = as soon as it is off the runway and still rolling along the exit. */
const toGround = (e: SimulationEngine, cs: string, moving = false) => {
  const ac = find(e, cs);
  runUntil(e, () => ac.phase === 'RUNWAY_EXIT' && (!moving || ac.groundSpeedKt > 3), 600);
  say(e, cmd('CONTACT_FREQUENCY', cs, { frequencyId: 'GND' }), 'TWR');
  runUntil(e, () => ac.frequencyId === 'GND', 60);
  return ac;
};

describe('hold position on the exit', () => {
  it('stops an aircraft that is still rolling along the exit, short of the hold line', () => {
    const { e, cs } = lander('C172', '22', 'B', 'left');
    const ac = toGround(e, cs, true);
    expect(ac.groundSpeedKt).toBeGreaterThan(3);
    expect(say(e, cmd('HOLD_POSITION', cs), 'GND').status).toBe('accepted');
    run(e, 15);
    expect(ac.groundSpeedKt).toBe(0);
    expect(ac.route!.progressIndex).toBeLessThan(ac.route!.nodeIds.length);
    // and a new taxi instruction releases it
    expect(say(e, cmd('TAXI_TO_PARKING', cs, { destination: 'GA-1' }), 'GND').status).toBe('accepted');
    run(e, 20);
    expect(ac.groundSpeedKt).toBeGreaterThan(3);
  });
});

describe('re-routing a lander', () => {
  it('a turn onto a taxiway that is not at the aircraft is refused with the reason; a new taxi route replaces the exit route and it moves', () => {
    const { e, cs } = lander('C172', '13', 'A', 'right');
    const ac = toGround(e, cs);
    run(e, 30);
    expect(ac.groundSpeedKt).toBe(0);
    // "turn left on Bravo" is a progressive-taxi step made AT the intersection (3-7-2): the hold line of Alpha is not one
    const refused = say(e, cmd('EXIT_RUNWAY', cs, { exitTaxiway: 'B', turnDirection: 'left' }), 'GND');
    expect(refused).toMatchObject({ status: 'rejected' });
    expect(refused.status === 'rejected' && refused.pilotResponse).toMatch(/can't turn left on bravo here/);
    const before = ac.route?.nodeIds.join('>');
    expect(say(e, cmd('TAXI', cs, { destination: 'GA-1', route: ['A', 'B'] }), 'GND').status).toBe('accepted');
    expect(ac.route!.nodeIds.join('>')).not.toBe(before);
    run(e, 15);
    expect(ac.groundSpeedKt).toBeGreaterThan(3);
  });
});

describe('make a one eighty', () => {
  it('parses (non-standard, lower confidence) in several wordings', () => {
    for (const s of ['November 723 echo juliet, make a one eighty', 'November 723 echo juliet, do a 180', 'November 723 echo juliet, turn around']) {
      const c = parseTransmission(s, CTX).commands[0];
      expect(c.kind).toBe('TURN_AROUND');
      expect(c.confidence).toBeLessThan(0.95);
      expect(c.issues.join(' ')).toMatch(/non-standard/);
    }
  });

  it('a C172 on the exit stub stops, turns 180 degrees, holds, and takes a route back the other way', () => {
    const { e, cs } = lander('C172', '22', 'B', 'left');
    const ac = toGround(e, cs);
    run(e, 30);
    const h0 = ac.headingDeg;
    expect(say(e, cmd('TURN_AROUND', cs), 'GND').status).toBe('accepted');
    expect(runUntil(e, () => Math.abs(Math.abs(headingDiff(ac.headingDeg, h0)) - 180) < 1 && ac.groundSpeedKt === 0, 30)).toBe(true);
    expect(ac.flags.holdingPosition).toBe(true);
    expect(ac.route).toBeUndefined();
    expect(say(e, cmd('TAXI_TO_PARKING', cs, { destination: 'GA-1' }), 'GND').status).toBe('accepted');
    run(e, 25);
    expect(ac.groundSpeedKt).toBeGreaterThan(3);
  });

  it('an A320 has no room on a plain taxiway; on the runway nobody turns around', () => {
    const { e, cs } = lander('A320');
    const ac = toGround(e, cs);
    run(e, 40);
    const out = say(e, cmd('TURN_AROUND', cs), 'GND');
    expect(out.status).toBe('rejected');
    const l = lander();
    const onRwy = find(l.e, l.cs);
    runUntil(l.e, () => onRwy.phase === 'ROLLOUT', 600);
    say(l.e, cmd('CONTACT_FREQUENCY', l.cs, { frequencyId: 'GND' }), 'TWR');
    expect(say(l.e, cmd('TURN_AROUND', l.cs), 'TWR').status).toBe('rejected');
    expect(ac.phase).not.toBe('ROLLOUT');
  });
});

describe('the engine waits short of the exit stub a lander is about to use', () => {
  const build = (withLander: boolean) => {
    const spawns = [GA_PARKED('T1', 'GA-1', 'GND'), ...(withLander ? [ARRIVING('X1', '22', 1.5, 'C172', 'TWR')] : [])];
    const e = createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: ['22'], landing: ['22'] }, spawns }) });
    run(e, 2);
    expect(say(e, cmd('TAXI', 'T1', { destination: 'RWY13', route: ['B'], holdShort: ['4/22'] }), 'GND').status).toBe('accepted');
    return e;
  };

  it('a taxiing aircraft whose route runs over the exit stub sees the lander as a stopped leader at the hold line', () => {
    const e = build(true);
    const state = e.getState();
    const stubs = landerStubs(state);
    expect(stubs).toHaveLength(1);
    const t1 = find(e, 'T1');
    // the whole route from the ramp reaches the stub far down it (the reservation applies within 300 m of the aircraft, `STUB_RESERVE_LEAD_M`); the part of it nearer the stub does
    expect(landerStubOnRoute(state, t1.route!.nodeIds, t1.id)).toBeUndefined();
    const i = t1.route!.nodeIds.indexOf(stubs[0].holdNodeId);
    expect(i).toBeGreaterThan(1);
    expect(landerStubOnRoute(state, t1.route!.nodeIds.slice(i - 1), t1.id)?.aircraftId).toBe(find(e, 'X1').id);
    t1.pos = { ...state.airport.taxiwayGraph.nodes[t1.route!.nodeIds[i - 1]].pos };
    t1.route!.progressIndex = i;
    expect(findLeader({ state, runtime: (e as unknown as { runtime: never }).runtime } as never, t1)).toBeDefined();
  });

  it('without a lander there is no leader at that spot', () => {
    const e = build(false);
    const state = e.getState();
    expect(landerStubs(state)).toHaveLength(0);
  });
});
