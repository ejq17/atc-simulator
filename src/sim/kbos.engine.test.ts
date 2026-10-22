/**
 * Engine smoke test on the real KBOS dataset (six runways, several crossings): an airliner is taxied from a Terminal B gate to runway 27
 * across three runways, holds at every crossing and takes off; an A320 lands on 4R (ILS) and taxis to a gate; a ROBUC THREE arrival flies the
 * published route to GOSHI. Nothing in the engine, pathfinding or ground logic is silently two-runway only.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import { loadKbos } from '../airport';
import { ARRIVING, IFR_DEPARTURE, cmd, find, has, makeScenario, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import type { ScenarioAircraftSpawn } from './types';
import { starArrivalSpawn } from '../game/ifr';
import { mulberry32 } from './rng';
import { findNavFix } from './navigation';

const kbos = loadKbos();

function setup(spawns: ScenarioAircraftSpawn[], departing = ['27'], landing = ['4R'], positions: ('TWR' | 'GND' | 'APP' | 'DEP' | 'CLNC')[] = ['TWR', 'GND']) {
  return createEngine({ airport: kbos, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing, landing }, controllerPositions: positions, spawns }) });
}

describe('KBOS engine smoke', () => {
  it('departure: gate B30 to runway 27 across 4L/22R, 4R/22L and 15R/33L, then takeoff and climb-out', () => {
    const e = setup([{ ...IFR_DEPARTURE('JBU123', 'GATE-B30', [], {}), initialFrequencyId: 'GND' }]);
    const ac = find(e, 'JBU123');
    expect(say(e, cmd('TAXI', 'JBU123', { runwayEnd: '27' }), 'GND').status).toBe('accepted');
    expect(pilotTexts(e, 'JBU123')[0]).toMatch(/^Runway two seven, taxi, JetBlue one twenty three/);
    const crossed: string[] = [];
    for (let i = 0; i < 6; i++) {
      expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT', 900)).toBe(true);
      expect(runUntil(e, () => !!ac.pendingRequest, 60)).toBe(true);
      if (ac.pendingRequest!.kind !== 'CROSSING') break;
      const rw = /runway (\d+[LR]?\/\d+[LR]?)/.exec(ac.pendingRequest!.text)![1];
      crossed.push(rw);
      expect(say(e, cmd('CROSS_RUNWAY', 'JBU123', { crossRunwayId: rw }), 'GND').status).toBe('accepted');
      expect(runUntil(e, () => ac.phase === 'TAXIING', 30)).toBe(true);
    }
    expect(crossed).toEqual(['4L/22R', '4R/22L', '15R/33L']);
    expect(ac.route!.nodeIds.at(-1)).toBe('HP9-27-D-1');
    expect(say(e, cmd('CONTACT_FREQUENCY', 'JBU123', { frequencyId: 'TWR' }), 'GND').status).toBe('accepted');
    expect(runUntil(e, () => ac.frequencyId === 'TWR' && ac.pendingRequest?.kind === 'DEPARTURE', 60)).toBe(true);
    expect(pilotTexts(e, 'JBU123').some((t) => t.startsWith('Boston Tower, JetBlue one twenty three, holding short runway two seven, ready for departure'))).toBe(true);
    expect(say(e, cmd('TAKEOFF', 'JBU123', { runwayEnd: '27' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'TAKEOFF_ROLL', 120)).toBe(true);
    expect(runUntil(e, () => ac.phase === 'DEPARTURE' && ac.altitudeFt > kbos.elevationFt + 500, 300)).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION' || x.kind === 'CONFLICT')).toEqual([]);
  });

  it('departure to 4L: one runway-4R-side hold, no crossing needed from the terminal side', () => {
    const e = setup([{ ...IFR_DEPARTURE('JBU123', 'GATE-B30', [], {}), initialFrequencyId: 'GND' }], ['4L'], ['4R']);
    const ac = find(e, 'JBU123');
    expect(say(e, cmd('TAXI', 'JBU123', { runwayEnd: '4L' }), 'GND').status).toBe('accepted');
    expect(ac.route!.nodeIds.at(-1)).toMatch(/^HP4L-22R-/);
    expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT', 900)).toBe(true);
    expect(runUntil(e, () => !!ac.pendingRequest, 60)).toBe(true);
    expect(ac.pendingRequest!.kind).toBe('FREQUENCY_CHANGE');
    expect(pilotTexts(e, 'JBU123').at(-1)).toMatch(/holding short runway four left/);
  });

  it('arrival: A320 cleared to land on 4R rolls out, exits and taxis to a gate', () => {
    const e = setup([ARRIVING('NKS451', '4R', 6, 'A320', 'TWR')]);
    const ac = find(e, 'NKS451');
    expect(say(e, cmd('LAND', 'NKS451', { runwayEnd: '4R' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'ROLLOUT', 900)).toBe(true);
    expect(runUntil(e, () => ac.phase === 'RUNWAY_EXIT', 300)).toBe(true);
    expect(runUntil(e, () => ac.occupyingRunways.length === 0 && ac.groundSpeedKt < 0.5, 300)).toBe(true);
    expect(runUntil(e, () => pilotTexts(e, 'NKS451').some((t) => t.startsWith('Boston Tower, Spirit four fifty one, clear of runway four right')), 60)).toBe(true);
    expect(say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'GND' }), 'TWR').status).toBe('accepted');
    run(e, 30);
    expect(say(e, cmd('TAXI', 'NKS451', { destination: 'GATE-B30' }), 'GND').status).toBe('accepted');
    // the gate is on the other side of 15R/33L (and 15L/33R): the taxi stops at each runway until the crossing is cleared
    for (let i = 0; i < 6 && !(ac.phase === 'PARKED' || !has(e, 'NKS451')); i++) {
      runUntil(e, () => ac.phase === 'PARKED' || ac.pendingRequest?.kind === 'CROSSING', 900);
      if (ac.pendingRequest?.kind === 'CROSSING') {
        const rw = /runway (\d+[LR]?\/\d+[LR]?)/.exec(ac.pendingRequest.text)![1];
        expect(say(e, cmd('CROSS_RUNWAY', 'NKS451', { crossRunwayId: rw }), 'GND').status).toBe('accepted');
        expect(runUntil(e, () => ac.phase === 'TAXI_TO_PARKING', 30)).toBe(true);
      }
    }
    expect(runUntil(e, () => ac.phase === 'PARKED' || !has(e, 'NKS451'), 1200)).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION' || x.kind === 'CONFLICT')).toEqual([]);
  });

  it('STAR arrival: a ROBUC THREE flight over PROVI is on the published route to GOSHI, WINNI, NABBO, MILTT for runway 4R', () => {
    const spec = starArrivalSpawn(kbos, mulberry32(7), { callsign: 'DAL212', type: 'A321', runwayEnd: '4R', atSec: 0, entry: 'PROVI' })!;
    expect(spec.start.kind === 'at_fix' && spec.start.star?.procedureId).toBe('ROBUC-THREE-RNAV');
    expect(spec.start.kind === 'at_fix' && spec.start.route).toEqual(['PROVI', 'JOODY', 'SOFEE', 'ERNEI', 'GOSHI', 'WINNI', 'NABBO', 'MILTT']);
    expect(spec.start.kind === 'at_fix' && spec.start.altitudeFt).toBeGreaterThanOrEqual(11000);
    const e = setup([spec], ['4R'], ['4R'], ['APP', 'TWR', 'GND']);
    const ac = find(e, 'DAL212');
    const goshi = findNavFix(kbos, 'GOSHI')!.pos;
    const d0 = Math.hypot(ac.pos.x - goshi.x, ac.pos.y - goshi.y);
    run(e, 300);
    expect(Math.hypot(ac.pos.x - goshi.x, ac.pos.y - goshi.y)).toBeLessThan(d0 - 10000); // flying the route towards GOSHI
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION')).toEqual([]);
  });
});
