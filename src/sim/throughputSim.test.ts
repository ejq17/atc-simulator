/**
 * Engine side of the throughput round (docs/PROGRESS.md "Throughput"): each test is one deadlock or one wrong constraint the 2 h free-play soak found.
 *
 *  - a departure that overtakes a slower one is cleared with a diverging departure heading (JO 7110.65 5-8-2 / 5-8-3) instead of waiting for it
 *  - a departing aircraft is never a "preceding arrival" (a taxi-back aircraft keeps its old landing clearance)
 *  - an aircraft far from every node on a long taxiway edge can be routed again
 *  - the pilot of a turned-around aircraft asks for new instructions whether or not it called the head-on
 *  - the taxi-back request is not replaced by "taxi to parking"
 *  - an exit that leads into a lane used by departures in the opposite direction counts as blocked
 *  - taxi spacing: nothing is kept to an aircraft standing beyond the stand, and nobody waits for an aircraft that is stopped behind it
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import { loadKacy } from '../airport';
import { ARRIVING, GA_PARKED, HOLDING, cmd, find, makeScenario, run, say } from './__fixtures__/testHelpers';
import { alongCross, findRunwayEnd } from './runways';
import { assessClearanceSafety, departureTrailConflict, precedingArrivalBlockers } from './conflicts';
import { edgeAheadNode } from './pathfinding';
import { magneticToTrue } from './geo';
import { arrivalParkingTargets, exitBlockage, holdToParking } from './exitChoice';
import { findLeader } from './groundMovement';
import { findHeadOnIn } from './headOn';
import type { Aircraft } from './types';

const kacy = loadKacy();
const g22 = findRunwayEnd(kacy, '22')!;

function world(spawns: ReturnType<typeof HOLDING>[], rwy = '22') {
  return createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: [rwy], landing: [rwy] }, spawns }) });
}

describe('takeoff behind a slower departure (5-8-3)', () => {
  /** A C172 climbing out on the runway track 3.6 nm out, an A320 at the hold line of the full-length entry. */
  function leaderAhead() {
    const e = world([HOLDING('LEAD', 'HP4-22-A-2', '22', 'C172', 'DEP'), HOLDING('FOL', 'HP4-22-A-2', '22', 'A320', 'TWR')]);
    const lead = find(e, 'LEAD');
    const along = 3.6 * 1852;
    lead.onGround = false;
    lead.phase = 'DEPARTURE';
    lead.isDeparture = true;
    lead.altitudeFt = 1500;
    lead.groundSpeedKt = 70;
    lead.trackDeg = g22.headingDeg;
    lead.headingDeg = g22.headingDeg;
    lead.pos = { x: g22.end.threshold.x + g22.dir.x * along, y: g22.end.threshold.y + g22.dir.y * along };
    lead.occupyingRunways = [];
    return { e, lead, fol: find(e, 'FOL') };
  }

  it('without a heading the follower would close inside 3 nm: unsafe, with the trail conflict named', () => {
    const { e, fol } = leaderAhead();
    const take = cmd('TAKEOFF', 'FOL', { runwayEnd: '22', runwayId: '4/22' });
    const trail = departureTrailConflict(e.getState(), fol, g22);
    expect(trail?.leader.callsign).toBe('LEAD');
    expect(assessClearanceSafety(e.getState(), take).issues.some((i) => /behind slower LEAD/.test(i.text))).toBe(true);
  });

  it('a departure heading 15 degrees or more off the runway heading removes the conflict; 10 degrees does not', () => {
    const { e, fol } = leaderAhead();
    const st = e.getState();
    const rwyMag = ((g22.headingDeg - kacy.magneticVariationDeg) + 360) % 360;
    const mag = (d: number) => Math.round((rwyMag + d + 360) % 360) || 360;
    const take = (d: number) => cmd('TAKEOFF', 'FOL', { runwayEnd: '22', runwayId: '4/22', departureHeading: mag(d), turnDirection: 'right' });
    expect(assessClearanceSafety(st, take(30)).issues.some((i) => /behind slower/.test(i.text))).toBe(false);
    expect(assessClearanceSafety(st, take(20)).issues.some((i) => /behind slower/.test(i.text))).toBe(false);
    expect(assessClearanceSafety(st, take(10)).issues.some((i) => /behind slower/.test(i.text))).toBe(true);
    expect(departureTrailConflict(st, fol, g22, magneticToTrue(mag(30), kacy.magneticVariationDeg))).toBeUndefined();
  });
});

describe('a departure is not an arrival', () => {
  it('an aircraft that landed, taxied back and took off again (old landing clearance still active) does not block the arrival behind it', () => {
    const e = world([ARRIVING('FOLLOW', '22', 2, 'C172', 'TWR'), ARRIVING('GHOST', '22', 6, 'C172', 'TWR')]);
    e.applyCommand(cmd('LAND', 'GHOST', { runwayEnd: '22' }));
    const st = e.getState();
    const follow = find(e, 'FOLLOW');
    const ghost = find(e, 'GHOST');
    // the second aircraft is on the extended centreline AHEAD of the follower along the runway (past the threshold), climbing out
    ghost.pos = { x: g22.end.threshold.x + g22.dir.x * 2500, y: g22.end.threshold.y + g22.dir.y * 2500 };
    ghost.altitudeFt = 900;
    ghost.groundSpeedKt = 65;
    ghost.trackDeg = g22.headingDeg;
    ghost.headingDeg = g22.headingDeg;
    ghost.phase = 'FINAL';
    expect(precedingArrivalBlockers(st, follow, g22).some((b) => b.other.id === ghost.id)).toBe(true);
    ghost.isDeparture = true;
    ghost.phase = 'DEPARTURE';
    expect(precedingArrivalBlockers(st, follow, g22).some((b) => b.other.id === ghost.id)).toBe(false);
  });
});

describe('an aircraft on a long taxiway edge can be routed again', () => {
  it('edgeAheadNode: the end of the edge the nose points to, and nothing for a point off every edge', () => {
    const g = kacy.taxiwayGraph;
    // KACY taxiway A has a 621 m edge (T0224 -> X072); the middle of it is 300 m from either end
    const e = g.edges.find((x) => x.lengthM > 500 && !x.taxiway.toUpperCase().startsWith('RWY'))!;
    const a = g.nodes[e.from];
    const b = g.nodes[e.to];
    const mid = { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 };
    const toB = (Math.atan2(b.pos.x - a.pos.x, b.pos.y - a.pos.y) * 180) / Math.PI;
    expect(edgeAheadNode(g, mid, toB)?.id).toBe(b.id);
    expect(edgeAheadNode(g, mid, toB + 180)?.id).toBe(a.id);
    expect(edgeAheadNode(g, { x: 1e6, y: 1e6 }, 0)).toBeUndefined();
  });

  it('a taxi instruction from the middle of such an edge is accepted (it used to fail: no node within 150 m)', () => {
    const e = createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [GA_PARKED('T1', 'GA-1', 'GND')] }) });
    const ac = find(e, 'T1');
    const g = kacy.taxiwayGraph;
    const edge = g.edges.find((x) => x.lengthM > 500 && !x.taxiway.toUpperCase().startsWith('RWY'))!;
    const a = g.nodes[edge.from];
    const b = g.nodes[edge.to];
    ac.pos = { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 };
    ac.headingDeg = ((Math.atan2(b.pos.x - a.pos.x, b.pos.y - a.pos.y) * 180) / Math.PI + 360) % 360;
    ac.phase = 'TAXIING';
    ac.route = undefined;
    ac.groundSpeedKt = 0;
    expect(say(e, cmd('TAXI', 'T1', { destination: 'RWY22', runwayEnd: '22' }), 'GND').status).toBe('accepted');
    expect(ac.route).toBeDefined();
    expect(ac.route!.nodeIds[0]).toBe(b.id);
  });
});

describe('a turned-around aircraft asks for new instructions', () => {
  it('also when it was not the one that called the head-on (AI Ground turns the departure, the arrival called)', () => {
    const e = createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [GA_PARKED('T1', 'GA-1', 'GND')] }) });
    const ac = find(e, 'T1');
    say(e, cmd('TAXI', 'T1', { destination: 'RWY22', runwayEnd: '22' }), 'GND');
    run(e, 12);
    expect(ac.groundSpeedKt).toBeGreaterThan(1);
    expect(ac.pendingRequest).toBeUndefined();
    expect(say(e, cmd('TURN_AROUND', 'T1'), 'GND').status).toBe('accepted');
    run(e, 40);
    expect(ac.groundSpeedKt).toBe(0);
    expect(ac.pendingRequest).toMatchObject({ kind: 'TAXI', resume: true });
  });
});

describe('taxi back for another departure', () => {
  it('"clear of the runway, request taxi to parking" does not replace the taxi-back request', () => {
    const e = createEngine({
      airport: kacy, readbackErrorRate: 0,
      scenario: makeScenario({ activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [HOLDING('TB1', 'HP4-22-B-2', '22', 'C172', 'GND')] }),
    });
    const ac = find(e, 'TB1');
    ac.isDeparture = true;
    ac.phase = 'RUNWAY_EXIT';
    ac.route = undefined;
    ac.groundSpeedKt = 0;
    ac.pendingRequest = { kind: 'TAXI', request: 'TAXI_BACK', runwayEnd: '22', text: 'request taxi back to runway 22 for departure', sinceSec: 0 };
    run(e, 3);
    expect(ac.pendingRequest?.request).toBe('TAXI_BACK');
  });
});

describe('an exit that leads into a lane used by departures the other way is blocked', () => {
  it('a departure queued on the lane beyond the 400 m stub, routed toward the runway, blocks the lander at the hold line', () => {
    const e = world([HOLDING('D1', 'HP4-22-A-2', '22', 'C172', 'GND'), ARRIVING('X1', '22', 3, 'C172', 'TWR')]);
    const st = e.getState();
    const lander = find(e, 'X1');
    const way = holdToParking(st, 'HP4-22-B-2', arrivalParkingTargets(st, lander));
    expect(exitBlockage(st, lander.id, way.nodeIds)).toBeUndefined();
    // the departure stands on the lane 700 m from the hold line (well beyond the stub), its route runs back along the lander's way, toward the runway
    const d = find(e, 'D1');
    const idx = way.nodeIds.findIndex((_id, i) => i > 0 && way.nodeIds.slice(0, i + 1).reduce((s, id, k, a) => (k ? s + Math.hypot(kacy.taxiwayGraph.nodes[id].pos.x - kacy.taxiwayGraph.nodes[a[k - 1]].pos.x, kacy.taxiwayGraph.nodes[id].pos.y - kacy.taxiwayGraph.nodes[a[k - 1]].pos.y) : s), 0) > 700);
    // (its route stops one node short of the hold line: a departure routed TO the hold line is the other, older rule)
    const back = way.nodeIds.slice(1, idx + 1).reverse();
    d.onGround = true;
    d.phase = 'TAXIING';
    d.pos = { ...kacy.taxiwayGraph.nodes[back[0]].pos };
    d.groundSpeedKt = 0;
    d.route = { nodeIds: back, taxiways: [], stopAtNodeIds: [], progressIndex: 1 };
    expect(exitBlockage(st, lander.id, way.nodeIds)).toMatchObject({ callsign: 'D1', why: 'opposing' });
    // an arrival taxiing in the same direction as the lander's way is no reason
    d.isDeparture = false;
    d.phase = 'TAXI_TO_PARKING';
    d.route = { nodeIds: way.nodeIds.slice(0, idx + 1), taxiways: [], stopAtNodeIds: [], progressIndex: 1 };
    expect(exitBlockage(st, lander.id, way.nodeIds)).toBeUndefined();
  });
});

describe('taxi spacing and head-on at a stand', () => {
  /** An arrival on its way into GA-1 with another aircraft standing on the lead-in, 13 m before the stand (the soak: both stopped for an hour). */
  function standLeadIn() {
    const e = createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [ARRIVING('IN1', '22', 5, 'C172', 'GND'), GA_PARKED('OUT1', 'GA-8', 'GND')] }) });
    const st = e.getState();
    const g = kacy.taxiwayGraph;
    const stand = kacy.parking.find((p) => p.id === 'GA-1')!;
    const standNode = g.nodes[stand.nodeId];
    const lane = g.edges.find((x) => (x.from === stand.nodeId || x.to === stand.nodeId))!;
    const laneEnd = g.nodes[lane.from === stand.nodeId ? lane.to : lane.from];
    const toStand = (Math.atan2(standNode.pos.x - laneEnd.pos.x, standNode.pos.y - laneEnd.pos.y) * 180) / Math.PI;
    const dir = { x: Math.sin((toStand * Math.PI) / 180), y: Math.cos((toStand * Math.PI) / 180) };
    const inbound = find(e, 'IN1');
    const blocker = find(e, 'OUT1');
    const at = (back: number) => ({ x: standNode.pos.x - dir.x * back, y: standNode.pos.y - dir.y * back });
    inbound.onGround = true;
    inbound.phase = 'TAXI_TO_PARKING';
    inbound.pos = at(45);
    inbound.headingDeg = (toStand + 360) % 360;
    inbound.groundSpeedKt = 0;
    inbound.route = { nodeIds: [laneEnd.id, stand.nodeId], taxiways: [], stopAtNodeIds: [], progressIndex: 1 };
    blocker.onGround = true;
    blocker.phase = 'TAXIING';
    blocker.pos = at(13);
    blocker.headingDeg = (toStand + 360) % 360;
    blocker.groundSpeedKt = 0;
    blocker.route = { nodeIds: [stand.nodeId, laneEnd.id], taxiways: [], stopAtNodeIds: [], progressIndex: 0 };
    return { e, st, inbound, blocker, at };
  }

  it('an aircraft standing beyond the stand it taxis into is not a leader; one in front of the stand is', () => {
    const { st, inbound, blocker, at } = standLeadIn();
    const ctx = { state: st } as never;
    blocker.pos = at(-30); // 30 m beyond the stand
    expect(findLeader(ctx, inbound)).toBeUndefined();
    blocker.pos = at(13); // between the aircraft and its stand
    expect(findLeader(ctx, inbound)).toBeDefined();
  });

  it('the stopped aircraft on the lead-in does not wait for the arrival that is stopped behind it', () => {
    const { st, inbound, blocker } = standLeadIn();
    const ho = findHeadOnIn(st, blocker);
    expect(ho?.role).not.toBe('wait');
    // (the arrival, which is the one held up, is not asked to wait either: it is not "ahead" of anybody)
    expect(findHeadOnIn(st, inbound)?.role).not.toBe('wait');
  });
});

describe('what the soak harness measures', () => {
  it('KACY runway 22: B-2 is the midfield exit used by the parking-side rule (unchanged by the lane check while the lane is empty)', () => {
    const e = world([ARRIVING('X1', '22', 3, 'C172', 'TWR')]);
    const st = e.getState();
    const lander = find(e, 'X1') as Aircraft;
    const way = holdToParking(st, 'HP4-22-B-2', arrivalParkingTargets(st, lander));
    expect(exitBlockage(st, lander.id, way.nodeIds)).toBeUndefined();
    expect(alongCross(g22, kacy.taxiwayGraph.nodes['HP4-22-B-2'].pos).along).toBeGreaterThan(400);
  });
});
