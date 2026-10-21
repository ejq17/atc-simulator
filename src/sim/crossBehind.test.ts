/**
 * Conditional runway crossing "cross runway 13 behind the landing Cessna" (ICAO Doc 4444 conditional clearance, conditionalCrossing.ts).
 * Fixture airport: taxiway A crosses runway 13/31 at A_r13, 800 m from the threshold of 13; the crossing aircraft holds short at A_h13N.
 */
import { describe, expect, it } from 'vitest';
import { ARRIVING, cmd, find, GA_PARKED, makeEngine, pilotTexts, run, runUntil } from './__fixtures__/testHelpers';
import { createTestAirport } from './__fixtures__/testAirport';
import { alongCross, findRunwayEnd } from './runways';
import { pointInPolygon } from './geo';
import type { SimulationEngine } from './api';

const airport = createTestAirport();
const g13 = findRunwayEnd(airport, '13')!;
const rw13 = airport.runways.find((r) => r.id === '13/31')!;
const CROSS_ALONG = alongCross(g13, airport.taxiwayGraph.nodes.A_r13.pos).along;

const LANDER = 'N67890';
const CROSSER = 'N723EJ';
const behind = (callsign = LANDER) => cmd('CROSS_RUNWAY', CROSSER, { crossRunwayId: '13/31', runwayId: '13/31', runwayEnd: '13', behindCallsign: callsign });

/** N723EJ taxis from GA1 to runway 4 via A, held short of 13/31; a Cessna lands on 13 from `finalNm` out. */
function setup(finalNm = 6): SimulationEngine {
  const e = makeEngine({ scenario: { spawns: [GA_PARKED(), ARRIVING(LANDER, '13', finalNm, 'C172')] } });
  run(e, 10);
  e.applyCommand(cmd('TAXI', CROSSER, { destination: 'RWY4', runwayEnd: '4', route: ['A'], holdShort: ['13/31'] }), { position: 'GND' });
  expect(runUntil(e, () => find(e, CROSSER).phase === 'HOLDING_SHORT', 200)).toBe(true);
  run(e, 5);
  return e;
}
const incursions = (e: SimulationEngine) => e.getState().conflicts.filter((c) => c.kind === 'RUNWAY_INCURSION');
const events = (e: SimulationEngine, re: RegExp) => e.getState().events.filter((x) => re.test(x.text));

describe('conditional crossing behind a landing aircraft', () => {
  it('is read back with "behind", holds while the lander is airborne and rolling short of the crossing, releases once it has passed, then crosses', () => {
    const e = setup();
    const ac = find(e, CROSSER);
    const lander = find(e, LANDER);
    e.applyCommand(cmd('LAND', LANDER, { runwayEnd: '13' }), { position: 'TWR' });
    expect(lander.onGround).toBe(false);

    const out = e.applyCommand(behind(), { position: 'GND' });
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') {
      expect(out.readback).toBe('Cross runway one three behind the landing Cessna, Cessna seven two three echo juliet');
      expect(out.clearance.behindCallsign).toBe(LANDER);
    }
    // not an authorisation yet, still holding short
    expect(ac.runwayAuthorizations).not.toContain('13/31');
    expect(ac.phase).toBe('HOLDING_SHORT');
    expect(ac.route?.stopAtNodeIds).toContain('A_h13N');
    expect(ac.pendingRequest).toBeUndefined();

    let sawLanderRolling = false;
    let released = -1;
    let onRunwayAt = -1;
    const t0 = e.getState().clock.timeSec;
    for (let i = 0; i < 300; i++) {
      run(e, 1);
      const now = e.getState().clock.timeSec - t0;
      if (lander.onGround && alongCross(g13, lander.pos).along < CROSS_ALONG) {
        sawLanderRolling = true;
        // lander on the ground but short of the crossing: still holding
        expect(ac.runwayAuthorizations, `t=${now}`).not.toContain('13/31');
        expect(ac.groundSpeedKt).toBe(0);
      }
      if (released < 0 && ac.runwayAuthorizations.includes('13/31')) {
        released = now;
        expect(lander.onGround).toBe(true);
        expect(alongCross(g13, lander.pos).along).toBeGreaterThan(CROSS_ALONG + 100 - 1);
      }
      if (onRunwayAt < 0 && pointInPolygon(ac.pos, rw13.polygon)) onRunwayAt = now;
      if (released < 0) expect(onRunwayAt, 'moved before the release').toBe(-1);
    }
    expect(sawLanderRolling).toBe(true);
    expect(released).toBeGreaterThan(0);
    expect(onRunwayAt).toBeGreaterThanOrEqual(released);
    expect(events(e, /N723EJ crossing runway 13 behind N67890/)).toHaveLength(1);
    expect(incursions(e)).toHaveLength(0);
    expect(e.getState().conflicts.filter((c) => c.severity === 'critical')).toHaveLength(0);
    expect(e.getState().events.filter((x) => x.severity === 'critical').map((x) => x.text)).toEqual([]);
    // it crossed (the plain crossing's own end state: authorisation dropped after the runway is left)
    expect(ac.runwayAuthorizations).not.toContain('13/31');
  });

  it('a lander that goes around does not release the crossing: warning logged, the aircraft keeps holding, the controller re-clears', () => {
    const e = setup(4);
    const ac = find(e, CROSSER);
    e.applyCommand(cmd('LAND', LANDER, { runwayEnd: '13' }), { position: 'TWR' });
    expect(e.applyCommand(behind(), { position: 'GND' }).status).toBe('accepted');
    run(e, 20);
    expect(e.applyCommand(cmd('GO_AROUND', LANDER), { position: 'TWR' }).status).toBe('accepted');
    run(e, 120);
    expect(find(e, LANDER).onGround).toBe(false);
    expect(ac.runwayAuthorizations).not.toContain('13/31');
    expect(ac.phase).toBe('HOLDING_SHORT');
    expect(ac.groundSpeedKt).toBe(0);
    const warn = events(e, /went around/).find((x) => x.callsign === CROSSER);
    expect(warn?.severity).toBe('warning');
    expect(incursions(e)).toHaveLength(0);
    // the pilot asks again, and a plain clearance is then needed and works
    expect(pilotTexts(e, CROSSER).filter((t) => /holding short of runway one three/.test(t)).length).toBeGreaterThanOrEqual(2);
    expect(e.applyCommand(cmd('CROSS_RUNWAY', CROSSER, { crossRunwayId: '13/31' }), { position: 'GND' }).status).toBe('accepted');
    expect(ac.runwayAuthorizations).toContain('13/31');
  });

  it('is released when the named aircraft has left the runway before the crossing point', () => {
    const e = setup();
    const ac = find(e, CROSSER);
    const lander = find(e, LANDER);
    e.applyCommand(cmd('LAND', LANDER, { runwayEnd: '13' }), { position: 'TWR' });
    expect(e.applyCommand(behind(), { position: 'GND' }).status).toBe('accepted');
    expect(runUntil(e, () => lander.onGround && lander.occupyingRunways.includes('13/31'), 400)).toBe(true);
    expect(ac.runwayAuthorizations).not.toContain('13/31');
    // the lander vacates (taken off the runway before the crossing point)
    lander.pos = { x: lander.pos.x + 1000, y: lander.pos.y - 1000 };
    lander.occupyingRunways = [];
    run(e, 1);
    expect(ac.runwayAuthorizations).toContain('13/31');
    expect(events(e, /N723EJ crossing runway 13 behind N67890/)).toHaveLength(1);
  });

  it('is cancelled with a warning when the named aircraft disappears', () => {
    const e = setup();
    const ac = find(e, CROSSER);
    e.applyCommand(cmd('LAND', LANDER, { runwayEnd: '13' }), { position: 'TWR' });
    expect(e.applyCommand(behind(), { position: 'GND' }).status).toBe('accepted');
    delete e.getState().aircraft[find(e, LANDER).id];
    run(e, 3);
    expect(ac.runwayAuthorizations).not.toContain('13/31');
    expect(events(e, /conditional crossing of runway 13 cancelled/)[0]?.severity).toBe('warning');
  });

  it('a premature move before the release would be a runway incursion: a conditional crossing is no authorisation', () => {
    const e = setup();
    const ac = find(e, CROSSER);
    e.applyCommand(cmd('LAND', LANDER, { runwayEnd: '13' }), { position: 'TWR' });
    expect(e.applyCommand(behind(), { position: 'GND' }).status).toBe('accepted');
    ac.pos = { ...airport.taxiwayGraph.nodes.A_r13.pos };
    ac.phase = 'TAXIING';
    run(e, 2);
    expect(incursions(e).length).toBeGreaterThan(0);
  });

  it('is refused when the named aircraft is not landing on that runway, or does not exist', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED(), GA_PARKED(LANDER, 'GA2'), ARRIVING('N11111', '31', 3, 'C172')] } });
    run(e, 10);
    e.applyCommand(cmd('TAXI', CROSSER, { destination: 'RWY4', runwayEnd: '4', route: ['A'], holdShort: ['13/31'] }), { position: 'GND' });
    expect(runUntil(e, () => find(e, CROSSER).phase === 'HOLDING_SHORT', 200)).toBe(true);
    run(e, 5);
    const ac = find(e, CROSSER);
    // parked aircraft
    const a = e.applyCommand(behind(LANDER), { position: 'GND' });
    expect(a.status).toBe('rejected');
    if (a.status === 'rejected') {
      expect(a.reason).toMatch(/not landing on or rolling out on runway 13\/31/);
      expect(a.pilotResponse ?? '').toMatch(/we don't see the traffic/);
    }
    // landing, but on the other end of the same runway is fine; on another runway is not: use 4/22 aircraft
    const b = e.applyCommand(behind('N99999'), { position: 'GND' });
    expect(b.status).toBe('rejected');
    expect(ac.runwayAuthorizations).not.toContain('13/31');
    expect(ac.route?.stopAtNodeIds).toContain('A_h13N');
  });

  it('plain "cross runway 13" is unchanged: authorised at once, no conditional state', () => {
    const e = setup();
    const ac = find(e, CROSSER);
    const out = e.applyCommand(cmd('CROSS_RUNWAY', CROSSER, { crossRunwayId: '13/31' }), { position: 'GND' });
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') {
      expect(out.readback).toBe('Cross runway one three, Cessna seven two three echo juliet');
      expect(out.clearance.behindCallsign).toBeUndefined();
    }
    expect(ac.runwayAuthorizations).toContain('13/31');
    expect(ac.route?.stopAtNodeIds).not.toContain('A_h13N');
    let sawOnRunway = false;
    expect(runUntil(e, () => { if (pointInPolygon(ac.pos, rw13.polygon)) sawOnRunway = true; return ac.phase === 'HOLDING_SHORT' && ac.groundSpeedKt === 0 && sawOnRunway; }, 200)).toBe(true);
    expect(incursions(e)).toHaveLength(0);
    expect(events(e, /behind/)).toHaveLength(0);
  });

  it('a later plain crossing replaces a pending conditional one', () => {
    const e = setup();
    const ac = find(e, CROSSER);
    e.applyCommand(cmd('LAND', LANDER, { runwayEnd: '13' }), { position: 'TWR' });
    expect(e.applyCommand(behind(), { position: 'GND' }).status).toBe('accepted');
    run(e, 6);
    expect(e.applyCommand(cmd('CROSS_RUNWAY', CROSSER, { crossRunwayId: '13/31' }), { position: 'GND' }).status).toBe('accepted');
    expect(ac.runwayAuthorizations).toContain('13/31');
    run(e, 5);
    expect(events(e, /crossing runway 13 behind/)).toHaveLength(0);
  });
});
