/** AI Ground with the ground-operations behaviours: pushback, a missing hold-short readback, and a progressive-taxi request (real KACY). */
import { describe, expect, it } from 'vitest';
import { createHarness, IFR_DEP } from './testkit';
import type { ScenarioAircraftSpawn } from '../sim/types';

const ga = (cs: string, parking: string): ScenarioAircraftSpawn => ({ atSec: 0, callsign: cs, type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: parking }, isDeparture: true, initialFrequencyId: 'GND' });
const groundTexts = (h: ReturnType<typeof createHarness>, cs: string) => h.atc('GND').filter((e) => e.callsign === cs).map((e) => e.text);

describe('AI Ground: progressive taxi', () => {
  const h = createHarness({
    player: ['TWR'], mode: 'free_play', readbackErrorRate: 0,
    spawns: [ga('N723EJ', 'GA-1')], pilotBehaviour: { ground: { unfamiliarFraction: 1, holdShortOmitFraction: 0 } },
  });
  h.runUntil(() => h.now() > 150 && !!h.find('N723EJ') && h.find('N723EJ')!.frequencyMhz === 120.3, 900);

  it('the unfamiliar pilot asks, and Ground gives the route in steps, then the full route for the last two taxiways', () => {
    expect(h.pilotTexts('N723EJ')[0]).toMatch(/ready to taxi, VFR to .*, request progressive taxi\.$/);
    const g = groundTexts(h, 'N723EJ');
    const steps = g.filter((t) => /turn (left|right) on|continue taxiing via/.test(t));
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(g.some((t) => /runway one three, taxi via/.test(t))).toBe(true);
    const order = g.findIndex((t) => /turn (left|right) on|continue taxiing via/.test(t));
    expect(order).toBeLessThan(g.findIndex((t) => /runway one three, taxi via/.test(t)));
  });

  it('the aircraft followed the segments to Tower without a safety event or a rejected command', () => {
    expect(h.find('N723EJ')!.frequencyMhz).toBe(120.3);
    expect(h.outcomes.filter((o) => o.out.status !== 'accepted').map((o) => `${o.cmd.kind} ${(o.out as { reason?: string }).reason}`)).toEqual([]);
    expect(h.events.filter((e) => ['RUNWAY_INCURSION', 'SEPARATION_VIOLATION'].includes(e.kind))).toEqual([]);
  });
});

describe('AI Ground: a hold-short readback that was left out', () => {
  const h = createHarness({
    player: ['TWR'], mode: 'free_play', readbackErrorRate: 0,
    spawns: [IFR_DEP('NKS451', 'GATE-1', ['VCN'])], pilotBehaviour: { ground: { holdShortOmitFraction: 1 } },
  });
  h.runUntil(() => h.now() > 400 && h.find('NKS451')?.frequencyMhz === 120.3, 1200);

  it('asks for the readback ("read back hold instructions", 3-7-2) and the aircraft goes on; the AI is not charged', () => {
    const g = groundTexts(h, 'NKS451');
    expect(g.some((t) => /pushback approved/.test(t))).toBe(true);
    expect(g.some((t) => t.endsWith('read back hold instructions'))).toBe(true);
    expect(h.find('NKS451')!.frequencyMhz).toBe(120.3);
    expect(h.engine.getState().score.communicationErrors).toBe(0);
  });
});
