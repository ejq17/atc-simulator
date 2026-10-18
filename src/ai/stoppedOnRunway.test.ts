/** AI Tower and an aircraft stopped on the runway ("stopped on runway four, unable to exit, request taxi instructions"). */
import { describe, expect, it } from 'vitest';
import { createHarness, cmd } from './testkit';
import type { Harness } from './testkit';
import type { SimulationEngineExtras } from '../sim/engineExtras';
import type { ScenarioAircraftSpawn } from '../sim/types';

const arr = (cs: string, type: string): ScenarioAircraftSpawn => ({
  atSec: 0, callsign: cs, type, flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
  start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 70, runwayEnd: '4', distanceNm: 3 },
});
const dep = (cs: string): ScenarioAircraftSpawn => ({
  atSec: 0, callsign: cs, type: 'C172', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'TWR',
  start: { kind: 'holding_short', nodeId: 'HP4-22-A-1', runwayEnd: '4' },
});

/**
 * The landing roll ends with no exit it can make and the aircraft stops on the runway and asks for taxi instructions.
 * C172: taxiway B (the only exit before the intersection) is closed and the clearance says "hold short of runway 13", so it stops short of the
 * intersection. F-16 flight of two: B and A are closed (NOTAM), it rolls through the intersection and stops beyond it; A is reopened after the call.
 */
function setup(type: string, extra: ScenarioAircraftSpawn[] = []): { h: Harness; reopen: () => void } {
  const h = createHarness({ player: ['GND'], mode: 'free_play', activeRunways: { departing: ['4'], landing: ['4'] }, spawns: [arr('X1', type), ...extra] });
  const x = h.engine as unknown as SimulationEngineExtras;
  const closeB = x.addClosure!({ kind: 'TAXIWAY', ident: 'B' }, 'scenario');
  const closeA = type === 'F16' ? x.addClosure!({ kind: 'TAXIWAY', ident: 'A' }, 'scenario') : undefined;
  h.run(1);
  void closeB;
  if (type === 'F16') h.find('X1')!.formation = { size: 2 };
  const land = type === 'F16' ? cmd('LAND', 'X1', { runwayEnd: '4' }) : cmd('LAND', 'X1', { runwayEnd: '4', holdShort: ['RWY13'] });
  expect(h.say('TWR', land).status).toBe('accepted');
  return { h, reopen: () => { if (closeA?.ok) x.removeClosure!(closeA.closure.id); } };
}

describe('AI Tower answers an aircraft stopped on the runway', () => {
  for (const type of ['F16', 'C172']) {
    it(`${type}: the stop is reported, then Tower sends it to taxiway A (across runway 13 when it stopped short of it) with the frequency change; the runway is cleared`, () => {
      const { h, reopen } = setup(type);
      const ac = h.find('X1')!;
      expect(h.runUntil(() => h.pilotTexts('X1').some((t) => /stopped on runway four, unable to exit/.test(t)), 300)).toBe(true);
      reopen();
      expect(h.runUntil(() => h.atc('TWR').some((e) => e.callsign === 'X1' && /turn right at/i.test(e.text)), 90)).toBe(true);
      const call = h.atc('TWR').find((e) => e.callsign === 'X1' && /turn right at/i.test(e.text))!.text;
      // (the F-16 stopped beyond the intersection and needs no crossing)
      expect(call).toMatch(type === 'C172' ? /cross runway one three, turn right at alpha, contact ground/i : /turn right at alpha, contact ground/i);
      expect(h.outcomes.filter((o) => o.out.status !== 'accepted' && o.cmd.callsign === 'X1' && o.cmd.kind !== 'LAND')).toEqual([]);
      expect(h.runUntil(() => ac.occupyingRunways.length === 0, 240)).toBe(true);
      expect(h.events.filter((e) => ['RUNWAY_INCURSION', 'SEPARATION_VIOLATION'].includes(e.kind))).toEqual([]);
    });
  }

  it('no deadlock: a departure at the hold is cleared for takeoff only after the stopped aircraft is off runway 4', () => {
    const { h } = setup('C172', [dep('N2')]);
    const stopped = h.find('X1')!;
    let occupiedAtClearance: string[] | undefined;
    h.runUntil(() => {
      const t = h.atc('TWR').find((e) => e.callsign === 'N2' && /cleared for takeoff/.test(e.text));
      if (t && !occupiedAtClearance) occupiedAtClearance = [...stopped.occupyingRunways];
      return !!t;
    }, 900);
    expect(occupiedAtClearance).toBeDefined();
    expect(occupiedAtClearance).not.toContain('4/22');
  });
});

describe('AI Tower and a rejected takeoff that stopped on the runway (JO 7110.65 3-9-11)', () => {
  for (const [type, kt] of [['A320', 60], ['C172', 40]] as const) {
    it(`${type} cancelled at ${kt} kt on runway 13: taxied off and handed to Ground, not re-cleared from where it stands`, () => {
      const h = createHarness({ player: ['GND'], mode: 'free_play', activeRunways: { departing: ['13'], landing: ['13'] }, spawns: [
        { atSec: 0, callsign: 'X1', type, flightRules: type === 'A320' ? 'IFR' : 'VFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'holding_short', nodeId: 'HP13-31-B-1', runwayEnd: '13' } },
      ] });
      const ac = h.find('X1')!;
      let cancelled = false;
      h.runUntil(() => {
        if (!cancelled && ac.phase === 'TAKEOFF_ROLL' && ac.groundSpeedKt >= kt) {
          cancelled = true;
          h.say('TWR', cmd('CANCEL_TAKEOFF', 'X1', { reason: 'vehicle on the runway' }));
        }
        return cancelled;
      }, 400);
      expect(cancelled).toBe(true);
      expect(h.runUntil(() => h.pilotTexts('X1').some((t) => /stopped on runway/.test(t)), 60)).toBe(true);
      const clearedBefore = h.atc('TWR').filter((e) => e.callsign === 'X1' && /cleared for takeoff/.test(e.text)).length;
      expect(h.runUntil(() => h.atc('TWR').some((e) => e.callsign === 'X1' && /turn (left|right) at|taxi/i.test(e.text)), 120)).toBe(true);
      expect(h.atc('TWR').filter((e) => e.callsign === 'X1' && /cleared for takeoff/.test(e.text)).length).toBe(clearedBefore);
      expect(h.outcomes.filter((o) => o.cmd.callsign === 'X1' && o.out.status !== 'accepted' && o.cmd.kind !== 'CANCEL_TAKEOFF')).toEqual([]);
      expect(h.runUntil(() => ac.occupyingRunways.length === 0, 300)).toBe(true);
    });
  }
});
