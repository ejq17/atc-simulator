/**
 * Departure heading given with the takeoff clearance (JO 7110.65 3-9-10): parsed into the TAKEOFF, read back in one call, flown after liftoff.
 */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../../airport';
import { createEngine } from '../../sim/engine';
import type { ExtendedEngine } from '../../sim/engineExtras';
import { findRunwayEnd } from '../../sim/runways';
import { headingDiff, magneticToTrue } from '../../sim/geo';
import { ALL_POSITIONS, HOLDING, find, makeScenario, run } from '../../sim/__fixtures__/testHelpers';
import type { PilotRealismLevel } from '../../sim/pilotBehaviour';
import { transmit } from './transmit';

const kacy = loadKacy();
const CLEAN = { delayedResponseRate: 0, noReadbackRate: 0, sayAgainRate: 0, digitErrorRate: 0, altitudeErrorRate: 0, frequencyErrorRate: 0, squawkErrorRate: 0, patternMisunderstandRate: 0, wrongCallsignRate: 0 };

function engineWith(realism: PilotRealismLevel | undefined, rates: Record<string, number> = {}, errorRate = 0): ExtendedEngine {
  return createEngine({
    airport: kacy, readbackErrorRate: errorRate, utcStartMs: Date.UTC(2026, 9, 17, 16),
    scenario: makeScenario({
      mode: 'free_play', controllerPositions: ALL_POSITIONS, playerPositions: ALL_POSITIONS, activeRunways: { departing: ['13'], landing: ['13'] }, spawns: [HOLDING('N723EJ', 'HP13-31-B-1', '13')],
      ...(realism ? { pilotRealism: realism, pilotBehaviour: { noAtisFraction: 0, ground: { holdShortOmitFraction: 0, unfamiliarFraction: 0, taxiwayErrorShare: 0 }, realism: { ...CLEAN, ...rates } } } : {}),
    }),
  }) as ExtendedEngine;
}
const clear = (e: ExtendedEngine, text: string) => transmit({ engine: e, text: `Cessna seven two three echo juliet, ${text}`, source: 'typed', controller: { positions: ['TWR'] } });
const readbacks = (e: ExtendedEngine, since: number) =>
  e.getState().events.filter((x) => x.kind === 'TRANSMISSION' && x.speaker === 'PILOT' && x.callsign === 'N723EJ' && x.timeSec >= since - 1e-9 && x.data?.readback).map((x) => x.text);

describe.each<[string, PilotRealismLevel | undefined]>([['realism off', undefined], ['heavy realism', 'heavy']])('%s', (_n, realism) => {
  it('"fly heading one eight zero, runway one three, cleared for takeoff": one TAKEOFF, one readback, runway heading first, then the heading', () => {
    const e = engineWith(realism);
    run(e, 45);
    const since = e.getState().clock.timeSec;
    const r = clear(e, 'turn right heading one eight zero, runway one three, cleared for takeoff');
    expect(r.commands.map((c) => c.kind)).toEqual(['TAKEOFF']);
    expect(r.commands[0]).toMatchObject({ runwayEnd: '13', departureHeading: 180, turnDirection: 'right' });
    expect(r.results[0].outcome.status).toBe('accepted');
    run(e, 12);
    expect(readbacks(e, since)).toEqual(['Right heading one eight zero, runway one three, cleared for takeoff, Cessna seven two three echo juliet']);
    const ac = find(e, 'N723EJ');
    const rwyTrue = ac.clearances.find((c) => c.kind === 'TAKEOFF')?.headingDeg; // magnetic 180 stored on the clearance
    expect(rwyTrue).toBe(180);
    // not on the ground roll and not at liftoff: the nose follows the runway
    const g = findRunwayEnd(kacy, '13')!;
    let sawClimbOnRunwayHeading = false;
    for (let i = 0; i < 600 && !(ac.altitudeFt - kacy.elevationFt > 1500); i++) {
      run(e, 1);
      const agl = ac.altitudeFt - kacy.elevationFt;
      if (!ac.onGround && agl > 50 && agl < 300 && Math.abs(headingDiff(ac.headingDeg, g.headingDeg)) < 8) sawClimbOnRunwayHeading = true;
      if (ac.onGround && ac.phase === 'TAKEOFF_ROLL') expect(Math.abs(headingDiff(ac.headingDeg, g.headingDeg))).toBeLessThan(8);
    }
    expect(sawClimbOnRunwayHeading).toBe(true);
    run(e, 60);
    expect(Math.abs(headingDiff(ac.headingDeg, magneticToTrue(180, kacy.magneticVariationDeg)))).toBeLessThan(15);
    expect(ac.phase).not.toBe('PARKED');
  });
});

describe('a departure heading and the readback error', () => {
  it('a heading digit slip lands inside the joined readback and is flown only if uncorrected', () => {
    const e = engineWith('heavy', { digitErrorRate: 1 }, 1);
    run(e, 45);
    const since = e.getState().clock.timeSec;
    clear(e, 'fly heading two seven zero, runway one three, cleared for takeoff');
    run(e, 12);
    const rb = readbacks(e, since);
    expect(rb).toHaveLength(1);
    expect(rb[0]).toMatch(/^Heading .*, runway one three, cleared for takeoff, Cessna seven two three echo juliet$/);
    expect(rb[0]).not.toMatch(/^Heading two seven zero/);
    const ac = find(e, 'N723EJ');
    expect(ac.flags.readbackErrorPending).toBe(true);
    expect(ac.flags.readbackErrorKind).toBe('heading');
  });

});
