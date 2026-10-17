import { describe, expect, it } from 'vitest';
import { normalize } from './normalize';
import { rawSlice } from './tokens';

const cases: [string, string][] = [
  ['I L S', 'ils'],
  ['i.l.s.', 'ils'],
  ['eye el es', 'ils'],
  ['R-NAV', 'rnav'],
  ['are nav', 'rnav'],
  ['spirit four fifty one, four miles', 'NKS 451 4 miles'],
  ['expect one zero thousand one zero minutes', 'expect 10000 10 minutes'],
  ['expect flight level two three zero ten minutes', 'expect fl 230 10 minutes'],
  ['maintain two thousand five hundred', 'maintain 2500'],
  ['one three', '13'],
  ['two thousand five hundred', '2500'],
  ['tree', '3'],
  ['fife', '5'],
  ['niner', '9'],
  ['one two one point niner', '121.9'],
  ['one two zero point three', '120.3'],
  ['flight level one two zero', 'fl 120'],
  ['FL180', 'fl 180'],
  ['alfa bravo charlie', 'a b c'],
  ['x-ray yankee zulu', 'x y z'],
  ['xray', 'x'],
  ['Juliett Oscar', 'j o'],
  ['juliet', 'j'],
  ['Spirit four five one', 'NKS 451'],
  ['spirit four fifty one', 'NKS 451'],
  ['spirit four hundred fifty one', 'NKS 451'],
  ['sun country two oh one', 'SCX 201'],
  ['jet blue six fifteen', 'JBU 615'],
  ['JetBlue 615', 'JBU 615'],
  ['fed ex ten eleven', 'FDX 1011'],
  ['Delta 88 heavy', 'DAL 88 heavy'],
  ['taxi via delta', 'taxi via d'],
  ['Mesa three oh one', 'ASH 301'],
  ['PSA 123', 'JIA 123'],
  ['american to fifty one', 'AAL 251'],
  // STT ordinals and punctuation inside a callsign
  ['November 4th, 5, Romeo Tango', 'n 4 5 r t'],
  ['November 6th, 0, 0, 4, Tango.', 'n 6 0 0 4 t'],
  ['november six zero zero for tango', 'n 6004 t'],
  ['november 6000 for tango', 'n 60004 t'],
  ['taxi to runway for via alpha', 'taxi to runway 4 via a'],
  ['taxi to runway 4 for departure', 'taxi to runway 4 for departure'],
  // fused / mangled NATO words next to a callsign or taxiway
  ['november 467 ecosira', 'n 467 e s'],
  ['november 467 ecociera', 'n 467 e s'],
  ['via baravo papa lima', 'via b p l'],
  ['cessna 45 romeo tango report midfield', 'cessna 45 r t report midfield'],
  ['november 123 holding short', 'n 123 holding short'],
  ['spirit for fifty one', 'NKS 451'],
  ['cleared for take off', 'cleared for takeoff'],
  ['Runway 13.', 'runway 13'],
  ['N723EJ', 'n 723 e j'],
  ['Cessna 3EJ', 'cessna 3 e j'],
  ['november seven two three echo juliet', 'n 723 e j'],
  ['descend and maintain 2,500', 'descend and maintain 2500'],
  ['heading zero niner zero', 'heading 090'],
  ['one oh one', '101'],
  ['reduce speed to one eight zero', 'reduce speed to 180'],
  ['taxi to runway two two', 'taxi to runway 22'],
  ['runway won three', 'runway 13'],
  ['line up and weight', 'line up and wait'],
  ['contact ground on one two one point niner', 'contact ground on 121.9'],
  ['ground point niner', 'ground .9'],
  ['twenty two', '22'],
  ['four hundred fifty one', '451'],
  ['one zero thousand', '10000'],
  ['runway zero four', 'runway 04'],
  ['rwy 13', 'runway 13'],
  ['hold short of runway 1 3', 'hold short of runway 13'],
  ['Southwest seventeen seventeen', 'SWA 1717'],
  ['American twelve thirty four', 'AAL 1234'],
  ['Cessna seven two three Echo Juliet.', 'cessna 723 e j'],
];

describe('normalize', () => {
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(normalize(input).text).toBe(expected);
  });

  it('keeps extra airline names supplied by the caller', () => {
    expect(normalize('Cactus twelve', { extraAirlines: { cactus: 'AWE' } }).text).toBe('AWE 12');
  });

  it('is reversible: tokens map back to the raw words', () => {
    const n = normalize('Spirit four fifty one, turn left heading two seven zero');
    expect(n.tokens.map((t) => t.text)).toEqual(['NKS', '451', 'turn', 'left', 'heading', '270']);
    expect(rawSlice(n, 0, 2)).toBe('Spirit four fifty one,');
    expect(rawSlice(n, 5, 6)).toBe('two seven zero');
    expect(n.raw).toBe('Spirit four fifty one, turn left heading two seven zero');
  });

  it('handles empty input', () => {
    const n = normalize('   ');
    expect(n.tokens).toEqual([]);
    expect(n.text).toBe('');
  });
});
