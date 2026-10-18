/** Ground asks Tower for an exit (JO 7110.65 3-1-4; the wording is not prescribed, so it is flagged non-standard). */
import { describe, expect, it } from 'vitest';
import { looksLikeLandline, parseLandline } from './landline';

const ctx = {
  aircraft: [{ callsign: 'NKS1033', spokenCallsign: 'Spirit ten thirty three', type: 'A320' }],
  taxiways: ['A', 'B', 'C', 'H'], runwayEnds: ['4', '22', '13', '31'], playerPositions: ['GND' as const],
};

describe('landline exit request', () => {
  it('"Tower, Ground, have Spirit ten thirty three exit left at Charlie"', () => {
    const c = parseLandline('Tower, Ground, have Spirit ten thirty three exit left at Charlie', ctx);
    expect(c).toMatchObject({ kind: 'REQUEST_EXIT', to: 'TWR', from: 'GND', callsign: 'NKS1033', exitSide: 'left', point: 'C', nonStandard: true });
    expect(c.confidence).toBeGreaterThanOrEqual(0.6);
    expect(c.confidence).toBeLessThan(0.95);
  });
  it('the calling position may be left out when the player works one position', () => {
    expect(parseLandline('Tower, have Spirit ten thirty three exit right at Hotel', ctx)).toMatchObject({ kind: 'REQUEST_EXIT', from: 'GND', exitSide: 'right', point: 'H' });
  });
  it('"... hold short of runway four after landing"', () => {
    const c = parseLandline('Tower, Ground, have Spirit ten thirty three hold short of runway four after landing', ctx);
    expect(c).toMatchObject({ kind: 'REQUEST_EXIT', runwayEnd: '4', holdShortAfterLanding: true });
  });
  it('is recognised as a landline call, and a plain "hold short" to an aircraft is not one', () => {
    expect(looksLikeLandline('Tower, have Spirit ten thirty three exit left at Charlie')).toBe(true);
    expect(looksLikeLandline('Spirit ten thirty three, hold short of runway four')).toBe(false);
  });
  it('a request that names no exit, side or hold short is not understood well enough', () => {
    const c = parseLandline('Tower, Ground, have Spirit ten thirty three exit', ctx);
    expect(c.confidence).toBeLessThan(0.6);
  });
});
