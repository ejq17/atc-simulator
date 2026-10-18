import { describe, expect, it } from 'vitest';
import type { ScenarioAircraftSpawn } from './types';
import { ARRIVING, cmd, find, GA_PARKED, HOLDING, makeEngine, run, runUntil } from './__fixtures__/testHelpers';
import { assessClearanceSafety } from './conflicts';
import { computeScore, SCORE_WEIGHTS } from './scoring';
import { createTestAirport } from './__fixtures__/testAirport';
import { createEngine } from './engine';
import { loadKacy } from '../airport';
import { dist } from './geo';

const airport = createTestAirport();

/** N1 lined up on 13 at the threshold; N2 holding short of 13 at the D intersection. */
function occupiedRunwayScenario(mode: 'training' | 'free_play') {
  const e = makeEngine({ scenario: { mode, spawns: [HOLDING('N1AA', 'H13', '13'), HOLDING('N2BB', 'D_h13S', '13')] } });
  run(e, 3);
  expect(e.applyCommand(cmd('LINE_UP_AND_WAIT', 'N1AA', { runwayEnd: '13' })).status).toBe('accepted');
  run(e, 25);
  return e;
}

describe('takeoff / landing safety', () => {
  it('takeoff clearance with the runway occupied is REJECTED in training with a 7110.65 reference', () => {
    const e = occupiedRunwayScenario('training');
    const out = e.applyCommand(cmd('TAKEOFF', 'N2BB', { runwayEnd: '13' }));
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.unsafe).toBe(true);
      expect(out.reason).toMatch(/occupied by N1AA/);
      expect(out.reason).toMatch(/3-9-6/);
      expect(out.reason).toMatch(/same runway separation/);
    }
    expect(find(e, 'N2BB').phase).toBe('HOLDING_SHORT');
    expect(find(e, 'N2BB').clearances).toHaveLength(0);
    expect(e.getState().conflicts.some((c) => c.kind === 'UNSAFE_CLEARANCE')).toBe(true);
  });

  it('takeoff clearance with the runway occupied is ACCEPTED, flagged and scored in free play', () => {
    const e = occupiedRunwayScenario('free_play');
    const scoreBefore = e.getState().score.score;
    const out = e.applyCommand(cmd('TAKEOFF', 'N2BB', { runwayEnd: '13' }));
    expect(out.status).toBe('accepted');
    const st = e.getState();
    expect(st.conflicts.map((c) => c.kind)).toEqual(expect.arrayContaining(['RUNWAY_CONFLICT', 'UNSAFE_CLEARANCE']));
    const unsafe = st.conflicts.find((c) => c.kind === 'UNSAFE_CLEARANCE')!;
    expect(unsafe.aircraftIds).toContain(find(e, 'N2BB').id);
    expect(unsafe.severity).toBe('critical');
    expect(st.events.some((x) => x.kind === 'CONFLICT' && (x.data as { alertKind?: string }).alertKind === 'UNSAFE_CLEARANCE')).toBe(true);
    run(e, 1);
    expect(e.getState().score.unsafeInstructions).toBe(1);
    expect(scoreBefore).toBe(100);
    expect(e.getState().score.score).toBe(100 - 15 + 2); // unsafe instruction -15, one correct clearance +2
    expect(e.getState().score.score).toBeLessThan(100);
    expect(e.getState().score.correctClearances).toBe(1); // only the safe LUAW counted
  });

  it('takeoff clearance with an arrival inside 2 nm final is unsafe; at 3 nm it is fine', () => {
    for (const [nm, unsafe] of [[1.5, true], [3, false]] as const) {
      const e = makeEngine({ scenario: { mode: 'training', spawns: [HOLDING('N1AA', 'H13', '13'), ARRIVING('N5CC', '13', nm)] } });
      run(e, 2);
      const out = e.applyCommand(cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' }));
      expect(out.status).toBe(unsafe ? 'rejected' : 'accepted');
      if (out.status === 'rejected') expect(out.reason).toMatch(/final for runway 13\/31/);
    }
  });

  it('landing clearance with the runway occupied cites the landing-clearance topic', () => {
    const e = makeEngine({ scenario: { mode: 'training', spawns: [HOLDING('N1AA', 'H13', '13'), ARRIVING('N5CC', '13', 5)] } });
    run(e, 2);
    e.applyCommand(cmd('LINE_UP_AND_WAIT', 'N1AA', { runwayEnd: '13', trafficAdvised: true }));
    run(e, 25);
    const out = e.applyCommand(cmd('LAND', 'N5CC', { runwayEnd: '13' }));
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.unsafe).toBe(true);
      expect(out.reason).toMatch(/3-10-3/);
    }
    expect(find(e, 'N5CC').runwayAuthorizations).toEqual([]);
  });

  it('simultaneous use of crossing runways 13/31 and 4/22 is detected', () => {
    const mk = (mode: 'training' | 'free_play') => {
      const e = makeEngine({ scenario: { mode, spawns: [HOLDING('N1AA', 'H13', '13'), HOLDING('N2BB', 'H22', '22')] } });
      run(e, 3);
      expect(e.applyCommand(cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' })).status).toBe('accepted');
      return e;
    };
    const t = mk('training');
    const rej = t.applyCommand(cmd('TAKEOFF', 'N2BB', { runwayEnd: '22' }));
    expect(rej.status).toBe('rejected');
    if (rej.status === 'rejected') {
      expect(rej.unsafe).toBe(true);
      expect(rej.reason).toMatch(/before N1AA departing runway 13\/31 has passed the intersection/);
    }
    const f = mk('free_play');
    expect(f.applyCommand(cmd('TAKEOFF', 'N2BB', { runwayEnd: '22' })).status).toBe('accepted');
    const kinds = f.getState().conflicts.map((c) => c.kind);
    expect(kinds).toContain('RUNWAY_CONFLICT');
    expect(kinds).toContain('UNSAFE_CLEARANCE');
    // the same assessment is available as a pure function (and is symmetric)
    const a = assessClearanceSafety(f.getState(), cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' }));
    expect(a.safe).toBe(false);
    expect(a.issues[0].reference).toContain('3-9-8');
  });

  it('assessClearanceSafety is pure and reports reasons', () => {
    const e = occupiedRunwayScenario('free_play');
    const before = JSON.stringify(e.getState().aircraft);
    const a = assessClearanceSafety(e.getState(), cmd('TAKEOFF', 'N2BB', { runwayEnd: '13' }));
    expect(a.safe).toBe(false);
    expect(a.issues[0].kind).toBe('RUNWAY_CONFLICT');
    expect(a.issues[0].reference).toContain('3-9-6');
    expect(JSON.stringify(e.getState().aircraft)).toBe(before);
    expect(assessClearanceSafety(e.getState(), cmd('HEADING', 'N2BB', { headingDeg: 10 })).safe).toBe(true);
    expect(assessClearanceSafety(e.getState(), cmd('TAKEOFF', 'NOBODY', { runwayEnd: '13' })).safe).toBe(true);
  });

  it('crossing a runway in front of a close arrival is unsafe', () => {
    const e = makeEngine({ scenario: { mode: 'free_play', spawns: [GA_PARKED()] } });
    const ac = find(e, 'N723EJ');
    run(e, 10);
    e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY4', runwayEnd: '4', route: ['A'] }), { position: 'GND' });
    expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT', 200)).toBe(true);
    e.spawnAircraft(ARRIVING('N5CC', '13', 2));
    const out = e.applyCommand(cmd('CROSS_RUNWAY', 'N723EJ', { crossRunwayId: '13/31' }), { position: 'GND' });
    expect(out.status).toBe('accepted');
    expect(e.getState().conflicts.some((c) => c.kind === 'UNSAFE_CLEARANCE' && /3-7-2/.test(c.text))).toBe(true);
  });
});

describe('dynamic conflict detection', () => {
  it('flags a runway incursion for an aircraft on a runway without clearance', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED()] } });
    const ac = find(e, 'N723EJ');
    run(e, 3);
    // Test hook: put the taxiing aircraft on the 13/31 surface.
    ac.pos = { ...airport.taxiwayGraph.nodes.A_r13.pos };
    run(e, 1);
    const st = e.getState();
    expect(st.conflicts.some((c) => c.kind === 'RUNWAY_INCURSION' && c.runwayId === '13/31')).toBe(true);
    expect(st.events.filter((x) => x.kind === 'RUNWAY_INCURSION')).toHaveLength(1);
    run(e, 5);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION')).toHaveLength(1); // not re-emitted every tick
    expect(e.getState().score.runwayIncursions).toBe(1);
    expect(e.getState().score.score).toBeLessThanOrEqual(75);
    expect(ac.occupyingRunways).toContain('13/31');
    expect(e.getState().runwayOccupancy['13/31'].occupants).toContain(ac.id);
  });

  it('flags ground proximity under 30 m but never for parked aircraft', () => {
    const parked = makeEngine({ scenario: { spawns: [GA_PARKED('N1AA', 'GA1'), GA_PARKED('N2BB', 'GA2')] } });
    run(parked, 1);
    find(parked, 'N1AA').pos = { x: find(parked, 'N2BB').pos.x + 10, y: find(parked, 'N2BB').pos.y };
    run(parked, 2);
    expect(parked.getState().conflicts.filter((c) => c.kind === 'GROUND_PROXIMITY')).toHaveLength(0);

    const e = makeEngine({ scenario: { spawns: [HOLDING('N1AA', 'H13', '13'), HOLDING('N2BB', 'D_h13S', '13')] } });
    run(e, 2);
    expect(e.getState().conflicts).toHaveLength(0);
    const b = find(e, 'N2BB');
    find(e, 'N1AA').pos = { x: b.pos.x + 12, y: b.pos.y + 5 };
    run(e, 1);
    const g = e.getState().conflicts.filter((c) => c.kind === 'GROUND_PROXIMITY');
    expect(g).toHaveLength(1);
    expect(e.getState().score.separationViolations).toBe(1);
  });

  it('flags airborne proximity (< 1.5 nm and < 500 ft)', () => {
    const mk = (y: number, alt: number): ScenarioAircraftSpawn => ({
      atSec: 0, callsign: 'N9', type: 'C172', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'TWR',
      start: { kind: 'airborne', pos: { x: 0, y }, altitudeFt: alt, headingDeg: 0, speedKt: 90, runwayEnd: '13' },
    });
    const e = makeEngine({ scenario: { spawns: [{ ...mk(-18000, 3000), callsign: 'N1AA' }, { ...mk(-18000 + 1000, 3200), callsign: 'N2BB' }, { ...mk(-18000 + 20000, 6000), callsign: 'N3CC' }] } });
    run(e, 1);
    const air = e.getState().conflicts.filter((c) => c.kind === 'AIRBORNE_PROXIMITY');
    expect(air).toHaveLength(1);
    expect(air[0].text).toMatch(/N1AA and N2BB|N2BB and N1AA/);
    expect(e.getState().score.separationViolations).toBe(1);
    // vertical separation resolves it
    e.applyCommand(cmd('ALTITUDE', 'N2BB', { altitudeFt: 5000 }));
    run(e, 120);
    expect(e.getState().conflicts.filter((c) => c.kind === 'AIRBORNE_PROXIMITY')).toHaveLength(0);
  });
});

describe('scoring formula', () => {
  it('weights safety events and clamps to 0..100', () => {
    const card = { aircraftHandled: 0, correctClearances: 0, communicationErrors: 0, runwayIncursions: 0, separationViolations: 0, unsafeInstructions: 0, missedReadbackErrors: 0, averageWaitSec: 0, totalDelaySec: 0, scenarioCompleted: false, score: 100 };
    expect(computeScore(card)).toBe(100);
    expect(computeScore({ ...card, runwayIncursions: 1 })).toBe(100 + SCORE_WEIGHTS.runwayIncursion);
    expect(computeScore({ ...card, unsafeInstructions: 1, communicationErrors: 2 })).toBe(100 - 15 - 4);
    expect(computeScore({ ...card, separationViolations: 1, missedReadbackErrors: 1 })).toBe(85);
    expect(computeScore({ ...card, runwayIncursions: 1, correctClearances: 5, aircraftHandled: 1 })).toBe(100 - 25 + 10 + 5);
    expect(computeScore({ ...card, runwayIncursions: 10 })).toBe(0);
    expect(computeScore({ ...card, correctClearances: 50 })).toBe(100);
  });

  it('counts correct clearances, communication errors and handled aircraft from events', () => {
    const e = makeEngine({ scenario: { spawns: [HOLDING('N1AA', 'H13', '13')] } });
    run(e, 3);
    e.applyCommand(cmd('LINE_UP_AND_WAIT', 'N1AA', { runwayEnd: '13' }));
    e.applyCommand(cmd('TAKEOFF', 'N1AA', { runwayEnd: '31' })); // wrong end -> controller error
    e.applyCommand(cmd('HEADING', 'N1AA', { headingDeg: 90 })); // on the ground -> controller error
    run(e, 1);
    const s = e.getState().score;
    expect(s.correctClearances).toBe(1);
    expect(s.communicationErrors).toBe(2);
    expect(s.score).toBe(98); // 100 - 2*2 + 2
  });
});

describe('hold-short queue on the ground (real KACY, runway 31 from B)', () => {
  it('an A320 taxiing up behind a stopped C172 at the hold line stops a following distance back and raises no GROUND_PROXIMITY alert', () => {
    const e = createEngine({
      airport: loadKacy(), readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 9, 17, 16, 0, 0),
      scenario: {
        id: 'q', name: 'q', description: 'q', mode: 'training', seed: 5,
        weather: { source: 'simulated', windDirDeg: 310, windSpeedKt: 6, visibilitySm: 10, clouds: [], temperatureC: 15, dewpointC: 5, altimeterInHg: 29.92, phenomena: [], flightCategory: 'VFR' },
        activeRunways: { departing: ['31'], landing: ['31'] }, controllerPositions: ['TWR', 'GND'], playerPositions: ['GND'],
        spawns: [
          HOLDING('N451NL', 'HP13-31-B-2', '31', 'C172', 'TWR'),
          { atSec: 0, callsign: 'AAL1727', type: 'A320', flightRules: 'IFR', isDeparture: true, initialFrequencyId: 'GND', start: { kind: 'parked', parkingId: 'GATE-1' } },
        ],
      },
    });
    run(e, 3);
    const [a, c] = [find(e, 'AAL1727'), find(e, 'N451NL')];
    expect(e.applyCommand(cmd('TAXI', 'AAL1727', { destination: 'RWY31', runwayEnd: '31', route: [] }), { position: 'GND' }).status).toBe('accepted');
    let minGap = Infinity;
    for (let i = 0; i < 400; i++) {
      run(e, 1);
      minGap = Math.min(minGap, dist(a.pos, c.pos));
    }
    expect(e.getState().conflicts.filter((x) => x.kind === 'GROUND_PROXIMITY')).toHaveLength(0);
    expect(minGap).toBeGreaterThan(1.5 * 37.6 + 20 - 5); // the taxi model's following distance
    expect(a.groundSpeedKt).toBeLessThan(1);
  });
});
