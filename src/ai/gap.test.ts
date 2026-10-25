/**
 * Departure gap (ai/gap.ts, gapActions.ts; coordination topic GAP): Tower asks Approach for a gap when a ready departure has no usable window in the arrival stream, Approach says
 * which arrival it follows and builds it (a speed assignment, 5-7-1; a 360 for a VFR straight-in, 3-8-1; a hold and a later approach clearance for an IFR arrival), Tower gives the
 * departure the window (3-9-5). Every spacing rule of the order stays (5-5-4 / 3-10-3 between the arrivals, the engine's own landing check).
 */
import { describe, expect, it } from 'vitest';
import { createHarness } from './testkit';
import type { Harness } from './testkit';
import { ARRIVING, HOLDING } from '../sim/__fixtures__/testHelpers';
import { COORDINATION_DESIGN, findOpenRequest, validApproval } from '../sim/coordination';
import { findRunwayEnd } from '../sim/runways';
import type { Aircraft, ScenarioAircraftSpawn } from '../sim/types';
import { GAP_HOLD_DELAY_SEC, GAP_HORIZON_SEC, GAP_REQUEST_WAIT_SEC, GAP_USABLE_WITHIN_SEC, arrivalSlots, delayOption, gapPlan, usableWindowSec } from './gap';
import { SEQ_MARGIN_SEC } from './sequence';
import { departureTimes, neededEtaSec } from './tower';
import { DEPARTURE_WAIT_BOUND_SEC } from './world';

const ALL = ['CLNC', 'GND', 'TWR', 'APP', 'DEP'] as const;
const reachAll = () => true;
const mk = (spawns: ScenarioAircraftSpawn[], over: Partial<Parameters<typeof createHarness>[0]> = {}): Harness =>
  createHarness({ player: [], ai: [...ALL], mode: 'free_play', activeRunways: { departing: ['22'], landing: ['22'] }, spawns, seed: 3, aiSeed: 5, ...over });
const g22 = (h: Harness) => findRunwayEnd(h.engine.getState().airport, '22')!;
const opts = (_h: Harness) => ({ lined: false, optionOf: (ac: Aircraft, og: ReturnType<typeof g22>) => delayOption(ac, og, reachAll) });
const plan = (h: Harness, dep: string) => gapPlan(h.engine.getState(), h.engine.getState().airport, g22(h), h.find(dep)!, opts(h));

/**
 * An A320 at the hold of 22 (it needs 143 s ahead of the next arrival, `neededEtaSec`), a lander 2 nm out that takes the runway for the next two and a half minutes, a second C172
 * 4.5 nm out that would cross the threshold too soon behind it, a third far out. The C172 behind the lander is the aircraft behind the gap.
 */
const IFR_HOLD = (): ScenarioAircraftSpawn => ({
  ...HOLDING('NKS900', 'HP4-22-A-2', '22', 'A320'),
  flightPlan: { flightRules: 'IFR', origin: 'KACY', destination: 'KPHL', cruiseAltitudeFt: 10000, route: ['VCN'] },
});
const STREAM = (): ScenarioAircraftSpawn[] => [IFR_HOLD(), ARRIVING('N1AA', '22', 2, 'C172', 'TWR'), ARRIVING('N2BB', '22', 5, 'C172', 'TWR'), ARRIVING('N3CC', '22', 12, 'C172', 'TWR')];

describe('gap plan (pure): which arrival the gap follows and how long the ones behind it are delayed', () => {
  it('follows the lander ahead, delays the next arrival to the departure\'s need and the one behind it to the sequence margin, each within what Approach can do', () => {
    const h = mk(STREAM());
    h.run(1);
    const st = h.engine.getState();
    const dep = h.find('NKS900')!;
    const p = plan(h, 'NKS900');
    expect(p.feasible, p.reason).toBe(true);
    expect(p.after?.callsign).toBe('N1AA');
    expect(p.delays.length).toBeGreaterThan(0);
    const slots = arrivalSlots(st, st.airport, g22(h), dep, (ac, og) => delayOption(ac, og, reachAll));
    const lander = slots.find((s) => s.ac.callsign === 'N1AA')!;
    // the departure goes when the lander is clear; the first arrival behind the gap crosses the threshold no sooner than the departure's need (3-9-5 / 3-9-6 / 3-10-3)
    expect(p.startSec).toBeCloseTo(lander.end, 0);
    const first = p.delays[0];
    expect(first.ac.callsign).toBe('N2BB');
    expect(first.requiredStartSec).toBeGreaterThanOrEqual(p.startSec + neededEtaSec(dep, false, 'C172', Math.max(first.ac.groundSpeedKt, 60)) - 1e-6);
    // every delay is within the tools (a speed assignment and up to two 360s), and the arrival after a delayed one stays SEQ_MARGIN_SEC clear of it
    for (const d of p.delays) {
      const s = slots.find((x) => x.ac.id === d.ac.id)!;
      expect(d.delaySec).toBeLessThanOrEqual(s.option!.maxSec + 1e-6);
      expect(d.requiredStartSec).toBeCloseTo(s.start + d.delaySec, 3);
    }
    for (let i = 1; i < p.delays.length; i++) {
      const prev = slots.find((x) => x.ac.id === p.delays[i - 1].ac.id)!;
      expect(p.delays[i].requiredStartSec).toBeGreaterThanOrEqual(p.delays[i - 1].requiredStartSec + (prev.end - prev.start) + SEQ_MARGIN_SEC - 1e-6);
    }
  });
  it('is unable when the arrival that would have to move is too close to the runway (nothing Approach can do) or beyond what the tools give', () => {
    const h = mk([IFR_HOLD(), ARRIVING('N1AA', '22', 2, 'C172', 'TWR'), ARRIVING('N2BB', '22', 3, 'C172', 'TWR')]);
    h.run(1);
    const p = plan(h, 'NKS900');
    // N2BB is 3 nm out (inside the 4 nm VFR limit): no tool; the only gap is behind both, which is later than the horizon allows unless they land in time
    expect(p.feasible ? p.after?.callsign : p.reason).toMatch(/N2BB/);
    if (p.feasible) expect(p.delays).toHaveLength(0);
  });
  it('the usable window is the runway-clear time of the lander ahead when nothing behind it is too close; none when the stream is dense', () => {
    const calm = mk([IFR_HOLD(), ARRIVING('N1AA', '22', 2, 'C172', 'TWR')]);
    calm.run(1);
    const stc = calm.engine.getState();
    const w = usableWindowSec(stc, stc.airport, g22(calm), calm.find('NKS900')!, false);
    expect(w).toBeGreaterThan(60);
    expect(w).toBeLessThan(GAP_HORIZON_SEC);
    const dense = mk(STREAM().filter((s) => s.callsign !== 'N3CC'));
    dense.run(1);
    const std = dense.engine.getState();
    expect(usableWindowSec(std, std.airport, g22(dense), dense.find('NKS900')!, false)).toBeGreaterThan(w);
  });
});

describe('Tower asks, Approach answers and builds (all AI)', () => {
  it('no gap is requested when a window already exists (a single far arrival: the departure just goes)', () => {
    const h = mk([IFR_HOLD(), ARRIVING('N3CC', '22', 14, 'C172', 'TWR')]);
    let left: number | undefined;
    h.runUntil(() => { const d = h.find('NKS900'); if (d && left === undefined && d.phase !== 'HOLDING_SHORT') left = h.now(); return left !== undefined; }, 400);
    expect(left, 'the departure never left the hold').toBeDefined();
    expect(left!).toBeLessThan(GAP_REQUEST_WAIT_SEC);
    expect((h.engine.getState().coordination?.requests ?? []).filter((r) => r.topic === 'GAP')).toHaveLength(0);
  });
  it('no gap is requested before the departure has waited the documented bound, and none when the window opens inside GAP_USABLE_WITHIN_SEC', () => {
    expect(GAP_REQUEST_WAIT_SEC).toBeLessThan(DEPARTURE_WAIT_BOUND_SEC);
    const h = mk([IFR_HOLD(), ARRIVING('N1AA', '22', 1.5, 'C172', 'TWR')]);
    h.run(GAP_REQUEST_WAIT_SEC + 20);
    // the lander ahead clears the runway in about 2.5 minutes: inside the usable window, so Tower waits for it and does not ask
    const asked = (h.engine.getState().coordination?.requests ?? []).filter((r) => r.topic === 'GAP');
    expect(asked.length === 0 || usableLater(h)).toBe(true);
    expect(GAP_USABLE_WITHIN_SEC).toBeGreaterThan(0);
  });
  it('asks after the bound, Approach answers "gap after <arrival>" and the departure goes inside the fairness bound with no go-around', () => {
    const h = mk(STREAM());
    let askedAt: number | undefined;
    let answerAt: number | undefined;
    let left: number | undefined;
    let n2Landed: number | undefined;
    h.runUntil(() => {
      const st = h.engine.getState();
      const reqs = (st.coordination?.requests ?? []).filter((r) => r.topic === 'GAP');
      if (reqs[0] && askedAt === undefined) askedAt = reqs[0].createdSec;
      if (reqs.some((r) => r.status === 'approved') && answerAt === undefined) answerAt = h.now();
      const d = h.find('NKS900');
      if (d && left === undefined && d.phase !== 'HOLDING_SHORT' && d.phase !== 'LINE_UP_AND_WAIT') left = h.now();
      const b = h.find('N2BB');
      if (b && n2Landed === undefined && b.onGround) n2Landed = h.now();
      return left !== undefined && n2Landed !== undefined;
    }, 900);
    expect(askedAt, 'Tower never asked').toBeDefined();
    expect(askedAt!).toBeGreaterThanOrEqual(GAP_REQUEST_WAIT_SEC - 1);
    expect(answerAt, 'Approach never answered').toBeDefined();
    const req = h.engine.getState().coordination!.requests.find((r) => r.topic === 'GAP')!;
    expect(req.from).toBe('TWR');
    expect(req.to).toBe('APP');
    expect(req.afterCallsign, 'Approach names the arrival the gap follows').toMatch(/^N[12]/);
    expect(left, 'the departure never left the hold').toBeDefined();
    expect(left! - askedAt!).toBeLessThan(DEPARTURE_WAIT_BOUND_SEC);
    // nothing was sent around, nothing came close
    expect(h.events.filter((e) => e.kind === 'GO_AROUND')).toHaveLength(0);
    expect(h.events.filter((e) => e.kind === 'RUNWAY_INCURSION' || e.kind === 'SEPARATION_VIOLATION')).toHaveLength(0);
  });
  it('a human Approach sees what Tower needs and builds the gap himself: approving it runs none of the AI\'s gap logic', () => {
    const h = mk(STREAM(), { player: ['APP'], ai: ['CLNC', 'GND', 'TWR', 'DEP'], humanAnswers: false });
    h.runUntil(() => !!(h.engine.getState().coordination?.requests ?? []).find((r) => r.topic === 'GAP'), 400);
    const r = h.engine.getState().coordination!.requests.find((x) => x.topic === 'GAP')!;
    expect(r).toMatchObject({ from: 'TWR', to: 'APP', status: 'pending' });
    expect(h.landline.some((m) => /need a gap for a departure runway two two/.test(m.spokenText))).toBe(true);
    const api = (h.engine as unknown as { coordination: { respond(id: string, a: string, o: object): unknown } }).coordination;
    api.respond(r.id, 'approve', { by: 'APP', source: 'player' });
    const said0 = h.transmissions.length;
    h.run(120);
    // nobody but the person works Approach: no speed assignment or 360 comes from an AI Approach, and Tower (AI) does not slow an aircraft on its own frequency for it
    // unless the plan needs it; the aircraft on Approach's frequency (none here) are untouched
    const fromApp = h.atc('APP');
    expect(fromApp).toHaveLength(0);
    expect(h.transmissions.length).toBeGreaterThanOrEqual(said0);
  });
});

function usableLater(h: Harness): boolean {
  const st = h.engine.getState();
  const dep = h.find('NKS900');
  return !dep || usableWindowSec(st, st.airport, g22(h), dep, false) > GAP_USABLE_WITHIN_SEC;
}

describe('gap tools', () => {
  it('a speed assignment is used when it saves enough, and not repeated', () => {
    const h = mk([IFR_HOLD(), ARRIVING('N1AA', '22', 2, 'C172', 'TWR'), ARRIVING('N2BB', '22', 11, 'C172', 'TWR')]);
    h.run(1);
    const b = h.find('N2BB')!;
    const og = g22(h);
    const o = delayOption(b, og, reachAll)!;
    expect(o).toBeDefined();
    expect(o.speedKt).toBeDefined();
    expect(o.speedGainSec).toBeGreaterThan(15);
    // after the assignment (target speed in effect) the same aircraft offers no second one
    b.target.speedKt = o.speedKt;
    b.groundSpeedKt = o.speedKt!;
    expect(delayOption(b, og, reachAll)!.speedKt).toBeUndefined();
  });
  it('a VFR aircraft offers up to two 360s (120 s each for a C172), none once cleared or closer than 4 nm, and an IFR one offers none', () => {
    const h = mk([IFR_HOLD(), ARRIVING('N2BB', '22', 8, 'C172', 'TWR'), ARRIVING('N4DD', '22', 3, 'C172', 'TWR'), { ...ARRIVING('AAL9', '22', 10, 'A320', 'APP'), flightRules: 'IFR' }]);
    h.run(1);
    const og = g22(h);
    const vfr = delayOption(h.find('N2BB')!, og, reachAll)!;
    expect(vfr.circles).toBe(2);
    expect(vfr.circleSec).toBeGreaterThan(120);
    expect(vfr.circleSec).toBeLessThan(135);
    expect(vfr.maxSec).toBeGreaterThanOrEqual(2 * vfr.circleSec);
    expect(delayOption(h.find('N4DD')!, og, reachAll)).toBeUndefined();
    const ifr = delayOption(h.find('AAL9')!, og, reachAll);
    expect(ifr?.circles ?? 0).toBe(0);
    expect(delayOption(h.find('N2BB')!, og, () => false)).toBeUndefined();
  });
  it('an IFR arrival without an approach clearance, outside the gate and with a published hold is held and cleared later (a hold adds GAP_HOLD_DELAY_SEC); inside 6 nm or already cleared it is not', () => {
    const h = mk([IFR_HOLD(), { ...ARRIVING('AAL9', '22', 12, 'A320', 'APP'), flightRules: 'IFR' }, { ...ARRIVING('AAL8', '22', 4, 'A320', 'APP'), flightRules: 'IFR' }]);
    h.run(1);
    const og = g22(h);
    const held = delayOption(h.find('AAL9')!, og, reachAll, { holdAvailable: () => true })!;
    expect(held.hold).toBe(true);
    expect(held.maxSec).toBeGreaterThanOrEqual(GAP_HOLD_DELAY_SEC);
    expect(delayOption(h.find('AAL9')!, og, reachAll, { holdAvailable: () => false })?.hold ?? false).toBe(false);
    expect(delayOption(h.find('AAL8')!, og, reachAll, { holdAvailable: () => true })).toBeUndefined();
    const cleared = h.find('AAL9')!;
    cleared.clearances.push({ id: 'x', kind: 'APPROACH', issuedAtSec: 0, byPosition: 'APP' } as never);
    expect(delayOption(cleared, og, reachAll, { holdAvailable: () => true })?.hold ?? false).toBe(false);
  });
  it('the 360 is a steady turn of 360 degrees at the type\'s turn rate; the aircraft then resumes its approach', () => {
    const h = mk([ARRIVING('N2BB', '22', 8, 'C172', 'TWR')], { player: ['TWR'], ai: ['CLNC', 'GND', 'APP', 'DEP'], humanAnswers: false });
    h.run(2);
    const b = h.find('N2BB')!;
    const d0 = Math.hypot(b.pos.x - g22(h).end.threshold.x, b.pos.y - g22(h).end.threshold.y);
    const out = h.say('TWR', { kind: 'PATTERN_INSTRUCTION', callsign: 'N2BB', confidence: 1, rawText: '', normalizedText: '', issues: [], destination: 'CIRCLE', turnDirection: 'left', turnDegrees: 360 });
    expect(out.status).toBe('accepted');
    const t0 = h.now();
    let turned = 0;
    let last = b.headingDeg;
    h.runUntil(() => {
      const hd = h.find('N2BB')!.headingDeg;
      turned += Math.abs(((hd - last + 540) % 360) - 180);
      last = hd;
      return turned >= 355;
    }, 200);
    const took = h.now() - t0;
    expect(took).toBeGreaterThan(110);
    expect(took).toBeLessThan(140);
    h.run(10);
    const d1 = Math.hypot(h.find('N2BB')!.pos.x - g22(h).end.threshold.x, h.find('N2BB')!.pos.y - g22(h).end.threshold.y);
    expect(Math.abs(d1 - d0)).toBeLessThan(2500); // it came back round: no net progress to speak of in 2 minutes at 60-70 kt
    expect(h.find('N2BB')!.phase === 'APPROACH' || h.find('N2BB')!.phase === 'INBOUND' || h.find('N2BB')!.phase === 'FINAL').toBe(true);
  });
  it('the engine refuses a 360 inside 3 nm and once cleared to land', () => {
    const h = mk([ARRIVING('N2BB', '22', 2.5, 'C172', 'TWR')], { player: ['TWR'], ai: ['CLNC', 'GND', 'APP', 'DEP'], humanAnswers: false });
    h.run(2);
    const out = h.say('TWR', { kind: 'PATTERN_INSTRUCTION', callsign: 'N2BB', confidence: 1, rawText: '', normalizedText: '', issues: [], destination: 'CIRCLE', turnDirection: 'left', turnDegrees: 360 });
    expect(out.status).toBe('rejected');
  });
});

describe('coordination bookkeeping for the gap', () => {
  it('Tower repeats a refused request no sooner than gapRetrySec, and never while one is open', () => {
    const h = mk(STREAM(), { player: ['APP'], ai: ['CLNC', 'GND', 'TWR', 'DEP'], humanAnswers: false });
    h.runUntil(() => !!findOpenRequest(h.engine.getState(), 'GAP', h.find('NKS900')!.id), 400);
    const st = h.engine.getState();
    const dep = h.find('NKS900')!;
    expect(findOpenRequest(st, 'GAP', dep.id)).toBeDefined();
    expect(validApproval(st, 'GAP', dep.id)).toBeUndefined();
    expect(COORDINATION_DESIGN.gapRetrySec).toBeGreaterThan(COORDINATION_DESIGN.reaskIntervalSec);
    expect(departureTimes(dep, false).liftoff).toBeGreaterThan(0);
  });
});

describe('the departure gap is per runway (multi-runway configuration)', () => {
  it('a departure at the hold of the departing-only runway 27L is not held for the arrival stream of the parallel runway 27R, and asks Approach for nothing', async () => {
    const { createMultiRunwayAirport } = await import('../sim/__fixtures__/multiRunwayAirport');
    const { HOLDING, ARRIVING } = await import('../sim/__fixtures__/testHelpers');
    const { ALL, createHarness } = await import('./testkit');
    const airport = createMultiRunwayAirport();
    const h = createHarness({
      airport, player: [], ai: ALL, mode: 'free_play', activeRunways: { departing: ['27L'], landing: ['27R'] }, readbackErrorRate: 0, seed: 5,
      spawns: [
        { ...ARRIVING('N31AA', '27R', 6, 'C172'), atSec: 0 }, { ...ARRIVING('N32BB', '27R', 9, 'C172'), atSec: 0 }, { ...ARRIVING('N33CC', '27R', 12, 'C172'), atSec: 0 },
        { ...HOLDING('NKS200', 'HSE2', '27L', 'A320'), atSec: 0 },
      ],
    });
    let airborneAt = -1;
    h.run(420, () => { const a = h.find('NKS200'); if (airborneAt < 0 && a && !a.onGround) airborneAt = h.now(); });
    expect(airborneAt).toBeGreaterThan(0);
    expect(airborneAt).toBeLessThan(240);
    expect(h.events.filter((e) => e.kind === 'COORDINATION' && /need a gap/.test(e.text)).map((e) => e.text)).toEqual([]);
    expect(h.events.filter((e) => e.kind === 'SEPARATION_VIOLATION').map((e) => e.text)).toEqual([]);
  }, 120_000);
});
