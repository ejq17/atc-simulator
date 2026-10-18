/**
 * One transmission, one readback: a progressive-taxi step, an exit with the handoff to Ground, line up and wait with traffic
 * (JO 7110.65 2-4-3, 3-7-2, 3-9-4, 3-10-9; AIM 4-3-18), through the player's transmit pipeline on real KACY.
 */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../../airport';
import { createEngine } from '../../sim/engine';
import type { ExtendedEngine } from '../../sim/engineExtras';
import { cmd, find, makeScenario, pilotTexts, run, say } from '../../sim/__fixtures__/testHelpers';
import type { PilotRealismLevel } from '../../sim/pilotBehaviour';
import type { ScenarioAircraftSpawn } from '../../sim/types';
import { transmit } from './transmit';

const kacy = loadKacy();
const GND = { positions: ['GND' as const] };
const TWR = { positions: ['TWR' as const] };

function engineWith(spawns: ScenarioAircraftSpawn[], realism?: PilotRealismLevel): ExtendedEngine {
  return createEngine({
    airport: kacy, readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 9, 17, 16),
    scenario: makeScenario({ mode: 'free_play', controllerPositions: ['GND', 'TWR'], playerPositions: ['GND', 'TWR'], activeRunways: { departing: ['13'], landing: ['13'] }, spawns, ...(realism ? { pilotRealism: realism, pilotBehaviour: { noAtisFraction: 0, ground: { holdShortOmitFraction: 0, unfamiliarFraction: 0, taxiwayErrorShare: 0 }, realism: { delayedResponseRate: 0, noReadbackRate: 0, sayAgainRate: 0, digitErrorRate: 0, altitudeErrorRate: 0, frequencyErrorRate: 0, squawkErrorRate: 0, patternMisunderstandRate: 0, wrongCallsignRate: 0 } } } : {}) }),
  }) as ExtendedEngine;
}
const cessna = { atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR' as const, isDeparture: true, initialFrequencyId: 'GND', start: { kind: 'parked' as const, parkingId: 'GA-1' } };

/** The pilot's readbacks to the transmission, in order. */
const readbacks = (e: ExtendedEngine, since: number, cs = 'NKS451') =>
  e.getState().events.filter((x) => x.kind === 'TRANSMISSION' && x.speaker === 'PILOT' && x.callsign === cs && x.timeSec >= since - 1e-9).map((x) => x.text);

describe.each<[string, PilotRealismLevel | undefined]>([['no pilot realism', undefined], ['heavy pilot realism', 'heavy']])('progressive taxi, %s', (_n, realism) => {
  it('"turn left on Lima, continue to Mike, hold short of runway four" is three commands and ONE readback', () => {
    const e = engineWith([cessna], realism);
    run(e, 70);
    transmit({ engine: e, text: 'Cessna seven two three echo juliet, taxi to lima', source: 'typed', controller: GND });
    run(e, 150); // the aircraft is now stopped at the end of Lima
    const since = e.getState().clock.timeSec;
    const r = transmit({ engine: e, text: 'Cessna seven two three echo juliet, turn left on lima, continue to mike, hold short of runway four', source: 'typed', controller: GND });
    expect(r.commands.map((c) => c.kind)).toEqual(['EXIT_RUNWAY', 'TAXI', 'HOLD_SHORT']); // the commands keep their separate engine effects
    expect(r.results.map((x) => x.outcome.status)).toEqual(['accepted', 'accepted', 'accepted']);
    run(e, 15);
    expect(readbacks(e, since, 'N723EJ')).toEqual(['Left on lima, continue to mike, hold short of runway four, Cessna seven two three echo juliet']);
  });
});

describe('the other combined instructions are read back once', () => {
  it('"turn right at Charlie, contact Ground point niner" after landing: one readback', () => {
    const e = engineWith([{ atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR' as const, isDeparture: false, initialFrequencyId: 'TWR', start: { kind: 'airborne' as const, pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 70, runwayEnd: '13', distanceNm: 4 } }]);
    run(e, 20);
    say(e, cmd('LAND', 'N723EJ', { runwayEnd: '13' }), 'TWR');
    let n = 0;
    while (!(find(e, 'N723EJ').phase === 'ROLLOUT' && find(e, 'N723EJ').groundSpeedKt < 60) && n++ < 900) run(e, 1);
    const since = e.getState().clock.timeSec;
    // an exit the engine accepts from here (the aircraft is on its rollout), said as the tower would
    const NATO: Record<string, string> = { A: 'alpha', B: 'bravo', C: 'charlie', D: 'delta', E: 'echo', F: 'foxtrot', G: 'golf', H: 'hotel', J: 'juliet', K: 'kilo', L: 'lima', M: 'mike', N: 'november', P: 'papa', Q: 'quebec', R: 'romeo', S: 'sierra', T: 'tango' };
    const pick = Object.keys(NATO).flatMap((t) => (['right', 'left'] as const).map((d) => ({ t, d })))
      .find(({ t, d }) => e.validateCommand!(cmd('EXIT_RUNWAY', 'N723EJ', { exitTaxiway: t, turnDirection: d }), { position: 'TWR' }).status === 'accepted');
    expect(pick).toBeDefined();
    const r = transmit({ engine: e, text: `Cessna seven two three echo juliet, turn ${pick!.d} at ${NATO[pick!.t]}, contact ground point niner`, source: 'typed', controller: TWR });
    expect(r.commands.map((c) => c.kind)).toEqual(['EXIT_RUNWAY', 'CONTACT_FREQUENCY']);
    run(e, 3);
    const rb = readbacks(e, since, 'N723EJ');
    expect(rb).toEqual([`Turn ${pick!.d} at ${NATO[pick!.t]}, ground point niner, Cessna seven two three echo juliet`]);
  });

  it('line up and wait with traffic advised is one command and one readback', () => {
    const e = engineWith([{ atSec: 0, callsign: 'N991KB', type: 'C172', flightRules: 'VFR' as const, isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'holding_short' as const, nodeId: 'HP13-31-B-1', runwayEnd: '13' } }]);
    run(e, 10);
    const since = e.getState().clock.timeSec;
    const r = transmit({ engine: e, text: 'Cessna niner niner one kilo bravo, runway one three, line up and wait, traffic Cessna six mile final', source: 'typed', controller: TWR });
    expect(r.commands.map((c) => c.kind)).toEqual(['LINE_UP_AND_WAIT']);
    run(e, 5);
    expect(readbacks(e, since, 'N991KB')).toHaveLength(1);
    expect(pilotTexts(e, 'N991KB').filter((t) => /line up and wait/i.test(t))).toHaveLength(1);
  });
});
