/**
 * The AI controllers cope with imperfect pilots: every readback error kind is corrected, missed calls and "say again" are repeated,
 * blocked pilots are waited out, and the pilot-initiated requests are answered (approved or "unable"). Seeded, real engine, real KACY.
 */
import { describe, expect, it } from 'vitest';
import type { PilotBehaviourOverride } from '../sim/pilotBehaviour';
import type { Aircraft, ControllerPositionId } from '../sim/types';
import { cmd, createHarness, IFR_ARR, IFR_DEP } from './testkit';
import type { Harness } from './testkit';

const NO_REQUESTS = { RUNWAY_CHANGE: 0, SHORT_APPROACH: 0, OPTION: 0, STRAIGHT_IN: 0, STAY_IN_PATTERN: 0, NEED_MINUTE: 0, SPACING_360: 0, HIGHER: 0, DIRECT_FIX: 0, VISUAL_APPROACH: 0, TAXI_BACK: 0 };
/** Every kind of mistake at a rate that actually happens in a 25 minute run. */
const MESSY: PilotBehaviourOverride = {
  noAtisFraction: 0,
  realism: {
    digitErrorRate: 0.3, altitudeErrorRate: 0.3, frequencyErrorRate: 0.3, squawkErrorRate: 0.3, noReadbackRate: 0.2,
    delayedResponseRate: 0.2, sayAgainRate: 0.5, wrongCallsignRate: 1, requests: NO_REQUESTS,
  },
};
const GND_MHZ = 121.9;
const aircraft = (h: Harness) => Object.values(h.engine.getState().aircraft);

/** Player working Ground (same script as ai.test.ts, but it retries when the pilot did not answer). */
function groundPlayer(h: Harness) {
  return () => {
    for (const ac of aircraft(h)) {
      if (ac.frequencyMhz !== GND_MHZ || ac.radioState === 'TRANSMITTING') continue;
      const p = ac.pendingRequest?.kind;
      if (ac.isDeparture && p === 'PUSHBACK') h.say('GND', cmd('PUSHBACK', ac.callsign));
      else if (ac.isDeparture && p === 'TAXI') h.say('GND', cmd('TAXI', ac.callsign, { destination: 'RWY13', route: ['B'], holdShort: ['4/22'] }));
      else if (p === 'CROSSING') h.say('GND', cmd('CROSS_RUNWAY', ac.callsign, { crossRunwayId: '4/22' }));
      else if (ac.isDeparture && p === 'FREQUENCY_CHANGE') h.say('GND', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'TWR' }));
      else if (!ac.isDeparture && p === 'TAXI') h.say('GND', cmd('TAXI_TO_PARKING', ac.callsign, { destination: 'GATE' }));
    }
  };
}
const allGone = (h: Harness, after = 60) => () => h.now() > after && Object.keys(h.engine.getState().aircraft).length === 0;

describe('AI controllers with messy pilots', () => {
  const run = (seed = 4242) => {
    const h = createHarness({
      player: ['GND'], seed, mode: 'free_play', pilotRealism: 'heavy', pilotBehaviour: MESSY,
      spawns: [IFR_DEP('NKS451', 'GATE-1', ['VCN']), IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 4000)],
    });
    h.runUntil(allGone(h), 3600, groundPlayer(h));
    return h;
  };
  const h = run();

  it('still takes both flights through, safely', () => {
    expect(Object.keys(h.engine.getState().aircraft)).toHaveLength(0);
    expect(h.engine.getState().score.aircraftHandled).toBeGreaterThanOrEqual(1);
    // slow, silent and confused pilots delay the taxi: a 29 m ground proximity can result, never an incursion or an unsafe clearance
    const bad = h.events.filter((e) => ['RUNWAY_INCURSION', 'GO_AROUND'].includes(e.kind) || (e.kind === 'CONFLICT' && /UNSAFE/.test(e.text)));
    expect(bad.map((e) => `${e.timeSec} ${e.text}`)).toEqual([]);
  });

  it('corrects the readback errors of its own clearances: errors were made and corrected, none of the AI\'s was missed', () => {
    const made = h.events.filter((e) => e.kind === 'INFO' && e.data?.readbackError);
    expect(made.length).toBeGreaterThan(2);
    const fixed = h.events.filter((e) => e.kind === 'READBACK_ERROR' && e.data?.corrected);
    expect(new Set(fixed.map((e) => e.data?.errorKind)).size).toBeGreaterThan(1); // more than one kind of mistake
    // the Ground script of the test never corrects anything: only the player's own (GND) clearances may be missed
    const missed = h.events.filter((e) => e.kind === 'READBACK_ERROR' && e.data?.missed);
    expect(missed.filter((e) => e.data?.byPosition !== 'GND').map((e) => e.text)).toEqual([]);
  });

  it('is deterministic with messy pilots too', () => {
    const again = run();
    const sig = (x: Harness) => x.events.map((e) => `${e.id}|${e.timeSec}|${e.kind}|${e.text}`);
    expect(sig(again)).toEqual(sig(h));
  });

  it('a different seed makes different mistakes', () => {
    const other = run(777);
    const kinds = (x: Harness) => x.events.filter((e) => e.data?.readbackError).map((e) => `${e.timeSec}${e.data?.errorKind}`).join();
    expect(kinds(other)).not.toBe(kinds(h));
  });
});

describe('a pilot who asks to say a long transmission again', () => {
  it('hears it again slowly (no size mark) and the flight is still handled', () => {
    const h = createHarness({
      player: ['GND'], mode: 'free_play', pilotRealism: 'moderate',
      pilotBehaviour: { noAtisFraction: 0, realism: { digitErrorRate: 0, altitudeErrorRate: 0, noReadbackRate: 0, delayedResponseRate: 0, wrongCallsignRate: 0, radioDiscipline: false, sayAgainRate: 1, sayAgainMinCommands: 2, requests: NO_REQUESTS } },
      spawns: [IFR_DEP('NKS451', 'GATE-1', ['VCN'])],
    });
    h.runUntil(allGone(h), 2400, groundPlayer(h));
    const asked = h.events.filter((e) => e.kind === 'CLARIFICATION' && /asks you to say again/.test(e.text));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.length).toBeLessThanOrEqual(2); // once per long plan (departure: radar contact + altitude + direct)
    expect(h.events.some((e) => e.kind === 'DESPAWN' && e.data?.handled === true)).toBe(true);
  });
});

describe('AI answers pilot requests', () => {
  const quiet = (req: Partial<typeof NO_REQUESTS>): PilotBehaviourOverride => ({
    noAtisFraction: 0,
    realism: {
      digitErrorRate: 0, altitudeErrorRate: 0, frequencyErrorRate: 0, squawkErrorRate: 0, noReadbackRate: 0,
      delayedResponseRate: 0, sayAgainRate: 0, wrongCallsignRate: 0, studentShare: 0, radioDiscipline: false, requests: { ...NO_REQUESTS, ...req },
    },
  });
  const arrival = (cs = 'N723EJ', nm = 9) => ({
    atSec: 0, callsign: cs, type: 'C172', flightRules: 'VFR' as const, isDeparture: false, initialFrequencyId: 'TWR',
    start: { kind: 'airborne' as const, pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 70, runwayEnd: '13', distanceNm: nm },
  });
  const harness = (req: Partial<typeof NO_REQUESTS>, spawns: ReturnType<typeof arrival>[], player: ControllerPositionId[] = ['GND']): Harness =>
    createHarness({ player, ai: ['TWR', 'GND', 'APP', 'DEP', 'CLNC'].filter((p) => !player.includes(p as ControllerPositionId)) as ControllerPositionId[], mode: 'free_play', pilotRealism: 'moderate', pilotBehaviour: quiet(req), spawns });
  const answered = (h: Harness, cs: string, code: string): Aircraft | undefined => {
    const asked = h.runUntil(() => h.find(cs)?.pendingRequest?.request === code, 600);
    expect(asked, `${code} requested`).toBe(true);
    const t0 = h.now();
    const gone = h.runUntil(() => h.find(cs)?.pendingRequest?.request !== code, 120);
    expect(gone, `${code} answered`).toBe(true);
    expect(h.now() - t0).toBeGreaterThanOrEqual(3); // human reaction time
    return h.find(cs);
  };

  it('straight-in: approved with "make straight-in", then the normal landing clearance follows', () => {
    const h = harness({ STRAIGHT_IN: 1 }, [arrival()]);
    answered(h, 'N723EJ', 'STRAIGHT_IN');
    expect(h.atc('TWR').some((e) => /straight-in runway one three/.test(e.text))).toBe(true);
    expect(h.runUntil(() => h.events.some((e) => e.kind === 'COMMAND_ACCEPTED' && e.data?.kind === 'LAND'), 400)).toBe(true);
  });

  it('runway change: unable when the requested runway is not in use', () => {
    const h = harness({ RUNWAY_CHANGE: 1 }, [arrival('N723EJ', 12)]);
    answered(h, 'N723EJ', 'RUNWAY_CHANGE');
    expect(h.atc('TWR').some((e) => /unable, runway/.test(e.text))).toBe(true);
    h.run(8);
    expect(h.pilotTexts('N723EJ').some((t) => t.startsWith('Roger'))).toBe(true);
  });

  it('short approach and the option in the pattern', () => {
    const h = harness({ SHORT_APPROACH: 1 }, [arrival('N723EJ', 6)]);
    h.say('TWR', cmd('ENTER_PATTERN', 'N723EJ', { patternLeg: 'left_downwind', runwayEnd: '13' }));
    answered(h, 'N723EJ', 'SHORT_APPROACH');
    expect(h.atc('TWR').some((e) => /make short approach/.test(e.text))).toBe(true);
    const o = harness({ OPTION: 1 }, [arrival('N723EJ', 6)]);
    o.say('TWR', cmd('ENTER_PATTERN', 'N723EJ', { patternLeg: 'left_downwind', runwayEnd: '13' }));
    answered(o, 'N723EJ', 'OPTION');
    expect(o.atc('TWR').some((e) => /cleared for the option|unable/.test(e.text))).toBe(true);
  });

  it('a departure asking for higher gets an altitude', () => {
    const dep = {
      atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR' as const, isDeparture: true, initialFrequencyId: 'DEP',
      start: { kind: 'airborne' as const, pos: { x: 3000, y: -2500 }, altitudeFt: 2500, headingDeg: 130, speedKt: 100, runwayEnd: '13' },
    };
    const h = harness({ HIGHER: 1 }, [dep as never]);
    answered(h, 'N723EJ', 'HIGHER');
    expect(h.atc().some((e) => e.callsign === 'N723EJ' && /maintain/.test(e.text))).toBe(true);
    expect(h.find('N723EJ')?.target.altitudeFt).toBeGreaterThan(2500);
  });
});

describe('IFR visual approach request', () => {
  it('"field in sight, request visual" is answered by Approach with a visual approach clearance', () => {
    const h = createHarness({
      player: ['GND'], mode: 'free_play', pilotRealism: 'moderate', seed: 99,
      pilotBehaviour: { noAtisFraction: 0, realism: { digitErrorRate: 0, altitudeErrorRate: 0, noReadbackRate: 0, delayedResponseRate: 0, sayAgainRate: 0, wrongCallsignRate: 0, radioDiscipline: false, requests: { ...NO_REQUESTS, VISUAL_APPROACH: 1 } } },
      spawns: [IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 4000)],
    });
    expect(h.runUntil(() => h.find('AAL212')?.pendingRequest?.request === 'VISUAL_APPROACH', 900)).toBe(true);
    h.runUntil(() => h.find('AAL212')?.pendingRequest?.request !== 'VISUAL_APPROACH', 120);
    expect(h.atc('APP').some((e) => /cleared visual approach runway one three/.test(e.text))).toBe(true);
  });
});
