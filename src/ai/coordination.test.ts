/**
 * AI controllers on the coordination channel: Ground asks Tower and waits, Tower answers from its own safety view, rescinds,
 * Departure releases and points out; nothing deadlocks. Real engine, real KACY, seeded.
 */
import { describe, expect, it } from 'vitest';
import { requestById } from '../sim/coordination';
import type { CoordMessage } from '../sim/coordination';
import type { SimulationEngineExtras } from '../sim/engineExtras';
import type { ScenarioAircraftSpawn, SimulationState } from '../sim/types';
import { findRunwayEnd } from '../sim/runways';
import { cmd, createHarness, IFR_ARR, IFR_DEP, kacy } from './testkit';
import type { Harness } from './testkit';

const api = (h: Harness) => (h.engine as unknown as SimulationEngineExtras).coordination!;
const co = (h: Harness): SimulationState['coordination'] => h.engine.getState().coordination;
const msgs = (h: Harness, kind?: CoordMessage['kind']) => (co(h)?.messages ?? []).filter((m) => !kind || m.kind === kind);
const accepted = (h: Harness, kind: string, cs: string) => h.events.filter((e) => e.kind === 'COMMAND_ACCEPTED' && e.callsign === cs && e.data?.kind === kind);


/** A scripted human Ground: taxis departures to 13 via Bravo, asks Tower before crossing the active 4/22 (once), crosses on the approval, hands over to Tower, parks arrivals. */
function groundScript(h: Harness) {
  return () => {
    for (const ac of Object.values(h.engine.getState().aircraft)) {
      if (ac.frequencyMhz !== 121.9 || ac.radioState === 'TRANSMITTING') continue;
      const p = ac.pendingRequest?.kind;
      if (ac.isDeparture && p === 'TAXI') h.say('GND', cmd('TAXI', ac.callsign, { destination: 'RWY13', runwayEnd: '13', route: ['B'], holdShort: ['4/22'] }));
      else if (p === 'CROSSING' && ac.groundSpeedKt < 1) {
        if (!co(h)!.requests.some((r) => r.aircraftId === ac.id && r.topic === 'CROSSING')) api(h).request({ topic: 'CROSSING', from: 'GND', to: 'TWR', aircraftId: ac.id, runwayId: '4/22', source: 'player' });
        else h.say('GND', cmd('CROSS_RUNWAY', ac.callsign, { crossRunwayId: '4/22', runwayId: '4/22' }));
      } else if (ac.isDeparture && p === 'FREQUENCY_CHANGE') h.say('GND', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'TWR' }));
      else if (!ac.isDeparture && p === 'TAXI') h.say('GND', cmd('TAXI_TO_PARKING', ac.callsign, { destination: 'GATE' }));
    }
  };
}

const GA_TAXI = (cs = 'N60DX', parking = 'GA-3'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign: cs, type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: parking }, isDeparture: true, initialFrequencyId: 'GND', initialRequest: 'TAXI',
});

/** AI Ground, a human Tower that has not answered yet: one Cessna taxis to runway 13 via Bravo, crossing the (active) runway 4/22. */
function crossingSetup(extra: Partial<Parameters<typeof createHarness>[0]> = {}) {
  return createHarness({
    player: ['TWR'], ai: ['GND', 'CLNC', 'APP', 'DEP'], humanAnswers: false, activeRunways: { departing: ['13', '22'], landing: ['13'] },
    spawns: [GA_TAXI()], ...extra,
  });
}

describe('AI Ground asks Tower before crossing an active runway and waits', () => {
  const h = crossingSetup();
  // the player (Tower) is silent for 70 s after the first ask
  h.runUntil(() => msgs(h, 'CROSS_REQUEST').length > 0, 600);
  const firstAsk = h.now();
  h.run(70);

  it('makes one landline request to Tower, with the runway and the point, spoken through the controller voice flagged as landline', () => {
    const [first] = msgs(h, 'CROSS_REQUEST');
    expect(first.from).toBe('GND');
    expect(first.to).toBe('TWR');
    expect(first.text).toMatch(/^Tower, Ground, request cross runway 4 at [A-Z0-9]+ with Cessna six zero delta x-ray$/);
    expect(first.source).toBe('ai');
    const t = h.landline.find((x) => x.position === 'GND')!;
    expect(t.channel).toBe('landline');
    expect(t.toPosition).toBe('TWR');
    expect(t.spokenText).toMatch(/request cross runway four at/);
    expect(h.transmissions.some((x) => x.channel === 'landline')).toBe(false); // never mixed into the radio transmissions
  });

  it('the aircraft keeps holding short; the AI repeats the request at the documented interval, never twice in a row sooner', () => {
    expect(accepted(h, 'CROSS_RUNWAY', 'N60DX')).toHaveLength(0);
    const asks = msgs(h, 'CROSS_REQUEST');
    expect(asks.length).toBe(3); // at ~0 s, ~30 s, ~60 s after the first ask
    for (let i = 1; i < asks.length; i++) expect(asks[i].timeSec - asks[i - 1].timeSec).toBeGreaterThanOrEqual(30);
    expect(co(h)!.requests).toHaveLength(1);
    expect(co(h)!.requests[0].asks).toBe(3);
    expect(h.find('N60DX')!.pendingRequest?.kind).toBe('CROSSING');
    expect(h.now()).toBeGreaterThan(firstAsk + 69);
  });

  it('crosses within seconds of Tower\'s approval, uses the approval up, and the engine closes the crossing', () => {
    const r = co(h)!.requests[0];
    api(h).respond(r.id, 'approve', { by: 'TWR', source: 'player' });
    const t0 = h.now();
    expect(h.runUntil(() => accepted(h, 'CROSS_RUNWAY', 'N60DX').length === 1, 30)).toBe(true);
    expect(h.now() - t0).toBeLessThan(12);
    expect(requestById(h.engine.getState(), r.id)!.status).toMatch(/used|completed/);
    h.run(120);
    expect(requestById(h.engine.getState(), r.id)!.status).toBe('completed');
    expect(msgs(h).map((m) => m.kind).filter((k) => k !== 'CROSS_REQUEST')).toEqual(['CROSS_APPROVED', 'CROSS_COMPLETE']);
  });
});

describe('AI Tower answers Ground\'s crossing request from its own safety view', () => {
  /** A Cessna from the ramp taxis to the 13 hold; the arrival is `nm` out on final. The (human) Ground player never crosses by itself. */
  function towerSetup(arrivalNm: number | undefined, over: Partial<Parameters<typeof createHarness>[0]> = {}) {
    const arr: ScenarioAircraftSpawn[] = arrivalNm === undefined ? [] : [{
      atSec: 0, callsign: 'N88LA', type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', initialRequest: 'LANDING',
      start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 80, runwayEnd: '13', distanceNm: arrivalNm },
    }];
    return createHarness({ player: ['GND'], ai: ['TWR', 'CLNC', 'APP', 'DEP'], humanAnswers: false, activeRunways: { departing: ['13', '22'], landing: ['13'] }, spawns: [GA_TAXI(), ...arr], ...over });
  }
  /** The scripted human Ground: taxi, then ask Tower once the aircraft stands at the hold. */
  function groundPlayer(h: Harness) {
    return () => {
      const ac = h.find('N60DX');
      if (!ac) return;
      if (ac.pendingRequest?.kind === 'TAXI' && ac.isDeparture) h.say('GND', cmd('TAXI', ac.callsign, { destination: 'RWY13', runwayEnd: '13', route: ['B'], holdShort: ['4/22'] }));
      if (ac.pendingRequest?.kind === 'CROSSING' && ac.groundSpeedKt < 1) api(h).request({ topic: 'CROSSING', from: 'GND', to: 'TWR', aircraftId: ac.id, runwayId: '4/22', source: 'player' });
    };
  }

  it('approves a free runway ("cross runway four at ...") after the controller\'s reaction delay', () => {
    const h = towerSetup(undefined);
    const gp = groundPlayer(h);
    h.runUntil(() => msgs(h, 'CROSS_APPROVED').length > 0, 600, gp);
    const [req] = msgs(h, 'CROSS_REQUEST');
    const [ok] = msgs(h, 'CROSS_APPROVED');
    expect(ok.timeSec - req.timeSec).toBeGreaterThanOrEqual(2);
    expect(ok.timeSec - req.timeSec).toBeLessThanOrEqual(12);
    expect(ok.text).toMatch(/^Ground, Tower, cross runway 4 at [A-Z0-9]+$/);
    expect(ok.standard).toBe(true);
    expect(h.landline.find((x) => x.position === 'TWR')?.toPosition).toBe('GND');
  });

  const arrival = (nm: number): ScenarioAircraftSpawn => ({
    atSec: 0, callsign: 'N88LA', type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', initialRequest: 'LANDING',
    start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 80, runwayEnd: '13', distanceNm: nm },
  });

  it('with one landing aircraft cleared and nobody behind it: "cross runway four at ..., behind the landing ...", and the crossing waits for it', () => {
    const h = towerSetup(undefined);
    const gp = groundPlayer(h);
    h.runUntil(() => h.find('N60DX')?.pendingRequest?.kind === 'CROSSING' && h.find('N60DX')!.groundSpeedKt < 1, 600, () => { if (h.find('N60DX')?.pendingRequest?.kind === 'TAXI') gp(); });
    h.engine.spawnAircraft({ ...arrival(2.4), atSec: h.now() });
    gp();
    h.runUntil(() => msgs(h, 'CROSS_APPROVED').length > 0, 60);
    const ok = msgs(h, 'CROSS_APPROVED')[0];
    expect(ok.text).toBe('Ground, Tower, cross runway 4 at B, behind the landing N88LA'.replace('at B', `at ${co(h)!.requests[0].point}`).replace('N88LA', 'Cessna eight eight lima alpha'));
    expect(ok.standard).toBe(false);
    const r = co(h)!.requests[0];
    expect(r.afterCallsign).toBe('N88LA');
    // the engine will not let Ground use it before N88LA has landed and cleared the runway
    expect(h.say('GND', cmd('CROSS_RUNWAY', 'N60DX', { crossRunwayId: '4/22', runwayId: '4/22' })).status).toBe('rejected');
    h.runUntil(() => h.find('N88LA')?.onGround === true && !h.find('N88LA')!.occupyingRunways.length || !h.find('N88LA'), 300);
    expect(h.say('GND', cmd('CROSS_RUNWAY', 'N60DX', { crossRunwayId: '4/22', runwayId: '4/22' })).status).toBe('accepted');
  });

  it('with a second arrival close behind the first: "unable, traffic on a ... mile final, I\'ll call you back", then approves when the gap comes', () => {
    const h = towerSetup(undefined);
    const gp = groundPlayer(h);
    h.runUntil(() => h.find('N60DX')?.pendingRequest?.kind === 'CROSSING' && h.find('N60DX')!.groundSpeedKt < 1, 600, () => { if (h.find('N60DX')?.pendingRequest?.kind === 'TAXI') gp(); });
    h.engine.spawnAircraft({ ...arrival(2.4), atSec: h.now() });
    h.engine.spawnAircraft({ ...arrival(5), callsign: 'N77LB', atSec: h.now() });
    gp();
    h.runUntil(() => msgs(h, 'CROSS_STANDBY').length > 0 || msgs(h, 'CROSS_APPROVED').length > 0, 60);
    const standby = msgs(h, 'CROSS_STANDBY')[0];
    expect(standby?.text).toMatch(/^Ground, Tower, unable, traffic on a (one|two|three) mile final, I'll call you back$/);
    expect(standby.standard).toBe(false);
    expect(requestById(h.engine.getState(), standby.requestId!)!.status).toBe('standby');
    h.runUntil(() => msgs(h, 'CROSS_APPROVED').length > 0, 600);
    const ok = msgs(h, 'CROSS_APPROVED')[0];
    expect(ok).toBeDefined();
    expect(ok.timeSec).toBeGreaterThan(standby.timeSec);
    expect(ok.requestId).toBe(standby.requestId);
  });
});

describe('AI Tower rescinds an approval that was not used when traffic comes inside the window', () => {
  it('"hold short runway four, traffic on final, disregard the crossing"; Ground then asks again and the aircraft never moves', () => {
    const h = createHarness({
      player: ['GND'], ai: ['TWR', 'CLNC', 'APP', 'DEP'], humanAnswers: false, activeRunways: { departing: ['13', '22'], landing: ['13'] }, spawns: [{
        atSec: 0, callsign: 'N60DX', type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: 'GA-3' }, isDeparture: true, initialFrequencyId: 'GND', initialRequest: 'TAXI',
      }],
    });
    const ac = () => h.find('N60DX')!;
    h.runUntil(() => ac().pendingRequest?.kind === 'TAXI', 60);
    h.say('GND', cmd('TAXI', 'N60DX', { destination: 'RWY13', runwayEnd: '13', route: ['B'], holdShort: ['4/22'] }));
    h.runUntil(() => ac().pendingRequest?.kind === 'CROSSING' && ac().groundSpeedKt < 1, 600);
    const arr = h.engine.spawnAircraft({
      atSec: h.now(), callsign: 'AAL88', type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'TWR', initialRequest: 'LANDING',
      start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 140, runwayEnd: '13', distanceNm: 8 },
    });
    // Tower approves while the arrival is 8 nm out (a free runway) ...
    const r = api(h).request({ topic: 'CROSSING', from: 'GND', to: 'TWR', aircraftId: ac().id, runwayId: '4/22', source: 'player' })!;
    api(h).respond(r.id, 'approve', { by: 'TWR', source: 'ai' });
    expect(r.status).toBe('approved');
    // ... and the arrival is suddenly close (a speed-up, a short approach): the AI Tower takes the approval back.
    const g = findRunwayEnd(kacy, '13')!;
    arr.pos = { x: g.end.threshold.x - g.dir.x * 2.2 * 1852, y: g.end.threshold.y - g.dir.y * 2.2 * 1852 };
    h.runUntil(() => msgs(h, 'CROSS_RESCINDED').length > 0, 120);
    const kinds = msgs(h).map((m) => m.kind);
    expect(kinds.slice(0, 3)).toEqual(['CROSS_REQUEST', 'CROSS_APPROVED', 'CROSS_RESCINDED']);
    expect(msgs(h, 'CROSS_RESCINDED')[0].source).toBe('ai');
    expect(msgs(h, 'CROSS_RESCINDED')[0].text).toMatch(/^Ground, Tower, hold short runway 4, traffic on final, disregard the crossing$/);
    expect(co(h)!.requests[0].status).toBe('rescinded');
    expect(h.say('GND', cmd('CROSS_RUNWAY', 'N60DX', { crossRunwayId: '4/22', runwayId: '4/22' })).status).toBe('rejected');
    expect(accepted(h, 'CROSS_RUNWAY', 'N60DX')).toHaveLength(0);
    expect(h.landline.filter((t) => t.position === 'TWR').map((t) => t.toPosition)).toContain('GND');
  });
});

describe('departure release between Tower and Departure', () => {
  const ifrSpawn = [IFR_DEP('NKS451', 'GATE-1', ['VCN'])];
  const groundPlayer = groundScript;

  it('AI Tower asks AI Departure, gets "released", clears the takeoff and says "rolling"; the order of the messages is request, released, rolling', () => {
    const h = createHarness({ player: ['GND'], spawns: ifrSpawn, humanAnswers: false });
    h.runUntil(() => Object.keys(h.engine.getState().aircraft).length === 0 && h.now() > 100, 2400, groundPlayer(h));
    const kinds = msgs(h).filter((m) => m.topic === 'RELEASE' || m.kind === 'ROLLING').map((m) => m.kind);
    expect(kinds).toEqual(['RELEASE_REQUEST', 'RELEASED', 'ROLLING']);
    const [rq, rel, roll] = msgs(h).filter((m) => m.topic === 'RELEASE' || m.kind === 'ROLLING');
    expect(rq.text).toBe('Departure, Tower, request release Spirit four fifty one');
    expect(rel.text).toBe('Tower, Departure, Spirit four fifty one released');
    expect(rel.standard).toBe(true);
    expect(roll.text).toMatch(/^Departure, Tower, Spirit four fifty one rolling runway 13$/);
    const takeoff = accepted(h, 'TAKEOFF', 'NKS451')[0];
    expect(rel.timeSec).toBeGreaterThan(rq.timeSec);
    expect(takeoff.timeSec).toBeGreaterThan(rel.timeSec);
    expect(takeoff.timeSec - rel.timeSec).toBeLessThan(15);
    expect(h.engine.getState().score.coordinationErrors ?? 0).toBe(0);
    expect(h.engine.getState().score.runwayIncursions + h.engine.getState().score.unsafeInstructions).toBe(0);
  });

  it('with a silent human on Departure the aircraft holds, Tower asks again at the interval, and the takeoff follows the answer', () => {
    const h = createHarness({ player: ['GND', 'APP', 'DEP'], ai: ['TWR', 'CLNC'], spawns: ifrSpawn, humanAnswers: false });
    h.runUntil(() => msgs(h, 'RELEASE_REQUEST').length > 0, 1500, groundPlayer(h));
    h.run(75, groundPlayer(h));
    const asks = msgs(h, 'RELEASE_REQUEST');
    expect(asks.length).toBe(3);
    expect(accepted(h, 'TAKEOFF', 'NKS451')).toHaveLength(0);
    expect(h.find('NKS451')!.phase).toBe('HOLDING_SHORT');
    const r = co(h)!.requests.find((x) => x.topic === 'RELEASE')!;
    api(h).respond(r.id, 'approve', { by: 'DEP', source: 'player' });
    expect(h.runUntil(() => accepted(h, 'TAKEOFF', 'NKS451').length === 1, 30, groundPlayer(h))).toBe(true);
  });

  it('an expired release is asked for again instead of deadlocking', () => {
    const h = createHarness({ player: ['GND', 'APP', 'DEP'], ai: ['TWR', 'CLNC'], spawns: ifrSpawn, humanAnswers: false });
    h.runUntil(() => msgs(h, 'RELEASE_REQUEST').length > 0, 1500, groundPlayer(h));
    const r = co(h)!.requests.find((x) => x.topic === 'RELEASE')!;
    // a runway conflict keeps the takeoff from being issued while the release runs out: block it with an arrival on short final
    api(h).respond(r.id, 'approve', { by: 'DEP', source: 'player' });
    r.expiresSec = h.now() + 1; // the release runs out at once
    h.run(3);
    expect(r.status === 'expired' || r.status === 'used').toBe(true);
    if (r.status === 'expired') {
      h.run(40, groundPlayer(h));
      expect(co(h)!.requests.filter((x) => x.topic === 'RELEASE').length).toBeGreaterThan(1);
    }
  });

  it('AI Departure says "hold for release" during a missed approach and releases afterwards', () => {
    const h = createHarness({ player: ['GND'], spawns: [...ifrSpawn, IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 4000, { atSec: 0 })], humanAnswers: false });
    h.runUntil(() => msgs(h, 'RELEASE_REQUEST').length > 0, 1500, groundPlayer(h));
    const ar = h.find('AAL212');
    if (ar) { ar.phase = 'GO_AROUND'; ar.onGround = false; }
    h.run(20, groundPlayer(h));
    expect(msgs(h, 'HOLD_FOR_RELEASE').length).toBeGreaterThanOrEqual(1);
    expect(msgs(h, 'HOLD_FOR_RELEASE')[0].text).toBe('Tower, Departure, Spirit four fifty one hold for release, missed approach in progress');
  });
});

describe('point-outs and traffic information between radar positions', () => {
  it('AI Departure points a departure out to AI Approach when it climbs close to an arrival; Approach answers "point out approved"', () => {
    const h = createHarness({ player: ['GND'], spawns: [IFR_DEP('NKS451', 'GATE-1', ['VCN'])], humanAnswers: false, ai: ['TWR', 'CLNC', 'APP', 'DEP'] });
    const gp = groundScript(h);
    h.runUntil(() => { const ac = h.find('NKS451'); return !!ac && !ac.onGround && ac.altitudeFt > 1500; }, 2400, gp);
    // an arrival inbound over the same spot
    const dep = h.find('NKS451')!;
    const arr = h.engine.spawnAircraft({
      atSec: h.now(), callsign: 'AAL212', type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP', initialRequest: 'APPROACH',
      start: { kind: 'at_fix', fix: 'CARYL', altitudeFt: 3000, speedKt: 170, route: ['CARYL', 'MAYBN'], runwayEnd: '13' },
    });
    arr.pos = { x: dep.pos.x + 2000, y: dep.pos.y + 1500 };
    h.runUntil(() => msgs(h, 'POINT_OUT_APPROVED').length > 0, 60, gp);
    const po = msgs(h, 'POINT_OUT')[0];
    expect(po.from).toBe('DEP');
    expect(po.to).toBe('APP');
    expect(po.text).toMatch(/^Approach, Departure, point out, .+ of .+, Spirit four fifty one, \d+/);
    expect(po.standard).toBe(true);
    expect(msgs(h, 'POINT_OUT_APPROVED')[0].text).toBe('Departure, Approach, Spirit four fifty one point out approved');
    expect(co(h)!.requests.find((r) => r.topic === 'POINT_OUT')!.status).toBe('completed');
  });
});

describe('the whole coordination run is deterministic and never deadlocks', () => {
  const run = () => {
    const h = createHarness({
      player: ['GND'], spawns: [IFR_DEP('NKS451', 'GATE-1', ['VCN']), IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 4000, { atSec: 200 })], humanAnswers: false,
    });
    h.runUntil(() => h.now() > 300 && Object.keys(h.engine.getState().aircraft).length === 0, 2800, groundScript(h));
    return h;
  };
  it('both flights are handled, nothing unsafe, and two runs give identical logs', () => {
    const a = run();
    expect(Object.keys(a.engine.getState().aircraft)).toHaveLength(0);
    const s = a.engine.getState().score;
    expect(s.runwayIncursions + s.unsafeInstructions + s.separationViolations).toBe(0);
    const b = run();
    const sig = (x: Harness) => JSON.stringify([x.events.map((e) => `${e.id}|${e.timeSec}|${e.kind}|${e.text}`), x.landline]);
    expect(sig(b)).toBe(sig(a));
  });
});
