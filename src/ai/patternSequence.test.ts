/**
 * Free-play jam (docs/PROGRESS.md): the landing sequence and the pending requests behind it.
 */
import { describe, expect, it } from 'vitest';
import { createHarness, kacy } from './testkit';
import type { ScenarioAircraftSpawn } from '../sim/types';
import { findRunwayEnd } from '../sim/runways';
import { patternLeg, etaNormalSec, etaBaseNowSec } from './sequence';

const arrival = (callsign: string, distanceNm: number, type = 'C172'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type, flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
  start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 2500, headingDeg: 0, speedKt: 90, runwayEnd: '22', distanceNm },
});

describe('landing sequence for the pattern', () => {
  it('five light arrivals three miles apart all land, with at most two go-arounds and no airborne or runway safety event', () => {
    const h = createHarness({
      player: [], spawns: ['N1A', 'N2B', 'N3C', 'N4D', 'N5E'].map((c, i) => arrival(c, 8 + i * 3)),
      activeRunways: { departing: ['22'], landing: ['22'] }, seed: 11,
    });
    h.run(2400);
    const landed = Object.values(h.engine.getState().aircraft).filter((a) => ['ROLLOUT', 'RUNWAY_EXIT', 'TAXI_TO_PARKING', 'ARRIVED'].includes(a.phase)).length + h.events.filter((e) => e.kind === 'DESPAWN').length;
    expect(landed).toBe(5);
    expect(h.events.filter((e) => e.kind === 'GO_AROUND').length).toBeLessThanOrEqual(2);
    expect(h.events.filter((e) => (e.kind === 'SEPARATION_VIOLATION' && !/on the ground/.test(e.text)) || e.kind === 'RUNWAY_INCURSION').map((e) => `${e.timeSec} ${e.text}`)).toEqual([]);
  }, 120_000); // a 2400 s simulation with five arrivals: far longer than the 30 s default when several suites share the CPU

  it('pattern leg is read from heading and position, and the base-turn ETA is never later than the normal one once the aircraft is extended', () => {
    const g = findRunwayEnd(kacy, '22')!;
    const base = { id: 'x', callsign: 'N1', type: 'C172', groundSpeedKt: 70, onGround: false } as never;
    const along = (m: number, cross: number, hdg: number) => ({ ...(base as object), pos: { x: g.end.threshold.x + g.dir.x * m + g.dir.y * cross, y: g.end.threshold.y + g.dir.y * m - g.dir.x * cross }, headingDeg: hdg }) as never;
    const rwy = g.headingDeg;
    expect(patternLeg(along(900, 1480, (rwy + 180) % 360), g)).toBe('DOWNWIND');
    expect(patternLeg(along(-2000, 600, (rwy + 90) % 360), g)).toBe('BASE');
    expect(patternLeg(along(-3000, 0, rwy), g)).toBe('FINAL');
    const ext = along(-5000, 1480, (rwy + 180) % 360);
    expect(etaBaseNowSec(ext, g)).toBeLessThanOrEqual(etaNormalSec(ext, g) + 1);
  });
});

describe('a pilot who asked for the numbers is still waiting for his clearance', () => {
  it('the wind and altimeter answer does not clear the landing request', () => {
    const h = createHarness({
      player: [], ai: [], spawns: [arrival('N77Z', 6)], activeRunways: { departing: ['22'], landing: ['22'] }, seed: 5,
      pilotBehaviour: { noAtisFraction: 1, numbersRequestAfterSec: 5 },
    });
    expect(h.runUntil(() => h.find('N77Z')?.pendingRequest?.kind === 'OTHER', 120)).toBe(true);
    const ac = h.find('N77Z')!;
    h.say('TWR', { kind: 'AIRPORT_INFO', callsign: ac.callsign, confidence: 1, rawText: '', normalizedText: '', issues: [], info: { windSpeedKt: 4, windDirDeg: 130, altimeterInHg: 29.92 } });
    expect(h.find('N77Z')!.pendingRequest?.kind).toBe('LANDING');
  });
});
