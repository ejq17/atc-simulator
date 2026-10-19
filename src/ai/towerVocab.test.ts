/** AI Tower use of the Tower vocabulary: exit + contact Ground after landing (3-10-9), traffic information with line up and wait (3-9-4), the numbers for a pilot without the ATIS (3-9-1, 3-10-1). */
import { describe, expect, it } from 'vitest';
import type { ScenarioAircraftSpawn } from '../sim/types';
import { pilotNeedsNumbers } from '../sim/traffic';
import { createHarness } from './testkit';

const vfrArrival = (callsign: string, nm: number): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
  start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 70, runwayEnd: '13', distanceNm: nm },
});
const vfrHold = (callsign: string): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'C172', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'holding_short', nodeId: 'HP13-31-B-1', runwayEnd: '13' },
});

describe('AI Tower: exit instruction with the handoff to Ground', () => {
  it('names the exit the aircraft is going to take and says "contact Ground"; the frequency changes only after the aircraft is clear of the runway', () => {
    const h = createHarness({ player: ['GND'], spawns: [vfrArrival('N723EJ', 4)] });
    expect(h.runUntil(() => h.atc('TWR').some((e) => /contact ground/.test(e.text)), 600)).toBe(true);
    const atc = h.atc('TWR').map((e) => e.text);
    expect(atc.at(-1)).toBe('Cessna seven two three echo juliet, turn right at charlie, contact ground point niner');
    const ac = h.find('N723EJ')!;
    const callAt = h.atc('TWR').at(-1)!.timeSec;
    // the exit command and the contact command are both accepted
    const accepted = h.outcomes.filter((o) => o.timeSec >= callAt - 0.01).map((o) => `${o.cmd.kind}:${o.out.status}`);
    expect(accepted).toEqual(['EXIT_RUNWAY:accepted', 'CONTACT_FREQUENCY:accepted']);
    expect(ac.frequencyMhz).toBe(120.3);
    expect(h.runUntil(() => !h.find('N723EJ') || h.find('N723EJ')!.frequencyMhz === 121.9, 120)).toBe(true);
    const clearAt = h.events.find((e) => e.kind === 'PHASE_CHANGE' && e.callsign === 'N723EJ' && e.data?.to === 'RUNWAY_EXIT')!.timeSec;
    const handoff = h.events.find((e) => e.kind === 'HANDOFF' && e.callsign === 'N723EJ' && e.frequencyMhz === 121.9)!;
    expect(handoff.timeSec).toBeGreaterThanOrEqual(clearAt);
    // no second, redundant handoff transmission
    expect(h.atc('TWR').filter((e) => /contact ground/.test(e.text))).toHaveLength(1);
  });

  it('is deterministic', () => {
    const run = () => {
      const h = createHarness({ player: ['GND'], spawns: [vfrArrival('N723EJ', 4)] });
      h.run(300);
      return h.atc().map((e) => `${e.timeSec.toFixed(1)} ${e.text}`).join('\n');
    };
    expect(run()).toBe(run());
  });
});

describe('AI Tower: traffic information with line up and wait', () => {
  // (6.4 nm: the line-up waits for Departure's release since the release-first rule, a few seconds later than before, so the arrival is nearer when it is given)
  it('an IFR departure without its clearance is lined up (the takeoff is not possible yet) and told about the arrival inside 6 miles (not yet cleared to land); training mode accepts it', () => {
    const h = createHarness({
      player: ['GND'],
      spawns: [
        { atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'holding_short', nodeId: 'HP13-31-B-1', runwayEnd: '13' }, flightPlan: { flightRules: 'IFR', origin: 'KACY', destination: 'KPHL', cruiseAltitudeFt: 10000, route: ['VCN'] } },
        vfrArrival('N723EJ', 6.4),
      ],
    });
    expect(h.runUntil(() => h.outcomes.some((o) => o.cmd.kind === 'LINE_UP_AND_WAIT'), 120)).toBe(true);
    const luaw = h.outcomes.find((o) => o.cmd.kind === 'LINE_UP_AND_WAIT')!;
    expect(luaw.out.status).toBe('accepted');
    expect(luaw.cmd.trafficAdvised).toBe(true);
    const say = h.atc('TWR').find((e) => /line up and wait/.test(e.text))!;
    expect(say.text).toMatch(/^Spirit four fifty one, runway one three, line up and wait, traffic Cessna, (six|five) mile final$/);
    expect(h.events.some((e) => /Improper instruction/.test(e.text))).toBe(false);
  });
});

describe('AI Tower: the numbers for a pilot without the ATIS', () => {
  it('answers "request wind and altimeter" with the wind (magnetic) and altimeter from the observation, once', () => {
    // (the arrival is 2 nm out: 3 nm, 154 s, leaves the room a takeoff needs since the release rule of 3-9-5 / 3-10-3 replaced the flat 2.4 nm, and the pilot would be gone before it asks)
    let h = createHarness({ player: ['GND'], spawns: [vfrHold('N482KB'), vfrArrival('N999AA', 2)] });
    for (let seed = 1; seed < 200; seed++) {
      h = createHarness({ player: ['GND'], seed, spawns: [vfrHold('N482KB'), vfrArrival('N999AA', 2)] });
      if (pilotNeedsNumbers(h.find('N482KB')!)) break;
    }
    expect(pilotNeedsNumbers(h.find('N482KB')!)).toBe(true);
    expect(h.runUntil(() => h.atc('TWR').some((e) => /altimeter/.test(e.text)), 120)).toBe(true);
    const info = h.atc('TWR').filter((e) => /altimeter/.test(e.text));
    expect(info).toHaveLength(1);
    expect(info[0].text).toMatch(/^Cessna four eight two kilo bravo, wind one four zero at four, altimeter two niner niner two$/);
    expect(h.pilotTexts('N482KB').filter((t) => /request wind and altimeter/.test(t))).toHaveLength(1);
    expect(h.outcomes.filter((o) => o.cmd.kind === 'AIRPORT_INFO').map((o) => o.out.status)).toEqual(['accepted']);
    h.run(60);
    expect(h.atc('TWR').filter((e) => /altimeter/.test(e.text))).toHaveLength(1);
  });
});
