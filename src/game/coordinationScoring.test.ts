import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import type { ExtendedEngine } from '../sim/engineExtras';
import { GA_PARKED, cmd, find, makeScenario, run, runUntil } from '../sim/__fixtures__/testHelpers';
import { buildDebrief } from './debrief';
import { REFERENCES } from './references';
import { evaluateCheck, isKnownCheck } from './objectives';

const kacy = loadKacy();

function freePlayCrossing(): ExtendedEngine {
  const e = createEngine({
    airport: kacy, readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 9, 17, 16),
    scenario: makeScenario({ mode: 'free_play', controllerPositions: ['GND', 'TWR'], playerPositions: ['GND'], activeRunways: { departing: ['13', '22'], landing: ['13'] }, spawns: [GA_PARKED('N60DX', 'GA-3')] }),
  }) as ExtendedEngine;
  e.applyCommand(cmd('TAXI', 'N60DX', { destination: 'RWY22', runwayEnd: '22', route: ['A'], holdShort: ['13/31'] }), { position: 'GND' });
  runUntil(e, () => find(e, 'N60DX').pendingRequest?.kind === 'CROSSING', 400);
  run(e, 2);
  return e;
}

describe('coordination in objectives and the debrief', () => {
  it('objective checks: coord:KIND:CS and no_coordination_errors', () => {
    const e = freePlayCrossing();
    expect(isKnownCheck('coord:CROSS_REQUEST:N60DX')).toBe(true);
    expect(isKnownCheck('no_coordination_errors')).toBe(true);
    const ac = find(e, 'N60DX');
    expect(evaluateCheck(e.getState(), 'coord:CROSS_REQUEST:N60DX')).toBe(false);
    const r = e.coordination!.request({ topic: 'CROSSING', from: 'GND', to: 'TWR', aircraftId: ac.id, runwayId: '13/31', source: 'player' })!;
    expect(evaluateCheck(e.getState(), 'coord:CROSS_REQUEST:N60DX')).toBe(true);
    expect(evaluateCheck(e.getState(), 'coord:CROSS_APPROVED:N60DX')).toBe(false);
    e.coordination!.respond(r.id, 'approve', { by: 'TWR', source: 'ai' });
    expect(evaluateCheck(e.getState(), 'coord:CROSS_APPROVED:N60DX')).toBe(true);
    expect(evaluateCheck(e.getState(), 'no_coordination_errors')).toBe(true);
  });

  it('an unapproved crossing in free play is a coordination error in the score card, the debrief advice (with 3-1-3) and the timeline', () => {
    const e = freePlayCrossing();
    e.applyCommand(cmd('CROSS_RUNWAY', 'N60DX', { crossRunwayId: '13/31', runwayId: '13/31' }), { position: 'GND' });
    run(e, 1);
    const s = e.getState();
    expect(evaluateCheck(s, 'no_coordination_errors')).toBe(false);
    const d = buildDebrief(s);
    expect(d.score.coordinationErrors).toBe(1);
    const advice = d.improvements.find((x) => /without Tower's approval/.test(x));
    expect(advice).toBeDefined();
    expect(advice).toMatch(/7110\.65 3-1-3 Use of Active Runways/);
    expect(advice).toMatch(/3-1-4/);
    expect(d.timeline.some((t) => /without Tower's approval/.test(t.text))).toBe(true);
  });

  it('the references used by the debrief exist (3-1-3, 3-1-4, 4-3-4, 5-4-7)', () => {
    for (const k of ['3-1-3', '3-1-4', '4-3-4', '5-4-3', '5-4-7'] as const) expect(REFERENCES[k].para).toBe(k);
  });
});
