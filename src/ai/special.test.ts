import { describe, expect, it } from 'vitest';
import { createHarness, kacy, timeline } from './testkit';
import type { ScenarioAircraftSpawn } from '../sim/types';

const vehicle = (callsign: string, parkingId: string, task: 'RUNWAY_INSPECTION' | 'PAVEMENT_INSPECTION' | 'ERRAND', extra: Partial<ScenarioAircraftSpawn> = {}): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'VEH', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'GND', start: { kind: 'parked', parkingId },
  behavior: { kind: 'vehicle', task, ...(task === 'RUNWAY_INSPECTION' ? { runwayId: '4/22' } : {}), ...(task === 'ERRAND' ? { errandCategory: 'ga' as const } : {}) }, ...extra,
});

describe('airport vehicle runway inspection with AI Ground and Tower', () => {
  it('asks Ground, holds short, is sent onto the runway, drives it, reports off, returns and is removed', () => {
    const h = createHarness({ spawns: [vehicle('APT21', 'FAA-1', 'RUNWAY_INSPECTION')], player: [], activeRunways: { departing: ['13'], landing: ['13'] } });
    const ok = h.runUntil(() => !h.find("APT21"), 2000);
    const log = timeline(h);
    expect(ok, log).toBe(true);
    const texts = h.pilotTexts('APT21').join(' | ');
    expect(texts).toMatch(/request taxi to runway .* for a runway inspection/);
    expect(texts).toMatch(/is off of runway/);
    expect(h.events.some((e) => e.kind === 'RUNWAY_ENTERED' && e.callsign === 'APT21' && /4\/22/.test(e.text))).toBe(true);
    expect(h.events.some((e) => e.kind === 'RUNWAY_INCURSION' && e.callsign === 'APT21')).toBe(false);
  });
});

const heli = (callsign: string, behavior: NonNullable<ScenarioAircraftSpawn['behavior']>, start: ScenarioAircraftSpawn['start'], over: Partial<ScenarioAircraftSpawn> = {}): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'H65', flightRules: 'VFR', isDeparture: start.kind === 'parked', initialFrequencyId: 'TWR', start, behavior, ...over,
});

describe('Coast Guard helicopter with AI Tower and Ground', () => {
  it('departs from the helipad: request, takeoff clearance from the pad, lift-off to a hover, climb away', () => {
    const h = createHarness({ spawns: [heli('CGD61327', { kind: 'helicopter', padId: 'USCG-1', mission: 'DEPARTURE' }, { kind: 'parked', parkingId: 'USCG-1' })], player: [] });
    const ok = h.runUntil(() => (h.find('CGD61327')?.altitudeFt ?? 0) > 400 && !h.find('CGD61327')!.onGround, 400);
    const log = timeline(h);
    expect(ok, log).toBe(true);
    expect(h.pilotTexts('CGD61327')[0]).toMatch(/Coast Guard six one three two seven, at Coast Guard Helipad one, request departure to the/);
    expect(log).toMatch(/make (left|right) turn for \w+ departure, cleared for takeoff/);
  });

  it('lands at the helipad: inbound call, landing clearance to the pad, vertical landing, shut down', () => {
    const pad = kacy.parking.find((p) => p.id === 'USCG-2')!;
    // 4 nm south-south-east of the pad at 1,000 ft, flying in
    const start = { kind: 'airborne' as const, pos: { x: pad.pos.x + 1500, y: pad.pos.y - 6500 }, altitudeFt: 1000, headingDeg: 350, speedKt: 100 };
    const h = createHarness({ spawns: [heli('CGD61328', { kind: 'helicopter', padId: 'USCG-2', mission: 'ARRIVAL' }, start, { isDeparture: false })], player: [] });
    const ok = h.runUntil(() => !h.find('CGD61328'), 900);
    const log = timeline(h);
    expect(ok, log).toBe(true);
    expect(log).toMatch(/inbound for/);
    expect(log).toMatch(/make straight-in approach to Coast Guard Helipad 2, cleared to land/);
    expect(h.events.some((e) => /landed at USCG Helipad 2/.test(e.text))).toBe(true);
  });
});

describe('helicopter hover and air taxi on the KACY helipads', () => {
  it('air taxis between two USCG helipads at the air-taxi height and speed, then settles on the pad', () => {
    const h = createHarness({
      spawns: [heli('CGD61329', { kind: 'helicopter', padId: 'USCG-3', mission: 'REPOSITION' }, { kind: 'parked', parkingId: 'USCG-1' }, { initialFrequencyId: 'GND' })], player: [],
    });
    const samples: { agl: number; kt: number }[] = [];
    const ok = h.runUntil(() => {
      const a = h.find('CGD61329');
      if (a) samples.push({ agl: a.altitudeFt - kacy.elevationFt, kt: a.groundSpeedKt });
      const pad = kacy.parking.find((p) => p.id === 'USCG-3')!;
      return !!a && a.phase === 'PARKED' && Math.hypot(a.pos.x - pad.pos.x, a.pos.y - pad.pos.y) < 3 && Math.abs(a.altitudeFt - kacy.elevationFt) < 0.5;
    }, 600);
    const log = timeline(h);
    expect(ok, log).toBe(true);
    expect(log).toMatch(/request air taxi to .*Helipad three/);
    expect(log).toMatch(/air taxi to Coast Guard USCG Helipad 3|air taxi to .*Helipad 3/);
    const maxKt = Math.max(...samples.map((s) => s.kt));
    const maxAgl = Math.max(...samples.map((s) => s.agl));
    expect(maxKt).toBeGreaterThan(10); // the pads are 60 m apart: speed builds up (the long-route speed is measured in rotorcraft.test.ts)
    expect(maxKt).toBeLessThan(40);
    expect(maxAgl).toBeGreaterThan(20);
    expect(maxAgl).toBeLessThan(100); // below 100 ft AGL
  });
});

describe('Air National Guard F-16C', () => {
  it('a flight of two taxis from the ANG ramp as one aircraft and departs', () => {
    const h = createHarness({
      spawns: [{ atSec: 0, callsign: 'ANG13586', type: 'F16', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'GND', start: { kind: 'parked', parkingId: 'ANG-3' }, behavior: { kind: 'military', size: 2 } }], player: [],
    });
    const a = h.find('ANG13586')!;
    expect(a.formation).toEqual({ size: 2 });
    expect(a.spokenCallsign).toBe('Air Guard one three five eight six flight of two');
    const ok = h.runUntil(() => !h.find('ANG13586') || (!h.find('ANG13586')!.onGround && h.find('ANG13586')!.phase === 'DEPARTURE'), 1500);
    const log = timeline(h);
    expect(ok, log).toBe(true);
    expect(log).toMatch(/Air Guard one three five eight six flight of two, ready to taxi|Air Guard one three five eight six flight of two, at ANG Ramp/);
    expect(log).toMatch(/cleared for takeoff/);
  });

  it('arrives through the overhead maneuver: instruction, initial, break, landing after the break', () => {
    const rwy = kacy.runways.flatMap((r) => r.ends).find((e) => e.id === '13')!;
    void rwy;
    const h = createHarness({
      spawns: [{
        atSec: 0, callsign: 'ANG24680', type: 'F16', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
        start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 2000, headingDeg: 118, speedKt: 200, runwayEnd: '13', distanceNm: 10 }, behavior: { kind: 'military', overhead: true },
      }], player: [],
    });
    const phases = new Set<string>();
    const ok = h.runUntil(() => {
      const a = h.find('ANG24680');
      if (a) phases.add(`${a.phase}/${a.flags.overhead ?? '-'}`);
      return !a;
    }, 1500);
    const log = timeline(h);
    expect(ok, log).toBe(true);
    expect(log).toMatch(/inbound for the overhead/);
    expect(log).toMatch(/runway one three, wind .*, pattern altitude one thousand six hundred, report initial/);
    expect(log).toMatch(/initial runway one three/);
    expect(log).toMatch(/break at midfield, report break/);
    expect(log).toMatch(/Air Guard two four six eight zero, break\./);
    expect(log).toMatch(/cleared to land/);
    // cleared to land only after the break
    const iBreak = h.events.findIndex((e) => /breaks over runway/.test(e.text));
    const iLand = h.events.findIndex((e) => /cleared to land/.test(e.text) && e.speaker === 'ATC');
    expect(iBreak).toBeGreaterThan(-1);
    expect(iLand).toBeGreaterThan(iBreak);
    expect(phases.has('PATTERN/BROKE')).toBe(true);
  });
});

describe('VFR transition through the Class C', () => {
  const transit = (callsign: string, freq: 'APP' | 'TWR'): ScenarioAircraftSpawn => ({
    atSec: 0, callsign, type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: freq,
    start: { kind: 'airborne', pos: { x: -30000, y: 4000 }, altitudeFt: 5500, headingDeg: 90, speedKt: 110 },
    behavior: { kind: 'transit', exitPos: { x: 30000, y: 4000 }, altitudeFt: 5500 }, remoteAirport: 'KMIV',
  });
  it('calls Approach per AIM 3-2-4, is given a squawk and radar contact, flies across, and is released with frequency change approved', () => {
    const h = createHarness({ spawns: [transit('N723EJ', 'APP')], player: [] });
    const ok = h.runUntil(() => !h.find('N723EJ'), 1500);
    const log = timeline(h);
    expect(ok, log).toBe(true);
    expect(log).toMatch(/Atlantic City Approach, Cessna seven two three echo juliet, .*miles .*, five thousand five hundred, squawking one two zero zero, request Class Charlie transition, destination Millville/);
    expect(log).toMatch(/ATC\/APP Cessna seven two three echo juliet, squawk \w+ \w+ \w+ \w+/);
    expect(log).toMatch(/radar contact/);
    expect(log).toMatch(/radar service terminated, squawk VFR, frequency change approved/);
    expect(h.events.some((e) => e.kind === 'DESPAWN' && /crossed the area/.test(e.text))).toBe(true);
    expect(h.events.some((e) => e.kind === 'CONFLICT' && e.severity === 'critical')).toBe(false);
  });
  it('with no Approach staffed, Tower gives the same service', () => {
    const h = createHarness({ spawns: [transit('N723EJ', 'TWR')], player: [], ai: ['TWR', 'GND'] });
    const ok = h.runUntil(() => !h.find('N723EJ'), 1500);
    const log = timeline(h);
    expect(ok, log).toBe(true);
    expect(log).toMatch(/ATC\/TWR .*radar contact/);
  });
});

describe('flight training circuits', () => {
  it('touch-and-goes while circuits remain, then a full stop and a request to taxi back', () => {
    const h = createHarness({
      spawns: [{
        atSec: 0, callsign: 'N456TR', type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
        start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 1500, headingDeg: 118, speedKt: 100, runwayEnd: '13', distanceNm: 6 }, behavior: { kind: 'training', circuits: 2 },
      }], player: [],
    });
    const ok = h.runUntil(() => !h.find('N456TR'), 2400);
    const log = timeline(h);
    expect(ok, log).toBe(true);
    expect(log).toMatch(/inbound for touch and go/);
    expect((log.match(/cleared touch-and-go/g) ?? []).length).toBe(1); // the circuit counter: 2 circuits = one touch-and-go then the full stop
    expect(log).toMatch(/left downwind runway one three, touch and go/);
    expect(log).toMatch(/ATC\/TWR .*cleared to land/);
    expect(log).toMatch(/request taxi back to the ramp/);
  });
});

describe('safety of the AI with special traffic', () => {
  it('Tower does not send the vehicle onto the runway while an arrival is on final, and no aeroplane lands over a vehicle', () => {
    // the vehicle starts at t = 0; an arrival appears 8 nm out once the vehicle is on its way and lands on 13 before the vehicle may enter
    const h = createHarness({
      spawns: [
        vehicle('APT21', 'FAA-1', 'RUNWAY_INSPECTION', { }),
        { atSec: 60, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 1500, headingDeg: 118, speedKt: 90, runwayEnd: '13', distanceNm: 8 } },
      ], player: [], activeRunways: { departing: ['13'], landing: ['13'] },
    });
    let proceedAt = -1;
    let landedAt = -1;
    h.runUntil(() => {
      const ev = h.events;
      if (proceedAt < 0) proceedAt = ev.find((e) => e.kind === 'COMMAND_ACCEPTED' && /APT21: PROCEED/.test(e.text))?.timeSec ?? -1;
      if (landedAt < 0) landedAt = ev.find((e) => /N723EJ touched down/.test(e.text))?.timeSec ?? -1;
      return !h.find('APT21') && !h.find('N723EJ');
    }, 3000);
    const log = timeline(h);
    expect(h.events.some((e) => e.kind === 'RUNWAY_INCURSION'), log).toBe(false);
    expect(h.events.some((e) => e.kind === 'GO_AROUND' && e.callsign === 'N723EJ'), log).toBe(false);
    expect(h.events.some((e) => e.kind === 'SEPARATION_VIOLATION' && /APT21/.test(e.text)), log).toBe(false);
    if (proceedAt > 0 && landedAt > 0) {
      // either the vehicle finished before the arrival reached the field or it was sent after the aircraft was clear of the runway
      const offAt = h.events.find((e) => e.kind === 'RUNWAY_EXITED' && e.callsign === 'APT21' && e.timeSec > proceedAt)?.timeSec ?? Infinity;
      expect(offAt < landedAt || proceedAt > landedAt, log).toBe(true);
    }
  });

  it('transit squawk codes are valid assigned codes (octal digits, never 1200 or an emergency code)', async () => {
    const { transitSquawk } = await import('./special');
    for (let seed = 0; seed < 5000; seed += 7) {
      const code = transitSquawk({ seed } as never);
      expect(code).toMatch(/^[0-7]{4}$/);
      expect(['1200', '7500', '7600', '7700']).not.toContain(code);
    }
  });

  it('a helicopter path is clear only when no aeroplane is near it (hold position until it is)', async () => {
    const { heliPathClear } = await import('./special');
    const state = { aircraft: { a: { id: 'a', type: 'C172', onGround: false, pos: { x: 1000, y: 0 }, groundSpeedKt: 90 } } } as never;
    expect(heliPathClear(state, { x: 0, y: 0 }, { x: 2000, y: 0 }, 'h')).toBe(false); // an aeroplane on the segment
    expect(heliPathClear(state, { x: 0, y: 5000 }, { x: 2000, y: 5000 }, 'h')).toBe(true);
  });
});

describe('vehicle queueing (several vehicles at once, seeds 11-15)', () => {
  it.each([11, 12, 13, 14, 15])('seed %i: six vehicles of every task share the airfield with no proximity alert and all finish', (seed) => {
    const homes = ['FAA-1', 'FAA-2', 'FAA-3', 'FBO-1', 'FBO-2', 'FAA-1'];
    const tasks: ('RUNWAY_INSPECTION' | 'PAVEMENT_INSPECTION' | 'ERRAND')[] = ['PAVEMENT_INSPECTION', 'RUNWAY_INSPECTION', 'PAVEMENT_INSPECTION', 'ERRAND', 'RUNWAY_INSPECTION', 'PAVEMENT_INSPECTION'];
    const spawns = tasks.map((t, i) => vehicle(`APT${10 + i * 7}`, homes[i], t, { atSec: i * (i === 5 ? 700 : 20) }));
    const h = createHarness({ spawns, player: [], seed, aiSeed: seed });
    const done = h.runUntil(() => Object.values(h.engine.getState().aircraft).every((a) => a.type !== 'VEH'), 9000);
    const log = timeline(h);
    const alerts = h.events.filter((e) => (e.kind === 'SEPARATION_VIOLATION' || e.kind === 'RUNWAY_INCURSION') && /APT/.test(e.text));
    expect(alerts.map((e) => `${e.timeSec} ${e.text}`), log).toEqual([]);
    expect(done, log).toBe(true);
  }, 60000);
});
