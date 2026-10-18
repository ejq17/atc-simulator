/**
 * AI Ground re-routes an aircraft that stopped short of a taxiway that closed under its route (the pilot's "holding short of Papa, taxiway closed,
 * request taxi instructions"): a new taxi instruction around the closure, and the aircraft reaches the runway hold.
 */
import { describe, expect, it } from 'vitest';
import type { SimulationEngineExtras } from '../sim/engineExtras';
import { routeSegmentTaxiways } from '../sim/pathfinding';
import { createHarness, kacy } from './testkit';

describe('AI Ground and a taxiway closed under a routed departure', () => {
  it('re-routes it around the closure; it taxis on and holds short of the runway', () => {
    const h = createHarness({
      player: ['TWR'], activeRunways: { departing: ['13'], landing: ['13'] }, mode: 'free_play',
      spawns: [{ atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'GND', start: { kind: 'parked', parkingId: 'GA-2' } }],
    });
    const ac = () => h.find('N723EJ')!;
    // Ground issues the first taxi instruction (route L > N > M > P > B)
    expect(h.runUntil(() => !!ac().route && ac().groundSpeedKt > 5, 300)).toBe(true);
    const firstRoute = ac().route!.nodeIds.slice();
    const segs = routeSegmentTaxiways(kacy.taxiwayGraph, firstRoute).map((x) => x?.toUpperCase());
    expect(segs).toContain('P');
    h.run(10);
    (h.engine as unknown as SimulationEngineExtras).addClosure!({ kind: 'TAXIWAY', ident: 'P' }, 'scenario');
    // it stops, calls, and Ground answers
    expect(h.runUntil(() => h.pilotTexts('N723EJ').some((t) => /taxiway closed, request taxi instructions/.test(t)), 400)).toBe(true);
    expect(h.runUntil(() => h.outcomes.filter((o) => o.cmd.kind === 'TAXI').length >= 2, 120)).toBe(true);
    const reroute = h.outcomes.filter((o) => o.cmd.kind === 'TAXI').at(-1)!;
    expect(reroute.out.status).toBe('accepted');
    expect(ac().route!.taxiways.map((t) => t.toUpperCase())).not.toContain('P');
    expect(h.runUntil(() => ac().phase === 'HOLDING_SHORT' || ac().phase === 'TAKEOFF_ROLL' || ac().phase === 'CLEARED_FOR_TAKEOFF', 1500)).toBe(true);
    expect(h.events.filter((e) => ['RUNWAY_INCURSION', 'SEPARATION_VIOLATION'].includes(e.kind))).toEqual([]);
  }, 30000);
});
