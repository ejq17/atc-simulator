import { describe, expect, it } from 'vitest';
import { parseTransmission } from './index';
import { AIRCRAFT, CTX, FIX_CTX, type Case } from './testkit';

const S = 'Spirit four fifty one';
const NKS = { callsign: 'NKS451' };
const CLNC = 'cleared to Philadelphia airport via the Atlantic City Three departure, radar vectors, then as filed, maintain two thousand, expect one zero thousand one zero minutes after departure, departure frequency one two four point six, squawk four two one five';

function run(groups: Record<string, Case[]>) {
  for (const [name, cases] of Object.entries(groups)) {
    describe(name, () => {
      it.each(cases.map((c) => [c.say, c] as const))('%s', (_say, c) => {
        const r = parseTransmission(c.say, c.ctx ?? FIX_CTX);
        expect(r.commands.map((x) => x.kind)).toEqual(c.cmds.map((x) => x.kind));
        c.cmds.forEach((want, i) => expect(r.commands[i]).toMatchObject(want));
        const issues = r.commands.flatMap((x) => x.issues);
        if (c.issue) expect(issues.join(' | ')).toContain(c.issue);
        if (c.clean) expect(issues).toEqual([]);
        if (c.conf) for (const x of r.commands) {
          expect(x.confidence).toBeGreaterThanOrEqual(c.conf[0]);
          expect(x.confidence).toBeLessThanOrEqual(c.conf[1]);
        }
      });
    });
  }
}

run({
  'approach clearances': [
    { say: `${S}, cleared ILS runway one three approach`, cmds: [{ kind: 'APPROACH', ...NKS, approachType: 'ILS', runwayEnd: '13', runwayId: '13/31' }], clean: true, conf: [0.95, 1] },
    { say: `${S}, cleared I-L-S runway 13 approach`, cmds: [{ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '13' }], clean: true },
    { say: `${S}, cleared for the ILS one three`, cmds: [{ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '13' }], clean: true },
    { say: `${S}, cleared RNAV runway two two approach`, cmds: [{ kind: 'APPROACH', approachType: 'RNAV', runwayEnd: '22', runwayId: '4/22' }], clean: true },
    { say: `${S}, cleared RNAV GPS runway 4 approach`, cmds: [{ kind: 'APPROACH', approachType: 'RNAV', runwayEnd: '4' }], clean: true },
    { say: `${S}, cleared VOR runway three one approach`, cmds: [{ kind: 'APPROACH', approachType: 'VOR', runwayEnd: '31' }], clean: true },
    { say: `${S}, cleared visual approach runway one three`, cmds: [{ kind: 'APPROACH', approachType: 'VISUAL', runwayEnd: '13' }], clean: true },
    { say: `${S}, cleared for the visual, runway 13`, cmds: [{ kind: 'APPROACH', approachType: 'VISUAL', runwayEnd: '13' }], clean: true },
    { say: `${S}, cleared localizer runway 31 approach`, cmds: [{ kind: 'APPROACH', approachType: 'LOC', runwayEnd: '31' }], clean: true },
    { say: `${S}, cleared the ILS runway 13 approach`, cmds: [{ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '13' }], clean: true },
    { say: `${S}, cleared straight in ILS runway 31 approach`, cmds: [{ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '31' }], clean: true },
    { say: `${S}, runway 13, cleared ILS approach`, cmds: [{ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '13' }], clean: true },
    { say: `${S}, cleared ILS approach runway 13`, cmds: [{ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '13' }], clean: true },
    { say: `${S}, cleared ILS or localizer runway 13 approach`, cmds: [{ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '13' }], clean: true },
    { say: 'SPIRIT 451 CLEARED ILS RUNWAY 31 APPROACH', cmds: [{ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '31' }], clean: true },
    { say: `${S}, cleared ILS runway one three approach, contact tower one two zero point three`,
      cmds: [{ kind: 'APPROACH', runwayEnd: '13' }, { kind: 'CONTACT_FREQUENCY', frequencyId: 'TWR', frequencyMhz: 120.3 }], clean: true },
    { say: `${S}, cleared ILS runway 9 approach`, cmds: [{ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '9' }], issue: 'unknown runway 9', conf: [0.5, 0.9] },
    { say: `${S}, cleared ILS approach`, cmds: [{ kind: 'APPROACH', approachType: 'ILS' }], issue: 'missing runway', conf: [0, 0.6] },
    { say: `${S}, cleared ILS runway 13 approach`, ctx: { aircraft: AIRCRAFT }, cmds: [{ kind: 'APPROACH', runwayEnd: '13' }], clean: true },
    { say: `${S}, cleared NDB runway 13 approach`, cmds: [{ kind: 'UNKNOWN' }], issue: 'unsupported instruction: approach clearance', conf: [0, 0.2] },
  ],

  'approach type spoken by STT': [
    { say: `${S}, cleared I L S runway one three approach`, cmds: [{ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '13' }], clean: true },
    { say: `${S}, cleared i.l.s. runway 13 approach`, cmds: [{ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '13' }], clean: true },
    { say: `${S}, cleared eye el es runway 13 approach`, cmds: [{ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '13' }], clean: true },
    { say: `${S}, cleared R NAV runway two two approach`, cmds: [{ kind: 'APPROACH', approachType: 'RNAV', runwayEnd: '22' }], clean: true },
    { say: `${S}, cleared are nav runway two two approach`, cmds: [{ kind: 'APPROACH', approachType: 'RNAV', runwayEnd: '22' }], clean: true },
    { say: `${S}, cleared R-NAV GPS runway 4 approach`, cmds: [{ kind: 'APPROACH', approachType: 'RNAV', runwayEnd: '4' }], clean: true },
    { say: `${S}, cleared V O R runway 31 approach`, cmds: [{ kind: 'APPROACH', approachType: 'VOR', runwayEnd: '31' }], clean: true },
    { say: `${S}, cleared localiser runway 31 approach`, cmds: [{ kind: 'APPROACH', approachType: 'LOC', runwayEnd: '31' }], clean: true },
  ],

  'vectors and altitude restrictions before an approach': [
    { say: `${S}, four miles from CARYL, turn right heading one zero zero, maintain two thousand until established on the localizer, cleared ILS runway one three approach`,
      cmds: [
        { kind: 'HEADING', ...NKS, headingDeg: 100, turnDirection: 'right' },
        { kind: 'ALTITUDE', altitudeFt: 2000, destination: 'UNTIL_ESTABLISHED' },
        { kind: 'APPROACH', approachType: 'ILS', runwayEnd: '13' },
      ], clean: true, conf: [0.9, 1] },
    { say: `${S}, descend and maintain three thousand until established, cleared ILS runway 31 approach`,
      cmds: [{ kind: 'ALTITUDE', altitudeFt: 3000, destination: 'UNTIL_ESTABLISHED' }, { kind: 'APPROACH', runwayEnd: '31' }], clean: true },
    { say: `${S}, maintain 2000 until CARYL`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 2000, destination: 'UNTIL_CARYL', fix: 'CARYL' }], clean: true },
    { say: `${S}, maintain 2000 until Carol, cleared RNAV runway 22 approach`,
      cmds: [{ kind: 'ALTITUDE', destination: 'UNTIL_CARYL', fix: 'CARYL' }, { kind: 'APPROACH', approachType: 'RNAV' }], clean: true },
    { say: `${S}, maintain 2000 until zebra`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 2000, fix: 'ZEBRA' }], issue: 'unknown fix ZEBRA' },
    { say: `${S}, two miles south of the field, fly heading 090`, cmds: [{ kind: 'HEADING', headingDeg: 90 }], clean: true },
    { say: `${S}, five miles from MAYBN, cleared visual approach runway 13`, cmds: [{ kind: 'APPROACH', approachType: 'VISUAL', runwayEnd: '13' }], clean: true },
    { say: `${S}, climb and maintain 3000`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 3000 }], clean: true },
  ],

  'direct to fix': [
    { say: `${S}, proceed direct CARYL`, cmds: [{ kind: 'DIRECT_FIX', ...NKS, fix: 'CARYL' }], clean: true, conf: [0.95, 1] },
    { say: `${S}, direct Cedar Lake`, cmds: [{ kind: 'DIRECT_FIX', fix: 'VCN' }], clean: true },
    { say: `${S}, cleared direct SIE`, cmds: [{ kind: 'DIRECT_FIX', fix: 'SIE' }], clean: true },
    { say: `${S}, direct to MAYBN`, cmds: [{ kind: 'DIRECT_FIX', fix: 'MAYBN' }], clean: true },
    { say: `${S}, proceed direct carol`, cmds: [{ kind: 'DIRECT_FIX', fix: 'CARYL' }], clean: true },
    { say: `${S}, proceed direct maybin`, cmds: [{ kind: 'DIRECT_FIX', fix: 'MAYBN' }], clean: true },
    { say: `${S}, direct stev`, cmds: [{ kind: 'DIRECT_FIX', fix: 'STEVV' }], clean: true },
    { say: `${S}, direct pristy`, cmds: [{ kind: 'DIRECT_FIX', fix: 'PRSTY' }], clean: true },
    { say: `${S}, direct smits`, cmds: [{ kind: 'DIRECT_FIX', fix: 'SMITS' }], clean: true },
    { say: `${S}, direct Sea Isle`, cmds: [{ kind: 'DIRECT_FIX', fix: 'SIE' }], clean: true },
    { say: `${S}, direct Coyle`, cmds: [{ kind: 'DIRECT_FIX', fix: 'CYN' }], clean: true },
    { say: `${S}, proceed direct Atlantic City VOR`, cmds: [{ kind: 'DIRECT_FIX', fix: 'ACY' }], clean: true },
    { say: `${S}, direct sierra india echo`, cmds: [{ kind: 'DIRECT_FIX', fix: 'SIE' }], clean: true },
    { say: `${S}, when able proceed direct CARYL`, cmds: [{ kind: 'DIRECT_FIX', fix: 'CARYL' }], clean: true },
    { say: `${S}, DIRECT CEDAR LAKE`, cmds: [{ kind: 'DIRECT_FIX', fix: 'VCN' }], clean: true },
    { say: `${S}, direct zebra`, cmds: [{ kind: 'DIRECT_FIX', fix: 'ZEBRA' }], issue: 'unknown fix ZEBRA', conf: [0.5, 0.9] },
    { say: `${S}, direct`, cmds: [{ kind: 'DIRECT_FIX' }], issue: 'missing fix', conf: [0, 0.6] },
    { say: `${S}, direct CARYL, maintain 3000`, cmds: [{ kind: 'DIRECT_FIX', fix: 'CARYL' }, { kind: 'ALTITUDE', altitudeFt: 3000 }], clean: true },
    { say: `${S}, direct CARYL`, ctx: CTX, cmds: [{ kind: 'DIRECT_FIX', fix: 'CARYL' }], clean: true },
    { say: `${S}, proceed direct`, cmds: [{ kind: 'DIRECT_FIX' }], issue: 'missing fix' },
  ],

  'resume navigation and radar contact': [
    { say: `${S}, resume own navigation`, cmds: [{ kind: 'RESUME_OWN_NAVIGATION', ...NKS }], clean: true, conf: [0.95, 1] },
    { say: `${S}, resume own nav`, cmds: [{ kind: 'RESUME_OWN_NAVIGATION' }], clean: true },
    { say: `${S}, proceed on course`, cmds: [{ kind: 'RESUME_OWN_NAVIGATION' }], clean: true },
    { say: `${S}, resume your own navigation`, cmds: [{ kind: 'RESUME_OWN_NAVIGATION' }], clean: true },
    { say: `${S}, radar contact`, cmds: [{ kind: 'RADAR_CONTACT', ...NKS }], clean: true, conf: [0.95, 1] },
    { say: `${S}, radar contact two miles south of the field`, cmds: [{ kind: 'RADAR_CONTACT' }], clean: true },
    { say: `${S}, radar contact four miles from CARYL`, cmds: [{ kind: 'RADAR_CONTACT' }], clean: true },
    { say: `${S}, Atlantic City departure, radar contact`, cmds: [{ kind: 'RADAR_CONTACT' }], clean: true },
    { say: `${S}, radar contact, resume own navigation`, cmds: [{ kind: 'RADAR_CONTACT' }, { kind: 'RESUME_OWN_NAVIGATION' }], clean: true },
    { say: 'radar contact', cmds: [{ kind: 'RADAR_CONTACT', callsign: null }], issue: 'missing callsign', conf: [0, 0.4] },
  ],

  'IFR clearance': [
    { say: `${S}, ${CLNC}`,
      cmds: [{
        kind: 'IFR_CLEARANCE', ...NKS,
        ifr: {
          destination: 'KPHL', departureProcedure: 'ATLANTIC CITY THREE',
          routeText: 'Atlantic City Three departure, radar vectors, then as filed',
          initialAltitudeFt: 2000, expectAltitudeFt: 10000, departureFrequencyMhz: 124.6, squawk: '4215',
        },
      }], clean: true, conf: [0.95, 1] },
    { say: `${S}, cleared to Philadelphia as filed, maintain two thousand, departure frequency one two four point six, squawk four two one five`,
      cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KPHL', routeText: 'as filed', initialAltitudeFt: 2000, departureFrequencyMhz: 124.6, squawk: '4215' } }], clean: true },
    { say: `${S}, cleared to Philly airport as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KPHL', routeText: 'as filed' } }], clean: true },
    { say: `${S}, cleared to Newark via the Atlantic City Three departure, maintain 2000, squawk 1234`,
      cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KEWR', departureProcedure: 'ATLANTIC CITY THREE', initialAltitudeFt: 2000, squawk: '1234' } }], clean: true },
    { say: `${S}, cleared to Kennedy airport as filed, maintain 3000`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KJFK', initialAltitudeFt: 3000 } }], clean: true },
    { say: `${S}, cleared to JFK as filed, maintain 3000`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KJFK' } }], clean: true },
    { say: `${S}, cleared to LaGuardia as filed, maintain 3000`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KLGA' } }], clean: true },
    { say: `${S}, cleared to Boston as filed, maintain 3000`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KBOS' } }], clean: true },
    { say: `${S}, cleared to Logan as filed, maintain 3000`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KBOS' } }], clean: true },
    { say: `${S}, cleared to Washington National as filed, maintain 3000`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KDCA' } }], clean: true },
    { say: `${S}, cleared to Reagan airport as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KDCA' } }], clean: true },
    { say: `${S}, cleared to Dulles as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KIAD' } }], clean: true },
    { say: `${S}, cleared to Baltimore as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KBWI' } }], clean: true },
    { say: `${S}, cleared to BWI as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KBWI' } }], clean: true },
    { say: `${S}, cleared to Teterboro as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KTEB' } }], clean: true },
    { say: `${S}, cleared to Charlotte as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KCLT' } }], clean: true },
    { say: `${S}, cleared to Atlanta as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KATL' } }], clean: true },
    { say: `${S}, cleared to Orlando as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KMCO' } }], clean: true },
    { say: `${S}, cleared to Fort Lauderdale as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KFLL' } }], clean: true },
    { say: `${S}, cleared to Myrtle Beach as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KMYR' } }], clean: true },
    { say: `${S}, cleared to kilo papa hotel lima airport as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KPHL' } }], clean: true },
    { say: `${S}, cleared to KPHL as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KPHL' } }], clean: true },
    { say: `${S}, cleared to kilo echo whiskey romeo as filed`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KEWR' } }], clean: true },
    { say: `${S}, cleared to Philadelphia via radar vectors, maintain two thousand`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KPHL', routeText: 'radar vectors', initialAltitudeFt: 2000 } }], clean: true },
    { say: `${S}, cleared as filed, maintain two thousand`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { routeText: 'as filed', initialAltitudeFt: 2000 } }], issue: 'missing destination', conf: [0, 0.6] },
    { say: `${S}, cleared to Wilmington airport as filed`, cmds: [{ kind: 'IFR_CLEARANCE' }], issue: 'unknown destination WILMINGTON', conf: [0, 0.6] },
    { say: `${S}, cleared to Philadelphia as filed, maintain flight level two three zero`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { initialAltitudeFt: 23000 } }], clean: true },
    { say: `${S}, cleared to Philadelphia as filed, climb via the SID`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KPHL' } }], issue: 'climb via is not supported' },
    { say: `${S}, cleared to Philadelphia as filed, maintain 2000, expect flight level two three zero ten minutes after departure`,
      cmds: [{ kind: 'IFR_CLEARANCE', ifr: { initialAltitudeFt: 2000, expectAltitudeFt: 23000 } }], clean: true },
    { say: `${S}, cleared to Philadelphia as filed, maintain 2000, expect one zero thousand`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { expectAltitudeFt: 10000 } }], clean: true },
    { say: `${S}, cleared to Philadelphia as filed, maintain 2000, expect 10000 ten minutes after departure`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { expectAltitudeFt: 10000 } }], clean: true },
    { say: `${S}, cleared to Philadelphia as filed, maintain 2000, departure one two four point six`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { departureFrequencyMhz: 124.6 } }], clean: true },
    { say: `${S}, cleared to Philadelphia as filed, maintain 2000, squawk four two one five`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { squawk: '4215' } }], clean: true },
    { say: `${S}, cleared to Philadelphia as filed, maintain 2000, squawk four nine one five`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KPHL' } }], issue: 'digits must be 0-7', conf: [0, 0.9] },
    { say: `${S}, cleared to Philadelphia as filed, maintain 2000, squawk four two one eight`, cmds: [{ kind: 'IFR_CLEARANCE' }], issue: 'invalid squawk 4218' },
    { say: `${S}, cleared to Philadelphia as filed, maintain 2000, squawk four two one`, cmds: [{ kind: 'IFR_CLEARANCE' }], issue: 'must be four digits' },
    { say: `${S}, cleared to Philadelphia as filed, squawk zero zero seven seven`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { squawk: '0077' } }], clean: true },
    { say: `${S}, cleared to Philadelphia as filed, maintain 2000, departure frequency two five zero point one`, cmds: [{ kind: 'IFR_CLEARANCE' }], issue: 'outside the VHF comm band' },
    { say: `${S}, cleared to Philadelphia as filed, maintain 2000, contact departure one two four point six`,
      cmds: [{ kind: 'IFR_CLEARANCE', ifr: { initialAltitudeFt: 2000 } }, { kind: 'CONTACT_FREQUENCY', frequencyId: 'DEP' }] },
    { say: `${S}, cleared to Philadelphia via the Cedar Lake Two departure, maintain 2000`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { departureProcedure: 'CEDAR LAKE TWO' } }], clean: true },
    { say: `${S}, cleared to Philadelphia via the Coyle Five departure, maintain 2000`, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { departureProcedure: 'COYLE FIVE' } }], clean: true },
    { say: `${S}, cleared to Philadelphia as filed`, ctx: { aircraft: AIRCRAFT }, cmds: [{ kind: 'IFR_CLEARANCE', ifr: { destination: 'KPHL' } }], clean: true },
  ],

  'existing commands are unaffected': [
    { say: `${S}, cleared for takeoff runway 13`, cmds: [{ kind: 'TAKEOFF', runwayEnd: '13' }], clean: true },
    { say: `${S}, cleared to land runway 31`, cmds: [{ kind: 'LAND', runwayEnd: '31' }], clean: true },
    { say: `${S}, cleared for a low approach runway 4`, cmds: [{ kind: 'LAND', destination: 'low_approach' }], clean: true },
    { say: `${S}, squawk one two zero zero`, cmds: [{ kind: 'UNKNOWN' }], issue: 'unsupported instruction: squawk' },
    { say: `${S}, turn left heading two seven zero, climb and maintain five thousand`, cmds: [{ kind: 'HEADING', headingDeg: 270 }, { kind: 'ALTITUDE', altitudeFt: 5000 }], clean: true },
  ],
});

describe('result shape for new commands', () => {
  it('leaves fix undefined when the fix is missing and does not invent one', () => {
    const r = parseTransmission(`${S}, direct`, FIX_CTX);
    expect(r.commands[0].fix).toBeUndefined();
  });

  it('keeps the raw token for an unknown fix and lowers confidence', () => {
    const known = parseTransmission(`${S}, direct CARYL`, FIX_CTX).commands[0];
    const unknown = parseTransmission(`${S}, direct zebra`, FIX_CTX).commands[0];
    expect(unknown.fix).toBe('ZEBRA');
    expect(unknown.confidence).toBeLessThan(known.confidence);
  });

  it('accepts any single word after direct when no fix list is supplied', () => {
    const r = parseTransmission(`${S}, direct zebra`, CTX).commands[0];
    expect(r.fix).toBe('ZEBRA');
    expect(r.issues).toEqual([]);
  });

  it('does not leave an ifr object on non-IFR commands', () => {
    const r = parseTransmission(`${S}, cleared ILS runway 13 approach`, FIX_CTX).commands[0];
    expect(r.ifr).toBeUndefined();
  });

  it('normalises "ten thousand ten minutes" into altitude and minutes', () => {
    const r = parseTransmission(`${S}, cleared to Philadelphia as filed, maintain 2000, expect ten thousand ten minutes after departure`, FIX_CTX).commands[0];
    expect(r.ifr?.expectAltitudeFt).toBe(10000);
  });

  it('flags an ambiguous fix instead of guessing', () => {
    const ctx = { ...FIX_CTX, fixes: [{ id: 'ABCDE', spoken: 'abcde' }, { id: 'ABCDF', spoken: 'abcdf' }] };
    const r = parseTransmission(`${S}, direct abcdx`, ctx).commands[0];
    expect(r.fix).toBeUndefined();
    expect(r.issues.join(' ')).toContain('ambiguous fix');
  });
});

run({
  'hold at fix': [
    { say: `${S}, hold at SMITS as published`, cmds: [{ kind: 'HOLD_AT_FIX', ...NKS, hold: { fix: 'SMITS', asPublished: true, turns: 'right' } }], clean: true, conf: [0.95, 1] },
    { say: `${S}, hold as published at SMITS`, cmds: [{ kind: 'HOLD_AT_FIX', hold: { fix: 'SMITS', asPublished: true } }], clean: true },
    { say: `${S}, hold east of SMITS on the zero nine zero radial, right turns, one minute legs, expect further clearance one two four five`,
      cmds: [{ kind: 'HOLD_AT_FIX', hold: { fix: 'SMITS', asPublished: false, turns: 'right', inboundCourseDeg: 270, legMinutes: 1, efcZulu: '1245' } }], clean: true, conf: [0.9, 1] },
    { say: `${S}, hold northwest of CARYL on the localizer, left turns, five mile legs`,
      cmds: [{ kind: 'HOLD_AT_FIX', hold: { fix: 'CARYL', turns: 'left', legNm: 5, asPublished: false } }], clean: true },
    { say: `${S}, hold at RODDI as published, expect further clearance at one three zero zero`,
      cmds: [{ kind: 'HOLD_AT_FIX', hold: { fix: 'RODDI', asPublished: true, efcZulu: '1300' } }], issue: 'unknown fix RODDI' },
    { say: `${S}, cleared to SMITS, hold as published`, cmds: [{ kind: 'HOLD_AT_FIX', hold: { fix: 'SMITS', asPublished: true } }], clean: true },
    { say: `${S}, hold at carol as published`, cmds: [{ kind: 'HOLD_AT_FIX', hold: { fix: 'CARYL' } }], clean: true },
    { say: `${S}, hold at Cedar Lake as published`, cmds: [{ kind: 'HOLD_AT_FIX', hold: { fix: 'VCN', asPublished: true } }], clean: true },
    { say: `${S}, hold southwest of Sea Isle on the 225 radial, left turns, two minute legs`,
      cmds: [{ kind: 'HOLD_AT_FIX', hold: { fix: 'SIE', inboundCourseDeg: 45, turns: 'left', legMinutes: 2 } }], clean: true },
    { say: `${S}, hold west of SMITS on the 270 radial`, cmds: [{ kind: 'HOLD_AT_FIX', hold: { inboundCourseDeg: 90 } }], issue: 'standard right turns assumed' },
    { say: `${S}, hold south of SMITS on the one eight zero radial, right turns`, cmds: [{ kind: 'HOLD_AT_FIX', hold: { inboundCourseDeg: 360 } }], clean: true },
    { say: `${S}, hold north of SMITS on the 360 radial, right turns`, cmds: [{ kind: 'HOLD_AT_FIX', hold: { inboundCourseDeg: 180 } }], clean: true },
    { say: `${S}, hold at SMITS`, cmds: [{ kind: 'HOLD_AT_FIX', hold: { fix: 'SMITS', asPublished: false, turns: 'right' } }], issue: 'standard right turns assumed' },
    { say: `${S}, hold at SMITS as published`, cmds: [{ kind: 'HOLD_AT_FIX' }], conf: [0.9, 1] },
    { say: `${S}, hold east of SMITS on the 270 radial, right turns`, cmds: [{ kind: 'HOLD_AT_FIX', hold: { inboundCourseDeg: 90 } }], issue: 'inconsistent hold', conf: [0, 0.8] },
    { say: `${S}, hold as published`, cmds: [{ kind: 'HOLD_AT_FIX', hold: { asPublished: true } }], issue: 'missing holding fix', conf: [0, 0.6] },
    { say: `${S}, hold at zebra as published`, cmds: [{ kind: 'HOLD_AT_FIX', hold: { fix: 'ZEBRA' } }], issue: 'unknown fix ZEBRA', conf: [0.5, 0.9] },
    { say: `${S}, hold at SMITS as published, expect further clearance nine four five`, cmds: [{ kind: 'HOLD_AT_FIX', hold: { efcZulu: '0945' } }], clean: true },
    { say: `${S}, hold at SMITS as published, expect further clearance two five zero zero`, cmds: [{ kind: 'HOLD_AT_FIX', hold: { fix: 'SMITS' } }], issue: 'invalid expect-further-clearance time' },
    { say: `${S}, hold at SMITS, right turns, one minute legs`, ctx: CTX, cmds: [{ kind: 'HOLD_AT_FIX', hold: { fix: 'SMITS', turns: 'right', legMinutes: 1 } }], clean: true },
    { say: `${S}, hold at SMITS as published, then maintain 3000`, cmds: [{ kind: 'HOLD_AT_FIX' }, { kind: 'ALTITUDE', altitudeFt: 3000 }], clean: true },
    { say: `${S}, proceed direct SMITS`, cmds: [{ kind: 'DIRECT_FIX', fix: 'SMITS' }], clean: true },
    { say: `${S}, hold short of runway 13`, cmds: [{ kind: 'HOLD_SHORT', runwayEnd: '13' }], clean: true },
    { say: `${S}, hold position`, cmds: [{ kind: 'HOLD_POSITION' }], clean: true },
  ],

  'missed approach': [
    { say: `${S}, execute missed approach`, cmds: [{ kind: 'MISSED_APPROACH', ...NKS }], clean: true, conf: [0.95, 1] },
    { say: `${S}, execute the missed approach`, cmds: [{ kind: 'MISSED_APPROACH' }], clean: true },
    { say: `${S}, go around, fly the published missed approach`, cmds: [{ kind: 'MISSED_APPROACH' }], clean: true },
    { say: `${S}, execute the published missed approach, climb and maintain two thousand`, cmds: [{ kind: 'MISSED_APPROACH' }, { kind: 'ALTITUDE', altitudeFt: 2000 }], clean: true },
    { say: `${S}, go missed`, cmds: [{ kind: 'MISSED_APPROACH' }], clean: true },
    { say: `${S}, go missed approach`, cmds: [{ kind: 'MISSED_APPROACH' }], clean: true },
    { say: `${S}, fly the published missed approach`, cmds: [{ kind: 'MISSED_APPROACH' }], clean: true },
    { say: `${S}, go around, execute the missed approach`, cmds: [{ kind: 'MISSED_APPROACH' }], clean: true },
    { say: `${S}, go around`, cmds: [{ kind: 'GO_AROUND' }], clean: true },
    { say: `${S}, go around, fly runway heading, climb and maintain two thousand`, cmds: [{ kind: 'GO_AROUND' }, { kind: 'HEADING' }, { kind: 'ALTITUDE' }], clean: true },
    { say: `${S}, execute missed approach, contact departure one eighteen point one`, cmds: [{ kind: 'MISSED_APPROACH' }, { kind: 'CONTACT_FREQUENCY', frequencyId: 'DEP' }], clean: true },
  ],
});
