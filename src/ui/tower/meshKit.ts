/**
 * Geometry helpers shared by the aircraft model recipes (aircraftMeshes.ts) and the special-traffic models (specialModels.ts): vertex
 * painting, merging, lathe bodies, extruded planforms, tubes, wheels and boxes. Model space: nose toward -z, +y up, +x the right side.
 */
import * as THREE from 'three';

// ---- geometry helpers --------------------------------------------------------------------------------------------------------------

export type Colour = number | ((x: number, y: number, z: number) => number);

export function paint(geo: THREE.BufferGeometry, colour: Colour): THREE.BufferGeometry {
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

export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
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
export function lathe(points: [number, number][], segments: number): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(points.map(([r, d]) => new THREE.Vector2(r, d)), segments);
  g.rotateX(Math.PI / 2); // lathe y -> z; lathe phi = 0 ends up at the belly (-y), phi = pi at the crown
  return g;
}

/** Average the normals on the lathe seam (first and last segment share positions) so no crease shows on the belly. */
export function closeSeam(g: THREE.BufferGeometry, ringSize: number, segments: number): void {
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

export function mapVerts(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number) => [number, number, number]): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const [x, y, z] = fn(p.getX(i), p.getY(i), p.getZ(i));
    p.setXYZ(i, x, y, z);
  }
  p.needsUpdate = true;
  return g;
}

/** A horizontal slab from a planform polygon [x, z] of constant thickness, centred on y = 0. */
export function slab(poly: [number, number][], thick: number): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  poly.forEach(([x, z], i) => (i === 0 ? sh.moveTo(x, -z) : sh.lineTo(x, -z)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false });
  g.translate(0, 0, -thick / 2);
  g.rotateX(-Math.PI / 2); // (x, y, depth) -> (x, depth, -y)
  return g;
}

/** A vertical plate from a profile polygon [z aft, y up] of the given thickness (across x), centred on x = 0. */
export function plate(poly: [number, number][], thick: number): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  poly.forEach(([z, y], i) => (i === 0 ? sh.moveTo(z, y) : sh.lineTo(z, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false });
  g.translate(0, 0, -thick / 2);
  g.rotateY(-Math.PI / 2); // (z, y, depth) -> (-depth, y, z)
  return g;
}

export function tube(a: [number, number, number], b: [number, number, number], r: number, seg = 6): THREE.BufferGeometry {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return g;
}

export function wheel(x: number, y: number, z: number, r: number, width: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, width, 10, 1);
  g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

export function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

