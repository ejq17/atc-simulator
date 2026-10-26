/**
 * Every runway surface an aircraft enters needs its own clearance, active or not (JO 7110.65 3-7-2, 3-7-5). Two soak failures at KBOS:
 *
 *  - NW flow (landing and departing 33L and 27, 4R/22L unused): twelve "on runway 4R/22L without a clearance" in two hours. The incursions were not taxi crossings
 *    (every taxi route holds short of 4R/22L and crosses on a clearance) but landers: the exits T on 15R/33L and K on 9/27 start inside the 4R/22L surface, so the
 *    lander turned off "into" the other runway. `runwayExits` no longer offers a turnoff whose runway node lies on another runway.
 *  - A B763 (book takeoff distance 2,899 m) was never given taxi instructions: Ground asked for 50 m on top, 33L leaves 2,945 m from its full-length entry.
 */
import { describe, expect, it } from 'vitest';
import { loadKbos, loadKphl, loadKacy, loadKmht, loadKpgd } from '../airport';
import { ftToM, pointInPolygon } from '../sim/geo';
import { runwayExits } from '../sim/flightDynamics';
import type { SimContext } from '../sim/context';
import { crossingRunways, findRunwayEnd } from '../sim/runways';
import { getPerformance } from '../sim/performance';
import type { Aircraft } from '../sim/types';
import { runFreePlaySoak } from './freePlayHarness';
import { planDeparture } from './world';

const kbos = loadKbos();

describe('runway exits never start on another runway', () => {
  for (const [name, ap] of [['KBOS', kbos], ['KPHL', loadKphl()], ['KACY', loadKacy()], ['KMHT', loadKmht()], ['KPGD', loadKpgd()]] as const) {
    it(`${name}: no turnoff node lies inside the surface of a crossing runway`, () => {
      const ctx = { state: { airport: ap } } as unknown as SimContext;
      const bad: string[] = [];
      for (const rw of ap.runways) for (const e of rw.ends) {
        const g = findRunwayEnd(ap, e.id)!;
        for (const row of runwayExits(ctx, g, true)) {
          const n = ap.taxiwayGraph.nodes[row.id];
          for (const o of crossingRunways(ap, rw.id)) if (pointInPolygon(n.pos, o.polygon)) bad.push(`${e.id} exit ${row.id} inside ${o.id}`);
        }
      }
      expect(bad).toEqual([]);
    });
  }

  it('KBOS: the exits T of 15R/33L and K of 9/27 that lie within 4R/22L are not offered', () => {
    const ctx = { state: { airport: kbos } } as unknown as SimContext;
    const ids = (end: string) => runwayExits(ctx, findRunwayEnd(kbos, end)!, true).map((r) => r.id);
    expect(ids('33L')).not.toContain('R15R-33L-07');
    expect(ids('27')).not.toContain('R9-27-02');
  });
});

describe('KBOS northwest flow (landing and departing 33L and 27), seed 1', () => {
  it('no landing turns off into the unused 4R/22L and no taxi route enters it without a clearance (first 20 simulated minutes)', () => {
    const r = runFreePlaySoak(1, 'moderate', 1 / 3, {}, { airport: kbos, activeRunways: { landing: ['33L', '27'], departing: ['33L', '27'] } });
    expect(r.incursions).toEqual([]);
  }, 300000);

  it('a B763 gets a departure plan although 33L leaves less than the book distance plus the planning margin', () => {
    const type = 'B763';
    const need = ftToM(getPerformance(type).takeoffDistanceFt);
    const g = findRunwayEnd(kbos, '33L')!;
    const gate = kbos.parking.find((p) => p.category !== 'military' && p.nodeId === 'AP003') ?? kbos.parking[0];
    const ac = { type, pos: gate.pos, headingDeg: 0, onGround: true, phase: 'READY', isDeparture: true, id: 'x' } as unknown as Aircraft;
    const plan = planDeparture(kbos, ac, ['33L', '27']);
    expect(plan, 'B763 has no plan').toBeDefined();
    expect(plan!.remainingM).toBeGreaterThanOrEqual(need);
    expect(g.lengthM).toBeGreaterThan(need);
  });
});
