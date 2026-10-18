import { describe, expect, it } from 'vitest';
import type { Runway, Vec2 } from '../../sim/types';
import { loadKacy } from '../../airport';
import {
  cleanRing, extrudeMesh, holdBarRects, offsetPolyline, polygonMesh, ribbonMesh, signedArea, rectMesh, runwayAxis, runwayLights, runwayMarkings,
  samplePolyline, taxiwaySigns, toScene,
} from './geometry';
import type { MeshData } from './geometry';
import {
  aircraftDims, bankFromTurnRate, billboardWorldHeight, classifyAircraft, familyOf, gearDown, lightState, modelPitchRad, pitchFromVerticalSpeed, placeAircraft, withinRange,
} from './aircraftModel';
import type { ModelFamily } from './aircraftModel';
import { buildGeometry, countTriangles, createAircraftFactory } from './aircraftMeshes';
import { LIVERIES, airlinePrefix, finPaint, fuselagePaint, liveryFor } from './liveries';
import {
  FOV_BINOCULARS, FOV_MAX, FOV_MIN, angleDiff, applyDrag, applyZoom, bearingAndElevation, compassTicks, followStep, horizontalFov, initialCam, lookAtPoint,
  lookDirection, snapToPoint, toMagnetic, toggleBinoculars,
} from './cameraMath';
import { ceilingFtAgl, cloudDeck, cloudiness, fogDensityFromVisibility, skyState, sunPosition, sunVector } from './skyMath';
import { resolveTowerSite } from './towerPosition';

const sq: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

/** Sum of triangle areas (scene xz plane) and the sign of each (all must face up: +y normal). */
function triAreas(m: MeshData): number[] {
  const out: number[] = [];
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => m.indices[i + k] * 3);
    const ux = m.positions[b] - m.positions[a], uz = m.positions[b + 2] - m.positions[a + 2];
    const vx = m.positions[c] - m.positions[a], vz = m.positions[c + 2] - m.positions[a + 2];
    // normal.y of (u x v) in scene axes = uz*vx - ux*vz
    out.push((uz * vx - ux * vz) / 2);
  }
  return out;
}

describe('polygon -> mesh', () => {
  it('maps sim (east, north) to scene (x, up, -z)', () => {
    expect(toScene({ x: 3, y: 4 }, 5)).toEqual([3, 5, -4]);
  });
  it('triangulates a square into two upward triangles covering its area', () => {
    const m = polygonMesh(sq, 0.5);
    expect(m.indices).toHaveLength(6);
    const areas = triAreas(m);
    expect(areas.every((a) => a > 0)).toBe(true);
    expect(areas.reduce((s, a) => s + a, 0)).toBeCloseTo(100, 6);
    expect(m.positions.filter((_, i) => i % 3 === 1).every((y) => y === 0.5)).toBe(true);
  });
  it('is winding-independent and drops a repeated closing vertex', () => {
    const cw = [...sq].reverse();
    const closed = [...sq, sq[0]];
    for (const ring of [cw, closed]) {
      const m = polygonMesh(ring, 0);
      expect(m.indices).toHaveLength(6);
      expect(triAreas(m).every((a) => a > 0)).toBe(true);
    }
    expect(cleanRing(closed)).toHaveLength(4);
  });
  it('triangulates a concave L shape without covering the notch', () => {
    const L: Vec2[] = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 }];
    const m = polygonMesh(L, 0);
    expect(m.indices).toHaveLength(12);
    const areas = triAreas(m);
    expect(areas.every((a) => a > 0)).toBe(true);
    expect(areas.reduce((s, a) => s + a, 0)).toBeCloseTo(300, 6);
    expect(signedArea(L)).toBeCloseTo(300, 6);
  });
  it('extrudes walls and a roof with outward-facing walls', () => {
    const m = extrudeMesh(sq, 12);
    expect(m.indices).toHaveLength(6 + 4 * 6);
    const ys = m.positions.filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys)).toBe(12);
    expect(Math.min(...ys)).toBe(0);
    // each wall triangle's normal points away from the centroid (5, -5 in scene)
    for (let i = 6; i < m.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => m.indices[i + k] * 3);
      const p = (o: number) => [m.positions[o], m.positions[o + 1], m.positions[o + 2]];
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      const u = pb.map((v, k) => v - pa[k]);
      const w = pc.map((v, k) => v - pa[k]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const mid = [(pa[0] + pb[0] + pc[0]) / 3 - 5, (pa[2] + pb[2] + pc[2]) / 3 + 5];
      expect(n[0] * mid[0] + n[2] * mid[1]).toBeGreaterThan(0);
    }
  });
});

describe('taxiway ribbons', () => {
  it('extrudes a straight centreline to its width', () => {
    const m = ribbonMesh([{ x: 0, y: 0 }, { x: 100, y: 0 }], 22, 0.04);
    expect(m.positions).toHaveLength(4 * 3);
    const zs = m.positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(22, 6);
    const areas = triAreas(m);
    expect(areas.every((a) => a > 0)).toBe(true);
    expect(areas.reduce((s, a) => s + a, 0)).toBeCloseTo(2200, 4);
  });
  it('mitres a right-angle bend and keeps the width at the corner', () => {
    const m = ribbonMesh([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], 10, 0);
    expect(m.indices).toHaveLength(12);
    // corner vertices at (50,0): the mitre points are (55,-5)... and (45, 5): offset of 5*sqrt2 from the vertex
    const corner = [2, 3].map((k) => [m.positions[k * 3], m.positions[k * 3 + 2]]);
    for (const [x, z] of corner) expect(Math.hypot(x - 50, z - 0)).toBeCloseTo(5 * Math.SQRT2, 5);
    expect(triAreas(m).every((a) => a > 0)).toBe(true);
  });
  it('ignores duplicate points and returns nothing for a point', () => {
    expect(ribbonMesh([{ x: 1, y: 1 }, { x: 1, y: 1 }], 5, 0).indices).toHaveLength(0);
    expect(ribbonMesh([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }], 4, 0).indices).toHaveLength(6);
  });
  it('rects are centred with the right size', () => {
    const m = rectMesh({ x: 100, y: 200 }, 90, 40, 2, 0);
    const xs = m.positions.filter((_, i) => i % 3 === 0);
    const zs = m.positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40, 6); // heading 090 = along x
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(2, 6);
    expect(triAreas(m).reduce((s, a) => s + a, 0)).toBeCloseTo(80, 6);
  });
});

describe('runway markings and lights from the KACY data', () => {
  const kacy = loadKacy();
  const rw13: Runway = kacy.runways.find((r) => r.id === '13/31')!;
  it('lays an axis from threshold to threshold with the data width', () => {
    const ax = runwayAxis(rw13);
    expect(ax.widthM).toBeCloseTo(150 * 0.3048, 6);
    expect(ax.headingDeg).toBeGreaterThan(115);
    expect(ax.headingDeg).toBeLessThan(121); // 13/31 true heading is 118
    expect(ax.length).toBeGreaterThan(2800);
  });
  it('produces centreline dashes, 12 threshold stripes per end, edge lines and aiming bars', () => {
    const m = runwayMarkings(rw13);
    expect(m.centreline.length).toBeGreaterThan(30);
    expect(m.threshold).toHaveLength(24);
    expect(m.edge).toHaveLength(2);
    expect(m.aiming).toHaveLength(4);
    // dashes lie on the axis
    const ax = runwayAxis(rw13);
    const r = (ax.headingDeg * Math.PI) / 180;
    for (const d of m.centreline.slice(0, 5)) {
      const off = (d.c.x - ax.origin.x) * Math.cos(r) - (d.c.y - ax.origin.y) * Math.sin(r);
      expect(Math.abs(off)).toBeLessThan(1e-6);
    }
  });
  it('threshold stripes stay inside the pavement width', () => {
    const ax = runwayAxis(rw13);
    const r = (ax.headingDeg * Math.PI) / 180;
    for (const b of runwayMarkings(rw13).threshold) {
      const across = (b.c.x - ax.origin.x) * Math.cos(r) - (b.c.y - ax.origin.y) * Math.sin(r);
      expect(Math.abs(across) + b.width / 2).toBeLessThanOrEqual(ax.widthM / 2);
    }
  });
  it('runway lights: edge lights every 60 m, centreline only where there is an ILS, no approach lights without data', () => {
    const edgeOnly = runwayLights(rw13, { centreline: false, approach: false });
    const white = edgeOnly.filter((l) => l.colour === 'white');
    const ax = runwayAxis(rw13);
    expect(white.length).toBe(2 * (Math.floor(ax.length / 60) + 1));
    expect(edgeOnly.some((l) => l.colour === 'green')).toBe(true);
    const withCl = runwayLights(rw13, { centreline: true, approach: false });
    expect(withCl.length).toBeGreaterThan(edgeOnly.length + 100);
    const withApp = runwayLights(rw13, { centreline: false, approach: true, approachEnds: ['13'] });
    expect(withApp.length).toBeGreaterThan(edgeOnly.length);
    expect(runwayLights(rw13, { centreline: false, approach: true, approachEnds: [] })).toHaveLength(edgeOnly.length);
  });
  it('hold bars are two bars across the taxiway, perpendicular to the runway direction', () => {
    const bars = holdBarRects({ pos: { x: 0, y: 0 }, towardRunway: { x: 0, y: 5 }, taxiwayWidth: 20 });
    expect(bars).toHaveLength(2);
    for (const b of bars) {
      expect(b.length).toBe(20);
      expect(Math.abs(Math.sin((b.headingDeg * Math.PI) / 180))).toBeCloseTo(1, 6); // long axis east-west
    }
    expect(Math.abs(bars[0].c.y - bars[1].c.y)).toBeCloseTo(0.9, 6);
  });
  it('places taxiway signs at intersections with spacing, and one per letter even without an intersection', () => {
    const nodes = {
      a: { kind: 'intersection', pos: { x: 0, y: 0 }, taxiways: ['A', 'B'] },
      b: { kind: 'intersection', pos: { x: 10, y: 0 }, taxiways: ['A'] }, // too close to A's sign
      c: { kind: 'intersection', pos: { x: 400, y: 0 }, taxiways: ['A'] },
      d: { kind: 'taxiway', pos: { x: 0, y: 500 }, taxiways: ['Z'] },
    };
    const signs = taxiwaySigns(nodes, { A: [[{ x: 0, y: 0 }, { x: 400, y: 0 }]], Z: [[{ x: 0, y: 500 }, { x: 0, y: 700 }]], UNNAMED: [[{ x: 1, y: 1 }, { x: 5, y: 5 }]] });
    expect(signs.filter((s) => s.name === 'A')).toHaveLength(2);
    expect(signs.filter((s) => s.name === 'B')).toHaveLength(1);
    expect(signs.filter((s) => s.name === 'Z')).toHaveLength(1);
    expect(signs.some((s) => s.name === 'UNNAMED')).toBe(false);
  });
  it('real data yields signs for every lettered taxiway', () => {
    const letters = Object.keys(kacy.taxiwayGraph.taxiwayPolylines).filter((n) => n !== 'UNNAMED');
    const signs = taxiwaySigns(kacy.taxiwayGraph.nodes, kacy.taxiwayGraph.taxiwayPolylines);
    for (const l of letters) expect(signs.some((s) => s.name === l)).toBe(true);
  });
  it('samples and offsets polylines', () => {
    const pts = samplePolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }], 30);
    expect(pts.map((p) => p.x)).toEqual([0, 30, 60, 90]);
    const off = offsetPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], 2);
    expect(off[0]).toEqual({ x: 0, y: 2 });
  });
});

describe('aircraft', () => {
  it('classifies by type', () => {
    expect(classifyAircraft('A320')).toBe('airliner');
    expect(classifyAircraft('C172')).toBe('ga');
    expect(classifyAircraft('C25A')).toBe('bizjet');
    expect(classifyAircraft('GLF4')).toBe('bizjet');
    expect(classifyAircraft('B738')).toBe('airliner');
  });
  it('scales models from performance.ts lengths', () => {
    const a = aircraftDims('A320');
    const c = aircraftDims('C172');
    expect(a.lengthM).toBeCloseTo(37.6, 6);
    expect(c.lengthM).toBeCloseTo(8.3, 6);
    expect(a.wingspanM).toBeGreaterThan(30);
    expect(c.wingspanM).toBeGreaterThan(c.lengthM); // GA wings out-span the fuselage
  });
  it('orients by heading: nose (-z) points along the heading', () => {
    const base = { onGround: true, verticalSpeedFpm: 0 };
    const pose = (h: number) => ({ x: 100, y: 50, headingDeg: h, altitudeFt: 74.8, groundSpeedKt: 10 });
    for (const h of [0, 45, 90, 180, 270, 333]) {
      const p = placeAircraft(base, pose(h), 74.8);
      // rotate the local nose (0,0,-1) about +y by yaw: x' = -sin(yaw), z' = -cos(yaw)
      const nose = [-Math.sin(p.yawRad), -Math.cos(p.yawRad)];
      const r = (h * Math.PI) / 180;
      expect(nose[0]).toBeCloseTo(Math.sin(r), 9); // east component of heading
      expect(nose[1]).toBeCloseTo(-Math.cos(r), 9); // north is -z
      expect(p.x).toBe(100);
      expect(p.z).toBe(-50);
    }
  });
  it('sits on the ground when on the ground, at MSL minus field elevation in the air', () => {
    const g = placeAircraft({ onGround: true, verticalSpeedFpm: 0 }, { x: 0, y: 0, headingDeg: 0, altitudeFt: 90, groundSpeedKt: 0 }, 74.8);
    expect(g.y).toBe(0);
    const a = placeAircraft({ onGround: false, verticalSpeedFpm: 0 }, { x: 0, y: 0, headingDeg: 0, altitudeFt: 1074.8, groundSpeedKt: 120 }, 74.8);
    expect(a.y).toBeCloseTo(304.8, 6);
    const low = placeAircraft({ onGround: false, verticalSpeedFpm: 0 }, { x: 0, y: 0, headingDeg: 0, altitudeFt: 50, groundSpeedKt: 120 }, 74.8);
    expect(low.y).toBe(0);
  });
  it('pitches from vertical speed in flight and stays level on the ground', () => {
    expect(pitchFromVerticalSpeed(2000, 150, true)).toBe(0);
    const climb = pitchFromVerticalSpeed(2500, 175, false);
    const level = pitchFromVerticalSpeed(0, 175, false);
    const descent = pitchFromVerticalSpeed(-700, 130, false);
    expect(climb).toBeGreaterThan(level);
    expect(descent).toBeLessThan(level);
    expect(climb).toBeLessThan((20 * Math.PI) / 180 + 1e-9);
    expect(pitchFromVerticalSpeed(60000, 10, false)).toBeLessThanOrEqual((20 * Math.PI) / 180 + 1e-9);
  });
  it('billboards keep a constant on-screen size: world height grows linearly with distance', () => {
    const near = billboardWorldHeight(500, 60, 900, 22);
    const far = billboardWorldHeight(20000, 60, 900, 22);
    expect(far / near).toBeCloseTo(40, 6);
    // projected back to pixels it is exactly the requested 22 px at any distance
    const px = (d: number) => (billboardWorldHeight(d, 60, 900, 22) / (2 * d * Math.tan(Math.PI / 6))) * 900;
    expect(px(500)).toBeCloseTo(22, 6);
    expect(px(20000)).toBeCloseTo(22, 6);
    // zooming in (smaller fov) shrinks the world height for the same pixels
    expect(billboardWorldHeight(1000, 10, 900, 22)).toBeLessThan(billboardWorldHeight(1000, 60, 900, 22));
  });
  it('range filter is in nautical miles', () => {
    expect(withinRange(1852 * 9, 0, 10)).toBe(true);
    expect(withinRange(1852 * 9, 1852 * 5, 10)).toBe(false);
  });
});

describe('camera math', () => {
  it('looks along true bearings in scene axes (north = -z, east = +x)', () => {
    const n = lookDirection(0, 0);
    expect(n[0]).toBeCloseTo(0, 9); expect(n[2]).toBeCloseTo(-1, 9);
    const e = lookDirection(90, 0);
    expect(e[0]).toBeCloseTo(1, 9); expect(e[2]).toBeCloseTo(0, 9);
    const up = lookDirection(33, 90);
    expect(up[1]).toBeCloseTo(1, 9);
    const p = lookAtPoint([10, 30, -5], 90, 0, 100);
    expect(p[0]).toBeCloseTo(110, 9);
    expect(p[1]).toBeCloseTo(30, 9);
    expect(p[2]).toBeCloseTo(-5, 9);
  });
  it('bearing and elevation to a target', () => {
    const t = bearingAndElevation({ x: 0, y: 0 }, 30, { x: 1000, y: 1000 }, 30);
    expect(t.bearingDeg).toBeCloseTo(45, 6);
    expect(t.elevationDeg).toBeCloseTo(0, 6);
    const below = bearingAndElevation({ x: 0, y: 0 }, 30, { x: 0, y: -300 }, 0);
    expect(below.bearingDeg).toBeCloseTo(180, 6);
    expect(below.elevationDeg).toBeLessThan(0);
    const up = bearingAndElevation({ x: 0, y: 0 }, 30, { x: -1000, y: 0 }, 1030);
    expect(up.bearingDeg).toBeCloseTo(270, 6);
    expect(up.elevationDeg).toBeCloseTo(45, 6);
  });
  it('drag swings the view the way the world is dragged, scaled by field of view, with the pitch clamped', () => {
    const cam = initialCam(10);
    const right = applyDrag(cam, 100, 0, 600);
    expect(right.yawDeg).toBeCloseTo(((10 - (100 * 60) / 600) + 360) % 360, 6);
    const zoomed = applyDrag({ ...cam, fovDeg: 6 }, 100, 0, 600);
    expect(10 - zoomed.yawDeg).toBeCloseTo(1, 6);
    expect(applyDrag(cam, 0, 100000, 600).pitchDeg).toBe(80);
    expect(applyDrag(cam, 0, -100000, 600).pitchDeg).toBe(-45);
  });
  it('wheel zoom clamps the field of view; binoculars toggle restores it', () => {
    let cam = initialCam(0);
    for (let i = 0; i < 40; i++) cam = applyZoom(cam, 1.5);
    expect(cam.fovDeg).toBe(FOV_MIN);
    for (let i = 0; i < 40; i++) cam = applyZoom(cam, 1 / 1.5);
    expect(cam.fovDeg).toBe(FOV_MAX);
    const c1 = toggleBinoculars(applyZoom(initialCam(0), 1.5));
    expect(c1.binoculars).toBe(true);
    expect(c1.fovDeg).toBe(FOV_BINOCULARS);
    const c2 = toggleBinoculars(c1);
    expect(c2.binoculars).toBe(false);
    expect(c2.fovDeg).toBeCloseTo(40, 6);
  });
  it('snaps to a runway end from the resolved tower, looking at the pavement', () => {
    const kacy = loadKacy();
    const site = resolveTowerSite(kacy);
    const end = kacy.runways[1].ends[0];
    const cam = snapToPoint(initialCam(0), site.pos, 30, end.threshold);
    const t = bearingAndElevation(site.pos, 30, end.threshold, 0);
    expect(cam.yawDeg).toBeCloseTo(t.bearingDeg, 6);
    expect(Math.abs(cam.pitchDeg)).toBeLessThan(5);
  });
  it('follow eases toward the target by the shortest arc', () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(-20);
    const cam = followStep({ ...initialCam(350), pitchDeg: 0 }, 10, 10, 0.5);
    expect(cam.yawDeg).toBeCloseTo(0, 6);
    expect(cam.pitchDeg).toBeCloseTo(5, 6);
    let c = initialCam(200);
    for (let i = 0; i < 60; i++) c = followStep(c, 90, 3, 0.2);
    expect(c.yawDeg).toBeCloseTo(90, 3);
  });
  it('compass ticks: cardinals labelled, centred on the heading, within the field', () => {
    const ticks = compassTicks(0, 60);
    const north = ticks.find((t) => t.deg === 0)!;
    expect(north.label).toBe('N');
    expect(north.xFrac).toBeCloseTo(0.5, 9);
    expect(ticks.every((t) => t.xFrac >= 0 && t.xFrac <= 1)).toBe(true);
    expect(ticks.find((t) => t.deg === 340)!.label).toBe('34');
    expect(ticks.find((t) => t.deg === 5)!.label).toBe('');
  });
  it('horizontal field of view and magnetic conversion', () => {
    expect(horizontalFov(60, 1)).toBeCloseTo(60, 6);
    expect(horizontalFov(60, 16 / 9)).toBeGreaterThan(90);
    expect(toMagnetic(118, -10)).toBe(128); // KACY: variation -10 (west)
    expect(toMagnetic(5, 10)).toBe(355);
  });
});

describe('sun, sky, fog and cloud', () => {
  const acy = { lat: 39.4576, lon: -74.5772 };
  it('puts the sun high and south at local noon in summer, below the horizon at midnight', () => {
    const noon = sunPosition(acy, Date.UTC(2026, 5, 21, 16, 55)); // ~12:55 EDT... solar noon is ~16:50 UTC
    expect(noon.elevationDeg).toBeGreaterThan(70);
    const morning = sunPosition(acy, Date.UTC(2026, 5, 21, 12, 0));
    expect(morning.azimuthDeg).toBeGreaterThan(60);
    expect(morning.azimuthDeg).toBeLessThan(110);
    const evening = sunPosition(acy, Date.UTC(2026, 5, 21, 22, 0));
    expect(evening.azimuthDeg).toBeGreaterThan(250);
    expect(evening.azimuthDeg).toBeLessThan(310);
    const midnight = sunPosition(acy, Date.UTC(2026, 5, 21, 4, 0));
    expect(midnight.elevationDeg).toBeLessThan(-10);
  });
  it('sun vector is a unit vector in scene axes (east +x, north -z)', () => {
    const v = sunVector({ azimuthDeg: 90, elevationDeg: 0 });
    expect(v[0]).toBeCloseTo(1, 9);
    const n = sunVector({ azimuthDeg: 0, elevationDeg: 45 });
    expect(Math.hypot(...n)).toBeCloseTo(1, 9);
    expect(n[2]).toBeLessThan(0);
  });
  it('maps sun elevation to sky: bright blue day, orange horizon at sunset, dark but never black at night', () => {
    const day = skyState(45);
    const dusk = skyState(0);
    const night = skyState(-30);
    expect(day.night).toBe(0);
    expect(night.night).toBe(1);
    expect(day.sunIntensity).toBe(1);
    expect(night.sunIntensity).toBe(0);
    expect(dusk.horizon[0]).toBeGreaterThan(dusk.horizon[2]); // warm
    expect(day.top[2]).toBeGreaterThan(day.top[0]); // blue
    const lum = (c: number[]) => c[0] + c[1] + c[2];
    expect(lum(night.top)).toBeLessThan(lum(day.top) / 4);
    expect(night.ambient).toBeGreaterThan(0.3); // legible
    expect(skyState(-4).night).toBeGreaterThan(0.1);
    expect(skyState(-4).night).toBeLessThan(0.9);
  });
  it('overcast greys the sky and dims the sun', () => {
    const clear = skyState(30, 0);
    const ovc = skyState(30, 1);
    const sat = (c: number[]) => Math.max(...c) - Math.min(...c);
    expect(sat(ovc.top)).toBeLessThan(sat(clear.top));
    expect(ovc.sunIntensity).toBeLessThan(clear.sunIntensity);
  });
  it('fog density follows visibility', () => {
    expect(fogDensityFromVisibility(1)).toBeGreaterThan(fogDensityFromVisibility(10) * 9);
    // contrast at the visibility distance is 5%
    const V = 3 * 1609.344;
    expect(Math.exp(-((fogDensityFromVisibility(3) * V) ** 2))).toBeCloseTo(0.05, 3);
  });
  it('cloud deck appears only for a low BKN/OVC ceiling', () => {
    expect(cloudDeck({ clouds: [] })).toBeUndefined();
    expect(cloudDeck({ clouds: [{ cover: 'FEW', baseFtAgl: 1500 }] })).toBeUndefined();
    expect(cloudDeck({ clouds: [{ cover: 'BKN', baseFtAgl: 12000 }] })).toBeUndefined();
    const d = cloudDeck({ clouds: [{ cover: 'FEW', baseFtAgl: 1500 }, { cover: 'OVC', baseFtAgl: 800 }] })!;
    expect(d.baseM).toBeCloseTo(800 * 0.3048, 6);
    expect(d.opacity).toBe(1);
    expect(ceilingFtAgl({ clouds: [{ cover: 'BKN', baseFtAgl: 3000 }, { cover: 'OVC', baseFtAgl: 2000 }] })).toBe(2000);
    expect(cloudiness({ clouds: [{ cover: 'SCT', baseFtAgl: 3000 }] })).toBe(0.45);
  });
});

describe('tower position', () => {
  const kacy = loadKacy();
  it('KACY has no tower in the airport data: falls back to the terminal centroid', () => {
    const s = resolveTowerSite(kacy);
    expect(s.source).toBe('terminal-fallback');
    expect(s.pos.x).toBeGreaterThan(300);
    expect(s.pos.x).toBeLessThan(450);
    expect(s.pos.y).toBeGreaterThan(-760);
    expect(s.pos.y).toBeLessThan(-650);
  });
  it('prefers a building named like a tower, then the ARP', () => {
    const withTower = { ...kacy, buildings: [...(kacy as unknown as { buildings: unknown[] }).buildings, { id: 't', kind: 'hangar', name: 'ATCT Tower', polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }] };
    expect(resolveTowerSite(withTower as never).source).toBe('named-building');
    expect(resolveTowerSite({ ...kacy, buildings: [] } as never).source).toBe('arp-fallback');
  });
});

describe('aircraft families and models', () => {
  const TYPES: [string, ModelFamily][] = [
    ['A320', 'narrowbody'], ['B738', 'narrowbody'], ['E175', 'narrowbody'], ['CRJ9', 'regionalJet'], ['DH8D', 'turboprop'], ['C208', 'turbopropSingle'],
    ['C25B', 'bizjet'], ['GLF4', 'bizjet'], ['C172', 'gaHigh'], ['PA28', 'gaLow'], ['SR22', 'gaLow'],
  ];
  it('maps types to families and keeps the sim class', () => {
    for (const [t, f] of TYPES) expect(familyOf(t)).toBe(f);
    expect(classifyAircraft('CRJ9')).toBe('airliner');
    expect(classifyAircraft('DH8D')).toBe('airliner');
    expect(classifyAircraft('C208')).toBe('ga');
    expect(familyOf('ZZZZ')).toBe('gaHigh'); // unknown types fall back to the C172 performance entry
  });
  it('uses the real wingspan/length ratio of each type', () => {
    const b738 = aircraftDims('B738'); // not in the performance table: real length 39.5 m
    expect(b738.lengthM).toBeCloseTo(39.5, 6);
    expect(b738.wingspanM).toBeCloseTo(35.8, 6);
    expect(b738.heightM).toBeCloseTo(12.5, 6);
    const crj = aircraftDims('CRJ9');
    expect(crj.wingspanM / crj.lengthM).toBeCloseTo(24.9 / 36.4, 6);
    expect(aircraftDims('A320').wingspanM).toBeCloseTo((37.6 * 35.8) / 37.57, 6);
    expect(aircraftDims('C172').heightM).toBeCloseTo((8.3 * 2.72) / 8.28, 6);
  });
  it('builds every family without throwing, finite, within the triangle budget and the right size', () => {
    const factory = createAircraftFactory();
    for (const [t] of TYPES) {
      const livery = liveryFor(t === 'C172' || t === 'PA28' || t === 'SR22' || t === 'C208' ? 'N123AB' : 'NKS123');
      const built = buildGeometry(t, livery);
      for (const g of [built.fuselage, built.airframe, built.gear]) {
        const arr = g.getAttribute('position').array as Float32Array;
        for (let i = 0; i < arr.length; i++) expect(Number.isFinite(arr[i])).toBe(true);
      }
      const m = factory.build(t, 'NKS123');
      expect(m.triangles).toBeGreaterThan(300);
      expect(m.triangles).toBeLessThan(3000);
      expect(countTriangles(m.root)).toBe(m.triangles);
      const d = aircraftDims(t);
      built.fuselage.computeBoundingBox();
      const box = built.fuselage.boundingBox!;
      expect(box.max.z - box.min.z).toBeCloseTo(d.lengthM, 3);
      built.airframe.computeBoundingBox();
      expect(built.airframe.boundingBox!.max.x - built.airframe.boundingBox!.min.x).toBeGreaterThan(d.wingspanM * 0.95);
      expect(built.airframe.boundingBox!.max.y).toBeLessThanOrEqual(d.heightM * 1.01);
      expect(built.airframe.boundingBox!.min.y).toBeGreaterThanOrEqual(-0.01); // nothing below the ground
      built.gear.computeBoundingBox();
      expect(built.gear.boundingBox!.min.y).toBeGreaterThanOrEqual(-0.01);
      expect(m.props.length).toBe(familyOf(t) === 'turboprop' ? 2 : ['gaHigh', 'gaLow', 'turbopropSingle'].includes(familyOf(t)) ? 1 : 0);
    }
    factory.dispose();
  });
  it('shares geometry between aircraft of one type and livery', () => {
    const factory = createAircraftFactory();
    const a = factory.build('A320', 'NKS100');
    const b = factory.build('A320', 'NKS200');
    const c = factory.build('A320', 'AAL300');
    const geoOf = (m: typeof a) => (m.root.children[1] as unknown as { geometry: unknown }).geometry;
    expect(geoOf(a)).toBe(geoOf(b));
    expect(geoOf(a)).not.toBe(geoOf(c));
    expect(a.root).not.toBe(b.root);
    factory.dispose();
  });
  it('looks up liveries by airline prefix, registration and unknown prefix', () => {
    expect(airlinePrefix('NKS451')).toBe('NKS');
    expect(airlinePrefix('N723EJ')).toBeUndefined();
    expect(liveryFor('NKS451')).toBe(LIVERIES.NKS);
    expect(liveryFor('nks451').top).toBe(0xffd400); // Spirit yellow
    expect(liveryFor('AAL1234')).toBe(LIVERIES.AAL);
    expect(liveryFor('AAL1234').metalness).toBeGreaterThan(liveryFor('JBU12').metalness); // bare metal
    for (const k of ['DAL', 'UAL', 'JBU', 'SWA', 'FFT', 'RPA', 'ENY', 'SKW']) expect(liveryFor(`${k}12`).id).toBe(k);
    const generic = liveryFor('XYZ123');
    expect(generic.top).toBe(0xf3f5f7);
    expect(liveryFor('XYZ999').id).toBe(generic.id); // seeded by the prefix only
    const ga = liveryFor('N723EJ');
    expect(ga.id.startsWith('GA-')).toBe(true);
    expect(liveryFor('N723EJ')).toEqual(ga); // deterministic by registration
    const stripes = new Set(Array.from({ length: 60 }, (_, i) => liveryFor(`N${100 + i}AB`).id));
    expect(stripes.size).toBeGreaterThan(3); // several cheat-line variants
  });
  it('paints the fuselage: Spirit yellow, window row, cockpit glass, red/white/blue American fin', () => {
    const p = { style: 'airliner' as const, windows: 50 };
    expect(fuselagePaint(LIVERIES.NKS, p, 0.5, 0.0)).toBe(0xffd400);
    expect(fuselagePaint(LIVERIES.NKS, p, 0.5, -0.8)).toBe(0xffd400);
    expect(fuselagePaint(LIVERIES.DAL, p, 0.6, -0.8)).toBe(0x12295a); // blue belly
    expect(fuselagePaint(LIVERIES.NKS, p, 0.07, 0.4)).toBe(0x151a22); // cockpit glass
    const win = new Set<number>();
    for (let i = 0; i < 100; i++) win.add(fuselagePaint(LIVERIES.NKS, p, 0.3 + i * 0.0004, 0.33));
    expect(win.has(0x151a22)).toBe(true);
    expect(finPaint(LIVERIES.AAL, 0.1)).toBe(0x0d3b7a);
    expect(finPaint(LIVERIES.AAL, 0.5)).toBe(0xf2f4f6);
    expect(finPaint(LIVERIES.AAL, 0.95)).toBe(0xc4162e);
    expect(finPaint(LIVERIES.JBU, 0.5)).toBe(0x0b2f78);
  });
  it('retracts the gear of airliners and bizjets above 200 ft AGL, never on fixed-gear types, and lowers it on final', () => {
    const climb = { onGround: false, aglFt: 500, verticalSpeedFpm: 2000, phase: 'INITIAL_CLIMB' as const };
    expect(gearDown('narrowbody', { ...climb, aglFt: 100 })).toBe(true);
    expect(gearDown('narrowbody', climb)).toBe(false);
    expect(gearDown('bizjet', climb)).toBe(false);
    expect(gearDown('regionalJet', climb)).toBe(false);
    expect(gearDown('turboprop', climb)).toBe(false);
    expect(gearDown('gaHigh', climb)).toBe(true);
    expect(gearDown('gaLow', climb)).toBe(true);
    expect(gearDown('turbopropSingle', climb)).toBe(true);
    expect(gearDown('narrowbody', { onGround: true, aglFt: 0, verticalSpeedFpm: 0, phase: 'TAXIING' })).toBe(true);
    expect(gearDown('narrowbody', { onGround: false, aglFt: 1200, verticalSpeedFpm: -700, phase: 'FINAL' })).toBe(true);
    expect(gearDown('narrowbody', { onGround: false, aglFt: 6000, verticalSpeedFpm: -700, phase: 'APPROACH' })).toBe(false);
    expect(gearDown('narrowbody', { onGround: false, aglFt: 5000, verticalSpeedFpm: 0, phase: 'DEPARTURE' })).toBe(false);
  });
  it('pitches 3 degrees on final, 6 to 8 degrees climbing, and rotates on the roll', () => {
    const deg = (r: number) => (r * 180) / Math.PI;
    const base = { onGround: false, aglFt: 1000, groundSpeedKt: 140 };
    expect(deg(modelPitchRad('A320', { ...base, verticalSpeedFpm: -700, phase: 'FINAL' }))).toBeCloseTo(3, 6);
    const climb = deg(modelPitchRad('A320', { ...base, verticalSpeedFpm: 2500, phase: 'INITIAL_CLIMB' }));
    expect(climb).toBeGreaterThanOrEqual(6);
    expect(climb).toBeLessThanOrEqual(8);
    const gaClimb = deg(modelPitchRad('C172', { ...base, groundSpeedKt: 75, verticalSpeedFpm: 700, phase: 'INITIAL_CLIMB' }));
    expect(gaClimb).toBeGreaterThanOrEqual(6);
    expect(gaClimb).toBeLessThanOrEqual(8);
    expect(modelPitchRad('A320', { onGround: true, aglFt: 0, groundSpeedKt: 20, verticalSpeedFpm: 0, phase: 'TAXIING' })).toBe(0);
    expect(modelPitchRad('A320', { onGround: true, aglFt: 0, groundSpeedKt: 100, verticalSpeedFpm: 0, phase: 'TAKEOFF_ROLL' })).toBe(0);
    expect(deg(modelPitchRad('A320', { onGround: true, aglFt: 0, groundSpeedKt: 145, verticalSpeedFpm: 0, phase: 'TAKEOFF_ROLL' }))).toBeCloseTo(6, 6);
  });
  it('banks into a coordinated turn from the turn rate and caps the bank', () => {
    expect(bankFromTurnRate(0, 140)).toBe(0);
    const right = bankFromTurnRate(3, 140);
    expect((right * 180) / Math.PI).toBeGreaterThan(10);
    expect((right * 180) / Math.PI).toBeLessThan(30);
    expect(bankFromTurnRate(-3, 140)).toBeCloseTo(-right, 9);
    expect((bankFromTurnRate(60, 250) * 180) / Math.PI).toBeCloseTo(30, 6);
    expect(bankFromTurnRate(3, 60)).toBeLessThan(right); // slower aircraft bank less at the same rate
  });
  it('drives the lights: dark in daylight, nav + beacon at night, strobes and landing lights by phase', () => {
    const base = { onGround: true, aglFt: 0, phase: 'TAXIING' as const, seed: 0 };
    const sample = (over: Partial<Parameters<typeof lightState>[0]>) => {
      let nav = false, beacon = false, strobe = false, landing = false;
      for (let ms = 0; ms < 1200; ms += 20) {
        const s = lightState({ ...base, lightsOn: true, nowMs: ms, ...over });
        nav = nav || s.nav; beacon = beacon || s.beacon; strobe = strobe || s.strobe; landing = landing || s.landing;
      }
      return { nav, beacon, strobe, landing };
    };
    expect(lightState({ ...base, lightsOn: false, nowMs: 0 })).toEqual({ nav: false, strobe: false, beacon: false, landing: false });
    expect(sample({})).toEqual({ nav: true, beacon: true, strobe: false, landing: false }); // taxiing
    expect(sample({ phase: 'PARKED' }).beacon).toBe(false);
    expect(sample({ phase: 'TAKEOFF_ROLL' })).toEqual({ nav: true, beacon: true, strobe: true, landing: true });
    expect(sample({ onGround: false, aglFt: 800, phase: 'FINAL' })).toEqual({ nav: true, beacon: true, strobe: true, landing: true });
    expect(sample({ onGround: false, aglFt: 15000, phase: 'DEPARTURE' }).landing).toBe(false);
    // the beacon flashes: on for part of the cycle only
    const on = Array.from({ length: 60 }, (_, i) => lightState({ ...base, lightsOn: true, nowMs: i * 20 }).beacon);
    expect(on.some((x) => x)).toBe(true);
    expect(on.some((x) => !x)).toBe(true);
  });
});
