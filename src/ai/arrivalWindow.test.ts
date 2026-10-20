/**
 * Runway windows of the landing sequence (ai/sequence.ts). `projectArrival` measures the distance to the threshold along the runway axis only: an arrival that is
 * still off the extended centreline was projected to cross the threshold "now" (soak seed 12: an A320 circling at 1,800 ft held a phantom window for 15 minutes).
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from '../sim/engine';
import { loadKacy } from '../airport';
import { findRunwayEnd } from '../sim/runways';
import { ARRIVING, find, makeScenario } from '../sim/__fixtures__/testHelpers';
import { arrivalWindow, LIGHT_OCCUPANCY_FLOOR_SEC, occupancySec } from './sequence';
import { nmToM } from '../sim/geo';

const kacy = loadKacy();
const g = findRunwayEnd(kacy, '22')!;
const eng = () => createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: ['22'], landing: ['22'] }, spawns: [ARRIVING('J1', '22', 6, 'A320', 'APP'), ARRIVING('C1', '22', 6, 'C172', 'TWR')] }) });

describe('arrival windows', () => {
  it('an arrival 6 nm off the extended centreline crosses the threshold no earlier than the straight distance at its own speed', () => {
    const e = eng();
    const a = find(e, 'J1');
    // abeam the threshold, 6 nm to the side of the runway
    a.pos = { x: g.end.threshold.x + g.dir.y * nmToM(6), y: g.end.threshold.y - g.dir.x * nmToM(6) };
    a.phase = 'APPROACH';
    a.groundSpeedKt = 150;
    const w = arrivalWindow(e.getState(), a, g);
    // 6 nm at no more than 1.15 x the approach speed of an A320 (135 kt) is at least 6 / 155 h = 139 s: not "now"
    expect(w.start).toBeGreaterThan(130);
    expect(w.end).toBeGreaterThan(w.start);
  });

  it('a light aircraft holds the runway at least LIGHT_OCCUPANCY_FLOOR_SEC in a window (the far exit of 4/22 takes 123-137 s)', () => {
    const e = eng();
    expect(occupancySec(e.getState(), find(e, 'C1'), g)).toBeGreaterThanOrEqual(LIGHT_OCCUPANCY_FLOOR_SEC);
  });
});
