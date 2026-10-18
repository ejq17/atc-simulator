/**
 * Procedural aircraft models for the Tower view (three.js). One recipe per model family (see aircraftModel.ts), built from lathe bodies,
 * extruded planforms and a few primitives, merged into three draw groups: the livery-textured fuselage, the vertex-coloured airframe
 * (wings, tail, engines), and the gear (a separate object so it can be hidden). Geometry and materials are cached per type and livery and
 * shared by every aircraft of that kind; each aircraft is a cheap clone. No model files: everything here is parametric.
 *
 * Model space: nose toward -z, +y up, +x the right wing, origin on the ground under the middle of the fuselage.
 * Real dimensions the proportions are taken from (length / span / height, m): A320 37.57 / 35.80 / 11.76, B738 39.5 / 35.8 / 12.5,
 * E175 31.7 / 26.0 / 9.7, CRJ9 36.4 / 24.9 / 7.5, DH8D 32.8 / 28.4 / 8.3, C25B 14.4 / 15.9 / 4.6, C172 8.28 / 11.0 / 2.72.
 */
import * as THREE from 'three';
import { RECIPES, aircraftDims } from './aircraftModel';
import type { ModelDims, Recipe } from './aircraftModel';
import { finPaint, fuselagePaint, liveryFor } from './liveries';
import type { FuselageStyle, Livery } from './liveries';

const DEG = Math.PI / 180;
const TYRE = 0x1a1c20;
const STRUT = 0x9aa0a7;
const DARK = 0x23262b;
const INTAKE = 0x14161a;

export interface ModelAnchors {
  /** Nav light / strobe positions in model space. */
  tipLeft: [number, number, number];
  tipRight: [number, number, number];
  tail: [number, number, number];
  beaconTop: [number, number, number];
  beaconBelly: [number, number, number];
  landing: [number, number, number];
}

export interface AircraftModel {
  root: THREE.Group;
  gear: THREE.Object3D;
  /** Propeller assemblies to spin about z (empty on jets). */
  props: THREE.Object3D[];
  anchors: ModelAnchors;
  dims: ModelDims;
  /** z of the main gear: the model pitches about this point on the runway. */
  pivotZ: number;
  triangles: number;
}

export interface AircraftFactory {
  /** A fresh instance (shared geometry and materials) for the aircraft's type and callsign. */
  build(type: string, callsign: string): AircraftModel;
  /** 0 (day) .. 1 (night): lifts the unlit side of the aircraft so it keeps its colours under apron lighting. */
  setNight(night: number): void;
  dispose(): void;
}

// ---- geometry helpers --------------------------------------------------------------------------------------------------------------

type Colour = number | ((x: number, y: number, z: number) => number);

function paint(geo: THREE.BufferGeometry, colour: Colour): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const arr = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.setHex(typeof colour === 'number' ? colour : colour(pos.getX(i), pos.getY(i), pos.getZ(i)));
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (!n.getAttribute('normal')) n.computeVertexNormals();
    return n;
  });
  const total = parts.reduce((s, g) => s + g.getAttribute('position').count, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const c = g.getAttribute('color');
    position.set(p.array as Float32Array, o * 3);
    normal.set(n.array as Float32Array, o * 3);
    if (c) color.set(c.array as Float32Array, o * 3);
    else color.fill(1, o * 3, (o + p.count) * 3);
    o += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  return out;
}

/** Revolve (radius, distance-from-front) points about the z axis; the first point is the front (z = 0), later points go aft (+z). */
function lathe(points: [number, number][], segments: number): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(points.map(([r, d]) => new THREE.Vector2(r, d)), segments);
  g.rotateX(Math.PI / 2); // lathe y -> z; lathe phi = 0 ends up at the belly (-y), phi = pi at the crown
  return g;
}

/** Average the normals on the lathe seam (first and last segment share positions) so no crease shows on the belly. */
function closeSeam(g: THREE.BufferGeometry, ringSize: number, segments: number): void {
  const n = g.getAttribute('normal');
  const v = new THREE.Vector3();
  for (let j = 0; j < ringSize; j++) {
    const a = j;
    const b = segments * ringSize + j;
    v.set(n.getX(a) + n.getX(b), n.getY(a) + n.getY(b), n.getZ(a) + n.getZ(b)).normalize();
    n.setXYZ(a, v.x, v.y, v.z);
    n.setXYZ(b, v.x, v.y, v.z);
  }
}

function mapVerts(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number) => [number, number, number]): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const [x, y, z] = fn(p.getX(i), p.getY(i), p.getZ(i));
    p.setXYZ(i, x, y, z);
  }
  p.needsUpdate = true;
  return g;
}

/** A horizontal slab from a planform polygon [x, z] of constant thickness, centred on y = 0. */
function slab(poly: [number, number][], thick: number): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  poly.forEach(([x, z], i) => (i === 0 ? sh.moveTo(x, -z) : sh.lineTo(x, -z)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false });
  g.translate(0, 0, -thick / 2);
  g.rotateX(-Math.PI / 2); // (x, y, depth) -> (x, depth, -y)
  return g;
}

/** A vertical plate from a profile polygon [z aft, y up] of the given thickness (across x), centred on x = 0. */
function plate(poly: [number, number][], thick: number): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  poly.forEach(([z, y], i) => (i === 0 ? sh.moveTo(z, y) : sh.lineTo(z, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false });
  g.translate(0, 0, -thick / 2);
  g.rotateY(-Math.PI / 2); // (z, y, depth) -> (-depth, y, z)
  return g;
}

function tube(a: [number, number, number], b: [number, number, number], r: number, seg = 6): THREE.BufferGeometry {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return g;
}

function wheel(x: number, y: number, z: number, r: number, width: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, width, 10, 1);
  g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

// ---- family recipes ----------------------------------------------------------------------------------------------------------------

/** Fuselage profile as [radius, distance from nose] pairs, in metres. */
function fuselageProfile(rc: Recipe, L: number, R: number): [number, number][] {
  const pts: [number, number][] = [];
  if (rc.gaProfile) {
    const prof: [number, number][] = [
      [0, 0], [0.42, 0.004], [0.5, 0.02], [0.57, 0.07], [0.7, 0.15], [0.85, 0.24], [0.97, 0.32], [1, 0.42], [1, 0.54],
      [0.82, 0.63], [0.6, 0.72], [0.42, 0.82], [0.27, 0.91], [0.17, 1],
    ];
    return prof.map(([r, t]) => [r * R, t * L]);
  }
  const noseLen = rc.nose * R;
  const tailLen = rc.tail * R;
  for (let i = 0; i <= 9; i++) {
    const s = i / 9;
    pts.push([R * Math.pow(Math.sin((s * Math.PI) / 2), 0.85), noseLen * s]);
  }
  const body0 = noseLen;
  const body1 = L - tailLen;
  for (let i = 1; i <= 3; i++) pts.push([R, body0 + ((body1 - body0) * i) / 4]);
  pts.push([R, body1]);
  for (let i = 1; i <= 10; i++) {
    const u = i / 10;
    pts.push([R * (0.1 + 0.9 * (1 - Math.pow(u, 1.8))), body1 + tailLen * u]);
  }
  return pts;
}

export interface BuiltModel {
  fuselage: THREE.BufferGeometry;
  airframe: THREE.BufferGeometry;
  gear: THREE.BufferGeometry;
  /** Always-visible parts of the gear (fixed gear) are merged into `gear`; retractable gear hides the whole object. */
  anchors: ModelAnchors;
  pivotZ: number;
  props: { pos: [number, number, number]; radius: number; blades: number }[];
  style: FuselageStyle;
  windows: number;
}

/** Build the geometry for a type (pure three.js data, no materials), painted for the livery. */
export function buildGeometry(type: string, livery: Livery): BuiltModel {
  const d = aircraftDims(type);
  const rc = RECIPES[d.family];
  const L = d.lengthM;
  const b = d.wingspanM;
  const H = d.heightM;
  const R = rc.R * L;
  const sq = rc.sq;
  const y0 = R * sq + rc.clear * L;
  const zNose = -L / 2;
  const zTail = L / 2;
  const tailStartZ = rc.gaProfile ? zNose + 0.54 * L : zTail - rc.tail * R;
  const upM = rc.up * R;

  // Axis height at z (nose droop on jets, tail upsweep everywhere).
  const axisY = (z: number): number => {
    let y = y0;
    if (!rc.gaProfile) {
      const nl = rc.nose * R;
      if (z < zNose + nl) y -= 0.15 * R * Math.pow(1 - (z - zNose) / nl, 2);
    }
    if (z > tailStartZ) y += upM * Math.pow((z - tailStartZ) / (zTail - tailStartZ), 2);
    return y;
  };
  const profile = fuselageProfile(rc, L, R);
  const radiusAt = (z: number): number => {
    const dz = z - zNose;
    for (let i = 1; i < profile.length; i++) {
      if (dz <= profile[i][1]) {
        const [r0, z0] = profile[i - 1];
        const [r1, z1] = profile[i];
        return r0 + ((r1 - r0) * (dz - z0)) / Math.max(1e-6, z1 - z0);
      }
    }
    return profile[profile.length - 1][0];
  };

  // ---- fuselage (livery-textured) ----
  const SEG = 16;
  const fus = lathe(profile, SEG);
  fus.translate(0, 0, zNose);
  mapVerts(fus, (x, y, z) => [x, axisY(z) + y * sq, z]);
  fus.computeVertexNormals();
  closeSeam(fus, profile.length, SEG);
  const uv = fus.getAttribute('uv');
  const fp = fus.getAttribute('position');
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - (fp.getZ(i) - zNose) / L); // v = 1 - t, t = 0 at the nose
  uv.needsUpdate = true;

  const air: THREE.BufferGeometry[] = [];
  const gear: THREE.BufferGeometry[] = [];

  // ---- wing ----
  const w = rc.wing;
  const semi = b / 2;
  const rootC = w.rc * L;
  const tipC = w.tc * L;
  const zLE0 = zNose + w.t0 * L;
  const tanS = Math.tan(w.sweep * DEG);
  const tanD = Math.tan(w.dih * DEG);
  const wingLE = (x: number): number => zLE0 + Math.abs(x) * tanS;
  const wingChord = (x: number): number => rootC + (tipC - rootC) * (Math.abs(x) / semi);
  const yRoot = w.high ? y0 + R * sq * 0.8 : y0 - R * sq * 0.5;
  const wingY = (x: number): number => yRoot + Math.abs(x) * tanD;
  const thick = rootC * w.thick;
  const wingPoly: [number, number][] = [
    [-semi, wingLE(semi)], [0, zLE0], [semi, wingLE(semi)], [semi, wingLE(semi) + tipC], [0, zLE0 + rootC], [-semi, wingLE(semi) + tipC],
  ];
  const wingGeo = slab(wingPoly, thick);
  mapVerts(wingGeo, (x, y, z) => [x, yRoot + y * (1 + (tipC / rootC - 1) * (Math.abs(x) / semi)) + Math.abs(x) * tanD, z]);
  air.push(paint(wingGeo, livery.wing));
  let tipY = wingY(semi);
  if (w.winglet > 0) {
    const h = w.winglet * L;
    const cb = tipC * 0.95;
    for (const side of [-1, 1]) {
      const wl = plate([[0, 0], [cb, 0], [cb * 0.55 + h * 0.5, h], [h * 0.5, h]], thick * 0.4);
      wl.translate(side * (semi - thick * 0.2), tipY, wingLE(semi) + tipC * 0.02);
      air.push(paint(wl, livery.fin[livery.fin.length >> 1]));
    }
    tipY += h * 0.5;
  }
  if (w.struts) {
    for (const side of [-1, 1]) {
      const zs = zLE0 + rootC * 0.55;
      const xo = semi * 0.42;
      air.push(paint(tube([side * R * sq * 0.55, y0 - R * sq * 0.6, zs + rootC * 0.05], [side * xo, wingY(xo) - thick * 0.4, wingLE(xo) + wingChord(xo) * 0.5], 0.035 * Math.max(1, L / 8), 5), STRUT));
    }
  }

  // ---- tail ----
  const f = rc.fin;
  const finRoot = f.rc * L;
  const finTE = zTail - f.zTE * L;
  const finLE = finTE - finRoot;
  const yb = Math.min(axisY(finLE) + radiusAt(finLE) * sq, axisY(finTE) + radiusAt(finTE) * sq) - 0.2 * R * sq;
  const finH = Math.max(R, H - yb);
  const finSweepOff = finH * Math.tan(f.sweep * DEG);
  const finTipLE = finLE + finSweepOff;
  const finTipTE = finTipLE + f.tc * L;
  const finThick = Math.max(0.12, R * 0.12);
  const finAt = (h: number): [number, number] => [finLE + finSweepOff * h, finTE + (finTipTE - finTE) * h]; // [LE z, TE z] at height fraction h
  const nStripes = livery.fin.length;
  for (let k = 0; k < nStripes; k++) {
    const [le0, te0] = finAt(k / nStripes);
    const [le1, te1] = finAt((k + 1) / nStripes);
    const y1 = yb + (finH * k) / nStripes;
    const y2 = yb + (finH * (k + 1)) / nStripes;
    air.push(paint(plate([[le0, y1], [te0, y1], [te1, y2], [le1, y2]], finThick), finPaint(livery, (k + 0.5) / nStripes)));
  }
  const s = rc.stab;
  const stabSemi = (s.span * b) / 2;
  const stabRoot = s.rc * L;
  const stabTip = s.tc * L;
  const stabTE = s.tTail ? finTipTE + 0.2 * stabRoot : zTail - s.zTE * L;
  const stabLE = stabTE - stabRoot;
  const stabY = s.tTail ? yb + finH - 0.03 * finH : axisY(stabTE - stabRoot * 0.5) + R * sq * 0.1;
  const stabTan = Math.tan(s.sweep * DEG);
  const stabPoly: [number, number][] = [
    [-stabSemi, stabLE + stabSemi * stabTan], [0, stabLE], [stabSemi, stabLE + stabSemi * stabTan], [stabSemi, stabLE + stabSemi * stabTan + stabTip],
    [0, stabTE], [-stabSemi, stabLE + stabSemi * stabTan + stabTip],
  ];
  const stabGeo = slab(stabPoly, Math.max(0.08, stabRoot * 0.09));
  mapVerts(stabGeo, (x, y, z) => [x, stabY + y + Math.abs(x) * Math.tan((s.tTail ? 0 : 4) * DEG), z]);
  air.push(paint(stabGeo, livery.tailplane));

  // ---- engines ----
  const eng = rc.engine;
  const rN = eng.r * L;
  const nLen = eng.len * L;
  const nacelle = (cx: number, cy: number, zFront: number, withExhaust: boolean): void => {
    const pts: [number, number][] = [
      [rN * 0.9, 0], [rN * 0.98, nLen * 0.05], [rN, nLen * 0.25], [rN * 0.95, nLen * 0.5], [rN * 0.8, nLen * 0.75], [rN * 0.58, nLen * 0.95], [rN * 0.5, nLen],
    ];
    const g = lathe(pts, 12);
    g.translate(cx, cy, zFront);
    closeSeam(g, pts.length, 12);
    air.push(paint(g, livery.engine));
    const fan = new THREE.CircleGeometry(rN * 0.86, 12);
    fan.rotateY(Math.PI);
    fan.translate(cx, cy, zFront + nLen * 0.07);
    air.push(paint(fan, INTAKE));
    if (withExhaust) {
      const ex = new THREE.CircleGeometry(rN * 0.46, 10);
      ex.translate(cx, cy, zFront + nLen);
      air.push(paint(ex, DARK));
    }
  };
  const props: BuiltModel['props'] = [];
  if (rc.engines === 'wing') {
    for (const side of [-1, 1]) {
      const x = side * eng.x * semi;
      const cy = wingY(x) - thick * 0.5 - rN * 0.95;
      const zf = wingLE(x) - nLen * 0.62;
      nacelle(x, cy, zf, true);
      air.push(paint(box(rN * 0.28, rN * 0.9, nLen * 0.55, x, cy + rN * 0.8, zf + nLen * 0.5), livery.wing)); // pylon
    }
  } else if (rc.engines === 'rear') {
    const zf = zNose + 0.775 * L;
    for (const side of [-1, 1]) {
      const rr = radiusAt(zf + nLen * 0.5);
      const cx = side * (rr + rN * 1.05);
      const cy = axisY(zf + nLen * 0.5) + R * sq * 0.3;
      nacelle(cx, cy, zf, true);
      air.push(paint(box(Math.max(0.1, cx * side - rr * 0.85), rN * 0.45, nLen * 0.7, cx * 0.5 + side * rr * 0.4, cy - rN * 0.05, zf + nLen * 0.55), livery.wing));
    }
  } else if (rc.engines === 'turboprop') {
    const pr = rc.prop!;
    for (const side of [-1, 1]) {
      const x = side * eng.x * semi;
      const cy = wingY(x) - thick * 0.5 - rN * 0.35;
      const zf = wingLE(x) - nLen * 0.55;
      nacelle(x, cy, zf, false);
      const spin = new THREE.ConeGeometry(rN * 0.38, rN * 0.9, 10).rotateX(-Math.PI / 2).translate(x, cy, zf - rN * 0.35);
      air.push(paint(spin, DARK));
      props.push({ pos: [x, cy, zf - rN * 0.55], radius: pr.r * L, blades: pr.blades });
      // main gear leg and wheels live under the nacelle
      const wr = rc.gear.wheelR * L;
      const gz = zf + nLen * 0.55;
      gear.push(paint(tube([x, cy - rN * 0.6, gz], [x, wr, gz], 0.05 * Math.max(1, L / 20)), STRUT));
      for (const dx of [-1, 1]) gear.push(paint(wheel(x + dx * wr * 0.8, wr, gz, wr, wr * 0.7), TYRE));
    }
  } else {
    // single nose engine: cowl is part of the fuselage; spinner and propeller
    const pr = rc.prop!;
    const nr = profile[1][0];
    const spin = new THREE.ConeGeometry(nr * 0.85, nr * 1.5, 10).rotateX(-Math.PI / 2).translate(0, axisY(zNose), zNose - nr * 0.6);
    air.push(paint(spin, DARK));
    props.push({ pos: [0, axisY(zNose), zNose - nr * 1.25], radius: pr.r * L, blades: pr.blades });
  }

  // ---- landing gear ----
  const g = rc.gear;
  const wr = g.wheelR * L;
  const noseZ = zNose + g.nose * L;
  const mainZ = zNose + g.main * L;
  const noseTop = axisY(noseZ) - radiusAt(noseZ) * sq * 0.6;
  const nwr = wr * (rc.gaProfile ? 0.85 : 0.75);
  gear.push(paint(tube([0, noseTop, noseZ], [0, nwr, noseZ], Math.max(0.04, wr * 0.12)), STRUT));
  if (g.twin) for (const dx of [-1, 1]) gear.push(paint(wheel(dx * nwr * 0.75, nwr, noseZ, nwr, nwr * 0.7), TYRE));
  else gear.push(paint(wheel(0, nwr, noseZ, nwr, nwr * 0.7), TYRE));
  const trackX = g.track * L;
  if (rc.engines !== 'turboprop') {
    for (const side of [-1, 1]) {
      const x = side * trackX;
      const top = rc.gaProfile && w.high ? axisY(mainZ) - R * sq * 0.5 : Math.max(wr * 3, wingY(x) - thick * 0.5);
      if (rc.gaProfile && w.high) {
        gear.push(paint(tube([side * R * sq * 0.5, top, mainZ], [x, wr, mainZ], Math.max(0.04, wr * 0.14)), STRUT));
      } else {
        gear.push(paint(tube([x, top, mainZ], [x, wr, mainZ], Math.max(0.045, wr * 0.14)), STRUT));
      }
      if (g.twin) for (const dx of [-1, 1]) gear.push(paint(wheel(x + dx * wr * 0.75, wr, mainZ, wr, wr * 0.75), TYRE));
      else gear.push(paint(wheel(x, wr, mainZ, wr, wr * 0.7), TYRE));
      if (g.pants) {
        const pant = new THREE.SphereGeometry(1, 8, 6).scale(wr * 0.5, wr * 1.1, wr * 2.2).translate(x, wr * 1.1, mainZ + wr * 0.3);
        gear.push(paint(pant, livery.top));
      }
    }
  }

  const landingY = Math.max(wr * 2, noseTop - 0.2 * R);
  const anchors: ModelAnchors = {
    tipLeft: [-semi, tipY, wingLE(semi) + tipC * 0.5],
    tipRight: [semi, tipY, wingLE(semi) + tipC * 0.5],
    tail: [0, yb + finH * 0.985, finTipTE],
    beaconTop: [0, y0 + R * sq * 1.02, zNose + 0.5 * L],
    beaconBelly: [0, y0 - R * sq * 1.02, zNose + 0.52 * L],
    landing: [0, rc.gaProfile ? y0 - R * sq * 0.3 : landingY, noseZ + 0.2],
  };
  const windows = Math.round(rc.windowsPerLen * L);
  return { fuselage: fus, airframe: merge(air), gear: merge(gear), anchors, pivotZ: mainZ, props, style: rc.style, windows };
}

// ---- textures, materials, factory ---------------------------------------------------------------------------------------------------

const TEX_W = 64;
const TEX_H = 512;

/** Sample the livery paint function into a texture: x = around the fuselage (0 and 1 = belly, 0.5 = crown), y = nose (top) to tail. */
export function fuselageTexture(livery: Livery, style: FuselageStyle, windows: number): THREE.DataTexture {
  const data = new Uint8Array(TEX_W * TEX_H * 4);
  for (let row = 0; row < TEX_H; row++) {
    const t = 1 - (row + 0.5) / TEX_H; // DataTexture row 0 is v = 0, which the geometry maps to the tail
    for (let col = 0; col < TEX_W; col++) {
      const u = (col + 0.5) / TEX_W;
      const v = -Math.cos(2 * Math.PI * u);
      const hex = fuselagePaint(livery, { style, windows }, t, v);
      const o = (row * TEX_W + col) * 4;
      // the texture is flagged sRGB, so the 8-bit components are the plain hex bytes
      data[o] = (hex >> 16) & 255;
      data[o + 1] = (hex >> 8) & 255;
      data[o + 2] = hex & 255;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, TEX_W, TEX_H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export function countTriangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry;
    n += (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
  });
  return n;
}

interface Template {
  fuselageGeo: THREE.BufferGeometry;
  airframeGeo: THREE.BufferGeometry;
  gearGeo: THREE.BufferGeometry;
  materials: THREE.Material[];
  built: BuiltModel;
  dims: ModelDims;
  livery: Livery;
  fuselageMat: THREE.Material;
  airframeMat: THREE.Material;
  gearMat: THREE.Material;
  propDiscMat: THREE.Material;
  propBladeMat: THREE.Material;
}

/** Cached geometry/materials per (type, livery); build() returns a lightweight clone with its own gear/prop handles. */
export function createAircraftFactory(): AircraftFactory {
  const templates = new Map<string, Template>();
  const textures = new Map<string, THREE.DataTexture>();
  const discGeo = new THREE.CircleGeometry(1, 24);
  const bladeGeo = new THREE.BoxGeometry(2, 0.09, 0.02);
  const owned: { dispose(): void }[] = [discGeo, bladeGeo];
  let night = 0;
  const applyNight = (t: Template): void => {
    const f = t.fuselageMat as THREE.MeshStandardMaterial;
    f.emissive.setRGB(1, 1, 1);
    f.emissiveIntensity = 0.2 * night;
    (t.airframeMat as THREE.MeshStandardMaterial).emissive.setRGB(0.1 * night, 0.1 * night, 0.11 * night);
    (t.gearMat as THREE.MeshStandardMaterial).emissive.setRGB(0.05 * night, 0.05 * night, 0.05 * night);
  };

  const template = (type: string, callsign: string): Template => {
    const livery = liveryFor(callsign);
    const key = `${type}|${livery.id}`;
    const hit = templates.get(key);
    if (hit) return hit;
    const dims = aircraftDims(type);
    const built = buildGeometry(type, livery);
    const texKey = `${livery.id}|${built.style}|${built.windows}`;
    let map = textures.get(texKey);
    if (!map) { map = fuselageTexture(livery, built.style, built.windows); textures.set(texKey, map); }
    const metal = Math.min(0.2, livery.metalness);
    const fuselageMat = new THREE.MeshStandardMaterial({ map, roughness: 0.5, metalness: metal });
    const airframeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: metal });
    const gearMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.1 });
    const propDiscMat = new THREE.MeshBasicMaterial({ color: 0x1a1c20, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, fog: true });
    const propBladeMat = new THREE.MeshStandardMaterial({ color: 0x25282d, roughness: 0.6 });
    const t: Template = {
      fuselageGeo: built.fuselage, airframeGeo: built.airframe, gearGeo: built.gear, built, dims, livery,
      materials: [fuselageMat, airframeMat, gearMat, propDiscMat, propBladeMat], fuselageMat, airframeMat, gearMat, propDiscMat, propBladeMat,
    };
    (fuselageMat as THREE.MeshStandardMaterial).emissiveMap = map;
    applyNight(t);
    templates.set(key, t);
    return t;
  };

  return {
    build(type, callsign) {
      const t = template(type, callsign);
      const root = new THREE.Group();
      root.add(new THREE.Mesh(t.fuselageGeo, t.fuselageMat), new THREE.Mesh(t.airframeGeo, t.airframeMat));
      const gearObj = new THREE.Mesh(t.gearGeo, t.gearMat);
      gearObj.name = 'gear';
      root.add(gearObj);
      const props: THREE.Object3D[] = [];
      for (const p of t.built.props) {
        const grp = new THREE.Group();
        grp.name = 'prop';
        const disc = new THREE.Mesh(discGeo, t.propDiscMat);
        disc.scale.set(p.radius, p.radius, 1);
        grp.add(disc);
        for (let i = 0; i < Math.max(1, Math.ceil(p.blades / 2)); i++) {
          const blade = new THREE.Mesh(bladeGeo, t.propBladeMat);
          blade.scale.set(p.radius * 0.97, p.radius * 0.5, 1);
          blade.rotation.z = (i * Math.PI) / Math.ceil(p.blades / 2);
          grp.add(blade);
        }
        grp.position.set(...p.pos);
        root.add(grp);
        props.push(grp);
      }
      return {
        root, gear: gearObj, props, anchors: t.built.anchors, dims: t.dims, pivotZ: t.built.pivotZ,
        triangles: countTriangles(root),
      };
    },
    setNight(n) {
      const v = Math.max(0, Math.min(1, n));
      if (Math.abs(v - night) < 0.01) return;
      night = v;
      for (const t of templates.values()) applyNight(t);
    },
    dispose() {
      for (const t of templates.values()) {
        t.fuselageGeo.dispose();
        t.airframeGeo.dispose();
        t.gearGeo.dispose();
        for (const m of t.materials) m.dispose();
      }
      for (const tx of textures.values()) tx.dispose();
      for (const o of owned) o.dispose();
      templates.clear();
      textures.clear();
    },
  };
}
