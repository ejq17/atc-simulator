/**
 * Procedural models of the special traffic for the Tower view: the Coast Guard MH-65 Dolphin helicopter, the Air National Guard F-16C and
 * an airport pickup truck. Same conventions as aircraftMeshes.ts (model space: nose toward -z, +y up, +x the right side, origin on the ground
 * under the middle of the body; fuselage = livery-textured lathe, airframe = vertex-coloured parts, gear = wheels), built from the helpers
 * in meshKit.ts. Real dimensions (length / span / height, m): MH-65 13.54 (rotors turning) / 11.94 (rotor diameter) / 3.99, F-16C 15.06 /
 * 9.96 (over the wingtip missiles) / 4.88, pickup 5.5 / 2.0 / 1.9.
 */
import * as THREE from 'three';
import { aircraftDims } from './aircraftModel';
import type { BuiltModel, ModelAnchors } from './aircraftMeshes';
import { box, closeSeam, lathe, mapVerts, merge, paint, plate, slab, tube, wheel } from './meshKit';
import type { Livery } from './liveries';
import { finPaint } from './liveries';

const DEG = Math.PI / 180;
const TYRE = 0x1a1c20;
const STRUT = 0x9aa0a7;
const DARK = 0x23262b;
const GLASS = 0x151a22;
const AMBER = 0xffa31a;

/** Fuselage lathe from [radius ratio, length ratio] pairs, centred on z = 0 and lifted onto the axis height function; UVs map v = 1 - t. */
function bodyLathe(prof: [number, number][], R: number, len: number, sq: number, axisY: (z: number) => number, seg = 14): THREE.BufferGeometry {
  const pts = prof.map(([r, t]) => [r * R, t * len] as [number, number]);
  const g = lathe(pts, seg);
  g.translate(0, 0, -len / 2);
  mapVerts(g, (x, y, z) => [x, axisY(z) + y * sq, z]);
  g.computeVertexNormals();
  closeSeam(g, pts.length, seg);
  const uv = g.getAttribute('uv');
  const p = g.getAttribute('position');
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - (p.getZ(i) + len / 2) / len);
  uv.needsUpdate = true;
  return g;
}

// ---- Coast Guard MH-65 Dolphin ---------------------------------------------------------------------------------------------------

/** Fuselage length as a fraction of the 13.54 m overall length (the overall figure includes the main rotor blades reaching past the nose). */
const H65_BODY = 0.86;

function buildHelicopter(livery: Livery): BuiltModel {
  const d = aircraftDims('H65');
  const k = d.lengthM / 13.54;
  const F = d.lengthM * H65_BODY;
  const zNose = -F / 2;
  const zTail = F / 2;
  const R = 0.95 * k;
  const sq = 1.2;
  const y0 = 1.68 * k; // axis height of the cabin
  const zBoom = zNose + 0.5 * F;
  const rise = 0.5 * k; // the boom climbs slightly toward the fenestron
  const axisY = (z: number): number => y0 + (z > zBoom ? ((z - zBoom) / (zTail - zBoom)) * rise : 0);

  // [radius / R, distance / F]: rounded nose, deep cabin, narrowing into the boom
  const prof: [number, number][] = [
    [0, 0], [0.5, 0.012], [0.72, 0.05], [0.88, 0.11], [0.98, 0.18], [1, 0.26], [1, 0.42], [0.86, 0.5], [0.56, 0.57], [0.36, 0.64], [0.27, 0.74], [0.24, 0.9], [0.23, 1],
  ];
  const fus = bodyLathe(prof, R, F, sq, axisY);

  const air: THREE.BufferGeometry[] = [];
  const gear: THREE.BufferGeometry[] = [];
  const white = livery.top;
  const red = livery.fin[0];

  // engine deck and transmission fairing on top of the cabin
  const deck = new THREE.SphereGeometry(1, 12, 8).scale(0.62 * k, 0.4 * k, 2.35 * k).translate(0, y0 + R * sq * 0.9, zNose + 0.42 * F);
  air.push(paint(deck, white));
  // exhaust stubs
  for (const side of [-1, 1]) air.push(paint(tube([side * 0.34 * k, y0 + R * sq * 1.05, zNose + 0.55 * F], [side * 0.36 * k, y0 + R * sq * 1.0, zNose + 0.6 * F], 0.11 * k, 8), DARK));
  // main rotor mast and hub (the rotating blades are a prop assembly, see the factory)
  const hubY = d.heightM - 0.18;
  air.push(paint(tube([0, y0 + R * sq * 1.15, zNose + 0.4 * F], [0, hubY, zNose + 0.4 * F], 0.13 * k, 8), DARK));
  air.push(paint(new THREE.CylinderGeometry(0.34 * k, 0.4 * k, 0.2 * k, 12).translate(0, hubY, zNose + 0.4 * F), DARK));

  // tail: fin with the fenestron duct, stabiliser with end plates
  const yb = axisY(zTail) - 0.12 * k;
  const finTop = 1.8 * k;
  const fin = plate([[zTail - 1.65 * k, yb], [zTail - 0.05 * k, yb], [zTail - 0.2 * k, yb + finTop], [zTail - 1.0 * k, yb + finTop]], 0.16 * k);
  air.push(paint(fin, (_x, y) => (y - yb > finTop * 0.62 ? red : white)));
  const fenR = 0.5 * k;
  const fenY = yb + 0.74 * k;
  const fenZ = zTail - 0.72 * k;
  const duct = new THREE.CylinderGeometry(fenR, fenR, 0.44 * k, 16, 1, true);
  duct.rotateZ(Math.PI / 2).translate(0, fenY, fenZ);
  air.push(paint(duct, white));
  const hub = new THREE.CylinderGeometry(0.1 * k, 0.1 * k, 0.5 * k, 8).rotateZ(Math.PI / 2).translate(0, fenY, fenZ);
  air.push(paint(hub, DARK));
  const stabZ = zTail - 2.9 * k;
  const stab = slab([[-1.15 * k, stabZ], [0, stabZ - 0.1 * k], [1.15 * k, stabZ], [1.15 * k, stabZ + 0.55 * k], [-1.15 * k, stabZ + 0.55 * k]], 0.07 * k);
  stab.translate(0, axisY(stabZ + 0.3 * k) + 0.14 * k, 0);
  air.push(paint(stab, white));
  for (const side of [-1, 1]) {
    const e = plate([[stabZ - 0.05 * k, 0], [stabZ + 0.6 * k, 0], [stabZ + 0.55 * k, 0.75 * k], [stabZ + 0.1 * k, 0.75 * k]], 0.05 * k);
    e.translate(side * 1.15 * k, axisY(stabZ + 0.3 * k) - 0.1 * k, 0);
    air.push(paint(e, red));
  }
  // nose-mounted sensor turret / chin blister
  air.push(paint(new THREE.SphereGeometry(0.26 * k, 8, 6).translate(0, y0 - R * sq * 0.95, zNose + 0.9 * k), DARK));

  // fixed wheel gear: two main wheels in sponsons aft of the cabin, a nose wheel
  const wr = 0.2 * k;
  const mainZ = zNose + 0.4 * F;
  const noseZ = zNose + 0.12 * F;
  const belly = y0 - R * sq;
  for (const side of [-1, 1]) {
    gear.push(paint(tube([side * 0.5 * k, belly + 0.15 * k, mainZ], [side * 1.0 * k, wr, mainZ], 0.05 * k, 6), STRUT));
    gear.push(paint(wheel(side * 1.0 * k, wr, mainZ, wr, wr * 0.8), TYRE));
  }
  gear.push(paint(tube([0, belly + 0.2 * k, noseZ], [0, wr * 0.85, noseZ], 0.045 * k, 6), STRUT));
  gear.push(paint(wheel(0, wr * 0.85, noseZ, wr * 0.85, wr * 0.65), TYRE));

  const anchors: ModelAnchors = {
    tipLeft: [-1.0 * k, y0 + 0.1 * k, zNose + 0.28 * F],
    tipRight: [1.0 * k, y0 + 0.1 * k, zNose + 0.28 * F],
    tail: [0, yb + finTop, zTail - 0.4 * k],
    beaconTop: [0, y0 + R * sq * 1.35, zNose + 0.52 * F],
    beaconBelly: [0, belly - 0.05 * k, zNose + 0.5 * F],
    landing: [0, y0 - R * sq * 0.85, zNose + 0.06 * F],
  };
  // main rotor: 4 blades, 11.94 m disc about the vertical axis; fenestron: 10 blades about the lateral axis
  const props: BuiltModel['props'] = [
    { pos: [0, hubY + 0.12 * k, zNose + 0.4 * F], radius: d.wingspanM / 2, blades: 4, axis: 'y' },
    { pos: [0, fenY, fenZ], radius: fenR * 0.92, blades: 10, axis: 'x' },
  ];
  return { fuselage: fus, airframe: merge(air), gear: merge(gear), anchors, pivotZ: mainZ, props, style: 'rotor', windows: 0 };
}

// ---- Air National Guard F-16C ----------------------------------------------------------------------------------------------------

function buildFighter(livery: Livery): BuiltModel {
  const d = aircraftDims('F16');
  const L = d.lengthM;
  const u = L / 15.06; // all lengths below are F-16C metres, scaled to the model length
  const zNose = -L / 2;
  const zTail = L / 2;
  const R = 0.68 * u;
  const sq = 1.1;
  const y0 = 1.7 * u;
  const axisY = (): number => y0;
  const prof: [number, number][] = [
    [0, 0], [0.2, 0.012], [0.45, 0.04], [0.68, 0.085], [0.85, 0.14], [0.95, 0.22], [1, 0.3], [1, 0.62], [0.9, 0.78], [0.78, 0.9], [0.72, 0.945],
  ];
  const fusLen = 0.945 * L;
  const fus = bodyLathe(prof, R, fusLen, sq, axisY, 16);
  // the lathe is centred on its own length; shift so its nose sits at zNose
  fus.translate(0, 0, (fusLen - L) / 2);
  const uv = fus.getAttribute('uv');
  const p = fus.getAttribute('position');
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - (p.getZ(i) - zNose) / L);
  uv.needsUpdate = true;

  const air: THREE.BufferGeometry[] = [];
  const gear: THREE.BufferGeometry[] = [];
  // nozzle
  const nz = lathe([[0.7 * R, 0], [0.75 * R, 0.4 * u], [0.62 * R, 1.05 * u], [0.58 * R, 1.1 * u]], 14);
  nz.translate(0, y0, zTail - 1.1 * u);
  air.push(paint(nz, livery.engine));
  const nzCap = new THREE.CircleGeometry(0.5 * R, 12).translate(0, y0, zTail + 0.001);
  air.push(paint(nzCap, 0x101114));

  // intake under the fuselage: elliptical duct with a dark mouth
  const intLen = 3.3 * u;
  const intZ = zNose + 0.285 * L;
  const intY = y0 - R * sq * 0.78;
  const intake = new THREE.CylinderGeometry(1, 1, intLen, 14, 1, true).rotateX(Math.PI / 2).scale(0.62 * u, 0.4 * u, 1).translate(0, intY, intZ + intLen / 2);
  air.push(paint(intake, livery.top));
  const mouth = new THREE.CircleGeometry(1, 14).rotateY(Math.PI).scale(0.58 * u, 0.36 * u, 1).translate(0, intY, intZ + 0.02);
  air.push(paint(mouth, 0x0d0f12));

  // canopy
  air.push(paint(new THREE.SphereGeometry(1, 14, 8).scale(0.42 * u, 0.42 * u, 1.5 * u).translate(0, y0 + R * sq * 0.78, zNose + 0.255 * L), 0x2b3b52));

  // wing: cropped delta, 40 degree leading-edge sweep, leading-edge root extension (strake)
  const semi = 4.72 * u;
  const zLE0 = zNose + 0.4 * L;
  const tanS = Math.tan(40 * DEG);
  const wingTE = zNose + 0.735 * L;
  const wingY = y0 - R * sq * 0.35;
  const wingGeo = slab([[-semi, zLE0 + semi * tanS], [0, zLE0], [semi, zLE0 + semi * tanS], [semi, wingTE], [0, wingTE], [-semi, wingTE]], 0.16 * u);
  wingGeo.translate(0, wingY, 0);
  air.push(paint(wingGeo, livery.wing));
  for (const side of [-1, 1]) {
    const sx = 0.5 * u;
    const ex = 1.25 * u;
    const strake = slab([[side * sx, zNose + 0.265 * L], [side * ex, zLE0 + ex * tanS], [side * sx, zLE0 + 0.2 * u]], 0.07 * u);
    strake.translate(0, wingY + 0.02 * u, 0);
    air.push(paint(strake, livery.wing));
    // wingtip missile (AIM-9 class) on its rail
    const mx = side * (semi + 0.18 * u);
    air.push(paint(tube([mx, wingY, zLE0 + semi * tanS - 0.7 * u], [mx, wingY, zLE0 + semi * tanS + 2.3 * u], 0.085 * u, 6), 0xd9dde1));
    air.push(paint(new THREE.ConeGeometry(0.085 * u, 0.4 * u, 6).rotateX(-Math.PI / 2).translate(mx, wingY, zLE0 + semi * tanS - 0.9 * u), 0xd9dde1));
  }

  // horizontal tails (all-moving), vertical fin, ventral fin
  const stSemi = 2.79 * u;
  const stTE = zTail - 0.1 * u;
  const stLE0 = stTE - 2.6 * u;
  const stY = y0 - 0.1 * u;
  const stab = slab([[-stSemi, stLE0 + stSemi * Math.tan(33 * DEG)], [0, stLE0], [stSemi, stLE0 + stSemi * Math.tan(33 * DEG)], [stSemi, stTE], [0, stTE], [-stSemi, stTE]], 0.1 * u);
  stab.translate(0, stY, 0);
  air.push(paint(stab, livery.tailplane));
  const yb = y0 + R * sq * 0.55;
  const finH = d.heightM - yb;
  const zr = zTail - 3.9 * u;
  const fin = plate([[zr, yb], [zr + 3.5 * u, yb], [zr + 3.35 * u, yb + finH], [zr + 2.55 * u, yb + finH]], 0.13 * u);
  air.push(paint(fin, (_x, y) => finPaint(livery, (y - yb) / finH)));
  for (const side of [-1, 1]) {
    const ventral = plate([[zTail - 3.2 * u, 0], [zTail - 1.2 * u, 0], [zTail - 1.5 * u, 0.9 * u], [zTail - 2.6 * u, 0.9 * u]], 0.06 * u);
    ventral.rotateZ(side * 25 * DEG);
    ventral.translate(side * 0.35 * u, y0 - R * sq * 0.95, 0);
    air.push(paint(ventral, livery.tailplane));
  }

  // landing gear
  const wr = 0.3 * u;
  const mainZ = zNose + 0.62 * L;
  const noseZ = zNose + 0.27 * L;
  const belly = y0 - R * sq;
  for (const side of [-1, 1]) {
    gear.push(paint(tube([side * 0.7 * u, belly + 0.1 * u, mainZ], [side * 1.25 * u, wr, mainZ], 0.07 * u, 6), STRUT));
    gear.push(paint(wheel(side * 1.25 * u, wr, mainZ, wr, 0.25 * u), TYRE));
  }
  gear.push(paint(tube([0, belly, noseZ], [0, wr * 0.75, noseZ], 0.06 * u, 6), STRUT));
  gear.push(paint(wheel(0, wr * 0.75, noseZ, wr * 0.75, 0.2 * u), TYRE));

  const tipZ = zLE0 + semi * tanS + 0.8 * u;
  const anchors: ModelAnchors = {
    tipLeft: [-semi - 0.18 * u, wingY, tipZ],
    tipRight: [semi + 0.18 * u, wingY, tipZ],
    tail: [0, yb + finH * 0.97, zr + 3.35 * u],
    beaconTop: [0, y0 + R * sq * 1.0, zNose + 0.5 * L],
    beaconBelly: [0, belly - 0.02 * u, zNose + 0.5 * L],
    landing: [0, belly - 0.1 * u, noseZ + 0.1 * u],
  };
  return { fuselage: fus, airframe: merge(air), gear: merge(gear), anchors, pivotZ: mainZ, props: [], style: 'fighter', windows: 0 };
}

// ---- airport pickup truck --------------------------------------------------------------------------------------------------------

function buildVehicle(livery: Livery): BuiltModel {
  const d = aircraftDims('VEH');
  const k = d.lengthM / 5.5;
  const zNose = -d.lengthM / 2;
  const zTail = d.lengthM / 2;
  const W = 2.0 * k;
  const body = livery.top;
  const trim = livery.belly;
  const air: THREE.BufferGeometry[] = [];
  const gear: THREE.BufferGeometry[] = [];
  const wr = 0.37 * k;

  // chassis with hood and bed side walls
  air.push(paint(box(W, 0.62 * k, d.lengthM, 0, 0.38 * k + 0.31 * k, 0), (_x, y) => (y < 0.5 * k ? trim : body)));
  // cab (crew cab) with a dark glass band all round
  const cabZ0 = zNose + 1.35 * k;
  const cabZ1 = cabZ0 + 2.1 * k;
  air.push(paint(box(W * 0.93, 0.7 * k, cabZ1 - cabZ0, 0, 1.0 * k + 0.35 * k, (cabZ0 + cabZ1) / 2), body));
  air.push(paint(box(W * 0.95, 0.38 * k, cabZ1 - cabZ0 - 0.5 * k, 0, 1.0 * k + 0.37 * k, (cabZ0 + cabZ1) / 2 - 0.02 * k), GLASS));
  air.push(paint(box(W * 0.85, 0.36 * k, 0.04 * k, 0, 1.0 * k + 0.37 * k, cabZ0 + 0.02 * k), GLASS)); // windscreen (slightly proud of the cab)
  // bed walls
  const bedZ0 = cabZ1 + 0.05 * k;
  for (const side of [-1, 1]) air.push(paint(box(0.1 * k, 0.32 * k, zTail - bedZ0, side * (W / 2 - 0.05 * k), 1.0 * k + 0.16 * k, (bedZ0 + zTail) / 2), body));
  air.push(paint(box(W, 0.32 * k, 0.1 * k, 0, 1.0 * k + 0.16 * k, zTail - 0.05 * k), body)); // tailgate
  air.push(paint(box(W, 0.32 * k, 0.1 * k, 0, 1.0 * k + 0.16 * k, bedZ0 + 0.05 * k), body)); // bulkhead
  air.push(paint(box(W - 0.2 * k, 0.04 * k, zTail - bedZ0, 0, 1.0 * k + 0.02 * k, (bedZ0 + zTail) / 2), DARK)); // bed floor
  // bumpers and lamps
  air.push(paint(box(W * 1.02, 0.22 * k, 0.16 * k, 0, 0.5 * k, zNose + 0.04 * k), DARK));
  air.push(paint(box(W * 1.02, 0.2 * k, 0.16 * k, 0, 0.5 * k, zTail - 0.04 * k), DARK));
  for (const side of [-1, 1]) {
    air.push(paint(box(0.3 * k, 0.12 * k, 0.05 * k, side * 0.7 * k, 0.8 * k, zNose - 0.005 * k), 0xf4f2e0));
    air.push(paint(box(0.2 * k, 0.14 * k, 0.05 * k, side * 0.8 * k, 0.85 * k, zTail + 0.005 * k), 0xb3141b));
  }
  // light bar and rotating beacon on the cab roof
  const roofY = 1.0 * k + 0.7 * k;
  air.push(paint(box(0.95 * k, 0.07 * k, 0.28 * k, 0, roofY + 0.035 * k, (cabZ0 + cabZ1) / 2), DARK));
  air.push(paint(new THREE.SphereGeometry(0.13 * k, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, roofY + 0.07 * k, (cabZ0 + cabZ1) / 2), AMBER));
  air.push(paint(box(0.3 * k, 0.1 * k, 0.1 * k, -0.33 * k, roofY + 0.12 * k, (cabZ0 + cabZ1) / 2), AMBER));
  air.push(paint(box(0.3 * k, 0.1 * k, 0.1 * k, 0.33 * k, roofY + 0.12 * k, (cabZ0 + cabZ1) / 2), AMBER));

  // wheels
  const frontZ = zNose + 0.95 * k;
  const rearZ = zTail - 1.0 * k;
  for (const z of [frontZ, rearZ]) {
    for (const side of [-1, 1]) {
      gear.push(paint(wheel(side * (W / 2 - 0.12 * k), wr, z, wr, 0.3 * k), TYRE));
      gear.push(paint(wheel(side * (W / 2 + 0.005 * k), wr, z, wr * 0.55, 0.06 * k), STRUT));
    }
  }
  // the empty textured fuselage: vehicles have no painted body of revolution
  const empty = new THREE.BufferGeometry();
  empty.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  empty.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(0), 3));
  empty.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(0), 2));

  const beaconY = roofY + 0.2 * k;
  const anchors: ModelAnchors = {
    // headlights double as the "nav" pair, taillight-side marker for the tail; the beacon is the amber dome
    tipLeft: [-0.7 * k, 0.8 * k, zNose], tipRight: [0.7 * k, 0.8 * k, zNose], tail: [0, 0.85 * k, zTail],
    beaconTop: [0, beaconY, (cabZ0 + cabZ1) / 2], beaconBelly: [0, beaconY, (cabZ0 + cabZ1) / 2],
    landing: [0, 0.85 * k, zNose - 0.1 * k],
  };
  return { fuselage: empty, airframe: merge(air), gear: merge(gear), anchors, pivotZ: 0, props: [], style: 'vehicle', windows: 0 };
}

/** Geometry of a special family (helicopter, fighter, ground vehicle) for the livery. */
export function buildSpecialGeometry(family: 'helicopter' | 'fighter' | 'groundVehicle', livery: Livery): BuiltModel {
  if (family === 'helicopter') return buildHelicopter(livery);
  if (family === 'fighter') return buildFighter(livery);
  return buildVehicle(livery);
}
