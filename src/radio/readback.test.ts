import { describe, expect, it } from 'vitest';
import type { Aircraft, Clearance } from '../sim/types';
import { createTestAirport } from '../sim/__fixtures__/testAirport';
import { mulberry32 } from '../sim/rng';
import {
  approachCheckInCall, arrivalTowerCheckInCall, buildReadback, buildUnable, checkInCall, clearOfRunwayCall, departureCheckInCall, establishedCall, finalCall,
  goAroundEstablishedCall, goingAroundCall, holdingShortCall, ifrClearanceRequestCall, inboundCall, missedApproachCheckInCall, readyToTaxiCall,
  requestFrequencyChangeCall,
} from './readback';
import {
  digitsSpoken, spokenAirportName, spokenAltitude, spokenCallsign, spokenFrequency, spokenHeading, spokenRunway, spokenSpeed, spokenTaxiway, spokenText, titleCase,
} from './spoken';
import { facilityCallName, hearsFrequency, listenersOn } from './frequencies';

const airport = createTestAirport();
const env = { airport };

function ac(over: Partial<Aircraft> = {}): Aircraft {
  return {
    id: 'ac-1', callsign: 'N723EJ', spokenCallsign: 'Cessna seven two three echo juliet', type: 'C172', flightRules: 'VFR', origin: 'KTST',
    destination: 'KPHL', isDeparture: true, pos: { x: 0, y: 0 }, headingDeg: 0, trackDeg: 0, altitudeFt: 75, airspeedKt: 0, groundSpeedKt: 0,
    verticalSpeedFpm: 0, onGround: true, phase: 'PARKED', frequencyMhz: 121.9, frequencyId: 'GND', clearances: [], target: {}, radioState: 'IDLE',
    occupyingRunways: [], runwayAuthorizations: [], spawnedAtSec: 0, history: [], voiceId: 'v1', flags: {}, seed: 1, ...over,
  };
}
const clr = (c: Partial<Clearance> & Pick<Clearance, 'kind'>): Clearance => ({ id: 'c1', issuedAtSec: 0, byPosition: 'TWR', ...c });

describe('spoken numbers', () => {
  it('renders runways, frequencies, altitudes, headings, speeds', () => {
    expect(spokenRunway('13')).toBe('one three');
    expect(spokenRunway('4')).toBe('four');
    expect(spokenRunway('04')).toBe('four');
    expect(spokenRunway('22')).toBe('two two');
    expect(spokenRunway('13L')).toBe('one three left');
    expect(spokenRunway('13/31')).toBe('one three');
    expect(spokenFrequency('121.9')).toBe('one two one point niner');
    expect(spokenFrequency(120.3)).toBe('one two zero point three');
    expect(spokenFrequency(124.6)).toBe('one two four point six');
    expect(spokenAltitude(2500)).toBe('two thousand five hundred');
    expect(spokenAltitude(3000)).toBe('three thousand');
    expect(spokenAltitude(800)).toBe('eight hundred');
    expect(spokenAltitude(10000)).toBe('one zero thousand');
    expect(spokenAltitude(9500)).toBe('niner thousand five hundred');
    expect(spokenAltitude(24000)).toBe('flight level two four zero');
    expect(spokenHeading(270)).toBe('two seven zero');
    expect(spokenHeading(5)).toBe('zero zero five');
    expect(spokenHeading(0)).toBe('three six zero');
    expect(spokenHeading(95)).toBe('zero niner five');
    expect(spokenSpeed(180)).toBe('one eight zero');
    expect(spokenTaxiway('A')).toBe('alpha');
    expect(spokenTaxiway('A1')).toBe('alpha one');
    expect(spokenText('GA Ramp 3')).toBe('general aviation Ramp three');
    expect(digitsSpoken('9')).toBe('niner');
  });

  it('builds spoken callsigns', () => {
    expect(spokenCallsign('N723EJ', 'C172')).toBe('Cessna seven two three echo juliet');
    expect(spokenCallsign('NKS451', 'A320')).toBe('Spirit four fifty one');
    expect(spokenCallsign('AAL1234')).toBe('American twelve thirty four');
    expect(spokenCallsign('DAL100')).toBe('Delta one hundred');
    expect(spokenCallsign('JBU7')).toBe('JetBlue seven');
    expect(spokenCallsign('N5AB', 'XYZ')).toBe('November five alpha bravo');
  });
});

describe('clearance readbacks (callsign last)', () => {
  const cess = ac();
  const spirit = ac({ callsign: 'NKS451', spokenCallsign: 'Spirit four fifty one', type: 'A320', frequencyMhz: 120.3, frequencyId: 'TWR', onGround: false, altitudeFt: 2000 });

  it('matches the specified phraseology exactly', () => {
    expect(buildReadback(cess, clr({ kind: 'TAKEOFF', runwayEnd: '13' }), env).text).toBe('Runway one three, cleared for takeoff, Cessna seven two three echo juliet');
    expect(buildReadback(cess, clr({ kind: 'TAXI', destination: 'RWY22', route: ['A'], holdShort: ['13/31'] }), env).text).toBe(
      'Runway two two, taxi via alpha, hold short of runway one three, Cessna seven two three echo juliet',
    );
    expect(buildReadback(spirit, clr({ kind: 'HEADING', headingDeg: 270, turnDirection: 'left' }), env).text).toBe('Left heading two seven zero, Spirit four fifty one');
    expect(buildReadback(spirit, clr({ kind: 'CONTACT_FREQUENCY', frequencyMhz: 121.9, frequencyId: 'GND' }), env).text).toBe('Ground point niner, Spirit four fifty one');
  });

  it('covers the other clearance kinds', () => {
    const t = (c: Partial<Clearance> & Pick<Clearance, 'kind'>, a = cess) => buildReadback(a, clr(c), env).text;
    expect(t({ kind: 'LAND', runwayEnd: '31' })).toBe('Runway three one, cleared to land, Cessna seven two three echo juliet');
    expect(t({ kind: 'LINE_UP_AND_WAIT', runwayEnd: '4' })).toBe('Runway four, line up and wait, Cessna seven two three echo juliet');
    expect(t({ kind: 'CROSS_RUNWAY', runwayId: '13/31' })).toBe('Cross runway one three, Cessna seven two three echo juliet');
    expect(t({ kind: 'HOLD_SHORT', holdShort: ['4/22'] })).toBe('Hold short of runway four, Cessna seven two three echo juliet');
    expect(t({ kind: 'HOLD_POSITION' })).toBe('Holding position, Cessna seven two three echo juliet');
    expect(t({ kind: 'GO_AROUND' }, spirit)).toBe('Going around, Spirit four fifty one');
    expect(t({ kind: 'HEADING', headingDeg: 90 }, spirit)).toBe('Heading zero niner zero, Spirit four fifty one');
    expect(t({ kind: 'HEADING', headingDeg: 5, turnDirection: 'right' }, spirit)).toBe('Right heading zero zero five, Spirit four fifty one');
    expect(t({ kind: 'ALTITUDE', altitudeFt: 2500 }, spirit)).toBe('Climb and maintain two thousand five hundred, Spirit four fifty one');
    expect(t({ kind: 'ALTITUDE', altitudeFt: 1000 }, spirit)).toBe('Descend and maintain one thousand, Spirit four fifty one');
    expect(t({ kind: 'SPEED', speedKt: 180 }, spirit)).toBe('Speed one eight zero, Spirit four fifty one');
    expect(t({ kind: 'CONTACT_FREQUENCY', frequencyMhz: 120.3, frequencyId: 'TWR' }, cess)).toBe('Tower one two zero point three, Cessna seven two three echo juliet');
    expect(t({ kind: 'TAXI', destination: 'GA2', route: ['A', 'B'] })).toBe('Taxi to the ramp via alpha, bravo, Cessna seven two three echo juliet');
    expect(t({ kind: 'ENTER_PATTERN', runwayEnd: '13', patternLeg: 'left_downwind' })).toBe('Left downwind runway one three, Cessna seven two three echo juliet');
    expect(buildUnable(cess, 'we are airborne')).toBe('Unable, we are airborne, Cessna seven two three echo juliet');
  });
});

describe('pilot-initiated calls (callsign first)', () => {
  const cess = ac();
  it('ready to taxi, holding short, inbound, go-around, clear of runway, frequency change', () => {
    expect(readyToTaxiCall(cess, env, airport.parking[0])).toBe(
      'Atlantic City Ground, Cessna seven two three echo juliet, at general aviation Ramp one, ready to taxi, VFR to Philadelphia.',
    );
    const twr = ac({ frequencyMhz: 120.3, frequencyId: 'TWR' });
    expect(holdingShortCall(twr, env, '22', true)).toBe('Atlantic City Tower, Cessna seven two three echo juliet, holding short runway two two, ready for departure.');
    expect(holdingShortCall(cess, env, '22', false)).toBe('Atlantic City Ground, Cessna seven two three echo juliet, holding short runway two two.');
    const spirit = ac({ callsign: 'NKS451', spokenCallsign: 'Spirit four fifty one', frequencyMhz: 124.6, onGround: false });
    expect(inboundCall(spirit, env, { distanceNm: 10, bearingFromAirportDeg: 225, atisLetter: 'B' })).toBe(
      'Atlantic City Approach, Spirit four fifty one, one zero miles southwest, inbound for landing with information bravo.',
    );
    expect(finalCall(twr, env, '13', 4)).toBe('Atlantic City Tower, Cessna seven two three echo juliet, four mile final runway one three, full stop.');
    expect(goingAroundCall(twr, env, '13', 'no landing clearance')).toBe('Atlantic City Tower, Cessna seven two three echo juliet, going around runway one three, no landing clearance.');
    expect(clearOfRunwayCall(twr, env, '13', 'A')).toBe('Atlantic City Tower, Cessna seven two three echo juliet, clear of runway one three at alpha.');
    expect(requestFrequencyChangeCall(twr, env)).toBe('Atlantic City Tower, Cessna seven two three echo juliet, request frequency change.');
    expect(checkInCall(cess, env, { taxiway: 'A', wantsTaxiToParking: true })).toBe('Atlantic City Ground, Cessna seven two three echo juliet, at alpha, request taxi to parking.');
  });
});

describe('readback errors', () => {
  const cess = ac();
  it('never happen with rate 0 and are seeded/deterministic otherwise', () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 200; i++) {
      expect(buildReadback(cess, clr({ kind: 'TAKEOFF', runwayEnd: '13' }), { airport, rng, errorRate: 0 }).error).toBeUndefined();
    }
    const run = (seed: number) => {
      const r = mulberry32(seed);
      return Array.from({ length: 30 }, () => buildReadback(cess, clr({ kind: 'TAKEOFF', runwayEnd: '13' }), { airport, rng: r, errorRate: 0.5 }).text);
    };
    expect(run(9)).toEqual(run(9));
    expect(run(9)).not.toEqual(run(10));
  });

  it('inject a wrong runway or a wrong heading digit and describe the mistake', () => {
    const rng = mulberry32(1);
    const t = buildReadback(cess, clr({ kind: 'TAKEOFF', runwayEnd: '13' }), { airport, rng, errorRate: 1 });
    expect(t.error?.kind).toBe('runway');
    expect(t.error?.correct).toBe('runway 13');
    expect(t.text).not.toContain('one three');
    expect(t.text.startsWith('Runway ')).toBe(true);
    expect(t.text.endsWith(', Cessna seven two three echo juliet')).toBe(true);
    const h = buildReadback(cess, clr({ kind: 'HEADING', headingDeg: 270 }), { airport, rng, errorRate: 1 });
    expect(h.error?.kind).toBe('heading');
    expect(h.text).not.toContain('two seven zero');
    expect(h.text).toMatch(/^Heading two (six|eight) zero, /);
    // instructions without a runway or heading are never corrupted
    expect(buildReadback(cess, clr({ kind: 'GO_AROUND' }), { airport, rng, errorRate: 1 }).error).toBeUndefined();
    expect(buildReadback(cess, clr({ kind: 'ALTITUDE', altitudeFt: 3000 }), { airport, rng, errorRate: 1 }).error).toBeUndefined();
  });

  it('occur at roughly the configured rate', () => {
    const rng = mulberry32(77);
    let n = 0;
    for (let i = 0; i < 4000; i++) if (buildReadback(cess, clr({ kind: 'TAKEOFF', runwayEnd: '13' }), { airport, rng, errorRate: 0.08 }).error) n++;
    expect(n / 4000).toBeGreaterThan(0.06);
    expect(n / 4000).toBeLessThan(0.1);
  });
});

describe('frequencies', () => {
  it('aircraft only hear their own frequency', () => {
    const a = ac({ frequencyMhz: 121.9 });
    const b = ac({ id: 'ac-2', frequencyMhz: 120.3 });
    expect(hearsFrequency(a, 121.9)).toBe(true);
    expect(hearsFrequency(a, 120.3)).toBe(false);
    expect(hearsFrequency(a, 121.9004)).toBe(true);
    expect(listenersOn([a, b], 120.3)).toEqual([b]);
  });

  it('names facilities from airport data', () => {
    expect(facilityCallName(airport, 121.9)).toBe('Atlantic City Ground');
    expect(facilityCallName(airport, 124.6)).toBe('Atlantic City Approach');
    expect(facilityCallName(airport, 130.0)).toBe('Atlantic City');
  });
});

describe('IFR readbacks and calls', () => {
  const nks = ac({ callsign: 'NKS451', spokenCallsign: 'Spirit four fifty one', type: 'A320', flightRules: 'IFR', frequencyMhz: 127.85, frequencyId: 'CLNC' });
  const ifr = {
    destination: 'KPHL', routeText: 'ATLANTIC CITY THREE departure, radar vectors, then as filed', departureProcedure: 'ATLANTIC CITY THREE',
    initialAltitudeFt: 2000, expectAltitudeFt: 10000, departureFrequencyMhz: 124.6, squawk: '4215',
  };

  it('IFR clearance: destination, DP, radar vectors, maintain, expect, departure frequency, squawk, callsign last', () => {
    expect(buildReadback(nks, clr({ kind: 'IFR_CLEARANCE', ifr }), env).text).toBe(
      'Cleared to Philadelphia airport, Atlantic City Three departure, radar vectors, maintain two thousand, expect one zero thousand, one zero minutes after departure, departure frequency one two four point six, squawk four two one five, Spirit four fifty one',
    );
  });

  it('IFR clearance without a DP says "as filed"; flight-level cruise; unknown destinations are spelled out', () => {
    const t = buildReadback(nks, clr({ kind: 'IFR_CLEARANCE', ifr: { ...ifr, departureProcedure: undefined, expectAltitudeFt: 24000, destination: 'KXYZ' } }), env).text;
    expect(t).toBe(
      'Cleared to kilo x-ray yankee zulu airport, as filed, maintain two thousand, expect flight level two four zero, one zero minutes after departure, departure frequency one two four point six, squawk four two one five, Spirit four fifty one',
    );
    expect(buildReadback(nks, clr({ kind: 'IFR_CLEARANCE', ifr: { ...ifr, expectAltitudeFt: undefined } }), env).text).not.toMatch(/expect/);
  });

  it('approach clearances by type', () => {
    const b = (approachType: Clearance['approachType'], runwayEnd = '13') => buildReadback(nks, clr({ kind: 'APPROACH', approachType, runwayEnd }), env).text;
    expect(b('ILS')).toBe('Cleared ILS runway one three approach, Spirit four fifty one');
    expect(b('LOC')).toBe('Cleared localizer runway one three approach, Spirit four fifty one');
    expect(b('RNAV', '22')).toBe('Cleared RNAV runway two two approach, Spirit four fifty one');
    expect(b('VOR', '4')).toBe('Cleared VOR runway four approach, Spirit four fifty one');
    expect(b('VISUAL')).toBe('Cleared visual approach runway one three, Spirit four fifty one');
  });

  it('approach clearance readbacks can carry a seeded runway error', () => {
    const r = buildReadback(nks, clr({ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '13' }), { airport, rng: mulberry32(3), errorRate: 1 });
    expect(r.error?.kind).toBe('runway');
    expect(r.error?.correct).toBe('runway 13');
  });

  it('direct fix: navaid name when present, otherwise the identifier; resume own navigation; radar contact has no readback', () => {
    expect(buildReadback(nks, clr({ kind: 'DIRECT_FIX', fix: 'TVO' }), env).text).toBe('Direct Testville, Spirit four fifty one');
    expect(buildReadback(nks, clr({ kind: 'DIRECT_FIX', fix: 'FX13A' }), env).text).toBe('Direct FX13A, Spirit four fifty one');
    expect(buildReadback(nks, clr({ kind: 'DIRECT_FIX', fix: 'UNKNWN' }), env).text).toBe('Direct UNKNWN, Spirit four fifty one');
    expect(buildReadback(nks, clr({ kind: 'RESUME_OWN_NAVIGATION' }), env).text).toBe('Resuming own navigation, Spirit four fifty one');
    expect(buildReadback(nks, clr({ kind: 'RADAR_CONTACT' }), env).text).toBe('');
  });

  it('contact frequency by position id resolves CLNC / DEP / APP, keeping the named position when positions share a frequency', () => {
    expect(buildReadback(nks, clr({ kind: 'CONTACT_FREQUENCY', frequencyId: 'DEP', frequencyMhz: 124.6 }), env).text).toBe('Departure one two four point six, Spirit four fifty one');
    expect(buildReadback(nks, clr({ kind: 'CONTACT_FREQUENCY', frequencyId: 'APP', frequencyMhz: 124.6 }), env).text).toBe('Approach one two four point six, Spirit four fifty one');
    expect(buildReadback(nks, clr({ kind: 'CONTACT_FREQUENCY', frequencyId: 'CLNC' }), env).text).toBe('Clearance Delivery one two seven point eight five, Spirit four fifty one');
  });

  it('the facility is named from the frequency id the aircraft was told to contact (APP and DEP share 124.6)', () => {
    expect(facilityCallName(airport, 124.6)).toBe('Atlantic City Approach');
    expect(facilityCallName(airport, 124.6, 'DEP')).toBe('Atlantic City Departure');
    expect(facilityCallName(airport, 124.6, 'APP')).toBe('Atlantic City Approach');
    expect(facilityCallName(airport, 121.9, 'DEP')).toBe('Atlantic City Ground'); // stale id for another frequency is ignored
    expect(facilityCallName(airport, 127.85)).toBe('Atlantic City Clearance Delivery');
  });

  it('pilot calls', () => {
    expect(ifrClearanceRequestCall(nks, env, { destination: 'KPHL', atisLetter: 'B' })).toBe(
      'Atlantic City Clearance Delivery, Spirit four fifty one, IFR to Philadelphia, with information bravo, ready to copy.',
    );
    const app = { ...nks, frequencyMhz: 124.6, frequencyId: 'APP', onGround: false, isDeparture: false, altitudeFt: 5000 };
    expect(approachCheckInCall(app, env, { altitudeFt: 5000, atisLetter: 'B' })).toBe('Atlantic City Approach, Spirit four fifty one, level five thousand, information bravo.');
    expect(approachCheckInCall(app, env, { altitudeFt: 4960 })).toBe('Atlantic City Approach, Spirit four fifty one, level five thousand.');
    const dep = { ...nks, frequencyMhz: 124.6, frequencyId: 'DEP', onGround: false, altitudeFt: 1230 };
    expect(departureCheckInCall(dep, env, { targetAltitudeFt: 2000 })).toBe('Atlantic City Departure, Spirit four fifty one, leaving one thousand two hundred, climbing to two thousand.');
    expect(departureCheckInCall({ ...dep, altitudeFt: 2000 }, env, { targetAltitudeFt: 2000 })).toBe('Atlantic City Departure, Spirit four fifty one, level two thousand.');
    expect(establishedCall(app, env, { type: 'ILS', runwayEnd: '13' })).toBe('Atlantic City Approach, Spirit four fifty one, established on the ILS runway one three.');
    expect(establishedCall(app, env, { type: 'LOC', runwayEnd: '31' })).toBe('Atlantic City Approach, Spirit four fifty one, established on the localizer runway three one.');
    const twr = { ...app, frequencyMhz: 120.3, frequencyId: 'TWR' };
    expect(arrivalTowerCheckInCall(twr, env, { distanceNm: 4.6, runwayEnd: '13' })).toBe('Atlantic City Tower, Spirit four fifty one, five mile final runway one three, full stop.');
    expect(missedApproachCheckInCall({ ...app, altitudeFt: 2000 }, env)).toBe('Atlantic City Approach, Spirit four fifty one, missed approach, two thousand.');
    expect(goAroundEstablishedCall(twr, env, 2000, { vectors: true })).toBe('Atlantic City Tower, Spirit four fifty one, runway heading, level two thousand, request vectors for another approach.');
    expect(goAroundEstablishedCall(twr, env, 2000)).toMatch(/request another approach\.$/);
  });

  it('spoken airport names and title case', () => {
    expect(spokenAirportName('KPHL')).toBe('Philadelphia');
    expect(spokenAirportName('BOS')).toBe('Boston');
    expect(spokenAirportName('KQQQ')).toBe('kilo quebec quebec quebec');
    expect(titleCase('CEDAR LAKE')).toBe('Cedar Lake');
  });
});

describe('phraseology audit fixes (docs/PHRASEOLOGY-AUDIT.md)', () => {
  const nks = ac({ callsign: 'NKS451', spokenCallsign: 'Spirit four fifty one', type: 'A320', flightRules: 'IFR', onGround: false, altitudeFt: 3000, frequencyMhz: 124.6, frequencyId: 'APP' });

  it('R-B1: a taxi to a runway is read back "Runway <n>, taxi ..." (7110.65 3-7-2)', () => {
    expect(buildReadback(ac(), clr({ kind: 'TAXI', runwayEnd: '13' }), env).text).toBe('Runway one three, taxi, Cessna seven two three echo juliet');
    expect(buildReadback(ac(), clr({ kind: 'TAXI', runwayEnd: '13', route: ['D', 'A'], holdShort: ['13/31'] }), env).text).toBe(
      'Runway one three, taxi via delta, alpha, hold short of runway one three, Cessna seven two three echo juliet',
    );
  });

  it('R-B3: ready to taxi states the type of operation and the first point of intended landing (AIM 4-3-18)', () => {
    const ifr = ac({ callsign: 'NKS451', spokenCallsign: 'Spirit four fifty one', flightRules: 'IFR', flightPlan: { flightRules: 'IFR', origin: 'KTST', destination: 'KBOS', cruiseAltitudeFt: 10000, route: [] } });
    expect(readyToTaxiCall(ifr, env)).toBe('Atlantic City Ground, Spirit four fifty one, on the ramp, ready to taxi, IFR to Boston.');
  });

  it('R-B5: airborne check-ins use "leaving ..., climbing to ..." / "level ..." instead of "passing"', () => {
    expect(checkInCall(nks, env)).toBe('Atlantic City Approach, Spirit four fifty one, level three thousand.');
    expect(departureCheckInCall({ ...nks, frequencyId: 'DEP', altitudeFt: 800 }, env, { targetAltitudeFt: 2000 })).toBe('Atlantic City Departure, Spirit four fifty one, leaving eight hundred, climbing to two thousand.');
  });

  it('R-B6: mileages are separate digits (7110.65 2-4-17)', () => {
    expect(finalCall({ ...nks, frequencyMhz: 120.3, frequencyId: 'TWR' }, env, '13', 10)).toBe('Atlantic City Tower, Spirit four fifty one, one zero mile final runway one three, full stop.');
    expect(arrivalTowerCheckInCall({ ...nks, frequencyMhz: 120.3, frequencyId: 'TWR' }, env, { distanceNm: 12, runwayEnd: '13' })).toMatch(/one two mile final/);
  });

  it('R-S3: a flight number with a leading zero is spoken digit by digit (2-4-20)', () => {
    expect(spokenCallsign('DAL010')).toBe('Delta zero one zero');
    expect(spokenCallsign('DAL100')).toBe('Delta one hundred');
  });
});
