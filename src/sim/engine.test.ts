import { describe, expect, it } from 'vitest';
import type { ParsedCommand, ScenarioAircraftSpawn } from './types';
import type { SimulationEngine } from './api';
import { createEngine } from './engine';
import { ARRIVING, cmd, find, GA_PARKED, has, HOLDING, makeEngine, makeScenario, run, runUntil } from './__fixtures__/testHelpers';
import { createTestAirport } from './__fixtures__/testAirport';
import { createBasicTrafficGenerator } from './traffic';
import { DEFAULT_PILOT_BEHAVIOUR } from './pilotBehaviour';

describe('readback errors', () => {
  const setup = (rate: number) => makeEngine({ scenario: { spawns: [HOLDING('N723EJ', 'H13', '13')] }, opts: { readbackErrorRate: rate } });

  it('a wrong readback sets the pending flag; a correct re-issue clears it and nothing is scored as missed', () => {
    const e = setup(1);
    run(e, 3);
    const ac = find(e, 'N723EJ');
    const out = e.applyCommand(cmd('LINE_UP_AND_WAIT', 'N723EJ', { runwayEnd: '13' }));
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') expect(out.readback).not.toContain('one three');
    expect(ac.flags.readbackErrorPending).toBe(true);
    expect(ac.radioState).toBe('WAITING_FOR_READBACK');
    run(e, 8); // within 20 s, and past the 5 s duplicate window
    // The correcting call is the same instruction (and is not blocked by the duplicate filter).
    const fix = e.applyCommand(cmd('LINE_UP_AND_WAIT', 'N723EJ', { runwayEnd: '13' }));
    expect(fix.status).toBe('accepted');
    if (fix.status === 'accepted') expect(fix.readback).toBe('Runway one three, line up and wait, Cessna seven two three echo juliet');
    expect(ac.flags.readbackErrorPending).toBe(false);
    expect(ac.clearances).toHaveLength(1); // no second clearance created
    run(e, 40);
    expect(e.getState().score.missedReadbackErrors).toBe(0);
    expect(e.getState().events.some((x) => x.kind === 'READBACK_ERROR' && (x.data as { corrected?: boolean }).corrected)).toBe(true);
  });

  it('an uncorrected readback error is scored as missed after 20 s', () => {
    const e = setup(1);
    run(e, 3);
    const ac = find(e, 'N723EJ');
    e.applyCommand(cmd('LINE_UP_AND_WAIT', 'N723EJ', { runwayEnd: '13' }));
    run(e, 19);
    expect(ac.flags.readbackErrorPending).toBe(true);
    expect(e.getState().score.missedReadbackErrors).toBe(0);
    run(e, 2);
    expect(ac.flags.readbackErrorPending).toBe(false);
    expect(e.getState().score.missedReadbackErrors).toBe(1);
    const ev = e.getState().events.find((x) => x.kind === 'READBACK_ERROR');
    expect(ev?.severity).toBe('warning');
    expect(e.getState().score.score).toBeLessThan(100);
    run(e, 30);
    expect(e.getState().score.missedReadbackErrors).toBe(1); // scored once
    // the clearance itself was executed as issued (the mistake was in the readback only)
    expect(ac.phase).toBe('LINE_UP_AND_WAIT');
  });

  it('default rates: 0 in training, roughly 8% in free play', () => {
    const count = (mode: 'training' | 'free_play') => {
      const e = createEngine({
        airport: createTestAirport(),
        scenario: makeScenario({ mode, seed: 99, spawns: [{ atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'airborne', pos: { x: 0, y: -2000 }, altitudeFt: 3000, headingDeg: 0, speedKt: 190, runwayEnd: '13' } }] }),
      });
      let errors = 0;
      for (let i = 0; i < 300; i++) {
        const out = e.applyCommand(cmd('HEADING', 'NKS451', { headingDeg: 10 + (i % 300) }));
        expect(out.status).toBe('accepted');
        if (find(e, 'NKS451').flags.readbackErrorPending) errors++;
        run(e, 6);
        // keep the aircraft near the airport so it is never despawned
        find(e, 'NKS451').pos = { x: 0, y: -2000 };
      }
      return errors;
    };
    expect(count('training')).toBe(0);
    const n = count('free_play');
    expect(n).toBeGreaterThan(8);
    expect(n).toBeLessThan(45);
  });
});

describe('determinism', () => {
  const script: { step: number; cmd: ParsedCommand; pos?: 'GND' | 'TWR' }[] = [
    { step: 40, cmd: cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22', route: ['A'] }), pos: 'GND' },
    { step: 100, cmd: cmd('LINE_UP_AND_WAIT', 'NKS451', { runwayEnd: '13' }) },
    { step: 220, cmd: cmd('TAKEOFF', 'NKS451', { runwayEnd: '13' }) },
    { step: 300, cmd: cmd('LAND', 'N5AA', { runwayEnd: '13' }) },
    { step: 400, cmd: cmd('HEADING', 'NKS451', { headingDeg: 200 }) },
  ];
  const spawns: ScenarioAircraftSpawn[] = [GA_PARKED(), HOLDING('NKS451', 'H13', '13', 'A320'), ARRIVING('N5AA', '13', 6)];
  const play = (seed: number): SimulationEngine => {
    const e = createEngine({ airport: createTestAirport(), scenario: makeScenario({ seed, spawns, traffic: { enabled: true, arrivalsPerHour: 60, departuresPerHour: 60, gaFraction: 0.5, maxAircraft: 12 } }), readbackErrorRate: 0.5 });
    for (let i = 0; i < 600; i++) {
      for (const s of script) if (s.step === i) e.applyCommand(s.cmd, { position: s.pos ?? 'TWR' });
      e.step();
    }
    return e;
  };

  it('two engines with the same seed and command script are identical after 600 steps', () => {
    const a = play(2024);
    const b = play(2024);
    expect(a.getState().clock.tick).toBe(600);
    expect(Object.keys(a.getState().aircraft).length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(a.getState())).toBe(JSON.stringify(b.getState()));
    expect(a.random()).toBe(b.random());
  });

  it('a different seed changes the outcome', () => {
    expect(JSON.stringify(play(2024).getState())).not.toBe(JSON.stringify(play(2025).getState()));
  });
});

describe('engine loop', () => {
  it('advance() runs whole fixed steps from a wall-clock accumulator and honours speed', () => {
    const e = makeEngine();
    e.advance(1);
    expect(e.getState().clock.tick).toBe(10);
    e.advance(0.05);
    e.advance(0.05);
    expect(e.getState().clock.tick).toBe(11);
    e.setSpeed(4);
    e.advance(1);
    expect(e.getState().clock.tick).toBe(51);
    e.setSpeed(0);
    e.advance(5);
    expect(e.getState().clock.tick).toBe(51);
    expect(e.getState().clock.timeSec).toBeCloseTo(5.1, 6);
  });

  it('keeps the last 60 positions sampled once per second', () => {
    const e = makeEngine({ scenario: { spawns: [HOLDING('NKS451', 'H13', '13', 'A320')] } });
    const ac = find(e, 'NKS451');
    run(e, 5);
    e.applyCommand(cmd('TAKEOFF', 'NKS451', { runwayEnd: '13' }));
    run(e, 100);
    expect(ac.history).toHaveLength(60);
    const last = ac.history[ac.history.length - 1];
    expect(Math.hypot(last.x - ac.pos.x, last.y - ac.pos.y)).toBeLessThan(250); // within the last second of travel
  });

  it('caps the event log at 2000 entries', () => {
    const e = makeEngine();
    for (let i = 0; i < 2500; i++) e.logEvent({ kind: 'INFO', text: `event ${i}`, severity: 'info' });
    const ev = e.getState().events;
    expect(ev).toHaveLength(2000);
    expect(ev[ev.length - 1].text).toBe('event 2499');
    expect(ev[0].text).toBe('event 500');
    expect(new Set(ev.map((x) => x.id)).size).toBe(2000);
  });

  it('emits onPilotTransmission for every pilot call', () => {
    const calls: string[] = [];
    const e = createEngine({
      airport: createTestAirport(), scenario: makeScenario({ spawns: [GA_PARKED()] }), readbackErrorRate: 0,
      onPilotTransmission: (t) => calls.push(`${t.callsign}@${t.frequencyMhz}: ${t.text}`),
    });
    run(e, 10);
    e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22', route: ['A'] }), { position: 'GND' });
    e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22', route: ['A'] }), { position: 'GND' }); // duplicate: silent
    const pilot = e.getState().events.filter((x) => x.speaker === 'PILOT');
    expect(calls).toHaveLength(pilot.length);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^N723EJ@121\.9: Atlantic City Ground, Cessna seven two three echo juliet, at general aviation Ramp one, ready to taxi/);
  });

  it('swapping controller position and active runways updates the state', () => {
    const e = makeEngine();
    e.setControllerPosition('GND');
    expect(e.getState().controllerPosition).toBe('GND');
    expect(e.getState().controllerFrequencyMhz).toBe(121.9);
    e.setActiveRunways({ departing: ['22'], landing: ['22'] });
    expect(e.getState().activeRunways.landing).toEqual(['22']);
    expect(e.getState().atis.activeRunways.departing).toEqual(['22']);
    e.selectAircraft('x');
    expect(e.getState().selectedAircraftId).toBe('x');
  });
});

describe('lifecycle and scoring of completed flights', () => {
  it('an arrival is handed to ground, taxis to parking, shuts down, and counts as handled', () => {
    const e = makeEngine({ scenario: { spawns: [ARRIVING('N723EJ', '13', 4)] } });
    const ac = find(e, 'N723EJ');
    run(e, 3);
    expect(e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13' })).status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt === 0, 400)).toBe(true);
    run(e, 5);
    expect(ac.pendingRequest?.kind).toBe('FREQUENCY_CHANGE');
    expect(e.applyCommand(cmd('CONTACT_FREQUENCY', 'N723EJ', { frequencyId: 'GND' })).status).toBe('accepted');
    expect(runUntil(e, () => ac.frequencyId === 'GND', 20)).toBe(true);
    run(e, 5);
    const checkIn = e.getState().events.filter((x) => x.speaker === 'PILOT').pop()!;
    expect(checkIn.text).toBe('Atlantic City Ground, Cessna seven two three echo juliet, at alpha, request taxi to parking.');
    expect(ac.pendingRequest?.kind).toBe('TAXI');
    const taxi = e.applyCommand(cmd('TAXI_TO_PARKING', 'N723EJ', { destination: 'GA2', route: ['A', 'B'] }), { position: 'GND' });
    expect(taxi.status).toBe('accepted');
    expect(ac.phase).toBe('TAXI_TO_PARKING');
    expect(runUntil(e, () => ac.phase === 'ARRIVED', 400)).toBe(true);
    expect(ac.groundSpeedKt).toBe(0);
    expect(has(e, 'N723EJ')).toBe(true); // stays at the stand while the stand is occupied (arrivedLingerSec)
    expect(runUntil(e, () => !has(e, 'N723EJ'), DEFAULT_PILOT_BEHAVIOUR.ground.arrivedLingerSec + 5)).toBe(true);
    const s = e.getState().score;
    expect(s.aircraftHandled).toBe(1);
    expect(s.correctClearances).toBe(3);
    expect(s.runwayIncursions).toBe(0);
    expect(s.score).toBe(100);
    expect(s.averageWaitSec).toBeGreaterThan(0);
    expect(s.scenarioCompleted).toBe(true);
  });

  it('a departure handed to departure control is counted as handled when it leaves; otherwise it is not', () => {
    const mk = (handoff: boolean) => {
      const e = makeEngine({
        scenario: {
          spawns: [{ atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: true, initialFrequencyId: 'TWR',
            start: { kind: 'airborne', pos: { x: 0, y: -24000 }, altitudeFt: 3000, headingDeg: 180, speedKt: 190, runwayEnd: '13' } }],
        },
      });
      if (handoff) {
        expect(e.applyCommand(cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyMhz: 124.6, frequencyId: 'APP' })).status).toBe('accepted');
      }
      run(e, 120);
      return e;
    };
    const handed = mk(true);
    expect(has(handed, 'NKS451')).toBe(false);
    expect(handed.getState().score.aircraftHandled).toBe(1);
    const lost = mk(false);
    expect(has(lost, 'NKS451')).toBe(false);
    expect(lost.getState().score.aircraftHandled).toBe(0);
  });
});

describe('traffic generation', () => {
  it('spawns arrivals and departures from scenario.traffic, respects maxAircraft, and is deterministic', () => {
    const mkState = () => {
      const e = createEngine({
        airport: createTestAirport(),
        scenario: makeScenario({ seed: 7, traffic: { enabled: true, arrivalsPerHour: 120, departuresPerHour: 120, gaFraction: 0.5, maxAircraft: 4 } }),
        trafficGenerator: createBasicTrafficGenerator(),
      });
      run(e, 600);
      return e;
    };
    const a = mkState();
    const b = mkState();
    const spawned = a.getState().events.filter((x) => x.kind === 'SPAWN');
    expect(spawned.length).toBeGreaterThan(3);
    expect(Object.keys(a.getState().aircraft).length).toBeLessThanOrEqual(4);
    expect(a.getState().events.map((x) => x.text)).toEqual(b.getState().events.map((x) => x.text));
  });

  it('a custom TrafficGenerator can be plugged in', () => {
    let calls = 0;
    const e = createEngine({
      airport: createTestAirport(), scenario: makeScenario(),
      trafficGenerator: { update: (s) => (calls++ === 5 ? [{ atSec: s.clock.timeSec, callsign: 'N123AB', type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: 'GA3' }, isDeparture: true, initialFrequencyId: 'GND' }] : []) },
    });
    run(e, 2);
    expect(has(e, 'N123AB')).toBe(true);
  });
});
