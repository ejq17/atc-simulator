/**
 * AI side of the throughput round (docs/PROGRESS.md "Throughput"). Each block is one finding of the 2 h free-play soak (`freePlaySoak.test.ts`, FREEPLAY_SOAK=1):
 *
 *  - the takeoff gap: the release rule is the one of 7110.65 3-9-5 / 3-10-3 (+ the engine's near-miss alert), not a flat 2.4 nm at lift-off
 *  - a departure with something in the way before the hold stays with Ground, which can taxi it aside (no handoff to a Tower that cannot)
 *  - the crossing window, the lane checks, the pushback checks, the approach height
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from '../sim/engine';
import { ARRIVING, GA_PARKED, HOLDING, cmd, find, makeScenario } from '../sim/__fixtures__/testHelpers';
import { loadKacy } from '../airport';
import { findRunwayEnd } from '../sim/runways';
import { findTaxiRoute } from '../sim/pathfinding';
import { KT_TO_MPS, nmToM } from '../sim/geo';
import { getPerformance } from '../sim/performance';
import { departureTimes, divergingDeparture, neededEtaSec, releaseSlackSec } from './tower';
import { CROSSING_ARRIVAL_SEC, runwayInUse } from './ground';
import { blockedBeforeHold, opposingTraffic, pushbackBlockedBy } from './world';
import { crossingWaiting } from './tower';
import { tooHighForFaf } from './approach';
import { pushbackGeometry } from '../sim/pushback';
import { landerStubOnRoute, landerStubs } from '../sim/exitStubs';
import type { AgentView } from './core';
import type { Aircraft } from '../sim/types';

const kacy = loadKacy();
const g22 = findRunwayEnd(kacy, '22')!;

const eng = (spawns: ReturnType<typeof HOLDING>[], rwy = '22') =>
  createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: [rwy], landing: [rwy] }, spawns }) });
/** A bare agent view over an engine state (what the pure functions read). */
const view = (e: ReturnType<typeof eng>): AgentView => ({ airport: kacy, state: e.getState(), now: e.getState().clock.timeSec } as unknown as AgentView);

describe('the takeoff gap (releaseSlackSec, neededEtaSec)', () => {
  const dep = (type: string) => ({ type, id: 'd', callsign: 'D1' } as unknown as Aircraft);

  it('a C172 behind a C172 on final needs the 3-9-6 / 3-10-3 distance (3,000 ft) and the alert distance, and far less than the old flat 2.4 nm at lift-off', () => {
    const kt = 70;
    const need = neededEtaSec(dep('C172'), true, 'C172', kt);
    const old = departureTimes(dep('C172'), true).liftoff + ((2.4 / kt) * 3600);
    expect(need).toBeLessThan(old - 25);
    // at least the time to be airborne and 3,000 ft down the runway, plus the go-around allowance (1 nm at 70 kt)
    const perf = getPerformance('C172');
    const roll = 0.5 * perf.accelKtPerSec * KT_TO_MPS * (perf.rotateSpeedKt / perf.accelKtPerSec) ** 2;
    const srs = departureTimes(dep('C172'), true).liftoff + (914 - roll) / (perf.climbSpeedKt * KT_TO_MPS) + (nmToM(1) / (kt * KT_TO_MPS));
    expect(need).toBeGreaterThanOrEqual(srs - 1);
  });

  it('keeps the engine alert (1.5 nm / 500 ft) at lift-off and at touchdown: the projected gap never drops below it', () => {
    for (const [dt, at, kt] of [['C172', 'C172', 70], ['C172', 'A320', 130], ['A320', 'C172', 70], ['A320', 'A320', 140]] as const) {
      const d = dep(dt);
      const eta = neededEtaSec(d, false, at, kt);
      const perf = getPerformance(dt);
      const tL = departureTimes(d, false).liftoff;
      const roll = 0.5 * perf.accelKtPerSec * KT_TO_MPS * (perf.rotateSpeedKt / perf.accelKtPerSec) ** 2;
      const vA = kt * KT_TO_MPS;
      const vD = perf.climbSpeedKt * KT_TO_MPS;
      // arrival position along the runway axis (m, negative = short of the threshold) and the departure's, at lift-off and 8 s after the arrival crosses the threshold
      const gapLiftoff = roll - vA * (tL - eta);
      const gapTouchdown = roll + vD * (eta + 8 - tL) - vA * 8;
      expect(gapLiftoff, `${dt} behind ${at}: gap at lift-off`).toBeGreaterThanOrEqual(nmToM(1.5) - 1);
      expect(gapTouchdown, `${dt} behind ${at}: gap at touchdown`).toBeGreaterThanOrEqual(nmToM(1.5) - 1);
    }
  });

  it('slack is the ETA minus the need: an arrival 4 nm out leaves room for a C172, one 1.5 nm out does not', () => {
    const e = eng([HOLDING('D1', 'HP4-22-A-2', '22', 'C172', 'TWR'), ARRIVING('A1', '22', 4, 'C172', 'TWR')]);
    const v = view(e);
    const d = find(e, 'D1');
    expect(releaseSlackSec(v, g22, d, false)).toBeGreaterThan(0);
    const a = find(e, 'A1');
    a.pos = { x: g22.end.threshold.x - g22.dir.x * nmToM(1.5), y: g22.end.threshold.y - g22.dir.y * nmToM(1.5) };
    expect(releaseSlackSec(v, g22, d, false)).toBeLessThan(0);
  });

  it('a departure that would overtake a slower one gets a heading 30 degrees to the right of the runway heading (rounded to ten)', () => {
    const h = divergingDeparture(kacy, g22);
    expect(h.turn).toBe('right');
    const rwyMag = ((g22.headingDeg - kacy.magneticVariationDeg) % 360 + 360) % 360;
    const diff = ((h.headingMag - rwyMag + 540) % 360) - 180;
    expect(diff).toBeGreaterThanOrEqual(25);
    expect(diff).toBeLessThanOrEqual(35);
    expect(h.headingMag % 10).toBe(0);
  });
});

describe('Ground hands a departure to Tower only with the way to the hold clear (blockedBeforeHold)', () => {
  /** A C172 taxiing to the Bravo hold line of 22 (HP4-22-B-2) with 30 m to go, and a lander stopped at that hold line waiting for taxi instructions. */
  function stubJam() {
    const e = eng([GA_PARKED('DEP1', 'GA-1', 'GND'), HOLDING('LAND1', 'HP4-22-B-2', '22', 'C172', 'GND')]);
    const g = kacy.taxiwayGraph;
    const dep = find(e, 'DEP1');
    const lander = find(e, 'LAND1');
    const r = findTaxiRoute(g, kacy.parking.find((p) => p.id === 'GA-1')!.nodeId, 'HP4-22-B-2', { avoidRunways: true, allowedRunwayIds: kacy.runways.map((x) => x.id) }).route!;
    const k = r.nodeIds.length - 2;
    dep.onGround = true;
    dep.phase = 'TAXIING';
    dep.pos = { ...g.nodes[r.nodeIds[k]].pos };
    const a = g.nodes[r.nodeIds[k]].pos;
    const b = g.nodes[r.nodeIds[k + 1]].pos;
    dep.headingDeg = ((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI + 360) % 360;
    dep.groundSpeedKt = 0;
    dep.route = { nodeIds: r.nodeIds, taxiways: [], stopAtNodeIds: [r.nodeIds.at(-1)!], progressIndex: k + 1 };
    lander.isDeparture = false;
    lander.phase = 'RUNWAY_EXIT';
    lander.pos = { ...g.nodes['HP4-22-B-2'].pos };
    lander.groundSpeedKt = 0;
    lander.headingDeg = 118;
    lander.route = { nodeIds: ['R4-22-03', 'HP4-22-B-2'], taxiways: [], stopAtNodeIds: [], progressIndex: 2 };
    lander.pendingRequest = { kind: 'TAXI', text: 'request taxi to parking', sinceSec: 0 };
    return { e, dep, lander };
  }

  it('an arrival waiting on the route ahead of it blocks the handoff (Tower could not move the departure; Ground can)', () => {
    const { e, dep, lander } = stubJam();
    expect(blockedBeforeHold(e.getState(), dep)?.id).toBe(lander.id);
  });

  it('with the stub empty, or the aircraft ahead a departure queued in the same direction, nothing blocks it', () => {
    const { e, dep, lander } = stubJam();
    lander.onGround = false; // gone
    lander.phase = 'FINAL';
    lander.pos = { x: 1e5, y: 1e5 };
    expect(blockedBeforeHold(e.getState(), dep)).toBeUndefined();
    // a departure standing at the hold line, facing the way this one goes
    lander.onGround = true;
    lander.isDeparture = true;
    lander.phase = 'HOLDING_SHORT';
    lander.pos = { ...kacy.taxiwayGraph.nodes['HP4-22-B-2'].pos };
    lander.headingDeg = dep.headingDeg;
    expect(blockedBeforeHold(e.getState(), dep)).toBeUndefined();
  });
});

describe('the crossing window (runwayInUse)', () => {
  it('an arrival cleared to land but four minutes out does not hold a crossing; inside the window it does', () => {
    const e = eng([ARRIVING('A1', '22', 5, 'C172', 'TWR'), GA_PARKED('X1', 'GA-1', 'GND')]);
    e.applyCommand(cmd('LAND', 'A1', { runwayEnd: '22' }));
    const v = view(e);
    expect(CROSSING_ARRIVAL_SEC).toBe(60);
    expect(runwayInUse(v, '13/31', 'x')).toBe(false);
    expect(runwayInUse(v, '4/22', 'x')).toBe(false);
    const a = find(e, 'A1');
    a.pos = { x: g22.end.threshold.x - g22.dir.x * nmToM(0.8), y: g22.end.threshold.y - g22.dir.y * nmToM(0.8) };
    a.phase = 'FINAL';
    expect(runwayInUse(v, '13/31', 'x')).toBe(true);
  });

  it('operations on the intersecting runway are the engine\'s to judge by time, not a flat "runway in use"; on the crossed runway itself they are', () => {
    const e = eng([HOLDING('D1', 'HP4-22-A-2', '22', 'C172', 'TWR')]);
    const st = e.getState();
    const d = find(e, 'D1');
    st.runwayOccupancy['4/22'] = { runwayId: '4/22', occupants: [], departingId: d.id, crossingIds: [], holdingShortIds: [] };
    expect(runwayInUse(view(e), '13/31', 'x')).toBe(false);
    expect(runwayInUse(view(e), '4/22', 'x')).toBe(true);
  });

  it('an aircraft waiting at the 13/31 hold line counts for the landing clearances on 4/22 (crossingWaiting)', () => {
    const e = eng([GA_PARKED('W1', 'GA-1', 'GND')]);
    const w = find(e, 'W1');
    w.onGround = true;
    w.phase = 'HOLDING_SHORT';
    w.groundSpeedKt = 0;
    w.pos = { ...kacy.taxiwayGraph.nodes['HP13-31-A-1'].pos };
    w.pendingRequest = { kind: 'CROSSING', text: 'holding short of runway 13/31, request crossing', sinceSec: -100 };
    const v = view(e);
    v.state.clock.timeSec = 100;
    (v as { now: number }).now = 100;
    expect(crossingWaiting(v, g22, 'someone-else')?.id).toBe(w.id);
  });
});

describe('lane checks (opposingTraffic)', () => {
  /** Two taxi routes over the same lane: `lane` is the route of the aircraft asking, `slice` the part of it another aircraft traverses the other way. */
  function lanes() {
    const e = eng([GA_PARKED('ASK', 'GA-1', 'GND'), GA_PARKED('O1', 'GA-2', 'GND'), GA_PARKED('O2', 'GA-3', 'GND')]);
    const g = kacy.taxiwayGraph;
    const route = findTaxiRoute(g, kacy.parking.find((p) => p.id === 'GA-1')!.nodeId, 'HP4-22-A-2', { avoidRunways: true, allowedRunwayIds: kacy.runways.map((x) => x.id) }).route!;
    const back = (from: number, to: number) => route.nodeIds.slice(from, to + 1).reverse();
    const put = (cs: string, ids: string[], moving: boolean) => {
      const ac = find(e, cs);
      ac.onGround = true;
      ac.isDeparture = false;
      ac.phase = 'TAXI_TO_PARKING';
      ac.pos = { ...g.nodes[ids[0]].pos };
      ac.groundSpeedKt = moving ? 13 : 0;
      ac.route = { nodeIds: ids, taxiways: [], stopAtNodeIds: [], progressIndex: 1 };
      return ac;
    };
    return { e, route, back, put };
  }

  it('one aircraft whose window does not overlap does not hide the next one in the list that does (the early return)', () => {
    const { e, route, back, put } = lanes();
    const n = route.nodeIds.length;
    // O1 is about to leave the far end of the route; O2 is at the start of it, coming toward the asking aircraft
    put('O1', back(n - 6, n - 2), true);
    const o2 = put('O2', back(2, 8), true);
    expect(opposingTraffic(e.getState(), route.nodeIds, find(e, 'ASK').id)?.id).toBe(o2.id);
  });

  it('a lander stub that is more than 300 m along the route is not reserved against it', () => {
    const e = eng([ARRIVING('L1', '22', 1.5, 'C172', 'TWR'), GA_PARKED('ASK', 'GA-1', 'GND')]);
    const st = e.getState();
    const g = kacy.taxiwayGraph;
    const stubs = landerStubs(st);
    expect(stubs.length).toBe(1);
    const ids = stubs[0].nodeIds;
    expect(landerStubOnRoute(st, ids, 'ASK')?.aircraftId).toBe(stubs[0].aircraftId);
    // a route that comes to the stub after 600 m of other taxiway
    const far = findTaxiRoute(g, kacy.parking.find((p) => p.id === 'GA-1')!.nodeId, ids.at(-1)!, { avoidRunways: true, allowedRunwayIds: kacy.runways.map((x) => x.id) }).route!;
    expect(far.lengthM).toBeGreaterThan(600);
    expect(landerStubOnRoute(st, far.nodeIds, 'ASK')).toBeUndefined();
  });
});

describe('pushback', () => {
  it('Ground does not approve a push whose path an aircraft stands on, nor one that ends where another push ends', () => {
    const e = eng([GA_PARKED('P1', 'GA-1', 'GND'), GA_PARKED('P2', 'GA-2', 'GND')]);
    const st = e.getState();
    const p1 = find(e, 'P1');
    const p2 = find(e, 'P2');
    const from = { ...p1.pos };
    const to = { x: from.x + 30, y: from.y };
    expect(pushbackBlockedBy(st, p1, from, to)).toBeUndefined();
    p2.onGround = true;
    p2.phase = 'READY';
    p2.pos = { x: from.x + 20, y: from.y + 3 };
    p2.route = undefined;
    expect(pushbackBlockedBy(st, p1, from, to)?.id).toBe(p2.id);
    // P2 is being pushed from its own stand: the push of P1 that ends within half the two lengths + 8 m of where P2's ends waits
    const stand2 = kacy.parking.find((x) => x.id === 'GA-2')!;
    const dest2 = pushbackGeometry(kacy, stand2, p2, { departingEnds: ['22'] })!.to;
    p2.phase = 'PUSHBACK';
    p2.pos = { x: stand2.pos.x + 12 * Math.sign(dest2.x - stand2.pos.x || 1), y: stand2.pos.y + 12 * Math.sign(dest2.y - stand2.pos.y || 1) }; // (a few metres into the push)
    expect(pushbackBlockedBy(st, p1, from, { x: dest2.x + 5, y: dest2.y })?.id).toBe(p2.id);
    expect(pushbackBlockedBy(st, p1, from, { x: dest2.x + 400, y: dest2.y })).toBeUndefined();
  });
});

describe('approach clearance height (tooHighForFaf)', () => {
  it('an airliner 2,600 ft above the final approach fix altitude and at the fix is too high (the soak\'s 6.9 km float); the same aircraft 5 nm out is not, nor one 600 ft high', () => {
    expect(tooHighForFaf(2600, 0.3)).toBe(true);
    expect(tooHighForFaf(2600, 5)).toBe(false); // 450 ft per nm x 5 + 1,000
    expect(tooHighForFaf(600, 0)).toBe(false);
    expect(tooHighForFaf(1100, 0)).toBe(true);
    expect(tooHighForFaf(-500, 3)).toBe(false);
  });
});
