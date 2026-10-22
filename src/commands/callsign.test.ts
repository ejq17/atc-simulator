import { describe, expect, it } from 'vitest';
import { resolveCallsign } from './callsign';
import { normalize } from './normalize';
import { AIRCRAFT, N993EJ } from './testkit';

const resolve = (say: string, extra = false) => {
  const n = normalize(say);
  return resolveCallsign(n.tokens, extra ? [...AIRCRAFT, N993EJ] : AIRCRAFT);
};

const resolved: [string, string][] = [
  ['N723EJ taxi', 'N723EJ'],
  ['n723ej taxi', 'N723EJ'],
  ['november seven two three echo juliet', 'N723EJ'],
  ['seven two three echo juliet', 'N723EJ'],
  ['Cessna seven two three echo juliet', 'N723EJ'],
  ['Cessna three echo juliet', 'N723EJ'],
  ['three echo juliet', 'N723EJ'],
  ['tree echo juliet', 'N723EJ'],
  ['Skyhawk three echo juliet', 'N723EJ'],
  ['piper four five papa x-ray', 'N45PX'],
  ['five papa x-ray', 'N45PX'],
  ['spirit four fifty one', 'NKS451'],
  ['spirit four five one', 'NKS451'],
  ['spirit four hundred fifty one', 'NKS451'],
  ['spirit 451', 'NKS451'],
  ['Spirit for fifty one', 'NKS451'],
  ['NKS451', 'NKS451'],
  ['american twelve thirty four', 'AAL1234'],
  ['american one two three four', 'AAL1234'],
  ['delta eighty eight', 'DAL88'],
  ['delta 88 heavy', 'DAL88'],
  ['united two oh two', 'UAL202'],
  ['jet blue six one five', 'JBU615'],
  ['southwest seventeen seventeen', 'SWA1717'],
  ['fedex ten eleven', 'FDX1011'],
  ['contact tower one two zero point three spirit four fifty one', 'NKS451'],
  // STT damage with an explicit prefix: split digits, garbled or missing letters, one inserted/dropped digit
  ['november 7, 2, 3, echo juliet taxi', 'N723EJ'],
  ['november 723 echo zero contact tower', 'N723EJ'],
  ['cessna 723 contact tower', 'N723EJ'],
  ['november 7023 echo juliet taxi', 'N723EJ'],
  ['november 72 echo juliet taxi', 'N723EJ'],
];

describe('resolveCallsign', () => {
  it.each(resolved)('%s -> %s', (say, expected) => {
    const r = resolve(say);
    expect(r.callsign).toBe(expected);
    expect(r.score).toBeGreaterThanOrEqual(0.75);
    expect(r.ambiguous).toBe(false);
    expect(r.span).not.toBeNull();
  });

  it('scores a full N-number higher than an abbreviation', () => {
    expect(resolve('november seven two three echo juliet').score).toBeGreaterThan(resolve('three echo juliet').score);
  });

  it('reports ambiguity when two aircraft share the suffix', () => {
    const r = resolve('three echo juliet', true);
    expect(r.callsign).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.candidates.map((c) => c.callsign).sort()).toEqual(['N723EJ', 'N993EJ']);
    expect(r.issues[0]).toContain('ambiguous callsign');
  });

  it('resolves the full number even when a suffix twin exists', () => {
    expect(resolve('nine nine three echo juliet', true).callsign).toBe('N993EJ');
    expect(resolve('seven two three echo juliet', true).callsign).toBe('N723EJ');
  });

  it('never guesses a near miss on the flight number', () => {
    const r = resolve('spirit four fifty two');
    expect(r.callsign).toBeNull();
    expect(r.candidates[0].callsign).toBe('NKS451');
    expect(r.candidates[0].score).toBeLessThan(0.75);
    expect(r.issues[0]).toContain('low-confidence');
  });

  it('never guesses a near miss on an N-number', () => {
    const r = resolve('november seven two four echo juliet');
    expect(r.callsign).toBeNull();
    expect(r.candidates[0]?.callsign).toBe('N723EJ');
  });

  it('does not accept missing letters or a dropped digit without an explicit prefix', () => {
    expect(resolve('723 contact tower').callsign).toBeNull();
    expect(resolve('72 echo juliet taxi').callsign).toBeNull();
  });

  it('does not accept a dropped digit when the letters differ', () => {
    expect(resolve('november 72 echo kilo taxi').callsign).toBeNull();
  });

  it('rejects a two-character abbreviation', () => {
    expect(resolve('echo juliet taxi').callsign).toBeNull();
  });

  it('reports an unknown airline flight', () => {
    const r = resolve('frontier one hundred');
    expect(r.callsign).toBeNull();
    expect(r.mentioned).toBe(true);
    expect(r.issues[0]).toContain('not recognised');
  });

  it('reports a missing callsign', () => {
    const r = resolve('taxi to runway two two via alpha');
    expect(r.callsign).toBeNull();
    expect(r.mentioned).toBe(false);
    expect(r.issues).toEqual(['missing callsign']);
  });

  it('does not mistake a runway number for a callsign', () => {
    expect(resolve('runway one three cleared for takeoff').mentioned).toBe(false);
    expect(resolve('hold short of runway two two').mentioned).toBe(false);
  });

  it('does not mistake heading or altitude values for a callsign', () => {
    expect(resolve('turn left heading two seven zero climb and maintain five thousand').mentioned).toBe(false);
  });

  it('flags several different callsigns in one transmission', () => {
    const r = resolve('spirit four fifty one follow united two oh two');
    expect(r.callsign).not.toBeNull();
    expect(r.otherCallsigns.length).toBe(1);
  });
});

describe('business / commuter type words and heavy callsigns (types added 2026-10-21)', () => {
  const list = [
    ...AIRCRAFT,
    { callsign: 'N421KA', spokenCallsign: 'King Air four two one kilo alpha', type: 'BE20' },
    { callsign: 'N88GX', spokenCallsign: 'Challenger eight eight golf x-ray', type: 'CL35' },
    { callsign: 'N512PC', spokenCallsign: 'Pilatus five twelve papa charlie', type: 'PC12' },
    { callsign: 'UPS451', spokenCallsign: 'U P S four fifty one heavy', type: 'MD11' },
  ];
  const res = (say: string) => resolveCallsign(normalize(say).tokens, list).callsign;
  it('resolves them from the spoken type word, with and without the heavy word', () => {
    expect(res('king air four two one kilo alpha')).toBe('N421KA');
    expect(res('king air one kilo alpha')).toBe('N421KA');
    expect(res('challenger eight eight golf x-ray')).toBe('N88GX');
    expect(res('pilatus five twelve papa charlie')).toBe('N512PC');
    expect(res('ups four fifty one')).toBe('UPS451');
    expect(res('ups four fifty one heavy')).toBe('UPS451');
  });
});
