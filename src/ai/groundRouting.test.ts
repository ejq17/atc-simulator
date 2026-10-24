/**
 * Ground routing around runways and lanes (new-airport soak findings): a route never re-enters a runway it has left without a hold line, a progressive-taxi step never
 * ends on a runway surface, and a replan around given edges avoids them.
 */
import { describe, expect, it } from 'vitest';
import { loadEgll, loadKbos, loadKpgd, loadKphl } from '../airport';
import { dist, pointInPolygon } from '../sim/geo';
import { createHarness } from './testkit';
import { findTaxiRoute } from '../sim/pathfinding';
import { nextProgressiveSegment, planDeparture, runwayReentry, sharedEdgeIds } from './world';
import type { Aircraft, ScenarioAircraftSpawn } from '../sim/types';

const egll = loadEgll();
const kphl = loadKphl();
const kbos = loadKbos();

const at = (ap: typeof egll, nodeId: string, type: string): Aircraft => ({ pos: ap.taxiwayGraph.nodes[nodeId].pos, headingDeg: 180, type, route: undefined } as unknown as Aircraft);

describe('runway re-entry (EGLL N1 / S1, W-ALT-27R incursion of AAL59 at 1,068 s, BAW504 at 1,042 s)', () => {
  // The route Ground issued: south hold of S1, across 9R/27L at S1, along the N1 link (which leaves the pavement and rejoins it), then S1 south to the other hold.
  const issued = ['HP9R-27L-S1-1', 'T2647', 'T2669', 'R9R-27L-29', 'T2725', 'T2736', 'T2739', 'T2744', 'T2748', 'T2751', 'T2757', 'X627', 'T2766', 'R9R-27L-30', 'T2754', 'X622', 'T2735', 'HP9R-27L-S1-2'];

  it('the route that produced the incursion is recognised as two stretches on the runway with no hold line between', () => {
    expect(runwayReentry(egll, issued)).toBe('9R/27L');
  });

  it('a single crossing (one stretch, hold line before it) is not a re-entry', () => {
    expect(runwayReentry(egll, issued.slice(0, 4))).toBeUndefined();
  });

  it('Ground never plans a departure over the loop: B772 for 27L with the N1 hold taken (it was routed to S1-2 across the runway and back along N1)', () => {
    const busy = new Map([['HP9R-27L-N1-1', 1]]);
    for (const start of ['X597', 'HP9R-27L-S1-1', 'T2635']) {
      const plan = planDeparture(egll, at(egll, start, 'B772'), ['27L'], busy);
      expect(plan, start).toBeTruthy();
      expect(plan!.holdId, start).not.toBe('HP9R-27L-S1-2');
      expect(runwayReentry(egll, plan!.nodeIds), `${start} ${plan!.nodeIds.join('>')}`).toBeUndefined();
    }
  });
});

describe('progressive taxi never ends a step on a runway (KPHL, a departure stood on 9L/27R at the junction of K4 and N for 700 s)', () => {
  it('K4 then N across 9L/27R: the step runs to the far side of the crossing, not to the junction X244 on the runway', () => {
    const g = kphl.taxiwayGraph;
    const r = findTaxiRoute(g, 'T0854', 'X247', { via: ['K4', 'N'], avoidRunways: true, allowedRunwayIds: kphl.runways.map((x) => x.id) });
    expect(r.route?.nodeIds).toContain('X244');
    const seg = nextProgressiveSegment(kphl, r.route!.nodeIds, 0)!;
    expect(seg.endNodeId).not.toBe('X244');
    expect(kphl.runways.some((rw) => pointInPolygon(g.nodes[seg.endNodeId].pos, rw.polygon))).toBe(false);
    expect(r.route!.nodeIds.indexOf(seg.endNodeId)).toBeGreaterThan(r.route!.nodeIds.indexOf('HP9L-27R-N-3') - 1);
    // the step names both taxiways it covers
    expect(seg.taxiways).toEqual(['K4', 'N']);
  });
});

describe('replanning around edges', () => {
  it('planDeparture with avoidEdges never uses them (KBOS ramp lane)', () => {
    const start = at(kbos, 'X057', 'PA28');
    const plan = planDeparture(kbos, start, ['4L']);
    expect(plan).toBeTruthy();
    const avoid = sharedEdgeIds(kbos, plan!.nodeIds, plan!.nodeIds.slice(0, 6));
    expect(avoid.size).toBeGreaterThan(0);
    const alt = planDeparture(kbos, start, ['4L'], new Map(), undefined, avoid);
    if (alt) {
      const edges = new Set<string>();
      for (let i = 1; i < alt.nodeIds.length; i++) {
        const e = kbos.taxiwayGraph.edges.find((x) => (x.from === alt.nodeIds[i - 1] && x.to === alt.nodeIds[i]) || (x.to === alt.nodeIds[i - 1] && x.from === alt.nodeIds[i]));
        if (e) edges.add(e.id);
      }
      for (const id of avoid) expect(edges.has(id), id).toBe(false);
    }
  });
});

describe('head-on on the KBOS ramp lane (soak seed 1, N683JF and N27ZA): turned around once, never sent back along the same lane', () => {
  it('a departure and an arrival meet on the lane; the departure is turned around at most once and both are on their way again', () => {
    const h = createHarness({
      player: ['TWR'], mode: 'free_play', readbackErrorRate: 0, airport: kbos, activeRunways: { departing: ['4L'], landing: ['4R'] },
      pilotBehaviour: { ground: { holdShortOmitFraction: 0, unfamiliarFraction: 0, taxiwayErrorShare: 0 } },
      spawns: [
        { atSec: 0, callsign: 'N683JF', type: 'PA28', flightRules: 'VFR', start: { kind: 'parked', parkingId: 'FBO-3' }, isDeparture: true, initialFrequencyId: 'GND' },
        { atSec: 0, callsign: 'N27ZA', type: 'PA28', flightRules: 'VFR', start: { kind: 'holding_short', nodeId: 'HP4L-22R-F-1', runwayEnd: '4L' }, isDeparture: true, initialFrequencyId: 'GND' },
      ],
    });
    const g = kbos.taxiwayGraph;
    const m = h.find('N683JF')!;
    const o = h.find('N27ZA')!;
    const all = kbos.runways.map((r) => r.id);
    const put = (ac: Aircraft, route: { nodeIds: string[]; taxiways: string[] }, phase: Aircraft['phase']) => {
      const p0 = g.nodes[route.nodeIds[0]].pos;
      const p1 = g.nodes[route.nodeIds[1]].pos;
      ac.pos = { ...p0 };
      ac.headingDeg = (Math.atan2(p1.x - p0.x, p1.y - p0.y) * 180) / Math.PI;
      ac.route = { nodeIds: route.nodeIds, taxiways: route.taxiways, stopAtNodeIds: [], progressIndex: 1 };
      ac.phase = phase;
      ac.pendingRequest = undefined;
      ac.frequencyId = 'GND';
    };
    // the departure leaves the ramp along the lane toward runway 4L; the arrival comes down the same lane toward its ramp stand
    const out = findTaxiRoute(g, 'X057', 'HP4L-22R-F-1', { avoidRunways: true, allowedRunwayIds: all }).route!;
    const back = findTaxiRoute(g, 'T0397', 'PK-GA-1', { avoidRunways: true, allowedRunwayIds: all }).route!;
    o.isDeparture = false;
    put(m, out, 'TAXIING');
    put(o, back, 'TAXI_TO_PARKING');
    let minGap = Infinity;
    h.run(1200, () => { minGap = Math.min(minGap, dist(m.pos, o.pos)); });
    const turns = h.atc('GND').filter((e) => /one eighty/.test(e.text) && /six eight three/i.test(e.text));
    expect(turns.length).toBeLessThanOrEqual(1);
    expect(h.events.filter((e) => e.kind === 'SEPARATION_VIOLATION' || e.kind === 'RUNWAY_INCURSION')).toEqual([]);
    expect(minGap).toBeGreaterThan(20);
    // both got through: the arrival is on its stand, the departure reached the runway hold line (or went on to Tower)
    expect(o.phase).toBe('ARRIVED');
    expect(['HOLDING_SHORT', 'LINE_UP_AND_WAIT', 'CLEARED_FOR_TAKEOFF', 'TAKEOFF_ROLL', 'INITIAL_CLIMB', 'DEPARTURE']).toContain(m.phase);
  });
});

describe('an aircraft at a runway hold line whose request changed to "nose to nose" is still crossed (soak, KPHL seed 1: 2,300 s at the 17/35 hold line)', () => {
  it('KPGD: a departure waiting at the hold line of 15/33 for its crossing, request replaced by a head-on call that no head-on explains', () => {
    const dep = (cs: string, parking: string): ScenarioAircraftSpawn => ({ atSec: 0, callsign: cs, type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: parking }, isDeparture: true, initialFrequencyId: 'GND' });
    const h = createHarness({
      player: ['TWR'], mode: 'free_play', readbackErrorRate: 0, airport: loadKpgd(), activeRunways: { departing: ['22'], landing: ['22'] },
      pilotBehaviour: { ground: { holdShortOmitFraction: 0, unfamiliarFraction: 0, taxiwayErrorShare: 0 } },
      spawns: [dep('N1A', 'GATE-1'), dep('N2B', 'GA-3')],
    });
    const a = h.find('N1A')!;
    // taxi until it stands at the first runway hold line of its route with a crossing to ask for
    expect(h.runUntil(() => a.phase === 'HOLDING_SHORT' && a.groundSpeedKt < 1 && (a.route?.nodeIds.length ?? 0) > 0 && a.route!.stopAtNodeIds.length > 1, 900)).toBe(true);
    // The pilot's request is "taxi instructions" instead of the crossing (kept that way: what the head-on call did in the soak); the crossing is what he needs.
    const before = a.runwayAuthorizations.length;
    const b = h.find('N2B')!;
    const asTaxi = () => { if (a.phase === 'HOLDING_SHORT') a.pendingRequest = { kind: 'TAXI', text: `nose to nose with ${b.callsign}, request instructions`, sinceSec: h.now(), headOnWith: b.id }; };
    asTaxi();
    const crossed = h.runUntil(() => a.runwayAuthorizations.length > before || a.occupyingRunways.length > 0 || a.phase === 'TAXIING', 240, asTaxi);
    expect(crossed).toBe(true);
    expect(h.atc('GND').some((e) => /cross runway/.test(e.text) && /one alpha|N1A|one a/i.test(e.text))).toBe(true);
  });
});
