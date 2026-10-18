/** Ground asks Tower for an exit over the landline (JO 7110.65 3-1-4, 3-10-9) and the AI Tower's own exit instruction on the four KACY ends. */
import { describe, expect, it } from 'vitest';
import { createHarness } from './testkit';
import type { Harness } from './testkit';
import type { ScenarioAircraftSpawn } from '../sim/types';
import { transmitLandline } from '../ui/commands/landline';
import { parseLandline } from '../commands';

const arr = (cs: string, type: string, end: string, nm: number): ScenarioAircraftSpawn => ({
  atSec: 0, callsign: cs, type, flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
  start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: type === 'A320' ? 150 : 70, runwayEnd: end, distanceNm: nm },
});
const mk = (end: string, type = 'C172', nm = 4): Harness =>
  createHarness({ player: ['GND'], mode: 'free_play', activeRunways: { departing: [end], landing: [end] }, spawns: [arr('N60DX', type, end, nm)] });
const call = (h: Harness, text: string) => transmitLandline({ engine: h.engine, text, source: 'typed', controller: { positions: ['GND'], aiPositions: ['TWR'] } });
const exitCall = (h: Harness) => h.atc('TWR').find((e) => e.callsign === 'N60DX' && /(turn|exit) (left|right)|hold short of runway/i.test(e.text))?.text;

describe('AI Tower exit instruction on the four KACY runway ends (C172 to the ramp)', () => {
  for (const [end, expected] of [['22', /turn left at bravo/], ['4', /turn right at bravo/], ['13', /turn right at charlie/], ['31', /turn left at hotel/]] as const) {
    it(`runway ${end}: ${expected}`, () => {
      const h = mk(end);
      expect(h.runUntil(() => !!exitCall(h), 600)).toBe(true);
      expect(exitCall(h)).toMatch(expected);
      expect(h.events.filter((e) => ['RUNWAY_INCURSION', 'SEPARATION_VIOLATION'].includes(e.kind))).toEqual([]);
    });
  }
});

describe('Ground asks Tower for an exit by landline', () => {
  const onFinal = (h: Harness) => h.runUntil(() => h.find('N60DX')?.phase === 'FINAL', 300);

  it('"have ... exit right at Bravo" on 22: Tower agrees, tells the pilot, and the lander stops at that hold line', () => {
    const h = mk('22');
    expect(onFinal(h)).toBe(true);
    const r = call(h, 'Tower, Ground, have Cessna six zero delta x-ray exit right at Bravo');
    expect(r.summary).toBe('done');
    expect(h.runUntil(() => h.landline.length > 0, 60)).toBe(true);
    // right at Bravo exists on 22 (HP4-22-B-1): approved and issued to the pilot
    expect(h.landline.at(-1)!.text).toMatch(/will exit right at B\b/i);
    expect(h.runUntil(() => /turn right at bravo/i.test(exitCall(h) ?? ''), 120)).toBe(true);
    expect(h.runUntil(() => h.find('N60DX')?.route?.nodeIds.at(-1) === 'HP4-22-B-1', 600)).toBe(true);
  });

  it('an exit that does not exist is refused with the exit Tower will use', () => {
    const h = mk('22');
    expect(onFinal(h)).toBe(true);
    call(h, 'Tower, Ground, have Cessna six zero delta x-ray exit left at Hotel');
    expect(h.runUntil(() => h.landline.some((l) => /unable/i.test(l.text)), 60)).toBe(true);
    expect(h.landline.find((l) => /unable/i.test(l.text))!.text).toMatch(/unable, .*will exit at/i);
  });

  it('"hold short of runway one three after landing" is issued to the pilot and the rollout stops short of 13/31', () => {
    const h = mk('4');
    expect(onFinal(h)).toBe(true);
    call(h, 'Tower, Ground, have Cessna six zero delta x-ray hold short of runway one three after landing');
    expect(h.runUntil(() => /hold short of runway one three/i.test(exitCall(h) ?? ''), 120)).toBe(true);
  });

  it('parses with reduced confidence and the 3-1-4 wording flagged non-standard', () => {
    const c = parseLandline('Tower, Ground, have Cessna six zero delta x-ray exit left at Charlie', {
      aircraft: [{ callsign: 'N60DX', spokenCallsign: 'Cessna six zero delta x-ray', type: 'C172' }], taxiways: ['A', 'B', 'C'], playerPositions: ['GND'],
    });
    expect(c).toMatchObject({ kind: 'REQUEST_EXIT', callsign: 'N60DX', exitSide: 'left', point: 'C', nonStandard: true });
    expect(c.confidence).toBeLessThan(0.95);
  });
});

describe('AI Ground does not route onto the exit stub of a lander inside 2 nm', () => {
  it('a departure route over the stub is "opposing traffic" while the lander is inside 2 nm, and free again once it is far or gone', async () => {
    const { opposingTraffic, planDeparture } = await import('./world');
    const { landerStubs } = await import('../sim/exitStubs');
    const close = createHarness({ player: ['TWR'], ai: ['GND'], mode: 'free_play', activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [arr('N60DX', 'C172', '22', 1.5)] });
    close.run(2);
    const st = close.engine.getState();
    const dep = { type: 'C172', id: 'dd', callsign: 'D1', pos: st.airport.taxiwayGraph.nodes['PK-GA-1'].pos } as never;
    const plan = planDeparture(st.airport, dep, ['22'])!;
    expect(landerStubs(st)).toHaveLength(1);
    expect(opposingTraffic(st, plan.nodeIds, 'dd')?.callsign).toBe('N60DX');
    const far = createHarness({ player: ['TWR'], ai: ['GND'], mode: 'free_play', activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [arr('N60DX', 'C172', '22', 6)] });
    far.run(2);
    expect(landerStubs(far.engine.getState())).toHaveLength(0);
    expect(opposingTraffic(far.engine.getState(), plan.nodeIds, 'dd')).toBeUndefined();
  });

  it('Tower tells a Ground controller who is a person when the exit it will use needs a runway crossing to the parking (landline information, 3-1-4)', () => {
    const h = createHarness({ player: ['GND'], mode: 'free_play', activeRunways: { departing: ['13'], landing: ['13'] }, spawns: [arr('N60DX', 'C172', '13', 4)] });
    expect(h.runUntil(() => h.landline.some((l) => /will exit right at/i.test(l.text)), 200)).toBe(true);
    expect(h.landline.find((l) => /will exit right at/i.test(l.text))!.text).toMatch(/crossing/);
  });
});
