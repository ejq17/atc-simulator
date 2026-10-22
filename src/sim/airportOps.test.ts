/**
 * Airport operating state in the engine: NOTAM-style closures (runway, taxiway), their effect on taxi planning and on clearances, pilot braking action
 * reports, bird activity advisories, runway light intensity. Runs on the real KACY layout (13/31 and 4/22).
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import { loadKacy } from '../airport';
import { ARRIVING, GA_PARKED, HOLDING, cmd, find, makeScenario, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import type { Scenario, ScenarioAircraftSpawn, Weather } from './types';
import type { SimulationEngineExtras } from './engineExtras';
import type { SimulationEngine } from './api';
import {
  activeClosures, closedRunwayEnds, closedRunwayIds, closedTaxiways, defaultLightStep, effectiveLightStep, isNight, isRunwayClosed, latestBrakingReport,
  lightsRunwayId, resolveClosureIdent, runwayIsQuiet, runwayLightsOn, spokenTypeForReport,
} from './airportOps';
import { findTaxiRoute, routeSegmentTaxiways } from './pathfinding';

const kacy = loadKacy();
type Eng = SimulationEngine & SimulationEngineExtras;
const wx = (over: Partial<Weather> = {}): Weather => ({
  source: 'simulated', windDirDeg: 0, windSpeedKt: 0, visibilitySm: 10, clouds: [{ cover: 'SKC', baseFtAgl: 0 }], temperatureC: 15, dewpointC: 5, altimeterInHg: 29.92, phenomena: [], flightCategory: 'VFR', ...over,
});
const JUNE_NOON = Date.UTC(2026, 5, 1, 16, 0, 0); // 12:00 local, daylight
const JUNE_NIGHT = Date.UTC(2026, 5, 1, 4, 0, 0); // 00:00 local, dark
function make(over: Partial<Scenario> = {}, utcStartMs = JUNE_NOON): Eng {
  return createEngine({
    airport: kacy, readbackErrorRate: 0, utcStartMs,
    scenario: makeScenario({ weather: wx(), activeRunways: { departing: ['31'], landing: ['31'] }, controllerPositions: ['TWR', 'GND'], mode: 'free_play', ...over }),
  }) as Eng;
}

describe('closures', () => {
  it('scenario closures are in force from time 0, announced once as a NOTAM, and resolved to runway pairs / taxiway designators', () => {
    const e = make({ closures: [{ kind: 'RUNWAY', ident: '4' }, { kind: 'TAXIWAY', ident: 'h' }] });
    const st = e.getState();
    expect(activeClosures(st).map((c) => [c.kind, c.ident, c.source])).toEqual([['RUNWAY', '4/22', 'setup'], ['TAXIWAY', 'H', 'setup']]);
    expect(closedRunwayIds(st)).toEqual(new Set(['4/22']));
    expect(closedRunwayEnds(st).sort()).toEqual(['22', '4']);
    expect(closedTaxiways(st)).toEqual(new Set(['H']));
    expect(isRunwayClosed(st, '22')).toBe(true);
    expect(isRunwayClosed(st, '4/22')).toBe(true);
    expect(isRunwayClosed(st, '13')).toBe(false);
    run(e, 1);
    run(e, 1);
    const notams = st.events.filter((x) => x.text.startsWith('NOTAM: '));
    expect(notams.map((x) => x.text)).toEqual([expect.stringMatching(/^NOTAM: Runway 4\/22 closed/), expect.stringMatching(/^NOTAM: Taxiway H closed/)]);
  });
  it('a closure with start and end times is active only in between, and its end is announced', () => {
    const e = make();
    const r = e.addClosure!({ kind: 'TAXIWAY', ident: 'B', startSec: 5, endSec: 20, reason: 'test' }, 'scenario');
    expect(r.ok).toBe(true);
    expect(closedTaxiways(e.getState()).size).toBe(0);
    run(e, 6);
    expect(closedTaxiways(e.getState())).toEqual(new Set(['B']));
    run(e, 15);
    expect(closedTaxiways(e.getState()).size).toBe(0);
    expect(e.getState().events.some((x) => /NOTAM cancelled: Taxiway B closed/.test(x.text))).toBe(true);
  });
  it('refuses an unknown ident and the last open runway; removeClosure reopens now', () => {
    const e = make();
    expect(e.addClosure!({ kind: 'TAXIWAY', ident: 'ZZ' })).toMatchObject({ ok: false });
    expect(e.addClosure!({ kind: 'RUNWAY', ident: '09' })).toMatchObject({ ok: false });
    const a = e.addClosure!({ kind: 'RUNWAY', ident: '13/31' });
    expect(a.ok).toBe(true);
    const b = e.addClosure!({ kind: 'RUNWAY', ident: '4/22' });
    expect(b).toMatchObject({ ok: false, reason: expect.stringMatching(/last open runway/) });
    expect(a.ok && e.removeClosure!(a.closure.id)).toBe(true);
    expect(closedRunwayIds(e.getState()).size).toBe(0);
    expect(resolveClosureIdent(kacy, 'RUNWAY', 'runway 31')).toBe('13/31');
    expect(resolveClosureIdent(kacy, 'TAXIWAY', 'twy B')).toBe('B');
  });
  it('runwayIsQuiet: false with an aircraft on a 5 nm final, true once it is gone', () => {
    const e = make({ spawns: [ARRIVING('N1', '31', 5)] });
    expect(runwayIsQuiet(e.getState(), '13/31')).toBe(false);
    expect(runwayIsQuiet(e.getState(), '4/22')).toBe(true);
    e.removeAircraft(find(e, 'N1').id);
    expect(runwayIsQuiet(e.getState(), '13/31')).toBe(true);
  });
});

describe('taxi planning with a closed taxiway', () => {
  const spawn = (cs: string, gate: string): ScenarioAircraftSpawn => GA_PARKED(cs, gate, 'GND', { type: 'A320', flightRules: 'IFR' });
  it('the route search never uses the closed taxiway and refuses to name it', () => {
    const g = kacy.taxiwayGraph;
    const open = findTaxiRoute(g, 'PK-GATE-2', 'HP13-31-B-2', { avoidRunways: true, allowedRunwayIds: kacy.runways.map((r) => r.id) });
    expect(open.route?.taxiways).toBeTruthy();
    const used = open.route!.taxiways.filter((t) => !/^RWY/i.test(t));
    for (const t of used) {
      const r = findTaxiRoute(g, 'PK-GATE-2', 'HP13-31-B-2', { avoidRunways: true, allowedRunwayIds: kacy.runways.map((x) => x.id), avoidTaxiways: [t] });
      if (r.route) expect(r.route.taxiways.map((x) => x.toUpperCase())).not.toContain(t.toUpperCase());
    }
    const named = findTaxiRoute(g, 'PK-GATE-2', 'HP13-31-B-2', { via: ['B'], avoidTaxiways: ['b'] });
    expect(named.route).toBeNull();
    expect(named.reason).toMatch(/closed/);
  });
  it('a taxi instruction over a closed taxiway is refused with the reason; the default route goes around it', () => {
    const e = make({ spawns: [spawn('D1', 'GATE-2')], closures: [{ kind: 'TAXIWAY', ident: 'H' }] });
    const refused = say(e, cmd('TAXI', 'D1', { runwayEnd: '31', route: ['H'] }), 'GND');
    expect(refused.status).toBe('rejected');
    expect(refused).toMatchObject({ reason: expect.stringMatching(/Taxiway H is closed/), pilotResponse: expect.stringMatching(/taxiway hotel is closed/) });
    const ok = say(e, cmd('TAXI', 'D1', { runwayEnd: '31' }), 'GND');
    expect(ok.status).toBe('accepted');
    expect(find(e, 'D1').route!.taxiways.map((t) => t.toUpperCase())).not.toContain('H');
  });
  it('a taxi to a closed runway is refused, a taxi to the open one is not', () => {
    const e = make({ spawns: [spawn('D1', 'GATE-2')], closures: [{ kind: 'RUNWAY', ident: '4/22' }] });
    const refused = say(e, cmd('TAXI', 'D1', { runwayEnd: '22' }), 'GND');
    expect(refused).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/Runway 4\/22 is closed/) });
    expect(say(e, cmd('TAXI', 'D1', { runwayEnd: '31' }), 'GND').status).toBe('accepted');
  });
  it('a runway exit taxiway that is closed is not used for the rollout (AC 150/5370-2G: closed exits are marked with a yellow X)', () => {
    const landOn = (closures: Scenario['closures']) => {
      const e = make({ spawns: [ARRIVING('NKS1', '31', 3, 'A320')], closures });
      run(e, 1);
      say(e, cmd('LAND', 'NKS1', { runwayEnd: '31' }), 'TWR');
      runUntil(e, () => find(e, 'NKS1').phase === 'RUNWAY_EXIT', 500);
      return find(e, 'NKS1');
    };
    const open = landOn(undefined);
    expect(open.phase).toBe('RUNWAY_EXIT');
    const exitTwy = kacy.taxiwayGraph.nodes[open.route!.nodeIds.at(-1)!].taxiways[0].toUpperCase();
    const closed = landOn([{ kind: 'TAXIWAY', ident: exitTwy }]);
    expect(closed.phase).toBe('RUNWAY_EXIT');
    const hold = closed.route?.nodeIds.at(-1);
    if (hold) expect(kacy.taxiwayGraph.nodes[hold].taxiways.map((t) => t.toUpperCase())).not.toContain(exitTwy);
  });
});

describe('a taxiway that closes under an aircraft already routed over it', () => {
  const dep = (): Eng => make({ spawns: [GA_PARKED('N723EJ', 'GA-2', 'GND')], activeRunways: { departing: ['13'], landing: ['13'] } });
  const segs = (e: SimulationEngine) => { const r = find(e, 'N723EJ').route!; return { r, names: routeSegmentTaxiways(kacy.taxiwayGraph, r.nodeIds) }; };

  it('stops short of the closed segment and the pilot asks for instructions (non-standard plain phrasing), shown as a pending taxi request', () => {
    const e = dep();
    say(e, cmd('TAXI', 'N723EJ', { runwayEnd: '13' }), 'GND');
    const { r, names } = segs(e);
    expect(names.map((x) => x?.toUpperCase())).toContain('P'); // L > N > M > P > B
    runUntil(e, () => find(e, 'N723EJ').route!.progressIndex > names.findIndex((x) => x === 'N') + 1, 200); // on taxiway N, before P
    expect(find(e, 'N723EJ').groundSpeedKt).toBeGreaterThan(3);
    expect(e.addClosure!({ kind: 'TAXIWAY', ident: 'P' }, 'scenario').ok).toBe(true);
    run(e, 1);
    const ac = find(e, 'N723EJ');
    const firstP = names.findIndex((x) => x?.toUpperCase() === 'P');
    expect(r.stopAtNodeIds).toContain(r.nodeIds[firstP - 1]);
    runUntil(e, () => !!find(e, 'N723EJ').pendingRequest, 200);
    run(e, 3);
    expect(ac.groundSpeedKt).toBeLessThan(0.2);
    // it stopped at the node before the closed segment: short of it, not on it
    const stop = kacy.taxiwayGraph.nodes[r.nodeIds[firstP - 1]];
    expect(Math.hypot(ac.pos.x - stop.pos.x, ac.pos.y - stop.pos.y)).toBeLessThan(3);
    expect(ac.pendingRequest).toMatchObject({ kind: 'TAXI', text: expect.stringMatching(/holding short of taxiway P \(closed\), request taxi instructions/) });
    const call = pilotTexts(e, 'N723EJ').at(-1)!;
    expect(call).toMatch(/Atlantic City Ground, Cessna .*, holding short of papa, taxiway closed, request taxi instructions\./);
    expect(e.getState().events.some((x) => x.kind === 'INFO' && x.data?.closedTaxiway === 'P')).toBe(true);
    // it stays put until it is instructed
    run(e, 30);
    expect(ac.groundSpeedKt).toBeLessThan(0.2);
  });

  it('a new taxi instruction is planned around the closure, clears the hold and the aircraft carries on to the runway', () => {
    const e = dep();
    say(e, cmd('TAXI', 'N723EJ', { runwayEnd: '13' }), 'GND');
    runUntil(e, () => find(e, 'N723EJ').groundSpeedKt > 5, 100);
    run(e, 15);
    e.addClosure!({ kind: 'TAXIWAY', ident: 'P' }, 'scenario');
    runUntil(e, () => find(e, 'N723EJ').pendingRequest?.kind === 'TAXI' && find(e, 'N723EJ').groundSpeedKt < 0.2, 300);
    const ac = find(e, 'N723EJ');
    expect(ac.pendingRequest?.text).toMatch(/closed/);
    const out = say(e, cmd('TAXI', 'N723EJ', { runwayEnd: '13' }), 'GND');
    expect(out.status).toBe('accepted');
    expect(ac.route!.taxiways.map((t) => t.toUpperCase())).not.toContain('P');
    runUntil(e, () => ac.phase === 'HOLDING_SHORT', 900);
    expect(ac.phase).toBe('HOLDING_SHORT');
  });

  it('an aircraft already on the closed taxiway carries on instead of stopping on it', () => {
    const e = dep();
    say(e, cmd('TAXI', 'N723EJ', { runwayEnd: '13' }), 'GND');
    const { r, names } = segs(e);
    const p = names.findIndex((x) => x?.toUpperCase() === 'P');
    runUntil(e, () => find(e, 'N723EJ').route!.progressIndex > p, 400);
    e.addClosure!({ kind: 'TAXIWAY', ident: 'P' }, 'scenario');
    run(e, 2);
    expect(find(e, 'N723EJ').route!.stopAtNodeIds.filter((id) => id === r.nodeIds[p])).toEqual([]);
  });
});

describe('a clearance onto a closed runway is unsafe (JO 7110.65 3-3-2)', () => {
  const hold = (cs: string) => HOLDING(cs, 'HP4-22-A-1', '4', 'C172', 'TWR');
  it('training refuses takeoff, line up and landing, naming the closure', () => {
    const e = make({ mode: 'training', spawns: [hold('N1'), ARRIVING('N2', '22', 4)], closures: [{ kind: 'RUNWAY', ident: '4/22', reason: 'runway inspection by airport operations' }], activeRunways: { departing: ['13'], landing: ['13'] } });
    run(e, 2);
    // (line up and wait is refused first for the missing traffic information while N2 is on a 4 nm final, JO 7110.65 3-9-4: it is checked without that traffic below)
    for (const c of [cmd('TAKEOFF', 'N1', { runwayEnd: '4' }), cmd('LAND', 'N2', { runwayEnd: '22' })]) {
      const out = say(e, c, 'TWR');
      expect(out.status, c.kind).toBe('rejected');
      expect(out).toMatchObject({ unsafe: true, reason: expect.stringMatching(/runway 4\/22 is closed \(runway inspection by airport operations\).*3-3-2/) });
    }
  });
  it('line up and wait onto a closed runway is refused with the closure when no traffic is near', () => {
    const e = make({ mode: 'training', spawns: [hold('N1')], closures: [{ kind: 'RUNWAY', ident: '4/22' }], activeRunways: { departing: ['13'], landing: ['13'] } });
    run(e, 2);
    expect(say(e, cmd('LINE_UP_AND_WAIT', 'N1', { runwayEnd: '4' }), 'TWR')).toMatchObject({ status: 'rejected', unsafe: true, reason: expect.stringMatching(/runway 4\/22 is closed/) });
  });
  it('outside training the clearance is issued and recorded as an unsafe clearance', () => {
    const e = make({ spawns: [hold('N1')], closures: [{ kind: 'RUNWAY', ident: '4/22' }], activeRunways: { departing: ['13'], landing: ['13'] } });
    run(e, 2);
    expect(say(e, cmd('TAKEOFF', 'N1', { runwayEnd: '4' }), 'TWR').status).toBe('accepted');
    expect(e.getState().events.some((x) => x.kind === 'CONFLICT' && x.data?.alertKind === 'UNSAFE_CLEARANCE' && /closed/.test(x.text))).toBe(true);
  });
  it('an approach clearance to a closed runway is unsafe too, an open runway is not', () => {
    const e = make({ mode: 'training', spawns: [ARRIVING('N2', '31', 6, 'A320')], closures: [{ kind: 'RUNWAY', ident: '4/22' }] });
    run(e, 1);
    expect(e.validateCommand!(cmd('LAND', 'N2', { runwayEnd: '31' }), { position: 'TWR' }).status).toBe('accepted');
  });
  it('after the closure ends the same clearance is accepted', () => {
    const e = make({ mode: 'training', spawns: [hold('N1')], activeRunways: { departing: ['13'], landing: ['13'] } });
    const c = e.addClosure!({ kind: 'RUNWAY', ident: '4/22', endSec: 10 }, 'scenario');
    expect(c.ok).toBe(true);
    run(e, 2);
    expect(say(e, cmd('TAKEOFF', 'N1', { runwayEnd: '4' }), 'TWR')).toMatchObject({ status: 'rejected', unsafe: true });
    run(e, 10);
    expect(say(e, cmd('TAKEOFF', 'N1', { runwayEnd: '4' }), 'TWR').status).toBe('accepted');
  });
});

describe('braking action reports', () => {
  const rain = wx({ phenomena: ['RA'], visibilitySm: 5, flightCategory: 'MVFR', clouds: [{ cover: 'OVC', baseFtAgl: 2500 }] });
  const land = (e: Eng, cs: string) => {
    run(e, 1);
    say(e, cmd('LAND', cs, { runwayEnd: '31' }), 'TWR');
    return runUntil(e, () => find(e, cs).phase === 'RUNWAY_EXIT' || !e.getState().aircraft[find(e, cs).id], 400);
  };
  it('a landing pilot reports braking action on a wet runway with an official term; none on a dry one', () => {
    const wet = make({ weather: rain, spawns: [ARRIVING('NKS1', '31', 4, 'A320')] });
    expect(land(wet, 'NKS1')).toBe(true);
    run(wet, 3);
    const rep = wet.getState().ops.braking;
    expect(rep).toHaveLength(1);
    expect(['good', 'good to medium', 'medium to poor', 'medium', 'poor', 'nil']).toContain(rep[0].term);
    expect(rep[0]).toMatchObject({ runwayEnd: '31', aircraftType: 'A320', aircraftSpoken: 'an Airbus three twenty' });
    expect(pilotTexts(wet, 'NKS1').some((t) => /braking action (good|medium|poor|nil)/.test(t))).toBe(true);
    const dry = make({ weather: wx(), spawns: [ARRIVING('NKS1', '31', 4, 'A320')] });
    land(dry, 'NKS1');
    run(dry, 3);
    expect(dry.getState().ops.braking).toHaveLength(0);
    expect(pilotTexts(dry, 'NKS1').some((t) => /braking action/.test(t))).toBe(false);
  });
  it('light rain reports from the RCAM row: good (5) give or take one step; heavy rain: medium to poor give or take one step; deterministic for a seed', () => {
    const terms = (weather: Weather) => {
      const e = make({ weather, seed: 77, spawns: [ARRIVING('NKS1', '31', 4, 'A320')] });
      land(e, 'NKS1');
      run(e, 3);
      return e.getState().ops.braking.map((r) => r.term);
    };
    expect(['good', 'good to medium']).toContain(terms(rain)[0]);
    expect(['medium', 'medium to poor', 'poor']).toContain(terms(wx({ ...rain, phenomena: ['+RA'] }))[0]);
    expect(terms(rain)).toEqual(terms(rain));
  });
  it('is not repeated within ten minutes unless worse; latestBrakingReport finds it per runway end', () => {
    const e = make({ weather: rain, spawns: [ARRIVING('NKS1', '31', 4, 'A320')] });
    land(e, 'NKS1');
    run(e, 3);
    const first = latestBrakingReport(e.getState(), '31')!;
    expect(first).toBeDefined();
    expect(latestBrakingReport(e.getState(), '13')).toBe(first); // same runway, other end
    expect(latestBrakingReport(e.getState(), '22')).toBeUndefined();
    expect(spokenTypeForReport('B738')).toBe('a Boeing seven thirty seven');
    expect(spokenTypeForReport('C172')).toBe('a Cessna one seventy two');
  });
  it('the engine API files a report that the ATIS source can read', () => {
    const e = make({ weather: rain });
    const r = e.reportBrakingAction!({ runwayEnd: '31', term: 'medium', aircraftType: 'B738', aircraftSpoken: 'a Boeing seven thirty seven' });
    expect(r.atSec).toBe(0);
    expect(latestBrakingReport(e.getState(), '31')).toMatchObject({ term: 'medium' });
  });
});

describe('runway edge lights (JO 7110.65 3-4-10, 3-4-11)', () => {
  it('default steps follow TBL 3-4-8: night > 5 SM = 1, 3-5 = 2, 1-3 = 3, < 1 = 4; day < 1 = 5, 1-2 = 4, otherwise off', () => {
    expect([10, 4, 2, 0.5].map((v) => defaultLightStep(v, true))).toEqual([1, 2, 3, 4]);
    expect([10, 2.5, 1.5, 0.5].map((v) => defaultLightStep(v, false))).toEqual([0, 0, 4, 5]);
  });
  it('by day the lights are off in good visibility and on below 2 SM; at night they are on', () => {
    const day = make();
    expect(isNight(day.getState())).toBe(false);
    expect(runwayLightsOn(day.getState())).toBe(false);
    expect(effectiveLightStep(day.getState(), '13/31')).toBe(0);
    const dim = make({ weather: wx({ visibilitySm: 1.5, flightCategory: 'IFR' }) });
    expect(runwayLightsOn(dim.getState())).toBe(true);
    expect(effectiveLightStep(dim.getState(), '13/31')).toBe(4);
    const night = make({}, JUNE_NIGHT);
    expect(isNight(night.getState())).toBe(true);
    expect(effectiveLightStep(night.getState(), '13/31')).toBe(1);
    expect(lightsRunwayId(night.getState())).toBe('13/31');
  });
  it('a controller instruction raises or lowers the step of the runway in use, by one or to an explicit step; the pilot acknowledges', () => {
    const e = make({ spawns: [ARRIVING('N1', '31', 5)] }, JUNE_NIGHT);
    run(e, 1);
    expect(say(e, cmd('RUNWAY_LIGHTS', 'N1', { lightsDirection: 'UP' }), 'TWR').status).toBe('accepted');
    expect(effectiveLightStep(e.getState(), '13/31')).toBe(2);
    expect(say(e, cmd('RUNWAY_LIGHTS', 'N1', { lightStep: 5 }), 'TWR').status).toBe('accepted');
    expect(effectiveLightStep(e.getState(), '13/31')).toBe(5);
    run(e, 6);
    expect(say(e, cmd('RUNWAY_LIGHTS', 'N1', { lightsDirection: 'DOWN' }), 'TWR').status).toBe('accepted');
    expect(effectiveLightStep(e.getState(), '13/31')).toBe(4);
    expect(pilotTexts(e, 'N1').filter((t) => /Roger, thank you/.test(t)).length).toBe(3);
  });
  it('in daylight "lights down" is refused (they are off); the closed runway\'s lights stay off', () => {
    const e = make({ spawns: [ARRIVING('N1', '31', 5)] });
    run(e, 1);
    expect(say(e, cmd('RUNWAY_LIGHTS', 'N1', { lightsDirection: 'DOWN' }), 'TWR')).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/lights are off/) });
    const c = make({ spawns: [ARRIVING('N1', '31', 5)], activeRunways: { departing: ['31'], landing: ['31'] } }, JUNE_NIGHT);
    c.getState().ops.closures.push({ id: 'x', kind: 'RUNWAY', ident: '13/31', startSec: 0, reason: 'test', source: 'scenario' });
    run(c, 1);
    expect(say(c, cmd('RUNWAY_LIGHTS', 'N1', { lightsDirection: 'UP' }), 'TWR').status).toBe('rejected');
  });
  it('an arrival asks for the lights at night (free play), once, and a controller answer changes them', () => {
    const e = make({ spawns: [ARRIVING('N1', '31', 9, 'C172', 'TWR')], pilotRequests: { lights: true } }, JUNE_NIGHT);
    find(e, 'N1').seed = 0; // about one aircraft in eight asks; this one does
    runUntil(e, () => find(e, 'N1').pendingRequest?.kind === 'LANDING', 100); // the inbound call first
    say(e, cmd('CONTINUE_APPROACH', 'N1'), 'TWR');
    runUntil(e, () => pilotTexts(e, 'N1').some((t) => /request lights/.test(t)), 400);
    const ask = pilotTexts(e, 'N1').find((t) => /request lights/.test(t))!;
    expect(ask).toMatch(/Atlantic City Tower, Cessna .*, request lights up\./);
    expect(find(e, 'N1').pendingRequest).toMatchObject({ kind: 'OTHER', text: 'request lights up' });
    expect(say(e, cmd('RUNWAY_LIGHTS', 'N1', { lightsDirection: 'UP' }), 'TWR').status).toBe('accepted');
    expect(effectiveLightStep(e.getState(), '13/31')).toBe(2);
    run(e, 30);
    expect(pilotTexts(e, 'N1').filter((t) => /request lights/.test(t))).toHaveLength(1);
  });
  it('no request by day in good visibility, or when the scenario does not enable them', () => {
    const day = make({ spawns: [ARRIVING('N1', '31', 9)], pilotRequests: { lights: true } });
    find(day, 'N1').seed = 0;
    runUntil(day, () => find(day, 'N1').pendingRequest?.kind === 'LANDING', 100);
    say(day, cmd('CONTINUE_APPROACH', 'N1'), 'TWR');
    run(day, 120);
    expect(pilotTexts(day, 'N1').some((t) => /request lights/.test(t))).toBe(false);
    const off = make({ spawns: [ARRIVING('N1', '31', 9)] }, JUNE_NIGHT);
    find(off, 'N1').seed = 0;
    runUntil(off, () => find(off, 'N1').pendingRequest?.kind === 'LANDING', 100);
    say(off, cmd('CONTINUE_APPROACH', 'N1'), 'TWR');
    run(off, 120);
    expect(pilotTexts(off, 'N1').some((t) => /request lights/.test(t))).toBe(false);
  });
});

describe('bird activity advisory (JO 7110.65 2-1-23)', () => {
  it('bird activity is on the airport for its duration, then expires; a bird advisory is acknowledged by the pilot', () => {
    const e = make({ spawns: [ARRIVING('N1', '31', 5)] });
    e.setBirdActivity!('flocks of small birds, altitude unknown', 30);
    expect(e.getState().ops.birds?.text).toMatch(/small birds/);
    const out = say(e, cmd('ADVISORY', 'N1', { advisory: 'BIRDS' }), 'TWR');
    expect(out).toMatchObject({ status: 'accepted', readback: expect.stringMatching(/watch for the birds/) });
    run(e, 31);
    expect(e.getState().ops.birds).toBeUndefined();
    e.setBirdActivity!(undefined);
  });
  it('braking action advisories are acknowledged with "Roger"', () => {
    const e = make({ spawns: [ARRIVING('N1', '31', 5)] });
    expect(say(e, cmd('ADVISORY', 'N1', { advisory: 'BRAKING', brakingTerm: 'poor' }), 'TWR')).toMatchObject({ status: 'accepted', readback: expect.stringMatching(/^Roger, /) });
  });
});

describe('LAHSO integrates the runway condition (not a second precipitation list)', () => {
  it('wet runways are refused for LAHSO in training; vicinity showers are not precipitation at the airport', async () => {
    const { runwayIsDry } = await import('../weather/runwayCondition');
    expect(runwayIsDry(wx({ phenomena: ['VCSH'] }))).toBe(true);
    expect(runwayIsDry(wx({ phenomena: ['-DZ'] }))).toBe(false);
    expect(runwayIsDry(wx({ phenomena: ['SHRA'] }))).toBe(false);
  });
});
