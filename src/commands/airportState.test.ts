/**
 * Parser rules for the airport-state phraseology: STAR clearance (JO 7110.65 4-7-1, 4-5-7), bird activity and braking action advisories (2-1-23,
 * 3-3-4, 3-3-5), RVR in a landing clearance (2-8-3) and runway light requests / answers (3-4-10, 3-4-11).
 */
import { describe, expect, it } from 'vitest';
import { parseTransmission } from './index';
import { AIRCRAFT, CTX, type Case } from './testkit';
import type { ParseContext } from './context';

const CTX_KMHT: ParseContext = {
  ...CTX,
  aircraft: AIRCRAFT,
  runwayEnds: ['6', '24', '17', '35'],
  taxiways: ['A', 'B', 'C', 'D'],
  fixes: [{ id: 'CRIBB', spoken: 'crib' }, { id: 'MUCOW', spoken: 'mucow' }, { id: 'PONCT', spoken: 'ponte' }, { id: 'QUINZ', spoken: 'quinz' }, { id: 'SMYTH', spoken: 'smith' }, { id: 'TEETO', spoken: 'teeto' }],
  arrivals: [{ ident: 'ROZZE2', spokenName: 'ROZZE TWO', transitions: ['CRIBB', 'MUCOW', 'PONCT', 'QUINZ', 'SMYTH'] }],
};
const S = 'Southwest seventeen seventeen';
const SWA = { callsign: 'SWA1717' };

function run(groups: Record<string, Case[]>) {
  for (const [name, cases] of Object.entries(groups)) {
    describe(name, () => {
      it.each(cases.map((c) => [c.say, c] as const))('%s', (_say, c) => {
        const r = parseTransmission(c.say, c.ctx ?? CTX_KMHT);
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
  'STAR clearance (4-7-1) and descend via (4-5-7)': [
    { say: `${S}, cleared ROZZE two arrival`, cmds: [{ kind: 'STAR', ...SWA, starName: 'ROZZE2', descendVia: false }], clean: true, conf: [0.9, 1] },
    { say: `${S}, cleared ROZZE 2 arrival`, cmds: [{ kind: 'STAR', starName: 'ROZZE2', descendVia: false }], clean: true },
    { say: `${S}, ROZZE two arrival`, cmds: [{ kind: 'STAR', starName: 'ROZZE2' }], clean: true },
    { say: `${S}, ROZZE two arrival, CRIBB transition`, cmds: [{ kind: 'STAR', starName: 'ROZZE2', starTransition: 'CRIBB' }], clean: true },
    { say: `${S}, cleared the ROZZE two arrival, mucow transition`, cmds: [{ kind: 'STAR', starName: 'ROZZE2', starTransition: 'MUCOW' }], clean: true },
    { say: `${S}, descend via the ROZZE two arrival`, cmds: [{ kind: 'STAR', ...SWA, starName: 'ROZZE2', descendVia: true }], clean: true, conf: [0.9, 1] },
    { say: `${S}, descend via ROZZE two arrival`, cmds: [{ kind: 'STAR', starName: 'ROZZE2', descendVia: true }], clean: true },
    { say: `${S}, radar contact, descend via the ROZZE two arrival`, cmds: [{ kind: 'RADAR_CONTACT' }, { kind: 'STAR', descendVia: true }], clean: true },
    { say: `${S}, descend via the Rozzy two arrival`, cmds: [{ kind: 'STAR', starName: 'ROZZE2', descendVia: true }], clean: true }, // STT spelling
    { say: `${S}, descend via the ROZZE three arrival`, cmds: [{ kind: 'STAR' }], issue: 'unknown arrival', conf: [0, 0.59] },
    { say: `${S}, cleared ROZZE two arrival, SMYTH transition`, cmds: [{ kind: 'STAR', starTransition: 'SMYTH' }], clean: true },
    { say: `${S}, descend and maintain one zero thousand`, cmds: [{ kind: 'ALTITUDE', altitudeFt: 10000 }], clean: true },
    { say: `${S}, cleared ILS runway six approach`, cmds: [{ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '6' }], clean: true },
  ],
  'no arrivals known: the words are not an arrival clearance': [
    { say: `${S}, cleared ROZZE two arrival`, ctx: CTX, cmds: [{ kind: 'UNKNOWN' }] },
  ],
  'bird activity (2-1-23)': [
    { say: `${S}, caution, bird activity in the vicinity of the airport`, cmds: [{ kind: 'ADVISORY', ...SWA, advisory: 'BIRDS' }], clean: true, conf: [0.9, 1] },
    { say: `${S}, caution bird activity`, cmds: [{ kind: 'ADVISORY', advisory: 'BIRDS' }], clean: true },
    { say: `${S}, flock of geese, one o'clock, seven miles, northbound, last reported at four thousand`, cmds: [{ kind: 'ADVISORY', advisory: 'BIRDS' }], clean: true },
    { say: `${S}, numerous flocks of ducks, vicinity of the airport, altitude unknown`, cmds: [{ kind: 'ADVISORY', advisory: 'BIRDS' }], clean: true },
    { say: `${S}, caution, bird activity, runway six, cleared to land`, cmds: [{ kind: 'ADVISORY', advisory: 'BIRDS' }, { kind: 'LAND', runwayEnd: '6' }], clean: true },
  ],
  'braking action (3-3-4, 3-3-5)': [
    { say: `${S}, braking action advisories are in effect`, cmds: [{ kind: 'ADVISORY', advisory: 'BRAKING' }], clean: true },
    { say: `${S}, braking action medium, reported by a heavy Boeing seven sixty seven`, cmds: [{ kind: 'ADVISORY', advisory: 'BRAKING', brakingTerm: 'medium' }], clean: true },
    { say: `${S}, braking action medium to poor`, cmds: [{ kind: 'ADVISORY', brakingTerm: 'medium to poor' }], clean: true },
    { say: `${S}, braking action good to medium reported by an Airbus three twenty one`, cmds: [{ kind: 'ADVISORY', brakingTerm: 'good to medium' }], clean: true },
    { say: `${S}, no braking action reports received for runway six`, cmds: [{ kind: 'ADVISORY', advisory: 'BRAKING' }], clean: true },
    { say: `${S}, braking action poor, runway six, cleared to land`, cmds: [{ kind: 'ADVISORY', brakingTerm: 'poor' }, { kind: 'LAND', runwayEnd: '6' }], clean: true },
  ],
  'RVR in a landing clearance (2-8-3)': [
    { say: `${S}, runway six RVR two thousand four hundred, runway six, cleared to land`, cmds: [{ kind: 'LAND', ...SWA, runwayEnd: '6' }], clean: true, conf: [0.9, 1] },
    { say: `${S}, runway three five RVR more than six thousand, cleared to land runway three five`, cmds: [{ kind: 'LAND', runwayEnd: '35' }], clean: true },
    { say: `${S}, runway six RVR two thousand, rollout one thousand eight hundred, runway six, cleared to land`, cmds: [{ kind: 'LAND', runwayEnd: '6' }], clean: true },
  ],
  'runway lights (3-4-10, 3-4-11)': [
    { say: `${S}, increase the runway lights`, cmds: [{ kind: 'RUNWAY_LIGHTS', ...SWA, lightsDirection: 'UP' }], clean: true, conf: [0.9, 1] },
    { say: `${S}, lights up`, cmds: [{ kind: 'RUNWAY_LIGHTS', lightsDirection: 'UP' }], clean: true },
    { say: `${S}, runway lights increased`, cmds: [{ kind: 'RUNWAY_LIGHTS', lightsDirection: 'UP' }], clean: true },
    { say: `${S}, turn the lights down`, cmds: [{ kind: 'RUNWAY_LIGHTS', lightsDirection: 'DOWN' }], clean: true },
    { say: `${S}, turn up the runway lights`, cmds: [{ kind: 'RUNWAY_LIGHTS', lightsDirection: 'UP' }], clean: true },
    { say: `${S}, reduce the runway lights`, cmds: [{ kind: 'RUNWAY_LIGHTS', lightsDirection: 'DOWN' }], clean: true },
    { say: `${S}, set the runway lights to step four`, cmds: [{ kind: 'RUNWAY_LIGHTS', lightStep: 4 }], clean: true },
    { say: `${S}, runway lights step three`, cmds: [{ kind: 'RUNWAY_LIGHTS', lightStep: 3 }], clean: true },
    { say: `${S}, runway lights step seven`, cmds: [{ kind: 'RUNWAY_LIGHTS' }], issue: 'invalid light intensity step 7' },
    { say: `${S}, runway six, cleared for takeoff`, cmds: [{ kind: 'TAKEOFF', runwayEnd: '6' }], clean: true },
    { say: `${S}, taxi to runway six via alpha`, cmds: [{ kind: 'TAXI' }], clean: true },
  ],
});

describe('a wrong arrival number is not guessed', () => {
  it('"ROZZE three" gives no arrival name and a confidence below the execution threshold (0.6)', () => {
    const c = parseTransmission(`${S}, descend via the ROZZE three arrival`, CTX_KMHT).commands[0];
    expect(c.starName).toBeUndefined();
    expect(c.confidence).toBeLessThan(0.6);
  });
});

describe('the new kinds need what they need', () => {
  it('a STAR clearance without a known name, a lights command without direction or step, and an advisory without a kind are incomplete', () => {
    const r = parseTransmission(`${S}, cleared the arrival`, CTX_KMHT);
    expect(r.commands.every((c) => c.kind !== 'STAR')).toBe(true);
  });
});
