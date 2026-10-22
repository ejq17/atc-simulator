/**
 * Departure-departure separation in the climb-out, synthetic multi-runway fixture. A faster departure that follows a slower one off the same runway, or off the
 * parallel runway 4,003 ft away, would overtake it inside the engine's near-miss alert (1.5 nm and 500 ft); the Tower holds it or gives it a diverging departure
 * heading (JO 7110.65 3-9-6, 5-8-2, 5-8-3, `airbornePath.ts`).
 */
import { describe, expect, it } from 'vitest';
import { createMultiRunwayAirport } from '../sim/__fixtures__/multiRunwayAirport';
import { HOLDING } from '../sim/__fixtures__/testHelpers';
import { ALL, createHarness } from './testkit';
import type { Harness } from './testkit';
import { departureInstruction } from './tower';
import { departureProjectedConflict } from './airbornePath';
import { findRunwayEnd } from '../sim/runways';
import type { ScenarioAircraftSpawn } from '../sim/types';

const airport = createMultiRunwayAirport();
const jet = (callsign: string, nodeId: string, runwayEnd: string, atSec = 0): ScenarioAircraftSpawn => ({ ...HOLDING(callsign, nodeId, runwayEnd, 'A320'), atSec });
const light = (callsign: string, nodeId: string, runwayEnd: string, atSec = 0): ScenarioAircraftSpawn => ({ ...HOLDING(callsign, nodeId, runwayEnd, 'C172'), atSec });

const takeoffAt = (h: Harness, callsign: string) => h.outcomes.find((o) => o.cmd.kind === 'TAKEOFF' && o.cmd.callsign === callsign && o.out.status === 'accepted');
const alerts = (h: Harness) => h.events.filter((e) => e.kind === 'SEPARATION_VIOLATION' || e.kind === 'RUNWAY_INCURSION' || e.kind === 'CONFLICT');

function flightOf(config: { departing: string[]; landing: string[] }, spawns: ScenarioAircraftSpawn[], seconds: number): Harness {
  const h = createHarness({ airport, player: [], ai: ALL, mode: 'free_play', activeRunways: config, readbackErrorRate: 0, spawns });
  h.run(seconds);
  return h;
}

describe('a faster departure behind a slower one on the same runway', () => {
  // The Cessna leaves the intersection at x = 700, the airliner the full-length hold 700 m behind it.
  const h = flightOf({ departing: ['27L'], landing: ['27R'] }, [light('N88LT', 'HSE1', '27L'), jet('NKS200', 'HSE2', '27L', 4)], 420);

  it('both depart and no near-miss alert, conflict or incursion is raised', () => {
    expect(takeoffAt(h, 'N88LT')).toBeDefined();
    expect(takeoffAt(h, 'NKS200')).toBeDefined();
    expect(alerts(h).map((e) => e.text)).toEqual([]);
  });

  it('the airliner is released with a diverging departure heading (15 degrees or more) or after the Cessna is well out of the way', () => {
    const first = takeoffAt(h, 'N88LT')!;
    const second = takeoffAt(h, 'NKS200')!;
    const diverging = second.cmd.departureHeading !== undefined && Math.abs(((second.cmd.departureHeading - 270 + 540) % 360) - 180) >= 15;
    expect(diverging || second.timeSec - first.timeSec >= 150).toBe(true);
  });
});

describe('departures from the two parallel runways 4,003 ft apart', () => {
  const h = flightOf({ departing: ['27L', '27R'], landing: ['27L'] }, [light('N31PA', 'HNE2', '27R'), jet('NKS300', 'HSE2', '27L', 4)], 420);

  it('both depart and the airliner never comes within the near-miss alert of the Cessna in front of it', () => {
    expect(takeoffAt(h, 'N31PA')).toBeDefined();
    expect(takeoffAt(h, 'NKS300')).toBeDefined();
    expect(alerts(h).map((e) => e.text)).toEqual([]);
  });
});

describe('the projection that decides the release', () => {
  // The Cessna is airborne from the full-length hold; an airliner stands at the hold of the parallel runway.
  const h = createHarness({ airport, player: [], ai: ALL.filter((p) => p !== 'TWR'), mode: 'free_play', activeRunways: { departing: ['27L', '27R'], landing: ['27L'] }, readbackErrorRate: 0, spawns: [light('N31PA', 'HNE2', '27R'), jet('NKS300', 'HSE2', '27L')] });
  // (no AI Tower here: the test clears the Cessna itself and looks at the airliner's projection)
  h.run(12);
  h.say('TWR', { kind: 'TAKEOFF', callsign: 'N31PA', confidence: 1, rawText: 'x', normalizedText: 'x', issues: [], runwayEnd: '27R', runwayId: '9L/27R' });
  h.runUntil(() => !h.find('N31PA')!.onGround, 120);
  h.run(6);
  const state = () => h.engine.getState();
  const airliner = () => h.find('NKS300')!;
  const gEnd = findRunwayEnd(airport, '27L')!;

  it('with the Cessna just airborne from the parallel runway the airliner on the runway heading touches the alert; a divergence away from it does not', () => {
    expect(h.find('N31PA')!.onGround).toBe(false);
    const straight = departureProjectedConflict(state(), airliner(), gEnd, false);
    expect(straight?.other.callsign).toBe('N31PA');
    expect(straight!.minNm).toBeLessThan(1.7);
    const inst = departureInstruction(state(), airport, airliner(), gEnd, false);
    expect(inst.blocked || inst.heading !== undefined).toBe(true);
  });

  it('many minutes later, with the Cessna far away, the airliner is released on the runway heading', () => {
    h.run(240);
    expect(departureProjectedConflict(state(), airliner(), gEnd, false)).toBeUndefined();
    expect(departureInstruction(state(), airport, airliner(), gEnd, false)).toEqual({ blocked: false });
  });
});
