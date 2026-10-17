import { describe, expect, it } from 'vitest';
import { createEngine } from '../../sim/engine';
import type { SimulationEngine } from '../../sim/api';
import type { Scenario } from '../../sim/types';
import { loadKacy, runwayEntryNodes } from '../../airport';
import { getPresetWeather } from '../../weather/presets';
import { drawSurface, DEFAULT_SURFACE_LAYERS, labelLines, lahsoMarks, runwayTint } from './surfaceRenderer';
import { DEFAULT_RADAR_LAYERS, RADAR_RANGES_NM, approachPath, dataBlock, drawRadar, mvaLabel, mvaVisible, radarScale, ringSpacingNm } from './radarRenderer';
import { polygonCentroid } from '../lib/geom';
import { hitTestAircraft } from './hitTest';
import { fitBounds, worldToScreen } from './viewTransform';
import { buildSurfaceStatic } from './surfaceStatic';
import { poseOf } from './renderBuffer';
import type { Frame } from './frame';

const airport = loadKacy();
const nodeId = (e: unknown) => (e as { node?: { id: string }; id?: string }).node?.id ?? (e as { id: string }).id;

function makeEngine(): SimulationEngine {
  const hold13 = nodeId(runwayEntryNodes(airport, '13')[0]);
  const thr = airport.runways.find((r) => r.id === '13/31')!.ends.find((e) => e.id === '13')!;
  const rad = ((thr.trueHeadingDeg + 180) * Math.PI) / 180;
  const scenario: Scenario = {
    id: 't', name: 't', description: '', mode: 'free_play', seed: 3, weather: getPresetWeather('clear'),
    activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['TWR'],
    spawns: [
      { atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', start: { kind: 'holding_short', nodeId: hold13, runwayEnd: '13' }, isDeparture: true, initialFrequencyId: 'TWR' },
      { atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', start: { kind: 'airborne', pos: { x: thr.threshold.x + Math.sin(rad) * 8 * 1852, y: thr.threshold.y + Math.cos(rad) * 8 * 1852 }, altitudeFt: 2480, headingDeg: thr.trueHeadingDeg, speedKt: 160, runwayEnd: '13', distanceNm: 8 }, isDeparture: false, initialFrequencyId: 'TWR' },
    ],
  };
  return createEngine({ airport, scenario, readbackErrorRate: 0 });
}

/** A recording 2D context: accepts every call and property, returns plausible text metrics. */
function stubContext() {
  const calls: string[] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 6.5 });
      if (prop in t) return t[prop];
      return (...args: unknown[]) => { calls.push(`${prop}:${args.map((a) => (typeof a === 'string' ? a : '')).join('')}`); };
    },
    set(t, prop: string, v) { t[prop] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function frameOf(engine: SimulationEngine, selectedId?: string): Frame {
  const state = engine.getState();
  return { state, nowMs: 1234, pose: poseOf, selectedId };
}

describe('surface renderer', () => {
  it('draws a full frame from real engine state without throwing and writes runway numbers and taxiway ids', () => {
    const engine = makeEngine();
    for (let i = 0; i < 50; i++) engine.step();
    const { ctx, calls } = stubContext();
    const v = fitBounds(buildSurfaceStatic(airport).bounds, 1000, 600);
    const id = Object.values(engine.getState().aircraft)[0].id;
    drawSurface(ctx, frameOf(engine, id), v, DEFAULT_SURFACE_LAYERS);
    const texts = calls.filter((c) => c.startsWith('fillText:')).map((c) => c.slice('fillText:'.length));
    for (const n of ['13', '31', '4', '22']) expect(texts).toContain(n);
    expect(texts).toContain('N723EJ');
    expect(texts).toContain('HS 1');
    expect(texts.some((t) => t === 'A' || t === 'B')).toBe(true);
    expect(calls.some((c) => c.startsWith('roundRect'))).toBe(true);
  });

  it('layer toggles remove their content', () => {
    const engine = makeEngine();
    const v = fitBounds(buildSurfaceStatic(airport).bounds, 1000, 600);
    const off = { ...DEFAULT_SURFACE_LAYERS, labels: false, taxiwayIds: false };
    const { ctx, calls } = stubContext();
    drawSurface(ctx, frameOf(engine), v, off);
    const texts = calls.filter((c) => c.startsWith('fillText:')).map((c) => c.slice('fillText:'.length));
    expect(texts).not.toContain('N723EJ');
    expect(texts).not.toContain('A');
  });

  it('runway tint: green free, amber occupied, red conflict', () => {
    const base = { runwayOccupancy: {}, conflicts: [] } as Parameters<typeof runwayTint>[0];
    expect(runwayTint(base, '13/31')).toBe('free');
    const occ = { runwayOccupancy: { '13/31': { runwayId: '13/31', occupants: ['x'], crossingIds: [], holdingShortIds: [] } }, conflicts: [] } as unknown as Parameters<typeof runwayTint>[0];
    expect(runwayTint(occ, '13/31')).toBe('occupied');
    expect(runwayTint(occ, '4/22')).toBe('free');
    const conflict = { ...occ, conflicts: [{ id: 'c', kind: 'RUNWAY_CONFLICT', aircraftIds: ['a', 'b'], runwayId: '13/31', text: '', severity: 'critical', sinceSec: 0 }] } as Parameters<typeof runwayTint>[0];
    expect(runwayTint(conflict, '13/31')).toBe('conflict');
  });

  it('hit-tests aircraft at the interpolated position', () => {
    const engine = makeEngine();
    const frame = frameOf(engine);
    const v = fitBounds(buildSurfaceStatic(airport).bounds, 1000, 600);
    const ac = Object.values(engine.getState().aircraft).find((a) => a.callsign === 'N723EJ')!;
    const s = worldToScreen(v, ac.pos);
    expect(hitTestAircraft(frame, v, s.x + 5, s.y - 4)).toBe(ac.id);
    expect(hitTestAircraft(frame, v, s.x + 200, s.y + 200)).toBeUndefined();
  });

  it('data labels: callsign, type, phase code and speed', () => {
    const ac = Object.values(makeEngine().getState().aircraft).find((a) => a.callsign === 'N723EJ')!;
    expect(labelLines(ac, true)).toEqual(['N723EJ']);
    const [l1, l2] = labelLines(ac, false);
    expect(l1).toBe('N723EJ');
    expect(l2).toMatch(/^C172 HS \d+kt$/);
  });
});

describe('radar renderer', () => {
  it('data block: callsign/type, altitude in hundreds with trend, ground speed, magnetic heading', () => {
    const engine = makeEngine();
    const ac = Object.values(engine.getState().aircraft).find((a) => a.callsign === 'NKS451')!;
    const b = dataBlock({ ...ac, verticalSpeedFpm: -700 }, airport.magneticVariationDeg);
    expect(b.lines[0]).toBe('NKS451 A320');
    expect(b.lines[1]).toMatch(/^025↓\s*160$/); // 2,480 ft -> 025
    expect(b.lines[2]).toMatch(/^H128 /); // true 118 -> magnetic 128
  });

  it('data block shows the squawk once assigned and a V / R / A mode letter', () => {
    const engine = makeEngine();
    const ac = Object.values(engine.getState().aircraft).find((a) => a.callsign === 'NKS451')!;
    const plain = dataBlock(ac, airport.magneticVariationDeg);
    expect(plain.lines[1]).not.toMatch(/\d{4}/);
    const route = dataBlock({ ...ac, squawk: '4215', nav: { fixes: ['CARYL'], index: 0, mode: 'route' } }, airport.magneticVariationDeg);
    expect(route.lines[1]).toMatch(/ 4215$/);
    expect(route.lines[2]).toMatch(/ R$/);
    expect(dataBlock({ ...ac, nav: { fixes: [], index: 0, mode: 'vectors' } }, airport.magneticVariationDeg).lines[2]).toMatch(/ V$/);
    expect(dataBlock({ ...ac, nav: { fixes: [], index: 0, mode: 'approach' } }, airport.magneticVariationDeg).lines[2]).toMatch(/ A$/);
  });

  it('draws the procedure fixes of the landing runway, the selected route and every fix on request; 60 NM is a range', () => {
    const engine = makeEngine();
    const st = engine.getState();
    const nks = Object.values(st.aircraft).find((a) => a.callsign === 'NKS451')!;
    nks.nav = { fixes: ['VCN', 'CARYL', 'MAYBN'], index: 0, mode: 'route' };
    const v = { cx: 0, cy: 0, scale: radarScale(60, 1000, 700), width: 1000, height: 700 };
    const a = stubContext();
    drawRadar(a.ctx, frameOf(engine, nks.id), v, 60, DEFAULT_RADAR_LAYERS);
    const texts = a.calls.filter((c) => c.startsWith('fillText:')).map((c) => c.slice('fillText:'.length));
    for (const t of ['VCN', 'CARYL', 'MAYBN', 'ILS 13', '60 NM']) expect(texts).toContain(t);
    expect(texts.filter((t) => t === 'CARYL')).toHaveLength(1); // procedure and route draw it once
    expect(a.calls.some((c) => c.startsWith('setLineDash:'))).toBe(true);
    expect(texts).not.toContain('ZUKER');
    const all = stubContext();
    drawRadar(all.ctx, frameOf(engine, nks.id), v, 60, { ...DEFAULT_RADAR_LAYERS, allFixes: true });
    expect(all.calls.filter((c) => c.startsWith('fillText:')).map((c) => c.slice('fillText:'.length))).toContain('ZUKER');
    expect(RADAR_RANGES_NM).toContain(60);
  });

  it('scale fits the range inside the shorter canvas axis; rings step with the range', () => {
    expect(radarScale(10, 1000, 600) * 10 * 1852).toBeCloseTo(300 - 34);
    expect([5, 10, 20, 40].map(ringSpacingNm)).toEqual([1, 2, 5, 10]);
  });

  it('approach path for runway 13 extends out the back of the threshold with 1 nm ticks', () => {
    const p = approachPath(airport, '13', 10)!;
    const t13 = airport.runways.find((r) => r.id === '13/31')!.ends.find((e) => e.id === '13')!;
    expect(p.start).toEqual(t13.threshold);
    expect(p.ticks).toHaveLength(10);
    const d1 = Math.hypot(p.ticks[0].p.x - t13.threshold.x, p.ticks[0].p.y - t13.threshold.y);
    expect(d1).toBeCloseTo(1852, 3);
    // 13 points ESE (true 118), so the approach lies to the WNW of the threshold: x smaller, y larger
    expect(p.ticks[0].p.x).toBeLessThan(t13.threshold.x);
    expect(p.ticks[0].p.y).toBeGreaterThan(t13.threshold.y);
    expect(approachPath(airport, '99')).toBeUndefined();
  });

  it('draws a frame with targets, navaids and the key approach fixes', () => {
    const engine = makeEngine();
    const { ctx, calls } = stubContext();
    const v = { cx: 0, cy: 0, scale: radarScale(20, 1000, 700), width: 1000, height: 700 };
    drawRadar(ctx, frameOf(engine, Object.keys(engine.getState().aircraft)[1]), v, 20, DEFAULT_RADAR_LAYERS);
    const texts = calls.filter((c) => c.startsWith('fillText:')).map((c) => c.slice('fillText:'.length));
    expect(texts).toContain('ACY');
    for (const f of ['CARYL', 'MAYBN', 'STEVV', 'PRSTY', 'SMITS']) expect(texts).toContain(f);
    expect(texts).toContain('NKS451 A320');
    expect(texts).toContain('20 NM');
    expect(texts).toContain('360');
  });

  it('sweep is cosmetic: turning it off removes only the sweep, not the targets', () => {
    const engine = makeEngine();
    const v = { cx: 0, cy: 0, scale: radarScale(10, 1000, 700), width: 1000, height: 700 };
    const on = stubContext();
    drawRadar(on.ctx, frameOf(engine), v, 10, DEFAULT_RADAR_LAYERS);
    const off = stubContext();
    drawRadar(off.ctx, frameOf(engine), v, 10, { ...DEFAULT_RADAR_LAYERS, sweep: false });
    const textsOn = on.calls.filter((c) => c.startsWith('fillText:'));
    const textsOff = off.calls.filter((c) => c.startsWith('fillText:'));
    expect(textsOn).toEqual(textsOff);
    expect(on.calls.filter((c) => c.startsWith('arc')).length).toBeGreaterThan(off.calls.filter((c) => c.startsWith('arc')).length);
  });
});

describe('LAHSO marks on the surface display', () => {
  it('lists the NASR hold-short points of runway ends 4, 13 and 31 and draws a LAHSO label for each', () => {
    const marks = lahsoMarks(airport);
    expect(marks.map((m) => m.endId).sort()).toEqual(['13', '31', '4']);
    expect(marks.find((m) => m.endId === '4')).toMatchObject({ availableFt: 3550, holdShortOfRunwayId: '13/31' });
    const engine = makeEngine();
    const { ctx, calls } = stubContext();
    const v = fitBounds(buildSurfaceStatic(airport).bounds, 1000, 600);
    drawSurface(ctx, frameOf(engine), v, DEFAULT_SURFACE_LAYERS);
    expect(calls.filter((c) => c === 'fillText:LAHSO')).toHaveLength(3);
  });
});

describe('MVA layer on the radar', () => {
  const sectors = [
    { id: 'a', polygon: [{ x: 1000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 9000 }, { x: 1000, y: 9000 }], altitudeFt: 2500, provenance: airport.provenance[0] },
  ];
  const withMva = { ...airport, mvaSectors: sectors };
  const textsAt = (ap: typeof airport, range: number, layers = DEFAULT_RADAR_LAYERS) => {
    const engine = makeEngine();
    engine.getState().airport = ap;
    const { ctx, calls } = stubContext();
    const v = { cx: 0, cy: 0, scale: radarScale(range, 1000, 700), width: 1000, height: 700 };
    drawRadar(ctx, frameOf(engine), v, range, layers);
    return calls.filter((c) => c.startsWith('fillText:')).map((c) => c.slice('fillText:'.length));
  };

  it('computes the centroid and the label in hundreds of feet', () => {
    expect(polygonCentroid(sectors[0].polygon)).toEqual({ x: 5000, y: 5000 });
    expect(mvaLabel(sectors[0])).toEqual({ text: '025', at: { x: 5000, y: 5000 } });
  });
  it('draws the altitude at 20 NM and wider, not at 10 NM, and not when the layer is off', () => {
    expect(textsAt(withMva, 20)).toContain('025');
    expect(textsAt(withMva, 40)).toContain('025');
    expect(textsAt(withMva, 10)).not.toContain('025');
    expect(textsAt(withMva, 20, { ...DEFAULT_RADAR_LAYERS, mva: false })).not.toContain('025');
    expect(mvaVisible(withMva, DEFAULT_RADAR_LAYERS, 20)).toBe(true);
  });
  it('simply does not draw when the airport data has no sectors', () => {
    const none = { ...airport, mvaSectors: undefined };
    expect(mvaVisible(none, DEFAULT_RADAR_LAYERS, 40)).toBe(false);
    expect(mvaVisible({ ...airport, mvaSectors: [] }, DEFAULT_RADAR_LAYERS, 40)).toBe(false);
    expect(() => textsAt(none, 40)).not.toThrow();
    expect(textsAt(none, 40)).not.toContain('025');
  });
});
