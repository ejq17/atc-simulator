import { describe, expect, it } from 'vitest';
import { AT_FIX, cmd, find, has, IFR_DEPARTURE, IFR_HOLDING, GA_PARKED, ifrScenario, makeEngine, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import type { SimulationEngine } from './api';
import type { Aircraft } from './types';
import { headingDiff, mToNm } from './geo';
import { findRunwayEnd } from './runways';
import { createTestAirport } from './__fixtures__/testAirport';
import { departureProcedureName, isAssignableSquawk } from './ifr';
import { IFR_TAXI_REQUEST_DELAY_SEC } from './commandExecutor';

const airport = createTestAirport();

function clearedDeparture(over: Parameters<typeof makeEngine>[0] = {}): { e: SimulationEngine; ac: Aircraft } {
  const e = makeEngine({ ...over, scenario: ifrScenario([IFR_DEPARTURE()], over.scenario) });
  const ac = find(e, 'NKS451');
  expect(runUntil(e, () => ac.pendingRequest?.kind === 'IFR_CLEARANCE', 30)).toBe(true);
  return { e, ac };
}

describe('IFR clearance request (Clearance Delivery)', () => {
  it('an IFR departure calls Clearance Delivery first with its destination and the ATIS letter', () => {
    const { e, ac } = clearedDeparture();
    expect(ac.phase).toBe('PARKED');
    expect(ac.frequencyId).toBe('CLNC');
    expect(pilotTexts(e)).toEqual(['Atlantic City Clearance, Spirit four fifty one, IFR to Philadelphia, with information alpha, ready to copy.']);
    expect(ac.pendingRequest).toMatchObject({ kind: 'IFR_CLEARANCE' });
    // it does not ask for taxi until it has its clearance
    run(e, 60);
    expect(ac.phase).toBe('PARKED');
    expect(pilotTexts(e)).toHaveLength(1);
  });

  it('VFR departures are unchanged: no clearance request, they ask for taxi', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED('N723EJ', 'GA1', 'GND')] } });
    expect(runUntil(e, () => find(e, 'N723EJ').pendingRequest?.kind === 'TAXI', 30)).toBe(true);
    expect(pilotTexts(e)[0]).toMatch(/ready to taxi, VFR departure/);
  });

  it('a spec flight plan marked VFR does not need a clearance either', () => {
    const spec = GA_PARKED('N723EJ', 'GA1', 'GND', { flightPlan: { flightRules: 'VFR', origin: 'KTST', destination: 'KMIV', cruiseAltitudeFt: 3500, route: [] } });
    const e = makeEngine({ scenario: { spawns: [spec] } });
    expect(runUntil(e, () => find(e, 'N723EJ').pendingRequest?.kind === 'TAXI', 30)).toBe(true);
  });
});

describe('IFR_CLEARANCE', () => {
  it('fills destination, DP from airport.procedures, 2000 initial, cruise expect, DEP frequency and a squawk; reads it back', () => {
    const { e, ac } = clearedDeparture();
    expect(departureProcedureName(airport)).toBe('ATLANTIC CITY THREE');
    const r = say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: {} }), 'CLNC');
    expect(r.status).toBe('accepted');
    if (r.status !== 'accepted') return;
    const ifr = r.clearance.ifr!;
    expect(ifr).toMatchObject({
      destination: 'KPHL', departureProcedure: 'ATLANTIC CITY THREE', initialAltitudeFt: 2000, expectAltitudeFt: 10000, departureFrequencyMhz: 124.6,
    });
    expect(isAssignableSquawk(ifr.squawk)).toBe(true);
    expect(r.readback).toBe(
      `Cleared to Philadelphia, Atlantic City Three departure, radar vectors, maintain two thousand, expect one zero thousand ten minutes after departure, departure one two four point six, squawk ${ifr.squawk.split('').map((d) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][Number(d)]).join(' ')}, Spirit four fifty one`,
    );
    expect(ac.squawk).toBe(ifr.squawk);
    expect(ac.flightPlan?.ifrClearance).toMatchObject({ ...ifr, readBack: true });
    expect(ac.flightPlan?.departureProcedure).toBe('ATLANTIC CITY THREE');
    expect(ac.pendingRequest).toBeUndefined();
  });

  it('uses the elements the controller stated (initial altitude, squawk, frequency, expect altitude)', () => {
    const { e, ac } = clearedDeparture();
    const r = say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: { initialAltitudeFt: 3000, squawk: '4215', departureFrequencyMhz: 124.6, expectAltitudeFt: 12000, destination: 'KPHL' } }), 'CLNC');
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') {
      expect(r.readback).toContain('maintain three thousand');
      expect(r.readback).toContain('expect one two thousand ten minutes after departure');
      expect(r.readback).toContain('squawk four two one five');
    }
    expect(ac.squawk).toBe('4215');
  });

  it('accepts the destination as a FAA id and flight levels in the expect clause', () => {
    const spec = IFR_DEPARTURE('NKS451', 'GATE-1', ['TVO'], { flightPlan: { flightRules: 'IFR', origin: 'KTST', destination: 'KBOS', cruiseAltitudeFt: 23000, route: ['TVO'] } });
    const e = makeEngine({ scenario: ifrScenario([spec]) });
    const ac = find(e, 'NKS451');
    runUntil(e, () => ac.pendingRequest?.kind === 'IFR_CLEARANCE', 30);
    const r = say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: { destination: 'BOS' } }), 'CLNC');
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') expect(r.readback).toMatch(/^Cleared to Boston, .*expect flight level two three zero ten minutes after departure/);
  });

  it('refuses a clearance limit that is not the filed destination, bad or duplicate squawks, and unusable altitudes', () => {
    const { e } = clearedDeparture();
    const wrongDest = say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: { destination: 'KBOS' } }), 'CLNC');
    expect(wrongDest.status).toBe('rejected');
    if (wrongDest.status === 'rejected') expect(wrongDest.reason).toMatch(/does not match the flight plan/);
    for (const bad of ['7700', '7500', '7600', '1200', '0000', '4289', '12']) {
      expect(say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: { squawk: bad } }), 'CLNC').status, bad).toBe('rejected');
    }
    expect(say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: { initialAltitudeFt: 50 } }), 'CLNC').status).toBe('rejected');
    expect(say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: { departureProcedure: 'BRIDGEPORT FOUR' } }), 'CLNC').status).toBe('rejected');
    // after all that the aircraft still has no clearance and the request is still pending
    expect(find(e, 'NKS451').flightPlan?.ifrClearance).toBeUndefined();
    expect(find(e, 'NKS451').pendingRequest?.kind).toBe('IFR_CLEARANCE');
  });

  it('refuses a squawk already assigned to another aircraft', () => {
    const e = makeEngine({ scenario: ifrScenario([IFR_DEPARTURE('NKS451', 'GATE-1'), IFR_DEPARTURE('AAL12', 'GATE-2')]) });
    const a = find(e, 'NKS451');
    const b = find(e, 'AAL12');
    runUntil(e, () => a.pendingRequest?.kind === 'IFR_CLEARANCE' && b.pendingRequest?.kind === 'IFR_CLEARANCE', 40);
    expect(say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: { squawk: '4215' } }), 'CLNC').status).toBe('accepted');
    const dup = say(e, cmd('IFR_CLEARANCE', 'AAL12', { ifr: { squawk: '4215' } }), 'CLNC');
    expect(dup.status).toBe('rejected');
    if (dup.status === 'rejected') expect(dup.reason).toMatch(/already assigned/);
  });

  it('is only valid for a parked aircraft with an IFR flight plan that asked for it, once', () => {
    const e = makeEngine({ scenario: ifrScenario([GA_PARKED('N723EJ', 'GA1', 'CLNC'), IFR_DEPARTURE('NKS451', 'GATE-1', ['TVO'], { atSec: 100 })]) });
    run(e, 30);
    const vfr = say(e, cmd('IFR_CLEARANCE', 'N723EJ', { ifr: {} }), 'CLNC');
    expect(vfr.status).toBe('rejected');
    if (vfr.status === 'rejected') expect(vfr.pilotResponse).toMatch(/no IFR flight plan/);
    // the IFR aircraft has not called yet
    run(e, 75);
    const early = say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: {} }), 'CLNC');
    expect(early.status).toBe('rejected');
    if (early.status === 'rejected') expect(early.reason).toMatch(/has not requested/);
    runUntil(e, () => find(e, 'NKS451').pendingRequest?.kind === 'IFR_CLEARANCE', 40);
    expect(say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: {} }), 'CLNC').status).toBe('accepted');
    run(e, 6); // past the duplicate window
    const again = say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: {} }), 'CLNC');
    expect(again.status).toBe('rejected');
    if (again.status === 'rejected') expect(again.reason).toMatch(/already has its IFR clearance/);
  });

  it('can only be given on the Clearance Delivery frequency', () => {
    const { e } = clearedDeparture();
    const r = say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: {} }), 'GND');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reason).toMatch(/Not on frequency/);
  });

  it('after the readback the pilot tunes Ground and asks for taxi about 15 s later', () => {
    const { e, ac } = clearedDeparture();
    const t0 = e.getState().clock.timeSec;
    say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: {} }), 'CLNC');
    run(e, IFR_TAXI_REQUEST_DELAY_SEC - 2);
    expect(ac.frequencyId).toBe('CLNC');
    expect(ac.phase).toBe('PARKED');
    expect(runUntil(e, () => ac.pendingRequest?.kind === 'TAXI', 10)).toBe(true);
    expect(e.getState().clock.timeSec - t0).toBeGreaterThanOrEqual(IFR_TAXI_REQUEST_DELAY_SEC);
    expect(ac.frequencyId).toBe('GND');
    expect(ac.frequencyMhz).toBe(121.9);
    expect(ac.phase).toBe('READY');
    expect(pilotTexts(e).pop()).toBe('Atlantic City Ground, Spirit four fifty one, at Gate one, ready to taxi, IFR departure.');
    // Ground can now taxi it
    expect(say(e, cmd('TAXI', 'NKS451', { destination: 'RWY13' }), 'GND').status).toBe('accepted');
  });
});

describe('takeoff needs an IFR clearance', () => {
  it('training: refused with "no IFR clearance on file"; the aircraft stays put', () => {
    const e = makeEngine({ scenario: ifrScenario([IFR_HOLDING('NKS451', 'H13', '13')], { mode: 'training' }) });
    run(e, 5);
    const r = say(e, cmd('TAKEOFF', 'NKS451', { runwayEnd: '13' }), 'TWR');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') {
      expect(r.reason).toMatch(/no IFR clearance on file/);
      expect(r.pilotResponse).toBe("Unable, we don't have our IFR clearance yet, Spirit four fifty one");
    }
    expect(find(e, 'NKS451').phase).toBe('HOLDING_SHORT');
    run(e, 1);
    expect(e.getState().score.communicationErrors).toBe(1);
  });

  it('other modes: accepted but flagged as a communication error (not a correct clearance)', () => {
    const e = makeEngine({ scenario: ifrScenario([IFR_HOLDING('NKS451', 'H13', '13')]) });
    run(e, 5);
    const r = say(e, cmd('TAKEOFF', 'NKS451', { runwayEnd: '13' }), 'TWR');
    expect(r.status).toBe('accepted');
    run(e, 1);
    const s = e.getState();
    expect(s.score.communicationErrors).toBe(1);
    expect(s.score.correctClearances).toBe(0);
    expect(s.events.some((x) => /Improper instruction accepted: no IFR clearance on file/.test(x.text))).toBe(true);
  });

  it('a VFR or flight-plan-less IFR aircraft is not affected', () => {
    const e = makeEngine({ scenario: { spawns: [{ ...IFR_HOLDING('NKS451', 'H13', '13'), flightPlan: undefined }], mode: 'training' } });
    run(e, 5);
    expect(e.applyCommand(cmd('TAKEOFF', 'NKS451', { runwayEnd: '13' })).status).toBe('accepted');
  });
});

describe('IFR departure routing', () => {
  /** Parked -> cleared -> taxi -> takeoff, returns when airborne in DEPARTURE. */
  function airborne(): { e: SimulationEngine; ac: Aircraft } {
    const { e, ac } = clearedDeparture({ scenario: { mode: 'training' } });
    say(e, cmd('IFR_CLEARANCE', 'NKS451', { ifr: {} }), 'CLNC');
    expect(runUntil(e, () => ac.pendingRequest?.kind === 'TAXI', 40)).toBe(true);
    expect(say(e, cmd('TAXI', 'NKS451', { destination: 'RWY13' }), 'GND').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT' && ac.groundSpeedKt < 0.1 && !!ac.pendingRequest, 300)).toBe(true);
    expect(say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'TWR' }), 'GND').status).toBe('accepted');
    run(e, 8);
    expect(say(e, cmd('TAKEOFF', 'NKS451', { runwayEnd: '13' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'DEPARTURE', 300)).toBe(true);
    return { e, ac };
  }

  it('flies runway heading and levels at the cleared initial altitude (2000 ft)', () => {
    const { e, ac } = airborne();
    const g = findRunwayEnd(airport, '13')!;
    expect(ac.target.altitudeFt).toBe(2000);
    run(e, 90);
    expect(ac.altitudeFt).toBeCloseTo(2000, 0);
    expect(Math.abs(headingDiff(ac.headingDeg, g.headingDeg))).toBeLessThan(1);
    expect(ac.nav).toBeUndefined();
  });

  it('Tower hands off to Departure (shares the Approach frequency); the pilot checks in as Departure', () => {
    const { e, ac } = airborne();
    const out = say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'DEP' }), 'TWR');
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') expect(out.readback).toBe('Departure one two four point six, Spirit four fifty one');
    expect(runUntil(e, () => ac.frequencyId === 'DEP', 10)).toBe(true);
    expect(ac.frequencyMhz).toBe(124.6);
    expect(runUntil(e, () => ac.pendingRequest?.kind === 'OTHER', 10)).toBe(true);
    const text = pilotTexts(e).pop()!;
    expect(text).toMatch(/^Atlantic City Departure, Spirit four fifty one, (\w+ )+(thousand|hundred)( \w+)*( climbing two thousand)?\.$/);
    // an Approach-position controller on the same frequency hears it too
    expect(say(e, cmd('RADAR_CONTACT', 'NKS451'), 'APP').status).toBe('accepted');
  });

  it('check-in names the altitude and the climb target when still climbing', () => {
    const e = makeEngine({ scenario: ifrScenario([IFR_HOLDING('NKS451', 'H13', '13')], { mode: 'training' }) });
    const ac = find(e, 'NKS451');
    ac.flightPlan = { ...ac.flightPlan!, ifrClearance: { destination: 'KPHL', routeText: '', initialAltitudeFt: 2000, departureFrequencyMhz: 124.6, squawk: '2000', readBack: true, issuedAtSec: 0 } };
    run(e, 4);
    say(e, cmd('TAKEOFF', 'NKS451', { runwayEnd: '13' }), 'TWR');
    expect(runUntil(e, () => ac.altitudeFt >= 1200 && !ac.onGround, 400)).toBe(true);
    say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'DEP' }), 'TWR');
    expect(runUntil(e, () => ac.pendingRequest?.kind === 'OTHER', 20)).toBe(true);
    expect(pilotTexts(e).pop()).toMatch(/^Atlantic City Departure, Spirit four fifty one, one thousand \w+ hundred climbing two thousand\.$/);
  });

  it('RADAR_CONTACT is informational: sets radarIdentified, no readback, no pilot transmission', () => {
    const { e, ac } = airborne();
    say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'DEP' }), 'TWR');
    runUntil(e, () => ac.pendingRequest?.kind === 'OTHER', 20);
    const before = pilotTexts(e).length;
    expect(ac.radarIdentified).not.toBe(true);
    const r = say(e, cmd('RADAR_CONTACT', 'NKS451'), 'DEP');
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') expect(r.readback).toBe('');
    expect(ac.radarIdentified).toBe(true);
    expect(ac.pendingRequest).toBeUndefined();
    run(e, 5);
    expect(pilotTexts(e)).toHaveLength(before);
    expect(e.getState().events.some((x) => /Radar contact: NKS451 \(squawk \d{4}\)/.test(x.text))).toBe(true);
  });

  it('ALTITUDE, HEADING, DIRECT_FIX and RESUME work on Departure; the aircraft leaves handled after > 15 nm', () => {
    const { e, ac } = airborne();
    say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'DEP' }), 'TWR');
    runUntil(e, () => ac.pendingRequest?.kind === 'OTHER', 20);
    say(e, cmd('RADAR_CONTACT', 'NKS451'), 'DEP');
    const climb = say(e, cmd('ALTITUDE', 'NKS451', { altitudeFt: 10000 }), 'DEP');
    expect(climb.status).toBe('accepted');
    if (climb.status === 'accepted') expect(climb.readback).toBe('Climb and maintain one zero thousand, Spirit four fifty one');
    expect(say(e, cmd('HEADING', 'NKS451', { headingDeg: 200 }), 'DEP').status).toBe('accepted');
    run(e, 30);
    const resume = say(e, cmd('RESUME_OWN_NAVIGATION', 'NKS451'), 'DEP');
    expect(resume.status).toBe('accepted');
    expect(ac.nav).toMatchObject({ fixes: ['TVO'], mode: 'route' });
    const direct = say(e, cmd('DIRECT_FIX', 'NKS451', { fix: 'TVO' }), 'DEP');
    expect(direct.status).toBe('accepted');
    if (direct.status === 'accepted') expect(direct.readback).toBe('Direct Testville, Spirit four fifty one');
    expect(ac.nav).toEqual({ fixes: ['TVO'], index: 0, mode: 'direct' });
    expect(runUntil(e, () => !has(e, 'NKS451'), 1200)).toBe(true);
    const gone = e.getState().events.filter((x) => x.kind === 'DESPAWN' && x.callsign === 'NKS451').pop()!;
    expect(gone.data).toMatchObject({ handled: true });
    expect(gone.text).toMatch(/departed the area \(handed off\)/);
    expect(mToNm(Math.hypot(ac.pos.x, ac.pos.y))).toBeGreaterThan(15);
    expect(e.getState().score.aircraftHandled).toBe(1);
  });

  it('without an instruction after the handoff the departure is not counted as handled (and is not penalised)', () => {
    const { e, ac } = airborne();
    say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'DEP' }), 'TWR');
    runUntil(e, () => ac.pendingRequest?.kind === 'OTHER', 20);
    const score = e.getState().score.score;
    expect(runUntil(e, () => !has(e, 'NKS451'), 2400)).toBe(true);
    const gone = e.getState().events.filter((x) => x.kind === 'DESPAWN' && x.callsign === 'NKS451').pop()!;
    expect(gone.data).toMatchObject({ handled: false });
    expect(e.getState().score.aircraftHandled).toBe(0);
    expect(e.getState().score.score).toBe(score);
  });
});

describe('squawk codes', () => {
  it('every IFR aircraft gets a unique 4-digit octal code that is never a reserved code', () => {
    const spawns = Array.from({ length: 60 }, (_, i) => AT_FIX(`NKS${100 + i}`, 'TARR', ['TARR', 'FX13A']));
    const e = makeEngine({ scenario: ifrScenario(spawns) });
    const codes = Object.values(e.getState().aircraft).map((a) => a.squawk!);
    expect(codes).toHaveLength(60);
    expect(new Set(codes).size).toBe(60);
    for (const c of codes) expect(isAssignableSquawk(c)).toBe(true);
  });
});
