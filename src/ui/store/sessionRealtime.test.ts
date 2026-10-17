import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { game } from '../../game';
import { loadKacy } from '../../airport';
import { createEngine } from '../../sim/engine';
import { simUtcMs } from '../../sim/solar';
import { getPresetWeather } from '../../weather/presets';
import { initialAtisLetter } from '../../weather/atisCycle';
import { createPilotSink, startSession } from './session';
import type { Session } from './session';
import { runwayChangeForWind } from './simStore';

const airport = loadKacy();
let pending: ((t: number) => void) | null = null;
let session: Session | null = null;
const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };

// 12:50Z: five minutes before the hourly ATIS time.
const START = Date.UTC(2026, 9, 17, 12, 50, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  pending = null;
  g.requestAnimationFrame = (cb: (t: number) => void) => { pending = cb; return 1; };
  g.cancelAnimationFrame = () => { pending = null; };
});
afterEach(() => {
  session?.dispose();
  session = null;
  delete g.requestAnimationFrame;
  delete g.cancelAnimationFrame;
  vi.useRealTimers();
});

function build(realTime: boolean) {
  const scenario = game.buildFreePlay(airport, { seed: 2, weather: 'clear', aircraftCount: 0, arrivalsPerHour: 0, departuresPerHour: 0 });
  const { sink, onPilotTransmission } = createPilotSink();
  const engine = createEngine({ airport, scenario, onPilotTransmission, utcStartMs: START });
  engine.setWeather(getPresetWeather('clear'));
  const letters: string[] = [];
  const notices: string[] = [];
  session = startSession({
    engine, scenario, controller: { positions: ['TWR'] }, startUtcMs: START, atisLetter: initialAtisLetter(START), realTime,
    training: null, pilotSink: sink, enableVoice: false, enableAi: false,
    hooks: {
      onRev() {}, onVoiceStatus() {}, onPartial() {}, onTransmitting() {}, onTransmitResult() {}, onTraining() {},
      onAtis: (a) => letters.push(a.letter), onScenarioComplete() {}, onNotice: (_l, t) => notices.push(t),
    },
  });
  return { engine, letters, notices };
}

/** Run animation frames for `sec` real seconds in 50 ms steps. */
function run(sec: number) {
  for (let i = 0; i < sec * 20; i++) {
    vi.advanceTimersByTime(50);
    pending?.(performance.now());
  }
}

describe('session in real-time mode', () => {
  it('is LIVE, its sim UTC equals the real UTC, and sim time equals elapsed wall time', () => {
    const { engine } = build(true);
    expect(session!.clockStatus().mode).toBe('live');
    run(30);
    expect(Math.abs(engine.getState().clock.timeSec - 30)).toBeLessThan(0.11);
    expect(Math.abs(simUtcMs(engine.getState()) - Date.now())).toBeLessThan(150);
  });

  it('issues a new ATIS letter on the real hourly cycle (HH:55Z) and not before', () => {
    const { letters, engine } = build(true);
    const first = letters[0];
    run(4 * 60 + 50); // 12:54:50Z
    expect(letters).toHaveLength(1);
    run(20); // past 12:55Z
    expect(letters).toHaveLength(2);
    expect(letters[1]).toBe(String.fromCharCode(first.charCodeAt(0) + 1));
    expect(engine.getState().atis.letter).toBe(letters[1]);
    expect(session!.atis.text).toMatch(/12\d\dZ|1255/);
    run(10 * 60);
    expect(letters).toHaveLength(2); // once per hour
  });

  it('does not run the hourly ATIS cycle outside real-time mode', () => {
    const { letters } = build(false);
    run(10 * 60);
    expect(letters).toHaveLength(1);
  });

  it('2x override shows SIM and releases the lock; 1x re-locks', () => {
    build(true);
    session!.setSpeed(2);
    expect(session!.clockStatus()).toMatchObject({ mode: 'sim', speed: 2 });
    session!.setSpeed(1);
    expect(session!.clockStatus().mode).toBe('live');
    session!.setSpeed(0);
    expect(session!.clockStatus().mode).toBe('paused');
  });
});

describe('live wind -> runway selection', () => {
  const calm = { ...getPresetWeather('clear'), windSpeedKt: 0, windDirDeg: 0 };

  it('keeps the runway in use while it is still among the best ends', () => {
    expect(runwayChangeForWind(calm, { landing: ['22'], departing: ['22'] }, airport)).toBeUndefined();
  });

  it('switches to the best-headwind end (existing rules) when the wind moves around', () => {
    // True wind 040 at 15 kt is NE: runway 4 / 31/13 area, 22 would have a tailwind.
    const w = { ...calm, windDirDeg: 40, windSpeedKt: 15 };
    const change = runwayChangeForWind(w, { landing: ['22'], departing: ['22'] }, airport);
    expect(change).toBeDefined();
    expect(change!.landing).not.toContain('22');
    expect(change!.landing).toEqual(change!.departing);
  });
});
