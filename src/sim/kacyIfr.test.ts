/**
 * Integration: IFR arrivals and an IFR departure against the REAL KACY dataset (read-only import).
 * Fixes come from airport.navaids, procedures from airport.procedures (see src/airport/kacy).
 */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import type { SimulationEngine } from './api';
import { createEngine } from './engine';
import type { Scenario, ScenarioAircraftSpawn } from './types';
import { cmd, HOLDING, makeScenario, pilotTexts, run, runUntil, say, ALL_POSITIONS } from './__fixtures__/testHelpers';
import { alongCross, findRunwayEnd } from './runways';
import { mToNm } from './geo';
import { matchingProcedures, analyzeProcedure } from './approach';
import { bearingToFixMag, distanceToFixNm } from './navigation';

const kacy = loadKacy();

function engineFor(spawns: ScenarioAircraftSpawn[], over: Partial<Scenario> = {}): SimulationEngine {
  return createEngine({ airport: kacy, scenario: makeScenario({ controllerPositions: ALL_POSITIONS, spawns, mode: 'training', ...over }), readbackErrorRate: 0 });
}

const arrival = (callsign: string, fix: string, route: string[], runwayEnd: string, altitudeFt: number, speedKt = 170): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP',
  start: { kind: 'at_fix', fix, altitudeFt, speedKt, route, runwayEnd },
});

/** Approach clearance, handoff to Tower on final, landing clearance, rollout. Returns the aircraft for further checks. */
function flyApproach(e: SimulationEngine, callsign: string, type: 'ILS' | 'RNAV', rwy: string) {
  const ac = Object.values(e.getState().aircraft).find((a) => a.callsign === callsign)!;
  run(e, 3);
  expect(ac.frequencyId).toBe('APP');
  expect(ac.frequencyMhz).toBe(124.6);
  const r = say(e, cmd('APPROACH', callsign, { approachType: type, runwayEnd: rwy }), 'APP');
  expect(r.status).toBe('accepted');
  let handed = false;
  let landed = false;
  const dt = e.getState().clock.dtSec;
  const g = findRunwayEnd(kacy, rwy)!;
  for (let i = 0; i < Math.round(1500 / dt) && ac.phase !== 'ROLLOUT'; i++) {
    e.step();
    const d = mToNm(-alongCross(g, ac.pos).along);
    if (!handed && ac.phase === 'FINAL' && d < 7) {
      handed = true;
      expect(say(e, cmd('CONTACT_FREQUENCY', callsign, { frequencyId: 'TWR' }), 'APP').status).toBe('accepted');
    }
    if (!landed && ac.frequencyId === 'TWR' && ac.phase === 'FINAL' && d < 6.5) {
      landed = true;
      expect(say(e, cmd('LAND', callsign, { runwayEnd: rwy }), 'TWR').status).toBe('accepted');
    }
    expect(e.getState().conflicts).toHaveLength(0);
  }
  expect(ac.phase).toBe('ROLLOUT');
  expect(e.getState().events.some((x) => x.kind === 'GO_AROUND')).toBe(false);
  expect(e.getState().events.some((x) => new RegExp(`${callsign} touched down runway ${rwy}`).test(x.text))).toBe(true);
  return ac;
}

describe('KACY procedures as the engine reads them', () => {
  it('ILS 13: CARYL (IF) -> MAYBN (FAF) with VCN as the feeder; ILS 31: STEVV -> PRSTY; RNAV 22: KOPCE -> FLDER -> EFEWY', () => {
    const ils13 = analyzeProcedure(kacy, matchingProcedures(kacy, 'ILS', '13')[0], findRunwayEnd(kacy, '13')!);
    expect(ils13.procedure.name).toBe('ILS Z OR LOC Z RWY 13');
    expect(ils13.feeders).toEqual(['VCN']);
    expect(ils13.onCourse.map((f) => f.id)).toEqual(['CARYL', 'MAYBN']);
    expect(ils13.faf?.id).toBe('MAYBN');
    expect(mToNm(ils13.faf!.dM)).toBeCloseTo(4.55, 1);
    const ils31 = analyzeProcedure(kacy, matchingProcedures(kacy, 'ILS', '31')[0], findRunwayEnd(kacy, '31')!);
    expect(ils31.onCourse.map((f) => f.id)).toEqual(['STEVV', 'PRSTY']);
    expect(ils31.faf?.id).toBe('PRSTY'); // SMITS (missed approach hold) is not flown
    const rnav22 = analyzeProcedure(kacy, matchingProcedures(kacy, 'RNAV', '22')[0], findRunwayEnd(kacy, '22')!);
    expect(rnav22.feeders).toEqual(['PIDVE']);
    expect(rnav22.onCourse.map((f) => f.id)).toEqual(['KOPCE', 'FLDER', 'EFEWY']);
    expect(rnav22.faf?.id).toBe('EFEWY');
    // missed approach fixes never become part of the approach
    const rnavY13 = analyzeProcedure(kacy, matchingProcedures(kacy, 'RNAV', '13')[0], findRunwayEnd(kacy, '13')!);
    expect(rnavY13.onCourse.map((f) => f.id)).not.toContain('RODDI');
    expect(rnavY13.onCourse.map((f) => f.id)).not.toContain('JURAD');
  });

  it('approach availability matches the charts: ILS only for 13 and 31, RNAV for 4/22/13/31, VOR for 4/31', () => {
    for (const rwy of ['13', '31']) expect(matchingProcedures(kacy, 'ILS', rwy).length, `ILS ${rwy}`).toBeGreaterThan(0);
    for (const rwy of ['4', '22']) {
      expect(matchingProcedures(kacy, 'ILS', rwy), `ILS ${rwy}`).toHaveLength(0);
      expect(matchingProcedures(kacy, 'LOC', rwy), `LOC ${rwy}`).toHaveLength(0);
    }
    for (const rwy of ['4', '22', '13', '31']) expect(matchingProcedures(kacy, 'RNAV', rwy).length, `RNAV ${rwy}`).toBeGreaterThan(0);
    for (const rwy of ['4', '31']) expect(matchingProcedures(kacy, 'VOR', rwy).length, `VOR ${rwy}`).toBeGreaterThan(0);
    for (const rwy of ['13', '22']) expect(matchingProcedures(kacy, 'VOR', rwy), `VOR ${rwy}`).toHaveLength(0);
  });

  it('fix helpers on real data: Cedar Lake is VCN, bearing/distance from the ARP', () => {
    expect(distanceToFixNm(kacy, { x: 0, y: 0 }, 'Cedar Lake')).toBeCloseTo(18.7, 0);
    const brg = bearingToFixMag(kacy, { x: 0, y: 0 }, 'VCN')!;
    expect(brg).toBeGreaterThan(280);
    expect(brg).toBeLessThan(310); // west-north-west of the field
  });
});

describe('KACY arrivals flown fix to fix', () => {
  it('ILS 13 from CARYL via MAYBN, LAND from Tower, touchdown on 13', () => {
    const e = engineFor([arrival('NKS451', 'CARYL', ['CARYL', 'MAYBN'], '13', 3000)], { activeRunways: { departing: ['13'], landing: ['13'] } });
    expect(runUntil(e, () => pilotTexts(e).length > 0, 10)).toBe(true);
    expect(pilotTexts(e)[0]).toBe('Atlantic City Approach, Spirit four fifty one, level three thousand, information alpha.');
    const ac = flyApproach(e, 'NKS451', 'ILS', '13');
    expect(ac.assignedRunwayEnd).toBe('13');
    expect(pilotTexts(e)).toContain('Atlantic City Approach, Spirit four fifty one, established on the ILS runway one three.');
    expect(pilotTexts(e)).toContain('Cleared ILS runway one three approach, Spirit four fifty one');
  });

  it('ILS 31 from STEVV via PRSTY', () => {
    const e = engineFor([arrival('AAL212', 'STEVV', ['STEVV', 'PRSTY'], '31', 3000)], { activeRunways: { departing: ['31'], landing: ['31'] } });
    flyApproach(e, 'AAL212', 'ILS', '31');
  });

  it('RNAV 22 from KOPCE via FLDER and EFEWY', () => {
    const e = engineFor([arrival('DAL88', 'KOPCE', ['KOPCE', 'FLDER', 'EFEWY'], '22', 3000, 160)], { activeRunways: { departing: ['22'], landing: ['22'] } });
    flyApproach(e, 'DAL88', 'RNAV', '22');
  });

  it('ILS to 4 and 22 is refused, RNAV 22 is accepted, with the real procedure list', () => {
    const e = engineFor([arrival('NKS451', 'KOPCE', ['KOPCE', 'FLDER', 'EFEWY'], '22', 3000)]);
    for (const rwy of ['22', '4']) {
      const r = say(e, cmd('APPROACH', 'NKS451', { approachType: 'ILS', runwayEnd: rwy }), 'APP');
      expect(r.status).toBe('rejected');
    }
    expect(say(e, cmd('APPROACH', 'NKS451', { approachType: 'RNAV', runwayEnd: '22' }), 'APP').status).toBe('accepted');
  });
});

describe('KACY IFR departure to KPHL via the ATLANTIC CITY THREE', () => {
  it('clearance -> taxi -> takeoff -> Departure: radar contact, climb, direct Coyle (CYN), handled', () => {
    const spec: ScenarioAircraftSpawn = {
      atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: true, initialFrequencyId: 'CLNC',
      start: { kind: 'parked', parkingId: 'GATE-1' },
      flightPlan: { flightRules: 'IFR', origin: 'KACY', destination: 'KPHL', cruiseAltitudeFt: 10000, route: ['CYN'] },
    };
    const e = engineFor([spec], { activeRunways: { departing: ['13'], landing: ['13'] } });
    const ac = Object.values(e.getState().aircraft)[0];
    expect(runUntil(e, () => ac.pendingRequest?.kind === 'IFR_CLEARANCE', 30)).toBe(true);
    expect(pilotTexts(e)[0]).toBe('Atlantic City Clearance Delivery, Spirit four fifty one, IFR to Philadelphia, with information alpha, ready to copy.');

    const clr = say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: {} }), 'CLNC');
    expect(clr.status).toBe('accepted');
    if (clr.status === 'accepted') {
      expect(clr.clearance.ifr).toMatchObject({ destination: 'KPHL', departureProcedure: 'ATLANTIC CITY THREE', initialAltitudeFt: 2000, expectAltitudeFt: 10000, departureFrequencyMhz: 134.25 }); // CYN is north of the airport: the north departure sector
      expect(clr.readback).toMatch(/^Cleared to Philadelphia airport, Atlantic City Three departure, radar vectors, maintain two thousand, expect one zero thousand, one zero minutes after departure, departure frequency one three four point two five, squawk [a-z ]+, Spirit four fifty one$/);
    }
    expect(runUntil(e, () => ac.pendingRequest?.kind === 'TAXI', 40)).toBe(true);
    expect(ac.frequencyId).toBe('GND');
    // the full-length hold for 13 via Bravo, stopping short of the crossing runway 4/22
    expect(say(e, cmd('TAXI', 'NKS451', { destination: 'RWY13', route: ['B'], holdShort: ['4/22'] }), 'GND').status).toBe('accepted');
    expect(runUntil(e, () => ac.pendingRequest?.kind === 'CROSSING', 900)).toBe(true);
    expect(say(e, cmd('CROSS_RUNWAY', 'NKS451', { crossRunwayId: '4/22' }), 'GND').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT' && ac.groundSpeedKt < 0.1 && ac.pendingRequest?.kind === 'FREQUENCY_CHANGE', 900)).toBe(true);
    expect(say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'TWR' }), 'GND').status).toBe('accepted');
    run(e, 8);
    const to = say(e, cmd('TAKEOFF', 'NKS451', { runwayEnd: '13' }), 'TWR');
    if (to.status !== 'accepted') throw new Error(JSON.stringify(to) + ' ' + ac.phase);
    expect(runUntil(e, () => ac.phase === 'DEPARTURE', 300)).toBe(true);
    const handoff = say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'DEP' }), 'TWR'); // "contact departure": the sector of the clearance
    expect(handoff.status).toBe('accepted');
    if (handoff.status === 'accepted') expect(handoff.readback).toBe('Departure one three four point two five, Spirit four fifty one');
    expect(runUntil(e, () => ac.frequencyId === 'DEP-N' && ac.pendingRequest?.kind === 'OTHER', 20)).toBe(true);
    expect(ac.frequencyMhz).toBe(134.25);
    expect(pilotTexts(e).pop()).toMatch(/^Atlantic City Departure, Spirit four fifty one, .*(climbing )?two thousand\.$/);
    expect(say(e, cmd('RADAR_CONTACT', 'NKS451'), 'DEP').status).toBe('accepted');
    expect(say(e, cmd('ALTITUDE', 'NKS451', { altitudeFt: 10000 }), 'DEP').status).toBe('accepted');
    const d = say(e, cmd('DIRECT_FIX', 'NKS451', { fix: 'Coyle' }), 'DEP');
    expect(d.status).toBe('accepted');
    if (d.status === 'accepted') expect(d.readback).toBe('Direct Coyle, Spirit four fifty one');
    expect(ac.nav).toEqual({ fixes: ['CYN'], index: 0, mode: 'direct' });
    expect(runUntil(e, () => !Object.values(e.getState().aircraft).includes(ac), 2400)).toBe(true);
    const s = e.getState();
    expect(s.score.aircraftHandled).toBe(1);
    expect(s.score.unsafeInstructions + s.score.runwayIncursions + s.score.separationViolations).toBe(0);
  });
});

describe('A320 takeoff distance on KACY 4/22 (6,145 ft)', () => {
  const tryTakeoff = (node: string, end: string) => {
    const e = createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: [end], landing: [end] }, spawns: [HOLDING('NKS451', node, end, 'A320')] }) });
    run(e, 4);
    return e.applyCommand(cmd('TAKEOFF', 'NKS451', { runwayEnd: end }));
  };

  it('accepted from the full length of 22 and 4; refused from an intersection with < 5,000 ft remaining', () => {
    expect(tryTakeoff('HP4-22-A-2', '22').status).toBe('accepted');
    expect(tryTakeoff('HP4-22-A-1', '4').status).toBe('accepted');
    const short = tryTakeoff('HP4-22-B-1', '22');
    expect(short.status).toBe('rejected');
    if (short.status === 'rejected') expect(short.reason).toMatch(/Only 3\d{3} ft of runway 22 remain.*needs about 5000 ft/);
    const short4 = tryTakeoff('HP4-22-D-1', '4');
    expect(short4.status).toBe('rejected');
    if (short4.status === 'rejected') expect(short4.reason).toMatch(/Only 4\d{3} ft of runway 4 remain/);
  });
});

describe('departure frequency by sector (KACY: south 124.6 = 130-309, north 134.25 = 310-129, magnetic from the airport)', () => {
  it('data: the sector bearings are on the DEP / APP frequencies', () => {
    const f = (id: string) => kacy.frequencies.find((x) => x.id === id)!;
    expect(f('DEP').sectorBearings).toEqual({ fromDeg: 130, toDeg: 309 });
    expect(f('DEP-N').sectorBearings).toEqual({ fromDeg: 310, toDeg: 129 });
  });

  it.each([
    ['CYN', 134.25], ['COL', 134.25], ['RBV', 134.25], ['VCN', 124.6], ['SIE', 124.6], ['ENO', 124.6],
  ])('a flight plan whose first fix is %s gets departure frequency %s', (fix, mhz) => {
    const e = engineFor([{
      atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: true, initialFrequencyId: 'CLNC', start: { kind: 'parked', parkingId: 'GATE-1' },
      flightPlan: { flightRules: 'IFR', origin: 'KACY', destination: 'KPHL', cruiseAltitudeFt: 10000, route: [fix] },
    }]);
    const ac = Object.values(e.getState().aircraft)[0];
    expect(runUntil(e, () => ac.pendingRequest?.kind === 'IFR_CLEARANCE', 30)).toBe(true);
    const r = say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: {} }), 'CLNC');
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') {
      expect(r.clearance.ifr?.departureFrequencyMhz).toBe(mhz);
      expect(r.readback).toContain(`departure frequency ${mhz === 134.25 ? 'one three four point two five' : 'one two four point six'},`);
    }
  });

  it('a stated departure frequency is respected; a route without a resolvable fix keeps the first DEP frequency', () => {
    const mk = (route: string[]) => engineFor([{
      atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: true, initialFrequencyId: 'CLNC', start: { kind: 'parked', parkingId: 'GATE-1' },
      flightPlan: { flightRules: 'IFR', origin: 'KACY', destination: 'KPHL', cruiseAltitudeFt: 10000, route },
    }]);
    const e1 = mk(['CYN']);
    runUntil(e1, () => Object.values(e1.getState().aircraft)[0].pendingRequest?.kind === 'IFR_CLEARANCE', 30);
    const r1 = say(e1, cmd('IFR_CLEARANCE', 'NKS451', { ifr: { departureFrequencyMhz: 124.6 } }), 'CLNC');
    expect(r1.status === 'accepted' && r1.clearance.ifr?.departureFrequencyMhz).toBe(124.6);
    const e2 = mk(['NOWHERE']);
    runUntil(e2, () => Object.values(e2.getState().aircraft)[0].pendingRequest?.kind === 'IFR_CLEARANCE', 30);
    const r2 = say(e2, cmd('IFR_CLEARANCE', 'NKS451', { ifr: {} }), 'CLNC');
    expect(r2.status === 'accepted' && r2.clearance.ifr?.departureFrequencyMhz).toBe(124.6);
  });
});
