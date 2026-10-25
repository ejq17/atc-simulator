import { describe, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { loadKbos, loadKpgd } from '../airport';
import { glideAltitudeFt, glidePathFor } from '../sim/flightDynamics';
import { alongCross, findRunwayEnd } from '../sim/runways';
import { getPerformance } from '../sim/performance';
import type { Airport } from '../sim/types';
import { runFreePlaySoak } from './freePlayHarness';

/**
 * Reproduction (opt-in, FREEPLAY_SOAK=1; FREEPLAY_REPORT_FILE=path appends): all-AI arrivals that become FINAL far above the glide path of their distance, and what
 * ended up happening to them. Cause found in the 2026-10-22 traffic-realism task: airline arrivals are IFR (STAR / procedure entry fix at 10,000-13,000 ft, 250 kt,
 * generated correctly by src/game/ifr.ts); the AI Approach vectors them onto final and they are established 1,000-1,700 ft high at 4-7 nm, where the engine's glide
 * capture (+400 fpm over the path rate, descent limit 1.3 x descent rate) cannot get them down, so the touchdown-zone guard sends them around. Visual-start arrivals
 * (`pickArrivalStart`) are on the path (src/game/arrivalGlidePath.test.ts).
 */
const enabled = process.env.FREEPLAY_SOAK === '1';

function run(label: string, airport: Airport, seed: number, hours: number, active?: { landing: string[]; departing: string[] }): void {
  const seen = new Set<string>();
  const lines: string[] = [];
  const r = runFreePlaySoak(seed, 'moderate', hours, {
    perSecond: (engine, _ai, now) => {
      for (const a of Object.values(engine.getState().aircraft)) {
        if (a.isDeparture || a.phase !== 'FINAL' || seen.has(a.id)) continue;
        seen.add(a.id);
        const g = findRunwayEnd(airport, a.assignedRunwayEnd);
        if (!g) continue;
        const d = -alongCross(g, a.pos).along;
        const path = glideAltitudeFt(g.elevationFt, d, glidePathFor(airport, undefined, g, getPerformance(a.type)));
        const high = Math.round(a.altitudeFt - path);
        if (high > 300) lines.push(`${a.callsign} ${a.type} runway ${g.end.id} FINAL at t=${Math.round(now)}: ${(d / 1852).toFixed(1)} nm, ${Math.round(a.altitudeFt)} ft, ${high} ft above the path, ${Math.round(a.groundSpeedKt)} kt`);
      }
    },
  }, { airport, ...(active ? { activeRunways: active } : {}) });
  const tdz = r.events.filter((e) => e.kind === 'GO_AROUND' && /touchdown zone|unstable/.test(e.text)).map((e) => `${Math.round(e.timeSec)} ${e.text}`);
  const out = `${label}: ${lines.length} arrivals established more than 300 ft high; ${tdz.length} touchdown-zone / unstable go-arounds of ${r.goArounds}\n${lines.join('\n')}\n${tdz.join('\n')}\n`;
  if (process.env.FREEPLAY_REPORT_FILE) appendFileSync(process.env.FREEPLAY_REPORT_FILE, out);
  console.log(out);
}

describe.skipIf(!enabled)('arrivals established high on final (reproduction)', () => {
  it('KBOS NE-4R4L-9 seed 1', () => {
    const kbos = loadKbos();
    const c = kbos.runwayConfigurations!.find((x) => x.id === 'NE-4R4L-9')!;
    run('KBOS NE-4R4L-9 s1', kbos, 1, 1.5, { landing: c.landing, departing: c.departing });
  }, 1800000);
  it('KPGD seed 1', () => run('KPGD s1', loadKpgd(), 1, 2), 1800000);
});
