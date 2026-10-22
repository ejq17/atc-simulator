/**
 * AI controllers at KPHL (four runways, Class B): a Tower-only player, AI Clearance/Ground/Approach/Departure work the rest.
 * Facility names come from the airport data (Philadelphia Clearance/Ground/Tower/Approach/Departure), the IFR clearance names PHILADELPHIA FOUR,
 * and every flight is handled without a safety event: a gate departure to 27L (crossing 9L/27R), an ILS arrival to 27R.
 */
import { describe, expect, it } from 'vitest';
import { assessClearanceSafety } from '../sim/conflicts';
import { mToNm } from '../sim/geo';
import { alongCross, findRunwayEnd } from '../sim/runways';
import type { Aircraft, ScenarioAircraftSpawn } from '../sim/types';
import { loadKphl } from '../airport';
import { cmd, createHarness, IFR_ARR, IFR_DEP } from './testkit';
import type { Harness } from './testkit';

const kphl = loadKphl();
const g27r = findRunwayEnd(kphl, '27R')!;
const finalNm = (ac: Aircraft) => mToNm(-alongCross(g27r, ac.pos).along);
const aircraft = (h: Harness) => Object.values(h.engine.getState().aircraft);
const safe = (h: Harness, c: ReturnType<typeof cmd>) => assessClearanceSafety(h.engine.getState(), c).safe;
const TWR_MHZ = 118.5;

const dep = (cs: string, gate: string, over: Partial<ScenarioAircraftSpawn> = {}): ScenarioAircraftSpawn => {
  const s = IFR_DEP(cs, gate, [], over);
  return { ...s, flightPlan: { ...s.flightPlan!, origin: 'KPHL' } };
};

/** Player working Tower: 27L departures, 27R landings; takeoff when asked and safe, landing clearance inside 4 nm, Ground after landing, Departure when airborne. */
function towerPlayer(h: Harness) {
  const handed = new Set<string>();
  return () => {
    for (const ac of aircraft(h)) {
      if (ac.frequencyMhz !== TWR_MHZ || ac.radioState === 'TRANSMITTING') continue;
      const p = ac.pendingRequest?.kind;
      if (ac.isDeparture && ac.onGround && p === 'DEPARTURE') {
        const c = cmd('TAKEOFF', ac.callsign, { runwayEnd: '27L' });
        if (safe(h, c) && h.towerMayDepart(ac)) h.say('TWR', c);
      } else if (!ac.isDeparture && !ac.onGround && p === 'LANDING' && finalNm(ac) < 4) {
        const c = cmd('LAND', ac.callsign, { runwayEnd: '27R' });
        if (safe(h, c)) h.say('TWR', c);
      } else if (!ac.isDeparture && ac.onGround && p === 'FREQUENCY_CHANGE') h.say('TWR', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'GND' }));
      else if (ac.isDeparture && !ac.onGround && (ac.phase === 'INITIAL_CLIMB' || ac.phase === 'DEPARTURE') && ac.altitudeFt > 600 && !handed.has(ac.callsign)) {
        handed.add(ac.callsign);
        h.say('TWR', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'DEP' }));
      }
    }
  };
}

describe('AI controllers at KPHL (Tower-only player)', () => {
  const h = createHarness({
    airport: kphl,
    player: ['TWR'],
    activeRunways: { departing: ['27L'], landing: ['27R'] },
    spawns: [dep('NKS451', 'GATE-B5'), IFR_ARR('AAL212', 'ENZEW', ['ENZEW', 'MRTIN', 'JALTO'], '27R', 4000, { atSec: 200 })],
  });
  h.runUntil(() => h.now() > 300 && aircraft(h).length === 0, 4500, towerPlayer(h));

  it('both flights are handled and nothing unsafe happens', () => {
    expect(aircraft(h)).toHaveLength(0);
    const bad = h.events.filter((e) => ['RUNWAY_INCURSION', 'SEPARATION_VIOLATION', 'GO_AROUND'].includes(e.kind) || (e.kind === 'CONFLICT' && /UNSAFE/.test(e.text)));
    expect(bad.map((e) => e.text)).toEqual([]);
    expect(h.engine.getState().score.aircraftHandled).toBe(2);
  });

  it('uses the facility names from the airport data and the Philadelphia Four clearance', () => {
    const atc = h.atc().map((e) => e.text);
    const pilot = h.pilotTexts().join('\n');
    const clr = h.atc('CLNC').map((e) => e.text).find((t) => /departure, radar vectors/.test(t));
    expect(clr).toMatch(/Philadelphia Four departure, radar vectors/);
    expect(atc.join('\n')).not.toMatch(/Atlantic City|Manchester/);
    expect(pilot).toMatch(/Philadelphia Clearance Delivery, Spirit four fifty one/);
    expect(pilot).toMatch(/Philadelphia Ground, Spirit four fifty one/);
    expect(pilot).toMatch(/Philadelphia (Departure|Approach), (Spirit four fifty one|American two twelve)/);
    expect(pilot).not.toMatch(/Atlantic City|Manchester|Boston/);
  });
});
