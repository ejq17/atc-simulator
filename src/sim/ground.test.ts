import { describe, expect, it } from 'vitest';
import { cmd, find, GA_PARKED, makeEngine, run, runUntil } from './__fixtures__/testHelpers';
import { createTestAirport } from './__fixtures__/testAirport';
import { dist, ktToMps } from './geo';
import { pointInPolygon } from './geo';

const airport = createTestAirport();

describe('ground movement', () => {
  it('pilot requests taxi on its own, then follows the authorised route and stops at the end', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED()] } });
    const ac = find(e, 'N723EJ');
    expect(ac.phase).toBe('PARKED');
    expect(runUntil(e, () => ac.phase === 'READY', 15)).toBe(true);
    expect(ac.pendingRequest?.kind).toBe('TAXI');
    const call = e.getState().events.find((x) => x.speaker === 'PILOT');
    expect(call?.text).toBe('Atlantic City Ground, Cessna seven two three echo juliet, at general aviation Ramp one, ready to taxi, VFR departure.');
    const out = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22', route: ['A'] }), { position: 'GND' });
    expect(out.status).toBe('accepted');
    expect(ac.phase).toBe('TAXIING');
    expect(ac.route?.nodeIds.at(-1)).toBe('H22');
    expect(ac.pendingRequest).toBeUndefined();
    expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT', 200)).toBe(true);
    run(e, 5);
    expect(dist(ac.pos, airport.taxiwayGraph.nodes.H22.pos)).toBeLessThan(0.5);
    expect(ac.groundSpeedKt).toBe(0);
    // reports ready for departure on tower only; on ground freq it just reports holding short
    expect(e.getState().events.some((x) => x.speaker === 'PILOT' && /holding short runway two two/.test(x.text))).toBe(true);
  });

  it('accelerates smoothly and never jumps further than speed*dt', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED()] } });
    const ac = find(e, 'N723EJ');
    run(e, 10);
    e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22', route: ['A'] }), { position: 'GND' });
    const dt = e.getState().clock.dtSec;
    let prevPos = { ...ac.pos };
    let prevV = ac.groundSpeedKt;
    let maxV = 0;
    for (let i = 0; i < 1200; i++) {
      e.step();
      const step = dist(prevPos, ac.pos);
      expect(step).toBeLessThanOrEqual(ktToMps(Math.max(ac.groundSpeedKt, prevV)) * dt + 1e-6);
      expect(Math.abs(ac.groundSpeedKt - prevV)).toBeLessThanOrEqual(1.25 * 1.944 * dt + 1e-6);
      maxV = Math.max(maxV, ac.groundSpeedKt);
      prevPos = { ...ac.pos };
      prevV = ac.groundSpeedKt;
    }
    expect(maxV).toBeLessThanOrEqual(15.01);
    expect(maxV).toBeGreaterThan(10);
  });

  it('stops at the holding position short of a runway not yet authorised, and CROSS_RUNWAY lets it continue', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED()] } });
    const ac = find(e, 'N723EJ');
    run(e, 10);
    const out = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY4', runwayEnd: '4', route: ['A'], holdShort: ['13/31'] }), { position: 'GND' });
    expect(out.status).toBe('accepted');
    expect(ac.route?.stopAtNodeIds).toEqual(['A_h13N', 'H4']);
    const rw13 = airport.runways.find((r) => r.id === '13/31')!;
    // run well past the time it would take to reach and cross the runway: it must stay held short
    let everOnRunway = false;
    run(e, 150);
    for (let i = 0; i < 600; i++) {
      e.step();
      if (pointInPolygon(ac.pos, rw13.polygon)) everOnRunway = true;
    }
    expect(everOnRunway).toBe(false);
    expect(ac.phase).toBe('HOLDING_SHORT');
    expect(dist(ac.pos, airport.taxiwayGraph.nodes.A_h13N.pos)).toBeLessThan(0.5);
    expect(ac.groundSpeedKt).toBe(0);
    expect(e.getState().conflicts.filter((c) => c.kind === 'RUNWAY_INCURSION')).toHaveLength(0);
    expect(e.getState().events.some((x) => x.speaker === 'PILOT' && /holding short of runway one three at alpha/.test(x.text))).toBe(true);
    expect(ac.pendingRequest?.kind).toBe('CROSSING');

    // Explicit crossing clearance.
    const cross = e.applyCommand(cmd('CROSS_RUNWAY', 'N723EJ', { crossRunwayId: '13/31' }), { position: 'GND' });
    expect(cross.status).toBe('accepted');
    expect(ac.runwayAuthorizations).toContain('13/31');
    let sawOnRunway = false;
    expect(
      runUntil(e, () => {
        if (pointInPolygon(ac.pos, rw13.polygon)) sawOnRunway = true;
        return ac.phase === 'HOLDING_SHORT' && ac.groundSpeedKt === 0 && dist(ac.pos, airport.taxiwayGraph.nodes.H4.pos) < 0.5;
      }, 200),
    ).toBe(true);
    expect(sawOnRunway).toBe(true);
    expect(ac.runwayAuthorizations).not.toContain('13/31');
    expect(e.getState().conflicts.filter((c) => c.kind === 'RUNWAY_INCURSION')).toHaveLength(0);
  });

  it('does not cross from a holding position after a new TAXI instruction either', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED()] } });
    const ac = find(e, 'N723EJ');
    run(e, 10);
    e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY4', runwayEnd: '4', route: ['A'] }), { position: 'GND' });
    expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT', 200)).toBe(true);
    run(e, 6);
    const again = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY4', runwayEnd: '4', route: ['A'] }), { position: 'GND' });
    expect(again.status).toBe('accepted');
    run(e, 60);
    expect(ac.groundSpeedKt).toBe(0);
    expect(dist(ac.pos, airport.taxiwayGraph.nodes.A_h13N.pos)).toBeLessThan(0.5);
  });

  it('CROSS_RUNWAY is rejected for an aircraft that is not approaching that runway', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED()] } });
    run(e, 10);
    const out = e.applyCommand(cmd('CROSS_RUNWAY', 'N723EJ', { crossRunwayId: '4/22' }), { position: 'GND' });
    expect(out.status).toBe('rejected');
  });

  it('HOLD_POSITION stops the aircraft without teleporting, TAXI resumes', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED()] } });
    const ac = find(e, 'N723EJ');
    run(e, 10);
    e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22', route: ['A'] }), { position: 'GND' });
    run(e, 30);
    expect(ac.groundSpeedKt).toBeGreaterThan(5);
    const before = { ...ac.pos };
    const out = e.applyCommand(cmd('HOLD_POSITION', 'N723EJ'), { position: 'GND' });
    expect(out.status).toBe('accepted');
    run(e, 10);
    expect(ac.groundSpeedKt).toBe(0);
    expect(dist(before, ac.pos)).toBeLessThan(25);
    const stopped = { ...ac.pos };
    run(e, 5);
    expect(dist(stopped, ac.pos)).toBe(0);
    e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22', route: ['A'] }), { position: 'GND' });
    run(e, 10);
    expect(ac.groundSpeedKt).toBeGreaterThan(3);
  });

  it('keeps spacing behind an aircraft ahead', () => {
    const e = makeEngine({
      scenario: { spawns: [GA_PARKED('N111AA', 'GA1'), GA_PARKED('N222BB', 'GA3', 'GND', { atSec: 0 })] },
    });
    const a = find(e, 'N111AA');
    const b = find(e, 'N222BB');
    run(e, 10);
    e.applyCommand(cmd('TAXI', 'N222BB', { destination: 'RWY22', runwayEnd: '22', route: ['A'] }), { position: 'GND' });
    run(e, 6);
    e.applyCommand(cmd('TAXI', 'N111AA', { destination: 'RWY22', runwayEnd: '22', route: ['A'] }), { position: 'GND' });
    let minGap = Infinity;
    for (let i = 0; i < 2400; i++) {
      e.step();
      if (a.groundSpeedKt > 0 || b.groundSpeedKt > 0) minGap = Math.min(minGap, dist(a.pos, b.pos));
    }
    // both reach the same hold node region; follower must stay >= 1.5 lengths + 20 m behind (32.5 m)
    expect(minGap).toBeGreaterThan(30);
    expect(e.getState().conflicts.filter((c) => c.kind === 'GROUND_PROXIMITY')).toHaveLength(0);
    expect(dist(b.pos, airport.taxiwayGraph.nodes.H22.pos)).toBeLessThan(0.5);
    expect(dist(a.pos, b.pos)).toBeGreaterThanOrEqual(32);
  });

  it('rejects invalid taxi routes with an explanation', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED()] } });
    run(e, 10);
    const unknown = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22', route: ['Z'] }), { position: 'GND' });
    expect(unknown.status).toBe('rejected');
    if (unknown.status === 'rejected') {
      expect(unknown.reason).toMatch(/does not exist/);
      expect(unknown.pilotResponse).toMatch(/^Unable,/);
    }
    // order that cannot be satisfied
    const bad = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22', route: ['A', 'D'] }), { position: 'GND' });
    expect(bad.status).toBe('rejected');
    // unknown destination
    const nowhere = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'Narnia' }), { position: 'GND' });
    expect(nowhere.status).toBe('rejected');
    // aircraft did not move
    const ac = find(e, 'N723EJ');
    expect(ac.route).toBeUndefined();
    expect(ac.phase).toBe('READY');
  });

  it('taxis an arrival to parking and marks it ARRIVED', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED('N5AA', 'GA1', 'GND')] } });
    const ac = find(e, 'N5AA');
    // Teleport-free scenario: taxi out to the A/B junction area then back to GA2.
    run(e, 10);
    e.applyCommand(cmd('TAXI', 'N5AA', { destination: 'RWY22', runwayEnd: '22', route: ['A'] }), { position: 'GND' });
    run(e, 40);
    const back = e.applyCommand(cmd('TAXI_TO_PARKING', 'N5AA', { destination: 'GA2' }), { position: 'GND' });
    expect(back.status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'PARKED', 300)).toBe(true);
    expect(dist(ac.pos, airport.taxiwayGraph.nodes.GA2.pos)).toBeLessThan(0.1);
  });
});
