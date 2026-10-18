/** The session bugs through the player's transmit / landline pipeline (parse -> engine), on real KACY. */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../../airport';
import { createEngine } from '../../sim/engine';
import type { SimulationEngine } from '../../sim/api';
import type { ExtendedEngine } from '../../sim/engineExtras';
import { ftToM, mToFt } from '../../sim/geo';
import { alongCross, findRunwayEnd } from '../../sim/runways';
import { makeScenario, find, pilotTexts, run, runUntil } from '../../sim/__fixtures__/testHelpers';
import type { ScenarioAircraftSpawn } from '../../sim/types';
import { transmitLandline } from './landline';
import { transmit } from './transmit';

const kacy = loadKacy();

function engineWith(spawns: ScenarioAircraftSpawn[], player: ('GND' | 'TWR')[] = ['GND']): ExtendedEngine {
  return createEngine({
    airport: kacy, readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 9, 17, 16),
    scenario: makeScenario({ mode: 'free_play', controllerPositions: ['GND', 'TWR'], playerPositions: player, activeRunways: { departing: ['4'], landing: ['4'] }, spawns }),
  }) as ExtendedEngine;
}

const nks1033 = { atSec: 0, callsign: 'NKS1033', type: 'A320', flightRules: 'IFR' as const, isDeparture: false, initialFrequencyId: 'GND', start: { kind: 'parked' as const, parkingId: 'GATE-1' } };

describe('"Tower cross runway four at Bravo spirit 1033" spoken on the Ground frequency', () => {
  it('is never executed as a crossing clearance to the aircraft (it was, with a fighter landing)', () => {
    const e = engineWith([nks1033]);
    run(e, 2);
    const r = transmit({ engine: e, text: 'Tower cross runway four at Bravo spirit 1033', source: 'voice', controller: { positions: ['GND'] } });
    expect(r.results).toEqual([]);
    expect(r.summary).toBe('clarify');
    expect(r.message).toMatch(/landline call/);
    expect(find(e, 'NKS1033').runwayAuthorizations).toEqual([]);
    expect(e.getState().events.some((x) => x.kind === 'COMMAND_ACCEPTED' || x.kind === 'RUNWAY_INCURSION')).toBe(false);
  });
});

describe('landline from the one position the player works', () => {
  for (const say of [
    'Tower, cross runway four at Bravo with Spirit ten thirty three',
    'Tower, request to cross runway four at Bravo, Spirit ten thirty three',
    'Tower cross runway four at Bravo spirit 1033',
  ]) {
    it(say, () => {
      const e = engineWith([nks1033]);
      run(e, 2);
      const r = transmitLandline({ engine: e, text: say, source: 'voice', controller: { positions: ['GND'] } });
      expect(r.summary).toBe('done');
      expect(e.getState().coordination!.requests[0]).toMatchObject({ topic: 'CROSSING', from: 'GND', to: 'TWR', runwayId: '4/22', point: 'B' });
    });
  }
  it('the clarification quotes what was heard', () => {
    const e = engineWith([nks1033]);
    const r = transmitLandline({ engine: e, text: 'banana split', source: 'voice', controller: { positions: ['GND'] } });
    expect(r.summary).toBe('clarify');
    expect(r.message).toContain('heard "banana split"');
  });
});

/** The session flight stopped on runway 4 short of the 13/31 intersection (what is left when it cannot make an exit). */
function strandedFighter(): SimulationEngine {
  const e = engineWith([{
    atSec: 0, callsign: 'ANG92078', type: 'F16', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
    start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 140, runwayEnd: '4', distanceNm: 4 },
  }], ['TWR']);
  const ac = find(e, 'ANG92078');
  ac.formation = { size: 2 };
  ac.spokenCallsign = 'Air Guard niner two zero seven eight flight of two';
  const g = findRunwayEnd(kacy, '4')!;
  ac.onGround = true;
  ac.altitudeFt = g.elevationFt;
  ac.pos = { x: g.end.threshold.x + g.dir.x * ftToM(3600), y: g.end.threshold.y + g.dir.y * ftToM(3600) };
  ac.headingDeg = g.headingDeg;
  ac.trackDeg = g.headingDeg;
  ac.groundSpeedKt = 0;
  ac.airspeedKt = 0;
  ac.assignedRunwayEnd = '4';
  ac.phase = 'RUNWAY_EXIT';
  ac.route = undefined;
  ac.target = {};
  ac.nav = undefined;
  ac.runwayAuthorizations = ['4/22'];
  run(e, 1);
  return e;
}

describe('the session fighter: the controller moves it', () => {
  it('"continue down runway 22, turn right on the Alpha" is accepted and the flight taxis to the intersection, where it holds', () => {
    const e = strandedFighter();
    const r = transmit({ engine: e, text: 'Air National Guard 92078, continue down runway 22, turn right on the Alpha.', source: 'voice', controller: { positions: ['TWR'] } });
    expect(r.summary).toBe('accepted');
    expect(r.commands.map((c) => c.kind)).toEqual(['EXIT_RUNWAY']);
    expect(pilotTexts(e, 'ANG92078').join(' | ')).not.toMatch(/Unable/);
    run(e, 40);
    const ac = find(e, 'ANG92078');
    expect(ac.occupyingRunways).toEqual(['4/22']);
    expect(mToFt(alongCross(findRunwayEnd(kacy, '4')!, ac.pos).along)).toBeLessThan(3830);
  });

  it('"cross runway 13 and turn right on alpha": the exit is issued first, then the crossing; the flight clears runway 4 and 13', () => {
    const e = strandedFighter();
    const r = transmit({ engine: e, text: 'Air Guard niner two zero seven eight flight of two, cross runway 13 and turn right on aplha', source: 'voice', controller: { positions: ['TWR'] } });
    expect(r.results.map((x) => [x.command.kind, x.outcome.status])).toEqual([['EXIT_RUNWAY', 'accepted'], ['CROSS_RUNWAY', 'accepted']]);
    const ac = find(e, 'ANG92078');
    expect(runUntil(e, () => ac.occupyingRunways.length === 0, 240)).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION' || x.kind === 'SEPARATION_VIOLATION')).toEqual([]);
  });

  it('a taxi with a route from the runway is accepted too ("taxi to the ramp via Bravo")', () => {
    const e = strandedFighter();
    const r = transmit({ engine: e, text: 'Air Guard niner two zero seven eight flight of two, taxi to the ramp via Bravo', source: 'voice', controller: { positions: ['TWR'] } });
    expect(r.summary).toBe('accepted');
    expect(find(e, 'ANG92078').phase).toBe('TAXI_TO_PARKING');
  });
});
