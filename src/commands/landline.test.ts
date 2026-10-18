import { describe, expect, it } from 'vitest';
import { looksLikeLandline, parseLandline } from './landline';
import type { LandlineContext } from './landline';

const ctx: LandlineContext = {
  aircraft: [
    { callsign: 'N723EJ', spokenCallsign: 'Cessna seven two three echo juliet', type: 'C172' },
    { callsign: 'NKS451', spokenCallsign: 'Spirit four fifty one', type: 'A320' },
    { callsign: 'AAL212', spokenCallsign: 'American two twelve', type: 'A320' },
  ],
  runwayEnds: ['4', '22', '13', '31'],
  taxiways: ['A', 'B', 'C', 'D', 'A1'],
  fixes: [{ id: 'CEDAR', name: 'Cedar Lake' }],
};
const p = (t: string) => parseLandline(t, ctx);

describe('landline parser: runway crossings (7110.65 3-1-3)', () => {
  it('Ground asks Tower: "Tower, Ground, cross runway one three at Alpha with Cessna three echo juliet"', () => {
    const r = p('Tower, Ground, cross runway one three at Alpha with Cessna seven two three echo juliet');
    expect(r).toMatchObject({ kind: 'REQUEST_CROSS', to: 'TWR', from: 'GND', callsign: 'N723EJ', runwayEnd: '13', runwayId: '13/31', point: 'A' });
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.nonStandard).toBe(true); // the request wording is not prescribed
  });
  it('accepts "request to cross" and the other end of the runway', () => {
    const r = p('Tower, Ground, request to cross runway three one at alpha with november seven two three echo juliet');
    expect(r).toMatchObject({ kind: 'REQUEST_CROSS', callsign: 'N723EJ', runwayId: '13/31', runwayEnd: '31' });
  });
  it('Tower authorises with the 3-1-3 phraseology: "Ground, Tower, cross runway one three at Alpha"', () => {
    const r = p('Ground, Tower, cross runway one three at Alpha');
    expect(r).toMatchObject({ kind: 'APPROVE', to: 'GND', from: 'TWR', runwayId: '13/31', point: 'A' });
    expect(r.nonStandard).toBe(false);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });
  it('"behind the landing Spirit" is plain words: the aircraft is matched, non-standard', () => {
    const r = p('Ground, Tower, cross runway one three at Alpha behind the landing Spirit four fifty one');
    expect(r).toMatchObject({ kind: 'APPROVE', afterCallsign: 'NKS451' });
    expect(r.nonStandard).toBe(true);
    expect(p('Ground, Tower, cross runway four at bravo, after the landing Spirit').afterCallsign).toBe('NKS451');
  });
  it('short answers: cross approved, unable, hold short, stand by, call you back', () => {
    expect(p('Ground, Tower, cross approved').kind).toBe('APPROVE');
    expect(p('Ground, Tower, approved').kind).toBe('APPROVE');
    expect(p('Ground, Tower, unable').kind).toBe('UNABLE');
    expect(p('Ground, Tower, unable, traffic on a two mile final, call you back').kind).toBe('STANDBY');
    expect(p('Ground, Tower, hold short').kind).toBe('HOLD_SHORT');
    expect(p('Ground, Tower, hold short runway one three').kind).toBe('HOLD_SHORT');
    expect(p('Ground, Tower, stand by').kind).toBe('STANDBY');
    expect(p('Ground, Tower, standby').kind).toBe('STANDBY');
    expect(p("Ground, Tower, I'll call you back").kind).toBe('STANDBY');
    expect(p('Ground, Tower, cross approved').nonStandard).toBe(true); // bare "approved" is not the 3-1-3 form
  });
  it('crossing complete: "Tower, Ground, Cessna ... across runway one three"', () => {
    expect(p('Tower, Ground, Cessna seven two three echo juliet across runway one three')).toMatchObject({ kind: 'CROSS_COMPLETE', callsign: 'N723EJ', runwayId: '13/31' });
  });
  it('flags a missing runway, an unknown taxiway and a missing callsign, lowering the confidence below the 0.6 execute threshold', () => {
    const noRwy = p('Tower, Ground, cross at alpha with Cessna seven two three echo juliet');
    expect(noRwy.kind).toBe('REQUEST_CROSS');
    expect(noRwy.issues).toContain('missing runway');
    expect(noRwy.confidence).toBeLessThan(0.6);
    const noCs = p('Tower, Ground, request to cross runway one three at alpha');
    expect(noCs.kind).toBe('REQUEST_CROSS');
    expect(noCs.callsign).toBeNull();
    expect(noCs.confidence).toBeLessThan(0.6);
    expect(p('Tower, Ground, cross runway one three at zulu with Cessna seven two three echo juliet').issues.join()).toMatch(/unknown taxiway/);
  });
});

describe('landline parser: departure release (4-3-4)', () => {
  it('Tower asks: "Departure, Tower, release Spirit four fifty one"', () => {
    const r = p('Departure, Tower, release Spirit four fifty one');
    expect(r).toMatchObject({ kind: 'REQUEST_RELEASE', to: 'DEP', from: 'TWR', callsign: 'NKS451' });
    expect(r.nonStandard).toBe(true);
  });
  it('Departure releases with the 4-3-4 phrase: "Tower, Departure, Spirit four fifty one released"', () => {
    const r = p('Tower, Departure, Spirit four fifty one released');
    expect(r).toMatchObject({ kind: 'RELEASED', to: 'TWR', from: 'DEP', callsign: 'NKS451' });
    expect(r.nonStandard).toBe(false);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });
  it('hold for release, and a release with "approved"', () => {
    expect(p('Tower, Departure, Spirit four fifty one hold for release')).toMatchObject({ kind: 'HOLD_FOR_RELEASE', callsign: 'NKS451' });
    expect(p('Tower, Departure, Spirit four fifty one release approved').kind).toBe('RELEASED');
    expect(p('Tower, Approach, Spirit four fifty one released').from).toBe('APP');
  });
  it('rolling and going around are information', () => {
    expect(p('Departure, Tower, Spirit four fifty one rolling')).toMatchObject({ kind: 'ROLLING', callsign: 'NKS451' });
    expect(p('Approach, Tower, American two twelve going around')).toMatchObject({ kind: 'GOING_AROUND', callsign: 'AAL212' });
    expect(p('Approach, Tower, aircraft on the go, American two twelve').kind).toBe('GOING_AROUND');
  });
});

describe('landline parser: point out (5-4-3)', () => {
  it('"Approach, Departure, point out, two miles west of Cedar Lake, three thousand, Cessna ..."', () => {
    const r = p('Approach, Departure, point out, two miles west of Cedar Lake, three thousand, Cessna seven two three echo juliet');
    expect(r).toMatchObject({ kind: 'POINT_OUT', to: 'APP', from: 'DEP', callsign: 'N723EJ', altitudeFt: 3000 });
    expect(r.positionText).toBe('2 miles west of cedar lake');
    expect(r.nonStandard).toBe(false);
  });
  it('the positions may be left out', () => {
    const r = p('point out, two miles west of Cedar Lake, three thousand, Cessna seven two three echo juliet');
    expect(r).toMatchObject({ kind: 'POINT_OUT', callsign: 'N723EJ', altitudeFt: 3000 });
    expect(r.to).toBeUndefined();
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });
  it('answers: point out approved, unable, traffic observed', () => {
    expect(p('Departure, Approach, Cessna seven two three echo juliet point out approved')).toMatchObject({ kind: 'POINT_OUT_APPROVED', callsign: 'N723EJ' });
    expect(p('Departure, Approach, Cessna seven two three echo juliet unable point out').kind).toBe('POINT_OUT_UNABLE');
    expect(p('Departure, Approach, traffic observed').kind).toBe('TRAFFIC_OBSERVED');
  });
});

describe('landline parser: speech recognition variants', () => {
  it.each([
    ['tour ground cross runway one three at alpha with cessna seven two three echo juliet', 'REQUEST_CROSS'],
    ['Tower grounds, cross runway 13 at A with Cessna 723EJ', 'REQUEST_CROSS'],
    ['ground tower cross runway one three at alpha', 'APPROVE'],
    ['Ground, Tower, enable, hold short', 'UNABLE'],
    ['ground tower stand by', 'STANDBY'],
    ['departure tower release spirit four five one', 'REQUEST_RELEASE'],
    ['tower departure spirit four fifty one release', 'REQUEST_RELEASE'],
    ['Tower, Departure, Spirit 451 released', 'RELEASED'],
    ['approach departure pointed out two miles west of cedar lake three thousand cessna seven two three echo juliet', 'POINT_OUT'],
    ['departure approach cessna seven two three echo juliet point-out approved', 'POINT_OUT_APPROVED'],
  ])('%s -> %s', (text, kind) => {
    expect(p(text).kind).toBe(kind);
  });
});

describe('landline parser: free text, unknown input, and telling radio calls apart', () => {
  it('free text between two positions is TEXT with a capped confidence', () => {
    const r = p('Tower, Ground, we have a vehicle on the east side');
    expect(r.kind).toBe('TEXT');
    expect(r.text).toBe('we have a vehicle on the east side');
    expect(r.confidence).toBeLessThanOrEqual(0.75);
  });
  it('traffic information', () => {
    expect(p('Approach, Tower, traffic, a Cessna two mile final runway thirteen').kind).toBe('TRAFFIC');
  });
  it('missing positions are reported', () => {
    const r = p('Tower, cross runway one three at alpha with Cessna seven two three echo juliet');
    expect(r.issues.join()).toMatch(/which position is calling/);
    expect(r.confidence).toBeLessThan(0.6);
    expect(p('').kind).toBe('UNKNOWN');
    expect(p('banana').confidence).toBeLessThan(0.3);
  });
  it('only a call that starts with two position names is a landline call', () => {
    expect(looksLikeLandline('Tower, Ground, cross runway one three at alpha')).toBe(true);
    expect(looksLikeLandline('ground tower cross approved')).toBe(true);
    expect(looksLikeLandline('Cessna seven two three echo juliet, runway one three, cleared for takeoff')).toBe(false);
    expect(looksLikeLandline('Spirit four fifty one, contact tower one two zero point three')).toBe(false);
    expect(looksLikeLandline('Tower, ready')).toBe(false);
  });
});
