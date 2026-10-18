/**
 * Pushback on the real KACY and KMHT gates: geometry of every airline / cargo stand, the motion (speed, direction of travel, heading, duration),
 * the pilot's request and the engine-start timing, GA aircraft, the stand lingering after shutdown, and taxi-speed variation.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import { loadKacy, loadKmht } from '../airport';
import { cmd, find, GA_PARKED, makeScenario, REAL_GROUND, run, runUntil, say } from './__fixtures__/testHelpers';
import { bearingDeg, dist, headingDiff, ktToMps, mpsToKt } from './geo';
import { pushbackGeometry, pushbackStand } from './pushback';
import { DEFAULT_PILOT_BEHAVIOUR } from './pilotBehaviour';
import { parkingOccupant } from './parkingResolver';
import type { Airport, ScenarioAircraftSpawn } from './types';

const AIRPORTS: [string, Airport][] = [['KACY', loadKacy()], ['KMHT', loadKmht()]];
const jet = (cs: string, gate: string, over: Partial<ScenarioAircraftSpawn> = {}): ScenarioAircraftSpawn => ({
  atSec: 0, callsign: cs, type: 'A320', flightRules: 'VFR', start: { kind: 'parked', parkingId: gate }, isDeparture: true, initialFrequencyId: 'GND', ...over,
});
const setup = (airport: Airport, spawns: ScenarioAircraftSpawn[], dep = '31', extra: Record<string, unknown> = {}) =>
  createEngine({
    airport, readbackErrorRate: 0,
    scenario: makeScenario({ activeRunways: { departing: [dep], landing: [dep] }, controllerPositions: ['TWR', 'GND'], spawns, pilotBehaviour: { ground: { ...REAL_GROUND, ...extra } } }),
  });

describe('push geometry of every airline and cargo stand (measured on the datasets)', () => {
  for (const [icao, airport] of AIRPORTS) {
    it(`${icao}: the push runs from the stand along its lead-in to the lane, tail away from the nose, and ends along a lane direction`, () => {
      const rows: string[] = [];
      for (const p of airport.parking.filter((x) => x.category === 'airline' || x.category === 'cargo')) {
        const ac = { type: 'A320', pos: p.pos, headingDeg: p.headingDeg ?? 0, seed: 1 } as never;
        const g = pushbackGeometry(airport, p, ac, { departingEnds: ['31', '13', '17', '35'] })!;
        expect(g, p.id).toBeDefined();
        // the lead-in is the push path: its length is the graph connector's, within a metre
        expect(Math.abs(dist(g.from, g.to) - g.lengthM), p.id).toBeLessThan(1);
        expect(g.lengthM, p.id).toBeGreaterThan(5);
        expect(g.lengthM, p.id).toBeLessThan(140);
        // tail points down the lead-in: the push direction is opposite the nose of the stand (dataset stand heading)
        expect(Math.abs(headingDiff(g.pushDirDeg, ((p.headingDeg ?? 0) + 180) % 360)), p.id).toBeLessThan(8);
        // the final nose heading is one of the lane directions at the push point
        expect(g.candidatesDeg).toContain(g.finalHeadingDeg);
        rows.push(`${p.id}:${Math.round(g.lengthM)}m:${Math.round(g.pushDirDeg)}->${Math.round(g.finalHeadingDeg)}`);
      }
      expect(rows.length).toBeGreaterThanOrEqual(10);
    });
  }

  it('a requested tail direction picks the lane that fits it; one the lane cannot give is refused', () => {
    const kmht = loadKmht();
    const e = setup(kmht, [jet('D1', 'GATE-3')], '35');
    const d1 = find(e, 'D1');
    const stand = pushbackStand(kmht, d1)!;
    const east = pushbackGeometry(kmht, stand, d1, { tailDeg: 90 })!;
    const west = pushbackGeometry(kmht, stand, d1, { tailDeg: 270 })!;
    expect(Math.abs(headingDiff((east.finalHeadingDeg + 180) % 360, 90))).toBeLessThan(30);
    expect(Math.abs(headingDiff((west.finalHeadingDeg + 180) % 360, 270))).toBeLessThan(30);
    expect(Math.abs(headingDiff(east.finalHeadingDeg, west.finalHeadingDeg))).toBeGreaterThan(150);
  });
});

describe('pushback motion on the real gates', () => {
  it('KACY gate 2: the aircraft is pushed backwards at walking pace to the lane and ends with its nose along the lane', () => {
    const kacy = loadKacy();
    const e = setup(kacy, [jet('NKS451', 'GATE-2')]);
    const ac = find(e, 'NKS451');
    const stand = kacy.parking.find((p) => p.id === 'GATE-2')!;
    expect(runUntil(e, () => ac.pendingRequest?.kind === 'PUSHBACK', 30)).toBe(true);
    expect(e.getState().events.find((x) => x.speaker === 'PILOT')?.text).toMatch(/^Atlantic City Ground, Spirit four fifty one, at Gate two, request pushback, VFR to .*with information alpha\.$/);
    // taxi before the push is refused: the pilot needs the pushback first
    expect(say(e, cmd('TAXI', 'NKS451', { destination: 'RWY31', runwayEnd: '31', route: ['L', 'P', 'B'] }), 'GND').status).toBe('rejected');

    // the lane at gate 2 only runs east-west: tail south is refused with the direction the lane allows
    const no = say(e, cmd('PUSHBACK', 'NKS451', { pushTailDeg: 180 }), 'GND');
    expect(no.status).toBe('rejected');
    expect(no.status === 'rejected' ? no.pilotResponse : '').toMatch(/we can only push tail east from here/);
    const out = say(e, cmd('PUSHBACK', 'NKS451', { pushTailDeg: 90 }), 'GND');
    expect(out.status).toBe('accepted');
    expect(out.status === 'accepted' ? out.readback : '').toMatch(/^Pushing back, tail east, Spirit four fifty one$/);
    expect(ac.phase).toBe('PUSHBACK');
    const noseAtStart = ac.headingDeg;
    const t0 = e.getState().clock.timeSec;
    let maxMps = 0;
    let backwards = 0;
    let moving = 0;
    let prev = { ...ac.pos };
    for (let i = 0; i < 4000 && !e.getState().events.some((x) => /pushed back \d+ m/.test(x.text)); i++) {
      e.step();
      const step = dist(prev, ac.pos);
      if (step > 1e-6) {
        moving++;
        // moved opposite to where the nose pointed at the start of the step (heading changes slowly)
        if (Math.abs(headingDiff(bearingDeg(prev, ac.pos), (ac.headingDeg + 180) % 360)) < 100) backwards++;
        maxMps = Math.max(maxMps, step / e.getState().clock.dtSec);
      }
      prev = { ...ac.pos };
    }
    const pushedLen = dist(stand.pos, ac.pos);
    // speed: never above the design value, and the push really ran at about that speed
    expect(maxMps).toBeLessThanOrEqual(DEFAULT_PILOT_BEHAVIOUR.ground.pushbackSpeedMps + 0.05);
    expect(maxMps).toBeGreaterThan(0.9 * DEFAULT_PILOT_BEHAVIOUR.ground.pushbackSpeedMps);
    expect(mpsToKt(maxMps)).toBeLessThan(3); // walking pace
    // direction of travel is backwards the whole way (the nose never points where it moves)
    expect(backwards / moving).toBeGreaterThan(0.95);
    // distance and duration: gate 2 lead-in is 55 m, at 1.2 m/s with a start delay and ramp
    expect(pushedLen).toBeGreaterThan(50);
    expect(pushedLen).toBeLessThan(60);
    const dur = e.getState().events.find((x) => /pushed back/.test(x.text))!.timeSec - t0;
    expect(dur).toBeGreaterThan(pushedLen / 1.2); // start delay + ramps
    expect(dur).toBeLessThan(pushedLen / 1.2 + 25);
    // the nose swung onto the lane: the final heading is a lane direction, the tail points roughly south
    expect(Math.abs(headingDiff(ac.headingDeg, noseAtStart))).toBeGreaterThan(20);
    expect(ac.phase).toBe('PUSHBACK');
    expect(ac.groundSpeedKt).toBe(0);
    expect(dist(ac.pos, kacy.taxiwayGraph.nodes[nodeNear(kacy, ac.pos)].pos)).toBeLessThan(0.5);
  });

  it('the tug waits while another aircraft stands at the push point, and the push completes once it is gone', () => {
    const kmht = loadKmht();
    const e = setup(kmht, [jet('D1', 'GATE-3')], '35');
    const d1 = find(e, 'D1');
    runUntil(e, () => d1.pendingRequest?.kind === 'PUSHBACK', 30);
    say(e, cmd('PUSHBACK', 'D1', {}), 'GND');
    const stand = kmht.parking.find((p) => p.id === 'GATE-3')!;
    const pushPoint = kmht.taxiwayGraph.nodes[nodeNear(kmht, { x: stand.pos.x + 0, y: stand.pos.y })];
    const lead = Object.values(kmht.taxiwayGraph.edges).find((x) => x.from === stand.nodeId || x.to === stand.nodeId)!;
    const n1 = kmht.taxiwayGraph.nodes[lead.from === stand.nodeId ? lead.to : lead.from];
    expect(pushPoint).toBeTruthy();
    const blocker = e.spawnAircraft({ atSec: 0, callsign: 'B2', type: 'A320', flightRules: 'VFR', start: { kind: 'parked', parkingId: 'GATE-8' }, isDeparture: true, initialFrequencyId: 'GND' });
    blocker.phase = 'TAXIING';
    blocker.pos = { x: n1.pos.x, y: n1.pos.y };
    blocker.groundSpeedKt = 0;
    blocker.route = { nodeIds: [n1.id], taxiways: [], stopAtNodeIds: [], progressIndex: 1 };
    run(e, 120);
    expect(dist(d1.pos, stand.pos)).toBeLessThan(lead.lengthM - 10); // held back, not through the blocker
    expect(d1.phase).toBe('PUSHBACK');
    e.removeAircraft(blocker.id);
    expect(runUntil(e, () => dist(d1.pos, n1.pos) < 0.5, 200)).toBe(true);
  });

  it('GA aircraft do not push back: they start and call ready on their own, a pushback instruction is refused', () => {
    const kacy = loadKacy();
    const e = setup(kacy, [GA_PARKED('N723EJ', 'GA-1', 'GND')]);
    const ac = find(e, 'N723EJ');
    const out = say(e, cmd('PUSHBACK', 'N723EJ'), 'GND');
    expect(out.status).toBe('rejected');
    expect(out.status === 'rejected' ? out.pilotResponse : '').toMatch(/taxi on our own power/);
    expect(runUntil(e, () => ac.phase === 'READY', 90)).toBe(true);
    expect(e.getState().events.some((x) => /request pushback/.test(x.text))).toBe(false);
  });
});

function nodeNear(airport: Airport, pos: { x: number; y: number }): string {
  let best = '';
  let bd = Infinity;
  for (const n of Object.values(airport.taxiwayGraph.nodes)) {
    const d = dist(n.pos, pos);
    if (d < bd) { bd = d; best = n.id; }
  }
  return best;
}

describe('engine start and ready timing (design values in pilotBehaviour.ground)', () => {
  it('a GA pilot calls ready between the first-call time + gaStartSec[0] and + gaStartSec[1]; the interval varies by aircraft', () => {
    const kacy = loadKacy();
    const spawns = ['N1AA', 'N2BB', 'N3CC', 'N4DD'].map((cs, i) => GA_PARKED(cs, `GA-${i + 1}`, 'GND', { type: 'C172' }));
    const e = setup(kacy, spawns);
    const t: Record<string, number> = {};
    for (let i = 0; i < 3000; i++) {
      e.step();
      for (const a of Object.values(e.getState().aircraft)) if (a.phase === 'READY' && t[a.callsign] === undefined) t[a.callsign] = e.getState().clock.timeSec;
    }
    const [lo, hi] = DEFAULT_PILOT_BEHAVIOUR.ground.gaStartSec;
    const times = Object.values(t);
    expect(times).toHaveLength(4);
    for (const x of times) {
      expect(x).toBeGreaterThanOrEqual(3 + lo - 0.2); // first call time is 3-8 s after the spawn
      expect(x).toBeLessThanOrEqual(8 + hi + 0.5);
    }
    expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(1);
  });

  it('an airliner calls ready airlinerReadyAfterPushSec after the push, with the ATIS code and its location', () => {
    const kacy = loadKacy();
    const e = setup(kacy, [jet('NKS451', 'GATE-2')]);
    const ac = find(e, 'NKS451');
    runUntil(e, () => ac.pendingRequest?.kind === 'PUSHBACK', 30);
    say(e, cmd('PUSHBACK', 'NKS451'), 'GND');
    expect(runUntil(e, () => /pushed back/.test(e.getState().events.at(-1)?.text ?? '') || e.getState().events.some((x) => /pushed back \d+ m/.test(x.text)), 300)).toBe(true);
    const done = e.getState().events.find((x) => /pushed back \d+ m/.test(x.text))!.timeSec;
    expect(runUntil(e, () => ac.phase === 'READY', 120)).toBe(true);
    const ready = e.getState().clock.timeSec;
    const g = DEFAULT_PILOT_BEHAVIOUR.ground;
    expect(ready - done).toBeGreaterThanOrEqual(g.pushSettleSec + g.airlinerReadyAfterPushSec[0] - 0.2);
    expect(ready - done).toBeLessThanOrEqual(g.pushSettleSec + g.airlinerReadyAfterPushSec[1] + 0.5);
    const call = e.getState().events.filter((x) => x.speaker === 'PILOT').at(-1)!.text;
    expect(call).toBe('Atlantic City Ground, Spirit four fifty one, pushed back from Gate two, ready to taxi, VFR to ' + call.split('VFR to ')[1]);
    expect(call).toMatch(/with information alpha\.$/);
    expect(ac.pendingRequest?.kind).toBe('TAXI');
    // and taxis from the lane: the route starts at the push point, not at the stand
    expect(say(e, cmd('TAXI', 'NKS451', { destination: 'RWY31', runwayEnd: '31', route: ['L', 'P', 'B'] }), 'GND').status).toBe('accepted');
    expect(ac.route!.nodeIds[0]).toBe(nodeNear(kacy, ac.pos));
  });

  it('an unapproved pushback request is repeated', () => {
    const e = setup(loadKacy(), [jet('NKS451', 'GATE-2')]);
    run(e, 130);
    const asks = e.getState().events.filter((x) => x.speaker === 'PILOT' && /pushback/.test(x.text));
    expect(asks.length).toBeGreaterThanOrEqual(2);
    expect(asks[1].text).toMatch(/still requesting pushback/);
  });
});

describe('shutdown and the stand', () => {
  it('an arrival stays visible and keeps its stand for arrivedLingerSec after shutdown', () => {
    const kacy = loadKacy();
    const e = setup(kacy, [GA_PARKED('N1AA', 'GA-1', 'GND', { isDeparture: false })]);
    const ac = find(e, 'N1AA');
    const stand = kacy.parking.find((p) => p.id === 'GA-1')!;
    ac.phase = 'ARRIVED';
    run(e, 60);
    expect(Object.values(e.getState().aircraft).some((a) => a.callsign === 'N1AA')).toBe(true);
    expect(parkingOccupant(e.getState(), stand)?.callsign).toBe('N1AA');
    expect(runUntil(e, () => !Object.values(e.getState().aircraft).some((a) => a.callsign === 'N1AA'), DEFAULT_PILOT_BEHAVIOUR.ground.arrivedLingerSec)).toBe(true);
    expect(parkingOccupant(e.getState(), stand)).toBeUndefined();
  });
});

describe('taxi speed variation and corners', () => {
  it('each aircraft cruises at its own seeded speed between taxiSpeedMinFactor and 1 times the type speed', () => {
    const kacy = loadKacy();
    const spawns = ['N1AA', 'N2BB', 'N3CC'].map((cs, i) => GA_PARKED(cs, `GA-${i + 1}`, 'GND', { type: 'C172' }));
    const e = setup(kacy, spawns);
    run(e, 40);
    const peaks: Record<string, number> = {};
    for (const a of Object.values(e.getState().aircraft)) {
      expect(say(e, cmd('TAXI', a.callsign, { destination: 'RWY31', runwayEnd: '31', route: ['B'] }), 'GND').status, a.callsign).not.toBe('clarify');
    }
    for (let i = 0; i < 2400; i++) {
      e.step();
      for (const a of Object.values(e.getState().aircraft)) peaks[a.callsign] = Math.max(peaks[a.callsign] ?? 0, a.groundSpeedKt);
    }
    const min = DEFAULT_PILOT_BEHAVIOUR.ground.taxiSpeedMinFactor;
    const vals = Object.values(peaks);
    for (const v of vals) {
      expect(v).toBeLessThanOrEqual(15.01);
      expect(v).toBeGreaterThan(15 * min * 0.6); // moved (apron lanes are capped at 13 kt)
    }
    expect(new Set(vals.map((v) => Math.round(v * 10))).size).toBeGreaterThan(1);
  });

  it('corner speed falls smoothly with the turn angle: full speed to 15 deg, the turn speed from 90 deg', async () => {
    const { cornerSpeedMps } = await import('./groundMovement');
    const full = ktToMps(20);
    const turn = ktToMps(10);
    expect(cornerSpeedMps(10, full, turn)).toBe(full);
    expect(cornerSpeedMps(90, full, turn)).toBeCloseTo(turn, 9);
    expect(cornerSpeedMps(120, full, turn)).toBeCloseTo(turn, 9);
    let last = full;
    for (let a = 15; a <= 90; a += 1) {
      const v = cornerSpeedMps(a, full, turn);
      expect(v).toBeLessThanOrEqual(last + 1e-9);
      expect(last - v).toBeLessThan(0.1); // no steps
      last = v;
    }
  });
});
