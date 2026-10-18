/**
 * AI controllers against the real engine and the real KACY dataset (seeded, readbackErrorRate 0 unless stated).
 * The "player" in these tests is a small script that works exactly one position through `engine.applyCommand` like the UI does.
 */
import { describe, expect, it } from 'vitest';
import { assessClearanceSafety } from '../sim/conflicts';
import { mToNm } from '../sim/geo';
import { alongCross, findRunwayEnd } from '../sim/runways';
import type { Aircraft, ControllerPositionId, SimEvent } from '../sim/types';
import { cmd, createHarness, IFR_ARR, IFR_DEP, kacy, ALL } from './testkit';
import type { Harness } from './testkit';

const GND_MHZ = 121.9;
const TWR_MHZ = 120.3;
const APP_MHZ = 124.6;

const g13 = findRunwayEnd(kacy, '13')!;
const finalNm = (ac: Aircraft) => mToNm(-alongCross(g13, ac.pos).along);
const aircraft = (h: Harness) => Object.values(h.engine.getState().aircraft);
const safe = (h: Harness, c: ReturnType<typeof cmd>) => assessClearanceSafety(h.engine.getState(), c).safe;

/** Player working Ground: taxi to 13 via Bravo, crossings, handoff to Tower at the hold, taxi to parking for arrivals. */
function groundPlayer(h: Harness) {
  return () => {
    for (const ac of aircraft(h)) {
      if (ac.frequencyMhz !== GND_MHZ || ac.radioState === 'TRANSMITTING') continue;
      const p = ac.pendingRequest?.kind;
      if (ac.isDeparture && p === 'TAXI') h.say('GND', cmd('TAXI', ac.callsign, { destination: 'RWY13', route: ['B'], holdShort: ['4/22'] }));
      else if (p === 'CROSSING') {
        const c = cmd('CROSS_RUNWAY', ac.callsign, { crossRunwayId: '4/22' });
        if (safe(h, c)) h.say('GND', c);
      } else if (ac.isDeparture && p === 'FREQUENCY_CHANGE') h.say('GND', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'TWR' }));
      else if (!ac.isDeparture && p === 'TAXI') h.say('GND', cmd('TAXI_TO_PARKING', ac.callsign, { destination: 'GATE' }));
    }
  };
}

/** Player working Tower: takeoff when asked and safe, landing clearance inside 4 nm, Ground after landing, Departure when airborne. */
function towerPlayer(h: Harness) {
  const handedToDeparture = new Set<string>();
  return () => {
    for (const ac of aircraft(h)) {
      if (ac.frequencyMhz !== TWR_MHZ || ac.radioState === 'TRANSMITTING') continue;
      const p = ac.pendingRequest?.kind;
      if (ac.isDeparture && ac.onGround && p === 'DEPARTURE') {
        const c = cmd('TAKEOFF', ac.callsign, { runwayEnd: '13' });
        if (safe(h, c) && Object.values(h.engine.getState().aircraft).every((o) => o.isDeparture || o.onGround || finalNm(o) > 4)) h.say('TWR', c);
      } else if (!ac.isDeparture && !ac.onGround && p === 'LANDING' && finalNm(ac) < 4) {
        const c = cmd('LAND', ac.callsign, { runwayEnd: '13' });
        if (safe(h, c)) h.say('TWR', c);
      } else if (!ac.isDeparture && ac.onGround && p === 'FREQUENCY_CHANGE') h.say('TWR', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'GND' }));
      else if (ac.isDeparture && !ac.onGround && (ac.phase === 'INITIAL_CLIMB' || ac.phase === 'DEPARTURE') && ac.altitudeFt > 600 && !handedToDeparture.has(ac.callsign)) {
        handedToDeparture.add(ac.callsign);
        h.say('TWR', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'DEP' }));
      }
    }
  };
}

/** Player working Approach (and thereby the shared 124.6 / 134.25 Departure frequencies). */
function approachPlayer(h: Harness) {
  return () => {
    for (const ac of aircraft(h)) {
      if (ac.radioState === 'TRANSMITTING' || (ac.frequencyMhz !== APP_MHZ && ac.frequencyMhz !== 134.25)) continue;
      const p = ac.pendingRequest?.kind;
      if (!ac.isDeparture && p === 'APPROACH') {
        h.say('APP', cmd('RADAR_CONTACT', ac.callsign));
        h.say('APP', cmd('ALTITUDE', ac.callsign, { altitudeFt: 3000 }));
        h.say('APP', cmd('APPROACH', ac.callsign, { approachType: 'ILS', runwayEnd: '13' }));
      } else if (!ac.isDeparture && p === 'FREQUENCY_CHANGE') h.say('APP', cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'TWR' }));
      else if (ac.isDeparture && p === 'OTHER') {
        h.say('APP', cmd('RADAR_CONTACT', ac.callsign));
        h.say('APP', cmd('ALTITUDE', ac.callsign, { altitudeFt: 10000 }));
        h.say('APP', cmd('DIRECT_FIX', ac.callsign, { fix: 'VCN' }));
      }
    }
  };
}

const allGone = (h: Harness, after = 60) => () => h.now() > after && Object.keys(h.engine.getState().aircraft).length === 0;
const atcAi = (h: Harness, cs: string, pos?: ControllerPositionId) => h.atc(pos).filter((e) => e.callsign === cs);
const texts = (evs: SimEvent[]) => evs.map((e) => e.text);

/** The engine's own safety record of a run. */
function expectClean(h: Harness) {
  const s = h.engine.getState();
  const bad = h.events.filter((e) => ['CONFLICT', 'RUNWAY_INCURSION', 'SEPARATION_VIOLATION', 'GO_AROUND'].includes(e.kind));
  expect(bad.map((e) => `${e.timeSec.toFixed(0)}s ${e.kind} ${e.text}`)).toEqual([]);
  expect(s.score.runwayIncursions + s.score.unsafeInstructions + s.score.separationViolations + s.score.communicationErrors).toBe(0);
  expect(h.outcomes.filter((o) => o.out.status !== 'accepted').map((o) => `${o.position} ${o.cmd.kind} ${o.cmd.callsign} ${JSON.stringify(o.out)}`)).toEqual([]);
}

/** Every AI transmission produced exactly one ATC event (with aiPosition), in order, with the same words. */
function expectOneEventPerTransmission(h: Harness) {
  const atc = h.atc();
  expect(atc).toHaveLength(h.transmissions.length);
  h.transmissions.forEach((t, i) => {
    expect(atc[i].aiPosition).toBe(t.position);
    expect(atc[i].text).toBe(t.spokenText);
    expect(atc[i].callsign).toBe(t.callsign);
    expect(atc[i].timeSec).toBeCloseTo(t.timeSec, 5);
  });
}

describe('(1) Ground-only player: AI Clearance, Tower, Approach and Departure work the rest', () => {
  const run = () => {
    const h = createHarness({ player: ['GND'], spawns: [IFR_DEP('NKS451', 'GATE-1', ['VCN']), IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 4000)] });
    h.runUntil(allGone(h), 1500, groundPlayer(h));
    return h;
  };
  const h = run();

  it('finishes both flights in under 25 simulated minutes, cleanly', () => {
    expect(h.now()).toBeLessThan(25 * 60);
    expect(Object.keys(h.engine.getState().aircraft)).toHaveLength(0);
    expectClean(h);
    expect(h.engine.getState().score.aircraftHandled).toBe(2);
  });

  it('AI Clearance Delivery answers the IFR request with a full clearance before the aircraft asks Ground for taxi', () => {
    const [clr] = atcAi(h, 'NKS451', 'CLNC');
    expect(clr.text).toMatch(/^Spirit four fifty one, Atlantic City Clearance Delivery, cleared to Philadelphia airport, Atlantic City Three departure, radar vectors, maintain two thousand, expect one zero thousand, one zero minutes after departure, departure frequency one two four point six, squawk [a-z ]+$/);
    const call = h.events.find((e) => e.speaker === 'PILOT' && /Clearance Delivery, Spirit four fifty one, IFR to Philadelphia/.test(e.text))!;
    expect(clr.timeSec - call.timeSec).toBeGreaterThanOrEqual(2); // human reaction delay
    const accepted = h.events.find((e) => e.kind === 'COMMAND_ACCEPTED' && e.callsign === 'NKS451' && e.data?.kind === 'IFR_CLEARANCE')!;
    expect(accepted).toBeDefined();
    const taxiCall = h.events.find((e) => e.speaker === 'PILOT' && e.frequencyMhz === GND_MHZ && /Spirit four fifty one, at Gate one, ready to taxi/.test(e.text))!;
    expect(taxiCall.timeSec).toBeGreaterThan(clr.timeSec);
    const issued = h.transmissions.find((t) => t.callsign === 'NKS451' && t.position === 'CLNC')!;
    expect(issued.voiceId).toBe('atc-clnc');
    expect(issued.frequencyMhz).toBe(127.85);
  });

  it('after the player hands the departure to Tower, AI Tower clears it for takeoff and AI Departure climbs it direct Cedar Lake', () => {
    const handoff = h.events.find((e) => e.kind === 'COMMAND_ACCEPTED' && e.callsign === 'NKS451' && e.data?.kind === 'CONTACT_FREQUENCY' && e.aiPosition === undefined)!;
    const [to] = atcAi(h, 'NKS451', 'TWR');
    expect(to.text).toBe('Spirit four fifty one, runway one three, fly runway heading, cleared for takeoff');
    expect(to.timeSec).toBeGreaterThan(handoff.timeSec);
    const toDep = atcAi(h, 'NKS451', 'TWR')[1];
    expect(toDep.text).toBe('Spirit four fifty one, contact departure one two four point six');
    const dep = atcAi(h, 'NKS451', 'DEP')[0];
    expect(dep.text).toBe('Spirit four fifty one, Atlantic City Departure, radar contact, climb and maintain one zero thousand, proceed direct Cedar Lake');
    const kinds = h.events.filter((e) => e.kind === 'COMMAND_ACCEPTED' && e.callsign === 'NKS451' && e.timeSec >= dep.timeSec).map((e) => e.data?.kind);
    expect(kinds).toEqual(['RADAR_CONTACT', 'ALTITUDE', 'DIRECT_FIX']);
    expect(h.events.some((e) => e.kind === 'DESPAWN' && e.callsign === 'NKS451' && e.data?.handled === true)).toBe(true);
  });

  it('the arrival is cleared for the ILS by AI Approach, handed to AI Tower, cleared to land, and handed to the player with "request taxi to parking"', () => {
    const t = texts(h.atc().filter((e) => e.callsign === 'AAL212'));
    expect(t).toEqual([
      'American two twelve, Atlantic City Approach, radar contact, descend and maintain two thousand',
      'American two twelve, cleared ILS runway one three approach',
      'American two twelve, contact tower one two zero point three',
      'American two twelve, continue approach',
      'American two twelve, runway one three, cleared to land',
      'American two twelve, turn right at alpha, contact ground point niner',
    ]);
    const positions = h.atc().filter((e) => e.callsign === 'AAL212').map((e) => e.aiPosition);
    expect(positions).toEqual(['APP', 'APP', 'APP', 'TWR', 'TWR', 'TWR']);
    const gndCall = h.events.find((e) => e.speaker === 'PILOT' && e.frequencyMhz === GND_MHZ && /American two twelve, at .*request taxi to parking/.test(e.text))!;
    expect(gndCall).toBeDefined();
    expect(h.events.some((e) => e.kind === 'COMMAND_ACCEPTED' && e.callsign === 'AAL212' && e.data?.kind === 'TAXI_TO_PARKING' && e.timeSec > gndCall.timeSec)).toBe(true);
  });

  it('one ATC event per AI transmission; the AI never speaks on the player frequency; at least 3 s between a position\'s transmissions', () => {
    expectOneEventPerTransmission(h);
    expect(h.transmissions.every((t) => t.position !== 'GND' && t.frequencyMhz !== GND_MHZ)).toBe(true);
    expect(h.atc().every((e) => e.aiPosition !== 'GND' && e.frequencyMhz !== GND_MHZ)).toBe(true);
    for (const pos of ['CLNC', 'TWR', 'APP', 'DEP'] as const) {
      const times = h.transmissions.filter((t) => t.position === pos).map((t) => t.timeSec);
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(3 - 1e-6);
    }
  });

  it('(4) is deterministic: the same seed gives the same event log and transmissions', () => {
    const again = run();
    const sig = (x: Harness) => x.events.map((e) => `${e.id}|${e.timeSec}|${e.kind}|${e.aiPosition ?? ''}|${e.text}`);
    expect(sig(again)).toEqual(sig(h));
    expect(again.transmissions).toEqual(h.transmissions);
    expect(again.ai.status()).toEqual(h.ai.status());
  });
});

describe('(2) Tower-only player: AI Ground taxis the departure to the runway and hands it to the player', () => {
  const h = createHarness({
    player: ['TWR'],
    spawns: [IFR_DEP('NKS451', 'GATE-1', ['VCN']), IFR_DEP('DAL88', 'GATE-3', ['CYN'], { atSec: 20 }), IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 4000, { atSec: 150 })],
  });
  h.runUntil(allGone(h, 200), 2400, towerPlayer(h));

  it('both departures and the arrival are handled, cleanly', () => {
    expect(Object.keys(h.engine.getState().aircraft)).toHaveLength(0);
    const bad = h.events.filter((e) => ['RUNWAY_INCURSION', 'SEPARATION_VIOLATION', 'GO_AROUND'].includes(e.kind) || (e.kind === 'CONFLICT' && /UNSAFE/.test(e.text)));
    expect(bad.map((e) => e.text)).toEqual([]);
    expect(h.outcomes.filter((o) => o.out.status !== 'accepted')).toEqual([]);
    expectOneEventPerTransmission(h);
  });

  it('AI Ground taxis via Bravo, walks the aircraft across 4/22 and hands it to Tower; the holding-short call arrives on the Tower frequency', () => {
    const gnd = texts(atcAi(h, 'NKS451', 'GND'));
    expect(gnd[0]).toMatch(/^Spirit four fifty one, runway one three, taxi via .*bravo, hold short of runway four$/);
    expect(gnd[1]).toBe('Spirit four fifty one, cross runway four');
    expect(gnd[2]).toBe('Spirit four fifty one, contact tower one two zero point three');
    const hold = h.events.find((e) => e.speaker === 'PILOT' && e.callsign === 'NKS451' && /holding short runway one three, ready for departure/.test(e.text))!;
    expect(hold).toBeDefined();
    expect(hold.frequencyMhz).toBe(TWR_MHZ);
    expect(hold.text).toMatch(/^Atlantic City Tower, Spirit four fifty one, holding short runway one three, ready for departure\.$/);
    expect(hold.timeSec).toBeGreaterThan(atcAi(h, 'NKS451', 'GND')[2].timeSec);
  });

  it('the second departure takes a different hold (no queue at one hold line) and the arrival is sent to Ground after the player lands it', () => {
    const second = texts(atcAi(h, 'DAL88', 'GND'))[0];
    expect(second).toMatch(/charlie, hold short of runway four$/);
    expect(h.events.some((e) => e.kind === 'COMMAND_ACCEPTED' && e.callsign === 'AAL212' && e.data?.kind === 'CONTACT_FREQUENCY' && e.aiPosition === undefined && e.timeSec > 0)).toBe(true);
    expect(texts(atcAi(h, 'AAL212', 'GND'))[0]).toMatch(/^American two twelve, taxi to gate .* via /);
    // The arrival was handed to the player by AI Approach exactly as a human would.
    expect(texts(atcAi(h, 'AAL212', 'APP')).at(-1)).toBe('American two twelve, contact tower one two zero point three');
  });

  it('AI Departure takes the airborne departures handed over by the player', () => {
    for (const cs of ['NKS451', 'DAL88']) {
      const dep = atcAi(h, cs, 'DEP');
      expect(dep).toHaveLength(1);
      expect(dep[0].text).toMatch(/radar contact, climb and maintain one zero thousand, proceed direct (Cedar Lake|Coyle)$/);
    }
    expect(h.engine.getState().score.aircraftHandled).toBe(3);
  });

  it('the AI never transmits on the Tower frequency or as Tower', () => {
    expect(h.transmissions.every((t) => t.position !== 'TWR' && t.frequencyMhz !== TWR_MHZ)).toBe(true);
    expect(h.atc().every((e) => e.aiPosition !== 'TWR' && e.frequencyMhz !== TWR_MHZ)).toBe(true);
  });
});

describe('(3) Approach-only player: AI Tower, Ground and Clearance Delivery handle the rest', () => {
  const h = createHarness({
    player: ['APP'],
    spawns: [IFR_DEP('NKS451', 'GATE-1', ['VCN']), IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 4000, { atSec: 30 }), IFR_ARR('DAL99', 'VCN', ['VCN', 'CARYL', 'MAYBN'], '13', 5000, { atSec: 100 })],
  });
  h.runUntil(allGone(h, 200), 2400, approachPlayer(h));

  it('everything lands, taxis, departs and is handled without a safety event', () => {
    expect(Object.keys(h.engine.getState().aircraft)).toHaveLength(0);
    expectClean(h);
    expect(h.engine.getState().score.aircraftHandled).toBe(3);
    expectOneEventPerTransmission(h);
  });

  it('AI Tower takes the handed-over arrivals, in order, and releases the departure between them', () => {
    expect(texts(atcAi(h, 'AAL212', 'TWR'))).toEqual([
      'American two twelve, continue approach',
      'American two twelve, runway one three, cleared to land',
      'American two twelve, turn right at alpha, contact ground point niner',
    ]);
    const clearedTo = (cs: string) => atcAi(h, cs, 'TWR').find((e) => /cleared to land/.test(e.text))!.timeSec;
    const takeoff = atcAi(h, 'NKS451', 'TWR').find((e) => /cleared for takeoff/.test(e.text))!.timeSec;
    expect(takeoff).toBeGreaterThan(clearedTo('AAL212'));
    expect(texts(atcAi(h, 'DAL99', 'GND')).at(-1)).toMatch(/^Delta ninety nine, taxi to gate/);
  });

  it('Departure is covered by the player (shared 124.6 / 134.25), so the AI keeps off those frequencies', () => {
    expect(h.ai.status().DEP).toMatch(/covered by the player's APP/);
    expect(h.transmissions.every((t) => t.position !== 'DEP' && t.position !== 'APP')).toBe(true);
    expect(h.transmissions.every((t) => t.frequencyMhz !== APP_MHZ && t.frequencyMhz !== 134.25)).toBe(true);
    expect(h.ai.positions()).toEqual(['CLNC', 'GND', 'TWR', 'DEP']);
  });
});

describe('(5) the AI is polite to the engine', () => {
  it('a refused command is not repeated for the same aircraft within 10 s (and not announced twice in a row)', () => {
    const h = createHarness({
      player: ['GND'], rejectKinds: ['TAKEOFF'],
      spawns: [{ atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'holding_short', nodeId: 'HP13-31-B-1', runwayEnd: '13' } }],
    });
    h.run(240);
    const refused = h.outcomes.filter((o) => o.cmd.kind === 'TAKEOFF');
    expect(refused.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < refused.length; i++) expect(refused[i].timeSec - refused[i - 1].timeSec).toBeGreaterThanOrEqual(10 - 1e-6);
    // the third refusal in a row backs the AI off much longer
    expect(refused.length).toBeLessThanOrEqual(6);
  });

  it('never issues a clearance the engine would refuse as unsafe: a busy runway stays unused until it is safe', () => {
    const h = createHarness({
      player: ['GND'],
      spawns: [
        { atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'holding_short', nodeId: 'HP13-31-B-1', runwayEnd: '13' } },
        { atSec: 0, callsign: 'N482KB', type: 'C172', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'holding_short', nodeId: 'HP13-31-C-1', runwayEnd: '13' } },
        { atSec: 0, callsign: 'NKS608', type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'TWR', initialRequest: 'LANDING', start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 140, runwayEnd: '13', distanceNm: 6 } },
      ],
    });
    h.runUntil(() => aircraft(h).every((a) => a.callsign === 'NKS608' ? a.phase === 'ARRIVED' || a.phase === 'RUNWAY_EXIT' : a.phase === 'DEPARTURE') && h.now() > 60, 900);
    expect(h.engine.getState().score.unsafeInstructions).toBe(0);
    expect(h.outcomes.filter((o) => o.out.status !== 'accepted')).toEqual([]);
    expect(h.events.filter((e) => e.kind === 'GO_AROUND' || e.kind === 'RUNWAY_INCURSION' || e.kind === 'CONFLICT')).toEqual([]);
  });
});

describe('behaviour details', () => {
  it('re-issues a clearance after a faulty readback ("negative, ...") and the pilot corrects it', () => {
    const h = createHarness({
      player: ['GND'], readbackErrorRate: 1,
      spawns: [{ atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'holding_short', nodeId: 'HP13-31-B-1', runwayEnd: '13' }, flightPlan: { flightRules: 'IFR', origin: 'KACY', destination: 'KPHL', cruiseAltitudeFt: 10000, route: ['VCN'] } }],
    });
    // the aircraft has no IFR clearance on file in this setup; training would refuse the takeoff, so give it one first
    h.engine.getState().aircraft['ac-1'].flightPlan!.ifrClearance = {
      destination: 'KPHL', routeText: 'as filed', initialAltitudeFt: 2000, departureFrequencyMhz: 124.6, squawk: '2111', readBack: true, issuedAtSec: 0,
    };
    h.run(60);
    const t = texts(h.atc('TWR'));
    expect(t[0]).toBe('Spirit four fifty one, runway one three, fly runway heading, cleared for takeoff');
    expect(t[1]).toBe('negative, Spirit four fifty one, runway one three, fly runway heading, cleared for takeoff');
    expect(h.events.some((e) => e.kind === 'READBACK_ERROR' && /corrected/.test(e.text))).toBe(true);
    expect(h.find('NKS451')?.flags.readbackErrorPending).toBeFalsy();
  });

  it('3 nm behind the arrival ahead: the follower holds at the published fix (CARYL), then gets its clearance once the gap is there', () => {
    const h = createHarness({
      player: ['GND'],
      spawns: [IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 3000), IFR_ARR('DAL99', 'LEBVE', ['LEBVE', 'CARYL', 'MAYBN'], '13', 5000)],
    });
    h.runUntil(allGone(h, 100), 1800, groundPlayer(h));
    expect(Object.keys(h.engine.getState().aircraft)).toHaveLength(0);
    expectClean(h);
    const t = h.atc('APP').filter((e) => e.callsign === 'DAL99');
    expect(texts(t)).toEqual([
      'Delta ninety nine, Atlantic City Approach, radar contact, descend and maintain two thousand',
      'Delta ninety nine, hold at CARYL as published',
      'Delta ninety nine, cleared ILS runway one three approach',
      'Delta ninety nine, contact tower one two zero point three',
    ]);
    const approachOne = atcAi(h, 'AAL212', 'APP').find((e) => /cleared ILS/.test(e.text))!;
    expect(t[2].timeSec).toBeGreaterThan(approachOne.timeSec + 60);
    expect(h.events.filter((e) => /touched down runway 13/.test(e.text)).map((e) => e.callsign)).toEqual(['AAL212', 'DAL99']);
  });

  it('4.5 nm behind: the follower is slowed first (speed 140), no hold needed', () => {
    const h = createHarness({
      player: ['GND'],
      spawns: [IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 3000), IFR_ARR('DAL99', 'LEBVE', ['LEBVE', 'CARYL', 'MAYBN'], '13', 5000, { atSec: 10 })],
    });
    h.runUntil(allGone(h, 100), 1800, groundPlayer(h));
    expect(Object.keys(h.engine.getState().aircraft)).toHaveLength(0);
    expectClean(h);
    const t = texts(atcAi(h, 'DAL99', 'APP'));
    expect(t).toContain('Delta ninety nine, reduce speed to one four zero');
    expect(t.some((x) => /hold at/.test(x))).toBe(false);
    expect(h.events.filter((e) => /touched down runway 13/.test(e.text)).map((e) => e.callsign)).toEqual(['AAL212', 'DAL99']);
  });

  it.each([1, 2, 3])('career mode with pilots misreading 40%% of clearances (seed %i): every mistake is corrected, nothing unsafe happens', (seed) => {
    const h = createHarness({
      player: [], ai: ALL, mode: 'career', seed, readbackErrorRate: 0.4,
      spawns: [IFR_DEP('NKS451', 'GATE-1', ['VCN']), IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 4000, { atSec: 100 })],
    });
    h.runUntil(allGone(h, 100), 2400);
    expect(Object.keys(h.engine.getState().aircraft)).toHaveLength(0);
    expectClean(h);
    expect(h.events.filter((e) => e.kind === 'READBACK_ERROR' && e.data?.missed)).toEqual([]);
    const injected = h.events.filter((e) => e.kind === 'INFO' && e.data?.readbackError).length;
    expect(h.transmissions.filter((t) => t.text.startsWith('negative,'))).toHaveLength(injected);
    expectOneEventPerTransmission(h);
  });

  it('recovers a missed approach: Tower hands it back to Approach, Approach sends it direct to the initial fix and clears it again', () => {
    const h = createHarness({ player: ['GND'], spawns: [IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 4000)] });
    const gp = groundPlayer(h);
    let sentAround = false;
    h.runUntil(allGone(h, 100), 2400, () => {
      gp();
      const ac = h.find('AAL212');
      // an unplanned go-around right after the landing clearance (the pilot's own decision, not the AI's)
      if (!sentAround && ac?.phase === 'FINAL' && h.atc('TWR').some((e) => /cleared to land/.test(e.text))) {
        sentAround = true;
        h.say('TWR', cmd('GO_AROUND', 'AAL212'));
      }
    });
    expect(sentAround).toBe(true);
    expect(Object.keys(h.engine.getState().aircraft)).toHaveLength(0);
    const t = h.atc().filter((e) => e.callsign === 'AAL212').map((e) => `${e.aiPosition}: ${e.text}`);
    expect(t).toEqual([
      'APP: American two twelve, Atlantic City Approach, radar contact, descend and maintain two thousand',
      'APP: American two twelve, cleared ILS runway one three approach',
      'APP: American two twelve, contact tower one two zero point three',
      'TWR: American two twelve, continue approach',
      'TWR: American two twelve, runway one three, cleared to land',
      'TWR: American two twelve, contact approach one two four point six',
      'APP: American two twelve, proceed direct CARYL',
      'APP: American two twelve, cleared ILS runway one three approach',
      'APP: American two twelve, contact tower one two zero point three',
      'TWR: American two twelve, runway one three, cleared to land',
      'TWR: American two twelve, turn right at alpha, contact ground point niner',
    ]);
    const bad = h.events.filter((e) => ['CONFLICT', 'RUNWAY_INCURSION', 'SEPARATION_VIOLATION'].includes(e.kind));
    expect(bad).toEqual([]);
    expect(h.events.filter((e) => e.kind === 'GO_AROUND')).toHaveLength(1);
    expect(h.outcomes.filter((o) => o.out.status !== 'accepted')).toEqual([]);
  });

  it('hands a VFR departure to Departure and does not ask for an IFR clearance it does not need', () => {
    const h = createHarness({
      player: ['GND'],
      spawns: [{ atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'GND', start: { kind: 'parked', parkingId: 'GA-1' } }],
    });
    h.runUntil(allGone(h, 60), 1500, groundPlayer(h));
    expect(texts(h.atc('TWR'))).toEqual([
      'Cessna seven two three echo juliet, runway one three, cleared for takeoff',
      expect.stringMatching(/^Cessna seven two three echo juliet, contact departure one two four point six$/),
    ]);
    expect(h.atc('CLNC')).toHaveLength(0);
  });

  it('status() gives a short summary per AI position', () => {
    const h = createHarness({ player: ['TWR'], spawns: [IFR_DEP()] });
    h.run(10);
    const s = h.ai.status();
    expect(Object.keys(s).sort()).toEqual(['APP', 'CLNC', 'DEP', 'GND']);
    expect(s.CLNC).toMatch(/^CLNC \(AI\): 1 aircraft/);
    expect(s.APP).toMatch(/^APP \(AI\): 0 aircraft, no traffic$/);
    h.ai.dispose();
    const before = h.transmissions.length;
    h.run(60);
    expect(h.transmissions.length).toBe(before);
  });

  it('works every position when there is no player', () => {
    const h = createHarness({ player: [], ai: ALL, spawns: [IFR_DEP('NKS451', 'GATE-1', ['VCN']), IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 4000, { atSec: 200 })] });
    h.runUntil(allGone(h, 100), 2400);
    expect(Object.keys(h.engine.getState().aircraft)).toHaveLength(0);
    expectClean(h);
    expect(h.engine.getState().score.aircraftHandled).toBe(0); // with every position on AI, no aircraft is "handled" by the player (scoring counts only the player's own actions)
    expectOneEventPerTransmission(h);
  });
});
