/** Pilot realism in the game layer: the level of every scenario, the free-play option, the callsign generator, a full run with messy pilots. */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import { game } from './game';
import { careerRealism } from './scenarios';
import type { GameScenario } from './types';
import { run } from './testkit';
import { similarSounding } from '../radio/callsigns';

const airport = loadKacy();
const build = (id: string, o?: Parameters<typeof game.buildScenario>[2]) => game.buildScenario(id, airport, { seed: 5, ...o }) as GameScenario;

describe('pilot realism level of a scenario', () => {
  it('career steps ramp from off (introductory) through light and moderate to heavy', () => {
    const levels = Array.from({ length: 12 }, (_, i) => build(`${game.listScenarios().find((s) => s.careerStep === i + 1)!.id}`).pilotRealism);
    expect(levels.slice(0, 2)).toEqual(['off', 'off']); // introductory steps
    expect(levels.slice(2, 5)).toEqual(['light', 'light', 'light']);
    expect(levels.slice(5, 9)).toEqual(['moderate', 'moderate', 'moderate', 'moderate']);
    expect(levels.slice(9)).toEqual(['heavy', 'heavy', 'heavy']);
    expect(careerRealism(undefined)).toBe('off');
  });
  it('career step 11 is built on the free-play builder but still follows the career ramp', () => {
    expect(build('career-11-complex').pilotRealism).toBe('heavy');
  });
  it('training lessons are clean', () => {
    const lessons = game.listScenarios().filter((s) => s.mode === 'training');
    expect(lessons.length).toBeGreaterThan(5);
    for (const l of lessons) expect(build(l.id).pilotRealism, l.id).toBe('off');
  });
  it('free play defaults to moderate and takes the selector\'s value', () => {
    expect(build('free-play').pilotRealism).toBe('moderate');
    expect(build('free-play-mixed').pilotRealism).toBe('moderate');
    for (const level of ['off', 'light', 'moderate', 'heavy'] as const) expect(build('free-play', { pilotRealism: level }).pilotRealism).toBe(level);
    expect(game.buildFreePlay(airport, { seed: 1 }) as GameScenario).toMatchObject({ pilotRealism: 'moderate' });
    expect((game.buildFreePlay(airport, { seed: 1, pilotRealism: 'heavy' }) as GameScenario).pilotRealism).toBe('heavy');
  });
  it('the selector does not change career or training levels', () => {
    expect(build('career-01-first-radio', { pilotRealism: 'heavy' }).pilotRealism).toBe('off');
    expect(build('train-01-phraseology', { pilotRealism: 'heavy' }).pilotRealism).toBe('off');
  });
});

describe('a session with messy pilots runs', () => {
  it('free play at heavy runs 15 simulated minutes deterministically; callsign habits show up in the log', () => {
    const go = () => {
      const sc = build('free-play-busy-arrivals', { pilotRealism: 'heavy', seed: 21, aircraftCount: 6 });
      const e = createEngine({ airport, scenario: sc, trafficGenerator: game.createTrafficGenerator(sc, airport) });
      run(e, 900);
      return e;
    };
    const a = go();
    const b = go();
    const sig = (e: ReturnType<typeof go>) => e.getState().events.map((x) => `${x.timeSec}|${x.kind}|${x.text}`);
    expect(sig(a)).toEqual(sig(b));
    const pilot = a.getState().events.filter((x) => x.speaker === 'PILOT').map((x) => x.text);
    expect(pilot.length).toBeGreaterThan(5);
    expect(pilot.some((t) => /November|student pilot|with you/.test(t))).toBe(true); // callsign habits and pilot styles reach the log
  });
});

describe('callsign generator and realism', () => {
  /** Pairs of aircraft on the airport at once whose callsigns a pilot could take for each other (radio/callsigns.ts). */
  const alike = (level: 'off' | 'heavy') => {
    const base = build('free-play-mixed', { seed: 8, pilotRealism: level, maxAircraft: 40, arrivalsPerHour: 120, departuresPerHour: 120 });
    const sc = { ...base, spawns: [], traffic: { ...base.traffic!, flowControl: false } } as GameScenario; // raw clocks: nothing lands in this run
    const e = createEngine({ airport, scenario: sc, trafficGenerator: game.createTrafficGenerator(sc, airport) });
    const counted = new Set<string>();
    for (let t = 0; t < 12000; t++) {
      e.step();
      if (t % 20) continue;
      const cs = Object.values(e.getState().aircraft).map((a) => a.callsign);
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) if (similarSounding(cs[i], cs[j])) counted.add([cs[i], cs[j]].sort().join());
    }
    return counted.size;
  };
  it('sound-alike callsigns are avoided without realism and appear at heavy', () => {
    const off = alike('off');
    const heavy = alike('heavy');
    expect(off).toBeLessThan(2);
    expect(heavy).toBeGreaterThan(off + 2);
  });
});
