/**
 * Ground fairness (ai/world.ts DEPARTURE_WAIT_BOUND_SEC, ground.ts): a departure that has waited longer than the bound outranks the arrivals waiting at
 * their exit for the lanes, and its pushback is no longer held for taxiing traffic.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from '../sim/engine';
import { ARRIVING, GA_PARKED, HOLDING, find, makeScenario } from '../sim/__fixtures__/testHelpers';
import { loadKacy } from '../airport';
import { DEPARTURE_WAIT_BOUND_SEC, opposingTraffic, outranks, overdue, planParking, starvingDeparture } from './world';
import { createHarness, kacy } from './testkit';
import { landerStubs } from '../sim/exitStubs';
import type { ScenarioAircraftSpawn } from '../sim/types';

const airport = loadKacy();

function landerAndDeparture() {
  const e = createEngine({
    airport, readbackErrorRate: 0,
    scenario: makeScenario({ activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [HOLDING('N2B', 'HP4-22-B-2', '22', 'C172', 'GND'), GA_PARKED('N1A', 'GA-1', 'GND')] }),
  });
  const st = e.getState();
  const lander = find(e, 'N2B');
  // the lander has just exited runway 22 at the Bravo hold line and asks for taxi instructions to the ramp
  lander.isDeparture = false;
  lander.phase = 'RUNWAY_EXIT';
  lander.pendingRequest = { kind: 'TAXI', text: 'request taxi to parking', sinceSec: 900 };
  const dep = find(e, 'N1A');
  dep.phase = 'READY';
  dep.pendingRequest = { kind: 'TAXI', text: 'ready to taxi', sinceSec: 20 };
  return { e, st, lander, dep };
}

describe('departure fairness', () => {
  it('the bound is 8 minutes', () => {
    expect(DEPARTURE_WAIT_BOUND_SEC).toBe(480);
  });

  it('a departure that waited past the bound outranks an arrival waiting at its exit; before the bound it does not hold the arrival', () => {
    const { st, lander, dep } = landerAndDeparture();
    const plan = planParking(st, lander)!;
    expect(plan).toBeDefined();
    // 5 minutes after it appeared: not overdue, the arrival is not held by it
    st.clock.timeSec = 300;
    dep.spawnedAtSec = 0;
    expect(overdue(st, dep)).toBe(false);
    expect(opposingTraffic(st, plan.nodeIds, lander.id)).toBeUndefined();
    // 10 minutes: the departure has waited past the bound, the arrival holds at its exit for the lane the departure will use
    st.clock.timeSec = 600;
    expect(overdue(st, dep)).toBe(true);
    expect(starvingDeparture(st, dep)).toBe(true);
    expect(opposingTraffic(st, plan.nodeIds, lander.id)?.id).toBe(dep.id);
  });

  it('rank: an overdue aircraft outranks one that is not; among equals the one that waited longer', () => {
    const { st, lander, dep } = landerAndDeparture();
    st.clock.timeSec = 1000; // lander asked at 900 (100 s), the departure appeared at 0 (1000 s: overdue)
    dep.spawnedAtSec = 0;
    expect(outranks(st, dep, lander)).toBe(true);
    expect(outranks(st, lander, dep)).toBe(false);
    dep.spawnedAtSec = 800; // 200 s: neither overdue; the lander asked at 900, the departure at 800
    expect(outranks(st, dep, lander)).toBe(true);
    lander.pendingRequest!.sinceSec = 700;
    expect(outranks(st, lander, dep)).toBe(true);
  });

  it('an aircraft already taxiing is never held back by the ranking (it stands in the lane)', () => {
    const { st, lander, dep } = landerAndDeparture();
    st.clock.timeSec = 1000;
    dep.spawnedAtSec = 0;
    lander.phase = 'TAXIING';
    lander.pendingRequest = { kind: 'TAXI', text: 'request next progressive taxi instructions', sinceSec: 0, progressive: true };
    expect(overdue(st, lander)).toBe(false);
    expect(overdue(st, dep)).toBe(true);
    // the same overdue departure holds the arrival while it waits at its exit, but not once it is taxiing
    const plan = planParking(st, lander)!;
    expect(opposingTraffic(st, plan.nodeIds, lander.id)).toBeUndefined();
    lander.phase = 'RUNWAY_EXIT';
    lander.pendingRequest = { kind: 'TAXI', text: 'request taxi to parking', sinceSec: 900 };
    expect(opposingTraffic(st, plan.nodeIds, lander.id)?.id).toBe(dep.id);
  });
});

describe('pushback is not held for more than the bound', () => {
  const ifrDep = (cs: string, gate: string): ScenarioAircraftSpawn => ({
    atSec: 0, callsign: cs, type: 'A320', flightRules: 'IFR', start: { kind: 'parked', parkingId: gate }, isDeparture: true, initialFrequencyId: 'GND',
  });
  it('Ground approves the pushback after the bound although an aircraft stands in the lane next to the stand', () => {
    const h = createHarness({ player: ['TWR'], mode: 'free_play', readbackErrorRate: 0, spawns: [ifrDep('NKS451', 'GATE-2'), ARRIVING('N723EJ', '13', 30)] });
    // an aircraft held in the lane in front of the gate: its route passes within 90 m of the stand
    const blocker = h.find('N723EJ')!;
    const gate = kacy.parking.find((p) => p.id === 'GATE-2')!;
    const near = Object.values(kacy.taxiwayGraph.nodes).find((n) => n.kind !== 'parking' && n.kind !== 'runway' && Math.hypot(n.pos.x - gate.pos.x, n.pos.y - gate.pos.y) < 60)!;
    blocker.onGround = true;
    blocker.phase = 'TAXIING';
    blocker.pos = { ...near.pos };
    blocker.route = { nodeIds: [near.id, near.id], taxiways: [], stopAtNodeIds: [], progressIndex: 1 };
    blocker.flags.holdingPosition = true;
    let approvedAt: number | undefined;
    h.run(700, () => {
      if (approvedAt === undefined && h.atc('GND').some((e) => /pushback approved/i.test(e.text))) approvedAt = h.now();
    });
    expect(approvedAt).toBeDefined();
    expect(approvedAt!).toBeGreaterThan(DEPARTURE_WAIT_BOUND_SEC - 10);
    expect(approvedAt!).toBeLessThan(DEPARTURE_WAIT_BOUND_SEC + 120);
  });
});

describe('departures keep off the holds arrivals exit through', () => {
  it('KACY runway 22: the exit holds of Bravo are avoided while the end entry has room, and used when it is full', async () => {
    const { busyHoldIds, landingExitHoldIds, planDeparture } = await import('./world');
    const e = createEngine({
      airport, readbackErrorRate: 0,
      scenario: makeScenario({ activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [GA_PARKED('N1A', 'GA-1', 'GND')] }),
    });
    const st = e.getState();
    const dep = find(e, 'N1A');
    expect([...landingExitHoldIds(st)].sort()).toEqual(expect.arrayContaining(['HP4-22-B-1', 'HP4-22-B-2']));
    const free = planDeparture(airport, dep, ['22'], busyHoldIds(st, dep.id))!;
    expect(free.holdId).not.toBe('HP4-22-B-2');
    // the end entry is full (three queued): the Bravo hold is used after all
    const full = new Map(busyHoldIds(st, dep.id));
    full.set(free.holdId, 3);
    const relaxed = planDeparture(airport, dep, ['22'], full)!;
    expect(['HP4-22-B-2', 'HP4-22-B-1']).toContain(relaxed.holdId);
  });

  it('an arrival at the head of an exit stub is not held by the reservation of the next lander (no mutual wait on the stub)', () => {
    const e = createEngine({
      airport, readbackErrorRate: 0,
      scenario: makeScenario({ activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [HOLDING('N2B', 'HP4-22-B-2', '22', 'C172', 'GND'), HOLDING('N3C', 'HP4-22-B-1', '22', 'C172', 'GND')] }),
    });
    const st = e.getState();
    const head = find(e, 'N2B');
    head.isDeparture = false;
    head.phase = 'RUNWAY_EXIT';
    head.pendingRequest = { kind: 'TAXI', text: 'request taxi to parking', sinceSec: 0 };
    // the next lander is rolling to the same hold line
    const next = find(e, 'N3C');
    const g = airport.taxiwayGraph;
    next.isDeparture = false;
    next.phase = 'RUNWAY_EXIT';
    next.pos = { ...g.nodes['R4-22-03'].pos };
    next.route = { nodeIds: ['R4-22-03', 'HP4-22-B-2'], taxiways: ['B'], stopAtNodeIds: ['HP4-22-B-2'], progressIndex: 1 };
    const plan = planParking(st, head)!;
    expect(landerStubs(st).some((s) => s.aircraftId === next.id)).toBe(true);
    // the reservation covers the route of the head aircraft, which stands on the stub: it is not blocked by it
    expect(opposingTraffic(st, plan.nodeIds, head.id)).toBeUndefined();
    // another aircraft routed over the stub is
    expect(opposingTraffic(st, plan.nodeIds, 'someone-else')?.id).toBe(next.id);
  });
});
