import { describe, expect, it } from 'vitest';
import { parse } from './parse';
import { CTX } from './testkit';
import type { ParseContext } from './context';
import { spokenCallsign } from '../radio/spoken';

const AC = [
  { callsign: 'CGD61327', spokenCallsign: spokenCallsign('CGD61327', 'H65'), type: 'H65' },
  { callsign: 'ANG13586', spokenCallsign: `${spokenCallsign('ANG13586', 'F16')} flight of two`, type: 'F16' },
  { callsign: 'APT21', spokenCallsign: spokenCallsign('APT21', 'VEH'), type: 'VEH' },
  { callsign: 'N723EJ', spokenCallsign: 'Cessna seven two three echo juliet', type: 'C172' },
];
const ctx: ParseContext = { ...CTX, aircraft: AC };
const one = (say: string) => parse(say, ctx);

describe('callsign speech (JO 7110.65 2-4-20 military forms, AC 150/5210-20A vehicle form)', () => {
  it('speaks Coast Guard / Air Guard with the serial digits one by one and the vehicle as "Airport n vehicle"', () => {
    expect(spokenCallsign('CGD61327', 'H65')).toBe('Coast Guard six one three two seven');
    expect(spokenCallsign('ANG13586', 'F16')).toBe('Air Guard one three five eight six');
    expect(spokenCallsign('APT21', 'VEH')).toBe('Airport two one vehicle');
  });
});

describe('callsign parsing of the new forms', () => {
  it.each([
    ['Coast Guard six one three two seven, hold position', 'CGD61327'],
    ['Air Guard one three five eight six flight of two, cleared to land runway one three', 'ANG13586'],
    ['Airport two one vehicle, hold short of runway one three', 'APT21'],
    ['airport 21 vehicle hold short runway 13', 'APT21'],
  ])('%s -> %s', (say, cs) => {
    expect(one(say).callsign).toBe(cs);
  });
  it('does not take "Coast Guard helipad three" or "airport" in other uses for a callsign', () => {
    expect(one('Coast Guard six one three two seven, air taxi to Coast Guard helipad three').callsign).toBe('CGD61327');
    expect(one('N723EJ, wind calm, airport information').callsign).toBe('N723EJ');
  });
});

describe('vehicle instructions', () => {
  it('proceed on runway, report runway inspection complete', () => {
    const r = one('Airport two one vehicle, proceed on runway one three, report runway inspection complete');
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toMatchObject({ kind: 'PROCEED', runwayEnd: '13', runwayId: '13/31', reportClear: true });
    expect(r.commands[0].confidence).toBeGreaterThan(0.8);
  });
  it('proceed on the taxiways', () => {
    expect(one('Airport 21 vehicle, proceed on the taxiways, hold short of all runways').commands[0]).toMatchObject({ kind: 'PROCEED', destination: 'TAXIWAYS' });
  });
  it('proceed to runway via taxiway is a taxi, hold short of a runway is a hold short, cross runway at taxiway is a crossing', () => {
    expect(one('Airport two one vehicle, proceed to runway one three via alpha, hold short of runway four').commands[0]).toMatchObject({ kind: 'TAXI', runwayEnd: '13', route: ['A'], holdShort: ['RWY4'] });
    expect(one('Airport two one vehicle, hold short of runway one three').commands[0]).toMatchObject({ kind: 'HOLD_SHORT' });
    expect(one('Airport two one vehicle, cross runway one three at alpha').commands[0]).toMatchObject({ kind: 'CROSS_RUNWAY', crossRunwayId: '13/31', route: ['A'] });
  });
  it('"proceed as requested" is not approved phraseology for a runway (3-1-5 NOTE): it is not turned into a command', () => {
    expect(one('Airport two one vehicle, proceed as requested').commands[0].kind).toBe('UNKNOWN');
  });
});

describe('helicopter instructions (JO 7110.65 3-11)', () => {
  it('air taxi via a taxiway to the Coast Guard ramp / helipad', () => {
    expect(one('Coast Guard six one three two seven, air taxi via alpha to the Coast Guard ramp').commands[0]).toMatchObject({ kind: 'AIR_TAXI', taxiMode: 'air', route: ['A'], destination: 'USCG' });
    expect(one('Coast Guard six one three two seven, hover taxi to Coast Guard helipad three').commands[0]).toMatchObject({ kind: 'AIR_TAXI', taxiMode: 'hover', destination: 'USCG-3' });
  });
  it('cleared for takeoff from present position, with the departure turn', () => {
    expect(one('Coast Guard six one three two seven, cleared for takeoff from present position').commands[0]).toMatchObject({ kind: 'TAKEOFF', destination: 'PRESENT' });
    const c = one('Coast Guard six one three two seven, Coast Guard helipad one, make right turn for southeast departure, cleared for takeoff').commands[0];
    expect(c).toMatchObject({ kind: 'TAKEOFF', turnDirection: 'right', headingDeg: 135, destination: 'USCG-1' });
  });
  it('make straight-in approach to the helipad, cleared to land', () => {
    expect(one('Coast Guard six one three two seven, make straight-in approach to Coast Guard helipad two, cleared to land').commands[0]).toMatchObject({ kind: 'LAND', destination: 'USCG-2' });
  });
  it('an ordinary takeoff and landing clearance still need a runway', () => {
    expect(one('N723EJ, runway one three, cleared for takeoff').commands[0]).toMatchObject({ kind: 'TAKEOFF', runwayEnd: '13' });
    expect(one('N723EJ, cleared to land').commands[0].issues.join(' ')).toMatch(/runway/);
  });
});

describe('pattern direction (3-10-1)', () => {
  it('"make right traffic" / "right traffic approved"', () => {
    expect(one('N723EJ, make right traffic').commands[0]).toMatchObject({ kind: 'ENTER_PATTERN', patternLeg: 'right_downwind' });
    expect(one('N723EJ, right traffic approved').commands[0]).toMatchObject({ kind: 'ENTER_PATTERN', patternLeg: 'right_downwind' });
    expect(one('N723EJ, make left closed traffic').commands[0].kind).toBe('PATTERN_INSTRUCTION');
  });
});

describe('overhead maneuver and Class C service', () => {
  it('runway, wind, pattern altitude, report initial (3-10-12)', () => {
    const c = one('Air Guard one three five eight six, runway one three, wind one three zero at eight, pattern altitude one thousand five hundred, report initial').commands[0];
    expect(c).toMatchObject({ kind: 'OVERHEAD', runwayEnd: '13', altitudeFt: 1500, destination: 'INITIAL' });
  });
  it('right turns', () => {
    expect(one('Air Guard one three five eight six, runway one three, pattern altitude one thousand five hundred, right turns, report initial').commands[0]).toMatchObject({ kind: 'OVERHEAD', turnDirection: 'right' });
  });
  it('break at midfield, report break', () => {
    expect(one('Air Guard one three five eight six, break at midfield, report break').commands[0]).toMatchObject({ kind: 'OVERHEAD', destination: 'BREAK' });
  });
  it('squawk, radar contact, radar service terminated + frequency change approved', () => {
    expect(one('N723EJ, squawk four five two one').commands[0]).toMatchObject({ kind: 'SQUAWK', squawk: '4521' });
    expect(one('N723EJ, radar contact').commands[0].kind).toBe('RADAR_CONTACT');
    expect(one('N723EJ, radar service terminated, squawk VFR, frequency change approved').commands.map((c) => c.kind)).toContain('FREQUENCY_CHANGE_APPROVED');
  });
});
