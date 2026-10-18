import { describe, expect, it } from 'vitest';
import { loadKacy } from '../../airport';
import { createEngine } from '../../sim/engine';
import type { ExtendedEngine } from '../../sim/engineExtras';
import type { ControllerPositionId } from '../../sim/types';
import { GA_PARKED, IFR_HOLDING, find, makeScenario, run } from '../../sim/__fixtures__/testHelpers';
import { afterCandidates, landlineView, quickRequests, statusLabel } from '../lib/landline';
import { transmitLandline } from './landline';

const kacy = loadKacy();
const holdNode = Object.values(kacy.taxiwayGraph.nodes).find((n) => n.kind === 'holding_position' && n.runwayId === '13/31' && n.protectsRunwayEnd === '13')!.id;

function setup(player: ControllerPositionId[], positions: ControllerPositionId[] = ['GND', 'TWR', 'APP', 'DEP']): ExtendedEngine {
  const e = createEngine({
    airport: kacy, readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 9, 17, 16),
    scenario: makeScenario({
      mode: 'training', controllerPositions: positions, playerPositions: player, activeRunways: { departing: ['13', '22'], landing: ['13'] },
      spawns: [GA_PARKED('N60DX', 'GA-3'), IFR_HOLDING('NKS451', holdNode, '13', ['VCN'])],
    }),
  }) as ExtendedEngine;
  run(e, 2);
  return e;
}
const call = (e: ExtendedEngine, text: string, player: ControllerPositionId[]) => transmitLandline({ engine: e, text, source: 'typed', controller: { positions: player } });
const reqs = (e: ExtendedEngine) => e.getState().coordination!.requests;

describe('landline pipeline', () => {
  it('Ground asks Tower; Tower (the player) answers approve with and without "behind the landing"', () => {
    const g = setup(['GND']);
    expect(call(g, 'Tower, Ground, cross runway one three at alpha with Cessna six zero delta x-ray', ['GND'])).toMatchObject({ summary: 'done' });
    expect(reqs(g)[0]).toMatchObject({ topic: 'CROSSING', from: 'GND', to: 'TWR', point: 'A', status: 'pending' });
    // now as Tower on the same engine
    expect(call(g, 'Ground, Tower, cross runway one three at alpha', ['TWR'])).toMatchObject({ summary: 'done' });
    expect(reqs(g)[0].status).toBe('approved');
    const t = setup(['TWR']);
    t.coordination!.request({ topic: 'CROSSING', from: 'GND', to: 'TWR', aircraftId: find(t, 'N60DX').id, runwayId: '13/31', source: 'ai' });
    expect(call(t, 'Ground, Tower, unable, traffic on a two mile final, call you back', ['TWR']).summary).toBe('done');
    expect(reqs(t)[0].status).toBe('standby');
    expect(call(t, 'Ground, Tower, cross approved', ['TWR']).summary).toBe('done');
    expect(reqs(t)[0].status).toBe('approved');
    expect(call(t, 'Ground, Tower, hold short', ['TWR']).summary).toBe('done');
    expect(reqs(t)[0].status).toBe('rescinded');
  });

  it('refuses what cannot be done: a position the player does not work, nothing waiting, an unknown aircraft, both positions worked, nobody there', () => {
    const g = setup(['GND']);
    expect(call(g, 'Ground, Tower, cross approved', ['GND'])).toMatchObject({ summary: 'rejected' });
    expect(call(g, 'Tower, Ground, Cessna seven seven seven zulu zulu point out approved', ['GND']).summary).toMatch(/rejected|clarify/);
    const both = setup(['GND', 'TWR']);
    expect(call(both, 'Tower, Ground, cross runway one three at alpha with Cessna six zero delta x-ray', ['GND', 'TWR']).message).toMatch(/nobody to call/);
    const nobody = setup(['GND'], ['GND']);
    expect(call(nobody, 'Tower, Ground, cross runway one three at alpha with Cessna six zero delta x-ray', ['GND']).message).toMatch(/Nobody works Tower/);
    expect(call(g, 'banana', ['GND']).summary).toBe('clarify');
  });

  it('release: Tower asks Departure, Departure (the player) releases or says hold for release; "released" before a request is accepted too', () => {
    const t = setup(['TWR']);
    expect(call(t, 'Departure, Tower, release Spirit four fifty one', ['TWR']).summary).toBe('done');
    expect(reqs(t)[0]).toMatchObject({ topic: 'RELEASE', to: 'DEP' });
    const d = setup(['DEP']);
    d.coordination!.request({ topic: 'RELEASE', from: 'TWR', to: 'DEP', aircraftId: find(d, 'NKS451').id, source: 'ai' });
    expect(call(d, 'Tower, Departure, Spirit four fifty one released', ['DEP']).summary).toBe('done');
    expect(reqs(d)[0].status).toBe('approved');
    expect(call(d, 'Tower, Departure, Spirit four fifty one hold for release', ['DEP']).summary).toBe('done');
    expect(reqs(d)[0].status).toBe('rescinded');
    const early = setup(['DEP']);
    expect(call(early, 'Tower, Departure, Spirit four fifty one released', ['DEP']).summary).toBe('done');
    expect(reqs(early)[0]).toMatchObject({ from: 'TWR', to: 'DEP', status: 'approved' });
  });

  it('point out and information: rolling, going around, traffic, free text, crossing complete', () => {
    const d = setup(['DEP']);
    expect(call(d, 'point out, two miles west of Cedar Lake, three thousand, Spirit four fifty one', ['DEP']).summary).toBe('done');
    expect(reqs(d)[0]).toMatchObject({ topic: 'POINT_OUT', from: 'DEP', to: 'APP', altitudeFt: 3000 });
    expect(d.getState().coordination!.messages[0].text).toMatch(/^Approach, Departure, point out, two miles west of cedar lake, Spirit four fifty one, 3000$/);
    const t = setup(['TWR']);
    expect(call(t, 'Departure, Tower, Spirit four fifty one rolling', ['TWR']).summary).toBe('done');
    expect(call(t, 'Approach, Tower, Spirit four fifty one going around', ['TWR']).summary).toBe('done');
    expect(call(t, 'Approach, Tower, we have a vehicle on the runway', ['TWR']).summary).toBe('done');
    expect(t.getState().coordination!.messages.map((m) => m.kind)).toEqual(['ROLLING', 'GOING_AROUND', 'TEXT']);
    const g = setup(['GND']);
    expect(call(g, 'Tower, Ground, Cessna six zero delta x-ray across runway one three', ['GND']).summary).toBe('done');
    expect(g.getState().coordination!.messages[0].kind).toBe('CROSS_COMPLETE');
  });

  it('an ambiguous answer asks which aircraft', () => {
    const t = setup(['TWR']);
    for (const cs of ['N60DX', 'NKS451']) t.coordination!.request({ topic: 'CROSSING', from: 'GND', to: 'TWR', aircraftId: find(t, cs).id, runwayId: '13/31', source: 'ai' });
    expect(call(t, 'Ground, Tower, cross approved', ['TWR']).message).toMatch(/Which aircraft\? N60DX or NKS451/);
    expect(call(t, 'Ground, Tower, Cessna six zero delta x-ray cross approved', ['TWR']).summary).toBe('done');
  });
});

describe('landline view model', () => {
  it('splits incoming, asked and given; quick requests offer the calls that are still to make', () => {
    const e = setup(['TWR']);
    const ac = find(e, 'N60DX');
    const api = e.coordination!;
    const r = api.request({ topic: 'CROSSING', from: 'GND', to: 'TWR', aircraftId: ac.id, runwayId: '13/31', source: 'ai' })!;
    let v = landlineView(e.getState(), ['TWR']);
    expect(v.incoming.map((x) => x.id)).toEqual([r.id]);
    expect(v.outgoing).toHaveLength(0);
    api.respond(r.id, 'approve', { by: 'TWR', source: 'player' });
    v = landlineView(e.getState(), ['TWR']);
    expect(v.incoming).toHaveLength(0);
    expect(v.givenOpen.map((x) => x.id)).toEqual([r.id]);
    expect(statusLabel(reqs(e)[0], e.getState().clock.timeSec)).toMatch(/approved, 6\d s left|approved, 60 s left/);
    // the AI Ground is the requester: from the AI's side the same request is not "mine"
    expect(landlineView(e.getState(), ['GND'], false).outgoing.map((x) => x.id)).toEqual([r.id]);
    expect(landlineView(e.getState(), ['TWR']).log.length).toBe(2);
    expect(landlineView(e.getState(), ['APP'], false).log).toHaveLength(0);
    expect(landlineView(e.getState(), ['APP'], true).log).toHaveLength(2);
    // Tower player: the IFR departure at the hold with no release gets a one-click request
    const q = quickRequests(e.getState(), ['TWR']);
    expect(q.map((x) => x.topic)).toEqual(['RELEASE']);
    expect(q[0]).toMatchObject({ from: 'TWR', to: 'DEP' });
    expect(afterCandidates(e.getState())).toEqual([]);
  });
});
