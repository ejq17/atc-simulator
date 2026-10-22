import { describe, expect, it } from 'vitest';
import { loadKpgd } from '../airport';
import { preferredEndOrder } from '../weather/runwaySelection';
import { game } from './game';
import { arrivalProcedure, ifrDestinationsFor, ifrFlightPlan } from './ifr';
import { mulberry32 } from '../sim/rng';

const kpgd = loadKpgd();

describe('KPGD scenario catalogue and defaults', () => {
  it('only free play is offered, and every scenario builds against the KPGD data', () => {
    expect(new Set(game.listScenarios('KPGD').map((s) => s.mode))).toEqual(new Set(['free_play']));
    const ends = new Set(kpgd.runways.flatMap((r) => r.ends.map((e) => e.id)));
    for (const s of game.listScenarios('KPGD')) {
      const sc = game.buildScenario(s.id, kpgd, { seed: 3 });
      for (const r of [...sc.activeRunways.departing, ...sc.activeRunways.landing]) expect(ends.has(r), `${s.id} ${r}`).toBe(true);
      for (const sp of sc.spawns) if (sp.start.kind === 'parked') expect(kpgd.parking.some((p) => p.id === (sp.start as { parkingId: string }).parkingId)).toBe(true);
    }
  });

  it('runway preference puts the longer runway first; runway 4 has the only ILS, the others RNAV', () => {
    expect(preferredEndOrder(kpgd, 'low').slice(0, 2).sort()).toEqual(['22', '4']);
    expect(arrivalProcedure(kpgd, '4')).toMatchObject({ approachType: 'ILS', fafFix: 'CISTS' });
    for (const e of ['22', '15', '33']) expect(arrivalProcedure(kpgd, e)?.approachType, e).toBe('RNAV');
  });

  it('IFR departures file from KPGD to destinations of the Allegiant / Sun Country profile', () => {
    const icaos = ifrDestinationsFor(kpgd).map((d) => d.icao);
    expect(icaos).toContain('KMSP');
    expect(icaos).not.toContain('KBOS');
    const fp = ifrFlightPlan(kpgd, mulberry32(5), 'A320');
    expect(fp.origin).toBe('KPGD');
    expect(fp.route).toEqual([]);
  });
});
