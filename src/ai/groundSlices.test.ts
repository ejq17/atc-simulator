/**
 * Two ground faults the free-play soak found when the departure gap moved its timeline (docs/DESIGN-VALUES.md section 9, "Departure gap round"). Each slice is the soak seed itself
 * (KACY, 10 + 10 per hour, 14 aircraft, 2 h).
 *
 *  - Seed 12, pilot realism moderate: a student on progressive taxi and two arrivals bound for the GA ramp stood nose to nose on lane L for 53 minutes. The follow-distance rule had
 *    stopped them and the head-on state was gone, so nobody held a request and Ground had nothing to answer. Two aircraft that stand still facing each other for
 *    30 s are nose to nose (`traffic.ts` HEAD_ON_STUCK_SEC): the pilot who must give way calls, again every 90 s, and Ground resolves it (pull aside / one eighty).
 *  - Seed 10, realism off: a GA departure was ready at the ramp for 27 minutes while eleven later departures took every free place at the hold of runway 22. A departure that has
 *    waited past the fairness bound (`DEPARTURE_WAIT_BOUND_SEC`) is served first (`ground.ts`, `overdueFirst`).
 */
import { describe, expect, it } from 'vitest';
import { runFreePlaySoak } from './freePlayHarness';
import { DEPARTURE_WAIT_BOUND_SEC } from './world';

/** The bar of the soak: no single wait of 20 minutes. */
const BAR_SEC = 1200;

describe('soak slices: ground gridlock and starvation', () => {
  it('seed 12, moderate: the student on progressive taxi departs, nobody stands nose to nose for good', () => {
    const r = runFreePlaySoak(12, 'moderate', 2);
    expect(r.maxWaitSec, r.maxWaitText).toBeLessThan(BAR_SEC);
    expect(r.longWaits.filter((w) => /N2276G/.test(w) && /still waiting/.test(w)), r.longWaits.slice(0, 4).join('; ')).toHaveLength(0);
    expect(r.stallDump).toBeUndefined();
    // (no call is asserted any more: with the Tower sequencing of this branch the departure order of the seed changed and the pair never meets nose to nose, which is the better
    // outcome; the stop-and-call mechanism itself is covered by sim/headOn.test.ts, and what this slice guards, a stand-off that nobody resolves, is the two waits above)
  }, 300000);
  it('seed 10, off: the GA departure that waited past the fairness bound at the ramp leaves inside the bar, and the departures that called after it did not take its place for 20 minutes', () => {
    const r = runFreePlaySoak(10, 'off', 2);
    expect(r.maxWaitSec, r.maxWaitText).toBeLessThan(BAR_SEC);
    expect(DEPARTURE_WAIT_BOUND_SEC).toBeLessThan(BAR_SEC);
    expect(r.stallDump).toBeUndefined();
  }, 300000);
});
