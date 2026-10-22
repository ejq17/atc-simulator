import { describe, expect, it } from 'vitest';
import { loadKphl } from '../airport';
import { selectRunwayConfiguration } from '../weather/runwayConfigurations';
import { game } from './game';
import { arrivalProcedure, ifrDestinationsFor, ifrFlightPlan } from './ifr';
import { profileFor, profileDestinations } from './airportProfile';
import { mulberry32 } from '../sim/rng';

const kphl = loadKphl();
const wx = (dir: number, kt: number) => ({ windDirDeg: dir, windSpeedKt: kt });

describe('KPHL scenario catalogue', () => {
  it('career and training lessons are authored for KACY only; free play is offered', () => {
    expect(new Set(game.listScenarios('KPHL').map((s) => s.mode))).toEqual(new Set(['free_play']));
    expect(() => game.buildScenario('career-01-first-radio', kphl, { seed: 1 })).toThrow(/authored for KACY only/);
  });

  it('every KPHL free-play scenario builds against the KPHL data, with runways and stands that exist there', () => {
    const ends = new Set(kphl.runways.flatMap((r) => r.ends.map((e) => e.id)));
    for (const s of game.listScenarios('KPHL')) {
      const sc = game.buildScenario(s.id, kphl, { seed: 3 });
      for (const r of [...sc.activeRunways.departing, ...sc.activeRunways.landing]) expect(ends.has(r), `${s.id} ${r}`).toBe(true);
      for (const sp of sc.spawns) if (sp.start.kind === 'parked') expect(kphl.parking.some((p) => p.id === (sp.start as { parkingId: string }).parkingId)).toBe(true);
    }
  });
});

describe('KPHL runway configuration by wind (documented west and east flow)', () => {
  it('a westerly wind selects west flow (arrivals 27R/27L/26/35), an easterly wind east flow (9R/9L/17)', () => {
    expect(selectRunwayConfiguration(kphl.runwayConfigurations, wx(270, 10), kphl)!.config.id).toBe('WEST');
    expect(selectRunwayConfiguration(kphl.runwayConfigurations, wx(300, 12), kphl)!.config.id).toBe('WEST');
    expect(selectRunwayConfiguration(kphl.runwayConfigurations, wx(90, 10), kphl)!.config.id).toBe('EAST');
    expect(selectRunwayConfiguration(kphl.runwayConfigurations, wx(0, 2), kphl)!.config.id).toBe('WEST'); // calm: the operator-preferred first
  });
});

describe('KPHL traffic and IFR defaults', () => {
  it('IFR arrivals fly the published ILS 27R / 9R / 17 fixes from the KPHL data', () => {
    expect(arrivalProcedure(kphl, '27R')).toMatchObject({ approachType: 'ILS', fafFix: 'JALTO' });
    expect(arrivalProcedure(kphl, '9L')?.approachType).toBe('ILS');
    expect(arrivalProcedure(kphl, '35')?.approachType).toBe('RNAV');
  });

  it('IFR departures file to airports the parser knows (the profile destinations), with no exit fix', () => {
    const dests = ifrDestinationsFor(kphl).map((d) => d.icao);
    expect(dests).toEqual(expect.arrayContaining(['KCLT', 'KORD', 'KDFW', 'KATL']));
    expect(dests).not.toContain('KPHL');
    expect(profileDestinations(profileFor('KPHL')).length).toBe(dests.length);
    const fp = ifrFlightPlan(kphl, mulberry32(5), 'A320');
    expect(fp.origin).toBe('KPHL');
    expect(fp.route).toEqual([]);
  });

  it('profile: Class B, vehicles only, every airline type exists in the performance model', async () => {
    const { getPerformance } = await import('../sim/performance');
    const p = profileFor('KPHL');
    expect(Object.keys(p.special ?? {})).toEqual(['vehicles']);
    for (const a of p.airlines) for (const t of a.types) expect(getPerformance(t).type, t).toBe(t);
  });
});
