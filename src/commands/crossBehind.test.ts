/** Parser: conditional crossing "cross runway 13 at Bravo behind the landing Cessna" (ICAO Doc 4444 conditional clearance, never 7110.65). */
import { describe, expect, it } from 'vitest';
import { parseTransmission } from './index';
import { AIRCRAFT, CTX } from './testkit';

const one = (say: string, ctx = CTX) => {
  const r = parseTransmission(say, ctx);
  expect(r.commands, say).toHaveLength(1);
  return r.commands[0];
};
const NONSTD = /conditional "behind" crossing is an ICAO Doc 4444 clearance, not 7110.65/;

describe('conditional crossing', () => {
  it('"cross runway 13 at Bravo behind the landing Cessna" names the lander and is flagged non-standard', () => {
    const c = one('Spirit four fifty one, cross runway one three at Bravo behind the landing Cessna');
    expect(c).toMatchObject({ kind: 'CROSS_RUNWAY', callsign: 'NKS451', crossRunwayId: '13/31', runwayEnd: '13', route: ['B'], behindCallsign: 'N723EJ' });
    expect(c.issues.join(' ')).toMatch(NONSTD);
    expect(c.issues).toHaveLength(1);
  });

  it('is less confident than the plain crossing', () => {
    const plain = one('Spirit four fifty one, cross runway one three at Bravo');
    const cond = one('Spirit four fifty one, cross runway one three at Bravo behind the landing Cessna');
    expect(plain.behindCallsign).toBeUndefined();
    expect(plain.issues).toEqual([]);
    expect(cond.confidence).toBeLessThan(plain.confidence);
    expect(cond.confidence).toBeCloseTo(plain.confidence * 0.9, 1);
  });

  it.each([
    ['cross runway one three behind the landing Spirit four fifty one', 'NKS451', 'N723EJ'],
    ['cross runway one three behind the landing Spirit', 'NKS451', 'N723EJ'],
    ['cross runway one three behind the Skyhawk', 'N723EJ', 'NKS451'],
    ['cross runway one three after the Piper', 'N45PX', 'N723EJ'],
    ['cross runway one three behind the arriving American twelve thirty four', 'AAL1234', 'N723EJ'],
    ['cross runway one three behind november four five papa x-ray', 'N45PX', 'N723EJ'],
    ['cross runway one three behind Cessna seven two three echo juliet', 'N723EJ', 'NKS451'],
  ])('%s', (tail, behind, addressed) => {
    const c = one(`${addressed === 'N723EJ' ? 'Cessna seven two three echo juliet' : 'Spirit four fifty one'}, ${tail}`);
    expect(c).toMatchObject({ kind: 'CROSS_RUNWAY', callsign: addressed, behindCallsign: behind });
    expect(c.issues.join(' ')).toMatch(NONSTD);
  });

  it('the addressed aircraft is the one named first even when the aircraft to wait for is spoken in full', () => {
    const c = one('three echo juliet, cross runway one three behind the landing Spirit four fifty one');
    expect(c).toMatchObject({ callsign: 'N723EJ', behindCallsign: 'NKS451' });
  });

  it('the callsign may follow the clause, and a clause with only the lander and no addressed aircraft has no callsign', () => {
    expect(one('cross runway one three behind the landing Spirit four fifty one, Cessna seven two three echo juliet')).toMatchObject({ callsign: 'N723EJ', behindCallsign: 'NKS451' });
    const c = one('cross runway one three behind the landing Spirit four fifty one');
    expect(c.callsign).toBeNull();
    expect(c.behindCallsign).toBe('NKS451');
  });

  it('"behind" may come before the taxiway', () => {
    expect(one('Spirit four fifty one, cross runway one three behind the Cessna at Bravo')).toMatchObject({ route: ['B'], behindCallsign: 'N723EJ' });
  });

  it('an aircraft type that fits several active aircraft is ambiguous: an issue, no behindCallsign, not executable', () => {
    const ctx = { ...CTX, aircraft: [...AIRCRAFT, { callsign: 'N55CA', spokenCallsign: 'Cessna five five charlie alpha', type: 'C182' }] };
    const c = one('Spirit four fifty one, cross runway one three behind the landing Cessna', ctx);
    expect(c.behindCallsign).toBeUndefined();
    expect(c.issues[0]).toMatch(/conditional crossing: 'the landing cessna' fits N723EJ, N55CA/);
    expect(c.issues.join(' ')).toMatch(NONSTD);
    expect(c.issues.join(' ')).toMatch(/missing aircraft to cross behind/);
    expect(c.confidence).toBeLessThan(0.6);
  });

  it('no aircraft matches: an issue, behindCallsign unset, and low enough confidence that the engine asks again', () => {
    const ctx = { ...CTX, aircraft: AIRCRAFT.filter((a) => a.callsign !== 'N723EJ') };
    const c = one('Spirit four fifty one, cross runway one three behind the landing Cessna', ctx);
    expect(c.behindCallsign).toBeUndefined();
    expect(c.issues[0]).toBe("conditional crossing: no aircraft matches 'the landing cessna'");
    expect(c.confidence).toBeLessThan(0.6);
  });

  it('a callsign that is not active is not guessed from its telephony word', () => {
    const c = one('Spirit four fifty one, cross runway one three behind the landing Spirit nine nine nine');
    expect(c.behindCallsign).toBeUndefined();
    expect(c.issues.join(' ')).toMatch(/no aircraft matches/);
  });

  it('nothing after "behind" is an issue too', () => {
    const c = one('Spirit four fifty one, cross runway one three behind');
    expect(c.behindCallsign).toBeUndefined();
    expect(c.issues[0]).toMatch(/no aircraft named after "behind"/);
  });

  it('README example', () => {
    const c = one('Spirit four fifty one, cross runway one three at Bravo behind the landing Cessna');
    expect(c).toMatchObject({ kind: 'CROSS_RUNWAY', crossRunwayId: '13/31', route: ['B'], behindCallsign: 'N723EJ' });
  });
});
