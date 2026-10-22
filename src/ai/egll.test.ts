/**
 * AI controllers at EGLL (London Heathrow, parallel runways, segregated mode: land 27L, depart 27R): a Tower-only player, AI Delivery/Ground/Director/
 * London Control work the rest. Facility names come from the airport data (Heathrow Delivery/Ground/Tower/Director, London Control), the IFR clearance
 * names a 27R SID with the 6,000 ft cap, and every flight is handled without a safety event.
 */
import { describe, expect, it } from 'vitest';
import { assessClearanceSafety } from '../sim/conflicts';
import { mToNm } from '../sim/geo';
import { alongCross, findRunwayEnd } from '../sim/runways';
import type { Aircraft, ScenarioAircraftSpawn } from '../sim/types';
import { loadEgll } from '../airport';
import { cmd, createHarness, IFR_ARR, IFR_DEP } from './testkit';
import type { Harness } from './testkit';

const egll = loadEgll();
const g27L = findRunwayEnd(egll, '27L')!;
const finalNm = (ac: Aircraft) => mToNm(-alongCross(g27L, ac.pos).along);
const aircraft = (h: Harness) => Object.values(h.engine.getState().aircraft);
const safe = (h: Harness, c: ReturnType<typeof cmd>) => assessClearanceSafety(h.engine.getState(), c).safe;
const TWR_MHZ = 118.505;

const dep = (cs: string, gate: string, over: Partial<ScenarioAircraftSpawn> = {}): ScenarioAircraftSpawn => {
  const s = IFR_DEP(cs, gate, [], over);
  return { ...s, flightPlan: { ...s.flightPlan!, origin: 'EGLL', destination: 'KJFK' } };
};

/** Player working Tower (land 27L, depart 27R): takeoff when asked and safe, landing clearance inside 4 nm, Ground after landing, Departure when airborne. */
function towerPlayer(h: Harness) {
  const handed = new Set<string>();
  return () => {
    for (const ac of aircraft(h)) {
      if (ac.frequencyMhz !== TWR_MHZ || ac.radioState === 'TRANSMITTING') continue;
      const p = ac.pendingRequest?.kind;
      if (ac.isDeparture && ac.onGround && p === 'DEPARTURE') {
        const c = cmd('TAKEOFF', ac.callsign, { runwayEnd: '27R' });
        if (safe(h, c) && aircraft(h).every((o) => o.isDeparture || o.onGround || finalNm(o) > 4) && h.towerMayDepart(ac)) h.say('TWR', c);
      } else if (!ac.isDeparture && !ac.onGround && p === 'LANDING' && finalNm(ac) < 4) {
        const c = cmd('LAND', ac.callsign, { runwayEnd: '27L' });
        if (safe(h, c)) h.say('TWR', c);
      } else if (!ac.isDeparture && ac.onGround && p === 'FREQUENCY_CHANGE') h.say('TWR', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'GND' }));
      else if (ac.isDeparture && !ac.onGround && (ac.phase === 'INITIAL_CLIMB' || ac.phase === 'DEPARTURE') && ac.altitudeFt > 600 && !handed.has(ac.callsign)) {
        handed.add(ac.callsign);
        h.say('TWR', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'DEP' }));
      }
    }
  };
}

describe('AI controllers at EGLL (Tower-only player)', () => {
  const h = createHarness({
    airport: egll,
    player: ['TWR'],
    activeRunways: { departing: ['27R'], landing: ['27L'] },
    spawns: [dep('BAW123', 'STAND-501'), IFR_ARR('VIR212', 'BIG', ['BIG', 'LLIF', 'LLFAP'], '27L', 4000, { atSec: 200 })],
  });
  h.runUntil(() => h.now() > 300 && aircraft(h).length === 0, 3000, towerPlayer(h));

  it('both flights are handled and nothing unsafe happens', () => {
    expect(aircraft(h)).toHaveLength(0);
    const bad = h.events.filter((e) => ['RUNWAY_INCURSION', 'SEPARATION_VIOLATION', 'GO_AROUND'].includes(e.kind) || (e.kind === 'CONFLICT' && /UNSAFE/.test(e.text)));
    expect(bad.map((e) => e.text)).toEqual([]);
    expect(h.engine.getState().score.aircraftHandled).toBe(2);
  });

  it('uses the facility names from the airport data and a 27R SID with the 6,000 ft cap', () => {
    const atc = h.atc().map((e) => e.text);
    const pilot = h.pilotTexts().join('\n');
    const clr = h.atc('CLNC').map((e) => e.text).find((t) => /departure, radar vectors/.test(t));
    expect(clr).toMatch(/(Compton|Modmi|Maxit|Brookmans Park|Ultib|Umlat|Detling|Gasgu|Gogsi) \w+ \w+ departure, radar vectors, maintain six thousand/i);
    expect(clr).toMatch(/departure frequency one three four point one two five/);
    expect(atc.join('\n')).not.toMatch(/Atlantic City/);
    expect(pilot).toMatch(/Heathrow Delivery, Speedbird one twenty three/);
    expect(pilot).toMatch(/Heathrow Ground, Speedbird one twenty three/);
    expect(pilot).toMatch(/(Heathrow Director|Heathrow Tower), Virgin two twelve/);
    expect(pilot).not.toMatch(/Atlantic City/);
  });
});
