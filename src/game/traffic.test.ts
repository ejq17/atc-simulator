import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import type { TrafficGenerator, SpawnSpec } from '../sim/traffic';
import type { Scenario } from '../sim/types';
import { findRunwayEnd } from '../sim/runways';
import { game } from './game';
import { MIN_SPAWN_SPACING_SEC, rampFactor } from './traffic';
import { callsignTail, NM } from './world';

const airport = loadKacy();

function scenarioWith(over: Partial<Scenario['traffic']> & { seed?: number; difficulty?: 'easy' | 'normal' | 'hard'; types?: string[]; runways?: string }): Scenario {
  const fp = game.buildFreePlay(airport, {
    seed: over.seed ?? 5, weather: 'clear', aircraftCount: 0, difficulty: over.difficulty ?? 'normal', aircraftTypes: over.types,
    arrivalsPerHour: over.arrivalsPerHour ?? 14, departuresPerHour: over.departuresPerHour ?? 14, gaFraction: over.gaFraction ?? 0.5, maxAircraft: over.maxAircraft ?? 8,
    activeRunways: over.runways ? { departing: [over.runways], landing: [over.runways] } : undefined,
  });
  return fp;
}

interface Recorded { spec: SpawnSpec; others: { pos: { x: number; y: number }; air: boolean; arrival: boolean; cs: string; onGround: boolean }[]; count: number; time: number }

/** Run the real engine for `sec` seconds with the generator wrapped in a recorder. */
function simulate(sc: Scenario, sec: number): { recs: Recorded[]; maxCount: number } {
  const inner = game.createTrafficGenerator(sc, airport);
  const recs: Recorded[] = [];
  let engineRef: ReturnType<typeof createEngine> | undefined;
  const wrapped: TrafficGenerator = {
    update(state) {
      const out = inner.update(state);
      for (const spec of out) {
        recs.push({
          spec, time: state.clock.timeSec, count: Object.keys(state.aircraft).length,
          others: Object.values(state.aircraft).map((a) => ({ pos: { ...a.pos }, air: !a.onGround, arrival: !a.isDeparture, cs: a.callsign, onGround: a.onGround })),
        });
      }
      return out;
    },
  };
  const engine = createEngine({ airport, scenario: sc, trafficGenerator: wrapped });
  engineRef = engine;
  let maxCount = 0;
  for (let i = 0; i < sec * 10; i++) {
    engineRef.step();
    if (i % 10 === 0) maxCount = Math.max(maxCount, Object.keys(engineRef.getState().aircraft).length);
  }
  return { recs, maxCount };
}

describe('traffic generator', () => {
  const sc = scenarioWith({ seed: 11 });
  const run1 = simulate(sc, 1800);

  it('spawns a believable amount of traffic and both kinds', () => {
    expect(run1.recs.length).toBeGreaterThanOrEqual(8);
    expect(run1.recs.some((r) => r.spec.isDeparture)).toBe(true);
    expect(run1.recs.some((r) => !r.spec.isDeparture)).toBe(true);
  });

  it('is deterministic: same seed => identical spawn list; a different seed differs', () => {
    const again = simulate(scenarioWith({ seed: 11 }), 1800);
    expect(again.recs.map((r) => r.spec)).toEqual(run1.recs.map((r) => r.spec));
    const other = simulate(scenarioWith({ seed: 12 }), 1800);
    expect(other.recs.map((r) => r.spec.callsign)).not.toEqual(run1.recs.map((r) => r.spec.callsign));
  });

  it('never exceeds maxAircraft', () => {
    for (const max of [3, 5, 8]) {
      const r = simulate(scenarioWith({ seed: 3, maxAircraft: max, arrivalsPerHour: 40, departuresPerHour: 40 }), 1800);
      expect(r.maxCount).toBeLessThanOrEqual(max);
      for (const rec of r.recs) expect(rec.count).toBeLessThan(max);
    }
  });

  it('staggers spawns at least 45 s apart', () => {
    const r = simulate(scenarioWith({ seed: 4, arrivalsPerHour: 60, departuresPerHour: 60, maxAircraft: 30 }), 1800);
    expect(r.recs.length).toBeGreaterThan(10);
    for (let i = 1; i < r.recs.length; i++) expect(r.recs[i].time - r.recs[i - 1].time).toBeGreaterThanOrEqual(MIN_SPAWN_SPACING_SEC - 1e-6);
  });

  it('keeps callsigns unique and not sound-alike with active traffic', () => {
    const r = simulate(scenarioWith({ seed: 6, arrivalsPerHour: 50, departuresPerHour: 50, maxAircraft: 30 }), 1800);
    const seen = new Set<string>();
    for (const rec of r.recs) {
      expect(seen.has(rec.spec.callsign)).toBe(false);
      seen.add(rec.spec.callsign);
      expect(rec.others.some((o) => callsignTail(o.cs) === callsignTail(rec.spec.callsign))).toBe(false);
      expect(rec.spec.callsign).toMatch(rec.spec.type === 'C172' ? /^N\d{1,4}[A-Z]{0,2}$/ : /^(NKS|AAL)\d{3,4}$/);
    }
  });

  it('places arrivals 10-12 nm out at 2,500-3,000 ft, 3 nm clear of other airborne traffic', () => {
    const r = simulate(scenarioWith({ seed: 8, arrivalsPerHour: 40, departuresPerHour: 4, maxAircraft: 30 }), 1800);
    const arrivals = r.recs.filter((x) => !x.spec.isDeparture);
    expect(arrivals.length).toBeGreaterThan(8);
    for (const rec of arrivals) {
      const st = rec.spec.start;
      expect(st.kind).toBe('airborne');
      if (st.kind !== 'airborne') continue;
      const g = findRunwayEnd(airport, st.runwayEnd)!;
      const d = Math.hypot(st.pos.x - g.end.threshold.x, st.pos.y - g.end.threshold.y) / NM;
      expect(d).toBeGreaterThanOrEqual(9.9);
      expect(d).toBeLessThanOrEqual(12.1);
      expect(st.altitudeFt).toBeGreaterThanOrEqual(2500);
      expect(st.altitudeFt).toBeLessThanOrEqual(3000);
      expect(st.speedKt).toBe(rec.spec.type === 'C172' ? 100 : 170);
      for (const o of rec.others.filter((x) => x.air)) expect(Math.hypot(o.pos.x - st.pos.x, o.pos.y - st.pos.y) / NM).toBeGreaterThanOrEqual(3);
      expect(rec.spec.initialFrequencyId).toBe('TWR');
      expect(rec.spec.initialRequest).toBe('LANDING');
    }
    // some on the centreline, some on a base-leg offset
    expect(arrivals.some((a) => a.spec.start.kind === 'airborne' && a.spec.start.distanceNm !== undefined)).toBe(true);
    expect(arrivals.some((a) => a.spec.start.kind === 'airborne' && a.spec.start.distanceNm === undefined)).toBe(true);
  });

  it('puts departures on free parking of the right kind', () => {
    const r = simulate(scenarioWith({ seed: 9, arrivalsPerHour: 4, departuresPerHour: 50, maxAircraft: 30 }), 1800);
    const deps = r.recs.filter((x) => x.spec.isDeparture);
    expect(deps.length).toBeGreaterThan(8);
    for (const rec of deps) {
      const st = rec.spec.start;
      expect(st.kind).toBe('parked');
      if (st.kind !== 'parked') continue;
      const p = airport.parking.find((x) => x.id === st.parkingId)!;
      expect(p).toBeDefined();
      expect(rec.spec.type === 'C172' ? ['ga', 'fbo'] : ['airline']).toContain(p.category);
      for (const o of rec.others.filter((x) => x.onGround)) expect(Math.hypot(o.pos.x - p.pos.x, o.pos.y - p.pos.y)).toBeGreaterThanOrEqual(20);
      expect(rec.spec.initialFrequencyId).toBe('GND');
      expect(rec.spec.initialRequest).toBe('TAXI');
    }
  });

  it('never sends an A320 departure to short runway 4/22 and honours aircraftTypes', () => {
    const r = simulate(scenarioWith({ seed: 10, runways: '22', gaFraction: 0.2, arrivalsPerHour: 10, departuresPerHour: 40, maxAircraft: 30 }), 1800);
    const jetDeps = r.recs.filter((x) => x.spec.isDeparture && x.spec.type === 'A320');
    expect(jetDeps).toEqual([]);
    expect(r.recs.some((x) => !x.spec.isDeparture && x.spec.type === 'A320')).toBe(true);
    const ga = simulate(scenarioWith({ seed: 10, types: ['C172'], maxAircraft: 30, arrivalsPerHour: 30, departuresPerHour: 30 }), 1200);
    expect(ga.recs.every((x) => x.spec.type === 'C172')).toBe(true);
    const jets = simulate(scenarioWith({ seed: 10, types: ['A320'], maxAircraft: 30, arrivalsPerHour: 30, departuresPerHour: 30 }), 1200);
    expect(jets.recs.every((x) => x.spec.type === 'A320')).toBe(true);
  });

  it('ramps intensity with difficulty and time', () => {
    for (const d of ['easy', 'normal', 'hard'] as const) {
      expect(rampFactor(d, 0)).toBeLessThan(rampFactor(d, 600));
      expect(rampFactor(d, 600)).toBeLessThanOrEqual(rampFactor(d, 3600));
      expect(rampFactor(d, 7200)).toBe(rampFactor(d, 3600));
    }
    expect(rampFactor('hard', 0)).toBeGreaterThan(rampFactor('easy', 0));
    expect(rampFactor('hard', 3600)).toBeGreaterThan(rampFactor('easy', 3600));
    // Late traffic is denser than early traffic (averaged over seeds).
    let early = 0;
    let late = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const r = simulate(scenarioWith({ seed, difficulty: 'hard', arrivalsPerHour: 30, departuresPerHour: 30, maxAircraft: 60 }), 1500);
      early += r.recs.filter((x) => x.time < 450).length;
      late += r.recs.filter((x) => x.time >= 1050).length;
    }
    expect(late).toBeGreaterThan(early);
  });

  it('returns a null generator when traffic is disabled', () => {
    const quiet: Scenario = { ...sc, traffic: { ...sc.traffic!, enabled: false } };
    const g = game.createTrafficGenerator(quiet, airport);
    const engine = createEngine({ airport, scenario: quiet, trafficGenerator: g });
    for (let i = 0; i < 3000; i++) engine.step();
    expect(Object.keys(engine.getState().aircraft).length).toBe(0);
    expect(game.createTrafficGenerator(game.buildScenario('career-01-first-radio', airport), airport).update(engine.getState())).toEqual([]);
  });

  it('generated arrivals can be landed: spawn position is a workable final', () => {
    const s = scenarioWith({ seed: 21, arrivalsPerHour: 30, departuresPerHour: 0, maxAircraft: 4, gaFraction: 0.5 });
    const engine = createEngine({ airport, scenario: s, readbackErrorRate: 0, trafficGenerator: game.createTrafficGenerator(s, airport) });
    const cleared = new Set<string>();
    let landed = 0;
    for (let i = 0; i < 3600 * 10 / 2; i++) {
      engine.step();
      if (i % 10 !== 0) continue;
      const st = engine.getState();
      for (const a of Object.values(st.aircraft)) {
        if (!a.isDeparture && !cleared.has(a.callsign) && a.phase === 'FINAL' && a.pendingRequest) {
          const r = engine.applyCommand({ kind: 'LAND', callsign: a.callsign, runwayEnd: a.assignedRunwayEnd, confidence: 0.99, rawText: '', normalizedText: '', issues: [] });
          if (r.status === 'accepted') cleared.add(a.callsign);
        }
      }
      landed = st.events.filter((e) => e.kind === 'PHASE_CHANGE' && e.data?.to === 'ROLLOUT').length;
    }
    expect(cleared.size).toBeGreaterThanOrEqual(3);
    expect(landed).toBeGreaterThanOrEqual(2);
    expect(engine.getState().score.runwayIncursions).toBe(0);
  });
});
