/**
 * An F-16 flight stopped on KACY runway 4 (session bug): the rollout figures, the exits that were not considered, and the ways the controller
 * can move an aircraft that is stopped on a runway (JO 7110.65 3-9-11 rejected takeoff, a landing with no reachable exit).
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import type { SimulationEngineExtras } from './engineExtras';
import { loadKacy } from '../airport';
import { ARRIVING, cmd, find, makeScenario, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import { alongCross, findRunwayEnd } from './runways';
import { ftToM, mToFt } from './geo';
import { getPerformance } from './performance';
import { stoppedExitOptionsFor } from './runwayStop';

const kacy = loadKacy();

function engineWith(type: string, end: string, size = 1): SimulationEngine {
  const e = createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: [end], landing: [end] }, spawns: [ARRIVING('X1', end, 4, type, 'TWR')] }) });
  if (size > 1) find(e, 'X1').formation = { size };
  return e;
}

/** Land X1 and run until it has left the rollout; returns where it ended. */
function landAndClear(e: SimulationEngine, end: string): { phase: string; alongFt: number; occupying: string[]; stoppedCall: boolean } {
  const ac = find(e, 'X1');
  e.applyCommand(cmd('LAND', 'X1', { runwayEnd: end }));
  runUntil(e, () => ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt < 0.2, 400);
  runUntil(e, () => ac.occupyingRunways.length === 0, 400);
  const g = findRunwayEnd(kacy, end)!;
  return { phase: ac.phase, alongFt: mToFt(alongCross(g, ac.pos).along), occupying: ac.occupyingRunways, stoppedCall: pilotTexts(e, 'X1').some((t) => /stopped on runway/.test(t)) };
}

describe('F-16 landing rollout on KACY (UNVERIFIED design figures: 140 kt touchdown, 5 kt/s)', () => {
  it('the figures: no exit of runway 4 before the intersection can be made at the normal or the maximum braking rate', () => {
    const p = getPerformance('F16');
    expect(p.touchdownSpeedKt).toBe(140);
    expect(p.decelKtPerSec).toBe(5);
    // taxiway B at 3,397 ft from a touchdown 1,640 ft down the runway: 1,757 ft to slow from 140 kt to under 30 kt needs about 8.9 kt/s, the limit is 5 x 1.4 = 7 kt/s
    const d = ftToM(3397 - 1640);
    const need = ((140 * 0.5144) ** 2 - (30 * 0.5144) ** 2) / (2 * d) / 0.5144;
    expect(need).toBeGreaterThan(7);
  });

  for (const end of ['4', '22', '13', '31']) {
    for (const size of [1, 2]) {
      it(`a ${size === 1 ? 'single F-16' : 'flight of two'} lands on runway ${end} and clears the runway at a taxiway (no stop on the runway)`, () => {
        const r = landAndClear(engineWith('F16', end, size), end);
        expect(r.occupying).toEqual([]);
        expect(r.phase).toBe('RUNWAY_EXIT');
        expect(r.stoppedCall).toBe(false);
      });
    }
  }

  it('runway 4: the turnoff taken is taxiway A at the 22 end (the exit hold line is not next to the runway node), past the intersection', () => {
    const e = engineWith('F16', '4', 2);
    const r = landAndClear(e, '4');
    expect(r.alongFt).toBeGreaterThan(6000);
    expect(find(e, 'X1').route!.nodeIds[0]).toBe('R4-22-05');
    expect(find(e, 'X1').route!.nodeIds.at(-1)).toBe('HP4-22-A-2');
  });

  it('never stops in the runway intersection: with every turnoff closed it rolls through 13/31 and stops clear of it', () => {
    const e = engineWith('F16', '4', 2);
    const x = e as unknown as SimulationEngineExtras;
    x.addClosure!({ kind: 'TAXIWAY', ident: 'A' }, 'scenario');
    x.addClosure!({ kind: 'TAXIWAY', ident: 'B' }, 'scenario');
    const ac = find(e, 'X1');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '4' }));
    runUntil(e, () => ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt < 0.1, 400);
    expect(ac.occupyingRunways).toEqual(['4/22']);
    expect(pilotTexts(e, 'X1').join(' | ')).not.toMatch(/never/);
    run(e, 20);
    expect(pilotTexts(e, 'X1').some((t) => /stopped on runway four, unable to exit, request taxi instructions/.test(t))).toBe(true);
  });
});

/** Place X1 stopped on the runway at `alongFt` (what the rollout leaves when nothing can be made). */
function stoppedAt(type: string, end: string, alongFt: number, size = 1): SimulationEngine {
  const e = engineWith(type, end, size);
  const ac = find(e, 'X1');
  const g = findRunwayEnd(kacy, end)!;
  ac.onGround = true;
  ac.altitudeFt = g.elevationFt;
  ac.pos = { x: g.end.threshold.x + g.dir.x * ftToM(alongFt), y: g.end.threshold.y + g.dir.y * ftToM(alongFt) };
  ac.headingDeg = g.headingDeg;
  ac.trackDeg = g.headingDeg;
  ac.groundSpeedKt = 0;
  ac.airspeedKt = 0;
  ac.assignedRunwayEnd = end;
  ac.phase = 'RUNWAY_EXIT';
  ac.route = undefined;
  ac.target = {};
  ac.nav = undefined;
  ac.runwayAuthorizations = ['4/22'];
  run(e, 1);
  return e;
}

describe('moving an aircraft that is stopped on the runway', () => {
  it('lists the turnoffs ahead, nearest first, and which intersecting runway the way crosses', () => {
    const e = stoppedAt('F16', '4', 3600, 2);
    const opts = stoppedExitOptionsFor(e.getState(), find(e, 'X1'));
    expect(opts.map((o) => o.taxiway)).toEqual(['A']);
    expect(opts[0].crosses).toEqual(['13/31']);
    expect(opts[0].holdNodeId).toBe('HP4-22-A-2');
  });

  it('"turn right on Alpha": the aircraft stops short of the intersection until it is cleared across runway 13, then taxis to the hold and clears runway 4', () => {
    const e = stoppedAt('F16', '4', 3600, 2);
    const ac = find(e, 'X1');
    const out = say(e, cmd('EXIT_RUNWAY', 'X1', { exitTaxiway: 'A', turnDirection: 'right' }), 'TWR');
    expect(out.status).toBe('accepted');
    run(e, 40);
    // held short of the 13/31 intersection (the safety net), still on runway 4
    expect(ac.occupyingRunways).toEqual(['4/22']);
    expect(mToFt(alongCross(findRunwayEnd(kacy, '4')!, ac.pos).along)).toBeLessThan(3830);
    expect(say(e, cmd('CROSS_RUNWAY', 'X1', { crossRunwayId: '13/31', runwayId: '13/31' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.occupyingRunways.length === 0, 200)).toBe(true);
    expect(runUntil(e, () => ac.route === undefined || ac.route.progressIndex >= ac.route.nodeIds.length, 200)).toBe(true);
  });

  it('"continue to the end": the last turnoff ahead', () => {
    const e = stoppedAt('C172', '4', 3000);
    const out = say(e, cmd('EXIT_RUNWAY', 'X1', { destination: 'END' }), 'TWR');
    expect(out.status).toBe('accepted');
    expect(find(e, 'X1').route!.nodeIds.at(-1)).toBe('HP4-22-A-2');
  });

  it('a TAXI with a destination and a route starts at the runway; the runway stays occupied until the aircraft is clear', () => {
    const e = stoppedAt('C172', '4', 3000);
    const ac = find(e, 'X1');
    const out = say(e, cmd('TAXI', 'X1', { destination: 'RAMP', route: ['B'] }), 'TWR');
    expect(out, JSON.stringify(out)).toMatchObject({ status: 'accepted' });
    expect(ac.phase).toBe('TAXI_TO_PARKING');
    run(e, 5);
    expect(ac.occupyingRunways).toEqual(['4/22']);
    expect(runUntil(e, () => ac.occupyingRunways.length === 0, 120)).toBe(true);
  });

  it('a rejected takeoff that stopped on the runway can be taxied off it', () => {
    const e = stoppedAt('C172', '4', 3000);
    const ac = find(e, 'X1');
    ac.phase = 'LINE_UP_AND_WAIT';
    ac.isDeparture = true;
    const out = say(e, cmd('TAXI', 'X1', { destination: 'RAMP', route: ['B'] }), 'TWR');
    expect(out.status).toBe('accepted');
    expect(ac.phase).toBe('TAXIING');
    expect(runUntil(e, () => ac.occupyingRunways.length === 0, 120)).toBe(true);
  });

  it('"cross runway 13" without a taxi route is refused as before when the aircraft is not stopped on a runway', () => {
    const e = engineWith('C172', '4');
    expect(say(e, cmd('CROSS_RUNWAY', 'X1', { crossRunwayId: '13/31', runwayId: '13/31' }), 'TWR').status).toBe('rejected');
  });
});

describe('the session flight: ANG92078, F-16 flight of two, overhead to runway 4', () => {
  it('breaks, is cleared to land and clears runway 4 (it used to stop in the 13/31 intersection and call "unable to exit")', () => {
    const e = createEngine({
      airport: kacy, readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 5, 1, 16),
      scenario: makeScenario({
        activeRunways: { departing: ['4'], landing: ['4'] }, controllerPositions: ['TWR', 'GND'], playerPositions: ['TWR', 'GND'],
        spawns: [{
          atSec: 0, callsign: 'ANG92078', type: 'F16', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
          start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 1600, headingDeg: 220, speedKt: 200, runwayEnd: '4', distanceNm: 8 },
          behavior: { kind: 'military', overhead: true, size: 2 },
        }],
      }),
    });
    const ac = find(e, 'ANG92078');
    expect(ac.formation?.size).toBe(2);
    const tpa = Math.round(getPerformance('F16').approachSpeedKt / 100) * 100;
    void tpa;
    say(e, cmd('OVERHEAD', 'ANG92078', { runwayEnd: '4', runwayId: '4/22', altitudeFt: 1600, destination: 'INITIAL' }), 'TWR');
    let landed = false;
    runUntil(e, () => {
      if (ac.flags.overhead === 'BROKE' && !landed) {
        landed = true;
        say(e, cmd('LAND', 'ANG92078', { runwayEnd: '4' }), 'TWR');
      }
      return ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt < 0.2;
    }, 1500);
    expect(landed).toBe(true);
    expect(ac.phase).toBe('RUNWAY_EXIT');
    expect(pilotTexts(e, 'ANG92078').some((t) => /unable to exit/.test(t))).toBe(false);
    expect(runUntil(e, () => ac.occupyingRunways.length === 0, 200)).toBe(true);
  });
});
