/**
 * AI controllers at the third airport (KPGD): a Tower-only player, AI Clearance/Ground/Approach/Departure work the rest.
 * Facility names come from the airport data (Punta Gorda Clearance/Ground/Tower, Fort Myers Approach/Departure); PGD publishes no DP, so the
 * clearance carries the default initial altitude, and every flight is handled without a safety event.
 */
import { describe, expect, it } from 'vitest';
import { assessClearanceSafety } from '../sim/conflicts';
import { mToNm } from '../sim/geo';
import { alongCross, findRunwayEnd } from '../sim/runways';
import type { Aircraft, ScenarioAircraftSpawn } from '../sim/types';
import { loadKpgd } from '../airport';
import { cmd, createHarness, IFR_ARR, IFR_DEP } from './testkit';
import type { Harness } from './testkit';

const kpgd = loadKpgd();
const g22 = findRunwayEnd(kpgd, '22')!;
const finalNm = (ac: Aircraft) => mToNm(-alongCross(g22, ac.pos).along);
const aircraft = (h: Harness) => Object.values(h.engine.getState().aircraft);
const safe = (h: Harness, c: ReturnType<typeof cmd>) => assessClearanceSafety(h.engine.getState(), c).safe;
const TWR_MHZ = 121.0;

const dep = (cs: string, gate: string, over: Partial<ScenarioAircraftSpawn> = {}): ScenarioAircraftSpawn => {
  const s = IFR_DEP(cs, gate, [], over);
  return { ...s, flightPlan: { ...s.flightPlan!, origin: 'KPGD' } };
};

/** Player working Tower (runway 22): takeoff when asked and safe, landing clearance inside 4 nm, Ground after landing, Departure when airborne. */
function towerPlayer(h: Harness) {
  const handed = new Set<string>();
  return () => {
    for (const ac of aircraft(h)) {
      if (ac.frequencyMhz !== TWR_MHZ || ac.radioState === 'TRANSMITTING') continue;
      const p = ac.pendingRequest?.kind;
      if (ac.isDeparture && ac.onGround && p === 'DEPARTURE') {
        const c = cmd('TAKEOFF', ac.callsign, { runwayEnd: '22' });
        if (safe(h, c) && aircraft(h).every((o) => o.isDeparture || o.onGround || finalNm(o) > 4) && h.towerMayDepart(ac)) h.say('TWR', c);
      } else if (!ac.isDeparture && !ac.onGround && p === 'LANDING' && finalNm(ac) < 4) {
        const c = cmd('LAND', ac.callsign, { runwayEnd: '22' });
        if (safe(h, c)) h.say('TWR', c);
      } else if (!ac.isDeparture && ac.onGround && p === 'FREQUENCY_CHANGE') h.say('TWR', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'GND' }));
      else if (ac.isDeparture && !ac.onGround && (ac.phase === 'INITIAL_CLIMB' || ac.phase === 'DEPARTURE') && ac.altitudeFt > 600 && !handed.has(ac.callsign)) {
        handed.add(ac.callsign);
        h.say('TWR', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'DEP' }));
      }
    }
  };
}

describe('AI controllers at KPGD (Tower-only player)', () => {
  const h = createHarness({
    airport: kpgd,
    player: ['TWR'],
    activeRunways: { departing: ['22'], landing: ['22'] },
    spawns: [dep('AAY451', 'GATE-5'), IFR_ARR('AAY212', 'AIRVA', ['AIRVA', 'DOGLE'], '22', 3000, { atSec: 200 })],
  });
  h.runUntil(() => h.now() > 300 && aircraft(h).length === 0, 3000, towerPlayer(h));

  it('both flights are handled and nothing unsafe happens', () => {
    expect(aircraft(h)).toHaveLength(0);
    const bad = h.events.filter((e) => ['RUNWAY_INCURSION', 'SEPARATION_VIOLATION', 'GO_AROUND'].includes(e.kind) || (e.kind === 'CONFLICT' && /UNSAFE/.test(e.text)));
    expect(bad.map((e) => e.text)).toEqual([]);
    expect(h.engine.getState().score.aircraftHandled).toBe(2);
  });

  it('uses the facility names from the airport data; the clearance has no published departure procedure (default initial altitude)', () => {
    const atc = h.atc().map((e) => e.text);
    const pilot = h.pilotTexts().join('\n');
    const clr = h.atc('CLNC').map((e) => e.text).find((t) => /departure frequency/.test(t));
    expect(clr).toBeDefined();
    expect(clr).not.toMatch(/Atlantic City|One departure/);
    expect(clr).toMatch(/departure frequency one two seven point zero five/);
    expect(atc.join('\n')).not.toMatch(/Atlantic City/);
    expect(pilot).toMatch(/Punta Gorda Clearance Delivery, Allegiant four fifty one/);
    expect(pilot).toMatch(/Punta Gorda Ground, Allegiant two twelve/);
    expect(pilot).toMatch(/Fort Myers (Departure|Approach), (Allegiant four fifty one|Allegiant two twelve)/);
    expect(pilot).not.toMatch(/Atlantic City/);
  });
});
