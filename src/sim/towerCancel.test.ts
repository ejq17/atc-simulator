/** Cancellation of takeoff clearance (JO 7110.65 3-9-11) and the rejected takeoff. */
import { describe, expect, it } from 'vitest';
import { cmd, find, HOLDING, makeEngine, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import { getPerformance } from './performance';
import { alongCross, findRunwayEnd } from './runways';

const setup = (type = 'C172', mode: 'free_play' | 'training' = 'free_play') => {
  const e = makeEngine({ scenario: { mode, spawns: [HOLDING('N1AA', 'H13', '13', type)] } });
  run(e, 2);
  return e;
};
const cancel = (f: Parameters<typeof cmd>[2] = {}) => cmd('CANCEL_TAKEOFF', 'N1AA', f);

describe('cancel takeoff clearance', () => {
  it('before the roll starts: the aircraft goes back to line up and wait, no takeoff', () => {
    const e = setup();
    expect(e.applyCommand(cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' })).status).toBe('accepted');
    const ac = find(e, 'N1AA');
    expect(ac.phase).toBe('CLEARED_FOR_TAKEOFF');
    const out = say(e, cancel({ reason: 'traffic on the runway' }), 'TWR');
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') expect(out.readback).toBe('Cancelling takeoff clearance, stopping, Cessna one alpha alpha');
    expect(ac.phase).toBe('LINE_UP_AND_WAIT');
    run(e, 60);
    expect(ac.onGround).toBe(true);
    expect(ac.phase).toBe('LINE_UP_AND_WAIT');
    expect(ac.groundSpeedKt).toBe(0);
  });

  it('in the early roll: the C172 brakes to a stop on the runway and reports; it can be cleared again', () => {
    const e = setup();
    e.applyCommand(cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' }));
    const ac = find(e, 'N1AA');
    expect(runUntil(e, () => ac.phase === 'TAKEOFF_ROLL' && ac.airspeedKt > 25, 60)).toBe(true);
    const out = say(e, cancel({ reason: 'vehicle on the runway' }), 'TWR');
    expect(out.status).toBe('accepted');
    expect(runUntil(e, () => ac.groundSpeedKt === 0, 30)).toBe(true);
    expect(ac.onGround).toBe(true);
    expect(ac.phase).toBe('LINE_UP_AND_WAIT');
    const g = findRunwayEnd(e.getState().airport, '13')!;
    expect(alongCross(g, ac.pos).along).toBeLessThan(g.lengthM);
    expect(pilotTexts(e).some((t) => /stopped on runway one three, holding position/.test(t))).toBe(true);
    // not airborne, not rolling: a new takeoff clearance works
    expect(e.applyCommand(cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' })).status).toBe('accepted');
  });

  it('"stop" while cleared for takeoff or rolling is a cancellation (hold position becomes cancel takeoff)', () => {
    const e = setup();
    e.applyCommand(cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' }));
    const ac = find(e, 'N1AA');
    expect(runUntil(e, () => ac.phase === 'TAKEOFF_ROLL' && ac.airspeedKt > 20, 60)).toBe(true);
    const out = say(e, cmd('HOLD_POSITION', 'N1AA'), 'TWR');
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') expect(out.clearance.kind).toBe('CANCEL_TAKEOFF');
    expect(runUntil(e, () => ac.groundSpeedKt === 0, 30)).toBe(true);
    expect(ac.phase).toBe('LINE_UP_AND_WAIT');
  });

  it('past the decision point (rotation speed, 14 CFR 25.107: V1 <= VR) the aircraft is airborne: the pilot says so and continues', () => {
    const e = setup();
    e.applyCommand(cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' }));
    const ac = find(e, 'N1AA');
    expect(runUntil(e, () => !ac.onGround, 60)).toBe(true);
    const out = say(e, cancel({ reason: 'traffic' }), 'TWR');
    expect(out.status).toBe('rejected');
    expect(pilotTexts(e).at(-1)).toMatch(/^Unable, we're airborne, continuing/);
    expect(ac.phase).toMatch(/INITIAL_CLIMB|DEPARTURE/);
  });

  it('too little runway left to stop at the maximum braking rate: the pilot continues', () => {
    const e = setup('A320');
    e.applyCommand(cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' }));
    const ac = find(e, 'N1AA');
    const perf = getPerformance('A320');
    expect(runUntil(e, () => ac.phase === 'TAKEOFF_ROLL' && ac.airspeedKt > perf.rotateSpeedKt * 0.6, 120)).toBe(true);
    const g = findRunwayEnd(e.getState().airport, '13')!;
    // move the aircraft close to the runway end at that speed (the stopping distance no longer fits)
    ac.pos = { x: g.end.threshold.x + g.dir.x * (g.lengthM - 150), y: g.end.threshold.y + g.dir.y * (g.lengthM - 150) };
    const out = say(e, cancel({ reason: 'traffic' }), 'TWR');
    expect(out.status).toBe('rejected');
    expect(pilotTexts(e).at(-1)).toMatch(/past the point where we can stop, continuing/);
    expect(ac.phase).toBe('TAKEOFF_ROLL');
  });

  it('after the roll started and with no reason and no hazard it is an improper instruction: flagged in free play, refused in training', () => {
    const free = setup();
    free.applyCommand(cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' }));
    const a = find(free, 'N1AA');
    runUntil(free, () => a.phase === 'TAKEOFF_ROLL' && a.airspeedKt > 20, 60);
    expect(say(free, cancel(), 'TWR').status).toBe('accepted');
    expect(free.getState().events.some((x) => /Improper instruction accepted: cancelling the takeoff clearance/.test(x.text))).toBe(true);

    const tr = setup('C172', 'training');
    tr.applyCommand(cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' }));
    const b = find(tr, 'N1AA');
    runUntil(tr, () => b.phase === 'TAKEOFF_ROLL' && b.airspeedKt > 20, 60);
    const out = say(tr, cancel(), 'TWR');
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.reason).toMatch(/3-9-11/);
  });

  it('is deterministic', () => {
    const trace = () => {
      const e = setup();
      e.applyCommand(cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' }));
      const ac = find(e, 'N1AA');
      runUntil(e, () => ac.phase === 'TAKEOFF_ROLL' && ac.airspeedKt > 30, 60);
      say(e, cancel({ reason: 'traffic' }), 'TWR');
      runUntil(e, () => ac.groundSpeedKt === 0, 30);
      return `${ac.pos.x.toFixed(3)},${ac.pos.y.toFixed(3)},${e.getState().clock.timeSec}`;
    };
    expect(trace()).toBe(trace());
  });
});
