/**
 * The arrival slot of the traffic generator's flow control (game/traffic.ts): 200 s between arrivals for one runway, longer while departures stand ready at
 * the hold (soak seeds 3 and 5: a departure waited 1,490 s at the 200 s slot because a lander that rolls to the far exit holds the runway about 130 s and a jet
 * needs 143 s behind a light arrival).
 */
import { describe, expect, it } from 'vitest';
import { ARRIVAL_SLOT_BASE_SEC, ARRIVAL_SLOT_PER_DEPARTURE_SEC, ARRIVAL_SLOT_SEC, arrivalSlotSec } from './traffic';
import { neededEtaSec } from '../ai/tower';
import type { Aircraft } from '../sim/types';

describe('arrival slot with departures waiting', () => {
  it('is 200 s with nobody waiting, and leaves the runway occupancy plus one departure window per waiting departure (at most three)', () => {
    expect(arrivalSlotSec(0)).toBe(ARRIVAL_SLOT_SEC);
    expect(arrivalSlotSec(1)).toBe(ARRIVAL_SLOT_BASE_SEC + ARRIVAL_SLOT_PER_DEPARTURE_SEC);
    expect(arrivalSlotSec(2)).toBeGreaterThan(arrivalSlotSec(1));
    expect(arrivalSlotSec(3)).toBe(arrivalSlotSec(9));
  });
  it('one departure window is at least what it needs behind a light arrival (the engine\'s neededEtaSec)', () => {
    const jet = { type: 'A320', id: 'd', callsign: 'D1' } as unknown as Aircraft;
    const need = neededEtaSec(jet, false, 'C172', 70);
    expect(ARRIVAL_SLOT_PER_DEPARTURE_SEC).toBeGreaterThanOrEqual(Math.floor(need));
  });
});
