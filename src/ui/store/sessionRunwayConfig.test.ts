/**
 * A runway configuration chosen in the middle of a free-play session on a multi-runway airport reaches the ATIS and the AI positions together (synthetic fixture airport):
 * the ATIS gets a new letter that names the new runways, the engine state the AI reads carries the same runways, and the AI Tower and Ground work the new configuration.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { game } from '../../game';
import { createEngine } from '../../sim/engine';
import { createMultiRunwayAirport } from '../../sim/__fixtures__/multiRunwayAirport';
import { createPilotSink, startSession } from './session';
import type { Session } from './session';
import type { SimEvent } from '../../sim/types';

const airport = createMultiRunwayAirport();
let session: Session | null = null;
afterAll(() => { session?.dispose(); session = null; });

function build() {
  const sc = game.buildFreePlay(airport, {
    seed: 3, weather: 'clear', aircraftCount: 0, maxAircraft: 4, arrivalsPerHour: 0, departuresPerHour: 0, difficulty: 'normal', startingScenario: 'quiet',
    activeRunways: { departing: ['27L'], landing: ['27R'] }, airportEvents: false, startUtcMs: Date.UTC(2026, 5, 1, 15),
    specialTraffic: { helicopter: false, military: false, transition: false, training: false, vehicles: false },
  });
  sc.controllerPositions = ['CLNC', 'GND', 'TWR', 'APP', 'DEP'];
  sc.playerPositions = ['CLNC'];
  sc.pilotBehaviour = { ground: { holdShortOmitFraction: 0, unfamiliarFraction: 0, taxiwayErrorShare: 0 } };
  sc.spawns = [{ atSec: 0, callsign: 'N411AB', type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: 'GA1' }, isDeparture: true, initialFrequencyId: 'GND' }];
  const { sink, onPilotTransmission } = createPilotSink();
  const engine = createEngine({ airport, scenario: sc, onPilotTransmission, readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 5, 1, 15) });
  const letters: string[] = [];
  session = startSession({
    engine, scenario: sc, controller: { positions: ['CLNC'] }, startUtcMs: Date.UTC(2026, 5, 1, 15), atisLetter: 'B', training: null, pilotSink: sink, enableVoice: false,
    hooks: {
      onRev() {}, onVoiceStatus() {}, onPartial() {}, onTransmitting() {}, onTransmitResult() {}, onTraining() {}, onAtis: (a) => letters.push(a.letter),
      onScenarioComplete() {}, onNotice() {},
    },
  });
  return { engine, letters };
}

describe('runway configuration changed in a session', () => {
  const { engine, letters } = build();
  const events: SimEvent[] = [];
  let seen = 0;
  const step = (n: number) => {
    for (let i = 0; i < n; i++) {
      engine.step();
      for (const e of engine.getState().events) {
        const k = Number(e.id.replace('ev-', ''));
        if (k > seen) { seen = k; events.push(e); }
      }
    }
  };
  step(700); // 70 s: the departure has been cleared to taxi to 27L and is on its way
  const atisBefore = session!.atis;
  const toTaxi27 = events.some((e) => e.kind === 'TRANSMISSION' && e.aiPosition === 'GND' && /runway two seven left/.test(e.text));
  const changedAt = engine.getState().clock.timeSec;
  session!.setActiveRunways({ departing: ['9R'], landing: ['9L'] });
  step(6000); // 600 s

  it('the departure was on its way to the old runway when the configuration changed', () => {
    expect(toTaxi27).toBe(true);
    expect(atisBefore.activeRunways).toEqual({ departing: ['27L'], landing: ['27R'] });
  });

  it('the ATIS has a new letter and the new runways, in the session and in the engine the AI positions read', () => {
    expect(letters).toEqual(['B', 'C']);
    expect(session!.atis.letter).toBe('C');
    expect(session!.atis.activeRunways).toEqual({ departing: ['9R'], landing: ['9L'] });
    expect(session!.atis.text).toMatch(/runway 9L|runway niner left|nine left/i);
    expect(engine.getState().atis.letter).toBe('C');
    expect(engine.getState().atis.activeRunways).toEqual({ departing: ['9R'], landing: ['9L'] });
    expect(engine.getState().activeRunways).toEqual({ departing: ['9R'], landing: ['9L'] });
  });

  it('AI Ground routes the aircraft to the new runway and AI Tower clears it there, never on the old one', () => {
    const atc = events.filter((e) => e.kind === 'TRANSMISSION' && e.speaker === 'ATC' && e.timeSec > changedAt);
    expect(atc.some((e) => e.aiPosition === 'GND' && /runway niner right/.test(e.text))).toBe(true);
    expect(atc.some((e) => e.aiPosition === 'TWR' && /runway niner right, cleared for takeoff/.test(e.text))).toBe(true);
    expect(atc.some((e) => /runway two seven left, cleared for takeoff/.test(e.text))).toBe(false);
  });
});
