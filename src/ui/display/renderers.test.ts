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
import { GLYPH_HALF, glyphFor, glyphPath, specialMark, symbolSize } from './symbols';
import { C } from './palette';
import { typeTag } from '../lib/format';
import type { Aircraft } from '../../sim/types';

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

describe('aircraft glyphs', () => {
  interface Rec { ops: string[]; xs: number[]; ys: number[] }
  const record = (halfLen: number, type?: string): Rec => {
    const r: Rec = { ops: [], xs: [], ys: [] };
    const ctx = {
      beginPath: () => r.ops.push('begin'),
      closePath: () => r.ops.push('close'),
      moveTo: (x: number, y: number) => { r.ops.push('move'); r.xs.push(x); r.ys.push(y); },
      lineTo: (x: number, y: number) => { r.ops.push('line'); r.xs.push(x); r.ys.push(y); },
    } as unknown as CanvasRenderingContext2D;
    glyphPath(ctx, halfLen, type);
    return r;
  };
  const FAMILIES: [string, string][] = [
    ['A320', 'narrowbody'], ['B738', 'narrowbody'], ['CRJ9', 'regionalJet'], ['E175', 'narrowbody'], ['DH8D', 'turboprop'], ['C208', 'turbopropSingle'],
    ['C25B', 'bizjet'], ['GLF4', 'bizjet'], ['C172', 'gaHigh'], ['PA28', 'gaLow'],
    ['B772', 'widebody'], ['A359', 'widebody'], ['A388', 'widebodyQuad'], ['B748', 'widebodyQuad'], ['BE20', 'turboprop'], ['C402', 'gaLow'], ['GLEX', 'bizjet'],
  ];
  it('has a closed path for every family, starting at the nose and ending closed', () => {
    for (const [type, family] of FAMILIES) {
      const g = glyphFor(type);
      expect(g.family).toBe(family);
      const r = record(20, type);
      expect(r.ops[0]).toBe('begin');
      expect(r.ops[1]).toBe('move');
      expect(r.ops[r.ops.length - 1]).toBe('close');
      expect(r.ops.filter((o) => o === 'move').length).toBe(r.ops.filter((o) => o === 'close').length); // every sub-path is closed
      expect(r.xs[0]).toBeCloseTo(0, 9);
      expect(r.ys[0]).toBeCloseTo(-20, 9); // nose at -y (up the screen)
      for (const v of [...r.xs, ...r.ys]) expect(Number.isFinite(v)).toBe(true);
      expect(g.half[0][0]).toBe(0);
      expect(g.half[g.half.length - 1][0]).toBe(0); // the outline meets the centreline at the tail
    }
  });
  it('is symmetric about the centreline and sized by symbolSize (true span and length)', () => {
    for (const [type] of FAMILIES) {
      const size = symbolSize({ type }, 3); // 3 px per metre
      const r = record(size.halfLenPx, type);
      expect(Math.min(...r.xs)).toBeCloseTo(-Math.max(...r.xs), 6);
      const g = glyphFor(type);
      expect(Math.max(...r.xs)).toBeCloseTo(g.spanRatio * size.halfLenPx, 6); // half the wingspan in px
      // length: nose to tail within the glyph's half length (propeller bars may stick out a few percent)
      expect(Math.min(...r.ys)).toBeLessThanOrEqual(-size.halfLenPx + 1e-9);
      expect(Math.min(...r.ys)).toBeGreaterThan(-size.halfLenPx * 1.06);
      expect(Math.max(...r.ys)).toBeCloseTo(size.halfLenPx, 6);
    }
    // never below the readable minimum, true to scale when zoomed in
    expect(symbolSize({ type: 'C172' }, 0.01).halfLenPx).toBe(7);
    expect(symbolSize({ type: 'A320' }, 0.01).halfLenPx).toBe(10);
    expect(symbolSize({ type: 'A320' }, 10).halfLenPx).toBeCloseTo((37.6 * 10) / 2, 9);
  });
  it('differs by family: swept jet vs straight prop wing, T-tail jets, aft vs underwing engines', () => {
    const a320 = glyphFor('A320');
    const c172 = glyphFor('C172');
    const crj = glyphFor('CRJ9');
    expect(a320.spanRatio).toBeGreaterThan(0.9);
    expect(c172.spanRatio).toBeGreaterThan(1.2);
    expect(crj.spanRatio).toBeLessThan(0.75);
    expect(a320.bars.length).toBe(0);
    expect(c172.bars.length).toBe(1); // propeller
    expect(glyphFor('DH8D').bars.length).toBe(1); // twin props, mirrored
    expect(glyphFor('DH8D').bars[0].mirror).toBe(true);
    // swept wing: the tip leading edge is well aft of the root leading edge for the airliner, level for the Cessna
    const tipLe = (g: ReturnType<typeof glyphFor>) => g.half.filter(([x]) => Math.abs(x - g.spanRatio) < 1e-9)[0][1];
    const rootLe = (g: ReturnType<typeof glyphFor>) => g.half.find(([x]) => x === g.fuselageHalfWidth && x > 0)!;
    void rootLe;
    expect(tipLe(a320)).toBeGreaterThan(0.1);
    expect(tipLe(c172)).toBeLessThan(tipLe(a320));
    expect(glyphFor('A320')).toBe(glyphFor('A320')); // cached
  });
  it('falls back to the original generic outline without a type', () => {
    const r = record(10);
    expect(r.ops.filter((o) => o === 'move').length).toBe(1);
    expect(Math.max(...r.xs)).toBeCloseTo(GLYPH_HALF.reduce((m, [x]) => Math.max(m, x), 0) * 10, 9);
    expect(r.ops[r.ops.length - 1]).toBe('close');
  });
});

describe('special traffic on the displays (helicopter, fighter, airport vehicle)', () => {
  /** The engine's N723EJ as another type: same pose and phase, new id / callsign / type. */
  function withSpecial(): { frame: Frame; ids: { h: string; f: string; v: string; fl: string } } {
    const engine = makeEngine();
    const state = engine.getState();
    const base = Object.values(state.aircraft).find((a) => a.callsign === 'N723EJ')!;
    const mk = (id: string, callsign: string, type: string, extra: Partial<Aircraft> = {}): Aircraft => ({ ...base, id, callsign, type, ...extra });
    const aircraft = {
      ...state.aircraft,
      h: mk('h', 'CGD61327', 'H65'),
      f: mk('f', 'ANG61234', 'F16', { pos: { x: base.pos.x + 80, y: base.pos.y + 60 } }),
      v: mk('v', 'APT21', 'VEH', { pos: { x: base.pos.x - 80, y: base.pos.y - 60 } }),
      fl: mk('fl', 'ANG61999', 'F16', { formation: { size: 2 }, pos: { x: base.pos.x + 200, y: base.pos.y } }),
    };
    return { frame: { state: { ...state, aircraft }, nowMs: 1234, pose: poseOf }, ids: { h: 'h', f: 'f', v: 'v', fl: 'fl' } };
  }

  it('marks helicopters, military types and vehicles; ordinary aircraft carry no mark', () => {
    expect(specialMark('H65')).toBe('rotorcraft');
    expect(specialMark('F16')).toBe('military');
    expect(specialMark('VEH')).toBe('vehicle');
    expect(specialMark('C172')).toBeUndefined();
    expect(specialMark('A320')).toBeUndefined();
  });

  it('has closed, symmetric glyphs: a rotor cross for the helicopter, a delta fighter, a boxy vehicle', () => {
    const rec = (type: string) => {
      const ops: string[] = [];
      const xs: number[] = [];
      const ys: number[] = [];
      const ctx = {
        beginPath: () => ops.push('begin'), closePath: () => ops.push('close'),
        moveTo: (x: number, y: number) => { ops.push('move'); xs.push(x); ys.push(y); },
        lineTo: (x: number, y: number) => { ops.push('line'); xs.push(x); ys.push(y); },
      } as unknown as CanvasRenderingContext2D;
      glyphPath(ctx, 20, type);
      return { ops, xs, ys };
    };
    for (const type of ['H65', 'F16', 'VEH']) {
      const r = rec(type);
      expect(r.ops[1]).toBe('move');
      expect(r.ops.filter((o) => o === 'move').length).toBe(r.ops.filter((o) => o === 'close').length);
      expect(r.xs[0]).toBeCloseTo(0, 9);
      expect(r.ys[0]).toBeCloseTo(-20, 9);
      expect(Math.min(...r.xs)).toBeCloseTo(-Math.max(...r.xs), 6);
      for (const v of [...r.xs, ...r.ys]) expect(Number.isFinite(v)).toBe(true);
    }
    expect(glyphFor('H65').family).toBe('helicopter');
    expect(glyphFor('H65').bars.length).toBe(2); // the two crossed rotor blades
    expect(glyphFor('F16').family).toBe('fighter');
    expect(glyphFor('F16').spanRatio).toBeCloseTo(9.96 / 15.06, 2);
    expect(glyphFor('F16').bars.length).toBe(0);
    expect(glyphFor('VEH').family).toBe('groundVehicle');
    expect(glyphFor('VEH').spanRatio).toBeCloseTo(0.36, 2);
    // a fighter's wing is swept: its tip leading edge is aft of the root leading edge
    const g = glyphFor('F16');
    expect(g.half.find(([x]) => x === g.spanRatio)![1]).toBeGreaterThan(0.1);
    // symbol sizes follow the real lengths with the readable minimum
    expect(symbolSize({ type: 'VEH' }, 10).halfLenPx).toBeCloseTo(27.5, 6);
    expect(symbolSize({ type: 'F16' }, 0.01).halfLenPx).toBe(10);
  });

  it('the radar never draws or picks airport vehicles; helicopters and fighters keep their callsign data blocks', () => {
    const { frame } = withSpecial();
    const v = { cx: 0, cy: 0, scale: radarScale(10, 1000, 700), width: 1000, height: 700 };
    const { ctx, calls } = stubContext();
    drawRadar(ctx, frame, v, 10, DEFAULT_RADAR_LAYERS);
    const texts = calls.filter((c) => c.startsWith('fillText:')).map((c) => c.slice('fillText:'.length));
    expect(texts.some((t) => t.startsWith('APT21'))).toBe(false);
    // ground targets are on by default: the helicopter and the fighter show as bare callsigns, the vehicle not at all
    expect(texts).toContain('ANG61234');
    expect(texts).toContain('CGD61327');
    expect(texts).not.toContain('APT21');
    // hit test: with vehicles excluded the vehicle is not selectable on the radar scope, on the surface it is
    const sv = fitBounds(buildSurfaceStatic(airport).bounds, 1000, 600);
    const veh = frame.state.aircraft.v;
    const s = worldToScreen(sv, veh.pos);
    expect(hitTestAircraft(frame, sv, s.x, s.y)).toBe('v');
    expect(hitTestAircraft(frame, sv, s.x, s.y, 16, false)).not.toBe('v');
  });

  it('draws an airborne helicopter as a rotor disc with a blade cross and a fighter as a double square', () => {
    const { frame } = withSpecial();
    const air = (id: string) => ({ ...frame.state.aircraft[id], onGround: false, altitudeFt: 1500, phase: 'DEPARTURE' as const });
    const f2 = { ...frame, state: { ...frame.state, aircraft: { h: air('h'), f: air('f') } } };
    const v = { cx: 0, cy: 0, scale: radarScale(10, 1000, 700), width: 1000, height: 700 };
    const { ctx, calls } = stubContext();
    drawRadar(ctx, f2, v, 10, { ...DEFAULT_RADAR_LAYERS, sweep: false, rings: false, compass: false });
    // helicopter: the rotor disc is an arc (no square); fighter: two nested squares
    expect(calls.filter((c) => c.startsWith('arc')).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.startsWith('strokeRect')).length).toBe(2);
    const texts = calls.filter((c) => c.startsWith('fillText:')).map((c) => c.slice('fillText:'.length));
    expect(texts).toContain('CGD61327 H65');
    expect(texts).toContain('ANG61234 F16');
  });

  it('the surface display draws the vehicle and outlines military aircraft in the military colour', () => {
    const { frame } = withSpecial();
    const v = fitBounds(buildSurfaceStatic(airport).bounds, 1000, 600);
    const strokes: string[] = [];
    const target: Record<string, unknown> = {};
    const ctx = new Proxy(target, {
      get(t, prop: string) {
        if (prop === 'measureText') return (s: string) => ({ width: s.length * 6.5 });
        if (prop === 'stroke') return () => strokes.push(String(t.strokeStyle));
        if (prop in t) return t[prop];
        return () => undefined;
      },
      set(t, prop: string, val) { t[prop] = val; return true; },
    }) as unknown as CanvasRenderingContext2D;
    const { ctx: textCtx, calls } = stubContext();
    drawSurface(ctx, frame, v, DEFAULT_SURFACE_LAYERS);
    drawSurface(textCtx, frame, v, DEFAULT_SURFACE_LAYERS);
    expect(strokes).toContain(C.military);
    const texts = calls.filter((c) => c.startsWith('fillText:')).map((c) => c.slice('fillText:'.length));
    expect(texts).toContain('APT21');
    expect(texts.some((t) => t.startsWith('F16x2 '))).toBe(true); // the formation tag in the label
    expect(texts.some((t) => t.startsWith('VEH '))).toBe(true);
  });

  it('label text carries the formation size', () => {
    const { frame } = withSpecial();
    expect(typeTag(frame.state.aircraft.fl)).toBe('F16x2');
    expect(typeTag(frame.state.aircraft.f)).toBe('F16');
    expect(labelLines(frame.state.aircraft.fl, false)[1]).toMatch(/^F16x2 /);
    expect(dataBlock({ ...frame.state.aircraft.fl, onGround: false }, airport.magneticVariationDeg).lines[0]).toBe('ANG61999 F16x2');
  });
});
