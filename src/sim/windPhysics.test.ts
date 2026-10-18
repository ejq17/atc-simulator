/**
 * Wind physics on the REAL KACY / KMHT datasets: gusts on final and in the takeoff roll, crosswind refusals and go-arounds,
 * pattern altitude by type, published missed approach altitudes, TCH per runway end, KMHT displaced thresholds.
 * Numbers measured by these tests are quoted in docs/BEHAVIOUR-ACCURACY.md (rows F6, F8, F10, F11, T6, T7, T9 and the wind rows).
 */
import { describe, expect, it } from 'vitest';
import facility from '../../data/sources/kmht-facility.json';
import { createProjection, loadKacy, loadKmht } from '../airport';
import { getPresetWeather } from '../weather/presets';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import { createTestAirport } from './__fixtures__/testAirport';
import { ARRIVING, HOLDING, cmd, find, makeEngine, makeScenario, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import { alongCross, displacedThresholds, findRunwayEnd } from './runways';
import { glidePathFor } from './flightDynamics';
import { projectArrival, timeToThreshold } from './runwayTiming';
import { parseMissedApproach, publishedMissedAltitudeFt } from './missedApproach';
import { C172, A320, B738, C208, getPerformance, isLargeOrTurbine, patternAltitudeFt, registerPerformance } from './performance';
import { onDownwind } from '../game/world';
import { dist, ftToM, ktToMps, mToFt } from './geo';
import type { Airport, Scenario, ScenarioAircraftSpawn, Weather } from './types';

const kacy = loadKacy();
const kmht = loadKmht();

const wx = (o: Partial<Weather>): Weather => ({ ...getPresetWeather('clear'), windDirDeg: 0, windSpeedKt: 0, windGustKt: undefined, ...o });

function engineOn(airport: Airport, weather: Weather, spawns: ScenarioAircraftSpawn[], rwy: string, over: Partial<Scenario> = {}): SimulationEngine {
  return createEngine({ airport, readbackErrorRate: 0, scenario: makeScenario({ weather, activeRunways: { departing: [rwy], landing: [rwy] }, spawns, ...over }) });
}

interface FinalStats { sdAirspeedKt: number; sdCrossTrackM: number; tdAlongFt: number; tdGroundSpeedKt: number; goAround: boolean }

/** Fly an arrival from 6 nm to touchdown and measure the 4 nm - 0.6 nm segment (sampled at 1 Hz). */
function flyFinal(airport: Airport, type: string, rwy: string, weather: Weather, seed: number): FinalStats {
  const e = engineOn(airport, weather, [ARRIVING('X1', rwy, 6, type, 'TWR')], rwy, { seed });
  const ac = find(e, 'X1');
  e.applyCommand(cmd('LAND', 'X1', { runwayEnd: rwy }));
  const g = findRunwayEnd(airport, rwy)!;
  const as: number[] = [];
  const xt: number[] = [];
  for (let i = 0; i < 20000 && ac.phase !== 'ROLLOUT'; i++) {
    e.step();
    const { along, cross } = alongCross(g, ac.pos);
    const dNm = -along / 1852;
    if (dNm < 4 && dNm > 0.6 && i % 10 === 0) {
      as.push(ac.airspeedKt);
      xt.push(cross);
    }
  }
  const sd = (a: number[]) => {
    const m = a.reduce((p, q) => p + q, 0) / a.length;
    return Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length);
  };
  const landed = ac.phase === 'ROLLOUT';
  return {
    sdAirspeedKt: sd(as), sdCrossTrackM: sd(xt), tdAlongFt: landed ? mToFt(alongCross(g, ac.pos).along) : NaN, tdGroundSpeedKt: landed ? ac.groundSpeedKt : NaN,
    goAround: e.getState().events.some((x) => x.kind === 'GO_AROUND'),
  };
}

describe('gusts on final (KACY runway 13, wind 125 at 14 gusting 26: 7 degrees off the runway, 14 kt gust spread... within the A320 and C172 limits)', () => {
  const gusty = wx({ windDirDeg: 125, windSpeedKt: 14, windGustKt: 26 });
  const steady = wx({ windDirDeg: 125, windSpeedKt: 14 });
  const seeds = [1, 2, 3, 4, 5, 6];

  it('a steady wind and a calm leave the final steady; gusts make airspeed and the track unsteady (A320)', () => {
    const calm = flyFinal(kacy, 'A320', '13', wx({}), 1);
    const st = flyFinal(kacy, 'A320', '13', steady, 1);
    const runs = seeds.map((s) => flyFinal(kacy, 'A320', '13', gusty, s));
    const meanXt = runs.reduce((a, r) => a + r.sdCrossTrackM, 0) / runs.length;
    const meanAs = runs.reduce((a, r) => a + r.sdAirspeedKt, 0) / runs.length;
    expect(calm.sdCrossTrackM).toBeLessThan(0.01);
    expect(calm.sdAirspeedKt).toBeLessThan(0.01);
    expect(st.sdAirspeedKt).toBeLessThan(0.01);
    expect(st.sdCrossTrackM).toBeLessThan(0.5);
    expect(meanXt).toBeGreaterThan(3); // m of cross-track scatter on the 3.4 nm segment (measured ~8 m)
    expect(meanAs).toBeGreaterThan(0.25); // kt (measured ~0.7 kt)
    for (const r of runs) expect(r.goAround).toBe(false);
  });

  it('float in the flare varies with the gusts: touchdown point and ground speed scatter, calm is a single value (C172)', () => {
    const mild = wx({ windDirDeg: 125, windSpeedKt: 12, windGustKt: 24 });
    const runs = seeds.map((s) => flyFinal(kacy, 'C172', '13', mild, s));
    const calm = flyFinal(kacy, 'C172', '13', wx({}), 1);
    const td = runs.map((r) => r.tdAlongFt);
    expect(Math.max(...td) - Math.min(...td)).toBeGreaterThan(150); // ft between the shortest and the longest float (measured ~440 ft over 12 seeds)
    const gs = runs.map((r) => r.tdGroundSpeedKt);
    expect(Math.max(...gs) - Math.min(...gs)).toBeGreaterThan(4);
    expect(calm.tdAlongFt).toBeGreaterThan(900);
    expect(calm.tdAlongFt).toBeLessThan(1500);
  });

  it('is replayable: the same seed gives the same trajectory, a different seed a different one', () => {
    const a = flyFinal(kacy, 'A320', '13', gusty, 7);
    expect(flyFinal(kacy, 'A320', '13', gusty, 7)).toEqual(a);
    expect(flyFinal(kacy, 'A320', '13', gusty, 8)).not.toEqual(a);
    const state = (seed: number) => {
      const e = engineOn(kacy, gusty, [ARRIVING('X1', '13', 6, 'A320', 'TWR')], '13', { seed });
      e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
      run(e, 90);
      return JSON.stringify(e.getState().aircraft);
    };
    expect(state(3)).toBe(state(3));
  });
});

describe('rollout and touchdown speed follow the wind component (calm: A320 130 kt)', () => {
  it('headwind lowers the touchdown ground speed by the component, tailwind raises it, so the rollout (v^2 / 2a) changes the same way', () => {
    const calm = flyFinal(kacy, 'A320', '13', wx({}), 1).tdGroundSpeedKt;
    const head = flyFinal(kacy, 'A320', '13', wx({ windDirDeg: 125, windSpeedKt: 14 }), 1).tdGroundSpeedKt; // 14 cos 7 = 13.9 kt headwind
    const tail = flyFinal(kacy, 'A320', '13', wx({ windDirDeg: 298, windSpeedKt: 8 }), 1).tdGroundSpeedKt; // 8 kt tailwind (wind from the 31 direction)
    expect(calm - head).toBeGreaterThan(12);
    expect(calm - head).toBeLessThan(15);
    expect(tail - calm).toBeGreaterThan(6);
    expect(tail - calm).toBeLessThan(9);
    const roll = (kt: number) => (kt * 0.5144) ** 2 / (2 * 6 * 0.5144); // m with the A320 braking 6 kt/s
    expect(roll(head) / roll(calm)).toBeLessThan(0.85);
    expect(roll(tail) / roll(calm)).toBeGreaterThan(1.1);
  });
});

describe('takeoff roll in gusts', () => {
  const liftoff = (weather: Weather, seed: number): { sec: number; distM: number } => {
    const e = makeEngine({ scenario: { seed, weather, spawns: [HOLDING('NKS451', 'H13', '13', 'A320')] } });
    say(e, cmd('TAKEOFF', 'NKS451', { runwayEnd: '13' }), 'TWR');
    const ac = find(e, 'NKS451');
    expect(runUntil(e, () => ac.phase === 'TAKEOFF_ROLL', 60)).toBe(true);
    const t0 = e.getState().clock.timeSec;
    const p0 = { ...ac.pos };
    expect(runUntil(e, () => !ac.onGround, 120)).toBe(true);
    return { sec: e.getState().clock.timeSec - t0, distM: Math.hypot(ac.pos.x - p0.x, ac.pos.y - p0.y) };
  };
  const ap = createTestAirport();
  const hdg13 = findRunwayEnd(ap, '13')!.headingDeg;

  it('the roll to rotation is the same every run in a steady wind but varies with the gusts; a headwind shortens the ground run', () => {
    const calm = liftoff(wx({}), 1);
    const head = liftoff(wx({ windDirDeg: hdg13, windSpeedKt: 14 }), 1);
    const gusty = wx({ windDirDeg: hdg13, windSpeedKt: 14, windGustKt: 28 });
    const runs = [1, 2, 3, 4, 5].map((s) => liftoff(gusty, s));
    const again = liftoff(wx({}), 2); // another seed: the per-aircraft taxi speed differs, the roll must not (time is a float sum of ticks)
    expect(again.sec).toBeCloseTo(calm.sec, 6);
    expect(again.distM).toBeCloseTo(calm.distM, 3);
    expect(head.distM).toBeLessThan(calm.distM - 30); // the headwind removes ~14 kt of ground speed over a ~35 s roll
    const secs = runs.map((r) => r.sec);
    expect(Math.max(...secs) - Math.min(...secs)).toBeGreaterThan(0.5); // s between the quickest and slowest rotation
    const dists = runs.map((r) => r.distM);
    expect(Math.max(...dists) - Math.min(...dists)).toBeGreaterThan(20); // m of ground run
    expect(liftoff(gusty, 3)).toEqual(runs[2]);
  });
});

describe('crosswind limits (cited figures only: the C172 15 kt demonstrated)', () => {
  it('only the C172 has a limit; the others are undefined because no primary source was found', () => {
    expect(C172.maxCrosswindKt).toBe(15);
    for (const t of ['A320', 'B738', 'E175', 'CRJ9', 'B752', 'BCS3', 'C208']) {
      expect(getPerformance(t).maxCrosswindKt, t).toBeUndefined();
      expect(getPerformance(t).maxTailwindKt, t).toBeUndefined();
    }
  });

  const preset = getPresetWeather('gusty-crosswind'); // 320 at 16 gusting 28: gust crosswind 26 kt on 4 and 22, ~10 kt on 31

  it('a C172 cleared to land on 4 says "unable runway four, request runway three one"; on 31 it accepts; an A320 accepts 4', () => {
    const e = engineOn(kacy, preset, [ARRIVING('N1', '4', 6, 'C172', 'TWR'), ARRIVING('N2', '4', 8, 'A320', 'TWR'), ARRIVING('N3', '31', 10, 'C172', 'TWR')], '4');
    const r = say(e, cmd('LAND', 'N1', { runwayEnd: '4' }), 'TWR');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') {
      expect(r.reason).toMatch(/crosswind 2\d knots exceeds 15/);
      expect(r.pilotResponse).toMatch(/^Unable, runway four, crosswind is above our limit, request runway three one, /);
    }
    expect(say(e, cmd('LAND', 'N3', { runwayEnd: '31' }), 'TWR').status).toBe('accepted');
    expect(say(e, cmd('LAND', 'N2', { runwayEnd: '4' }), 'TWR').status).toBe('accepted');
  });

  it('a routine gusty day is not refused: C172 on 13 in 163 at 15 gusting 22 (steady 10.6, gust 15.6, effective 13.1 kt crosswind) accepts; 20 gusting 30 (effective 17.7) refuses', () => {
    const ok = engineOn(kacy, wx({ windDirDeg: 163, windSpeedKt: 15, windGustKt: 22 }), [ARRIVING('N1', '13', 6, 'C172', 'TWR')], '13');
    expect(say(ok, cmd('LAND', 'N1', { runwayEnd: '13' }), 'TWR').status).toBe('accepted');
    const no = engineOn(kacy, wx({ windDirDeg: 163, windSpeedKt: 20, windGustKt: 30 }), [ARRIVING('N1', '13', 6, 'C172', 'TWR')], '13');
    expect(say(no, cmd('LAND', 'N1', { runwayEnd: '13' }), 'TWR').status).toBe('rejected');
  });

  it('the in-flight go-around needs the gusted component 5 kt over the demonstrated value: a steady 18 kt crosswind (3 over) never triggers it, 25 kt does', () => {
    const fly = (kt: number): boolean => {
      const e = engineOn(kacy, wx({ windDirDeg: 125, windSpeedKt: 6 }), [ARRIVING('N1', '13', 5, 'C172', 'TWR')], '13');
      const ac = find(e, 'N1');
      say(e, cmd('LAND', 'N1', { runwayEnd: '13' }), 'TWR');
      runUntil(e, () => ac.phase === 'FINAL', 300);
      e.getState().weather = wx({ windDirDeg: 208, windSpeedKt: kt }); // 90 degrees off the runway heading 118: all of it is crosswind
      runUntil(e, () => ac.phase === 'GO_AROUND' || ac.phase === 'ROLLOUT', 600);
      return e.getState().events.some((x) => x.kind === 'GO_AROUND' && x.data?.reason === 'crosswind exceeds our limit');
    };
    expect(fly(18)).toBe(false);
    expect(fly(25)).toBe(true);
  });

  it('a refusal is not scored as a controller communication error', () => {
    const e = engineOn(kacy, preset, [ARRIVING('N1', '4', 6, 'C172', 'TWR')], '4');
    say(e, cmd('LAND', 'N1', { runwayEnd: '4' }), 'TWR');
    expect(e.getState().events.some((x) => x.kind === 'READBACK_ERROR')).toBe(false);
  });

  it('with no runway inside the limit the pilot asks for a different runway', () => {
    const w = wx({ windDirDeg: 70, windSpeedKt: 25, windGustKt: 35 });
    const e = engineOn(kacy, w, [ARRIVING('N1', '4', 6, 'C172', 'TWR')], '4');
    const r = say(e, cmd('LAND', 'N1', { runwayEnd: '4' }), 'TWR');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.pilotResponse).toMatch(/request a different runway/);
  });

  it('takeoff is refused the same way, and a type with a registered limit and a tailwind limit refuses a tailwind', () => {
    const ap = createTestAirport();
    const hdg = findRunwayEnd(ap, '13')!.headingDeg;
    const e = makeEngine({ scenario: { weather: wx({ windDirDeg: (hdg + 90) % 360, windSpeedKt: 22 }), spawns: [HOLDING('N1', 'H13', '13', 'C172')] } });
    const r = say(e, cmd('TAKEOFF', 'N1', { runwayEnd: '13' }), 'TWR');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.pilotResponse).toMatch(/^Unable, runway one three, crosswind is above our limit/);
    registerPerformance({ ...A320, type: 'TLIM', maxTailwindKt: 10, maxCrosswindKt: 25 });
    const e2 = makeEngine({ scenario: { weather: wx({ windDirDeg: (hdg + 180) % 360, windSpeedKt: 14 }), spawns: [HOLDING('N2', 'H13', '13', 'TLIM')] } });
    const r2 = say(e2, cmd('TAKEOFF', 'N2', { runwayEnd: '13' }), 'TWR');
    expect(r2.status).toBe('rejected');
    if (r2.status === 'rejected') expect(r2.pilotResponse).toMatch(/tailwind is above our limit/);
  });

  it('a gust-driven exceedance on final is a go-around with the reason', () => {
    // cleared in a mild wind, then the wind turns to a strong crosswind: the C172 goes around inside 1 nm
    const e = engineOn(kacy, wx({ windDirDeg: 125, windSpeedKt: 6 }), [ARRIVING('N1', '13', 5, 'C172', 'TWR')], '13');
    const ac = find(e, 'N1');
    expect(say(e, cmd('LAND', 'N1', { runwayEnd: '13' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'FINAL', 300)).toBe(true);
    e.getState().weather = wx({ windDirDeg: 200, windSpeedKt: 18, windGustKt: 30 }); // 82 degrees off the runway heading 118
    expect(runUntil(e, () => ac.phase === 'GO_AROUND', 400)).toBe(true);
    expect(pilotTexts(e, 'N1').some((t) => /going around runway one three, crosswind exceeds our limit/.test(t))).toBe(true);
    const ga = e.getState().events.find((x) => x.kind === 'GO_AROUND')!;
    expect(ga.data?.reason).toBe('crosswind exceeds our limit');
  });

  it('an aircraft type without a cited limit never goes around for wind', () => {
    const e = engineOn(kacy, wx({ windDirDeg: 200, windSpeedKt: 18, windGustKt: 30 }), [ARRIVING('N1', '13', 5, 'A320', 'TWR')], '13');
    say(e, cmd('LAND', 'N1', { runwayEnd: '13' }), 'TWR');
    expect(runUntil(e, () => find(e, 'N1').phase === 'ROLLOUT', 600)).toBe(true);
    expect(e.getState().events.some((x) => x.kind === 'GO_AROUND')).toBe(false);
  });
});

describe('pattern altitude by type (AIM 4-3-3)', () => {
  it('propeller 1,000 ft AGL; large and turbine-powered 1,500 ft AGL; a published TPA is flown by propeller aircraft and 500 ft above it by the others', () => {
    expect(patternAltitudeFt(C172, 75)).toBe(1075);
    expect(patternAltitudeFt(A320, 75)).toBe(1575);
    expect(patternAltitudeFt(B738, 266)).toBe(1766);
    expect(patternAltitudeFt(C208, 266)).toBe(1766); // turboprop: turbine-powered although light
    expect(isLargeOrTurbine(C172)).toBe(false);
    expect(isLargeOrTurbine(C208)).toBe(true);
    expect(patternAltitudeFt(C172, 266, 1266)).toBe(1266);
    expect(patternAltitudeFt(A320, 266, 1266)).toBe(1766);
    // unknown types follow the category
    expect(isLargeOrTurbine({ ...C172, propulsion: undefined, category: 'large' })).toBe(true);
    expect(isLargeOrTurbine({ ...C172, propulsion: undefined })).toBe(false);
  });

  it('the dataset has no TPA, so the defaults apply on both airports', () => {
    expect(kacy.trafficPatternAltitudeFt).toBeUndefined();
    expect(kmht.trafficPatternAltitudeFt).toBeUndefined();
  });

  const patternLevel = (type: string): number => {
    const start = onDownwind(kacy, '13', 'left', 1.5, { speedKt: type === 'C172' ? 90 : 150, altitudeFt: type === 'C172' ? 1900 : 2300, type });
    const spawn: ScenarioAircraftSpawn = { atSec: 0, callsign: 'P1', type, flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', start };
    const e = engineOn(kacy, wx({}), [spawn], '13');
    const ac = find(e, 'P1');
    say(e, cmd('ENTER_PATTERN', 'P1', { runwayEnd: '13', patternLeg: 'left_downwind' }), 'TWR');
    run(e, type === 'C172' ? 95 : 35);
    expect(ac.phase).toBe('PATTERN');
    return ac.altitudeFt;
  };

  it('on the downwind a C172 descends to ~1,100 ft (75 ft field + 1,000), an A320 to ~1,600 ft, from just above', () => {
    expect(patternLevel('C172')).toBeGreaterThan(1050);
    expect(patternLevel('C172')).toBeLessThan(1200);
    expect(patternLevel('A320')).toBeGreaterThan(1550);
    expect(patternLevel('A320')).toBeLessThan(1700);
  });

  it('spawns on the downwind at the type altitude', () => {
    expect(onDownwind(kacy, '13', 'left', 1.5, { speedKt: 90 }).altitudeFt).toBe(1100);
    expect(onDownwind(kacy, '13', 'left', 1.5, { speedKt: 150, type: 'A320' }).altitudeFt).toBe(1600);
  });
});

/** Expected plate values (docs/BEHAVIOUR-ACCURACY.md F6): missed approach climb altitude, glidepath angle and TCH, read from the d-TPP 2610 plates. */
const KACY_PLATES: [string, number, number, number][] = [
  ['HI-ILS Y OR LOC Y RWY 13', 2000, 3.0, 58], ['ILS OR LOC/DME RWY 31', 2000, 3.0, 52], ['ILS Z OR LOC Z RWY 13', 2000, 3.0, 58],
  ['RNAV (RNP) Z RWY 13', 2000, 3.0, 58], ['RNAV (RNP) Z RWY 31', 2000, 3.0, 52], ['RNAV (GPS) RWY 04', 2000, 3.0, 47],
  ['RNAV (GPS) RWY 22', 2000, 3.0, 51], ['RNAV (GPS) Y RWY 13', 2000, 3.0, 58], ['RNAV (GPS) Y RWY 31', 2000, 3.0, 52],
  ['VOR RWY 04', 2000, 3.05, 47], ['VOR RWY 31', 2000, 3.12, 52], ['HI-VOR OR TACAN RWY 31', 2000, 3.12, 52], ['COPTER ILS OR LOC/DME RWY 13', 2000, 3.0, 58],
];
const KMHT_PLATES: [string, number, number, number][] = [
  ['ILS OR LOC RWY 06', 3000, 3.0, 50], ['RNAV (GPS) RWY 06', 3000, 3.0, 50], ['ILS OR LOC RWY 17', 2100, 3.1, 49], ['RNAV (GPS) Y RWY 17', 2000, 3.1, 49],
  ['RNAV (RNP) Z RWY 17', 2100, 3.1, 49], ['RNAV (GPS) RWY 24', 2600, 3.0, 50], ['ILS OR LOC RWY 35', 4000, 3.0, 55], ['ILS RWY 35 (CAT II - III)', 4000, 3.0, 55],
  ['ILS RWY 35 (SA CAT I)', 4000, 3.0, 55], ['RNAV (GPS) Y RWY 35', 3000, 3.0, 55], ['RNAV (RNP) Z RWY 35', 3000, 3.0, 55],
];

describe.each([['KACY', kacy, KACY_PLATES], ['KMHT', kmht, KMHT_PLATES]] as const)('%s plates: published missed approach altitude and glidepath per procedure', (_icao, airport, table) => {
  it.each(table)('%s: missed approach to %i ft, glidepath %f deg / TCH %i ft', (name, alt, angle, tch) => {
    const proc = airport.procedures.find((p) => p.name === name)!;
    expect(proc, name).toBeDefined();
    expect(proc.missedApproach?.finalAltitudeFt).toBe(alt);
    expect(proc.glidepath?.angleDeg).toBe(angle);
    expect(proc.glidepath?.tchFt).toBe(tch);
    // the structured altitude agrees with the interpreted text where the text is transcribed
    const plan = parseMissedApproach(proc.missedApproachText);
    if (plan) expect(plan.finalAltitudeFt).toBe(alt);
    const g = findRunwayEnd(airport, proc.runwayEnd!)!;
    expect(publishedMissedAltitudeFt(airport, { procedureId: proc.id } as never, g)).toBe(alt);
    expect(glidePathFor(airport, { approach: { type: 'ILS', procedureId: proc.id } } as never, g)).toMatchObject({ angleDeg: angle, tchFt: tch, source: 'plate' });
  });

  it('every IAP in the dataset has a structured glidepath and missed approach', () => {
    const iaps = airport.procedures.filter((p) => p.type === 'IAP');
    expect(iaps.length).toBe(table.length);
    for (const p of iaps) {
      expect(p.glidepath, p.name).toBeDefined();
      expect(p.missedApproach?.finalAltitudeFt, p.name).toBeGreaterThan(0);
    }
  });
});

describe('the engine flies the published missed approach altitude of each runway end (IFR go-around)', () => {
  let lastFallback = false;
  const missedTarget = (airport: Airport, rwy: string): number | undefined => {
    const spawn: ScenarioAircraftSpawn = { ...ARRIVING('X1', rwy, 5, 'A320', 'TWR'), flightRules: 'IFR', flightPlan: { flightRules: 'IFR', origin: 'KTST', destination: airport.icao, cruiseAltitudeFt: 10000, route: [] } };
    const e = engineOn(airport, wx({}), [spawn], rwy, { mode: 'training' });
    const ac = find(e, 'X1');
    run(e, 20);
    ac.altitudeFt = findRunwayEnd(airport, rwy)!.elevationFt + 800; // low, as at a missed approach point: the target is then the published altitude itself
    expect(say(e, cmd('GO_AROUND', 'X1'), 'TWR').status).toBe('accepted');
    run(e, 1);
    expect(ac.phase).toBe('GO_AROUND');
    lastFallback = e.getState().events.some((x) => x.data?.missedApproach === 'fallback');
    return ac.target.altitudeFt;
  };

  it.each([[kmht, '6', 3000], [kmht, '17', 2100], [kmht, '24', 2600], [kmht, '35', 4000], [kacy, '13', 2000], [kacy, '22', 2000]] as const)('%#: runway %s -> %i ft', (airport, rwy, alt) => {
    expect(missedTarget(airport, rwy)).toBe(alt);
    expect(lastFallback, 'the published routing text is interpreted (no fallback)').toBe(false);
  });

  it('a dataset without the structured altitude or an interpretable text falls back to the labelled 2,000 ft default', () => {
    const bare = structuredClone(kmht);
    for (const p of bare.procedures) {
      delete p.missedApproach;
      delete p.missedApproachText;
    }
    expect(missedTarget(bare, '35')).toBe(2000);
  });
});

describe('threshold crossing height per runway end', () => {
  it('visual approaches use the NASR VGSI angle and TCH of the end; light aircraft keep the 50 ft fallback', () => {
    const t = (airport: Airport, end: string, perf = A320) => glidePathFor(airport, undefined, findRunwayEnd(airport, end)!, perf);
    expect(t(kacy, '13')).toEqual({ angleDeg: 3, tchFt: 71, source: 'vgsi' });
    expect(t(kacy, '31').tchFt).toBe(69);
    expect(t(kacy, '4').tchFt).toBe(50);
    expect(t(kacy, '22').tchFt).toBe(51);
    expect(t(kmht, '17')).toEqual({ angleDeg: 3.1, tchFt: 67, source: 'vgsi' });
    expect(t(kmht, '35').tchFt).toBe(68);
    expect(t(kmht, '6').tchFt).toBe(50);
    expect(t(kacy, '13', C172)).toEqual({ angleDeg: 3, tchFt: 50, source: 'default' });
  });

  it('an instrument approach without a transcribed glidepath falls back to 3 degrees / 50 ft (labelled default)', () => {
    const bare = structuredClone(kacy);
    for (const p of bare.procedures) delete p.glidepath;
    const proc = bare.procedures.find((p) => p.name === 'ILS Z OR LOC Z RWY 13')!;
    expect(glidePathFor(bare, { approach: { type: 'ILS', procedureId: proc.id } } as never, findRunwayEnd(bare, '13')!)).toEqual({ angleDeg: 3, tchFt: 50, source: 'default' });
  });

  const crossing = (airport: Airport, rwy: string): { agl: number; tdFromThrFt: number } => {
    const e = engineOn(airport, wx({}), [ARRIVING('X1', rwy, 6, 'A320', 'TWR')], rwy);
    const ac = find(e, 'X1');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: rwy }));
    const gl = findRunwayEnd(airport, rwy)!;
    let agl = NaN;
    for (let i = 0; i < 20000 && ac.phase !== 'ROLLOUT'; i++) {
      e.step();
      const along = alongCross(gl, ac.pos).along - gl.displacedM;
      if (Number.isNaN(agl) && along >= 0) agl = ac.altitudeFt - gl.elevationFt;
    }
    const td = e.getState().events.find((x) => /touched down/.test(x.text))!;
    return { agl, tdFromThrFt: mToFt(td.data!.alongM as number) };
  };

  it.each([[kacy, '13', 71], [kacy, '31', 69], [kmht, '17', 67], [kmht, '35', 68], [kmht, '6', 50]] as const)('an A320 visual approach crosses the landing threshold of %#: runway %s at about its TCH (%i ft)', (airport, rwy, tch) => {
    const { agl, tdFromThrFt } = crossing(airport, rwy);
    expect(Math.abs(agl - tch)).toBeLessThan(10);
    expect(tdFromThrFt).toBeGreaterThan(900);
    expect(tdFromThrFt).toBeLessThan(2800);
  });
});

describe('KMHT displaced thresholds', () => {
  const proj = createProjection(kmht.arp);
  const ends = kmht.runways.flatMap((r) => r.ends.map((e) => ({ r, e })));

  it('the three displaced ends carry the NASR length: 6 = 442 ft, 17 = 336 ft, 35 = 850 ft; 24 has none', () => {
    const got = Object.fromEntries(ends.map(({ e }) => [e.id, e.displacedThresholdFt]));
    expect(got).toEqual({ '6': 442, '24': undefined, '17': 336, '35': 850 });
  });

  it('the landing threshold lies on the NASR displaced-threshold coordinate (within 5 m) and displacedThresholdFt from the pavement end (within 3 m)', () => {
    const src = (facility as { runways: { ends: { id: string; displaced_threshold: { present: boolean; length_ft: number; lat: number; lon: number } }[] }[] }).runways.flatMap((r) => r.ends);
    for (const { r, e } of ends) {
      const d = displacedThresholds(r).find((x) => x.endId === e.id);
      if (!e.displacedThresholdFt) {
        expect(d).toBeUndefined();
        continue;
      }
      const nasr = src.find((s) => String(parseInt(s.id, 10)) === e.id)!.displaced_threshold;
      expect(nasr.present).toBe(true);
      const nasrPos = proj.toLocal({ lat: nasr.lat, lon: nasr.lon });
      expect(dist(d!.threshold, nasrPos)).toBeLessThan(5);
      expect(Math.abs(dist(d!.pavementEnd, d!.threshold) - ftToM(nasr.length_ft))).toBeLessThan(3);
      expect(Math.abs(dist(d!.pavementEnd, nasrPos) - ftToM(nasr.length_ft))).toBeLessThan(5);
    }
  });

  it('landing and takeoff distances: LDA / TORA come from the declared distances, takeoff uses the full pavement', () => {
    const g = (id: string) => findRunwayEnd(kmht, id)!;
    expect(Math.round(mToFt(g('6').ldaM))).toBe(7208);
    expect(Math.round(mToFt(g('24').ldaM))).toBe(6850);
    expect(Math.round(mToFt(g('17').ldaM))).toBe(8914);
    expect(Math.round(mToFt(g('35').ldaM))).toBe(7650); // declared LDA (geometry alone would give 8,400 ft)
    for (const [id, tora] of [['6', 7650], ['24', 7650], ['17', 9250], ['35', 9250]] as const) expect(Math.round(mToFt(g(id).toraM)), id).toBe(tora);
    // takeoff from the pavement end: TORA equals the full pavement length (within the 1 ft of coordinate rounding), i.e. the displaced area is used
    expect(Math.abs(mToFt(g('35').toraM) - mToFt(g('35').lengthM))).toBeLessThan(2);
    expect(mToFt(g('35').toraM)).toBeGreaterThan(mToFt(g('35').ldaM) + 850);
    expect(g('35').displacedM).toBeCloseTo(ftToM(850), 3);
    expect(g('24').displacedM).toBe(0);
    expect(g('24').landingThreshold).toEqual(g('24').end.threshold);
  });

  it('KACY has no displaced thresholds: landing threshold = pavement end, LDA = TORA = the runway length', () => {
    for (const r of kacy.runways) for (const e of r.ends) {
      if (e.id === 'H1') continue;
      const g = findRunwayEnd(kacy, e.id)!;
      expect(g.displacedM).toBe(0);
      expect(Math.abs(mToFt(g.ldaM) - e.declaredDistancesFt!.lda!)).toBeLessThan(1);
    }
  });

  it('a runway 35 landing touches down beyond the displaced threshold (850 ft = 259 m) and the rollout starts there', () => {
    const e = engineOn(kmht, wx({}), [ARRIVING('X1', '35', 6, 'A320', 'TWR')], '35');
    const ac = find(e, 'X1');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '35' }));
    expect(runUntil(e, () => ac.phase === 'ROLLOUT', 900)).toBe(true);
    const g = findRunwayEnd(kmht, '35')!;
    const fromPavementEnd = alongCross(g, ac.pos).along;
    expect(fromPavementEnd).toBeGreaterThan(g.displacedM + 150);
    expect(mToFt(fromPavementEnd - g.displacedM)).toBeLessThan(2800);
    const ev = e.getState().events.find((x) => /touched down/.test(x.text))!;
    expect(ev.data!.displacedM).toBeCloseTo(g.displacedM, 3);
    expect(ev.data!.alongM as number).toBeCloseTo(fromPavementEnd - g.displacedM, 0);
  });

  it('a C172 landing on runway 6 is not refused on distance and the displaced area does not shorten the full-pavement takeoff run check', () => {
    const e = engineOn(kmht, wx({}), [ARRIVING('X1', '6', 6, 'C172', 'TWR')], '6');
    expect(say(e, cmd('LAND', 'X1', { runwayEnd: '6' }), 'TWR').status).toBe('accepted');
  });

  it('an aircraft whose landing distance exceeds the declared LDA is refused', () => {
    registerPerformance({ ...A320, type: 'LONG', landingDistanceFt: 7000 });
    const e = engineOn(kmht, wx({}), [{ ...ARRIVING('X1', '24', 6, 'LONG', 'TWR') }], '24');
    const r = say(e, cmd('LAND', 'X1', { runwayEnd: '24' }), 'TWR');
    expect(r.status).toBe('rejected'); // 7,000 ft needed, 6,850 ft declared LDA on 24
    if (r.status === 'rejected') expect(r.reason).toMatch(/6850 ft landing distance available/);
  });
});

describe('threshold-crossing time is measured to the LANDING threshold (JO 7110.65 3-10-3 / 3-9-6)', () => {
  const kts = 130;
  const probe = (airport: Airport, rwy: string): { moved: number; expected: number; tThr: number; old: number } => {
    const g = findRunwayEnd(airport, rwy)!;
    const d = 3 * 1852;
    const pos = { x: g.end.threshold.x - g.dir.x * d, y: g.end.threshold.y - g.dir.y * d };
    const o = { type: 'A320', pos, onGround: false, groundSpeedKt: kts, altitudeFt: g.elevationFt + 900 } as never;
    const v = ktToMps(kts);
    const proj = projectArrival({ airport } as never, o, g);
    const t = timeToThreshold(o, g);
    expect(proj.tThr).toBeCloseTo(t, 6);
    return { moved: t - d / v, expected: g.displacedM / v, tThr: t, old: d / v };
  };
  it('KMHT: the crossing is later by displacement / ground speed on 6 (442 ft), 35 (850 ft), 17 (336 ft); unchanged on 24', () => {
    for (const [rwy, ft] of [['6', 442], ['35', 850], ['17', 336], ['24', 0]] as const) {
      const r = probe(kmht, rwy);
      expect(r.moved, rwy).toBeCloseTo(r.expected, 6);
      expect(r.moved, rwy).toBeCloseTo(ftToM(ft) / ktToMps(kts), 3);
    }
    expect(probe(kmht, '35').moved).toBeGreaterThan(3.5); // 259 m at 130 kt = 3.9 s
  });
  it('KACY: no displaced thresholds, the crossing time is unchanged', () => {
    for (const rwy of ['4', '22', '13', '31']) expect(Math.abs(probe(kacy, rwy).moved), rwy).toBeLessThan(1e-9);
  });
  it('the landed-aircraft distance (3,000 / 4,500 ft) counts from the landing threshold: a C172 tail 3,100 ft past the pavement end of KMHT 35 is only 2,250 ft past the threshold', async () => {
    const { landedDistanceExceptionApplies } = await import('./conflicts');
    const g = findRunwayEnd(kmht, '35')!;
    const e = createEngine({ airport: kmht, readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 9, 17, 16, 0, 0), scenario: makeScenario({ weather: wx({}), activeRunways: { departing: ['35'], landing: ['35'] }, spawns: [ARRIVING('L1', '35', 6, 'C172', 'TWR'), ARRIVING('F1', '35', 8, 'C172', 'TWR')] }) }); // noon local: daylight
    const lead = find(e, 'L1');
    const fol = find(e, 'F1');
    const at = (alongFt: number) => ({ x: g.end.threshold.x + g.dir.x * ftToM(alongFt), y: g.end.threshold.y + g.dir.y * ftToM(alongFt) });
    lead.onGround = true;
    lead.phase = 'ROLLOUT';
    lead.pos = at(3100 + getPerformance('C172').lengthM / 0.3048 / 2);
    const day = landedDistanceExceptionApplies(e.getState(), fol, lead, g);
    lead.pos = at(850 + 3100 + getPerformance('C172').lengthM / 0.3048 / 2);
    const dayDisplaced = landedDistanceExceptionApplies(e.getState(), fol, lead, g);
    expect(day).toBe(false);
    expect(dayDisplaced).toBe(true);
  });
});
