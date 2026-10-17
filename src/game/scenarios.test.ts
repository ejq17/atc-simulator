import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import { findRunwayEnd } from '../sim/runways';
import type { Airport, Scenario, ScenarioAircraftSpawn, Vec2 } from '../sim/types';
import { game } from './game';
import { listScenarioSummaries } from './scenarios';
import { canDepartFrom, NM, planDepartureTaxi } from './world';

const airport = loadKacy();
const summaries = listScenarioSummaries();

/** Where the engine will actually put an airborne spawn (it snaps `distanceNm` spawns onto the extended centreline). */
function spawnPos(a: Airport, s: ScenarioAircraftSpawn): Vec2 {
  const st = s.start;
  if (st.kind === 'parked') return a.parking.find((p) => p.id === st.parkingId)!.pos;
  if (st.kind === 'holding_short') return a.taxiwayGraph.nodes[st.nodeId].pos;
  if (st.kind === 'at_fix') return a.navaids.find((n) => n.id === st.fix)!.pos;
  if (st.distanceNm !== undefined && st.runwayEnd) {
    const g = findRunwayEnd(a, st.runwayEnd)!;
    return { x: g.end.threshold.x - g.dir.x * st.distanceNm * NM, y: g.end.threshold.y - g.dir.y * st.distanceNm * NM };
  }
  return st.pos;
}

function validateSpawns(sc: Scenario): void {
  const calls = new Set<string>();
  for (const s of sc.spawns) {
    expect(calls.has(s.callsign), `duplicate callsign ${s.callsign}`).toBe(false);
    calls.add(s.callsign);
    expect(['C172', 'A320']).toContain(s.type);
    expect(airport.frequencies.some((f) => f.id === s.initialFrequencyId), `frequency ${s.initialFrequencyId}`).toBe(true);
    const st = s.start;
    if (st.kind === 'parked') {
      expect(airport.parking.find((p) => p.id === st.parkingId), `parking ${st.parkingId}`).toBeDefined();
      expect(s.isDeparture).toBe(true);
      expect(['ga', 'fbo', 'airline']).toContain(airport.parking.find((p) => p.id === st.parkingId)!.category);
      if (s.type === 'A320') expect(airport.parking.find((p) => p.id === st.parkingId)!.category).toBe('airline');
    } else if (st.kind === 'holding_short') {
      const n = airport.taxiwayGraph.nodes[st.nodeId];
      expect(n, `node ${st.nodeId}`).toBeDefined();
      expect(n.kind).toBe('holding_position');
      expect(findRunwayEnd(airport, st.runwayEnd), `runway end ${st.runwayEnd}`).toBeDefined();
      expect(!n.protectsRunwayEnd || n.protectsRunwayEnd === st.runwayEnd, `${st.nodeId} protects ${n.protectsRunwayEnd}`).toBe(true);
      // The engine refuses a takeoff roll that is too short: an A320 must never be parked on a hold it cannot depart from.
      expect(canDepartFrom(airport, s.type, st.runwayEnd, n), `${s.callsign} ${s.type} cannot depart ${st.runwayEnd} from ${st.nodeId}`).toBe(true);
    } else {
      expect(findRunwayEnd(airport, st.runwayEnd), `runway end ${st.runwayEnd}`).toBeDefined();
      expect(s.isDeparture).toBe(false);
      expect(st.altitudeFt).toBeGreaterThan(1000);
    }
  }
}

describe('catalogue', () => {
  it('lists the 12 career steps in order, at least 6 training scenarios and the free-play presets', () => {
    const career = summaries.filter((s) => s.mode === 'career');
    expect(career.map((s) => s.careerStep)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(career.map((s) => s.difficulty)).toEqual(career.map((s) => s.difficulty).sort((a, b) => a - b));
    expect(summaries.filter((s) => s.mode === 'training').length).toBeGreaterThanOrEqual(6);
    expect(summaries.filter((s) => s.mode === 'free_play').length).toBeGreaterThanOrEqual(4);
    expect(new Set(summaries.map((s) => s.id)).size).toBe(summaries.length);
    expect(game.listScenarios()).toEqual(summaries);
  });

  for (const sum of summaries) {
    describe(sum.id, () => {
      const sc = game.buildScenario(sum.id, airport, { seed: 7 }) as Scenario;

      it('builds with the catalogue metadata and resolvable ids', () => {
        expect(sc.id).toBe(sum.id);
        expect(sc.mode).toBe(sum.mode);
        expect(sc.description.length).toBeGreaterThan(20);
        validateSpawns(sc);
        if (sum.mode !== 'free_play') {
          expect(sc.objectives?.length ?? 0).toBeGreaterThan(0);
          expect(sc.durationSec).toBeGreaterThan(0);
        }
        if (sum.mode === 'training') expect(sc.training?.steps.length).toBeGreaterThanOrEqual(3);
        // JSON round trip (scenarios must be serialisable).
        expect(JSON.parse(JSON.stringify(sc)).spawns.length).toBe(sc.spawns.length);
      });

      it('has no conflicting spawns', () => {
        const tAir = sc.spawns.map((s) => ({ s, p: spawnPos(airport, s) }));
        for (let i = 0; i < tAir.length; i++) {
          for (let j = i + 1; j < tAir.length; j++) {
            const a = tAir[i];
            const b = tAir[j];
            const d = Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y);
            const aAir = a.s.start.kind === 'airborne';
            const bAir = b.s.start.kind === 'airborne';
            if (aAir && bAir && Math.abs(a.s.atSec - b.s.atSec) < 60) expect(d / NM, `${a.s.callsign}/${b.s.callsign}`).toBeGreaterThanOrEqual(3);
            if (!aAir && !bAir) expect(d, `${a.s.callsign}/${b.s.callsign} on the ground`).toBeGreaterThan(20);
          }
        }
      });

      it('runs 120 s in the real engine with no conflicts or incursions at spawn time', () => {
        const engine = createEngine({ airport, scenario: sc, trafficGenerator: game.createTrafficGenerator(sc, airport) });
        for (let i = 0; i < 1200; i++) engine.step();
        const st = engine.getState();
        const bad = st.events.filter((e) => ['CONFLICT', 'RUNWAY_INCURSION', 'SEPARATION_VIOLATION'].includes(e.kind));
        expect(bad.map((e) => `${e.timeSec} ${e.kind} ${e.text}`)).toEqual([]);
        expect(st.score.runwayIncursions + st.score.separationViolations + st.score.unsafeInstructions).toBe(0);
        // Everything scheduled for the first 120 s exists.
        const due = sc.spawns.filter((s) => s.atSec <= 119);
        for (const s of due) {
          const exists = Object.values(st.aircraft).some((a) => a.callsign === s.callsign) || st.events.some((e) => e.kind === 'DESPAWN' && e.callsign === s.callsign);
          expect(exists, `${s.callsign} spawned`).toBe(true);
        }
      });
    });
  }
});

describe('KACY specifics', () => {
  it('career 5 really crosses 13/31 at Alpha and 4/22 at Bravo', () => {
    const a = planDepartureTaxi(airport, 'GA-2', '22', ['A'])!;
    expect(a.crossings.map((c) => c.runwayId)).toContain('13/31');
    expect(a.taxiways).toContain('A');
    const b = planDepartureTaxi(airport, 'FBO-1', '13', ['B'])!;
    expect(b.crossings.map((c) => c.runwayId)).toContain('4/22');
    const none = planDepartureTaxi(airport, 'GA-1', '13', ['D', 'A'])!;
    expect(none.crossings).toEqual([]);
  });

  it('no A320 is ever placed on a departure runway it cannot use, and no helicopters or fighters are spawned', () => {
    for (const sum of summaries) {
      const sc = game.buildScenario(sum.id, airport, { seed: 3 });
      for (const s of sc.spawns) {
        expect(['C172', 'A320']).toContain(s.type);
        if (s.type === 'A320' && s.start.kind === 'holding_short') expect(airport.taxiwayGraph.nodes[s.start.nodeId].runwayId).toBe('13/31');
        expect(/^(USCG|ANG)/.test(s.callsign)).toBe(false);
      }
    }
  });

  it('the runway change scenario places post-shift traffic on runway 31', () => {
    const sc = game.buildScenario('career-10-runway-change', airport);
    expect(sc.spawns.some((s) => s.start.kind === 'airborne' && s.start.runwayEnd === '31')).toBe(true);
    expect(sc.spawns.some((s) => s.start.kind === 'holding_short' && s.start.runwayEnd === '31')).toBe(true);
  });
});
