/**
 * Release of a departure against an arrival on a parallel runway (EGLL W-ALT-27R seed 2: BAW473 lined up in 58 s instead of 22.5 s and lifted off with BAW275 still in its
 * flare on the parallel runway, 1.3 nm and 20 ft). A departure cleared from the hold line needs the late-start margin there; a lined-up one and the same-runway case do not.
 */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createHarness, IFR_DEP } from './testkit';
import { LINE_UP_LATE_MARGIN_SEC, neededEtaSec } from './tower';

describe('neededEtaSec against an arrival on a parallel runway', () => {
  it('adds the late line-up margin only for a departure cleared from the hold line', () => {
    const h = createHarness({ player: ['GND'], airport: loadKacy(), spawns: [IFR_DEP('NKS451', 'GATE-1', ['VCN'])] });
    const dep = Object.values(h.engine.getState().aircraft)[0];
    const kt = 140;
    const hold = neededEtaSec(dep, false, 'A320', kt, 0.76);
    const lined = neededEtaSec(dep, true, 'A320', kt, 0.76);
    expect(hold - lined).toBeGreaterThanOrEqual(LINE_UP_LATE_MARGIN_SEC - 1);
    // same runway (lateral 0): the categorical distance governs, no extra margin
    expect(neededEtaSec(dep, false, 'A320', kt, 0) - neededEtaSec(dep, true, 'A320', kt, 0)).toBeLessThan(LINE_UP_LATE_MARGIN_SEC);
  });
});
