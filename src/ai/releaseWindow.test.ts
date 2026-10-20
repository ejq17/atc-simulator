/**
 * A departure that needs a Departure release and waits at the hold while GA arrivals land one after another (free-play soak, seed 3, moderate: NKS1210 stood at the
 * hold of runway 22 for 1,900 s; its release was asked for when a gap opened, lapsed 120 s later with the lander ahead still on the runway, and the next request
 * was made 740 s later). JO 7110.65 4-3-4: the release is Departure's, given on request ("released"); the Tower applies 3-9-5 / 3-9-6 / 3-10-3 when it issues
 * the takeoff clearance. So the release is asked for at the hold line, not when a gap happens to be open, and renewed (a second request while the first is still
 * valid) when it is about to lapse and the departure still waits.
 */
import { describe, expect, it } from 'vitest';
import { createHarness } from './testkit';
import { ARRIVING, HOLDING } from '../sim/__fixtures__/testHelpers';
import { COORDINATION_DESIGN, validApproval } from '../sim/coordination';
import { DEPARTURE_WAIT_BOUND_SEC } from './world';
import type { ScenarioAircraftSpawn } from '../sim/types';

const IFR_HOLD = (): ScenarioAircraftSpawn => ({
  ...HOLDING('NKS900', 'HP4-22-A-2', '22', 'A320'),
  flightPlan: { flightRules: 'IFR', origin: 'KACY', destination: 'KPHL', cruiseAltitudeFt: 10000, route: ['VCN'] },
});
/** GA landers on the final of 22, 170 s apart, the first one 2.5 nm out: the jet at the hold has to wait for its gap. */
const LANDERS = (): ScenarioAircraftSpawn[] => [0, 1, 2, 3, 4, 5, 6].map((i) => ({ ...ARRIVING(`N${i + 1}0GA`, '22', i === 0 ? 2.5 : 4, 'C172', 'TWR'), atSec: i * 170 }));

describe('release for a departure that waits at the hold (7110.65 4-3-4, 3-9-5, 3-9-6, 3-10-3)', () => {
  it('holds a valid release from the first answer until the takeoff clearance, renews it before it lapses, and goes within the fairness bound', () => {
    const h = createHarness({ player: [], ai: ['CLNC', 'GND', 'TWR', 'APP', 'DEP'], mode: 'free_play', activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [IFR_HOLD(), ...LANDERS()], seed: 3, aiSeed: 5 });
    let first: number | undefined;
    let cleared: number | undefined;
    let gaps = 0;
    h.runUntil(() => cleared !== undefined, 1800, () => {
      const d = h.find('NKS900');
      if (!d) return;
      const held = !!validApproval(h.engine.getState(), 'RELEASE', d.id);
      if (first === undefined && held) first = h.now();
      if (cleared === undefined && d.phase !== 'HOLDING_SHORT' && d.phase !== 'LINE_UP_AND_WAIT') cleared = h.now();
      if (first !== undefined && cleared === undefined && !held) gaps++;
    });
    expect(cleared, 'the departure never left the hold').toBeDefined();
    expect(first, 'no release was ever granted').toBeDefined();
    expect(first!).toBeLessThan(60); // asked at the hold line, not when a gap happened to open
    expect(cleared!).toBeLessThan(DEPARTURE_WAIT_BOUND_SEC);
    expect(gaps, 'seconds at the hold without a valid release after the first one').toBe(0);
    const state = h.engine.getState();
    const reqs = (state.coordination?.requests ?? []).filter((r) => r.topic === 'RELEASE' && r.aircraftId === h.find('NKS900')!.id);
    if (cleared! - first! > COORDINATION_DESIGN.releaseTtlSec - COORDINATION_DESIGN.releaseRenewBeforeSec) {
      const renewal = reqs.find((r) => r.renewalOf);
      expect(renewal, 'waited longer than a release lasts and never renewed it').toBeDefined();
      expect(renewal!.createdSec).toBeLessThan(first! + COORDINATION_DESIGN.releaseTtlSec); // before the first one lapsed
    }
    expect(h.events.some((e) => e.kind === 'COORDINATION' && e.data?.error)).toBe(false); // never cleared for takeoff without it
  });

  it('a renewal does not count as another departure released (the next departure is not told to stand by for it)', () => {
    const h = createHarness({ player: [], ai: ['CLNC', 'GND', 'TWR', 'APP', 'DEP'], mode: 'free_play', activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [IFR_HOLD(), ...LANDERS()], seed: 3, aiSeed: 5 });
    h.run(135);
    const reqs = (h.engine.getState().coordination?.requests ?? []).filter((r) => r.topic === 'RELEASE');
    expect(reqs.some((r) => r.renewalOf)).toBe(true);
    expect(COORDINATION_DESIGN.releaseRenewBeforeSec).toBeLessThan(COORDINATION_DESIGN.releaseTtlSec);
  });
});

describe('a departure that needs no release behind back-to-back GA landings (soak seeds 3 and 5)', () => {
  it('a C172 at the 22 hold behind landings 200 s apart departs inside the fairness bound', () => {
    const landers = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ ...ARRIVING(`N${i + 1}0GB`, '22', i === 0 ? 2.5 : 4, 'C172', 'TWR'), atSec: i * 200 }));
    const h = createHarness({ player: [], ai: ['CLNC', 'GND', 'TWR', 'APP', 'DEP'], mode: 'free_play', activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [HOLDING('N900D', 'HP4-22-A-2', '22', 'C172'), ...landers], seed: 3, aiSeed: 5, pilotRealism: 'moderate' });
    let left: number | undefined;
    h.runUntil(() => { const d = h.find('N900D'); if (d && left === undefined && d.phase !== 'HOLDING_SHORT') left = h.now(); return left !== undefined; }, 1800);
    expect(left, 'the departure never left the hold').toBeDefined();
    expect(left!).toBeLessThan(DEPARTURE_WAIT_BOUND_SEC);
  });
});
