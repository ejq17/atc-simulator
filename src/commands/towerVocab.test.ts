/** Tower vocabulary: runway exit, cancel takeoff, traffic information and sequencing, pattern instructions, reports, squawk, airport information (JO 7110.65 3-10-9, 3-9-11, 3-1-6, 3-8-1, 3-10-11, 7-6-11, 5-2-1, 3-9-1, 3-10-1, 3-9-4). */
import { describe, expect, it } from 'vitest';
import { parseTransmission } from './index';
import { CTX, type Case } from './testkit';

const C = 'Cessna seven two three echo juliet';
const S = 'Spirit four fifty one';

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
      });
    });
  }
}

run({
  'runway exit (3-10-9)': [
    { say: `${C} turn left at Charlie`, cmds: [{ kind: 'EXIT_RUNWAY', callsign: 'N723EJ', turnDirection: 'left', exitTaxiway: 'C' }], clean: true, conf: [0.95, 1] },
    { say: `${C} turn right Bravo`, cmds: [{ kind: 'EXIT_RUNWAY', turnDirection: 'right', exitTaxiway: 'B' }], clean: true },
    { say: `${C} turn left at taxiway Charlie`, cmds: [{ kind: 'EXIT_RUNWAY', turnDirection: 'left', exitTaxiway: 'C' }], clean: true },
    { say: `${C} exit at Charlie`, cmds: [{ kind: 'EXIT_RUNWAY', exitTaxiway: 'C' }], clean: true },
    { say: `${C} exit right Bravo`, cmds: [{ kind: 'EXIT_RUNWAY', turnDirection: 'right', exitTaxiway: 'B' }], clean: true },
    { say: `${C} exit the runway at Alpha`, cmds: [{ kind: 'EXIT_RUNWAY', exitTaxiway: 'A' }], clean: true },
    { say: `${C} if able, turn left at Charlie`, cmds: [{ kind: 'EXIT_RUNWAY', turnDirection: 'left', exitTaxiway: 'C', ifAble: true }], clean: true },
    { say: `${C} turn right next taxiway`, cmds: [{ kind: 'EXIT_RUNWAY', turnDirection: 'right', destination: 'NEXT' }], clean: true },
    { say: `${C} take the next taxiway`, cmds: [{ kind: 'EXIT_RUNWAY', destination: 'NEXT' }], clean: true },
    { say: `${C} continue to the end`, cmds: [{ kind: 'EXIT_RUNWAY', destination: 'END' }], conf: [0.85, 0.95] }, // not in 7110.65: flagged non-standard
    { say: `${C} turn left Charlie, contact Ground point niner`, cmds: [{ kind: 'EXIT_RUNWAY', turnDirection: 'left', exitTaxiway: 'C' }, { kind: 'CONTACT_FREQUENCY', frequencyId: 'GND' }], clean: true },
    { say: `${C} turn left at Charlie, hold short of runway four`, cmds: [{ kind: 'EXIT_RUNWAY', exitTaxiway: 'C' }, { kind: 'HOLD_SHORT', holdShort: ['RWY4'] }], clean: true },
    { say: `${C} hold short of runway 4`, cmds: [{ kind: 'HOLD_SHORT', holdShort: ['RWY4'], runwayId: '4/22' }], clean: true },
    // STT variants
    { say: `${C} turn left at charley`, cmds: [{ kind: 'EXIT_RUNWAY', turnDirection: 'left', exitTaxiway: 'C' }], clean: true },
    { say: `${C} left on Charlie, hold shore of runway four`, cmds: [{ kind: 'EXIT_RUNWAY', turnDirection: 'left', exitTaxiway: 'C' }, { kind: 'HOLD_SHORT' }], clean: true },
    { say: `${S} turn left at Charlie contact ground one two one point nine`, cmds: [{ kind: 'EXIT_RUNWAY' }, { kind: 'CONTACT_FREQUENCY', frequencyMhz: 121.9 }], clean: true },
    // still headings
    { say: `${C} turn left heading two seven zero`, cmds: [{ kind: 'HEADING', turnDirection: 'left', headingDeg: 270 }], clean: true },
    { say: `${C} turn left`, cmds: [{ kind: 'HEADING', turnDirection: 'left' }], issue: 'missing heading' },
  ],

  'cancel takeoff clearance (3-9-11)': [
    { say: `${C} cancel takeoff clearance`, cmds: [{ kind: 'CANCEL_TAKEOFF', callsign: 'N723EJ' }], clean: true, conf: [0.95, 1] },
    { say: `${C} cancel takeoff clearance, traffic on the runway`, cmds: [{ kind: 'CANCEL_TAKEOFF', reason: 'traffic on the runway' }], clean: true },
    { say: `${C} cancel takeoff clearance, vehicle crossing`, cmds: [{ kind: 'CANCEL_TAKEOFF', reason: 'vehicle crossing' }], clean: true },
    { say: `${C} abort takeoff`, cmds: [{ kind: 'CANCEL_TAKEOFF' }], clean: true },
    { say: `${C} abort the takeoff`, cmds: [{ kind: 'CANCEL_TAKEOFF' }], clean: true },
    { say: `${C} abort, abort`, cmds: [{ kind: 'CANCEL_TAKEOFF' }], clean: true },
    { say: `${C} cancel take off clearance`, cmds: [{ kind: 'CANCEL_TAKEOFF' }], clean: true },
    { say: `${C} stop`, cmds: [{ kind: 'HOLD_POSITION' }], clean: true }, // "stop" is a hold position; the engine reads it as a cancellation while the takeoff roll is in progress
    { say: `${C} cancel taxi clearance`, cmds: [{ kind: 'HOLD_POSITION' }], issue: 'non-standard' },
  ],

  'traffic information (3-1-6, 2-1-21, 3-9-4)': [
    { say: `${C} traffic, Cessna two-mile final`, cmds: [{ kind: 'TRAFFIC_ADVISORY', traffic: { desc: 'cessna', position: 'final', distanceNm: 2 } }], clean: true },
    { say: `${C} traffic, Cessna two mile final`, cmds: [{ kind: 'TRAFFIC_ADVISORY', traffic: { desc: 'cessna', position: 'final', distanceNm: 2 } }], clean: true },
    { say: `${C} traffic, a Skyhawk on left base`, cmds: [{ kind: 'TRAFFIC_ADVISORY', traffic: { desc: 'skyhawk', position: 'base', side: 'left' } }], clean: true },
    { say: `${C} traffic, Cessna on left downwind`, cmds: [{ kind: 'TRAFFIC_ADVISORY', traffic: { desc: 'cessna', position: 'downwind', side: 'left' } }], clean: true },
    { say: `${C} traffic, twelve o'clock, Cessna on a two mile final`, cmds: [{ kind: 'TRAFFIC_ADVISORY', traffic: { desc: 'cessna', position: 'final', distanceNm: 2 } }], clean: true },
    { say: `${C} traffic, Boeing seven thirty seven six mile final`, cmds: [{ kind: 'TRAFFIC_ADVISORY', traffic: { desc: 'boeing 737', position: 'final', distanceNm: 6 } }], clean: true },
    { say: `${C} traffic, Boeing 737 departing`, cmds: [{ kind: 'TRAFFIC_ADVISORY', traffic: { desc: 'boeing 737', position: 'departing' } }], clean: true },
    { say: `${C} traffic`, cmds: [{ kind: 'UNKNOWN' }], issue: 'no recognised instruction' },
    // LUAW with traffic information (3-9-4: "United Five, Runway One Eight, line up and wait. Traffic a Boeing Seven Thirty Seven, six mile final.")
    { say: `${S} runway three one, line up and wait. Traffic, a Boeing seven thirty seven, six mile final`, cmds: [{ kind: 'LINE_UP_AND_WAIT', runwayEnd: '31', trafficAdvised: true, traffic: { desc: 'boeing 737', distanceNm: 6 } }], clean: true },
    { say: `${S} runway three one, line up and wait`, cmds: [{ kind: 'LINE_UP_AND_WAIT', runwayEnd: '31' }], clean: true },
  ],

  'sequencing (3-8-1)': [
    { say: `${C} follow the Skyhawk ahead`, cmds: [{ kind: 'FOLLOW_TRAFFIC', traffic: { desc: 'skyhawk', position: 'ahead' } }], clean: true },
    { say: `${C} follow the Cessna on base`, cmds: [{ kind: 'FOLLOW_TRAFFIC', traffic: { desc: 'cessna', position: 'base' } }], clean: true },
    { say: `${C} number two, follow the Skyhawk ahead`, cmds: [{ kind: 'FOLLOW_TRAFFIC', sequenceNumber: 2, traffic: { desc: 'skyhawk', position: 'ahead' } }], clean: true },
    { say: `${C} number 2 follow the Skyhawk`, cmds: [{ kind: 'FOLLOW_TRAFFIC', sequenceNumber: 2, traffic: { desc: 'skyhawk' } }], clean: true },
    { say: `${S} number three, follow the Boeing seven thirty seven four mile final`, cmds: [{ kind: 'FOLLOW_TRAFFIC', sequenceNumber: 3, traffic: { desc: 'boeing 737', position: 'final', distanceNm: 4 } }], clean: true },
    { say: `${C} extend downwind, I'll call your base`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'EXTEND_DOWNWIND' }], clean: true },
    { say: `${C} extend downwind`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'EXTEND_DOWNWIND' }], clean: true },
    { say: `${C} extended downwind, tower will call your base`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'EXTEND_DOWNWIND' }], clean: true },
    { say: `${C} turn base now`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'TURN_BASE_NOW' }], clean: true },
    { say: `${C} turn base`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'TURN_BASE_NOW' }], clean: true },
    { say: `${C} base now`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'TURN_BASE_NOW' }], clean: true },
    { say: `${C} make short approach`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'SHORT_APPROACH' }], clean: true },
    { say: `${C} make short approach, runway one three, cleared to land`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'SHORT_APPROACH' }, { kind: 'LAND', runwayEnd: '13' }], clean: true },
    { say: `${C} make left three sixty`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'CIRCLE', turnDirection: 'left', turnDegrees: 360 }], clean: true },
    { say: `${C} make right three-sixty`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'CIRCLE', turnDirection: 'right', turnDegrees: 360 }], clean: true },
    { say: `${C} make a left 360`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'CIRCLE', turnDirection: 'left', turnDegrees: 360 }], clean: true },
    { say: `${C} make right two seventy`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'CIRCLE', turnDirection: 'right', turnDegrees: 270 }], clean: true },
    { say: `${C} go around, enter left downwind`, cmds: [{ kind: 'GO_AROUND' }, { kind: 'ENTER_PATTERN', patternLeg: 'left_downwind' }], clean: true },
    { say: `${C} go around, make right traffic runway one three`, cmds: [{ kind: 'GO_AROUND' }, { kind: 'ENTER_PATTERN', patternLeg: 'right_downwind', runwayEnd: '13' }], clean: true },
  ],

  'closed traffic, option, touch-and-go (3-10-11, 3-8-1)': [
    { say: `${C} remain in closed traffic`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'CLOSED_TRAFFIC' }], clean: true },
    { say: `${C} make left closed traffic`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'CLOSED_TRAFFIC', turnDirection: 'left' }], clean: true },
    { say: `${C} left closed traffic approved`, cmds: [{ kind: 'PATTERN_INSTRUCTION', destination: 'CLOSED_TRAFFIC', turnDirection: 'left' }], clean: true },
    { say: `${C} make right traffic runway 13`, cmds: [{ kind: 'ENTER_PATTERN', patternLeg: 'right_downwind', runwayEnd: '13' }], clean: true },
    { say: `${C} runway one three, cleared for the option`, cmds: [{ kind: 'LAND', destination: 'option', runwayEnd: '13' }], clean: true },
    { say: `${C} runway one three, cleared touch and go`, cmds: [{ kind: 'LAND', destination: 'touch_and_go', runwayEnd: '13' }], clean: true },
    { say: `${C} runway one three, cleared low approach`, cmds: [{ kind: 'LAND', destination: 'low_approach', runwayEnd: '13' }], clean: true },
  ],

  'position reports (3-10-1)': [
    { say: `${C} report midfield downwind`, cmds: [{ kind: 'REPORT_POSITION', destination: 'REPORT_MIDFIELD_DOWNWIND' }], clean: true },
    { say: `${C} report abeam midfield downwind`, cmds: [{ kind: 'REPORT_POSITION', destination: 'REPORT_MIDFIELD_DOWNWIND' }], clean: true },
    { say: `${C} report downwind`, cmds: [{ kind: 'REPORT_POSITION', destination: 'REPORT_MIDFIELD_DOWNWIND' }], clean: true },
    { say: `${C} report base`, cmds: [{ kind: 'REPORT_POSITION', destination: 'REPORT_BASE' }], clean: true },
    { say: `${C} report left base`, cmds: [{ kind: 'REPORT_POSITION', destination: 'REPORT_BASE' }], clean: true },
    { say: `${C} report two mile final`, cmds: [{ kind: 'REPORT_POSITION', destination: 'REPORT_FINAL', distanceNm: 2 }], clean: true },
    { say: `${C} report two-mile final`, cmds: [{ kind: 'REPORT_POSITION', destination: 'REPORT_FINAL', distanceNm: 2 }], clean: true },
    { say: `${C} report final`, cmds: [{ kind: 'REPORT_POSITION', destination: 'REPORT_FINAL' }], clean: true },
  ],

  'frequency change approved, squawk (7-6-11, 5-2-1)': [
    { say: `${C} frequency change approved`, cmds: [{ kind: 'FREQUENCY_CHANGE_APPROVED' }], clean: true },
    { say: `${C} change to advisory frequency approved`, cmds: [{ kind: 'FREQUENCY_CHANGE_APPROVED' }], clean: true },
    { say: `${C} squawk VFR, frequency change approved`, cmds: [{ kind: 'SQUAWK', squawk: '1200', destination: 'VFR' }, { kind: 'FREQUENCY_CHANGE_APPROVED' }], clean: true },
    { say: `${C} radar service terminated, squawk VFR, frequency change approved`, cmds: [{ kind: 'SQUAWK', squawk: '1200' }, { kind: 'FREQUENCY_CHANGE_APPROVED' }], clean: true },
    { say: `${C} squawk one two zero zero`, cmds: [{ kind: 'SQUAWK', squawk: '1200' }], clean: true },
    { say: `${C} squawk twelve hundred`, cmds: [{ kind: 'SQUAWK', squawk: '1200' }], clean: true },
    { say: `${C} squawk four three two one`, cmds: [{ kind: 'SQUAWK', squawk: '4321' }], clean: true },
    { say: `${C} squawk 0 4 0 5`, cmds: [{ kind: 'SQUAWK', squawk: '0405' }], clean: true },
    { say: `${C} squawk one two zero nine`, cmds: [{ kind: 'SQUAWK' }], issue: 'invalid squawk code', conf: [0, 0.6] },
    { say: `${C} squawk ident`, cmds: [{ kind: 'UNKNOWN' }], issue: 'unsupported instruction: squawk' },
  ],

  'departure / landing information (3-9-1, 3-10-1)': [
    { say: `${C} wind one three zero at eight, altimeter three zero one zero`, cmds: [{ kind: 'AIRPORT_INFO', info: { windDirDeg: 130, windSpeedKt: 8, altimeterInHg: 30.1 } }], clean: true },
    { say: `${C} wind calm, altimeter two niner niner two`, cmds: [{ kind: 'AIRPORT_INFO', info: { calm: true, altimeterInHg: 29.92 } }], clean: true },
    { say: `${C} altimeter three zero one zero`, cmds: [{ kind: 'AIRPORT_INFO', info: { altimeterInHg: 30.1 } }], clean: true },
    { say: `${C} wind two seven zero at one two gusts two two`, cmds: [{ kind: 'AIRPORT_INFO', info: { windDirDeg: 270, windSpeedKt: 12, windGustKt: 22 } }], clean: true },
    // with a clearance the information is attached to it, not a command of its own
    { say: `${C} runway one three, wind one three zero at eight, altimeter three zero one zero, cleared for takeoff`, cmds: [{ kind: 'TAKEOFF', runwayEnd: '13', info: { windDirDeg: 130, windSpeedKt: 8, altimeterInHg: 30.1 } }], clean: true },
    { say: `${C} runway one three, line up and wait, wind one three zero at eight`, cmds: [{ kind: 'LINE_UP_AND_WAIT', runwayEnd: '13', info: { windDirDeg: 130, windSpeedKt: 8 } }], clean: true },
    { say: `${C} wind calm, runway one three, cleared to land`, cmds: [{ kind: 'LAND', runwayEnd: '13', info: { calm: true } }], clean: true },
    { say: `${C} altimeter three zero point one zero`, cmds: [{ kind: 'AIRPORT_INFO', info: { altimeterInHg: 30.1 } }], clean: true },
    { say: `${C} altimeter 31 nine nine`, cmds: [{ kind: 'AIRPORT_INFO' }], issue: 'implausible altimeter', conf: [0, 0.9] },
  ],
});

describe('multi-aircraft transmissions keep their order', () => {
  it('exit + frequency are two commands for one callsign, in order', () => {
    const r = parseTransmission(`${S} turn right at Alpha, contact ground one two one point nine`, CTX);
    expect(r.commands.map((c) => c.kind)).toEqual(['EXIT_RUNWAY', 'CONTACT_FREQUENCY']);
    expect(r.callsign).toBe('NKS451');
  });
});
