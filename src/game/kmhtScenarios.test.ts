import { describe, expect, it } from 'vitest';
import { loadKacy, loadKmht } from '../airport';
import { preferredEndOrder } from '../weather/runwaySelection';
import { game } from './game';
import { arrivalProcedure, ifrDestinationsFor, ifrFlightPlan } from './ifr';
import { mulberry32 } from '../sim/rng';

const kmht = loadKmht();
const kacy = loadKacy();

describe('scenario catalogue per airport', () => {
  it('career and training lessons are authored for KACY only; free play is offered at every airport', () => {
    const at = (icao: string) => game.listScenarios(icao).map((s) => s.mode);
    expect(at('KACY')).toEqual(game.listScenarios().map((s) => s.mode));
    expect(new Set(at('KMHT'))).toEqual(new Set(['free_play']));
    expect(game.listScenarios('KMHT').length).toBeGreaterThanOrEqual(5);
    expect(() => game.buildScenario('career-01-first-radio', kmht, { seed: 1 })).toThrow(/authored for KACY only/);
  });

  it('every KMHT free-play scenario builds against the KMHT data, with runways that exist there', () => {
    const ends = new Set(kmht.runways.flatMap((r) => r.ends.map((e) => e.id)));
    for (const s of game.listScenarios('KMHT')) {
      const sc = game.buildScenario(s.id, kmht, { seed: 3 });
      for (const r of [...sc.activeRunways.departing, ...sc.activeRunways.landing]) expect(ends.has(r), `${s.id} ${r}`).toBe(true);
      for (const sp of sc.spawns) if (sp.start.kind === 'parked') expect(kmht.parking.some((p) => p.id === (sp.start as { parkingId: string }).parkingId)).toBe(true);
    }
  });
});

describe('airport-dependent defaults', () => {
  it('runway preference: KACY keeps its documented order; KMHT prefers the longest runway, ILS ends first', () => {
    expect(preferredEndOrder(kacy, 'low')).toEqual(['13', '31', '22', '4']);
    expect(preferredEndOrder(kacy, 'high')).toEqual(['31', '13', '22', '4']);
    expect(preferredEndOrder(kmht, 'low')).toEqual(['17', '35', '6', '24']);
    expect(preferredEndOrder(kmht, 'high')).toEqual(['35', '17', '6', '24']);
  });

  it('IFR arrivals fly the published ILS 35 / 17 / 6 fixes from the KMHT data', () => {
    expect(arrivalProcedure(kmht, '35')).toMatchObject({ approachType: 'ILS', fafFix: 'MNTIN' });
    expect(arrivalProcedure(kmht, '17')?.fafFix).toBeDefined();
    expect(arrivalProcedure(kmht, '6')?.approachType).toBe('ILS');
    expect(arrivalProcedure(kmht, '24')?.approachType).toBe('RNAV');
  });

  it('IFR departures from KMHT file to airports the parser knows, with no KACY exit fix', () => {
    expect(ifrDestinationsFor(kmht).map((d) => d.icao)).not.toContain('KBOS');
    const fp = ifrFlightPlan(kmht, mulberry32(5), 'A320');
    expect(fp.origin).toBe('KMHT');
    expect(fp.route).toEqual([]);
    expect(ifrFlightPlan(kacy, mulberry32(5), 'A320').route.length).toBe(1);
  });
});
