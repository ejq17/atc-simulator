/**
 * Deterministic build of an airport dataset from its verified source files.
 *
 *   npx tsx scripts/build-airport.ts <ICAO>          e.g. KACY, KMHT
 *   npx tsx scripts/build-kacy-airport.ts            (wrapper kept for KACY)
 *
 * Reads  data/sources/<slug>-{facility,frequencies,navaids,procedures}.json
 *        data/sources/<slug>-taxiways.geojson   (OSM, ODbL 1.0)
 *        optional per airport (see scripts/airports/<slug>.ts): holding patterns, fix altitudes, MVA sectors,
 *        FAA diagram label positions (cached in scripts/data/)
 * Writes src/airport/<slug>/{<slug>.airport.json, build-report.md, debug-graph.svg}
 *
 * No aeronautical value is typed in from memory: runways, frequencies, navaids, fixes,
 * procedures and URLs are all read from the source JSON. The only constants in this file
 * are geometric tolerances and documented simplifications (see CONFIG). Everything that is
 * specific to one airport (parking stands, frequency naming, MVA, diagram labels) lives in
 * its profile, scripts/airports/<slug>.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjection, trueToMagnetic } from '../src/airport/projection.ts';
import type { Projection } from '../src/airport/projection.ts';
import type { DataProvenance, HotSpot, InstrumentProcedure, LatLon, NavigationAid, RadioFrequency, Vec2 } from '../src/sim/types.ts';
import { angDiff, bearing, dist, distToPolygonEdge, lerp, pointInPolygon, projectOnSegment, r2, r6 } from './lib/geom.ts';
import type { P } from './lib/geom.ts';
import { Planar } from './lib/planar.ts';
import type { PWay } from './lib/planar.ts';
import { inferIdentifiers } from './lib/inference.ts';
import type { Decision, DiagramLabel } from './lib/inference.ts';
import { renderDebugSvg } from './lib/svg.ts';
import { kacyProfile } from './airports/kacy.ts';
import { kmhtProfile } from './airports/kmht.ts';
import type { AirportProfile, ApronRec, BuildingRec, ParkingCtx, ParkRec } from './airports/types.ts';
import type {
  KacyAirport,
  KacyBuilding,
  KacyParking,
  KacyRunway,
  KacyRunwayEnd,
  KacyTaxiEdge,
  KacyTaxiNode,
  KacyMvaSector,
  LahsoInfo,
} from '../src/airport/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'data/sources');

const PROFILES: Record<string, AirportProfile> = { KACY: kacyProfile, KMHT: kmhtProfile };
const requested = (process.argv[2] ?? '').toUpperCase();
const profile = PROFILES[requested] ?? PROFILES[`K${requested}`];
if (!profile) {
  console.error(`usage: npx tsx scripts/build-airport.ts <ICAO>   (known: ${Object.keys(PROFILES).join(', ')})`);
  process.exit(2);
}
const SLUG = profile.slug;
const OUT = path.join(ROOT, 'src/airport', SLUG);

const CONFIG = {
  /** Vertex / endpoint snapping tolerance (m). */
  snapM: 3,
  /** Edges shorter than this are contracted (m). */
  tinyEdgeM: 1.5,
  /** Documented simplification: runway holding position distance from the runway centreline. 250 ft. */
  holdDistanceFt: 250,
  /** Inference tolerances. */
  contAngleDeg: 20,
  labelMaxM: 30,
  /** Runway polygon extension beyond each threshold (m), so the thresholds are interior points. */
  polygonExtensionM: 1,
  /** Mapped turn-on fillets (untagged curves from a through taxiway to the runway centreline) shorter than this are collapsed when the through taxiway reaches the runway itself within `filletReachM`. */
  filletMaxM: 90,
  filletReachM: 120,
  /** Parking connector limit (m). */
  parkingConnectMaxM: 150,
  /** Synthetic ramp spot grid (m). */
  syntheticSpotSpacingM: 38,
};
const FT = 0.3048;

// ---------------------------------------------------------------------------------------------
// Source typing (only the fields we read)
// ---------------------------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const readJson = (f: string): J => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
const readOptional = (f: string | undefined): J | undefined => (f && fs.existsSync(path.join(SRC, f)) ? readJson(f) : undefined);
const facility: J = readJson(`${SLUG}-facility.json`);
const freqSrc: J = readJson(`${SLUG}-frequencies.json`);
const navSrc: J = readJson(`${SLUG}-navaids.json`);
const procSrc: J = readJson(`${SLUG}-procedures.json`);
const osm: J = readJson(`${SLUG}-taxiways.geojson`);

const problems: string[] = [];
const hardErrors: string[] = [];
const report: string[] = [];
const warn = (s: string): void => {
  problems.push(s);
};
const hard = (s: string): void => {
  hardErrors.push(s);
};

// ---------------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------------
const RETRIEVED = facility._provenance.retrieved as string; // 2026-10-16
const NASR_FROM = facility._provenance.faa_cycle_effective as string; // 2026-10-01
const DTPP_FROM = (procSrc._provenance.effective_from as string).slice(0, 10);
const DTPP_TO = (procSrc._provenance.effective_to as string).slice(0, 10);
const NASR_TO = (facility._provenance.faa_cycle_next as string) ?? DTPP_TO;
const NASR_URL = 'https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/2026-10-01/';
const OSM_ATTR = '(c) OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)';

const nasrProv = (notes?: string, extra: Partial<DataProvenance> = {}): DataProvenance => ({
  source: 'FAA NASR 28-day subscription (cycle 2026-10-01)',
  url: NASR_URL,
  retrievedOn: RETRIEVED,
  effectiveFrom: NASR_FROM,
  effectiveTo: NASR_TO,
  ...(notes ? { notes } : {}),
  ...extra,
});
const dtppProv = (url: string, notes?: string): DataProvenance => ({
  source: `FAA d-TPP cycle ${procSrc._provenance.cycle as string}`,
  url,
  retrievedOn: RETRIEVED,
  effectiveFrom: DTPP_FROM,
  effectiveTo: DTPP_TO,
  ...(notes ? { notes } : {}),
});
const osmProv = (notes: string, approximate = false): DataProvenance => ({
  source: `OpenStreetMap via Overpass API, ${OSM_ATTR}`,
  url: 'https://www.openstreetmap.org/copyright',
  retrievedOn: RETRIEVED,
  notes: `OSM base timestamp ${osm.properties.osm_base_timestamp as string}. ${notes}`,
  ...(approximate ? { approximate: true } : {}),
});

// ---------------------------------------------------------------------------------------------
// Projection and airport basics
// ---------------------------------------------------------------------------------------------
const arp: LatLon = { lat: facility.airport.arp.lat, lon: facility.airport.arp.lon };
const proj: Projection = createProjection(arp);
const loc = (lat: number, lon: number): Vec2 => proj.toLocal({ lat, lon });
const magVar: number = (facility.airport.magnetic_variation.hemisphere === 'W' ? -1 : 1) * facility.airport.magnetic_variation.deg; // east-positive
const pr = (p: P): Vec2 => ({ x: r2(p.x), y: r2(p.y) });
const ll = (p: P): LatLon => {
  const l = proj.toLatLon(p);
  return { lat: r6(l.lat), lon: r6(l.lon) };
};

// ---------------------------------------------------------------------------------------------
// Runways
// ---------------------------------------------------------------------------------------------
const endId = (nasrId: string): string => String(parseInt(nasrId, 10)); // "04" -> "4" (matches src/sim/types.ts comments)
// source key names differ slightly between the first airport's hand-written files and the extractor's output
const navPrimary: J = navSrc.primary_navaid ?? navSrc.vortac_acy;
const navIls: J = navSrc.ils_localizers ?? navSrc.ils_localizers_at_kacy;
const navOther: J[] = navSrc.other_navaids_referenced ?? navSrc.other_navaids_referenced_by_kacy_procedures ?? [];
const navFixes: J[] = navSrc.fixes_named_on_approach_charts ?? navSrc.fixes_named_on_kacy_approach_charts ?? [];
const rolesOf = (f: J): Record<string, string | null> => f.roles_on_plates ?? f.roles_on_kacy_plates ?? {};

interface RunwayBuild {
  runway: KacyRunway;
  a: P;
  b: P;
  halfWidthM: number;
}
const runwayBuilds: RunwayBuild[] = [];
const ilsByEnd: Record<string, J> = facility.ils_by_runway_end;
const ilsSystems: J[] = navIls.systems;

for (const src of facility.runways as J[]) {
  if (src.id === 'H1') continue; // private experimental helipad; not a runway for this sim
  const ends: KacyRunwayEnd[] = (src.ends as J[]).map((e: J): KacyRunwayEnd => {
    const id = endId(e.id);
    const thr = loc(e.threshold.lat, e.threshold.lon);
    const ilsInfo = ilsByEnd[id];
    const sys = ilsSystems.find((s: J) => endId(s.runway_end) === id);
    const lahso: LahsoInfo | null = e.lahso
      ? {
          availableLandingDistanceFt: e.lahso.available_landing_distance_ft,
          holdShortOfRunwayId: String(e.lahso.hold_short_of).split('/').map((x: string) => String(parseInt(x, 10))).join('/'),
          holdShortPoint: { latLon: { lat: e.lahso.hold_short_point.lat, lon: e.lahso.hold_short_point.lon }, pos: pr(loc(e.lahso.hold_short_point.lat, e.lahso.hold_short_point.lon)) },
        }
      : null;
    return {
      id,
      threshold: pr(thr),
      thresholdLatLon: { lat: e.threshold.lat, lon: e.threshold.lon },
      trueHeadingDeg: e.true_alignment_deg,
      magneticHeadingDeg: profile.chartedMagneticHeading(id, { procSrc, endSrc: e }),
      ...(e.displaced_threshold.present ? { displacedThresholdFt: e.displaced_threshold.length_ft } : {}),
      ...(typeof e.threshold_crossing_height_ft === 'number' && typeof e.visual_glide_path_angle_deg === 'number'
        ? { visualGlidepath: { angleDeg: e.visual_glide_path_angle_deg, tchFt: e.threshold_crossing_height_ft } }
        : {}),
      tdzeFt: e.tdz_elev_ft,
      ils:
        ilsInfo && sys
          ? { ident: sys.plate_ident, frequencyMhz: sys.loc_freq_mhz, courseDeg: sys.front_course_mag_deg, glideslopeDeg: sys.glideslope.angle_deg }
          : null,
      thresholdElevationFt: e.threshold.elev_ft,
      approachLighting: e.approach_lighting,
      vgsi: e.vgsi,
      reil: e.reil,
      lahso,
      declaredDistancesFt: { tora: e.declared_distances_ft.tora, toda: e.declared_distances_ft.toda, asda: e.declared_distances_ft.asda, lda: e.declared_distances_ft.lda },
    };
  });
  const a = ends[0].threshold as P;
  const b = ends[1].threshold as P;
  const widthM = src.width_ft * FT;
  const ux = (b.x - a.x) / dist(a, b);
  const uy = (b.y - a.y) / dist(a, b);
  const nx = -uy * (widthM / 2);
  const ny = ux * (widthM / 2);
  // The polygon extends POLY_EXT_M beyond each threshold so the thresholds are strictly interior points
  // (robust point-in-polygon for aircraft at/over the threshold); 1 m is 0.07% of the 13/31 length.
  const ex = ux * CONFIG.polygonExtensionM;
  const ey = uy * CONFIG.polygonExtensionM;
  const polygon: Vec2[] = [
    { x: a.x - ex + nx, y: a.y - ey + ny },
    { x: b.x + ex + nx, y: b.y + ey + ny },
    { x: b.x + ex - nx, y: b.y + ey - ny },
    { x: a.x - ex - nx, y: a.y - ey - ny },
  ].map(pr);
  const lengthBetween = dist(a, b) / FT;
  const rwy: KacyRunway = {
    id: `${ends[0].id}/${ends[1].id}`,
    ends: [ends[0], ends[1]],
    lengthFt: src.length_ft,
    widthFt: src.width_ft,
    surface: src.surface,
    polygon,
    lengthBetweenThresholdsFt: r2(lengthBetween),
    provenance: nasrProv(
      `NASR APT_RWY/APT_RWY_END: length ${src.length_ft} x ${src.width_ft} ft ${src.surface}, ${src.condition}, ${src.treatment}; threshold lat/lon from ${src.ends[0].threshold.position_source} ${src.ends[0].threshold.position_date}. ${profile.headingSourceNote} Polygon = rectangle between the two NASR thresholds at the NASR width, extended ${CONFIG.polygonExtensionM} m beyond each threshold (no stopways/overruns).`,
    ),
  };
  if (Math.abs(lengthBetween - src.length_ft) / src.length_ft > 0.005) warn(`runway ${rwy.id}: threshold-to-threshold ${lengthBetween.toFixed(0)} ft differs from NASR length ${src.length_ft} ft by >0.5%`);
  runwayBuilds.push({ runway: rwy, a, b, halfWidthM: widthM / 2 });
}
const runways: KacyRunway[] = runwayBuilds.map((r) => r.runway);
const runwayById = (id: string): RunwayBuild => runwayBuilds.find((r) => r.runway.id === id)!;

// ---------------------------------------------------------------------------------------------
// Taxiway network (OSM) -> planar graph
// ---------------------------------------------------------------------------------------------
const FAA_DIAGRAM_IDS: readonly string[] = profile.taxiwayIds;
const featsOf = (aeroway: string): J[] => (osm.features as J[]).filter((f) => f.properties.aeroway === aeroway);
const toLocalPts = (coords: [number, number][]): P[] => coords.map(([lon, lat]) => loc(lat, lon));

const excludedOsmRefs: string[] = [];
const abandonedWays: number[] = [];
const wayIns = featsOf('taxiway')
  .filter((f: J) => {
    const t = f.properties.tags ?? {};
    if (t.abandoned === 'yes' || t.disused === 'yes' || t.access === 'no') {
      abandonedWays.push(f.properties.osm_id as number);
      return false;
    }
    return true;
  })
  .map((f: J) => {
    let ref: string | null = f.properties.ref ?? null;
    if (ref && !FAA_DIAGRAM_IDS.includes(ref)) {
      // an OSM identifier that is not on the FAA diagram (OSM-only "I"): geometry kept, identifier excluded
      if (!excludedOsmRefs.includes(ref)) excludedOsmRefs.push(ref);
      ref = null;
    }
    return { key: `way/${f.properties.osm_id as number}`, osmId: f.properties.osm_id as number, ref, origRef: f.properties.ref as string | null, pts: toLocalPts(f.geometry.coordinates) };
  })
  .sort((a, b) => a.osmId - b.osmId);

const pl = new Planar();
pl.init(wayIns, CONFIG.snapM);
const nTJ = pl.tJunctions(CONFIG.snapM);
const nX = pl.crossings();
const nTiny1 = pl.contractTiny(CONFIG.tinyEdgeM);
pl.attachRunways(
  runwayBuilds.map((r) => ({ id: r.runway.id, a: r.a, b: r.b })),
  CONFIG.snapM,
);
const nTiny2 = pl.contractTiny(CONFIG.tinyEdgeM);
const droppedFillets = pl.collapseFillets(CONFIG.filletMaxM, CONFIG.filletReachM);
const nTiny3 = droppedFillets.length ? pl.contractTiny(CONFIG.tinyEdgeM) : 0;
report.push(`planar: ${wayIns.length} OSM taxiway ways -> ${pl.ways.filter((w) => w.kind === 'taxiway').length} ways, ${nTJ} T-junction splits, ${nX} crossings, ${nTiny1 + nTiny2 + nTiny3} tiny edges contracted${droppedFillets.length ? `, ${droppedFillets.length} mapped turn-on fillets collapsed (${droppedFillets.map((w) => w.key).join(', ')})` : ''}`);

// --- FAA diagram labels
const labelFile = profile.diagramLabels?.() ?? { labels: [], from: '', note: '' };
const labels: DiagramLabel[] = labelFile.labels.map((l) => ({ id: l.id, p: loc(l.lat, l.lon), pt: { x: l.ptX, y: l.ptY } }));

// --- identifier inference for untagged ways
const excludeKeys = new Set(wayIns.filter((w) => w.origRef && excludedOsmRefs.includes(w.origRef)).map((w) => w.key));
for (const w of pl.ways) if (excludeKeys.has(w.key)) w.origRef = wayIns.find((x) => x.key === w.key)!.origRef;
const decisions: Decision[] = inferIdentifiers(pl, labels, { labelMaxM: CONFIG.labelMaxM, contAngleDeg: CONFIG.contAngleDeg, excludeKeys });
// ---------------------------------------------------------------------------------------------
// Runway holding positions (derived; OSM has none)
// ---------------------------------------------------------------------------------------------
const HOLD_M = CONFIG.holdDistanceFt * FT;
const thresholdNodeOf = new Map<string, number[]>(); // runway id -> [thr node a, thr node b]
for (const rb of runwayBuilds) {
  const rw = pl.ways.find((w) => w.kind === 'runway' && w.runwayId === rb.runway.id)!;
  thresholdNodeOf.set(rb.runway.id, [rw.nodes[0], rw.nodes[rw.nodes.length - 1]]);
}
const nearestEnd = (rb: RunwayBuild, p: P): { end: KacyRunwayEnd; d: number; other: { end: KacyRunwayEnd; d: number } } => {
  const d0 = dist(p, rb.a);
  const d1 = dist(p, rb.b);
  const [e0, e1] = rb.runway.ends;
  return d0 <= d1 ? { end: e0, d: d0, other: { end: e1, d: d1 } } : { end: e1, d: d1, other: { end: e0, d: d0 } };
};
const distToRunwayLine = (rb: RunwayBuild, p: P): number => projectOnSegment(p, rb.a, rb.b).d;

interface HoldRec {
  node: number;
  runwayId: string;
  entryNode: number;
  taxiway: string;
  protectsEnd: string;
  otherEnd: string;
  entryDistFromEndM: number;
  entryDistFromOtherEndM: number;
  distFromCentrelineM: number;
  shortStub: boolean;
}
const holds: HoldRec[] = [];
const holdNodeSet = new Set<number>();

function buildAdjacency(): Map<number, { other: number; ways: PWay[] }[]> {
  const adj = new Map<number, { other: number; ways: PWay[] }[]>();
  for (const e of pl.edgeList()) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a)!.push({ other: e.b, ways: e.ways });
    adj.get(e.b)!.push({ other: e.a, ways: e.ways });
  }
  return adj;
}

for (const rb of runwayBuilds) {
  const namedAt = new Set<number>();
  for (const e of pl.edgeList()) if (e.ways.some((w) => w.kind === 'taxiway' && w.ref)) { namedAt.add(e.a); namedAt.add(e.b); }
  const nodes = [...pl.runwayNodes.get(rb.runway.id)!].filter((n) => pl.alive[n]).sort((p, q) => Number(namedAt.has(q)) - Number(namedAt.has(p)));
  for (const n of nodes) {
    const adj = buildAdjacency();
    const taxiNbrs = (adj.get(n) ?? []).filter((x) => x.ways.some((w) => w.kind === 'taxiway') && !x.ways.some((w) => w.kind === 'runway'));
    for (const nb of taxiNbrs) {
      // walk away from the centreline along degree-2 nodes until the perpendicular distance reaches HOLD_M
      let prev = n;
      let cur = nb.other;
      let pathLen = dist(pl.pos[prev], pl.pos[cur]);
      let found: { a: number; b: number; point: P; short: boolean } | null = null;
      let spur = false;
      const edgeWays = nb.ways;
      for (let guard = 0; guard < 200; guard++) {
        const dCur = distToRunwayLine(rb, pl.pos[cur]);
        if (dCur >= HOLD_M) {
          // bisect on segment prev->cur
          let lo = 0;
          let hi = 1;
          for (let i = 0; i < 40; i++) {
            const mid = (lo + hi) / 2;
            if (distToRunwayLine(rb, lerp(pl.pos[prev], pl.pos[cur], mid)) >= HOLD_M) hi = mid;
            else lo = mid;
          }
          found = { a: prev, b: cur, point: lerp(pl.pos[prev], pl.pos[cur], hi), short: false };
          break;
        }
        const nbrs = (adj.get(cur) ?? []).filter((x) => x.other !== prev);
        const isJunction = (adj.get(cur) ?? []).length >= 3 || pl.pinned.has(cur);
        if (isJunction && !pl.pinned.has(cur) && nbrs.length > 0) {
          // a junction before 250 ft (e.g. a mapped fillet that joins the through taxiway): keep walking along the branch that leads
          // away from the runway, so the hold line ends up on the through taxiway instead of inside the fillet
          const curD = distToRunwayLine(rb, pl.pos[cur]);
          const away = nbrs
            .filter((x) => !x.ways.some((w) => w.kind === 'runway') && !pl.pinned.has(x.other))
            .map((x) => ({ x, gain: distToRunwayLine(rb, pl.pos[x.other]) - curD }))
            .filter((c) => c.gain > 0.5)
            .sort((p, q) => q.gain - p.gain);
          if (away.length) {
            pathLen += dist(pl.pos[cur], pl.pos[away[0].x.other]);
            prev = cur;
            cur = away[0].x.other;
            continue;
          }
        }
        if (nbrs.length === 0 && !pl.pinned.has(cur) && pathLen < 2 * CONFIG.snapM) {
          // a dangling way end a few metres past the entry node (the mapped taxiway overshoots the centreline): not a taxi route, no hold line
          spur = true;
          break;
        }
        if (isJunction || nbrs.length === 0) {
          // short stub: junction/dead end reached before 250 ft; put the hold at 60% of the way
          const target = pathLen * 0.6;
          // locate target along the walked path (re-walk)
          let w2prev = n;
          let w2cur = nb.other;
          let acc = 0;
          for (let g2 = 0; g2 < 200; g2++) {
            const seg = dist(pl.pos[w2prev], pl.pos[w2cur]);
            if (acc + seg >= target) {
              found = { a: w2prev, b: w2cur, point: lerp(pl.pos[w2prev], pl.pos[w2cur], (target - acc) / seg), short: true };
              break;
            }
            acc += seg;
            const nx = (adj.get(w2cur) ?? []).find((x) => x.other !== w2prev);
            if (!nx) break;
            w2prev = w2cur;
            w2cur = nx.other;
          }
          break;
        }
        const next = nbrs[0].other;
        pathLen += dist(pl.pos[cur], pl.pos[next]);
        prev = cur;
        cur = next;
      }
      if (!found && spur) continue;
      if (!found) {
        hard(`no holding position could be placed for runway ${rb.runway.id} entry node ${n} (taxiway edge to node ${nb.other})`);
        continue;
      }
      const { a, b, point, short } = found;
      // several mapped fillets of one crossing lead to the same hold line on the through taxiway: keep the first (named entries come first)
      if (holds.some((h) => h.runwayId === rb.runway.id && dist(pl.pos[h.node], point) < 3)) continue;
      const edgeRef = pl.ways.find((w) => w.kind === 'taxiway' && w.ref && w.nodes.some((x, i) => i < w.nodes.length - 1 && ((x === a && w.nodes[i + 1] === b) || (x === b && w.nodes[i + 1] === a))))?.ref ?? '';
      const segLen = dist(pl.pos[a], pl.pos[b]);
      const tAlong = dist(pl.pos[a], point);
      let hn: number;
      if (tAlong < CONFIG.tinyEdgeM && a !== n && !pl.pinned.has(a) && (adj.get(a) ?? []).length === 2) hn = a;
      else if (segLen - tAlong < CONFIG.tinyEdgeM && !pl.pinned.has(b) && (adj.get(b) ?? []).length === 2) hn = b;
      else {
        const useT = Math.min(Math.max(tAlong, CONFIG.tinyEdgeM), segLen - CONFIG.tinyEdgeM) / segLen;
        hn = pl.addNode(lerp(pl.pos[a], pl.pos[b], useT));
        pl.insertOnEdge(a, b, hn);
      }
      const entry = nearestEnd(rb, pl.pos[n]);
      const tw = edgeWays.find((w) => w.ref && w.kind === 'taxiway')?.ref ?? edgeRef;
      holds.push({
        node: hn,
        runwayId: rb.runway.id,
        entryNode: n,
        taxiway: tw,
        protectsEnd: entry.end.id,
        otherEnd: entry.other.end.id,
        entryDistFromEndM: entry.d,
        entryDistFromOtherEndM: entry.other.d,
        distFromCentrelineM: distToRunwayLine(rb, pl.pos[hn]),
        shortStub: short,
      });
      holdNodeSet.add(hn);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Entry chains: the engine leaves a runway from a runway node straight to the adjacent hold node (rollout exits) and enters it the
// same way, so a hold line must be adjacent to its runway node. Where the OSM ways are digitised densely (curved entrances with a
// vertex every few metres) there are degree-2 vertices between the two; they are removed from the routing graph (the rendered
// taxiway polylines lose only those few vertices). Enabled per airport in its profile.
// ---------------------------------------------------------------------------------------------
let chainVerticesRemoved = 0;
if (profile.simplifyEntryChains) {
  for (const h of holds) {
    for (let guard = 0; guard < 60; guard++) {
      const adj = buildAdjacency();
      // shortest taxi path entry -> hold (BFS, runway-way edges excluded)
      const prev = new Map<number, number>([[h.entryNode, -1]]);
      const queue = [h.entryNode];
      while (queue.length && !prev.has(h.node)) {
        const x = queue.shift()!;
        for (const nb of adj.get(x) ?? []) {
          if (prev.has(nb.other) || nb.ways.some((w) => w.kind === 'runway')) continue;
          prev.set(nb.other, x);
          queue.push(nb.other);
        }
      }
      if (!prev.has(h.node)) break;
      const chain: number[] = [];
      for (let x = prev.get(h.node)!; x !== h.entryNode && x !== -1; x = prev.get(x)!) chain.push(x);
      // contract the vertex next to the runway node into it (keeps the way structure and the node's own position)
      const victim = chain[chain.length - 1];
      if (victim === undefined || (adj.get(victim) ?? []).length !== 2 || pl.pinned.has(victim) || holdNodeSet.has(victim)) break;
      pl.mergeNodes(h.entryNode, victim);
      chainVerticesRemoved++;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Aprons, buildings, parking
// ---------------------------------------------------------------------------------------------
const ringsOf = (f: J): P[][] => {
  const g = f.geometry;
  if (g.type === 'Polygon') return [toLocalPts(g.coordinates[0])];
  if (g.type === 'MultiPolygon') return (g.coordinates as J[]).map((poly: J) => toLocalPts(poly[0]));
  return [];
};
const apronRecs: ApronRec[] = featsOf('apron').flatMap((f: J) => ringsOf(f).map((ring) => ({ osmId: f.properties.osm_id as number, name: f.properties.name as string | null, ring })));
const apronOf = (osmId: number): ApronRec => apronRecs.find((a) => a.osmId === osmId)!;

const buildings: KacyBuilding[] = [];
for (const kind of ['terminal', 'hangar', 'helipad'] as const) {
  for (const f of featsOf(kind)) {
    const ring = ringsOf(f)[0];
    if (!ring) continue;
    buildings.push({
      id: `${kind}-${f.properties.osm_id as number}`,
      kind,
      ...(f.properties.name ? { name: f.properties.name as string } : {}),
      osmId: f.properties.osm_id as number,
      polygon: ring.map(pr),
      provenance: osmProv(`aeroway=${kind}${f.properties.tags?.building ? `, building=${f.properties.tags.building as string}` : ''}`),
    });
  }
}
const buildingPolys: P[][] = buildings.filter((b) => b.kind !== 'helipad').map((b) => b.polygon as P[]);

const parkRecs: ParkRec[] = [];
const apronNodeSet = new Set<number>();
const parkNodeSet = new Set<number>();
const connectors: { a: number; b: number; len: number }[] = [];

interface NetPoint {
  a: number;
  b: number;
  foot: P;
  d: number;
}
/** Nearest point on any non-runway taxi/apron edge. */
function nearestNetworkPoint(p: P): NetPoint | null {
  let best: NetPoint | null = null;
  for (const e of pl.edgeList()) {
    if (e.ways.some((w) => w.kind === 'runway')) continue;
    const r = projectOnSegment(p, pl.pos[e.a], pl.pos[e.b]);
    if (!best || r.d < best.d) best = { a: e.a, b: e.b, foot: r.q, d: r.d };
  }
  return best;
}
function networkDistance(p: P): number {
  return nearestNetworkPoint(p)?.d ?? Infinity;
}
/** Make `np` a node: reuse an endpoint if within 2 m (and not a runway/hold node), else split the edge. */
function nodeAt(np: NetPoint): number {
  for (const n of [np.a, np.b]) {
    if (!pl.pinned.has(n) && !holdNodeSet.has(n) && dist(pl.pos[n], np.foot) < 2) return n;
  }
  const n = pl.addNode(np.foot);
  pl.insertOnEdge(np.a, np.b, n);
  apronNodeSet.add(n);
  return n;
}
function connectParking(rec: ParkRec, maxM: number): void {
  const stop = rec.leadIn[rec.leadIn.length - 1];
  const stopNode = pl.addNode(stop);
  parkNodeSet.add(stopNode);
  rec.node = stopNode;
  // chain of lead-in vertices (skip the first, which attaches to the network)
  const chain: number[] = [];
  const mid = rec.leadIn.slice(1, -1);
  let lastP = stop;
  const keepMid: P[] = [];
  for (let i = mid.length - 1; i >= 0; i--) {
    if (dist(mid[i], lastP) >= CONFIG.tinyEdgeM) {
      keepMid.unshift(mid[i]);
      lastP = mid[i];
    }
  }
  for (const m of keepMid) {
    const n = pl.addNode(m);
    apronNodeSet.add(n);
    chain.push(n);
  }
  const first = rec.leadIn.length > 1 ? rec.leadIn[0] : stop;
  const np = nearestNetworkPoint(first);
  if (!np || np.d > (rec.leadIn.length > 1 ? 10 : maxM)) {
    if (rec.leadIn.length > 1 && np && np.d <= maxM) {
      /* lead-in start is off the lane but within range: still attach, flagged */
    } else {
      rec.connected = false;
      warn(`parking ${rec.id}: no taxi-network point within ${maxM} m of the lead-in start (nearest ${np ? np.d.toFixed(0) : 'n/a'} m)`);
      return;
    }
  }
  const laneNode = nodeAt(np!);
  const seq = [laneNode, ...chain, stopNode];
  if (rec.leadIn.length === 1) {
    // synthetic: straight connector from the foot point
  }
  let total = 0;
  for (let i = 0; i + 1 < seq.length; i++) {
    const len = dist(pl.pos[seq[i]], pl.pos[seq[i + 1]]);
    total += len;
    connectors.push({ a: seq[i], b: seq[i + 1], len });
  }
  if (rec.leadIn.length > 1 && np!.d > 0.5) {
    // include the gap between the lead-in start and the lane foot point
    total += np!.d;
  }
  rec.connectorLengthM = total;
  rec.connected = true;
  if (rec.headingDeg === undefined) {
    const prevP = pl.pos[seq[seq.length - 2]];
    rec.headingDeg = Math.round(bearing(prevP, stop));
  }
}

function sampleSpots(poly: P[], opts: { spacing: number; margin: number; avoidBuildingsM: number; accept: (p: P) => boolean }): P[] {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const out: P[] = [];
  for (let x = Math.floor(Math.min(...xs) / opts.spacing) * opts.spacing; x <= Math.max(...xs); x += opts.spacing) {
    for (let y = Math.floor(Math.min(...ys) / opts.spacing) * opts.spacing; y <= Math.max(...ys); y += opts.spacing) {
      const p = { x, y };
      if (!pointInPolygon(p, poly) || distToPolygonEdge(p, poly) < opts.margin) continue;
      if (buildingPolys.some((b) => pointInPolygon(p, b) || distToPolygonEdge(p, b) < opts.avoidBuildingsM)) continue;
      if (!opts.accept(p)) continue;
      out.push(p);
    }
  }
  return out;
}
function pickSpots(cands: P[], n: number, minSep: number, maxNet: number): P[] {
  const scored = cands.map((p) => ({ p, d: networkDistance(p) })).filter((c) => c.d <= maxNet && c.d >= 8).sort((a, b) => a.d - b.d || a.p.x - b.p.x || a.p.y - b.p.y);
  const picked: P[] = [];
  for (const c of scored) {
    if (picked.every((q) => dist(q, c.p) >= minSep)) picked.push(c.p);
    if (picked.length >= n) break;
  }
  return picked;
}
const addSynthetic = (ids: { id: string; name: string; category: KacyParking['category']; zone: string; notes: string }, p: P): void => {
  parkRecs.push({ ...ids, pos: p, source: 'synthetic', approximate: true, leadIn: [p], node: -1, connectorLengthM: 0, connected: false });
};
// --- airport-specific stands (gates, GA / FBO / cargo / military spots) come from the profile
const parkingCtx: ParkingCtx = {
  featsOf,
  toLocalPts,
  loc,
  ringsOf,
  buildings: buildings as unknown as BuildingRec[],
  apronRecs,
  apronOf,
  buildingPolys,
  parkRecs,
  networkDistance,
  sampleSpots,
  pickSpots,
  addSynthetic,
  warn,
  syntheticSpotSpacingM: CONFIG.syntheticSpotSpacingM,
  parkingConnectMaxM: CONFIG.parkingConnectMaxM,
};
const parkingResult = profile.parking(parkingCtx);

for (const rec of parkRecs) connectParking(rec, CONFIG.parkingConnectMaxM);

// ---------------------------------------------------------------------------------------------
// Assemble nodes and edges
// ---------------------------------------------------------------------------------------------
const rawEdges = pl.edgeList();
interface FEdge {
  a: number;
  b: number;
  taxiway: string;
  kind: KacyTaxiEdge['kind'];
  runwayId?: string;
  osmWayIds: number[];
  approximate?: boolean;
}
const fedges: FEdge[] = [];
for (const e of rawEdges) {
  const rwy = e.ways.find((w) => w.kind === 'runway');
  if (rwy) {
    fedges.push({ a: e.a, b: e.b, taxiway: `RWY${rwy.runwayId}`, kind: 'runway', runwayId: rwy.runwayId, osmWayIds: [] });
    continue;
  }
  const named = e.ways.find((w) => w.ref);
  fedges.push({
    a: e.a,
    b: e.b,
    taxiway: named?.ref ?? '',
    kind: named ? 'taxiway' : 'unnamed',
    osmWayIds: e.ways.map((w) => w.osmId).filter((x): x is number => x !== null),
    ...(named ? {} : { approximate: true }),
  });
}
for (const c of connectors) fedges.push({ a: c.a, b: c.b, taxiway: '', kind: 'apron_connector', osmWayIds: [], approximate: true });

// node membership
const usedNodes = new Set<number>();
for (const e of fedges) {
  usedNodes.add(e.a);
  usedNodes.add(e.b);
}
parkRecs.forEach((r) => {
  if (r.node >= 0) usedNodes.add(r.node);
});
const incident = new Map<number, FEdge[]>();
for (const e of fedges) {
  for (const n of [e.a, e.b]) {
    if (!incident.has(n)) incident.set(n, []);
    incident.get(n)!.push(e);
  }
}
const runwaysOfNode = new Map<number, string[]>();
for (const [rid, set] of pl.runwayNodes) for (const n of set) runwaysOfNode.set(n, [...(runwaysOfNode.get(n) ?? []), rid]);
const thrNodeIds = new Set([...thresholdNodeOf.values()].flat());

// --- taxi edges that lie on a runway surface carry onRunwayId (engine contract; `taxiway` keeps the human identifier)
const runwayMarked: { edge: FEdge; why: string }[] = [];
const markOnRunway = (e: FEdge, rid: string, why: string): void => {
  if (e.runwayId && e.runwayId !== rid) {
    hard(`taxi edge ${e.taxiway || '(unnamed)'} ${e.a}-${e.b} would lie on two runways (${e.runwayId} and ${rid}); split the edge`);
    return;
  }
  if (!e.runwayId) runwayMarked.push({ edge: e, why });
  e.runwayId = rid;
};
{
  const taxiAdj = new Map<number, { other: number; e: FEdge }[]>();
  for (const e of fedges) {
    if (e.kind !== 'taxiway' && e.kind !== 'unnamed') continue;
    for (const [x, y] of [[e.a, e.b], [e.b, e.a]]) taxiAdj.set(x, [...(taxiAdj.get(x) ?? []), { other: y, e }]);
  }
  // (1) every edge between a hold line and its runway entry node: the crossing starts at the hold line
  for (const h of holds) {
    const prev = new Map<number, { from: number; e: FEdge }>([[h.node, { from: -1, e: undefined as unknown as FEdge }]]);
    const queue = [h.node];
    while (queue.length && !prev.has(h.entryNode)) {
      const x = queue.shift()!;
      for (const { other, e } of taxiAdj.get(x) ?? []) {
        if (prev.has(other)) continue;
        prev.set(other, { from: x, e });
        queue.push(other);
      }
    }
    if (!prev.has(h.entryNode)) {
      hard(`hold ${h.node} has no taxi path to its runway entry node ${h.entryNode} (hold ${JSON.stringify(pl.pos[h.node])}, entry ${JSON.stringify(pl.pos[h.entryNode])}, runway ${h.runwayId}, taxiway ${h.taxiway})`);
      continue;
    }
    for (let x = h.entryNode; x !== h.node; ) {
      const step = prev.get(x)!;
      markOnRunway(step.e, h.runwayId, 'hold-to-entry path');
      x = step.from;
    }
  }
  // (2) any taxi edge with a runway-kind endpoint, or whose midpoint is inside a runway polygon
  for (const e of fedges) {
    if (e.kind !== 'taxiway' && e.kind !== 'unnamed') continue;
    const mid = lerp(pl.pos[e.a], pl.pos[e.b], 0.5);
    const inside = runways.find((r) => pointInPolygon(mid, r.polygon as P[]));
    if (inside) markOnRunway(e, inside.id, 'midpoint inside runway polygon');
    for (const n of [e.a, e.b]) {
      if (!pl.pinned.has(n)) continue;
      const rids = runwaysOfNode.get(n) ?? [];
      if (rids.length === 1) markOnRunway(e, rids[0], 'runway-kind endpoint');
      else if (rids.length > 1 && !e.runwayId) hard(`taxi edge touches multi-runway node ${n} without lying on a runway`);
    }
  }
}

// deterministic ids: sort by position
const sortedNodes = [...usedNodes].sort((p, q) => pl.pos[p].x - pl.pos[q].x || pl.pos[p].y - pl.pos[q].y);
const nodeIdOf = new Map<number, string>();
const rtag = (id: string): string => id.replace('/', '-');
let tCount = 0;
let xCount = 0;
let apCount = 0;
const hpCounter = new Map<string, number>();
const kindOf = new Map<number, KacyTaxiNode['kind']>();
for (const n of sortedNodes) {
  const inc = incident.get(n) ?? [];
  const taxiInc = inc.filter((e) => e.kind === 'taxiway' || e.kind === 'unnamed');
  const refs = new Set(taxiInc.map((e) => e.taxiway).filter(Boolean));
  let kind: KacyTaxiNode['kind'];
  if (parkNodeSet.has(n)) kind = 'parking';
  else if (pl.pinned.has(n)) kind = 'runway';
  else if (holdNodeSet.has(n)) kind = 'holding_position';
  else if (apronNodeSet.has(n)) kind = 'apron';
  else if (taxiInc.length >= 3 || refs.size >= 2) kind = 'intersection';
  else kind = 'taxiway';
  kindOf.set(n, kind);
}
// runway + threshold ids in runway order
for (const rb of runwayBuilds) {
  const rw = pl.ways.find((w) => w.kind === 'runway' && w.runwayId === rb.runway.id)!;
  rw.nodes.forEach((n, i) => {
    if (i === 0) nodeIdOf.set(n, `THR${rb.runway.ends[0].id}`);
    else if (i === rw.nodes.length - 1) nodeIdOf.set(n, `THR${rb.runway.ends[1].id}`);
    else if (!nodeIdOf.has(n)) nodeIdOf.set(n, `R${rtag(rb.runway.id)}-${String(i).padStart(2, '0')}`);
  });
}
for (const n of sortedNodes) {
  if (nodeIdOf.has(n)) continue;
  const k = kindOf.get(n)!;
  if (k === 'parking') {
    const rec = parkRecs.find((r) => r.node === n)!;
    nodeIdOf.set(n, `PK-${rec.id}`);
  } else if (k === 'holding_position') {
    const h = holds.find((x) => x.node === n)!;
    const key = `${rtag(h.runwayId)}-${h.taxiway || 'U'}`;
    const c = (hpCounter.get(key) ?? 0) + 1;
    hpCounter.set(key, c);
    nodeIdOf.set(n, `HP${rtag(h.runwayId)}-${h.taxiway || 'U'}-${c}`);
  } else if (k === 'apron') nodeIdOf.set(n, `AP${String(++apCount).padStart(3, '0')}`);
  else if (k === 'intersection') nodeIdOf.set(n, `X${String(++xCount).padStart(3, '0')}`);
  else nodeIdOf.set(n, `T${String(++tCount).padStart(4, '0')}`);
}
// the runway-runway crossing node (KACY: FAA hot spot HS 1)
const xRunwayNode = [...pl.runwayNodes.get(runways[0].id)!].find((n) => (runwaysOfNode.get(n) ?? []).length === 2);
if (xRunwayNode === undefined) hard(`runway centrelines ${runways[0].id} and ${runways[1].id} do not intersect in the built graph`);
else nodeIdOf.set(xRunwayNode, profile.crossing.nodeId);

const nodes: Record<string, KacyTaxiNode> = {};
for (const n of sortedNodes) {
  const id = nodeIdOf.get(n)!;
  const kind = kindOf.get(n)!;
  const inc = incident.get(n) ?? [];
  const taxiways = [...new Set(inc.filter((e) => e.kind === 'taxiway').map((e) => e.taxiway))].sort();
  const node: KacyTaxiNode = { id, kind, pos: pr(pl.pos[n]), latLon: ll(pl.pos[n]), taxiways };
  const rids = runwaysOfNode.get(n);
  if (kind === 'runway' && rids) {
    node.runwayId = rids.length === 2 ? [...rids].sort((p, q) => runwayById(q).runway.lengthFt - runwayById(p).runway.lengthFt)[0] : rids[0]; // a crossing node belongs to the longer runway
    node.runwayIds = rids;
    const dists: Record<string, number> = {};
    for (const rid of rids) {
      const rb = runwayById(rid);
      const t = projectOnSegment(pl.pos[n], rb.a, rb.b).t;
      dists[rb.runway.ends[0].id] = r2(t * dist(rb.a, rb.b));
      dists[rb.runway.ends[1].id] = r2((1 - t) * dist(rb.a, rb.b));
    }
    node.distFromThresholdM = dists;
    if (thrNodeIds.has(n)) node.name = `Threshold ${nodeIdOf.get(n)!.replace('THR', '')}`;
    if (n === xRunwayNode) {
      node.name = profile.crossing.name;
      node.notes = profile.crossing.notes;
    }
  }
  if (kind === 'holding_position') {
    const h = holds.find((x) => x.node === n)!;
    node.runwayId = h.runwayId;
    node.protectsRunwayEnd = h.protectsEnd;
    node.approximate = true;
    node.holdDistanceM = r2(h.distFromCentrelineM);
    node.entryNodeId = nodeIdOf.get(h.entryNode);
    node.name = `Hold short RWY ${h.runwayId}${h.taxiway ? ` on ${h.taxiway}` : ''}`;
    node.notes = `Derived hold line (not in OSM or FAA data): ${CONFIG.holdDistanceFt} ft (${r2(HOLD_M)} m) from the runway ${h.runwayId} centreline on the connecting taxiway edge${h.shortStub ? '; stub shorter than 250 ft so placed at 60% of the stub' : ''}. Entry point on the runway is ${r2(h.entryDistFromEndM)} m from the ${h.protectsEnd} threshold and ${r2(h.entryDistFromOtherEndM)} m from the ${h.otherEnd} threshold; protectsRunwayEnd is the nearer threshold (a departure entering here may in practice use the opposite end).`;
  }
  if (kind === 'apron') node.approximate = true;
  if (kind === 'parking') {
    const rec = parkRecs.find((r) => r.node === n)!;
    node.name = rec.name;
    node.approximate = rec.approximate;
  }
  nodes[id] = node;
}

const edgeSortKey = (e: FEdge): string => `${e.kind}|${e.taxiway}|${nodeIdOf.get(e.a)!}|${nodeIdOf.get(e.b)!}`;
fedges.sort((x, y) => (edgeSortKey(x) < edgeSortKey(y) ? -1 : edgeSortKey(x) > edgeSortKey(y) ? 1 : 0));
const edges: KacyTaxiEdge[] = fedges.map((e, i) => ({
  id: `E${String(i + 1).padStart(4, '0')}`,
  from: nodeIdOf.get(e.a)!,
  to: nodeIdOf.get(e.b)!,
  taxiway: e.taxiway,
  lengthM: r2(dist(pl.pos[e.a], pl.pos[e.b])),
  kind: e.kind,
  ...(e.runwayId ? { onRunwayId: e.runwayId } : {}),
  ...(e.osmWayIds.length ? { osmWayIds: e.osmWayIds } : {}),
  ...(e.approximate ? { approximate: true } : {}),
}));

// rendering polylines (node sequence of each way, identifiers after inference)
const taxiwayPolylines: Record<string, Vec2[][]> = {};
for (const w of pl.ways) {
  if (w.kind !== 'taxiway') continue;
  const key = w.ref ?? 'UNNAMED';
  (taxiwayPolylines[key] ??= []).push(w.nodes.map((n) => pr(pl.pos[n])));
}
const apronPolys: Vec2[][] = apronRecs.map((a) => a.ring.map(pr));

// ---------------------------------------------------------------------------------------------
// Frequencies (all values read from <slug>-frequencies.json)
// ---------------------------------------------------------------------------------------------
const titleCase = (s: string): string => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
/** Spoken airport name for the radio layer: "ATLANTIC CITY INTL" -> "Atlantic City International" (raw NASR name kept in provenance notes as nasrName). */
const spokenName = (nasrName: string): string => profile.spokenName?.(nasrName) ?? titleCase(nasrName.replace(/\bINTL\b/, 'INTERNATIONAL').replace(/\bRGNL\b/, 'REGIONAL'));
const callName = titleCase(freqSrc.facility.radio_call as string); // "Atlantic City", "Manchester"
const approachCallName = titleCase((freqSrc.facility.approach_radio_call ?? freqSrc.facility.radio_call) as string); // "Atlantic City", "Boston"
const freqProv = (note: string): DataProvenance => nasrProv(note, { source: `FAA NASR 28-day subscription (FRQ.csv, cycle ${NASR_FROM}); cross-checked with d-TPP airport diagram ${profile.diagramPdf.replace(/\.PDF$/i, '')} cycle ${procSrc._provenance.cycle as string}` });
/** "130-309" -> { fromDeg: 130, toDeg: 309 } (NASR sectorization bearings; may wrap through north, e.g. 310-129). */
const sector = (s: string | undefined): { sectorBearings: { fromDeg: number; toDeg: number } } | Record<string, never> => {
  const m = /^(\d{1,3})-(\d{1,3})$/.exec(s ?? '');
  return m ? { sectorBearings: { fromDeg: parseInt(m[1], 10), toDeg: parseInt(m[2], 10) } } : {};
};
const mkFreq = (id: string, name: string, vhf: string, position: RadioFrequencyPosition, note: string, sectorBearings?: string): RadioFrequency => ({ id, name, mhz: parseFloat(vhf), position, ...sector(sectorBearings), provenance: freqProv(note) });
type RadioFrequencyPosition = RadioFrequency['position'];
const frequencies: RadioFrequency[] = profile.frequencies({ freqSrc, callName, approachCallName, mk: mkFreq });

// ---------------------------------------------------------------------------------------------
// Navaids and fixes (all values read from <slug>-navaids.json)
// ---------------------------------------------------------------------------------------------
const navProv = (note: string): DataProvenance => nasrProv(note, { source: `FAA NASR 28-day subscription (NAV/ILS/FIX CSV, cycle ${NASR_FROM})` });
const mkNav = (n: Omit<NavigationAid, 'pos' | 'provenance'> & { notes: string }): NavigationAid & Record<string, unknown> => {
  const { notes, ...rest } = n;
  return { ...rest, pos: pr(loc(n.latLon.lat, n.latLon.lon)), provenance: navProv(notes) };
};
const navaids: (NavigationAid & Record<string, unknown>)[] = [];
const vt: J = navPrimary;
navaids.push({
  ...mkNav({ id: vt.id, type: vt.type, name: vt.name, frequencyMhz: vt.freq_mhz, latLon: { lat: vt.lat, lon: vt.lon }, notes: `TACAN/DME channel ${vt.tacan_dme_channel as string}; status ${vt.status as string}; ${(vt.remarks as string[]).join(' ')}; mag var ${vt.mag_var as string}${vt.mag_var_epoch ? ` (${vt.mag_var_epoch as string})` : ''}; elevation ${vt.elev_ft as number} ft` }),
  status: vt.status,
  channel: vt.tacan_dme_channel,
  restrictions: vt.remarks,
});
for (const o of navOther) {
  navaids.push({
    ...mkNav({ id: o.id, type: o.type, name: o.name, frequencyMhz: parseFloat(o.freq_mhz), latLon: { lat: o.lat, lon: o.lon }, notes: `channel ${o.channel as string}; status ${o.status as string}; mag var ${o.mag_var as string}; elevation ${o.elev_ft as number} ft` }),
    status: o.status,
    channel: o.channel,
  });
}
for (const s of ilsSystems) {
  const rwy = `RWY ${s.runway_end as string}`;
  navaids.push({
    ...mkNav({ id: s.plate_ident, type: 'LOC', name: `${s.plate_ident as string} localizer ${rwy}`, frequencyMhz: s.loc_freq_mhz, latLon: { lat: s.localizer_antenna.lat, lon: s.localizer_antenna.lon }, notes: `${s.category as string}; front course ${s.front_course_mag_deg as number} magnetic; ${s.system_type_meaning as string}; DME channel ${s.dme_channel as string}; status ${s.status as string}; approach lighting ${s.approach_lighting as string}; ${s.plate_data.plate_minima as string}` }),
    status: s.status,
  });
  navaids.push({
    ...mkNav({ id: `${s.plate_ident as string}-GS`, type: 'ILS', name: `${s.plate_ident as string} glideslope ${rwy}`, frequencyMhz: s.glideslope.freq_mhz, latLon: { lat: s.glideslope.antenna.lat, lon: s.glideslope.antenna.lon }, notes: `glide angle ${s.glideslope.angle_deg as number} deg; status ${s.glideslope.status as string}` }),
    status: s.glideslope.status,
  });
  if (s.dme_antenna) navaids.push({
    ...mkNav({ id: `${s.plate_ident as string}-DME`, type: 'DME', name: `${s.plate_ident as string} DME ${rwy}`, latLon: { lat: s.dme_antenna.lat, lon: s.dme_antenna.lon }, notes: `paired channel ${s.dme_channel as string} with the ${s.plate_ident as string} localizer` }),
    channel: s.dme_channel,
  });
}
for (const f of navFixes) {
  navaids.push(
    mkNav({
      id: f.id,
      type: 'FIX',
      latLon: { lat: f.lat, lon: f.lon },
      notes: `FIX use ${String(f.fix_use_code).trim()}; charted on ${f.charted_on as string}; roles: ${Object.entries(rolesOf(f)).filter(([, v]) => v).map(([k, v]) => `${k}: ${v as string}`).join('; ')} (roles transcribed from the plates)`,
    }),
  );
}
const knownIds = new Set(navaids.map((n) => n.id));

// ---------------------------------------------------------------------------------------------
// Procedures (all URLs read from <slug>-procedures.json)
// ---------------------------------------------------------------------------------------------
const slug = (s: string): string => s.toUpperCase().replace(/[()]/g, '').replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
function fixesOf(entries: { fix: string; role: string }[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (/marker|antenna/i.test(e.role)) continue;
    const toks = e.fix.match(/\b[A-Z]{3,5}\b/g) ?? [];
    const t = toks.find((x) => knownIds.has(x));
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
const textField = <K extends 'missedApproachText' | 'holdingText' | 'minimaText'>(key: K, v: unknown): Partial<Record<K, string>> => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t && t !== '-' ? ({ [key]: t } as Record<K, string>) : {};
};
const holdSrc: J = readOptional(profile.holdingPatternsFile) ?? { procedures: [] };
const holdsByPdf = new Map<string, J[]>((holdSrc.procedures as J[]).map((p: J) => [p.pdf_name as string, p.holds as J[]]));
const holdingPatternsOf = (pdfName: string): NonNullable<InstrumentProcedure['holdingPatterns']> =>
  (holdsByPdf.get(pdfName) ?? []).map((h: J) => ({
    fix: h.fix,
    inboundCourseDeg: h.inbound_course_mag_deg,
    turns: h.turns,
    ...(h.leg_nm !== undefined ? { legNm: h.leg_nm } : {}),
    ...(h.leg_minutes !== undefined ? { legMinutes: h.leg_minutes } : {}),
    role: h.role,
    ...(h.max_speed_kt ? { maxSpeedKt: h.max_speed_kt } : {}),
    // extras beyond the core contract (structural superset)
    outboundCourseDeg: h.outbound_course_mag_deg,
    legSource: h.leg_source,
    notes: h.notes,
    source: h.provenance,
  }));
const fixAltSrc: J = readOptional(profile.fixAltitudesFile) ?? { procedures: [] };
const fixAltsByPdf = new Map<string, J[]>((fixAltSrc.procedures as J[]).map((p: J) => [p.pdf_name as string, p.fix_altitudes as J[]]));
const fixAltitudesOf = (pdfName: string): NonNullable<InstrumentProcedure['fixAltitudes']> =>
  (fixAltsByPdf.get(pdfName) ?? []).map((f: J) => ({
    fix: f.fix,
    ...(f.min_altitude_ft !== undefined ? { minAltitudeFt: f.min_altitude_ft } : {}),
    ...(f.max_altitude_ft !== undefined ? { maxAltitudeFt: f.max_altitude_ft } : {}),
    ...(f.mandatory_altitude_ft !== undefined ? { mandatoryAltitudeFt: f.mandatory_altitude_ft } : {}),
    note: `${f.note ?? ''}${f.note ? ' ' : ''}[${f.provenance as string}]`.trim(),
  }));
const plateGeomSrc: J = readOptional(profile.plateGeometryFile) ?? { procedures: [] };
const plateGeomByPdf = new Map<string, J>((plateGeomSrc.procedures as J[]).map((p: J) => [p.pdf_name as string, p]));
const plateGeometryOf = (pdfName: string): Pick<InstrumentProcedure, 'glidepath' | 'missedApproach'> => {
  const g = plateGeomByPdf.get(pdfName);
  if (!g) return {};
  const ma = g.missed_approach as J;
  return {
    glidepath: { kind: g.glidepath.kind, angleDeg: g.glidepath.angle_deg, tchFt: g.glidepath.tch_ft },
    missedApproach: {
      ...(typeof ma.initial_climb_altitude_ft === 'number' ? { initialClimbFt: ma.initial_climb_altitude_ft } : {}),
      finalAltitudeFt: ma.final_altitude_ft,
      plateText: ma.plate_text,
    },
  };
};
const procedures: InstrumentProcedure[] = [];
for (const a of procSrc.instrument_approaches as J[]) {
  procedures.push({
    id: slug(a.chart_name),
    name: a.chart_name,
    type: 'IAP',
    runwayEnd: endId(a.runway),
    chartPdfUrl: a.pdf.url,
    fixes: fixesOf(a.fixes_and_roles),
    // plate transcriptions copied verbatim from <slug>-procedures.json ('-' in the source means "none printed" and is omitted)
    ...textField('missedApproachText', a.missed_approach),
    ...textField('holdingText', a.holding),
    ...textField('minimaText', a.minima_summary),
    holdingPatterns: holdingPatternsOf(a.pdf_name),
    fixAltitudes: fixAltitudesOf(a.pdf_name),
    ...plateGeometryOf(a.pdf_name),
    provenance: dtppProv(a.pdf.url, `${a.printed_amendment_on_plate as string}; HTTP ${a.pdf.http_status as number} ${a.pdf.content_type as string}; ${a.data_provenance as string}`),
  });
}
const ad: J = procSrc.airport_diagram;
procedures.push({ id: 'AIRPORT-DIAGRAM', name: ad.chart_name, type: 'DIAGRAM', chartPdfUrl: ad.pdf.url, provenance: dtppProv(ad.pdf.url, `${ad.printed_header as string}; HTTP ${ad.pdf.http_status as number}`) });
for (const d of procSrc.departure_procedures as J[]) {
  procedures.push({
    id: slug(d.chart_name),
    name: d.chart_name,
    type: 'DP',
    chartPdfUrl: d.pdf.url,
    ...(d.maintain_altitude_ft !== undefined ? { maintainAltitudeFt: d.maintain_altitude_ft as number } : {}),
    provenance: dtppProv(d.pdf.url, `${d.type as string}; printed ${d.printed_date as string}; ${d.note as string}`),
  });
}
const starOf = (t: J): NonNullable<InstrumentProcedure['star']> => ({
  ident: t.ident,
  spokenName: t.spoken_name,
  transitions: (t.transitions as J[]).map((x) => ({ name: x.name, fixes: [...x.fixes] })),
  runways: (t.runways as J[]).map((r) => ({
    runwayEnd: endId(r.runway_end),
    fixes: [...r.fixes],
    ...(r.join_approach_fixes?.length ? { joinApproachFixes: [...r.join_approach_fixes] } : {}),
    ...(r.then_heading_mag_deg !== undefined ? { thenHeadingMagDeg: r.then_heading_mag_deg } : {}),
    expect: r.expect,
  })),
  restrictions: (t.restrictions as J[]).map((r) => ({
    fix: r.fix,
    ...(r.at_or_above_ft !== undefined ? { atOrAboveFt: r.at_or_above_ft } : {}),
    ...(r.at_or_below_ft !== undefined ? { atOrBelowFt: r.at_or_below_ft } : {}),
    ...(r.at_ft !== undefined ? { atFt: r.at_ft } : {}),
    ...(r.speed_kt !== undefined ? { speedKt: r.speed_kt } : {}),
  })),
  legs: (t.legs as J[]).map((l) => ({ from: l.from, to: l.to, ...(l.track_mag_deg !== undefined ? { trackMagDeg: l.track_mag_deg } : {}), distanceNm: l.distance_nm, ...(l.mea_ft !== undefined ? { meaFt: l.mea_ft } : {}) })),
  notes: [...t.notes],
});
for (const st of (procSrc.stars ?? []) as J[]) {
  for (const f of st.star ? ([...(st.star.transitions as J[]).flatMap((x) => x.fixes), ...(st.star.runways as J[]).flatMap((r) => [...r.fixes, ...(r.join_approach_fixes ?? [])])] as string[]) : []) {
    if (!knownIds.has(f)) throw new Error(`STAR ${st.chart_name as string}: fix ${f} is not in ${SLUG}-navaids.json`);
  }
  procedures.push({
    id: slug(st.chart_name), name: st.chart_name, type: 'STAR', chartPdfUrl: st.pdf.url,
    ...(st.star ? { star: starOf(st.star) } : {}),
    provenance: dtppProv(st.pdf.url, `${st.type as string}; ${st.note as string}`),
  });
}
const volumeId = String(procSrc._provenance.volume).split(' ')[0]; // "NE-2"
const supportingCharts: KacyAirport['supportingCharts'] = [];
for (const k of ['takeoff_minimums_pdf', 'lahso', 'hot_spot'] as const) {
  for (const c of procSrc.supporting_charts[k] as J[]) {
    supportingCharts.push({ id: slug(c.chart_name), name: c.chart_name, chartPdfUrl: c.pdf.url, provenance: dtppProv(c.pdf.url, `Regional ${volumeId} booklet page (shared by several airports); HTTP ${c.pdf.http_status as number}`) });
  }
}

// ---------------------------------------------------------------------------------------------
// Minimum vectoring altitude sectors (FAA MVA digital product; only airports whose profile includes it)
// ---------------------------------------------------------------------------------------------
const mva = profile.mva?.({ loc, pr });
const mvaSectors: KacyMvaSector[] = mva?.sectors ?? [];

// ---------------------------------------------------------------------------------------------
// Hot spot, LAHSO, airport object
// ---------------------------------------------------------------------------------------------
const hotSpotText = procSrc.supporting_charts?.hot_spot_text as string | undefined;
const hotSpot: HotSpot | undefined = hotSpotText
  ? {
      id: 'HS 1',
      description: `${hotSpotText} Caution on the diagram: BE ALERT TO RUNWAY CROSSING CLEARANCES. READBACK OF ALL RUNWAY HOLDING INSTRUCTIONS IS REQUIRED.`,
      ...(xRunwayNode !== undefined ? { pos: pr(pl.pos[xRunwayNode]) } : {}),
      provenance: dtppProv(procSrc.supporting_charts.hot_spot[0].pdf.url as string, profile.hotSpotProvenanceNote),
    }
  : undefined;

const parking: KacyParking[] = parkRecs.map((r) => ({
  id: r.id,
  name: r.name,
  nodeId: r.node >= 0 ? nodeIdOf.get(r.node)! : '',
  pos: pr(r.pos),
  category: r.category,
  ...(r.headingDeg !== undefined ? { headingDeg: r.headingDeg } : {}),
  source: r.source,
  approximate: r.approximate,
  zone: r.zone,
  ...(r.notes ? { notes: r.notes } : {}),
  connectorLengthM: r2(r.connectorLengthM),
  ...(!r.connected || r.connectorLengthM > CONFIG.parkingConnectMaxM ? { connectorOverLimit: true } : {}),
}));

const unresolved = decisions.filter((d) => d.method === 'unresolved' || d.method === 'excluded');
const airport: KacyAirport = {
  icao: facility.airport.icao,
  faaId: facility.airport.faa_id,
  name: spokenName(facility.airport.name),
  arp,
  elevationFt: facility.airport.field_elevation_ft,
  magneticVariationDeg: magVar,
  runways,
  taxiwayGraph: {
    nodes,
    edges,
    taxiwayPolylines,
    aprons: apronPolys,
    provenance: osmProv(
      `Taxiway/apron geometry from OSM reconciled against the FAA airport diagram ${profile.diagramPdf.replace(/\.PDF$/i, '')} (cycle ${procSrc._provenance.cycle as string}); ${wayIns.length} OSM taxiway ways planarised (shared nodes + ${CONFIG.snapM} m snapping), untagged ways named by ${labels.length ? 'continuity / diagram-label proximity' : 'continuity'}, runway holding positions derived at ${CONFIG.holdDistanceFt} ft from the centreline. Positional accuracy beyond the runway endpoints not assessed.`,
      true,
    ),
    unresolvedWayIds: unresolved.filter((d) => d.osmId !== null).map((d) => d.osmId as number),
    excludedOsmRefs,
  },
  parking,
  frequencies,
  navaids,
  procedures,
  hotSpots: hotSpot ? [hotSpot] : [],
  ...(mva ? { mvaSectors } : {}),
  towerHours: facility.tower.tower_hours,
  airspaceClass: facility.airspace.class_c ? 'C' : undefined,
  provenance: [
    nasrProv(`nasrName: ${facility.airport.name as string}. ${SLUG}-facility.json: ARP, elevation, magnetic variation ${facility.airport.magnetic_variation.deg as number} ${facility.airport.magnetic_variation.hemisphere as string} (epoch ${facility.airport.magnetic_variation.epoch_year as string}, stale), runways, remarks, tower hours, Class C flag.`),
    freqProv(`${SLUG}-frequencies.json`),
    navProv(profile.provenanceNotes.navaids),
    dtppProv('https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/', profile.provenanceNotes.procedures),
    osmProv(profile.provenanceNotes.osm, true),
    ...(mva ? [mva.provenance] : []),
    dtppProv(procSrc.airport_diagram.pdf.url as string, profile.provenanceNotes.diagramReconciliation),
  ],
  buildings,
  supportingCharts,
  remarks: (facility.remarks as J[]).map((r) => r.text as string),
  osmAttribution: '© OpenStreetMap contributors, ODbL 1.0',
  build: { script: profile.buildCommand, osmBaseTimestamp: osm.properties.osm_base_timestamp, faaCycle: `NASR ${NASR_FROM}`, dtppCycle: procSrc._provenance.cycle },
};

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string, fatal = true): void => {
  checks.push({ name, ok, detail });
  if (!ok) (fatal ? hard : warn)(`${name}: ${detail}`);
};

function components(filter: (e: KacyTaxiEdge) => boolean): Map<string, number> {
  const parent = new Map<string, string>(Object.keys(nodes).map((k) => [k, k]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const e of edges) if (filter(e)) parent.set(find(e.from), find(e.to));
  const comp = new Map<string, number>();
  const ids = new Map<string, number>();
  for (const k of Object.keys(nodes)) {
    const r = find(k);
    if (!ids.has(r)) ids.set(r, ids.size);
    comp.set(k, ids.get(r)!);
  }
  return comp;
}
const compAll = components(() => true);
const compTaxi = components((e) => e.kind !== 'runway');
const sizeOf = (comp: Map<string, number>): Map<number, number> => {
  const m = new Map<number, number>();
  for (const c of comp.values()) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
};
const taxiSizes = sizeOf(compTaxi);
const mainTaxiComp = [...taxiSizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
const allSizes = sizeOf(compAll);
const mainAllComp = [...allSizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
const holdIds = Object.values(nodes).filter((n) => n.kind === 'holding_position').map((n) => n.id);
const parkNodeIds = parking.map((p) => p.nodeId).filter(Boolean);
const strandedAll = Object.values(nodes).filter((n) => compAll.get(n.id) !== mainAllComp);
const strandedTaxi = Object.values(nodes).filter((n) => compTaxi.get(n.id) !== mainTaxiComp && n.kind !== 'runway');
check('graph connected (all edges)', strandedAll.length === 0, `${strandedAll.length} node(s) outside the main component: ${strandedAll.slice(0, 10).map((n) => n.id).join(', ')}`);
check('graph connected without runway edges (crossings count as connections)', strandedTaxi.length === 0, `${strandedTaxi.length} non-runway node(s) can only be reached via runway edges or are isolated: ${strandedTaxi.slice(0, 10).map((n) => n.id).join(', ')}`, false);
check('every holding position is in the main taxi component', holdIds.every((h) => compTaxi.get(h) === mainTaxiComp), `holds outside main component: ${holdIds.filter((h) => compTaxi.get(h) !== mainTaxiComp).join(', ')}`);
check('every connected parking is in the main taxi component', parkNodeIds.every((p) => compTaxi.get(p) === mainTaxiComp), `parking outside: ${parkNodeIds.filter((p) => compTaxi.get(p) !== mainTaxiComp).join(', ')}`);
const zero = edges.filter((e) => e.lengthM < 0.5);
check('no zero-length edges (< 0.5 m)', zero.length === 0, `${zero.length}: ${zero.slice(0, 8).map((e) => `${e.id}(${e.from}-${e.to})`).join(', ')}`);
const shortE = edges.filter((e) => e.lengthM < CONFIG.tinyEdgeM && e.kind !== 'runway');
check(`no edges shorter than ${CONFIG.tinyEdgeM} m`, shortE.length === 0, `${shortE.length}: ${shortE.slice(0, 8).map((e) => `${e.id}=${e.lengthM}m`).join(', ')}`, false);
const dupKeys = new Set<string>();
let dups = 0;
for (const e of edges) {
  const k = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
  if (dupKeys.has(k)) dups++;
  dupKeys.add(k);
}
check('no duplicate edges', dups === 0, `${dups} duplicate node pairs`);
if (mva) {
  const hit = mvaSectors.filter((m) => pointInPolygon({ x: 0, y: 0 }, m.polygon as P[]) && !m.holes.some((h) => pointInPolygon({ x: 0, y: 0 }, h as P[])));
  check('the ARP lies inside exactly one MVA sector', hit.length === 1, hit.map((m) => m.name).join(', ') || 'none');
  const badAlt = mvaSectors.filter((m) => m.polygon.length < 3 || m.altitudeFt < 1000 || m.altitudeFt > 10000);
  check('every MVA sector has >= 3 vertices and 1000-10000 ft', badAlt.length === 0, badAlt.map((m) => m.name).join(', '));
}
// runway-crossing edges carry onRunwayId
{
  const tadj = new Map<string, { other: string; e: KacyTaxiEdge }[]>();
  for (const e of edges) {
    if (e.kind !== 'taxiway' && e.kind !== 'unnamed') continue;
    for (const [x, y] of [[e.from, e.to], [e.to, e.from]]) tadj.set(x, [...(tadj.get(x) ?? []), { other: y, e }]);
  }
  const badHold: string[] = [];
  for (const h of Object.values(nodes).filter((n) => n.kind === 'holding_position')) {
    const prev = new Map<string, { from: string; e: KacyTaxiEdge | null }>([[h.id, { from: '', e: null }]]);
    const q = [h.id];
    const entryId = h.entryNodeId!;
    while (q.length && !prev.has(entryId)) {
      const x = q.shift()!;
      for (const { other, e } of tadj.get(x) ?? []) {
        if (prev.has(other)) continue;
        prev.set(other, { from: x, e });
        q.push(other);
      }
    }
    let ok = prev.has(entryId);
    for (let x = entryId; ok && x !== h.id; x = prev.get(x)!.from) ok = prev.get(x)!.e!.onRunwayId === h.runwayId;
    if (!ok) badHold.push(h.id);
  }
  check('every holding position -> entry-node path has onRunwayId === the hold runway', badHold.length === 0, badHold.join(', '));
  const unmarked = edges.filter((e) => (e.kind === 'taxiway' || e.kind === 'unnamed') && !e.onRunwayId && runways.some((r) => pointInPolygon({ x: (nodes[e.from].pos.x + nodes[e.to].pos.x) / 2, y: (nodes[e.from].pos.y + nodes[e.to].pos.y) / 2 }, r.polygon as P[])));
  check('no taxi edge with its midpoint inside a runway polygon lacks onRunwayId', unmarked.length === 0, unmarked.map((e) => e.id).join(', '));
  const rwKindEnd = edges.filter((e) => (e.kind === 'taxiway' || e.kind === 'unnamed') && !e.onRunwayId && (nodes[e.from].kind === 'runway' || nodes[e.to].kind === 'runway'));
  check('no taxi edge touching a runway-kind node lacks onRunwayId', rwKindEnd.length === 0, rwKindEnd.map((e) => e.id).join(', '));
  check('taxi edges marked onRunwayId (information)', true, `${edges.filter((e) => e.kind !== 'runway' && e.onRunwayId).length} taxi edges carry onRunwayId (hold-to-runway crossing paths); taxiway identifier kept`);
}
const selfLoops = edges.filter((e) => e.from === e.to);
check('no self-loop edges', selfLoops.length === 0, `${selfLoops.length}`);

// runway entry/exit nodes per end region (each runway split at its midpoint)
const regionCounts: { runway: string; end: string; count: number; ids: string[] }[] = [];
for (const rb of runwayBuilds) {
  const total = dist(rb.a, rb.b);
  rb.runway.ends.forEach((end, idx) => {
    const ids = Object.values(nodes)
      .filter((n) => n.kind === 'runway' && n.runwayIds?.includes(rb.runway.id) && !n.id.startsWith('THR') && n.id !== profile.crossing.nodeId)
      .filter((n) => n.taxiways.length > 0)
      .filter((n) => {
        const d = n.distFromThresholdM?.[end.id] ?? Infinity;
        return d <= total / 2 && (idx === 0 || idx === 1);
      })
      .map((n) => n.id);
    regionCounts.push({ runway: rb.runway.id, end: end.id, count: ids.length, ids });
  });
}
for (const rc of regionCounts) check(`runway ${rc.runway} end ${rc.end} half has >= 2 entry/exit nodes`, rc.count >= 2, `${rc.count}: ${rc.ids.join(', ')}`);

// holding positions
for (const rb of runwayBuilds) {
  const hs = holds.filter((h) => h.runwayId === rb.runway.id);
  check(`runway ${rb.runway.id} has holding positions`, hs.length >= 2, `${hs.length}`);
}
const holdInPoly = holdIds.filter((h) => runways.some((r) => pointInPolygon(nodes[h].pos, r.polygon as P[])));
check('no holding position lies inside a runway polygon', holdInPoly.length === 0, holdInPoly.join(', '));
const holdOff = holds.filter((h) => !h.shortStub && Math.abs(h.distFromCentrelineM - HOLD_M) > 1.5);
check(`non-stub holding positions are ${r2(HOLD_M)} m +- 1.5 m from the centreline`, holdOff.length === 0, holdOff.map((h) => `${nodeIdOf.get(h.node)!} ${r2(h.distFromCentrelineM)} m`).join(', '));
// taxi nodes inside runway polygons (other than runway nodes)
const inRunway = Object.values(nodes).filter((n) => n.kind !== 'runway' && n.kind !== 'parking' && runways.some((r) => pointInPolygon(n.pos, r.polygon as P[])));
check('taxi nodes inside a runway polygon (information)', true, `${inRunway.length}: ${inRunway.slice(0, 12).map((n) => `${n.id}[${n.taxiways.join('/')}]`).join(', ')}`);

// parking
const gatesOk = parking.filter((p) => p.category === 'airline' && p.nodeId && !p.connectorOverLimit).length;
const gaOk = parking.filter((p) => p.category === 'ga' && p.nodeId && !p.connectorOverLimit).length;
const fboOk = parking.filter((p) => p.category === 'fbo' && p.nodeId && !p.connectorOverLimit).length;
check('at least 5 airline gates usable', gatesOk >= 5, `${gatesOk}`);
check('at least 3 GA ramp spots usable', gaOk >= 3, `${gaOk}`);
check('at least 1 FBO spot usable', fboOk >= 1, `${fboOk}`);
const parkFlag = parking.filter((p) => p.connectorOverLimit);
check(`parking connectors <= ${CONFIG.parkingConnectMaxM} m`, parkFlag.length === 0, `flagged: ${parkFlag.map((p) => `${p.id} (${p.connectorLengthM} m)`).join(', ')}`, false);
const missingIds = FAA_DIAGRAM_IDS.filter((id) => !taxiwayPolylines[id]);
check(`all ${FAA_DIAGRAM_IDS.length} FAA diagram identifiers present in the graph`, missingIds.length === 0, `missing: ${missingIds.join(', ')}`, false);
for (const r of runways) {
  check(`runway ${r.id} threshold-to-threshold length within 0.5% of NASR`, Math.abs(r.lengthBetweenThresholdsFt - r.lengthFt) / r.lengthFt <= 0.005, `${r.lengthBetweenThresholdsFt} ft vs ${r.lengthFt} ft`);
  for (const e of r.ends) {
    const a = e.trueHeadingDeg;
    const other = r.ends.find((x) => x !== e)!;
    const meas = bearing(e.threshold as P, other.threshold as P);
    check(`runway end ${e.id} measured bearing within 1 deg of NASR true alignment`, angDiff(meas, a) <= 1, `measured ${meas.toFixed(2)} vs NASR ${a}`);
    check(`runway end ${e.id} charted magnetic heading equals true alignment converted with the NASR variation`, angDiff(e.magneticHeadingDeg, trueToMagnetic(a, magVar)) <= 1, `charted ${e.magneticHeadingDeg} vs ${trueToMagnetic(a, magVar)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
const osmHoldingNodes = featsOf('holding_position').filter((f: J) => f.geometry.type === 'Point');
const nodeCountByKind: Record<string, number> = {};
for (const n of Object.values(nodes)) nodeCountByKind[n.kind] = (nodeCountByKind[n.kind] ?? 0) + 1;
const edgeCountByKind: Record<string, number> = {};
for (const e of edges) edgeCountByKind[e.kind] = (edgeCountByKind[e.kind] ?? 0) + 1;
const lenByTw: Record<string, { edges: number; m: number; ways: Set<number> }> = {};
for (const e of edges) {
  if (e.kind === 'runway' || e.kind === 'apron_connector') continue;
  const k = e.taxiway || '(unnamed)';
  const r = (lenByTw[k] ??= { edges: 0, m: 0, ways: new Set() });
  r.edges++;
  r.m += e.lengthM;
  (e.osmWayIds ?? []).forEach((w) => r.ways.add(w));
}
const taxiWays = pl.ways.filter((w) => w.kind === 'taxiway');
const taggedWays = taxiWays.filter((w) => w.origRef && !excludedOsmRefs.includes(w.origRef));
const inferredWays = decisions.filter((d) => d.method === 'continuity' || d.method === 'label-proximity');
const unresolvedWays = decisions.filter((d) => d.method === 'unresolved');
const mdTable = (head: string[], rows: (string | number)[][]): string[] => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)];

const R: string[] = [];
R.push(`# ${profile.icao} airport build report`);
R.push('');
R.push(`Generated by \`${profile.buildCommand}\` (deterministic; do not edit by hand).`);
R.push('');
R.push(`- FAA data: NASR cycle ${NASR_FROM}, d-TPP cycle ${procSrc._provenance.cycle as string} (${DTPP_FROM} to ${DTPP_TO}); retrieved ${RETRIEVED}.`);
R.push(`- OSM base timestamp ${osm.properties.osm_base_timestamp as string}. ${OSM_ATTR}. The OSM-derived taxiway/apron layer is an ODbL derivative and must carry the attribution.`);
R.push(`- ARP ${arp.lat}, ${arp.lon}; field elevation ${airport.elevationFt} ft; magnetic variation ${magVar} (east-positive; ${facility.airport.magnetic_variation.deg as number} ${facility.airport.magnetic_variation.hemisphere as string}, epoch ${facility.airport.magnetic_variation.epoch_year as string} per NASR).`);
R.push('');
R.push('## Counts');
R.push('');
R.push(`- Graph nodes: **${Object.keys(nodes).length}** (${Object.entries(nodeCountByKind).map(([k, v]) => `${k} ${v}`).join(', ')})`);
R.push(`- Graph edges: **${edges.length}** (${Object.entries(edgeCountByKind).map(([k, v]) => `${k} ${v}`).join(', ')}); total taxi length ${r2(edges.filter((e) => e.kind === 'taxiway' || e.kind === 'unnamed').reduce((s, e) => s + e.lengthM, 0))} m`);
R.push(`- OSM taxiway ways: ${wayIns.length + abandonedWays.length} in the extract; ${abandonedWays.length} dropped as abandoned (${abandonedWays.map((w) => `way/${w}`).join(', ') || 'none'}); ${wayIns.length} used (tagged with a usable ref: ${taggedWays.length}; untagged: ${wayIns.filter((w) => !w.origRef).length}; OSM-only ref excluded: ${excludedOsmRefs.join(', ') || 'none'})`);
if (chainVerticesRemoved) R.push(`- Entry chains simplified: ${chainVerticesRemoved} intermediate vertices between a runway node and its hold line were removed from the routing graph so that every hold is adjacent to its runway node (the engine's rollout exit and runway entry assume this); rendered polylines lose only those vertices.`);
if (droppedFillets.length) R.push(`- Mapped turn-on fillets collapsed: ${droppedFillets.length} untagged curves (${droppedFillets.map((w) => w.key).join(', ')}) from a through taxiway to the runway centreline were dropped because the through taxiway itself reaches the runway within ${CONFIG.filletReachM} m; keeping them would add runway entries whose hold line is not adjacent to the runway node.`);
R.push(`- Identifiers inferred for untagged ways: ${inferredWays.length} (continuity ${inferredWays.filter((d) => d.method === 'continuity').length}, label proximity ${inferredWays.filter((d) => d.method === 'label-proximity').length}); left unnamed: ${unresolvedWays.length} + ${decisions.filter((d) => d.method === 'excluded').length} excluded`);
R.push(`- FAA diagram identifiers present (${FAA_DIAGRAM_IDS.join(' ')}): ${FAA_DIAGRAM_IDS.filter((i) => taxiwayPolylines[i]).length}/${FAA_DIAGRAM_IDS.length}${missingIds.length ? `; missing: ${missingIds.join(', ')}` : ''}`);
R.push(`- Runway holding positions: **${holds.length}** (all derived/approximate)`);
R.push(`- Parking positions: **${parking.length}** (${['airline', 'ga', 'fbo', 'military', 'cargo', 'other'].map((c) => `${c} ${parking.filter((p) => p.category === c).length}`).join(', ')}); OSM-sourced ${parking.filter((p) => p.source === 'osm').length}, synthetic ${parking.filter((p) => p.source === 'synthetic').length}`);
R.push(`- Aprons (OSM polygons): ${apronPolys.length}; buildings: ${buildings.length}`);
R.push(`- Frequencies ${frequencies.length}, navaids ${navaids.length} (${navaids.filter((n) => n.type === 'FIX').length} fixes), procedures ${procedures.length} (${procedures.filter((p) => p.type === 'IAP').length} IAP, ${procedures.filter((p) => p.type === 'DIAGRAM').length} diagram, ${procedures.filter((p) => p.type === 'DP').length} DP${procedures.some((p) => p.type === 'STAR') ? `, ${procedures.filter((p) => p.type === 'STAR').length} STAR` : ''})`);
R.push('');
R.push('## Validation');
R.push('');
R.push(...mdTable(['check', 'result', 'detail'], checks.map((c) => [c.name, c.ok ? 'PASS' : 'FAIL', c.ok && !/information/.test(c.name) ? '' : c.detail])));
R.push('');
R.push(hardErrors.length ? `**HARD ERRORS (${hardErrors.length}):**\n${hardErrors.map((h) => `- ${h}`).join('\n')}` : '**No hard errors.**');
R.push('');
R.push(problems.length ? `**Warnings / problems (${problems.length}):**\n${problems.map((h) => `- ${h}`).join('\n')}` : '**No warnings.**');
R.push('');
R.push('## Runways');
R.push('');
R.push(
  ...mdTable(
    ['runway', 'end', 'true hdg', 'charted mag hdg', 'threshold lat, lon', 'TDZE ft', 'ILS', 'LAHSO ALD ft (hold short of)'],
    runways.flatMap((r) => r.ends.map((e) => [r.id, e.id, e.trueHeadingDeg, e.magneticHeadingDeg, `${e.thresholdLatLon.lat}, ${e.thresholdLatLon.lon}`, e.tdzeFt ?? '', e.ils ? `${e.ils.ident} ${e.ils.frequencyMhz} (course ${e.ils.courseDeg} mag)` : 'NONE', e.lahso ? `${e.lahso.availableLandingDistanceFt} (${e.lahso.holdShortOfRunwayId})` : '-'])),
  ),
);
R.push('');
R.push(`Length between thresholds vs NASR: ${runways.map((r) => `${r.id} ${r.lengthBetweenThresholdsFt} ft vs ${r.lengthFt} ft (${(((r.lengthBetweenThresholdsFt - r.lengthFt) / r.lengthFt) * 100).toFixed(2)}%)`).join('; ')}. Runway polygons are the rectangle between the two NASR thresholds at the NASR width (${[...new Set(runways.map((r) => r.widthFt))].join('/')} ft), extended ${CONFIG.polygonExtensionM} m beyond each threshold so the thresholds are interior points.`);
R.push('');
R.push('## Runway nodes (entry / exit / crossing points)');
R.push('');
for (const rb of runwayBuilds) {
  const rn = Object.values(nodes).filter((n) => n.kind === 'runway' && n.runwayIds?.includes(rb.runway.id)).sort((a, b) => (a.distFromThresholdM?.[rb.runway.ends[0].id] ?? 0) - (b.distFromThresholdM?.[rb.runway.ends[0].id] ?? 0));
  R.push(`**Runway ${rb.runway.id}**`);
  R.push('');
  R.push(...mdTable(['node', `m from ${rb.runway.ends[0].id}`, `m from ${rb.runway.ends[1].id}`, 'taxiways'], rn.map((n) => [n.id, n.distFromThresholdM?.[rb.runway.ends[0].id] ?? '', n.distFromThresholdM?.[rb.runway.ends[1].id] ?? '', n.taxiways.join(', ') || (n.id === 'HS1-X' ? '(runway intersection, HS 1)' : '(threshold)')])));
  R.push('');
}
R.push(`End-region entry/exit counts (each runway split at its midpoint): ${regionCounts.map((c) => `${c.runway}/${c.end}: ${c.count}`).join('; ')}`);
R.push('');
R.push('## Taxiway identifiers in the graph');
R.push('');
R.push(...mdTable(['identifier', 'OSM ways', 'edges', 'length m', 'on FAA diagram'], Object.entries(lenByTw).sort().map(([k, v]) => [k, v.ways.size, v.edges, r2(v.m), FAA_DIAGRAM_IDS.includes(k) ? 'yes' : '-'])));
R.push('');
if (labels.length) {
  R.push(`Diagram labels (${labelFile.labels.length} ${profile.diagramLabelNote ?? 'words'} read from ${path.relative(ROOT, labelFile.from)}) vs the identifiers above: ${FAA_DIAGRAM_IDS.map((i) => `${i}${taxiwayPolylines[i] ? ' ok' : ' MISSING'}`).join(', ')}. ${labelFile.note}`);
} else {
  R.push(`Taxiway identifiers printed on the FAA airport diagram (${profile.diagramPdf}, read from the chart text; see ${SLUG}-procedures.json airport_diagram.taxiway_identifiers) vs the identifiers above: ${FAA_DIAGRAM_IDS.map((i) => `${i}${taxiwayPolylines[i] ? ' ok' : ' MISSING'}`).join(', ')}. No diagram label positions were georeferenced for this airport, so identifier inference uses OSM refs and continuity only.`);
}
R.push('');
R.push('## Identifier inference for untagged OSM ways');
R.push('');
R.push(`Method: (1) CONTINUITY - an untagged way whose end touches a named way and leaves within ${CONFIG.contAngleDeg} deg of a straight continuation takes that identifier (iterated, so inferred ids can propagate); ${labels.length ? `(2) LABEL PROXIMITY - the untagged way is the closest way to an FAA diagram label and within ${CONFIG.labelMaxM} m of it. ` : '(no label-proximity rule: no diagram label positions for this airport). '}Anything else stays unnamed (taxiway "", edge kind "unnamed", approximate). Tagged OSM refs are trusted except "${excludedOsmRefs.join(', ')}".`);
R.push('');
R.push(...mdTable(['way', 'result', 'method', 'detail'], decisions.map((d) => [d.key, d.ref ?? '(none)', d.method, d.detail])));
R.push('');
R.push('## Holding positions (all derived, approximate)');
R.push('');
R.push(`${osmHoldingNodes.length ? `OSM has ${osmHoldingNodes.length} \`holding_position\` nodes, but they are partial, inconsistently tagged and not tied to a runway entry, so they are NOT used as the source; they are compared with the derived lines in the table below, and` : 'OSM has no `holding_position` features and'} the FAA data gives no hold-line coordinates, so every hold line is placed ${CONFIG.holdDistanceFt} ft (${r2(HOLD_M)} m) from the runway centreline along the connecting taxiway (documented simplification for ${runways.length === 2 ? 'both runways' : 'all runways'}; real hold lines depend on aircraft design group / ILS critical area). \`protectsRunwayEnd\` is the runway end whose threshold is nearest the entry point; the farther end is listed too, since a departure entering mid-runway may use either direction.`);
R.push('');
R.push(
  ...mdTable(
    ['node', 'runway', 'taxiway', 'protects end', 'other end', 'entry m from protects-end thr', 'entry m from other thr', 'hold m from centreline', 'note'],
    holds
      .map((h) => ({ h, id: nodeIdOf.get(h.node)! }))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(({ h, id }) => [id, h.runwayId, h.taxiway || '(unnamed)', h.protectsEnd, h.otherEnd, r2(h.entryDistFromEndM), r2(h.entryDistFromOtherEndM), r2(h.distFromCentrelineM), h.shortStub ? 'short stub (<250 ft): placed at 60% of stub' : '']),
  ),
);
R.push('');
if (osmHoldingNodes.length) {
  R.push('## Derived hold lines vs OSM holding_position nodes (information only)');
  R.push('');
  R.push(`For each derived hold line, the nearest of the ${osmHoldingNodes.length} OSM \`holding_position\` nodes (tags quoted verbatim). Large distances mean OSM maps the line elsewhere or not at all; the derived 250 ft position is the one used.`);
  R.push('');
  R.push(
    ...mdTable(
      ['derived node', 'runway', 'taxiway', 'nearest OSM node', 'OSM tags', 'distance m'],
      holds
        .map((h) => ({ h, id: nodeIdOf.get(h.node)! }))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(({ h, id }) => {
          const hp = pl.pos[h.node];
          const best = osmHoldingNodes.map((f: J) => ({ f, d: dist(hp, loc(f.geometry.coordinates[1], f.geometry.coordinates[0])) })).sort((x, y) => x.d - y.d)[0];
          const t = best.f.properties.tags as Record<string, string>;
          return [id, h.runwayId, h.taxiway || '(unnamed)', `node/${best.f.properties.osm_id as number}`, Object.entries(t).filter(([k]) => k !== 'aeroway').map(([k, v]) => `${k}=${v}`).join(', ') || '(no tags)', r2(best.d)];
        }),
    ),
  );
  R.push('');
}
R.push('## Parking');
R.push('');
R.push(parkingResult.reportParagraph);
R.push('');
R.push(...mdTable(['id', 'name', 'category', 'zone', 'source', 'heading', 'connector m', 'flag'], parking.map((p) => [p.id, p.name, p.category, p.zone, p.source, p.headingDeg ?? '', p.connectorLengthM ?? '', p.connectorOverLimit ? `OVER ${CONFIG.parkingConnectMaxM} m / unconnected` : ''])));
R.push('');
if (mva) {
  R.push('## Minimum vectoring altitude sectors');
  R.push('');
  R.push(mva.reportIntro);
  R.push('');
  const ringArea = (r: Vec2[]): number => Math.abs(r.reduce((a, p, i) => a + p.x * r[(i + 1) % r.length].y - r[(i + 1) % r.length].x * p.y, 0)) / 2;
  R.push(...mdTable(['sector', 'MVA ft MSL', 'outer vertices', 'holes', 'area nm2 (outer-holes)', 'contains ARP', 'remarks'], mvaSectors.map((m) => [m.name, m.altitudeFt, m.polygon.length, m.holes.length, r2((ringArea(m.polygon as Vec2[]) - m.holes.reduce((a, h) => a + ringArea(h as Vec2[]), 0)) / 1852 ** 2), pointInPolygon({ x: 0, y: 0 }, m.polygon as P[]) && !m.holes.some((h) => pointInPolygon({ x: 0, y: 0 }, h as P[])) ? 'YES' : '', m.remarks ?? ''])));
  R.push('');
}
if (profile.fixAltitudesFile) {
  R.push(`## Published fix altitudes (plate transcriptions, data/sources/${profile.fixAltitudesFile})`);
  R.push('');
  R.push(...mdTable(['procedure', 'fix', 'min ft', 'max ft', 'mandatory ft', 'note'], procedures.filter((p) => p.type === 'IAP').flatMap((p) => (p.fixAltitudes ?? []).map((f) => [p.name, f.fix, f.minAltitudeFt ?? '', f.maxAltitudeFt ?? '', f.mandatoryAltitudeFt ?? '', (f.note ?? '').replace(/\[transcribed.*$/, '').trim()]))));
  R.push('');
}
R.push('## Approximate elements (summary)');
R.push('');
R.push('- ALL runway holding positions (derived at a fixed 250 ft; no source data).');
for (const l of parkingResult.approximateSummary) R.push(l);
R.push(`- Taxiway geometry in general: OSM centrelines, positional accuracy beyond the runway thresholds not assessed${profile.runwayEndpointNote}.`);
R.push(`- Unnamed lanes (${unresolvedWays.length} ways + ${decisions.filter((d) => d.method === 'excluded').length} excluded OSM-only ref): flagged approximate on every edge.`);
R.push('- Runway-to-taxiway connection nodes: OSM ways end on the runway centreline (within 1.5 m of it), which this build snaps exactly onto the centreline; real fillets/entrances are wider.');
R.push(`- Vertices within ${CONFIG.snapM} m of another way were merged / snapped; edges shorter than ${CONFIG.tinyEdgeM} m were contracted.`);
R.push(labels.length ? '- Taxiway names inferred for untagged ways (table above) and the diagram-label georeferencing (a few pixels, ~10 m).' : '- Taxiway names inferred for untagged ways by continuity (table above); no diagram label georeferencing for this airport.');
for (const l of profile.extraApproximate ?? []) R.push(l);
R.push('');
R.push(DIAGRAM_COMPARISON_NOTES());
R.push('');
function DIAGRAM_COMPARISON_NOTES(): string {
  const p = path.join(HERE, 'data', profile.diagramComparisonFile ?? '');
  return profile.diagramComparisonFile && fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trimEnd() : '## Comparison with the FAA airport diagram\n\n(no comparison notes file found)';
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------
if (process.env.DEBUG_NODE) {
  for (const id of process.env.DEBUG_NODE.split(',')) {
    console.log(id, JSON.stringify(nodes[id]), edges.filter((e) => e.from === id || e.to === id));
  }
}
fs.mkdirSync(OUT, { recursive: true });
const svg = renderDebugSvg(
  airport,
  labels.map((l) => ({ id: l.id, x: l.p.x, y: l.p.y })),
);
fs.writeFileSync(path.join(OUT, 'build-report.md'), R.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'debug-graph.svg'), svg);
if (hardErrors.length) {
  console.error(`BUILD FAILED with ${hardErrors.length} hard error(s):\n${hardErrors.map((h) => ` - ${h}`).join('\n')}`);
  console.error(`(report written to ${path.relative(ROOT, path.join(OUT, 'build-report.md'))} for diagnosis; ${SLUG}.airport.json NOT written)`);
  process.exit(1);
}
fs.writeFileSync(path.join(OUT, `${SLUG}.airport.json`), JSON.stringify(airport) + '\n');
console.log(`${profile.icao} build OK: ${Object.keys(nodes).length} nodes, ${edges.length} edges, ${holds.length} holding positions, ${parking.length} parking, ${problems.length} warning(s)`);
for (const w of problems) console.log(`  warn: ${w}`);
