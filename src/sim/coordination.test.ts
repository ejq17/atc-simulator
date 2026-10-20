/**
 * Coordination channel and engine rules (JO 7110.65 3-1-3 crossing approval, 4-3-4 departure release): determinism, approval, expiry, rescind,
 * training refusal, free-play scoring, the same-controller exemption.
 */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from './engine';
import type { ExtendedEngine } from './engineExtras';
import type { ControllerPositionId, GameMode, ScenarioAircraftSpawn, SimulationState } from './types';
import { SCORE_WEIGHTS, computeScore } from './scoring';
import { COORDINATION_DESIGN, describeMessage, validApproval } from './coordination';
import { IFR_HOLDING, GA_PARKED, cmd, find, makeScenario, run, runUntil } from './__fixtures__/testHelpers';

const kacy = loadKacy();
const DAY = Date.UTC(2026, 9, 17, 16, 0, 0);

interface Opts {
  mode?: GameMode;
  player?: ControllerPositionId[];
  positions?: ControllerPositionId[];
  dep?: string[];
  spawns?: ScenarioAircraftSpawn[];
}

function setup(o: Opts = {}): ExtendedEngine {
  const e = createEngine({
    airport: kacy, readbackErrorRate: 0, utcStartMs: DAY,
    scenario: makeScenario({
      mode: o.mode ?? 'training', controllerPositions: o.positions ?? ['GND', 'TWR'], playerPositions: o.player ?? ['GND'],
      activeRunways: { departing: o.dep ?? ['13', '22'], landing: ['13'] }, spawns: o.spawns ?? [GA_PARKED('N60DX', 'GA-3')],
    }),
  }) as ExtendedEngine;
  return e;
}

/** Taxi N60DX to runway 22 via Alpha and wait until it stands at the 13/31 hold line asking to cross. */
function toHold(e: ExtendedEngine): void {
  e.applyCommand(cmd('TAXI', 'N60DX', { destination: 'RWY22', runwayEnd: '22', route: ['A'], holdShort: ['13/31'] }), { position: 'GND' });
  expect(runUntil(e, () => find(e, 'N60DX').pendingRequest?.kind === 'CROSSING', 400)).toBe(true);
  run(e, 2);
}
const cross = (e: ExtendedEngine) => e.applyCommand(cmd('CROSS_RUNWAY', 'N60DX', { crossRunwayId: '13/31', runwayId: '13/31' }), { position: 'GND' });
const reqAndApprove = (e: ExtendedEngine, extra: { afterAircraftId?: string } = {}) => {
  const r = e.coordination!.request({ topic: 'CROSSING', from: 'GND', to: 'TWR', aircraftId: find(e, 'N60DX').id, runwayId: '13/31', source: 'player' })!;
  e.coordination!.respond(r.id, 'approve', { by: 'TWR', source: 'ai', ...extra });
  return r;
};
const sig = (s: SimulationState) => JSON.stringify([s.coordination, s.events.filter((x) => x.kind === 'COORDINATION').map((x) => [x.id, x.timeSec, x.text])]);

describe('crossing approval (3-1-3)', () => {
  it('training refuses a crossing of an active runway that Tower has not approved, citing 3-1-3 and not blaming the pilot', () => {
    const e = setup();
    toHold(e);
    const out = cross(e);
    expect(out.status).toBe('rejected');
    expect(out.status === 'rejected' && out.reason).toMatch(/approval from local control/);
    expect(out.status === 'rejected' && out.reason).toMatch(/3-1-3/);
    expect(out.status === 'rejected' && out.pilotResponse).toBeUndefined();
    expect(e.getState().score.communicationErrors).toBe(0);
  });

  it('accepts it after a request and Tower approval, uses the approval up, and closes the request when the aircraft has crossed', () => {
    const e = setup();
    toHold(e);
    const r = reqAndApprove(e);
    expect(validApproval(e.getState(), 'CROSSING', r.aircraftId, '13/31')?.status).toBe('approved');
    expect(cross(e).status).toBe('accepted');
    expect(r.status).toBe('used');
    expect(validApproval(e.getState(), 'CROSSING', r.aircraftId, '13/31')).toBeUndefined();
    expect(runUntil(e, () => r.status === 'completed', 180)).toBe(true);
    const kinds = e.getState().coordination!.messages.map((m) => m.kind);
    expect(kinds).toEqual(['CROSS_REQUEST', 'CROSS_APPROVED', 'CROSS_COMPLETE']);
  });

  it('puts the point (taxiway) in the request and Tower\'s approval uses the 3-1-3 phraseology "cross runway ... at ..."', () => {
    const e = setup();
    toHold(e);
    const r = reqAndApprove(e);
    expect(r.point).toBe('A');
    const [req, ok] = e.getState().coordination!.messages;
    expect(req.text).toBe('Tower, Ground, request cross runway 13 at A with Cessna six zero delta x-ray');
    expect(req.standard).toBe(false);
    expect(ok.text).toBe('Ground, Tower, cross runway 13 at A');
    expect(ok.spoken).toBe('Ground, Tower, cross runway one three at alpha');
    expect(ok.standard).toBe(true);
    expect(ok.reference).toMatch(/CROSS \(runway\) AT \(point\/intersection\)/);
  });

  it('free play accepts an unapproved crossing and scores one coordination error (3 points)', () => {
    const e = setup({ mode: 'free_play' });
    toHold(e);
    expect(cross(e).status).toBe('accepted');
    run(e, 0.2);
    const s = e.getState();
    expect(s.score.coordinationErrors).toBe(1);
    const err = s.events.find((x) => x.kind === 'COORDINATION' && x.data?.error);
    expect(err?.text).toMatch(/without Tower's approval/);
    expect(err?.data?.reference).toMatch(/3-1-3/);
    expect(SCORE_WEIGHTS.coordinationError).toBe(-3);
    const bare = { ...s.score, correctClearances: 0, aircraftHandled: 0, coordinationErrors: 0, communicationErrors: 0, unsafeInstructions: 0 };
    expect(computeScore({ ...bare, coordinationErrors: 2 })).toBe(computeScore(bare) - 6);
  });

  it('is not needed when one person works both Ground and Tower', () => {
    const e = setup({ player: ['GND', 'TWR'] });
    toHold(e);
    expect(cross(e).status).toBe('accepted');
    expect(e.getState().coordination!.requests).toHaveLength(0);
  });

  it('is not needed when Tower does not exist, or the runway is not active, or the scenario turns it off', () => {
    const noTower = setup({ positions: ['GND'] });
    toHold(noTower);
    expect(cross(noTower).status).toBe('accepted');
    const inactive = setup({ dep: ['22'] }); // 13/31 is neither a departure nor a landing runway here
    inactive.getState().activeRunways.landing = ['22'];
    toHold(inactive);
    expect(cross(inactive).status).toBe('accepted');
    const off = setup();
    off.getState().scenario.coordination = { crossingApprovalRequired: false };
    toHold(off);
    expect(cross(off).status).toBe('accepted');
  });

  it('setStaffing: an unstaffed Tower needs no approval, an AI Tower does', () => {
    const e = setup();
    toHold(e);
    e.coordination!.setStaffing(['GND'], []);
    expect(cross(e).status).toBe('accepted');
    const f = setup();
    toHold(f);
    f.coordination!.setStaffing(['GND'], ['TWR']);
    expect(cross(f).status).toBe('rejected');
  });

  it('an approval expires after the design interval and is then refused again', () => {
    const e = setup();
    toHold(e);
    const r = reqAndApprove(e);
    run(e, COORDINATION_DESIGN.crossingApprovalTtlSec - 2);
    expect(r.status).toBe('approved');
    run(e, 4);
    expect(r.status).toBe('expired');
    expect(cross(e).status).toBe('rejected');
    expect(e.getState().coordination!.messages.at(-1)?.text).toMatch(/has expired/);
  });

  it('a rescinded approval cannot be used ("hold short, traffic on final")', () => {
    const e = setup();
    toHold(e);
    const r = reqAndApprove(e);
    e.coordination!.rescind(r.id, { by: 'TWR', source: 'ai', reason: 'traffic on final' });
    expect(r.status).toBe('rescinded');
    expect(cross(e).status).toBe('rejected');
    expect(e.getState().coordination!.messages.at(-1)?.text).toBe('Ground, Tower, hold short runway 13, traffic on final, disregard the crossing');
  });

  it('an approval "behind the landing" aircraft cannot be used until that aircraft has cleared the runway', () => {
    const e = setup({ spawns: [GA_PARKED('N60DX', 'GA-3'), { atSec: 0, callsign: 'N88LA', type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 70, runwayEnd: '13', distanceNm: 4 } }] });
    toHold(e);
    const other = find(e, 'N88LA');
    const r = reqAndApprove(e, { afterAircraftId: other.id });
    expect(r.afterCallsign).toBe('N88LA');
    const out = cross(e);
    expect(out.status).toBe('rejected');
    expect(out.status === 'rejected' && out.reason).toMatch(/after N88LA/);
    expect(e.getState().coordination!.messages.at(-1)?.standard).toBe(false); // "behind the landing ..." is plain words
  });

  it('a repeated request is one request with a higher ask count; a duplicate inside 5 s is ignored; an unanswered one is dropped later', () => {
    const e = setup();
    toHold(e);
    const ac = find(e, 'N60DX');
    const ask = () => e.coordination!.request({ topic: 'CROSSING', from: 'GND', to: 'TWR', aircraftId: ac.id, runwayId: '13/31', source: 'ai' })!;
    const r = ask();
    ask();
    expect(r.asks).toBe(1);
    run(e, 6);
    ask();
    expect(r.asks).toBe(2);
    expect(e.getState().coordination!.requests).toHaveLength(1);
    expect(e.getState().coordination!.messages.filter((m) => m.kind === 'CROSS_REQUEST')).toHaveLength(2);
    run(e, COORDINATION_DESIGN.openRequestTimeoutSec + 1);
    expect(r.status).toBe('expired');
    expect(ask().id).not.toBe(r.id);
  });

  it('stand-by keeps the request open; a later approval is valid', () => {
    const e = setup();
    toHold(e);
    const r = e.coordination!.request({ topic: 'CROSSING', from: 'GND', to: 'TWR', aircraftId: find(e, 'N60DX').id, runwayId: '13/31', source: 'player' })!;
    e.coordination!.respond(r.id, 'standby', { by: 'TWR', source: 'ai', reason: 'traffic on a two mile final' });
    expect(r.status).toBe('standby');
    expect(e.getState().coordination!.messages.at(-1)?.text).toBe("Ground, Tower, unable, traffic on a two mile final, I'll call you back");
    e.coordination!.respond(r.id, 'approve', { by: 'TWR', source: 'ai' });
    expect(cross(e).status).toBe('accepted');
  });
});

describe('determinism and replay', () => {
  it('the same calls at the same times give the same channel, messages and events', () => {
    const play = () => {
      const e = setup();
      toHold(e);
      reqAndApprove(e);
      cross(e);
      run(e, 60);
      return sig(e.getState());
    };
    expect(play()).toBe(play());
  });

  it('every message is also a COORDINATION event with the message id', () => {
    const e = setup();
    toHold(e);
    reqAndApprove(e);
    const s = e.getState();
    const evs = s.events.filter((x) => x.kind === 'COORDINATION');
    expect(evs.map((x) => x.data?.msgId)).toEqual(s.coordination!.messages.map((m) => m.id));
    expect(evs[0].aiPosition).toBeUndefined(); // the request was the player's
    expect(evs[1].aiPosition).toBe('TWR'); // the approval was an AI call
  });
});

describe('departure release (4-3-4 / LOA)', () => {
  const holdNode = (): string => {
    const h = Object.values(kacy.taxiwayGraph.nodes).find((n) => n.kind === 'holding_position' && n.runwayId === '13/31' && n.protectsRunwayEnd === '13');
    return h!.id;
  };
  const make = (over: Opts = {}) => {
    const e = createEngine({
      airport: kacy, readbackErrorRate: 0, utcStartMs: DAY,
      scenario: makeScenario({
        mode: over.mode ?? 'training', controllerPositions: over.positions ?? ['GND', 'TWR', 'DEP'], playerPositions: over.player ?? ['TWR'],
        activeRunways: { departing: ['13'], landing: ['13'] }, spawns: [IFR_HOLDING('NKS451', holdNode(), '13', ['VCN'])],
      }),
    }) as ExtendedEngine;
    const ac = find(e, 'NKS451');
    // the IFR clearance is on file (the departure was cleared by Delivery)
    ac.flightPlan!.ifrClearance = { destination: 'KPHL', routeText: 'radar vectors', initialAltitudeFt: 2000, departureFrequencyMhz: 124.6, squawk: '4215', readBack: true, issuedAtSec: 0 };
    run(e, 10);
    return e;
  };
  const takeoff = (e: ExtendedEngine) => e.applyCommand(cmd('TAKEOFF', 'NKS451', { runwayEnd: '13', runwayId: '13/31' }), { position: 'TWR' });

  it('training refuses the takeoff clearance of an IFR departure without a release from a separate Departure', () => {
    const e = make();
    const out = takeoff(e);
    expect(out.status).toBe('rejected');
    expect(out.status === 'rejected' && out.reason).toMatch(/no departure release from Departure/);
    expect(out.status === 'rejected' && out.reason).toMatch(/4-3-4/);
  });

  it('accepts it after the release ("Spirit four fifty one released"), once', () => {
    const e = make();
    const ac = find(e, 'NKS451');
    const r = e.coordination!.request({ topic: 'RELEASE', from: 'TWR', to: 'DEP', aircraftId: ac.id, runwayId: '13/31', source: 'player' })!;
    e.coordination!.respond(r.id, 'approve', { by: 'DEP', source: 'ai' });
    const m = e.getState().coordination!.messages;
    expect(m[0].text).toBe('Departure, Tower, request release Spirit four fifty one');
    expect(m[1].text).toBe('Tower, Departure, Spirit four fifty one released');
    expect(m[1].standard).toBe(true);
    expect(m[1].reference).toMatch(/4-3-4/);
    expect(takeoff(e).status).toBe('accepted');
    expect(r.status).toBe('used');
  });

  it('a release expires (design interval) and "hold for release" denies it', () => {
    const e = make();
    const ac = find(e, 'NKS451');
    const r = e.coordination!.request({ topic: 'RELEASE', from: 'TWR', to: 'DEP', aircraftId: ac.id, source: 'player' })!;
    e.coordination!.respond(r.id, 'deny', { by: 'DEP', source: 'ai', reason: 'missed approach in progress' });
    expect(r.status).toBe('denied');
    expect(e.getState().coordination!.messages.at(-1)?.text).toBe('Tower, Departure, Spirit four fifty one hold for release, missed approach in progress');
    expect(takeoff(e).status).toBe('rejected');
    const r2 = e.coordination!.request({ topic: 'RELEASE', from: 'TWR', to: 'DEP', aircraftId: ac.id, source: 'player' })!;
    e.coordination!.respond(r2.id, 'approve', { by: 'DEP', source: 'ai' });
    run(e, COORDINATION_DESIGN.releaseTtlSec + 1);
    expect(r2.status).toBe('expired');
    expect(takeoff(e).status).toBe('rejected');
  });

  it('free play accepts and scores a coordination error', () => {
    const e = make({ mode: 'free_play' });
    expect(takeoff(e).status).toBe('accepted');
    run(e, 0.2);
    expect(e.getState().score.coordinationErrors).toBe(1);
    expect(e.getState().events.find((x) => x.kind === 'COORDINATION' && x.data?.error)?.text).toMatch(/without a release from Departure/);
  });

  it('is not needed when the same person works Tower and Departure, when no Departure/Approach exists, or when the scenario turns it off', () => {
    expect(takeoff(make({ player: ['TWR', 'DEP'] })).status).toBe('accepted');
    expect(takeoff(make({ positions: ['GND', 'TWR'] })).status).toBe('accepted');
    const off = make();
    off.getState().scenario.coordination = { releasesRequired: false };
    expect(takeoff(off).status).toBe('accepted');
  });

  it('Approach releases when there is no Departure position', () => {
    const e = make({ positions: ['GND', 'TWR', 'APP'] });
    expect(takeoff(e).status).toBe('rejected');
    const r = e.coordination!.request({ topic: 'RELEASE', from: 'TWR', to: 'APP', aircraftId: find(e, 'NKS451').id, source: 'player' })!;
    e.coordination!.respond(r.id, 'approve', { by: 'APP', source: 'ai' });
    expect(takeoff(e).status).toBe('accepted');
  });
});

describe('departure gap (Tower asks Approach; 3-8-1 / 3-9-5 / 2-1-14, plain words)', () => {
  const hold22 = (): string => Object.values(kacy.taxiwayGraph.nodes).find((n) => n.kind === 'holding_position' && n.runwayId === '4/22' && n.protectsRunwayEnd === '22')!.id;
  const make = () => {
    const e = createEngine({
      airport: kacy, readbackErrorRate: 0, utcStartMs: DAY,
      scenario: makeScenario({
        mode: 'free_play', controllerPositions: ['GND', 'TWR', 'APP'], playerPositions: ['TWR'],
        activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [{ atSec: 0, callsign: 'N60DX', type: 'C172', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'holding_short', nodeId: hold22(), runwayEnd: '22' } }],
      }),
    }) as ExtendedEngine;
    run(e, 5);
    return e;
  };
  const ask = (e: ExtendedEngine, departures = 1) => e.coordination!.request({ topic: 'GAP', from: 'TWR', to: 'APP', aircraftId: find(e, 'N60DX').id, runwayId: '4/22', runwayEnd: '22', departures, source: 'player' })!;

  it('the request names the runway end and the number of departures, in plain words', () => {
    const e = make();
    const r = ask(e);
    expect(r.status).toBe('pending');
    const m = e.getState().coordination!.messages.at(-1)!;
    expect(m).toMatchObject({ kind: 'GAP_REQUEST', from: 'TWR', to: 'APP', standard: false });
    expect(m.text).toBe('Approach, Tower, need a gap for a departure runway 22');
    expect(m.spoken).toBe('Approach, Tower, need a gap for a departure runway two two');
    expect(describeMessage('GAP_REQUEST', { from: 'TWR', to: 'APP', runwayEnd: '22', departures: 2 }).spoken).toBe('Approach, Tower, need a gap for two departures runway two two');
  });
  it('Approach answers "gap after <callsign>" (valid for the design interval), or "unable, <reason>", or "stand by"', () => {
    const e = make();
    const after = { afterAircraftId: find(e, 'N60DX').id };
    const r = ask(e);
    e.coordination!.respond(r.id, 'approve', { by: 'APP', source: 'ai', ...after });
    const ok = e.getState().coordination!.requests.find((x) => x.id === r.id)!;
    expect(ok).toMatchObject({ status: 'approved', afterCallsign: 'N60DX' });
    expect(ok.expiresSec).toBeCloseTo(e.getState().clock.timeSec + COORDINATION_DESIGN.gapTtlSec, 0);
    expect(e.getState().coordination!.messages.at(-1)).toMatchObject({ kind: 'GAP_APPROVED', text: 'Tower, Approach, gap after N60DX', standard: false });
    expect(validApproval(e.getState(), 'GAP', find(e, 'N60DX').id)).toBeDefined();

    const e2 = make();
    const r2 = ask(e2);
    e2.coordination!.respond(r2.id, 'deny', { by: 'APP', source: 'ai', reason: 'no arrival I can delay' });
    expect(e2.getState().coordination!.messages.at(-1)).toMatchObject({ kind: 'GAP_UNABLE', text: 'Tower, Approach, unable, no arrival I can delay' });
    expect(e2.getState().coordination!.requests.find((x) => x.id === r2.id)!.status).toBe('denied');

    const e3 = make();
    const r3 = ask(e3);
    e3.coordination!.respond(r3.id, 'standby', { by: 'APP', source: 'player', reason: 'traffic' });
    expect(e3.getState().coordination!.messages.at(-1)!.kind).toBe('GAP_STANDBY');
  });
  it('an approved gap lapses after its interval, and is completed when the departure is cleared (it left the hold)', () => {
    const e = make();
    const r = ask(e);
    e.coordination!.respond(r.id, 'approve', { by: 'APP', source: 'player' });
    expect(e.getState().coordination!.messages.at(-1)!.text).toBe('Tower, Approach, gap available now');
    run(e, COORDINATION_DESIGN.gapTtlSec + 2);
    expect(e.getState().coordination!.requests.find((x) => x.id === r.id)!.status).toBe('expired');

    const e2 = make();
    const r2 = ask(e2);
    e2.coordination!.respond(r2.id, 'approve', { by: 'APP', source: 'player' });
    expect(e2.applyCommand(cmd('TAKEOFF', 'N60DX', { runwayEnd: '22', runwayId: '4/22' }), { position: 'TWR' }).status).toBe('accepted');
    run(e2, 2);
    expect(e2.getState().coordination!.requests.find((x) => x.id === r2.id)!.status).toBe('completed');
  });
  it('a repeated request is one request (asked twice); deterministic: the same calls give the same channel', () => {
    const e = make();
    const r = ask(e);
    run(e, 40);
    const again = ask(e);
    expect(again.id).toBe(r.id);
    expect(again.asks).toBe(2);
    const sigOf = (x: ExtendedEngine) => sig(x.getState());
    const a = make(); ask(a); run(a, 40); ask(a);
    const b = make(); ask(b); run(b, 40); ask(b);
    expect(sigOf(a)).toBe(sigOf(b));
  });
});

describe('phraseology (every wording is marked standard or plain)', () => {
  const base = { from: 'DEP' as const, to: 'APP' as const, spokenCallsign: 'Cessna three echo juliet' };
  it('point-out follows the 5-4-3 pattern and its answers are the 5-4-3 terms', () => {
    const po = describeMessage('POINT_OUT', { ...base, positionText: 'two miles west of Cedar Lake', altitudeFt: 3000 });
    expect(po.text).toBe('Approach, Departure, point out, two miles west of Cedar Lake, Cessna three echo juliet, 3000');
    expect(po.spoken).toBe('Approach, Departure, point out, two miles west of Cedar Lake, Cessna three echo juliet, three thousand');
    expect(po.standard).toBe(true);
    expect(describeMessage('POINT_OUT_APPROVED', { ...base, from: 'APP', to: 'DEP' }).text).toBe('Departure, Approach, Cessna three echo juliet point out approved');
    expect(describeMessage('TRAFFIC_OBSERVED', base).standard).toBe(true);
  });
  it('rolling, going around and stand-by are plain words (not in the order)', () => {
    for (const k of ['ROLLING', 'GOING_AROUND', 'RELEASE_STANDBY', 'CROSS_STANDBY', 'CROSS_UNABLE'] as const) expect(describeMessage(k, base).standard, k).toBe(false);
  });
});
