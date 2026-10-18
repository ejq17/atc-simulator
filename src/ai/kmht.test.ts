/**
 * AI controllers at the second airport (KMHT): a Tower-only player, AI Clearance/Ground/Approach/Departure work the rest.
 * Facility names come from the airport data (Manchester Clearance/Ground/Tower, Boston Approach/Departure), the IFR clearance
 * names MANCHESTER ONE with 3,000 ft, and every flight is handled without a safety event.
 */
import { describe, expect, it } from 'vitest';
import { assessClearanceSafety } from '../sim/conflicts';
import { mToNm } from '../sim/geo';
import { alongCross, findRunwayEnd } from '../sim/runways';
import type { Aircraft, ScenarioAircraftSpawn } from '../sim/types';
import { loadKmht } from '../airport';
import { cmd, createHarness, IFR_ARR, IFR_DEP } from './testkit';
import type { Harness } from './testkit';

const kmht = loadKmht();
const g35 = findRunwayEnd(kmht, '35')!;
const finalNm = (ac: Aircraft) => mToNm(-alongCross(g35, ac.pos).along);
const aircraft = (h: Harness) => Object.values(h.engine.getState().aircraft);
const safe = (h: Harness, c: ReturnType<typeof cmd>) => assessClearanceSafety(h.engine.getState(), c).safe;
const TWR_MHZ = 121.3;

const dep = (cs: string, gate: string, over: Partial<ScenarioAircraftSpawn> = {}): ScenarioAircraftSpawn => {
  const s = IFR_DEP(cs, gate, [], over);
  return { ...s, flightPlan: { ...s.flightPlan!, origin: 'KMHT' } };
};

/** Player working Tower (runway 35): takeoff when asked and safe, landing clearance inside 4 nm, Ground after landing, Departure when airborne. */
function towerPlayer(h: Harness) {
  const handed = new Set<string>();
  return () => {
    for (const ac of aircraft(h)) {
      if (ac.frequencyMhz !== TWR_MHZ || ac.radioState === 'TRANSMITTING') continue;
      const p = ac.pendingRequest?.kind;
      if (ac.isDeparture && ac.onGround && p === 'DEPARTURE') {
        const c = cmd('TAKEOFF', ac.callsign, { runwayEnd: '35' });
        if (safe(h, c) && aircraft(h).every((o) => o.isDeparture || o.onGround || finalNm(o) > 4) && h.towerMayDepart(ac)) h.say('TWR', c);
      } else if (!ac.isDeparture && !ac.onGround && p === 'LANDING' && finalNm(ac) < 4) {
        const c = cmd('LAND', ac.callsign, { runwayEnd: '35' });
        if (safe(h, c)) h.say('TWR', c);
      } else if (!ac.isDeparture && ac.onGround && p === 'FREQUENCY_CHANGE') h.say('TWR', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'GND' }));
      else if (ac.isDeparture && !ac.onGround && (ac.phase === 'INITIAL_CLIMB' || ac.phase === 'DEPARTURE') && ac.altitudeFt > 600 && !handed.has(ac.callsign)) {
        handed.add(ac.callsign);
        h.say('TWR', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'DEP' }));
      }
    }
  };
}

describe('AI controllers at KMHT (Tower-only player)', () => {
  const h = createHarness({
    airport: kmht,
    player: ['TWR'],
    activeRunways: { departing: ['35'], landing: ['35'] },
    spawns: [dep('NKS451', 'GATE-5'), IFR_ARR('AAL212', 'PELAN', ['PELAN', 'YOULL', 'MNTIN'], '35', 4000, { atSec: 200 })],
  });
  h.runUntil(() => h.now() > 300 && aircraft(h).length === 0, 3000, towerPlayer(h));

  it('both flights are handled and nothing unsafe happens', () => {
    expect(aircraft(h)).toHaveLength(0);
    const bad = h.events.filter((e) => ['RUNWAY_INCURSION', 'SEPARATION_VIOLATION', 'GO_AROUND'].includes(e.kind) || (e.kind === 'CONFLICT' && /UNSAFE/.test(e.text)));
    expect(bad.map((e) => e.text)).toEqual([]);
    expect(h.engine.getState().score.aircraftHandled).toBe(2);
  });

  it('uses the facility names from the airport data and the Manchester One clearance with 3,000 ft', () => {
    const atc = h.atc().map((e) => e.text);
    const pilot = h.pilotTexts().join('\n');
    const clr = h.atc('CLNC').map((e) => e.text).find((t) => /departure, radar vectors/.test(t));
    expect(clr).toMatch(/Manchester One departure, radar vectors, maintain three thousand/);
    expect(clr).toMatch(/departure frequency one two four point nine/);
    expect(atc.join('\n')).not.toMatch(/Atlantic City/);
    expect(pilot).toMatch(/Manchester Clearance Delivery, Spirit four fifty one/);
    expect(pilot).toMatch(/Manchester Ground, Spirit four fifty one/);
    expect(pilot).toMatch(/Boston (Departure|Approach), (Spirit four fifty one|American two twelve)/);
    expect(pilot).not.toMatch(/Atlantic City/);
  });
});
