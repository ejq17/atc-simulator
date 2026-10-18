/**
 * UI side of the airport state: panel lines, closure marking geometry for the Surface and Tower views, runway light levels, and the session behaviour
 * (new ATIS letter, runway change when the runway in use closes, live observations, braking action worse).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadKacy, loadKmht } from '../airport';
import { game } from '../game';
import { createEngine } from '../sim/engine';
import type { SimulationEngine } from '../sim/api';
import type { SimulationEngineExtras } from '../sim/engineExtras';
import type { Weather } from '../sim/types';
import { airportStatus, closureLines } from './lib/airportStatus';
import { closedRunwayMarks, closedTaxiwayMarks, xMark } from './display/closureMarks';
import { runwayLightLevel, xMarkRects } from './tower/geometry';
import { createPilotSink, makeAtis, startSession } from './store/session';
import type { Session } from './store/session';
import { runwayChangeForWind } from './store/runwayConfig';
import { getPresetWeather } from '../weather/presets';
import { initialAtisLetter } from '../weather/atisCycle';
import { drawSurface, DEFAULT_SURFACE_LAYERS } from './display/surfaceRenderer';
import { fitBounds } from './display/viewTransform';
import { buildSurfaceStatic } from './display/surfaceStatic';

const kacy = loadKacy();
const kmht = loadKmht();

const NIGHT = Date.UTC(2026, 5, 1, 4, 0, 0);

describe('panel lines', () => {
  const engine = createEngine({
    airport: kacy, readbackErrorRate: 0, utcStartMs: NIGHT,
    scenario: { ...game.buildFreePlay(kacy, { seed: 1, weather: { ...getPresetWeather('rain') }, airportEvents: false, closures: [{ kind: 'RUNWAY', ident: '4/22' }, { kind: 'TAXIWAY', ident: 'B' }], activeRunways: { departing: ['13'], landing: ['13'] } }), spawns: [] },
  });
  it('lists the closures with their remaining time, the derived runway condition, the lights step and the birds', () => {
    const e = engine as SimulationEngine & SimulationEngineExtras;
    e.setBirdActivity!('flocks of small birds, altitude unknown', 600);
    e.addClosure!({ kind: 'TAXIWAY', ident: 'C', endSec: 300 });
    const st = e.getState();
    expect(closureLines(st).map((c) => c.text)).toEqual(['Runway 4/22 closed', 'Taxiway B closed', 'Taxiway C closed']);
    expect(closureLines(st).map((c) => c.minutesLeft)).toEqual([undefined, undefined, 5]);
    const s = airportStatus(st);
    expect(s.runwayCondition).toMatch(/wet|water/);
    expect(s.lights).toMatch(/runway 13\/31 edge lights step \d/);
    expect(s.birds).toMatch(/small birds/);
    expect(s.rvr).toBeUndefined();
  });
  it('gives the RVR for the runway in use with an ILS when the visibility is low (KMHT 6 has one, 24 has none)', () => {
    const low: Weather = { ...getPresetWeather('low-visibility'), visibilitySm: 0.5, phenomena: ['FG'] };
    const mk = (end: string) => createEngine({ airport: kmht, readbackErrorRate: 0, scenario: { ...game.buildFreePlay(kmht, { seed: 1, weather: low, airportEvents: false, activeRunways: { departing: [end], landing: [end] } }), spawns: [] } });
    expect(airportStatus(mk('6').getState()).rvr).toBe('runway 6 RVR 2400');
    expect(airportStatus(mk('24').getState()).rvr).toBeUndefined();
  });
});

describe('closure marks (AC 150/5370-2G 2.18.2.1.2)', () => {
  it('a closed runway gets an X at each end, inside the threshold, spanning less than the runway width', () => {
    const rw = kacy.runways.find((r) => r.id === '13/31')!;
    const [a, b] = closedRunwayMarks(rw);
    expect(Math.hypot(a.center.x - rw.ends[0].threshold.x, a.center.y - rw.ends[0].threshold.y)).toBeCloseTo(150, 3);
    expect(Math.hypot(b.center.x - rw.ends[1].threshold.x, b.center.y - rw.ends[1].threshold.y)).toBeCloseTo(150, 3);
    for (const m of [a, b]) {
      expect(m.segments).toHaveLength(2);
      for (const [p, q] of m.segments) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(rw.widthFt * 0.3048 * 1.8);
    }
  });
  it('an X is two crossing strokes through its centre', () => {
    const m = xMark({ x: 10, y: 20 }, { x: 0, y: 1 }, 5);
    const mid = (s: [{ x: number; y: number }, { x: number; y: number }]) => ({ x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 });
    expect(mid(m.segments[0])).toEqual({ x: 10, y: 20 });
    expect(mid(m.segments[1])).toEqual({ x: 10, y: 20 });
    const d = (s: [{ x: number; y: number }, { x: number; y: number }]) => ({ x: s[1].x - s[0].x, y: s[1].y - s[0].y });
    expect(d(m.segments[0]).x * d(m.segments[1]).x + d(m.segments[0]).y * d(m.segments[1]).y).toBeCloseTo(0, 6); // perpendicular strokes
  });
  it('a closed taxiway is marked at both ends and along the way', () => {
    const lines = kacy.taxiwayGraph.taxiwayPolylines['B'];
    const marks = closedTaxiwayMarks(lines);
    expect(marks.length).toBeGreaterThanOrEqual(lines.length * 2);
    const rects = xMarkRects(marks, 0.9);
    expect(rects).toHaveLength(marks.length * 2);
    expect(rects.every((r) => r.length > 0 && r.width === 0.9)).toBe(true);
  });
  it('the Surface renderer draws the closure marks only when something is closed', () => {
    const draw = (closures: Parameters<typeof game.buildFreePlay>[1]) => {
      const e = createEngine({ airport: kacy, readbackErrorRate: 0, scenario: { ...game.buildFreePlay(kacy, { seed: 1, weather: 'clear', airportEvents: false, ...closures }), spawns: [] } });
      const calls: string[] = [];
      const ctx = new Proxy({}, { get: (_t, p) => (p === 'measureText' ? () => ({ width: 8 }) : (..._a: unknown[]) => { calls.push(String(p)); return undefined; }), set: (_t, p, v) => { if (p === 'strokeStyle') calls.push(`stroke:${String(v)}`); return true; } }) as unknown as CanvasRenderingContext2D;
      const v = fitBounds(buildSurfaceStatic(kacy).bounds, 1000, 600);
      drawSurface(ctx, { state: e.getState(), nowMs: 0, pose: (a: { pos: { x: number; y: number }; headingDeg: number; altitudeFt: number; groundSpeedKt: number }) => ({ x: a.pos.x, y: a.pos.y, headingDeg: a.headingDeg, altitudeFt: a.altitudeFt, groundSpeedKt: a.groundSpeedKt }) } as never, v, DEFAULT_SURFACE_LAYERS);
      return calls.filter((c) => c === 'stroke:#f2c744').length;
    };
    // (the same yellow is the hold line colour: compare against the open airport)
    const open = draw({});
    expect(draw({ closures: [{ kind: 'RUNWAY', ident: '4/22' }] })).toBeGreaterThan(open);
    expect(draw({ closures: [{ kind: 'TAXIWAY', ident: 'B' }] })).toBeGreaterThan(open);
  });
});

describe('runway light level (Tower view)', () => {
  it('is dark when off or closed and brighter with every step of the HIRL system', () => {
    expect(runwayLightLevel(0, false)).toEqual({ opacity: 0, size: 0 });
    expect(runwayLightLevel(5, true)).toEqual({ opacity: 0, size: 0 }); // no edge lights on a runway closed by NOTAM (3-4-10)
    const levels = [1, 2, 3, 4, 5].map((s) => runwayLightLevel(s, false));
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i].opacity).toBeGreaterThan(levels[i - 1].opacity);
      expect(levels[i].size).toBeGreaterThan(levels[i - 1].size);
    }
    expect(levels[4].opacity).toBe(1);
    expect(runwayLightLevel(9, false)).toEqual(runwayLightLevel(5, false)); // clamped
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------------------------------

describe('session: airport state and the ATIS', () => {
  let pending: ((t: number) => void) | null = null;
  let session: Session | null = null;
  const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
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
  const frames = (sec: number) => { for (let i = 0; i < sec * 20; i++) { vi.advanceTimersByTime(50); pending?.(performance.now()); } };

  function build(weather: Weather, realTime = false) {
    const scenario = game.buildFreePlay(kacy, { seed: 2, weather, aircraftCount: 0, arrivalsPerHour: 0, departuresPerHour: 0, airportEvents: false, activeRunways: { departing: ['13'], landing: ['13'] } });
    const { sink, onPilotTransmission } = createPilotSink();
    const engine = createEngine({ airport: kacy, scenario, onPilotTransmission, utcStartMs: START }) as SimulationEngine & SimulationEngineExtras;
    engine.setWeather(weather);
    const letters: string[] = [];
    const notices: string[] = [];
    session = startSession({
      engine, scenario, controller: { positions: ['TWR'] }, startUtcMs: START, atisLetter: initialAtisLetter(START), realTime, training: null, pilotSink: sink, enableVoice: false, enableAi: false,
      hooks: { onRev() {}, onVoiceStatus() {}, onPartial() {}, onTransmitting() {}, onTransmitResult() {}, onTraining() {}, onAtis: (a) => letters.push(a.letter), onScenarioComplete() {}, onNotice: (_l, t) => notices.push(t) },
    });
    return { engine, letters, notices };
  }

  it('a closure of a runway not in use makes a new letter that reads it; its end makes another; nothing else does', () => {
    const { engine, letters } = build(getPresetWeather('clear'));
    frames(3);
    expect(letters).toHaveLength(1);
    engine.addClosure!({ kind: 'RUNWAY', ident: '4/22', endSec: engine.getState().clock.timeSec + 60 }, 'scenario');
    frames(3);
    expect(letters).toHaveLength(2);
    expect(session!.atis.text).toContain('NOTAMs: Runway 4/22 closed.');
    expect(engine.getState().atis.letter).toBe(letters[1]);
    frames(65);
    expect(letters).toHaveLength(3);
    expect(session!.atis.text).not.toContain('closed');
  });

  it('closing the runway in use switches to the best open runway, tells the player, and the new ATIS names it', () => {
    const { engine, letters, notices } = build(getPresetWeather('clear'));
    frames(2);
    engine.addClosure!({ kind: 'RUNWAY', ident: '13/31', endSec: engine.getState().clock.timeSec + 600 }, 'scenario');
    frames(3);
    const st = engine.getState();
    expect([...st.activeRunways.landing, ...st.activeRunways.departing].every((e) => e === '4' || e === '22')).toBe(true);
    expect(notices.some((n) => /runway in use is closed.*changed to (4|22)/.test(n))).toBe(true);
    expect(letters.length).toBeGreaterThanOrEqual(2);
    expect(session!.atis.text).toContain('Runway 13/31 closed');
    expect(session!.atis.activeRunways.landing[0]).toBe(st.activeRunways.landing[0]);
    expect(runwayChangeForWind(st.weather, { landing: ['13'], departing: ['13'] }, kacy, ['13', '31'])?.landing[0]).toMatch(/^(4|22)$/);
  });

  it('a braking action report worse than the one in the ATIS makes a new letter; rain with RVR content shows in the text', () => {
    const rain: Weather = { ...getPresetWeather('rain'), visibilitySm: 0.75, flightCategory: 'IFR' };
    const { engine, letters } = build(rain);
    frames(2);
    expect(session!.atis.text).toContain('condition codes 5, 5, 5');
    expect(session!.atis.text).toContain('Runway 13 RVR 4000.');
    expect(session!.atis.text).not.toContain('Braking action advisories'); // light rain at 14 C: a wet runway (5, good), no report yet
    const n = letters.length;
    engine.reportBrakingAction!({ runwayEnd: '13', term: 'good', aircraftType: 'C172', aircraftSpoken: 'a Cessna one seventy two' });
    frames(2);
    expect(letters.length).toBe(n + 1);
    expect(session!.atis.text).toContain('Braking action good, reported by a Cessna one seventy two.');
    engine.reportBrakingAction!({ runwayEnd: '13', term: 'good', aircraftType: 'A320', aircraftSpoken: 'an Airbus three twenty' });
    frames(2);
    expect(letters.length).toBe(n + 1); // not worse: no new letter
    engine.reportBrakingAction!({ runwayEnd: '13', term: 'medium', aircraftType: 'A320', aircraftSpoken: 'an Airbus three twenty' });
    frames(2);
    expect(letters.length).toBe(n + 2);
    expect(session!.atis.text).toContain('Braking action advisories are in effect. Braking action medium, reported by an Airbus three twenty.');
  });

  it('bird activity is on the next ATIS and gone from the one after it ends', () => {
    const { engine, letters } = build(getPresetWeather('clear'));
    frames(1);
    engine.setBirdActivity!('a flock of geese, altitude unknown', 30);
    frames(2);
    expect(session!.atis.text).toContain('Bird activity in the vicinity of the airport, a flock of geese, altitude unknown.');
    frames(31);
    expect(session!.atis.text).not.toContain('Bird activity');
    expect(letters.length).toBeGreaterThanOrEqual(3);
  });

  it('live weather: a new hourly METAR makes a new letter even with identical values; the HH:55Z clock adds none; simulated weather uses the clock', () => {
    const live = (observedAt: string): Weather => ({ ...getPresetWeather('clear'), source: 'live', observedAt, rawMetar: `KACY ${observedAt}` });
    const a = build(live('2026-10-17T11:54:00.000Z'), true);
    frames(2);
    expect(a.letters).toHaveLength(1);
    a.engine.setWeather(live('2026-10-17T12:54:00.000Z')); // direct engine call does not reissue ...
    session!.setWeather(live('2026-10-17T12:54:00.000Z')); // ... the session API does
    frames(1);
    expect(a.letters).toHaveLength(2);
    session!.setWeather(live('2026-10-17T12:54:00.000Z')); // the same observation again: nothing
    frames(1);
    expect(a.letters).toHaveLength(2);
    frames(10 * 60); // 12:55Z passes: live weather gets no extra clock letter
    expect(a.letters).toHaveLength(2);
    session!.dispose();
    const b = build(getPresetWeather('clear'), true);
    frames(10 * 60);
    expect(b.letters).toHaveLength(2); // simulated weather: the hourly slot
  });

  it('makeAtis carries the airport state of the engine at the time', () => {
    const e = createEngine({ airport: kmht, readbackErrorRate: 0, scenario: { ...game.buildFreePlay(kmht, { seed: 1, weather: { ...getPresetWeather('low-visibility'), visibilitySm: 0.5 }, airportEvents: false, closures: [{ kind: 'TAXIWAY', ident: 'A' }], activeRunways: { departing: ['6'], landing: ['6'] } }), spawns: [] } });
    const atis = makeAtis(e.getState(), 'D', Date.UTC(2026, 9, 17, 12, 0, 0));
    expect(atis.text).toContain('Taxiway A closed');
    expect(atis.text).toContain('Runway 6 RVR 2400.');
    expect(atis.letter).toBe('D');
  });
});
