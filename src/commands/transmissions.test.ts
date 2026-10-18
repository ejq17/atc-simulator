import { describe, expect, it } from 'vitest';
import type { ParsedCommand } from '../sim/types';
import { parseTransmission } from './index';
import { AIRCRAFT, CTX, N993EJ, type Case } from './testkit';

const C = 'Cessna seven two three echo juliet';
const S = 'Spirit four fifty one';
const N: Partial<{ callsign: string }> = { callsign: 'N723EJ' };
const NKS = { callsign: 'NKS451' };

function run(groups: Record<string, Case[]>) {
  for (const [name, cases] of Object.entries(groups)) {
    describe(name, () => {
      it.each(cases.map((c) => [c.say, c] as const))('%s', (_say, c) => {
        const r = parseTransmission(c.say, c.ctx ?? CTX);
        expect(r.commands.map((x) => x.kind)).toEqual(c.cmds.map((x) => x.kind));
        c.cmds.forEach((want, i) => expect(r.commands[i]).toMatchObject(want));
        const issues = r.commands.flatMap((x) => x.issues);
        if (c.issue) expect(issues.join(' | ')).toContain(c.issue);
        if (c.clean) expect(issues).toEqual([]);
        if (c.conf) for (const x of r.commands) {
          expect(x.confidence).toBeGreaterThanOrEqual(c.conf[0]);
          expect(x.confidence).toBeLessThanOrEqual(c.conf[1]);
        }
        expect(r.rawText).toBe(c.say);
      });
    });
  }
}

run({
  'taxi': [
    { say: `${C}, taxi to runway two two via alpha, hold short of runway one three`,
      cmds: [{ kind: 'TAXI', ...N, destination: 'RWY22', runwayEnd: '22', runwayId: '4/22', route: ['A'], holdShort: ['RWY13'] }], clean: true, conf: [0.95, 1] },
    { say: `${S} taxi to runway one three via alpha bravo`,
      cmds: [{ kind: 'TAXI', ...NKS, destination: 'RWY13', route: ['A', 'B'] }], clean: true },
    { say: 'N723EJ runway two two, taxi via alpha, hold short of runway one three',
      cmds: [{ kind: 'TAXI', ...N, destination: 'RWY22', route: ['A'], holdShort: ['RWY13'] }], clean: true },
    { say: 'N723EJ taxi to the ramp via charlie',
      cmds: [{ kind: 'TAXI_TO_PARKING', ...N, destination: 'RAMP', route: ['C'] }], clean: true },
    { say: 'N723EJ taxi to parking via bravo',
      cmds: [{ kind: 'TAXI_TO_PARKING', destination: 'PARKING', route: ['B'] }], clean: true },
    { say: 'N723EJ taxi runway 4 via A C',
      cmds: [{ kind: 'TAXI', destination: 'RWY4', runwayEnd: '4', route: ['A', 'C'] }], clean: true },
    { say: 'N723EJ taxi to general aviation parking via alpha',
      cmds: [{ kind: 'TAXI_TO_PARKING', destination: 'GA', route: ['A'] }], clean: true },
    { say: 'N723EJ taxi to the FBO via charlie bravo',
      cmds: [{ kind: 'TAXI_TO_PARKING', destination: 'FBO', route: ['C', 'B'] }], clean: true },
    { say: `${S} taxi to gate two via bravo`,
      cmds: [{ kind: 'TAXI_TO_PARKING', destination: 'GATE2', route: ['B'] }], clean: true },
    { say: 'N723EJ taxi to runway zero four via alpha one',
      cmds: [{ kind: 'TAXI', destination: 'RWY4', runwayEnd: '4', route: ['A1'] }], clean: true },
    { say: 'N723EJ taxi to runway four via alpha, bravo, charlie',
      cmds: [{ kind: 'TAXI', destination: 'RWY4', route: ['A', 'B', 'C'] }], clean: true },
    { say: 'Delta eighty eight taxi via bravo, hold short of runway 13',
      cmds: [{ kind: 'TAXI', callsign: 'DAL88', route: ['B'], holdShort: ['RWY13'] }], clean: true },
    { say: 'N723EJ taxi to runway 22',
      cmds: [{ kind: 'TAXI', destination: 'RWY22' }], clean: true },
    { say: 'N723EJ taxi', cmds: [{ kind: 'TAXI', ...N }], issue: 'missing taxi destination or route', conf: [0, 0.6] },
    { say: 'N723EJ taxi to runway one three via zulu',
      cmds: [{ kind: 'TAXI', route: ['Z'] }], issue: 'unknown taxiway Z', conf: [0.5, 0.9] },
    { say: 'N723EJ taxi to runway nine via alpha',
      cmds: [{ kind: 'TAXI', runwayEnd: '9', destination: 'RWY9' }], issue: 'unknown runway 9' },
    { say: 'N723EJ taxi to runway 22 via alpha cross runway 13 at bravo',
      cmds: [{ kind: 'TAXI', destination: 'RWY22', route: ['A'] }, { kind: 'CROSS_RUNWAY', crossRunwayId: '13/31', route: ['B'] }], clean: true },
    { say: 'N723EJ taxi to the ramp via charlie and hold short of runway 22',
      cmds: [{ kind: 'TAXI_TO_PARKING', route: ['C'], holdShort: ['RWY22'] }], clean: true },
    { say: 'N723EJ taxi alpha bravo to runway 13',
      cmds: [{ kind: 'TAXI', route: ['A', 'B'], destination: 'RWY13' }], conf: [0.8, 1] },
  ],

  'hold position / hold short / cross': [
    { say: 'N723EJ hold position', cmds: [{ kind: 'HOLD_POSITION', ...N }], clean: true, conf: [0.95, 1] },
    { say: 'N723EJ hold your position', cmds: [{ kind: 'HOLD_POSITION' }], clean: true },
    { say: 'N723EJ stop', cmds: [{ kind: 'HOLD_POSITION' }], clean: true },
    { say: 'N723EJ stop, stop', cmds: [{ kind: 'HOLD_POSITION' }], clean: true },
    { say: `${S} hold`, cmds: [{ kind: 'HOLD_POSITION' }], issue: 'incomplete phraseology', conf: [0.7, 0.95] },
    { say: `${S} hold short of runway one three`, cmds: [{ kind: 'HOLD_SHORT', ...NKS, holdShort: ['RWY13'], runwayEnd: '13', runwayId: '13/31' }], clean: true },
    { say: `${S} hold short runway 22`, cmds: [{ kind: 'HOLD_SHORT', holdShort: ['RWY22'], runwayEnd: '22' }], clean: true },
    { say: `${S} hold short of alpha`, cmds: [{ kind: 'HOLD_SHORT', holdShort: ['A'] }], clean: true },
    { say: `${S} hold short of taxiway bravo`, cmds: [{ kind: 'HOLD_SHORT', holdShort: ['B'] }], clean: true },
    { say: `${S} runway 13 hold short`, cmds: [{ kind: 'HOLD_SHORT', holdShort: ['RWY13'], runwayEnd: '13' }], clean: true },
    { say: `${S} hold short of runway won three`, cmds: [{ kind: 'HOLD_SHORT', holdShort: ['RWY13'] }], clean: true },
    { say: `${S} hold short`, cmds: [{ kind: 'HOLD_SHORT' }], issue: 'missing hold short point', conf: [0, 0.6] },
    { say: `${S} cross runway one three`, cmds: [{ kind: 'CROSS_RUNWAY', crossRunwayId: '13/31', runwayEnd: '13' }], clean: true },
    { say: `${S} cross runway 13 at alpha`, cmds: [{ kind: 'CROSS_RUNWAY', crossRunwayId: '13/31', route: ['A'] }], clean: true },
    { say: `${S} runway 4, cross at bravo`, cmds: [{ kind: 'CROSS_RUNWAY', crossRunwayId: '4/22', route: ['B'] }], clean: true },
    { say: `${S} cross runway two two`, cmds: [{ kind: 'CROSS_RUNWAY', crossRunwayId: '4/22' }], clean: true },
    { say: `${S} cross`, cmds: [{ kind: 'CROSS_RUNWAY' }], issue: 'missing runway', conf: [0, 0.6] },
    { say: `${S} cross runway 13 and hold short of runway 22`,
      cmds: [{ kind: 'CROSS_RUNWAY', crossRunwayId: '13/31' }, { kind: 'HOLD_SHORT', holdShort: ['RWY22'] }], clean: true },
  ],

  'line up / takeoff / land': [
    { say: `${S}, runway one three, line up and wait`, cmds: [{ kind: 'LINE_UP_AND_WAIT', ...NKS, runwayEnd: '13', runwayId: '13/31' }], clean: true, conf: [0.95, 1] },
    { say: `${S} line up and wait runway 13`, cmds: [{ kind: 'LINE_UP_AND_WAIT', runwayEnd: '13' }], clean: true },
    { say: `${S} line up and weight runway one three`, cmds: [{ kind: 'LINE_UP_AND_WAIT', runwayEnd: '13' }], clean: true },
    { say: `${S} line up runway 13`, cmds: [{ kind: 'LINE_UP_AND_WAIT', runwayEnd: '13' }], issue: 'incomplete phraseology', conf: [0.7, 0.95] },
    { say: `${S} runway 13 position and hold`, cmds: [{ kind: 'LINE_UP_AND_WAIT', runwayEnd: '13' }], clean: true },
    { say: `${S} taxi into position and hold runway 22`, cmds: [{ kind: 'LINE_UP_AND_WAIT', runwayEnd: '22' }], clean: true },
    { say: `${S} lineup and wait runway 31`, cmds: [{ kind: 'LINE_UP_AND_WAIT', runwayEnd: '31' }], clean: true },
    { say: `${S} line up and wait`, cmds: [{ kind: 'LINE_UP_AND_WAIT' }], issue: 'missing runway', conf: [0, 0.6] },
    { say: `${S}, runway one three, cleared for takeoff`, cmds: [{ kind: 'TAKEOFF', ...NKS, runwayEnd: '13', runwayId: '13/31' }], clean: true, conf: [0.95, 1] },
    { say: `${S} cleared for takeoff runway 13`, cmds: [{ kind: 'TAKEOFF', runwayEnd: '13' }], clean: true },
    { say: `${C} wind two one zero at eight, runway two two, cleared for takeoff`, cmds: [{ kind: 'TAKEOFF', ...N, runwayEnd: '22' }], clean: true },
    { say: `${S} wind calm runway 31 cleared for takeoff`, cmds: [{ kind: 'TAKEOFF', runwayEnd: '31' }], clean: true },
    { say: `${S} fly runway heading, cleared for takeoff runway 13`,
      cmds: [{ kind: 'TAKEOFF', runwayEnd: '13' }], clean: true }, // "fly runway heading" is part of the takeoff clearance (assemble.ts)
    { say: `${S} fly heading one eight zero, runway one three, cleared for takeoff`,
      cmds: [{ kind: 'HEADING', headingDeg: 180 }, { kind: 'TAKEOFF', runwayEnd: '13' }], clean: true },
    { say: `${S} turn left heading 270, cleared for takeoff runway 13`,
      cmds: [{ kind: 'HEADING', turnDirection: 'left', headingDeg: 270 }, { kind: 'TAKEOFF', runwayEnd: '13' }], clean: true },
    { say: `${S} cleared for takeoff runway 13 turn right heading zero niner zero`,
      cmds: [{ kind: 'TAKEOFF', runwayEnd: '13' }, { kind: 'HEADING', turnDirection: 'right', headingDeg: 90 }], clean: true },
    { say: `${S} cleared for take off runway 31`, cmds: [{ kind: 'TAKEOFF', runwayEnd: '31' }], clean: true },
    { say: `${S} clear for takeoff runway 4`, cmds: [{ kind: 'TAKEOFF', runwayEnd: '4' }], clean: true },
    { say: `${S} cleared for immediate takeoff runway 22`, cmds: [{ kind: 'TAKEOFF', runwayEnd: '22' }], clean: true },
    { say: `${S} cleared for takeoff runway 13, contact departure`,
      cmds: [{ kind: 'TAKEOFF', runwayEnd: '13' }, { kind: 'CONTACT_FREQUENCY', frequencyId: 'DEP' }], clean: true },
    { say: `${S} cleared for takeoff`, cmds: [{ kind: 'TAKEOFF', ...NKS }], issue: 'missing runway', conf: [0, 0.6] },
    { say: `${S} cleared for takeoff runway 13 runway 22`, cmds: [{ kind: 'TAKEOFF', runwayEnd: '13' }], issue: 'conflicting runways', conf: [0, 0.7] },
    { say: `${S}, runway one three, cleared to land`, cmds: [{ kind: 'LAND', ...NKS, runwayEnd: '13' }], clean: true, conf: [0.95, 1] },
    { say: `${S} cleared to land runway 13`, cmds: [{ kind: 'LAND', runwayEnd: '13' }], clean: true },
    { say: `${S} wind calm, runway 13, cleared to land`, cmds: [{ kind: 'LAND', runwayEnd: '13' }], clean: true },
    { say: `${S} wind two seven zero at one two gusts two two runway 31 cleared to land`, cmds: [{ kind: 'LAND', runwayEnd: '31' }], clean: true },
    { say: `${C} cleared for the option runway 13`, cmds: [{ kind: 'LAND', runwayEnd: '13', destination: 'option' }], clean: true },
    { say: `${C} cleared touch and go runway 22`, cmds: [{ kind: 'LAND', runwayEnd: '22', destination: 'touch_and_go' }], clean: true },
    { say: `${C} cleared for a low approach runway 4`, cmds: [{ kind: 'LAND', runwayEnd: '4', destination: 'low_approach' }], clean: true },
    { say: `${S} cleared to land`, cmds: [{ kind: 'LAND' }], issue: 'missing runway', conf: [0, 0.6] },
  ],

  'go around / continue / pushback': [
    { say: `${S} go around`, cmds: [{ kind: 'GO_AROUND', ...NKS }], clean: true, conf: [0.95, 1] },
    { say: `${S} go around, fly runway heading, climb and maintain two thousand`,
      cmds: [{ kind: 'GO_AROUND' }, { kind: 'HEADING', destination: 'RUNWAY_HEADING' }, { kind: 'ALTITUDE', altitudeFt: 2000 }], clean: true },
    { say: `${S} go around go around go around`, cmds: [{ kind: 'GO_AROUND' }], clean: true },
    { say: `${S} continue`, cmds: [{ kind: 'CONTINUE_APPROACH', ...NKS }], clean: true },
    { say: `${S} continue approach`, cmds: [{ kind: 'CONTINUE_APPROACH' }], clean: true },
    { say: `${S}, continue, expect late landing clearance`, cmds: [{ kind: 'CONTINUE_APPROACH' }], clean: true },
    { say: `${S} pushback approved`, cmds: [{ kind: 'PUSHBACK' }], issue: 'no pushback phrase' }, // not FAA phraseology: marked non-standard
    { say: `${S} pushback approved, tail east`, cmds: [{ kind: 'PUSHBACK', pushTailDeg: 90 }], issue: 'no pushback phrase' },
    { say: `${S} push back approved, face south`, cmds: [{ kind: 'PUSHBACK', pushFaceDeg: 180 }], issue: 'no pushback phrase' },
  ],

  'contact / frequency': [
    { say: `${S} contact ground point niner`, cmds: [{ kind: 'CONTACT_FREQUENCY', frequencyId: 'GND' }], clean: true },
    { say: `${S} contact ground on one two one point niner`, cmds: [{ kind: 'CONTACT_FREQUENCY', frequencyId: 'GND', frequencyMhz: 121.9 }], clean: true },
    { say: `${S} contact tower one two zero point three`, cmds: [{ kind: 'CONTACT_FREQUENCY', frequencyId: 'TWR', frequencyMhz: 120.3 }], clean: true },
    { say: `${S} contact departure`, cmds: [{ kind: 'CONTACT_FREQUENCY', frequencyId: 'DEP' }], clean: true },
    { say: `${S} contact Atlantic City approach one two four point six`, cmds: [{ kind: 'CONTACT_FREQUENCY', frequencyId: 'APP', frequencyMhz: 124.6 }], clean: true },
    { say: `${S} monitor ground point nine`, cmds: [{ kind: 'CONTACT_FREQUENCY', frequencyId: 'GND' }], clean: true },
    { say: `${S} change to my frequency`, cmds: [{ kind: 'CONTACT_FREQUENCY', destination: 'MY_FREQUENCY' }], clean: true },
    { say: `${S} contact tower 120.3`, cmds: [{ kind: 'CONTACT_FREQUENCY', frequencyId: 'TWR', frequencyMhz: 120.3 }], clean: true },
    { say: `${S} contact one two zero point three`, cmds: [{ kind: 'CONTACT_FREQUENCY', frequencyId: 'TWR', frequencyMhz: 120.3 }], clean: true },
    { say: `${S} contact clearance delivery one two one point six five`, cmds: [{ kind: 'CONTACT_FREQUENCY', frequencyId: 'CLNC', frequencyMhz: 121.65 }], clean: true },
    { say: `${S} switch to tower one two zero point three`, cmds: [{ kind: 'CONTACT_FREQUENCY', frequencyId: 'TWR' }], clean: true },
    { say: `${S} contact ground one two zero point three`, cmds: [{ kind: 'CONTACT_FREQUENCY', frequencyId: 'GND', frequencyMhz: 120.3 }], issue: 'is TWR, not GND', conf: [0, 0.7] },
    { say: `${S} contact tower one two zero point seven`, cmds: [{ kind: 'CONTACT_FREQUENCY', frequencyMhz: 120.7 }], issue: 'not a known frequency', conf: [0.6, 0.95] },
    { say: `${S} contact tower one five zero point three`, cmds: [{ kind: 'CONTACT_FREQUENCY', frequencyId: 'TWR' }], issue: 'outside the VHF comm band' },
    { say: `${S} contact`, cmds: [{ kind: 'CONTACT_FREQUENCY' }], issue: 'missing frequency or facility', conf: [0, 0.6] },
  ],

  'heading': [
    { say: `${S} turn left heading two seven zero`, cmds: [{ kind: 'HEADING', turnDirection: 'left', headingDeg: 270 }], clean: true, conf: [0.95, 1] },
    { say: `${S} fly heading 180`, cmds: [{ kind: 'HEADING', headingDeg: 180 }], clean: true },
    { say: `${S} turn right heading zero niner zero`, cmds: [{ kind: 'HEADING', turnDirection: 'right', headingDeg: 90 }], clean: true },
    { say: `${S} fly runway heading`, cmds: [{ kind: 'HEADING', destination: 'RUNWAY_HEADING' }], clean: true },
    { say: `${S} heading three six zero`, cmds: [{ kind: 'HEADING', headingDeg: 360 }], clean: true },
    { say: `${S} turn right heading zero zero zero`, cmds: [{ kind: 'HEADING', headingDeg: 360 }], clean: true },
    { say: `${S} left turn heading 090`, cmds: [{ kind: 'HEADING', turnDirection: 'left', headingDeg: 90 }], clean: true },
    { say: `${S} make a left turn heading two seven zero`, cmds: [{ kind: 'HEADING', turnDirection: 'left', headingDeg: 270 }], clean: true },
    { say: `${S} turn left 270`, cmds: [{ kind: 'HEADING', turnDirection: 'left', headingDeg: 270 }], clean: true },
    { say: `${S} maintain present heading`, cmds: [{ kind: 'HEADING', destination: 'PRESENT_HEADING' }], clean: true },
    { say: `${S} turn left heading four hundred`, cmds: [{ kind: 'HEADING', turnDirection: 'left' }], issue: 'invalid heading', conf: [0, 0.6] },
    { say: `${S} turn left heading two seven`, cmds: [{ kind: 'HEADING' }], issue: 'ambiguous heading', conf: [0, 0.6] },
    { say: `${S} turn left`, cmds: [{ kind: 'HEADING', turnDirection: 'left' }], issue: 'missing heading', conf: [0, 0.6] },
  ],

  'altitude': [
    { say: `${S} climb and maintain three thousand`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 3000 }], clean: true, conf: [0.95, 1] },
    { say: `${S} descend and maintain two thousand five hundred`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 2500 }], clean: true },
    { say: `${C} maintain VFR at or below two thousand five hundred`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 2500 }], clean: true },
    { say: `${S} climb and maintain flight level one eight zero`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 18000 }], clean: true },
    { say: `${S} climb and maintain FL240`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 24000 }], clean: true },
    { say: `${S} climb and maintain one zero thousand`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 10000 }], clean: true },
    { say: `${S} descend and maintain niner thousand`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 9000 }], clean: true },
    { say: `${S} heading 090 altitude 3000`, cmds: [{ kind: 'HEADING', headingDeg: 90 }, { kind: 'ALTITUDE', altitudeFt: 3000 }], clean: true },
    { say: `${S} maintain 3000`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 3000 }], clean: true },
    { say: `${S} climb maintain 4,500`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 4500 }], clean: true },
    { say: `${S} descend and maintain eleven thousand`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 11000 }], clean: true },
    { say: `${S} climb and maintain one thousand five hundred`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 1500 }], clean: true },
    { say: `${S} climb and maintain five`, cmds: [{ kind: 'ALTITUDE' }], issue: 'invalid altitude', conf: [0, 0.6] },
    { say: `${S} climb and maintain`, cmds: [{ kind: 'ALTITUDE' }], issue: 'missing altitude', conf: [0, 0.6] },
    { say: `${S} maintain one eight zero`, cmds: [{ kind: 'UNKNOWN' }], issue: 'altitude or speed', conf: [0, 0.2] },
  ],

  'speed': [
    { say: `${S} reduce speed to one eight zero`, cmds: [{ kind: 'SPEED', speedKt: 180 }], clean: true, conf: [0.95, 1] },
    { say: `${S} maintain two one zero knots`, cmds: [{ kind: 'SPEED', speedKt: 210 }], clean: true },
    { say: `${S} slow to one six zero`, cmds: [{ kind: 'SPEED', speedKt: 160 }], clean: true },
    { say: `${S} speed one seven zero`, cmds: [{ kind: 'SPEED', speedKt: 170 }], clean: true },
    { say: `${S} resume normal speed`, cmds: [{ kind: 'SPEED', destination: 'NORMAL_SPEED' }], clean: true },
    { say: `${S} increase speed to two two zero`, cmds: [{ kind: 'SPEED', speedKt: 220 }], clean: true },
    { say: `${S} slow down to one four zero knots`, cmds: [{ kind: 'SPEED', speedKt: 140 }], clean: true },
    { say: `${S} reduce speed to eighteen`, cmds: [{ kind: 'SPEED' }], issue: 'implausible speed', conf: [0, 0.6] },
    { say: `${S} reduce speed`, cmds: [{ kind: 'SPEED' }], issue: 'missing speed', conf: [0, 0.6] },
  ],

  'pattern': [
    { say: `${C} enter left downwind runway one three`, cmds: [{ kind: 'ENTER_PATTERN', ...N, patternLeg: 'left_downwind', runwayEnd: '13', turnDirection: 'left' }], clean: true },
    { say: `${C} enter right base runway 22`, cmds: [{ kind: 'ENTER_PATTERN', patternLeg: 'base', turnDirection: 'right', runwayEnd: '22' }], clean: true },
    { say: `${C} make straight in runway 13`, cmds: [{ kind: 'ENTER_PATTERN', patternLeg: 'straight_in', runwayEnd: '13' }], clean: true },
    { say: `${C} report two mile final`, cmds: [{ kind: 'REPORT_POSITION', destination: 'REPORT_FINAL', distanceNm: 2 }], clean: true },
    { say: `${C} enter downwind runway 13`, cmds: [{ kind: 'ENTER_PATTERN', runwayEnd: '13' }], issue: 'pattern side not specified', conf: [0, 0.6] },
    { say: `${C} make left traffic runway 22`, cmds: [{ kind: 'ENTER_PATTERN', patternLeg: 'left_downwind', runwayEnd: '22' }], clean: true },
    { say: `${C} runway 13, enter right downwind`, cmds: [{ kind: 'ENTER_PATTERN', patternLeg: 'right_downwind', runwayEnd: '13' }], clean: true },
    { say: `${C} join left downwind runway 4`, cmds: [{ kind: 'ENTER_PATTERN', patternLeg: 'left_downwind', runwayEnd: '4' }], clean: true },
    { say: `${C} report downwind`, cmds: [{ kind: 'REPORT_POSITION', destination: 'REPORT_MIDFIELD_DOWNWIND' }], clean: true },
    { say: `${C} report left base`, cmds: [{ kind: 'REPORT_POSITION', destination: 'REPORT_BASE' }], clean: true },
  ],

  'multiple commands': [
    { say: `${S}, turn left heading two seven zero, climb and maintain five thousand`,
      cmds: [{ kind: 'HEADING', ...NKS, headingDeg: 270, turnDirection: 'left' }, { kind: 'ALTITUDE', ...NKS, altitudeFt: 5000 }], clean: true },
    { say: `${S} climb and maintain 3000, turn right heading 090, reduce speed to 160`,
      cmds: [{ kind: 'ALTITUDE', altitudeFt: 3000 }, { kind: 'HEADING', headingDeg: 90 }, { kind: 'SPEED', speedKt: 160 }], clean: true },
    { say: `${S} hold short of runway 13, contact tower 120.3`,
      cmds: [{ kind: 'HOLD_SHORT', holdShort: ['RWY13'] }, { kind: 'CONTACT_FREQUENCY', frequencyMhz: 120.3 }], clean: true },
    { say: `${S} cross runway 13, taxi to the ramp via charlie`,
      cmds: [{ kind: 'CROSS_RUNWAY', crossRunwayId: '13/31' }, { kind: 'TAXI_TO_PARKING', destination: 'RAMP', route: ['C'] }], clean: true },
    { say: `${S} runway 22, line up and wait, traffic permitting, then turn left heading 180`,
      cmds: [{ kind: 'LINE_UP_AND_WAIT', runwayEnd: '22' }, { kind: 'HEADING', headingDeg: 180 }] },
    { say: `${S} hold position, contact ground point niner`,
      cmds: [{ kind: 'HOLD_POSITION' }, { kind: 'CONTACT_FREQUENCY', frequencyId: 'GND' }], clean: true },
  ],

  'callsign handling in transmissions': [
    { say: 'cleared for takeoff runway 13', cmds: [{ kind: 'TAKEOFF', callsign: null, runwayEnd: '13' }], issue: 'missing callsign', conf: [0, 0.4] },
    { say: 'taxi to the ramp via charlie', cmds: [{ kind: 'TAXI_TO_PARKING', callsign: null }], issue: 'missing callsign', conf: [0, 0.4] },
    { say: 'three echo juliet taxi via alpha', ctx: { ...CTX, aircraft: [...AIRCRAFT, N993EJ] },
      cmds: [{ kind: 'TAXI', callsign: null, callsignCandidates: ['N723EJ', 'N993EJ'] }], issue: 'ambiguous callsign', conf: [0, 0.4] },
    { say: 'seven two three echo juliet cleared to land runway 22', ctx: { ...CTX, aircraft: [...AIRCRAFT, N993EJ] },
      cmds: [{ kind: 'LAND', callsign: 'N723EJ', runwayEnd: '22' }], clean: true },
    { say: 'spirit four fifty two taxi via alpha', cmds: [{ kind: 'TAXI', callsign: null, callsignCandidates: ['NKS451'] }], issue: 'low-confidence callsign', conf: [0, 0.4] },
    { say: 'frontier one hundred hold position', cmds: [{ kind: 'HOLD_POSITION', callsign: null }], issue: 'callsign not recognised', conf: [0, 0.4] },
    { say: 'contact tower 120.3 spirit four fifty one', cmds: [{ kind: 'CONTACT_FREQUENCY', ...NKS }], conf: [0.9, 1] },
    { say: 'three echo juliet hold position', ctx: { ...CTX, aircraft: [AIRCRAFT[0]] }, cmds: [{ kind: 'HOLD_POSITION', callsign: 'N723EJ' }], conf: [0.85, 1] },
    { say: 'Cessna tree echo juliet hold short of runway won three', ctx: { ...CTX, aircraft: [AIRCRAFT[0]] },
      cmds: [{ kind: 'HOLD_SHORT', callsign: 'N723EJ', holdShort: ['RWY13'] }], conf: [0.85, 1] },
    { say: 'american twelve thirty four hold position', cmds: [{ kind: 'HOLD_POSITION', callsign: 'AAL1234' }], clean: true },
    { say: 'jet blue six fifteen go around', cmds: [{ kind: 'GO_AROUND', callsign: 'JBU615' }], clean: true },
    { say: 'Cactus twelve hold position', ctx: { ...CTX, aircraft: [{ callsign: 'AWE12', spokenCallsign: 'Cactus twelve', type: 'A320' }] },
      cmds: [{ kind: 'HOLD_POSITION', callsign: 'AWE12' }], clean: true },
  ],

  'STT errors and incorrect phraseology': [
    { say: `${S} for fifty one cleared for take off runway won three`.replace(`${S} for`, 'spirit for'), cmds: [{ kind: 'TAKEOFF', ...NKS, runwayEnd: '13' }], clean: true },
    { say: 'Spirit four fife one line up and weight runway one three', cmds: [{ kind: 'LINE_UP_AND_WAIT', ...NKS, runwayEnd: '13' }], clean: true },
    { say: `${S} takeoff runway 13`, cmds: [{ kind: 'UNKNOWN', callsign: 'NKS451' }], issue: 'no recognised instruction', conf: [0, 0.2] },
    { say: `${S} go ahead and land runway 13`, cmds: [{ kind: 'UNKNOWN' }], conf: [0, 0.2] },
    { say: `${S} cleared NDB runway 13 approach`, cmds: [{ kind: 'UNKNOWN' }], issue: 'unsupported instruction', conf: [0, 0.2] },
    { say: `${S} squawk ident`, cmds: [{ kind: 'UNKNOWN' }], issue: 'unsupported instruction: squawk', conf: [0, 0.2] },
    { say: `${S} um taxi uh to runway 13 via alpha`, cmds: [{ kind: 'TAXI', route: ['A'], destination: 'RWY13' }], clean: true },
    { say: `${S} taxi quickly to runway 13 via alpha`, cmds: [{ kind: 'TAXI', route: ['A'], destination: 'RWY13' }], issue: 'unrecognised words', conf: [0.5, 0.95] },
    { say: `${S} via alpha, taxi to runway 13`, cmds: [{ kind: 'TAXI', route: ['A'], destination: 'RWY13' }], clean: true },
    { say: 'spirit 451 taxi to runway 13 via alpha uh lots of extra noise words here', cmds: [{ kind: 'TAXI' }], issue: 'unrecognised words', conf: [0, 0.7] },
    { say: `${S} taxi to the ramp via CHARLIE.`, cmds: [{ kind: 'TAXI_TO_PARKING', route: ['C'] }], clean: true },
    { say: 'SPIRIT 451 RUNWAY 13 CLEARED FOR TAKEOFF', cmds: [{ kind: 'TAKEOFF', runwayEnd: '13' }], clean: true },
  ],

  'say again / unknown / empty': [
    { say: 'say again', cmds: [{ kind: 'SAY_AGAIN', callsign: null }], issue: 'missing callsign' },
    { say: `${S} say again`, cmds: [{ kind: 'SAY_AGAIN', ...NKS }], clean: true },
    { say: 'N723EJ say that again please', cmds: [{ kind: 'SAY_AGAIN' }], clean: true },
    { say: '', cmds: [{ kind: 'UNKNOWN', callsign: null }], issue: 'empty transmission', conf: [0, 0.1] },
    { say: 'blah blah blah', cmds: [{ kind: 'UNKNOWN' }], issue: 'no recognised instruction', conf: [0, 0.1] },
    { say: 'N723EJ', cmds: [{ kind: 'UNKNOWN', callsign: 'N723EJ' }], issue: 'no recognised instruction' },
    { say: 'thanks good day', cmds: [{ kind: 'UNKNOWN' }], issue: 'no recognised instruction' },
  ],
});

/** Real voice-session transmissions (Whisper / Web Speech text) at KACY: taxiways incl. L M N P, runway ends 13/31 and 4/22. */
const VOICE_CTX = {
  ...CTX,
  aircraft: [
    { callsign: 'N451NL', spokenCallsign: 'November four five one november lima', type: 'C172' },
    { callsign: 'NKS1290', spokenCallsign: 'Spirit twelve ninety', type: 'A320' },
    { callsign: 'AAL1727', spokenCallsign: 'American seventeen twenty seven', type: 'B738' },
    { callsign: 'N935HP', spokenCallsign: 'November nine three five hotel papa', type: 'C172' },
    { callsign: 'N409MM', spokenCallsign: 'November four zero nine mike mike', type: 'C172' },
    { callsign: 'AAL615', spokenCallsign: 'American six fifteen', type: 'B738' },
    { callsign: 'NKS999', spokenCallsign: 'Spirit nine ninety nine', type: 'A320' },
  ],
  taxiways: ['A', 'B', 'C', 'D', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P'],
};
const RWY31_VIA_LB: Partial<ParsedCommand> = { kind: 'TAXI', destination: 'RWY31', runwayEnd: '31', runwayId: '13/31', holdShort: ['RWY31'] };

run({
  'voice session: hold short without the word runway, STT slips': [
    { say: 'Good evening, November 4, 5, 1, November Lima. Taxi to runway 31 via Lima, Mike, Papa, Bravo, hold short of 31 on Bravo.', ctx: VOICE_CTX,
      cmds: [{ ...RWY31_VIA_LB, callsign: 'N451NL', route: ['L', 'M', 'P', 'B'] }], clean: true, conf: [0.9, 1] },
    { say: 'Good evening, November 4, 5, 1, November Lima. Taxi to runway 31 via Lima, Mike, Papa, Bravo, hold short of runway 31 on Bravo.', ctx: VOICE_CTX,
      cmds: [{ ...RWY31_VIA_LB, callsign: 'N451NL', route: ['L', 'M', 'P', 'B'] }], clean: true, conf: [0.9, 1] },
    { say: 'Spirit 1290, good evening. Taxi to runway 31 via Lima, Aravo. Hold shore 31 on Bravo.', ctx: VOICE_CTX,
      cmds: [{ ...RWY31_VIA_LB, callsign: 'NKS1290', route: ['L', 'B'] }], clean: true, conf: [0.9, 1] },
    { say: 'American 1727 taxi to runway 31 via Lima Mike Papa Baravo hold short of runway 31 on Bravo', ctx: VOICE_CTX,
      cmds: [{ ...RWY31_VIA_LB, callsign: 'AAL1727', route: ['L', 'M', 'P', 'B'] }], clean: true, conf: [0.9, 1] },
    { say: 'November 935 hotel papa taxa to the ramp via a Lima', ctx: VOICE_CTX,
      cmds: [{ kind: 'TAXI_TO_PARKING', callsign: 'N935HP', destination: 'RAMP', route: ['L'] }], clean: true, conf: [0.9, 1] },
    { say: 'November 4, 09, Mike Mike. Tax it around way 31, Vialima, Baravo, whole chore of 31 on Baravo.', ctx: VOICE_CTX,
      cmds: [{ ...RWY31_VIA_LB, callsign: 'N409MM', route: ['L', 'B'] }], clean: true, conf: [0.9, 1] },
    { say: 'November 409 Mike Mike, taxi to runway 31 via Lima Baravo, hold short of 31 on Baravo.', ctx: VOICE_CTX,
      cmds: [{ ...RWY31_VIA_LB, callsign: 'N409MM', route: ['L', 'B'] }], clean: true, conf: [0.9, 1] },
    { say: 'American 615, Chaxi to the Terminal via Alpha, Baravo, Papa, Mike, Lima.', ctx: VOICE_CTX,
      cmds: [{ kind: 'TAXI_TO_PARKING', callsign: 'AAL615', destination: 'TERMINAL', route: ['A', 'B', 'P', 'M', 'L'] }], clean: true, conf: [0.9, 1] },
    { say: 'Spirit 999. Hello taxi to the terminal via Alpha Bravo Papa Mike', ctx: VOICE_CTX,
      cmds: [{ kind: 'TAXI_TO_PARKING', callsign: 'NKS999', destination: 'TERMINAL', route: ['A', 'B', 'P', 'M'] }], clean: true, conf: [0.9, 1] },
  ],

  'hold short: bare runway number, qualifier, safety': [
    { say: `${S} hold short of 13`, cmds: [{ kind: 'HOLD_SHORT', ...NKS, holdShort: ['RWY13'], runwayEnd: '13' }], clean: true },
    { say: `${S} hold short of 4`, cmds: [{ kind: 'HOLD_SHORT', holdShort: ['RWY4'], runwayEnd: '4' }], clean: true },
    { say: `${S} hold short of 22 at bravo`, cmds: [{ kind: 'HOLD_SHORT', holdShort: ['RWY22'] }], clean: true },
    { say: `${S} hold short of 27`, cmds: [{ kind: 'HOLD_SHORT' }], issue: 'missing hold short point', conf: [0, 0.6] },
    { say: `${S} taxi via alpha, hold short of 13 on bravo`, cmds: [{ kind: 'TAXI', route: ['A'], holdShort: ['RWY13'] }], clean: true },
    // a taxi whose hold-short point cannot be read is never a plain taxi: one command, flagged, below the execute threshold
    { say: `${S} taxi to runway 13 via alpha, hold short`, cmds: [{ kind: 'TAXI', destination: 'RWY13', route: ['A'] }],
      issue: 'missing hold short point', conf: [0, 0.6] },
    { say: `${S} taxi to the ramp via charlie, hold short of the`, cmds: [{ kind: 'TAXI_TO_PARKING', destination: 'RAMP' }],
      issue: 'missing hold short point', conf: [0, 0.6] },
  ],

  'fuzzy keyword correction': [
    { say: `${S} taxa to runway 13 via alpha`, cmds: [{ kind: 'TAXI', route: ['A'], destination: 'RWY13' }], clean: true },
    { say: `${S} taxi to runway 13 via alpha, hold shord of runway 22`, cmds: [{ kind: 'TAXI', holdShort: ['RWY22'] }], clean: true },
    { say: `${S} taxi to runway 13 viaalpha bravo`, cmds: [{ kind: 'TAXI', route: ['A', 'B'] }], clean: true },
    { say: `${S} taxi to runway 13 via alpha branvo`, cmds: [{ kind: 'TAXI', route: ['A', 'B'] }], clean: true },
    // words with a meaning of their own are not rewritten ("make" is not mike, "like" is not line)
    { say: `${S} make left traffic runway 13`, cmds: [{ kind: 'ENTER_PATTERN', runwayEnd: '13' }] },
    // typed single-letter taxiways after "via a" are untouched
    { say: 'N723EJ taxi to runway 13 via a b', cmds: [{ kind: 'TAXI', route: ['A', 'B'] }], clean: true },
  ],
});

describe('result shape', () => {
  it('returns the transmission-level callsign and texts', () => {
    const r = parseTransmission('Spirit four fifty one, runway one three, cleared for takeoff', CTX);
    expect(r.callsign).toBe('NKS451');
    expect(r.normalizedText).toBe('NKS 451 runway 13 cleared for takeoff');
    expect(r.commands[0].rawText).toBe(r.rawText);
    expect(r.commands[0].normalizedText).toBe(r.normalizedText);
  });

  it('does not fabricate a runway', () => {
    const r = parseTransmission('Spirit 451 cleared for takeoff', CTX);
    expect(r.commands[0].runwayEnd).toBeUndefined();
    expect(r.commands[0].runwayId).toBeUndefined();
  });

  it('keeps unresolved callsign off every command in a multi-command transmission', () => {
    const r = parseTransmission('turn left heading 270 climb and maintain 5000', CTX);
    expect(r.callsign).toBeNull();
    expect(r.commands.map((c) => c.callsign)).toEqual([null, null]);
    for (const c of r.commands) expect(c.issues).toContain('missing callsign');
  });

  it('works without validation context', () => {
    const r = parseTransmission('N723EJ taxi to runway 9 via zulu', { aircraft: AIRCRAFT });
    expect(r.commands[0].issues).toEqual([]);
  });
});
