/**
 * A departure at an intersection hold with too little runway for its type (a real session: an A320 sent to runway 4 at delta,
 * 4,829 ft) is never cleared for takeoff over and over; Tower sends it back to Ground, and AI Ground taxis it to full length.
 */
import { describe, expect, it } from 'vitest';
import { createHarness } from './testkit';
import type { ScenarioAircraftSpawn } from '../sim/types';

const atDelta: ScenarioAircraftSpawn = {
  atSec: 0, callsign: 'AAL2787', type: 'A320', flightRules: 'IFR', start: { kind: 'holding_short', nodeId: 'HP4-22-D-1', runwayEnd: '4' },
  isDeparture: true, initialFrequencyId: 'TWR',
  flightPlan: { flightRules: 'IFR', origin: 'KACY', destination: 'KATL', cruiseAltitudeFt: 35000, route: ['ACY'] },
};

describe('AI Tower and an intersection that is too short', () => {
  it('Tower does not clear it for takeoff; it hands the aircraft to the player on Ground, and the pilot asks for full length', () => {
    const h = createHarness({ spawns: [atDelta], player: ['GND'], activeRunways: { departing: ['4'], landing: ['4'] }, mode: 'free_play' });
    const ac = h.find('AAL2787')!;
    h.run(120);
    expect(h.atc('TWR').filter((e) => /cleared for takeoff/i.test(e.text))).toHaveLength(0);
    expect(h.atc('TWR').some((e) => /contact ground/i.test(e.text))).toBe(true);
    expect(ac.frequencyId).toBe('GND');
    expect(h.pilotTexts('AAL2787').some((t) => /request full length/.test(t))).toBe(true);
  });

  it('with AI Ground as well, the aircraft is taxied to the full-length hold at alpha', () => {
    const h = createHarness({ spawns: [atDelta], player: ['CLNC'], activeRunways: { departing: ['4'], landing: ['4'] }, mode: 'free_play' });
    const ac = h.find('AAL2787')!;
    expect(h.runUntil(() => ac.phase === 'TAXIING', 240)).toBe(true);
    expect(ac.route?.nodeIds.at(-1)).toBe('HP4-22-A-1');
    expect(h.atc('TWR').filter((e) => /cleared for takeoff/i.test(e.text))).toHaveLength(0);
  });
});
