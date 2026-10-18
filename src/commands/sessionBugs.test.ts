/**
 * Lines from a real 33-minute KACY free-play session (Ground by the player, AI Tower; the player also keyed up on the Tower frequency), with the
 * wording speech recognition produced. Each was parsed wrongly or refused; the fixes are checked here on the exact transcripts and on variants.
 */
import { describe, expect, it } from 'vitest';
import { parse } from './parse';
import { looksLikeLandline, parseLandline } from './landline';
import type { LandlineContext } from './landline';
import type { ParseContext } from './context';
import { spokenCallsign } from '../radio/spoken';

const AIRCRAFT = [
  { callsign: 'N740LR', spokenCallsign: 'Cessna seven four zero lima romeo', type: 'C172' },
  { callsign: 'N8088Q', spokenCallsign: 'Cessna eight zero eight eight quebec', type: 'C172' },
  { callsign: 'NKS1232', spokenCallsign: 'Spirit twelve thirty two', type: 'A320' },
  { callsign: 'NKS1033', spokenCallsign: 'Spirit ten thirty three', type: 'A320' },
  { callsign: 'N6195M', spokenCallsign: 'Cessna six one niner five mike', type: 'C172' },
  { callsign: 'ANG92078', spokenCallsign: `${spokenCallsign('ANG92078', 'F16')} flight of two`, type: 'F16' },
  { callsign: 'APT1', spokenCallsign: spokenCallsign('APT1', 'VEH'), type: 'VEH' },
  { callsign: 'CGD23850', spokenCallsign: spokenCallsign('CGD23850', 'H65'), type: 'H65' },
];
const TAXIWAYS = ['A', 'B', 'C', 'D', 'E', 'H', 'J', 'K', 'L', 'M', 'N', 'P'];
const ctx: ParseContext = { aircraft: AIRCRAFT, taxiways: TAXIWAYS, runwayEnds: ['4', '22', '13', '31'], frequencies: [{ id: 'GND', mhz: 121.9 }, { id: 'TWR', mhz: 120.3 }] };
const lctx: LandlineContext = { aircraft: AIRCRAFT, taxiways: TAXIWAYS, runwayEnds: ctx.runwayEnds, playerPositions: ['GND'] };

describe('speech recognition of "via" (JO 7110.65 3-7-2: the taxi clearance carries the route)', () => {
  const taxi = (say: string, callsign: string) => {
    const r = parse(say, ctx);
    expect(r.callsign).toBe(callsign);
    expect(r.commands).toHaveLength(1);
    return r.commands[0];
  };
  it('"be on November Papa Delta Alpha" (the session line) keeps the route and the hold short, in one command', () => {
    const c = taxi('November 8 0 8 8 Quebec taxi to runway 4 be on November Papa Delta Alpha hold short runway 4 on Alpha', 'N8088Q');
    expect(c).toMatchObject({ kind: 'TAXI', runwayEnd: '4', route: ['N', 'P', 'D', 'A'], holdShort: ['RWY4'] });
    expect(c.issues).toEqual([]);
    expect(c.confidence).toBeGreaterThan(0.9);
  });
  it('"be in November, Papa, Delta, Alpha, ... on an Alpha" (the session line)', () => {
    const c = taxi('Spirit 1232, taxi to runway 4, be in November, Papa, Delta, Alpha, hold short runway 4 on an Alpha.', 'NKS1232');
    expect(c).toMatchObject({ kind: 'TAXI', runwayEnd: '4', route: ['N', 'P', 'D', 'A'], holdShort: ['RWY4'] });
    expect(c.issues).toEqual([]);
  });
  it.each([
    'Spirit 1232 taxi to runway 4 been November Papa Delta Alpha',
    'Spirit 1232 taxi to runway 4 V a November Papa Delta Alpha',
    'Spirit 1232 taxi to runway 4 via a November Papa Delta Alpha',
    'Spirit 1232 taxi to runway 4 be a November Papa Delta Alpha',
    'Spirit 1232 taxi to runway 4 be on a November Papa Delta Alpha',
  ])('%s', (say) => {
    expect(taxi(say, 'NKS1232')).toMatchObject({ kind: 'TAXI', runwayEnd: '4', route: ['N', 'P', 'D', 'A'] });
  });
  it('"on an Alpha" is "on Alpha", and a typed taxiway "via A C" is untouched', () => {
    expect(taxi('Spirit 1232 taxi to runway 4 via November, hold short of runway 4 on an Alpha', 'NKS1232')).toMatchObject({ route: ['N'], holdShort: ['RWY4'] });
    expect(taxi('Spirit 1232 taxi to runway 4 via A C', 'NKS1232')).toMatchObject({ route: ['A', 'C'] });
  });
  it('"limo Romeo" is lima romeo and "tax in" is taxi to', () => {
    expect(parse('November 7 4 0 limo Romeo contact hour', ctx).callsign).toBe('N740LR');
    expect(taxi('Spirit 1232 tax in runway 4 via November Papa Delta Alpha', 'NKS1232')).toMatchObject({ kind: 'TAXI', runwayEnd: '4', route: ['N', 'P', 'D', 'A'] });
  });
});

describe('callsign aliases (JO 7110.65 2-4-20; AC 150/5210-20A)', () => {
  it.each([
    ['Air National Guard 92078, continue down runway 22, turn right on the Alpha.', 'ANG92078'],
    ['Air National Guard niner two zero seven eight flight of two, cross runway 13', 'ANG92078'],
    ['National Guard 92078 hold position', 'ANG92078'],
    ['Air Guard 92078 hold position', 'ANG92078'],
    ['Air Guard niner two zero seven eight flight of two hold position', 'ANG92078'],
    ['Airport vehicle one taxi to runway 13 via Bravo', 'APT1'],
    ['Airport vehicle 1, taxi to runway 13 via Bravo', 'APT1'],
    ['Airport one vehicle taxi to runway 13 via Bravo', 'APT1'],
    ['Airport 1 vehicle taxi to runway 13 via Bravo', 'APT1'],
    ['Airport 1, taxi to runway 13 via Bravo.', 'APT1'],
    ['Coast Guard 23850 hold position', 'CGD23850'],
  ])('%s -> %s', (say, callsign) => {
    expect(parse(say, ctx).callsign).toBe(callsign);
  });
  it('"airport" and "vehicle" elsewhere are not swallowed', () => {
    expect(parse('Spirit 1232 hold short of runway 13, airport vehicle on the runway', ctx).callsign).toBe('NKS1232');
  });
});

describe('a stopped aircraft: "continue down the runway, turn right on Alpha" (JO 7110.65 3-10-9 turn, 3-7-2 taxi)', () => {
  it('the session line is ONE runway exit instruction, not CONTINUE_APPROACH + an exit', () => {
    const r = parse('Air National Guard 92078, continue down runway 22, turn right on the Alpha.', ctx);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toMatchObject({ kind: 'EXIT_RUNWAY', exitTaxiway: 'A', turnDirection: 'right' });
    expect(r.commands[0].confidence).toBeGreaterThan(0.8);
  });
  it('the speech-recognised line ("contonie down runway 22 turn right on alpha")', () => {
    const r = parse('Air Guard niner two zero seven eight flight of two, contonie down runway 22 turn right on alpha', ctx);
    expect(r.commands.map((c) => c.kind)).toEqual(['EXIT_RUNWAY']);
    expect(r.commands[0]).toMatchObject({ exitTaxiway: 'A', turnDirection: 'right' });
  });
  it('"continue down the runway" alone is the exit at the end; "continue to the end" and "turn right at the next taxiway" too', () => {
    expect(parse('Air Guard niner two zero seven eight, continue down the runway', ctx).commands[0]).toMatchObject({ kind: 'EXIT_RUNWAY', destination: 'END' });
    expect(parse('Air Guard niner two zero seven eight, continue to the end', ctx).commands[0]).toMatchObject({ kind: 'EXIT_RUNWAY', destination: 'END' });
    expect(parse('Air Guard niner two zero seven eight, turn right at the next taxiway', ctx).commands[0]).toMatchObject({ kind: 'EXIT_RUNWAY', destination: 'NEXT', turnDirection: 'right' });
  });
  it('"cross runway 13 and turn right on aplha": a crossing and an exit, no "missing heading"', () => {
    const r = parse('Air Guard niner two zero seven eight flight of two, cross runway 13 and turn right on aplha', ctx);
    expect(r.commands.map((c) => c.kind)).toEqual(['CROSS_RUNWAY', 'EXIT_RUNWAY']);
    expect(r.commands[0]).toMatchObject({ crossRunwayId: '13/31' });
    expect(r.commands[1]).toMatchObject({ exitTaxiway: 'A', turnDirection: 'right' });
    expect(r.commands.flatMap((c) => c.issues).join(' ')).not.toMatch(/missing heading/);
  });
  it('a heading instruction is still a heading', () => {
    expect(parse('Spirit 1232 turn right heading 270', ctx).commands[0]).toMatchObject({ kind: 'HEADING', turnDirection: 'right', headingDeg: 270 });
    expect(parse('Spirit 1232 continue approach', ctx).commands[0].kind).toBe('CONTINUE_APPROACH');
  });
});

describe('one readback for taxi + hold short (3-7-2)', () => {
  it('a taxi whose route could not be read followed by "hold short" is one command with the hold short', () => {
    const r = parse('Spirit 1232 taxi to runway 4 blah blah blah, hold short of runway 4', ctx);
    expect(r.commands.map((c) => c.kind)).toEqual(['TAXI']);
    expect(r.commands[0]).toMatchObject({ runwayEnd: '4', holdShort: ['RWY4'] });
  });
  it('a hold short of another runway or taxiway is merged the same way; a lone hold short stays a hold short', () => {
    expect(parse('Spirit 1232 taxi to the ramp via foo bar, hold short of runway 13', ctx).commands.map((c) => c.kind)).toEqual(['TAXI_TO_PARKING']);
    expect(parse('Spirit 1232 hold short of runway 13', ctx).commands.map((c) => c.kind)).toEqual(['HOLD_SHORT']);
  });
});

describe('landline: the calling position is optional when the player works one position (JO 7110.65 3-1-3)', () => {
  it.each([
    'Tower, cross runway four at Bravo with Spirit ten thirty three',
    'Tower, request to cross runway four at Bravo, Spirit ten thirty three',
    'Tower cross runway four at Bravo for Spirit 1033',
    'Tower, Spirit ten thirty three, request to cross runway four at Bravo',
    'Tower cross runway four at Bravo spirit 1033',
    'Tower request cross runway 4 at B Spirit 1033',
    'Tower, Ground, cross runway four at Bravo spirit 1033',
  ])('%s', (say) => {
    const c = parseLandline(say, lctx);
    expect(c).toMatchObject({ kind: 'REQUEST_CROSS', to: 'TWR', from: 'GND', callsign: 'NKS1033', runwayId: '4/22', point: 'B' });
    expect(c.confidence).toBeGreaterThanOrEqual(0.8);
    expect(c.issues).toEqual([]);
  });
  it('without a point it is still a request (flagged), not a failure', () => {
    const c = parseLandline('Tower, cross runway four with Spirit ten thirty three', lctx);
    expect(c).toMatchObject({ kind: 'REQUEST_CROSS', to: 'TWR', from: 'GND', callsign: 'NKS1033' });
    expect(c.confidence).toBeGreaterThanOrEqual(0.6);
  });
  it('a player who works two positions must still say who is calling', () => {
    const c = parseLandline('Tower, cross runway four at Bravo with Spirit ten thirty three', { ...lctx, playerPositions: ['GND', 'APP'] });
    expect(c.from).toBeUndefined();
    expect(c.confidence).toBeLessThan(0.6);
    expect(c.issues.join(' ')).toMatch(/which position is calling/);
  });
  it('the called position cannot be the player\'s own', () => {
    expect(parseLandline('Ground, cross runway four at Bravo with Spirit ten thirty three', lctx).from).toBeUndefined();
  });
});

describe('a radio call that starts with a position name and asks for a coordination is a landline call, not a clearance', () => {
  it.each([
    'Tower cross runway four at Bravo spirit 1033',
    'Tower, cross runway four at Bravo with Spirit ten thirty three',
    'Tower, request to cross runway four at Bravo, Spirit ten thirty three',
    'Departure, release Spirit twelve thirty two',
    'Approach, point out, two miles west of Cedar Lake, three thousand, Cessna seven four zero lima romeo',
  ])('%s', (say) => {
    expect(looksLikeLandline(say)).toBe(true);
  });
  it.each([
    'Spirit 1033 cross runway 4 at Bravo',
    'Spirit 1033 contact tower 120.3',
    'Spirit 1033 taxi to runway 4 via Bravo, contact ground',
    'N740LR cross runway four at Bravo',
  ])('an instruction to an aircraft is not: %s', (say) => {
    expect(looksLikeLandline(say)).toBe(false);
  });
});
