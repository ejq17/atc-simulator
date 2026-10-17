/**
 * Arrivals must never be stranded: generated traffic checks in with Approach only when Approach is staffed, and an IFR
 * go-around with nobody on Approach is re-sequenced by Tower (pattern re-entry on the active runway). From a real session where
 * an arrival went around four times and others sat on an unstaffed Approach frequency for good.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from '../sim/engine';
import { loadKacy } from '../airport';
import { buildCatalogueScenario } from '../game/scenarios';
import { createAiControllers } from './index';
import type { Scenario, ScenarioAircraftSpawn } from '../sim/types';

describe('nobody works Approach', () => {
  it('generated arrivals check in with Tower, not with an unstaffed Approach, and none is stranded after 25 minutes', () => {
    const kacy = loadKacy();
    const sc = buildCatalogueScenario('free-play-busy-arrivals', kacy, { seed: 21, playerPositions: ['GND'] });
    expect(sc.controllerPositions).not.toContain('APP');
    const engine = createEngine({ airport: kacy, scenario: sc, readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 9, 17, 19, 0, 0) });
    const ai = createAiControllers({ engine, airport: kacy, positions: sc.controllerPositions.filter((p) => p !== 'GND'), playerPositions: ['GND'], seed: 21 });
    engine.subscribe((s) => ai.update(s));
    const n = Math.round(1 / engine.getState().clock.dtSec);
    for (let sec = 0; sec < 1500; sec++) for (let i = 0; i < n; i++) engine.step();
    const st = engine.getState();
    for (const a of Object.values(st.aircraft)) expect(a.frequencyId, `${a.callsign} on ${a.frequencyId}`).not.toBe('APP');
    const stranded = Object.values(st.aircraft).filter((a) => !a.onGround && !a.isDeparture && a.phase === 'GO_AROUND' && a.pendingRequest && st.clock.timeSec - a.pendingRequest.sinceSec > 120);
    expect(stranded.map((a) => a.callsign)).toEqual([]);
  }, 180_000);

  it('Tower re-sequences an IFR go-around itself and lands it when the scenario has no Approach position', () => {
    const kacy = loadKacy();
    const arrival: ScenarioAircraftSpawn = {
      atSec: 0, callsign: 'NKS327', type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'TWR',
      start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 160, runwayEnd: '13', distanceNm: 5 },
      flightPlan: { flightRules: 'IFR', origin: 'KPHL', destination: 'KACY', cruiseAltitudeFt: 10000, route: ['ACY'] },
    };
    const scenario: Scenario = {
      id: 'ga-test', name: 'go-around', description: 'IFR go-around, Tower and Ground only', mode: 'free_play', seed: 7,
      weather: { source: 'simulated', windDirDeg: 130, windSpeedKt: 4, visibilitySm: 10, clouds: [{ cover: 'SCT', baseFtAgl: 5000 }], temperatureC: 15, dewpointC: 5, altimeterInHg: 29.92, phenomena: [], flightCategory: 'VFR' },
      activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['TWR', 'GND'], playerPositions: ['GND'], spawns: [arrival],
    };
    const engine = createEngine({ airport: kacy, scenario, readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 5, 1, 16, 0, 0) });
    const ai = createAiControllers({ engine, airport: kacy, positions: ['TWR'], playerPositions: ['GND'], seed: 7 });
    engine.subscribe((s) => ai.update(s));
    const n = Math.round(1 / engine.getState().clock.dtSec);
    const runUntil = (pred: () => boolean, maxSec: number) => { for (let s = 0; s < maxSec; s++) { if (pred()) return true; for (let i = 0; i < n; i++) engine.step(); } return pred(); };
    const ac = () => Object.values(engine.getState().aircraft).find((a) => a.callsign === 'NKS327')!;
    expect(runUntil(() => ac().phase === 'FINAL', 300)).toBe(true);
    engine.applyCommand({ kind: 'GO_AROUND', callsign: 'NKS327', confidence: 1, rawText: '', normalizedText: '', issues: [] }, { position: 'TWR' });
    expect(ac().phase).toBe('GO_AROUND');
    // Tower works the missed approach itself (radar contact, direct to the approach fix, approach / landing clearance): no handoff to a frequency nobody answers.
    expect(runUntil(() => ac().onGround, 1500)).toBe(true);
    const atc = engine.getState().events.filter((e) => e.kind === 'TRANSMISSION' && e.speaker === 'ATC' && e.aiPosition === 'TWR').map((e) => e.text);
    expect(atc.some((t) => /contact approach/i.test(t))).toBe(false);
    expect(atc.some((t) => /cleared to land/i.test(t))).toBe(true);
    expect(engine.getState().events.filter((e) => e.kind === 'HANDOFF' && e.callsign === 'NKS327')).toHaveLength(0);
  });
});
