import { describe, expect, it } from 'vitest';
import type { Aircraft, Clearance } from '../sim/types';
import { createTestAirport } from '../sim/__fixtures__/testAirport';
import { mulberry32 } from '../sim/rng';
import {
  buildReadback, buildUnable, checkInCall, clearOfRunwayCall, finalCall, goingAroundCall, holdingShortCall, inboundCall,
  readyToTaxiCall, requestFrequencyChangeCall,
} from './readback';
import {
  digitsSpoken, spokenAltitude, spokenCallsign, spokenFrequency, spokenHeading, spokenRunway, spokenSpeed, spokenTaxiway, spokenText,
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
      'Runway two two via alpha, hold short of runway one three, Cessna seven two three echo juliet',
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
      'Atlantic City Ground, Cessna seven two three echo juliet, at general aviation Ramp one, ready to taxi, VFR departure.',
    );
    const twr = ac({ frequencyMhz: 120.3, frequencyId: 'TWR' });
    expect(holdingShortCall(twr, env, '22', true)).toBe('Atlantic City Tower, Cessna seven two three echo juliet, holding short runway two two, ready for departure.');
    expect(holdingShortCall(cess, env, '22', false)).toBe('Atlantic City Ground, Cessna seven two three echo juliet, holding short runway two two.');
    const spirit = ac({ callsign: 'NKS451', spokenCallsign: 'Spirit four fifty one', frequencyMhz: 124.6, onGround: false });
    expect(inboundCall(spirit, env, { distanceNm: 10, bearingFromAirportDeg: 225, atisLetter: 'B' })).toBe(
      'Atlantic City Approach, Spirit four fifty one, ten miles southwest, inbound for landing with information bravo.',
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
