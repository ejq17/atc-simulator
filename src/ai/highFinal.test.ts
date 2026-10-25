/**
 * Arrivals become established on final at or near the glidepath (JO 7110.65 5-9-1 / 5-9-2 / 4-8-1): Approach clears the approach only when the aircraft can be down by the final
 * approach fix (`CLEARANCE_HIGH_MARGIN_FT`), Tower sends an aircraft that is established far above the path round early (`earlyGoAroundReason`). 2 h all-AI runs, FREEPLAY_SOAK=1.
 */
import { describe, expect, it } from 'vitest';
import { loadKbos, loadKphl } from '../airport';
import { findRunwayEnd } from '../sim/runways';
import { glideAltitudeFt } from '../sim/flightDynamics';
import { dist } from '../sim/geo';
import { runFreePlaySoak } from './freePlayHarness';
import type { Airport } from '../sim/types';

const enabled = process.env.FREEPLAY_SOAK === '1';
/** Feet above the 3 degree path an IFR arrival may be when it becomes established on final (the task's bar; the pattern aircraft level off at 1,000 ft and are not counted). */
const BAND_FT = 300;
/** ... measured at this distance from the threshold (nm), inside which Tower sends an aircraft more than `HIGH_FINAL_BAND_FT` above the path around. */
const CHECK_NM = 4;

function run(airport: Airport, configIndex: number, hours: number): { worst: string[]; goArounds: number; established: number } {
  const c = airport.runwayConfigurations![configIndex];
  const seen = new Set<string>();
  const worst: string[] = [];
  let established = 0;
  const r = runFreePlaySoak(1, 'moderate', hours, {
    perSecond: (engine) => {
      for (const a of Object.values(engine.getState().aircraft)) {
        if (a.phase !== 'FINAL' || seen.has(a.id) || a.flightRules !== 'IFR') continue;
        const g = findRunwayEnd(airport, a.assignedRunwayEnd);
        // judged when it first stands inside CHECK_NM: farther out an aircraft established high can still get down (the engine descends 400 fpm over the path rate)
        if (!g || dist(a.pos, g.landingThreshold) > CHECK_NM * 1852) continue;
        seen.add(a.id);
        established++;
        const over = a.altitudeFt - glideAltitudeFt(g.elevationFt, dist(a.pos, g.landingThreshold));
        if (over > BAND_FT) worst.push(`${a.callsign} ${Math.round(over)} ft above the path at ${(dist(a.pos, g.landingThreshold) / 1852).toFixed(1)} nm`);
      }
    },
  }, { airport, activeRunways: { landing: c.landing, departing: c.departing } });
  return { worst, goArounds: r.goArounds, established };
}

describe.skipIf(!enabled)('IFR arrivals are established on final within the band of the glidepath (2 h, all AI)', () => {
  for (const [name, load, idx] of [['KBOS NE', loadKbos, 0], ['KPHL WEST', loadKphl, 0]] as const) {
    it(name, () => {
      const r = run(load(), idx, 2);
      console.log(`${name}: ${r.established} IFR arrivals established, ${r.goArounds} go-arounds, high: ${r.worst.join('; ') || 'none'}`);
      expect(r.worst).toEqual([]);
    }, 1800000);
  }
});
