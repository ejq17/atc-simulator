/**
 * The three.js side of the Tower view: the only module that imports three. It turns the pure data from geometry.ts / aircraftModel.ts /
 * skyMath.ts into GPU objects, and updates them from a Frame each animation frame. It owns every GPU resource it creates and releases them
 * in dispose(). It runs no simulation and no loop of its own: TowerDisplay calls render() from its animation frame.
 */
import * as THREE from 'three';
import type { Airport, Aircraft, SimulationState, Vec2 } from '../../sim/types';
import { simUtcMs } from '../../sim/solar';
import type { Pose } from '../display/renderBuffer';
import { runwayLabels } from '../display/surfaceStatic';
import {
  FT, extrudeMesh, holdBarRects, markingsMesh, mergeMeshes, offsetPolyline, polygonMesh, ribbonMesh, runwayLights, runwayMarkings, samplePolyline,
  taxiwaySigns, toScene,
} from './geometry';
import type { LightColour, LightPoint, MeshData } from './geometry';
import { bankFromTurnRate, billboardWorldHeight, gearDown, lightState, modelPitchRad, placeAircraft, withinRange } from './aircraftModel';
import { createAircraftFactory } from './aircraftMeshes';
import type { AircraftModel } from './aircraftMeshes';
import { lookAtPoint, eyeScene } from './cameraMath';
import type { CamState } from './cameraMath';
import { CAB_EYE_HEIGHT_M } from './towerPosition';
import type { TowerSite } from './towerPosition';
import { cloudDeck, cloudiness, fogDensityFromVisibility, skyState, sunPosition, sunVector, toHex } from './skyMath';
import type { SkyState } from './skyMath';

export const TAXIWAY_WIDTH_M = 22; // same width the Surface view draws; the airport data carries no taxiway widths
export const LANE_WIDTH_M = 12;
export const BUILDING_HEIGHT_M = { terminal: 14, hangar: 11, helipad: 0.05 } as const; // not tagged in OSM for KACY: documented defaults

export interface TowerFrame {
  state: SimulationState;
  nowMs: number;
  pose: (ac: Aircraft) => Pose;
  selectedId?: string;
  cam: CamState;
  width: number;
  height: number;
  rangeNm: number;
}

export interface TowerScene {
  render(frame: TowerFrame): void;
  resize(width: number, height: number, dpr: number): void;
  /** Aircraft id nearest the CSS-pixel point within `radiusPx`, using the last rendered frame. */
  pick(x: number, y: number, radiusPx?: number): string | undefined;
  dispose(): void;
  readonly info: { drawCalls: () => number };
}

function geometryOf(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
  g.setIndex(m.indices);
  g.computeVertexNormals();
  return g;
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) draw(ctx);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const LIGHT_COLOURS: Record<LightColour, number> = { white: 0xfff1d0, red: 0xff3030, green: 0x30ff60, blue: 0x3a6bff, yellow: 0xffd23a };

export function createTowerScene(canvas: HTMLCanvasElement, airport: Airport, site: TowerSite): TowerScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 400_000);
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => { owned.push(x); return x; };
  let dpr = 1;
  let viewW = 1;
  let viewH = 1;
  const elevFt = airport.elevationFt;

  // ---- sky dome, sun, lights -------------------------------------------------------------------------------------------
  const domeGeo = own(new THREE.SphereGeometry(150_000, 32, 16));
  domeGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(domeGeo.getAttribute('position').count * 3), 3));
  const dome = new THREE.Mesh(domeGeo, own(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  scene.add(dome);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  const sunLight = new THREE.DirectionalLight(0xffffff, 1);
  const moonLight = new THREE.DirectionalLight(0x8fa8d8, 0);
  scene.add(hemi, sunLight, moonLight);
  const sunDot = new THREE.Points(
    own(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))),
    own(new THREE.PointsMaterial({ size: 26, sizeAttenuation: false, color: 0xfff2c8, fog: false, transparent: true, depthWrite: false })),
  );
  sunDot.frustumCulled = false;
  scene.add(sunDot);
  scene.fog = new THREE.FogExp2(0x9fb8d0, 0.0001);

  // ---- ground and pavement -----------------------------------------------------------------------------------------------
  const flatMat = (color: number, order: number) => {
    const m = own(new THREE.MeshLambertMaterial({ color, depthWrite: false }));
    m.userData.order = order;
    return m;
  };
  const addFlat = (mesh: MeshData, color: number, order: number, emissive = 0) => {
    if (mesh.indices.length === 0) return;
    const m = flatMat(color, order);
    if (emissive) m.emissive = new THREE.Color(emissive);
    const o = new THREE.Mesh(own(geometryOf(mesh)), m);
    o.renderOrder = order;
    scene.add(o);
    return o;
  };

  const groundGeo = own(new THREE.CircleGeometry(100_000, 48));
  groundGeo.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(groundGeo, own(new THREE.MeshLambertMaterial({ color: 0x4d5a36 })));
  ground.position.y = -0.2;
  scene.add(ground);

  const g = airport.taxiwayGraph;
  addFlat(mergeMeshes(g.aprons.map((a) => polygonMesh(a, 0.02))), 0x6a6e73, 1);
  const named: MeshData[] = [];
  const lanes: MeshData[] = [];
  const centrelines: MeshData[] = [];
  for (const [name, lines] of Object.entries(g.taxiwayPolylines)) {
    for (const line of lines) {
      if (name === 'UNNAMED') { lanes.push(ribbonMesh(line, LANE_WIDTH_M, 0.03)); continue; }
      named.push(ribbonMesh(line, TAXIWAY_WIDTH_M, 0.04));
      centrelines.push(ribbonMesh(line, 0.35, 0.06));
    }
  }
  addFlat(mergeMeshes(lanes), 0x5a5e63, 2);
  addFlat(mergeMeshes(named), 0x54585d, 3);
  addFlat(mergeMeshes(centrelines), 0xe8c030, 4, 0x1a1400);
  addFlat(mergeMeshes(airport.runways.map((r) => polygonMesh(r.polygon, 0.05))), 0x42454a, 5);

  const mk = airport.runways.map((r) => runwayMarkings(r));
  addFlat(markingsMesh(mk.flatMap((m) => m.centreline), 0.07), 0xf2f2f2, 6, 0x101010);
  addFlat(markingsMesh(mk.flatMap((m) => m.threshold), 0.07), 0xf2f2f2, 6, 0x101010);
  addFlat(markingsMesh(mk.flatMap((m) => m.aiming), 0.07), 0xf2f2f2, 6, 0x101010);
  addFlat(markingsMesh(mk.flatMap((m) => m.edge), 0.07), 0xf2f2f2, 6, 0x101010);
  addFlat(markingsMesh(mk.flatMap((m) => m.displaced), 0.07), 0xf2f2f2, 6, 0x101010);

  // Hold lines: from each holding_position node toward the runway entry node it serves.
  const holdRects = Object.values(g.nodes).flatMap((n) => {
    if (n.kind !== 'holding_position') return [];
    const entryId = (n as { entryNodeId?: string }).entryNodeId;
    const entry = entryId ? g.nodes[entryId] : undefined;
    const rw = airport.runways.find((r) => r.id === n.runwayId);
    let toward: Vec2 | undefined = entry ? { x: entry.pos.x - n.pos.x, y: entry.pos.y - n.pos.y } : undefined;
    if (!toward && rw) {
      // No entry node: head for the nearest point of the runway centreline.
      const a = rw.ends[0].threshold;
      const b = rw.ends[1].threshold;
      const L2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((n.pos.x - a.x) * (b.x - a.x) + (n.pos.y - a.y) * (b.y - a.y)) / L2));
      toward = { x: a.x + (b.x - a.x) * t - n.pos.x, y: a.y + (b.y - a.y) * t - n.pos.y };
    }
    return toward ? holdBarRects({ pos: n.pos, towardRunway: toward, taxiwayWidth: TAXIWAY_WIDTH_M * 0.9 }) : [];
  });
  addFlat(markingsMesh(holdRects, 0.075), 0xf0c020, 7, 0x2a2000);

  // Runway numbers (painted, readable from the approach: the text's up points the way the aircraft is going).
  const numberTex = new Map<string, THREE.CanvasTexture>();
  const numberGeo = own(new THREE.PlaneGeometry(1, 1));
  for (const rw of airport.runways) {
    for (const lab of runwayLabels(rw, 48)) {
      let tex = numberTex.get(lab.text);
      if (!tex) {
        tex = own(canvasTexture(128, 128, (ctx) => {
          ctx.clearRect(0, 0, 128, 128);
          ctx.fillStyle = '#f4f4f4';
          ctx.font = 'bold 96px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(lab.text, 64, 68);
        }));
        numberTex.set(lab.text, tex);
      }
      const e = rw.ends.find((x) => x.id === lab.endId);
      // labels are placed inside the threshold; the aircraft lands heading AWAY from that threshold: text-up = that way.
      const mat = own(new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false }));
      const mesh = new THREE.Mesh(numberGeo, mat);
      const size = 20;
      mesh.scale.set(size, size, 1);
      mesh.rotation.order = 'YXZ';
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.y = -(((e?.trueHeadingDeg ?? lab.headingDeg) * Math.PI) / 180);
      const p = toScene({ x: lab.x, y: lab.y }, 0.08);
      mesh.position.set(p[0], p[1], p[2]);
      mesh.renderOrder = 8;
      scene.add(mesh);
    }
  }

  // Taxiway designator signs (yellow plate, black letter) at intersections.
  const signTex = new Map<string, THREE.CanvasTexture>();
  for (const s of taxiwaySigns(g.nodes, g.taxiwayPolylines)) {
    let tex = signTex.get(s.name);
    if (!tex) {
      tex = own(canvasTexture(64, 64, (ctx) => {
        ctx.fillStyle = '#f2c230';
        ctx.fillRect(2, 2, 60, 60);
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 3;
        ctx.strokeRect(2, 2, 60, 60);
        ctx.fillStyle = '#111';
        ctx.font = 'bold 44px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(s.name.slice(0, 3), 32, 35);
      }));
      signTex.set(s.name, tex);
    }
    const sp = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: tex })));
    sp.center.set(0.5, 0);
    sp.scale.set(5, 5, 1);
    const p = toScene(s.pos, 1.5);
    sp.position.set(p[0], p[1], p[2]);
    scene.add(sp);
  }

  // ---- buildings and the tower itself -------------------------------------------------------------------------------------
  const buildings = (airport as unknown as { buildings?: { kind: 'terminal' | 'hangar' | 'helipad'; polygon: Vec2[] }[] }).buildings ?? [];
  const bMats = {
    terminal: own(new THREE.MeshLambertMaterial({ color: 0xb9bcc0, flatShading: true })),
    hangar: own(new THREE.MeshLambertMaterial({ color: 0x9aa1a8, flatShading: true })),
  };
  const winGlow: THREE.MeshLambertMaterial[] = Object.values(bMats);
  for (const kind of ['terminal', 'hangar'] as const) {
    const m = mergeMeshes(buildings.filter((b) => b.kind === kind).map((b) => extrudeMesh(b.polygon, BUILDING_HEIGHT_M[kind])));
    if (m.indices.length) scene.add(new THREE.Mesh(own(geometryOf(m)), bMats[kind]));
  }
  addFlat(mergeMeshes(buildings.filter((b) => b.kind === 'helipad').map((b) => polygonMesh(b.polygon, 0.06))), 0x7b6a2a, 4);
  {
    const shaftMat = own(new THREE.MeshLambertMaterial({ color: 0xc9ccd0 }));
    const shaft = new THREE.Mesh(own(new THREE.CylinderGeometry(3.2, 4.2, CAB_EYE_HEIGHT_M - 4, 12)), shaftMat);
    const cab = new THREE.Mesh(own(new THREE.CylinderGeometry(6.5, 5, 5, 12)), own(new THREE.MeshLambertMaterial({ color: 0x6f8aa0 })));
    const p = toScene(site.pos, 0);
    shaft.position.set(p[0], (CAB_EYE_HEIGHT_M - 4) / 2, p[2]);
    cab.position.set(p[0], CAB_EYE_HEIGHT_M - 2.5, p[2]);
    scene.add(shaft, cab);
  }

  // ---- night lights ---------------------------------------------------------------------------------------------------------
  const glowTex = own(canvasTexture(32, 32, (ctx) => {
    const gr = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 32, 32);
  }));
  const lightMats: THREE.PointsMaterial[] = [];
  const addLights = (pts: LightPoint[], size: number) => {
    const byColour = new Map<LightColour, number[]>();
    for (const p of pts) {
      const arr = byColour.get(p.colour) ?? [];
      arr.push(...toScene(p.pos, p.h));
      byColour.set(p.colour, arr);
    }
    for (const [colour, arr] of byColour) {
      const geo = own(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)));
      const mat = own(new THREE.PointsMaterial({
        color: LIGHT_COLOURS[colour], size, sizeAttenuation: false, map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
      }));
      mat.userData.baseSize = size;
      lightMats.push(mat);
      const o = new THREE.Points(geo, mat);
      o.frustumCulled = false;
      scene.add(o);
    }
  };
  const runwayPts: LightPoint[] = [];
  for (const rw of airport.runways) {
    const approachEnds = rw.ends.filter((e) => {
      const a = (e as { approachLighting?: string | null }).approachLighting;
      return !!a && !/^none/i.test(a);
    }).map((e) => e.id);
    runwayPts.push(...runwayLights(rw, { centreline: rw.ends.some((e) => !!e.ils), approach: approachEnds.length > 0, approachEnds }));
  }
  addLights(runwayPts, 5 * 1);
  const taxiPts: LightPoint[] = [];
  for (const [name, lines] of Object.entries(g.taxiwayPolylines)) {
    if (name === 'UNNAMED') continue;
    for (const line of lines) for (const side of [-1, 1]) {
      for (const p of samplePolyline(offsetPolyline(line, (side * TAXIWAY_WIDTH_M) / 2 + side * 1.2), 30)) taxiPts.push({ pos: p, h: 0.3, colour: 'blue' });
    }
  }
  addLights(taxiPts, 4);

  // ---- cloud deck ---------------------------------------------------------------------------------------------------------
  const cloudTex = own(canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 256, 256);
    let seed = 1234;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 160; i++) {
      const x = rnd() * 256;
      const y = rnd() * 256;
      const r = 12 + rnd() * 40;
      const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
      const v = rnd() < 0.5 ? 0 : 255;
      gr.addColorStop(0, `rgba(${v},${v},${v},0.18)`);
      gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
      ctx.fillStyle = gr;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }));
  cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;
  cloudTex.repeat.set(40, 40);
  const cloudMat = own(new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  const cloudGeo = own(new THREE.PlaneGeometry(200_000, 200_000));
  cloudGeo.rotateX(-Math.PI / 2);
  const cloud = new THREE.Mesh(cloudGeo, cloudMat);
  cloud.visible = false;
  cloud.renderOrder = 20;
  scene.add(cloud);

  // ---- aircraft ---------------------------------------------------------------------------------------------------------
  const factory = own(createAircraftFactory());

  const dotTex = own(canvasTexture(32, 32, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(16, 16, 9, 0, Math.PI * 2);
    ctx.fill();
  }));
  const ringTex = own(canvasTexture(64, 64, (ctx) => {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(32, 32, 26, 0, Math.PI * 2);
    ctx.stroke();
  }));

  interface AcObj {
    group: THREE.Group;
    /** Yaw about the vertical; `tilt` (pitch and roll about the main gear) is its child and holds the model root. */
    model: THREE.Group;
    tilt: THREE.Group;
    m: AircraftModel;
    prevHeading: number;
    prevMs: number;
    turnRate: number;
    bank: number;
    label: THREE.Sprite;
    labelKey: string;
    marker: THREE.Points;
    ring: THREE.Points;
    lights: THREE.Points;
    dims: AircraftModel['dims'];
    ownTextures: THREE.Texture[];
  }
  const aircraft = new Map<string, AcObj>();
  const screenPos = new Map<string, { x: number; y: number }>();

  const makeLabelTexture = (text: string, selected: boolean) => canvasTexture(256, 64, (ctx) => {
    ctx.fillStyle = selected ? 'rgba(6,40,52,0.88)' : 'rgba(7,9,12,0.78)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = selected ? '#39c5e8' : '#4d5864';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 252, 60);
    ctx.fillStyle = selected ? '#39c5e8' : '#e6eaee';
    ctx.font = 'bold 36px "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 34);
  });

  const makeAircraft = (ac: Aircraft, selected: boolean): AcObj => {
    const m = factory.build(ac.type, ac.callsign);
    const dims = m.dims;
    const group = new THREE.Group();
    const model = new THREE.Group();
    const tilt = new THREE.Group();
    tilt.rotation.order = 'XYZ';
    tilt.add(m.root);
    model.add(tilt);
    group.add(model);
    const tex = makeLabelTexture(ac.callsign, selected);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, fog: false, transparent: true }));
    label.center.set(0.5, 0);
    label.renderOrder = 30;
    scene.add(label);
    const mkPts = (n: number, size: number, tex2: THREE.Texture, color: number, additive: boolean) => {
      const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
      const mat = new THREE.PointsMaterial({
        size, sizeAttenuation: false, map: tex2, transparent: true, depthWrite: false, depthTest: !additive ? false : true, vertexColors: additive,
        color: additive ? 0xffffff : color, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: false,
      });
      const o = new THREE.Points(geo, mat);
      o.frustumCulled = false;
      return o;
    };
    const marker = mkPts(1, 7 * dpr, dotTex, 0x6be58a, false);
    marker.renderOrder = 29;
    const ring = mkPts(1, 30 * dpr, ringTex, 0x39c5e8, false);
    ring.renderOrder = 29;
    const lights = mkPts(8, 10 * dpr, glowTex, 0xffffff, true);
    lights.renderOrder = 15;
    scene.add(group, marker, ring, lights);
    return { group, model, tilt, m, prevHeading: 0, prevMs: -1, turnRate: 0, bank: 0, label, labelKey: `${ac.callsign}|${selected}`, marker, ring, lights, dims, ownTextures: [tex] };
  };

  const disposeAircraft = (o: AcObj) => {
    scene.remove(o.group, o.label, o.marker, o.ring, o.lights);
    for (const t of o.ownTextures) t.dispose();
    (o.label.material as THREE.Material).dispose();
    for (const p of [o.marker, o.ring, o.lights]) { p.geometry.dispose(); (p.material as THREE.Material).dispose(); }
  };

  // ---- sky update (throttled by key) -----------------------------------------------------------------------------------
  let skyKey = '';
  let lastSky: SkyState | undefined;
  const tmpColor = new THREE.Color();
  const applySky = (state: SimulationState) => {
    const w = state.weather;
    const sun = sunPosition(airport.arp, simUtcMs(state));
    const cloudy = cloudiness(w);
    const deck = cloudDeck(w);
    const key = `${Math.round(sun.elevationDeg * 5)}|${Math.round(sun.azimuthDeg)}|${cloudy}|${w.visibilitySm}|${deck?.baseM ?? 'x'}`;
    if (key === skyKey && lastSky) return lastSky;
    skyKey = key;
    const sky = skyState(sun.elevationDeg, cloudy);
    lastSky = sky;
    // dome vertex colours: horizon at y=0 up to the zenith colour, ground colour below.
    const pos = domeGeo.getAttribute('position');
    const colors = domeGeo.getAttribute('color');
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 150_000;
      const t = y >= 0 ? Math.pow(y, 0.55) : 0;
      const c = y >= 0 ? [sky.horizon[0] + (sky.top[0] - sky.horizon[0]) * t, sky.horizon[1] + (sky.top[1] - sky.horizon[1]) * t, sky.horizon[2] + (sky.top[2] - sky.horizon[2]) * t] : sky.horizon;
      colors.setXYZ(i, c[0], c[1], c[2]);
    }
    colors.needsUpdate = true;
    const fog = scene.fog as THREE.FogExp2;
    fog.color.set(toHex(sky.horizon));
    fog.density = fogDensityFromVisibility(w.visibilitySm);
    hemi.color.copy(tmpColor.set(toHex(sky.top)));
    hemi.groundColor.set(toHex([sky.horizon[0] * 0.5, sky.horizon[1] * 0.5, sky.horizon[2] * 0.5]));
    hemi.intensity = sky.ambient * Math.PI * 0.8;
    const sv = sunVector(sun);
    sunLight.position.set(sv[0] * 1000, Math.max(sv[1], 0.02) * 1000, sv[2] * 1000);
    const warm = Math.max(0, Math.min(1, (10 - sun.elevationDeg) / 10));
    sunLight.color.setRGB(1, 1 - 0.28 * warm, 1 - 0.55 * warm);
    sunLight.intensity = sun.elevationDeg > 0 ? sky.sunIntensity * Math.PI * 0.9 : Math.max(0, sky.sunIntensity * Math.PI * 0.9 * (1 + sun.elevationDeg / 3));
    moonLight.position.set(-sv[0] * 600, 800, -sv[2] * 600);
    moonLight.intensity = sky.night * 0.9;
    sunDot.visible = sun.elevationDeg > -1 && cloudy < 0.85;
    sunDot.position.set(sv[0] * 100_000, sv[1] * 100_000, sv[2] * 100_000);
    for (const m of winGlow) m.emissive.setRGB(0.1 * sky.night, 0.09 * sky.night, 0.06 * sky.night);
    for (const m of lightMats) m.opacity = Math.min(1, sky.night * 1.15);
    factory.setNight(sky.night);
    cloud.visible = !!deck;
    if (deck) {
      cloud.position.y = deck.baseM;
      cloudMat.opacity = deck.opacity * 0.92;
      cloudMat.color.set(toHex([sky.horizon[0] * 0.9 + 0.05, sky.horizon[1] * 0.9 + 0.05, sky.horizon[2] * 0.9 + 0.05]));
    }
    return sky;
  };

  // ---- frame ---------------------------------------------------------------------------------------------------------------
  const eyeH = CAB_EYE_HEIGHT_M;
  const eye = eyeScene(site.pos, eyeH);
  const v3 = new THREE.Vector3();

  const render = (f: TowerFrame) => {
    const sky = applySky(f.state);
    camera.fov = f.cam.fovDeg;
    camera.aspect = viewW / viewH;
    camera.updateProjectionMatrix();
    camera.position.set(eye[0], eye[1], eye[2]);
    const la = lookAtPoint(eye, f.cam.yawDeg, f.cam.pitchDeg);
    camera.lookAt(la[0], la[1], la[2]);
    camera.updateMatrixWorld();
    dome.position.copy(camera.position);

    const seen = new Set<string>();
    screenPos.clear();
    const night = sky.night;
    for (const ac of Object.values(f.state.aircraft)) {
      const pose = f.pose(ac);
      if (!withinRange(pose.x - site.pos.x, pose.y - site.pos.y, f.rangeNm)) continue;
      seen.add(ac.id);
      const selected = f.selectedId === ac.id;
      let o = aircraft.get(ac.id);
      if (o && o.labelKey !== `${ac.callsign}|${selected}`) {
        const old = o.ownTextures.pop();
        const tex = makeLabelTexture(ac.callsign, selected);
        (o.label.material as THREE.SpriteMaterial).map = tex;
        (o.label.material as THREE.SpriteMaterial).needsUpdate = true;
        old?.dispose();
        o.ownTextures.push(tex);
        o.labelKey = `${ac.callsign}|${selected}`;
      }
      if (!o) { o = makeAircraft(ac, selected); aircraft.set(ac.id, o); }
      const pl = placeAircraft(ac, pose, elevFt);
      o.group.position.set(pl.x, pl.y, pl.z);
      o.model.rotation.y = pl.yawRad;
      const aglFt = pl.y / FT;
      const fs = { onGround: ac.onGround, aglFt, verticalSpeedFpm: ac.verticalSpeedFpm, phase: ac.phase };
      o.m.gear.visible = gearDown(o.dims.family, fs);
      // Bank from the heading change per second of simulated time (smoothed); no bank on the ground.
      const wallDt = o.prevMs < 0 ? 0 : Math.max(0, (f.nowMs - o.prevMs) / 1000);
      const simDt = wallDt * f.state.clock.speed;
      if (simDt > 1e-4) {
        let dh = pose.headingDeg - o.prevHeading;
        dh = ((((dh + 180) % 360) + 360) % 360) - 180;
        o.turnRate += (dh / simDt - o.turnRate) * (1 - Math.exp(-wallDt / 0.6));
      }
      if (wallDt > 0) { o.prevHeading = pose.headingDeg; o.prevMs = f.nowMs; } else if (o.prevMs < 0) { o.prevHeading = pose.headingDeg; o.prevMs = f.nowMs; }
      const bankTarget = ac.onGround ? 0 : bankFromTurnRate(o.turnRate, pose.groundSpeedKt);
      o.bank += (bankTarget - o.bank) * (wallDt > 0 ? 1 - Math.exp(-wallDt / 0.4) : 0);
      const pitch = modelPitchRad(ac.type, { ...fs, groundSpeedKt: pose.groundSpeedKt });
      o.tilt.rotation.set(pitch, 0, -o.bank);
      // Tilt about the main gear contact point rather than the middle of the fuselage.
      v3.set(0, 0, o.m.pivotZ).applyEuler(o.tilt.rotation);
      o.tilt.position.set(-v3.x, -v3.y, o.m.pivotZ - v3.z);
      const running = !ac.onGround || (ac.phase !== 'PARKED' && ac.phase !== 'ARRIVED');
      for (const pr of o.m.props) {
        pr.rotation.z = running ? (f.nowMs * 0.045) % (Math.PI * 2) : 0;
        if (pr.children[0]) pr.children[0].visible = running;
      }
      const dist = Math.hypot(pl.x - eye[0], pl.y - eye[1], pl.z - eye[2]);
      const lh = billboardWorldHeight(dist, f.cam.fovDeg, viewH, 22);
      const showLabel = !ac.onGround || dist < 4500;
      o.label.visible = showLabel;
      o.label.scale.set(lh * 4, lh, 1);
      o.label.position.set(pl.x, pl.y + o.dims.heightM * 1.2 + lh * 0.25, pl.z);
      // Marker dots: when the model is smaller than a few pixels, and always a ring on the selected aircraft.
      const modelPx = (o.dims.lengthM / Math.max(1, dist)) * (viewH / (2 * Math.tan((f.cam.fovDeg * Math.PI) / 360)));
      const markerPos = o.marker.geometry.getAttribute('position');
      markerPos.setXYZ(0, pl.x, pl.y + o.dims.heightM * 0.5, pl.z);
      markerPos.needsUpdate = true;
      o.marker.visible = modelPx < 8;
      const ringPos = o.ring.geometry.getAttribute('position');
      ringPos.setXYZ(0, pl.x, pl.y + o.dims.heightM * 0.5, pl.z);
      ringPos.needsUpdate = true;
      o.ring.visible = selected;
      // Lights (nav, strobes, beacons, landing) sit at the model's own anchors, carried through its attitude.
      const lp = o.lights.geometry.getAttribute('position');
      const lc = o.lights.geometry.getAttribute('color');
      o.group.updateMatrixWorld(true);
      const an = o.m.anchors;
      const place = (i: number, a: [number, number, number]) => {
        v3.set(a[0], a[1], a[2]).applyMatrix4(o!.m.root.matrixWorld);
        lp.setXYZ(i, v3.x, v3.y, v3.z);
      };
      place(0, an.tipLeft);
      place(1, an.tipRight);
      place(2, an.tail);
      place(3, an.tipLeft);
      place(4, an.tipRight);
      place(5, an.beaconTop);
      place(6, an.beaconBelly);
      place(7, an.landing);
      lp.needsUpdate = true;
      const lightsOn = night > 0.05 || f.state.weather.visibilitySm < 3;
      const ls = lightState({ lightsOn, onGround: ac.onGround, aglFt, phase: ac.phase, nowMs: f.nowMs, seed: ac.seed });
      const set = (i: number, on: boolean, r: number, g2: number, b2: number) => lc.setXYZ(i, on ? r : 0, on ? g2 : 0, on ? b2 : 0);
      set(0, ls.nav, 1, 0.05, 0.05);
      set(1, ls.nav, 0.05, 1, 0.1);
      set(2, ls.nav, 0.9, 0.9, 0.8);
      set(3, ls.strobe, 1.6, 1.6, 1.6);
      set(4, ls.strobe, 1.6, 1.6, 1.6);
      set(5, ls.beacon, 1.3, 0.05, 0.05);
      set(6, ls.beacon, 1.3, 0.05, 0.05);
      set(7, ls.landing, 1.7, 1.6, 1.4);
      lc.needsUpdate = true;
      // Project for picking.
      v3.set(pl.x, pl.y + o.dims.heightM * 0.5, pl.z).project(camera);
      if (v3.z > -1 && v3.z < 1) screenPos.set(ac.id, { x: ((v3.x + 1) / 2) * viewW, y: ((1 - v3.y) / 2) * viewH });
    }
    for (const [id, o] of aircraft) if (!seen.has(id)) { disposeAircraft(o); aircraft.delete(id); }
    renderer.render(scene, camera);
  };

  const resize = (w: number, h: number, ratio: number) => {
    viewW = Math.max(1, w);
    viewH = Math.max(1, h);
    dpr = Math.min(2, ratio);
    renderer.setPixelRatio(dpr);
    renderer.setSize(viewW, viewH, false);
    for (const m of lightMats) m.size = (m.userData.baseSize as number) * dpr * 0.6;
    for (const o of aircraft.values()) {
      (o.marker.material as THREE.PointsMaterial).size = 7 * dpr;
      (o.ring.material as THREE.PointsMaterial).size = 30 * dpr;
      (o.lights.material as THREE.PointsMaterial).size = 10 * dpr;
    }
  };

  return {
    render,
    resize,
    pick(x, y, radiusPx = 24) {
      let best: string | undefined;
      let bd = radiusPx;
      for (const [id, p] of screenPos) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bd) { bd = d; best = id; }
      }
      return best;
    },
    dispose() {
      for (const o of aircraft.values()) disposeAircraft(o);
      aircraft.clear();
      for (const t of numberTex.values()) t.dispose();
      for (const t of signTex.values()) t.dispose();
      for (const d of owned) d.dispose();
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.isMesh || (obj as THREE.Points).isPoints || (obj as THREE.Sprite).isSprite) {
          (m.geometry as THREE.BufferGeometry | undefined)?.dispose?.();
          const mat = m.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose?.();
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
    },
    info: { drawCalls: () => renderer.info.render.calls },
  };
}
