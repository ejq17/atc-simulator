import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import { game } from '../game/game';
import { defaultSpecialTraffic } from '../game/specialTraffic';
import { createAiControllers } from './index';
import type { SimEvent } from '../sim/types';

const kacy = loadKacy();

describe('free play with every special traffic kind and all AI controllers', () => {
  it('runs 2 hours: every kind appears and completes, vehicles never cause an incursion, no critical separation loss involves special traffic', () => {
    const sc = game.buildFreePlay(kacy, {
      seed: Number(process.env.SOAK_SEED ?? 13), weather: 'clear', aircraftCount: 2, maxAircraft: 10, arrivalsPerHour: 4, departuresPerHour: 4, difficulty: 'normal', startingScenario: 'quiet',
      specialTraffic: defaultSpecialTraffic('KACY'), airportEvents: true, startUtcMs: Date.UTC(2026, 5, 1, 15),
    });
    sc.controllerPositions = ['CLNC', 'GND', 'TWR', 'APP', 'DEP'];
    sc.playerPositions = [];
    const engine = createEngine({ airport: kacy, scenario: sc, trafficGenerator: game.createTrafficGenerator(sc, kacy), readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 5, 1, 15) });
    const ai = createAiControllers({ engine, airport: kacy, positions: ['CLNC', 'GND', 'TWR', 'APP', 'DEP'], playerPositions: [], seed: 5 });
    const events: SimEvent[] = [];
    let last = 0;
    engine.subscribe((s) => {
      ai.update(s);
      for (const e of s.events) {
        const n = Number(e.id.replace('ev-', ''));
        if (n > last) { events.push(e); last = n; }
      }
    });
    const seen = new Set<string>();
    for (let i = 0; i < 120 * 60 * 10; i++) {
      engine.step();
      if (i % 10 === 0) for (const a of Object.values(engine.getState().aircraft)) seen.add(a.type);
    }
    const specials = /^(CGD|ANG|APT)/;
    const bad = events.filter((e) => (e.kind === 'RUNWAY_INCURSION' || e.kind === 'SEPARATION_VIOLATION') && (specials.test(e.callsign ?? '') || /\bAPT\d/.test(e.text)));
    const summary = [
      [...seen].join(','),
      `spawns ${events.filter((e) => e.kind === 'SPAWN' && specials.test(e.callsign ?? '')).length}`,
      `despawns ${events.filter((e) => e.kind === 'DESPAWN' && specials.test(e.callsign ?? '')).length}`,
      ...bad.flatMap((e) => [`${e.timeSec} ${e.kind} ${e.text}`, ...events.filter((x) => x.timeSec <= e.timeSec && x.timeSec > e.timeSec - 900 && x.callsign && e.text.includes(x.callsign)).slice(-30).map((x) => `    ${x.timeSec} ${x.kind} ${x.callsign} ${x.text}`)]),
      ...events.filter((e) => e.kind === 'CONFLICT' && /APT|CGD|ANG/.test(e.text)).map((e) => `${e.timeSec} CONFLICT ${e.text}`),
    ].join('\n');
    expect(bad, summary).toHaveLength(0);
    // how many special flights a seed produces is chance (2-4 per hour): the completeness checks hold for the committed seed only
    if (process.env.SOAK_SEED) return;
    for (const t of ['H65', 'F16', 'VEH']) expect(seen.has(t), summary).toBe(true);
    expect(events.filter((e) => e.kind === 'DESPAWN' && specials.test(e.callsign ?? '')).length, summary).toBeGreaterThanOrEqual(4);
    expect(events.some((e) => e.kind === 'SPAWN' && /\(C172\)/.test(e.text) && e.data?.phase === 'INBOUND'), summary).toBe(true);
    expect(bad, summary).toHaveLength(0);
  }, 180000);
});
