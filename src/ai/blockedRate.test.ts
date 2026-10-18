import { describe, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import { game } from '../game/game';
import { createAiControllers } from './index';
import type { SimEvent } from '../sim/types';
import type { PilotRealismLevel } from '../sim/pilotBehaviour';

/**
 * Blocked-call measurement (docs/BEHAVIOUR-ACCURACY.md R9): KACY free play, "mixed" start, 24 arrivals + 24 departures per hour, 35 simulated
 * minutes after the first 5 are discarded, share of pilot calls blocked, with and without AI controllers on every position.
 * Slow, so it only runs with BLOCKED_RATE=1 (BLOCKED_SEEDS=1,2,3, BLOCKED_LEVELS=light,moderate,heavy, BLOCKED_AI=0,1, BLOCKED_FILE=path appends the rows).
 */
const enabled = process.env.BLOCKED_RATE === '1';
const seeds = (process.env.BLOCKED_SEEDS ?? '1,2,3').split(',').map(Number);
const levels = (process.env.BLOCKED_LEVELS ?? 'light,moderate,heavy').split(',') as PilotRealismLevel[];
const modes = (process.env.BLOCKED_AI ?? '0,1').split(',').map((x) => x === '1');
const kacy = loadKacy();
const DISCARD = 300;
const SPAN = 2100;

export function measureBlocked(seed: number, level: PilotRealismLevel, withAi: boolean) {
  const sc = game.buildFreePlay(kacy, {
    seed, weather: 'clear', aircraftCount: 6, maxAircraft: 30, arrivalsPerHour: 24, departuresPerHour: 24, difficulty: 'normal', pilotRealism: level, startingScenario: 'mixed',
    airportEvents: false, startUtcMs: Date.UTC(2026, 5, 1, 15),
  });
  sc.controllerPositions = ['CLNC', 'GND', 'TWR', 'APP', 'DEP'];
  sc.playerPositions = [];
  const engine = createEngine({ airport: kacy, scenario: sc, trafficGenerator: game.createTrafficGenerator(sc, kacy), readbackErrorRate: 0.04, utcStartMs: Date.UTC(2026, 5, 1, 15) });
  const ai = withAi ? createAiControllers({ engine, airport: kacy, positions: ['CLNC', 'GND', 'TWR', 'APP', 'DEP'], playerPositions: [], seed: 5 }) : undefined;
  const events: SimEvent[] = [];
  let last = 0;
  engine.subscribe((s) => {
    ai?.update(s);
    for (const e of s.events) { const n = Number(e.id.replace('ev-', '')); if (n > last) { events.push(e); last = n; } }
  });
  for (let t = 1; t <= (DISCARD + SPAN) * 10; t++) engine.step();
  let pilot = 0, blockedCalls = 0, groups = 0;
  const pairs: string[] = [];
  for (const e of events) {
    if (e.timeSec < DISCARD) continue;
    if (e.kind === 'TRANSMISSION' && e.speaker === 'PILOT') pilot++;
    if (e.kind === 'RADIO_BLOCKED') {
      const d = e.data as { callsigns: string[]; answers: boolean[]; texts: string[]; keyedAtSec: number[] };
      blockedCalls += d.callsigns.length; groups++;
      const atc = events.filter((x) => x.kind === 'TRANSMISSION' && x.speaker === 'ATC' && x.timeSec <= e.timeSec && x.timeSec > e.timeSec - 12).map((x) => `ATC@${x.timeSec.toFixed(1)}:${(x.text ?? '').slice(0, 30)}`).join(' | ');
      pairs.push(atc + ' >> ' + `${Math.round(e.timeSec)} ${d.answers.map((a) => (a ? 'A' : 'P')).join('')} ${d.keyedAtSec.join('/')} ${d.texts.map((t) => `[${t.slice(0, 70)}]`).join(' ')}`);
    }
  }
  return { pilot, blockedCalls, groups, pairs, total: pilot + blockedCalls };
}

describe.skipIf(!enabled)('blocked-call rate', () => {
  for (const level of levels) for (const withAi of modes) {
    it(`${level} ${withAi ? 'AI' : 'unattended'}`, () => {
      let p = 0, b = 0, g = 0;
      const per: string[] = [];
      const pairs: string[] = [];
      for (const seed of seeds) {
        const r = measureBlocked(seed, level, withAi);
        p += r.pilot; b += r.blockedCalls; g += r.groups; per.push(`${seed}:${r.blockedCalls}/${r.total}`);
        if (process.env.BLOCKED_PAIRS) pairs.push(...r.pairs.map((x) => `s${seed} ${x}`));
      }
      const line = `${level} ${withAi ? 'AI' : 'unattended'}: blocked ${b} of ${p + b} calls keyed = ${((100 * b) / (p + b)).toFixed(2)} % (groups ${g}; ${per.join(' ')})`;
      console.log(line + (pairs.length ? '\n' + pairs.join('\n') : ''));
      if (process.env.BLOCKED_FILE) appendFileSync(process.env.BLOCKED_FILE, line + '\n' + (pairs.length ? pairs.join('\n') + '\n' : ''));
    }, 1800000);
  }
});
