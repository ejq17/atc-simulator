/**
 * Convert a raw Overpass `out geom;` response into the GeoJSON layout the airport build reads
 * (data/sources/<icao>-taxiways.geojson).
 *
 *   npx tsx scripts/osm-overpass-to-geojson.ts <raw.json> <out.geojson> <retrieved YYYY-MM-DD> <lat> <lon> [radiusM=2000]
 *
 * Closed ways of area-type aeroway features (apron, terminal, hangar, helipad, aerodrome) become Polygons, other ways
 * LineStrings, nodes Points. Tags are copied verbatim; nothing is edited, filtered or corrected. The Overpass query shape is the
 * one documented in data/sources/README.md (aeroway features within radiusM of the NASR ARP). The result is OSM data under
 * ODbL 1.0, (c) OpenStreetMap contributors.
 */
import fs from 'node:fs';

const [, , rawPath, outPath, retrieved, latArg, lonArg, radiusArg] = process.argv;
if (!rawPath || !outPath || !retrieved || !latArg || !lonArg) {
  console.error('usage: osm-overpass-to-geojson.ts <raw.json> <out.geojson> <retrieved> <lat> <lon> [radiusM]');
  process.exit(2);
}
const radius = radiusArg ?? '2000';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const raw: J = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
const AREA = new Set(['apron', 'terminal', 'hangar', 'helipad', 'aerodrome']);

const features: J[] = [];
for (const el of raw.elements as J[]) {
  const tags: Record<string, string> = el.tags ?? {};
  const aeroway = tags.aeroway;
  if (!aeroway) continue;
  let geometry: J;
  if (el.type === 'node') geometry = { type: 'Point', coordinates: [el.lon, el.lat] };
  else if (el.type === 'way' && Array.isArray(el.geometry)) {
    const pts: [number, number][] = el.geometry.map((g: J) => [g.lon, g.lat]);
    const closed = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
    geometry = closed && AREA.has(aeroway) ? { type: 'Polygon', coordinates: [pts] } : { type: 'LineString', coordinates: pts };
  } else continue; // relations are not present in this query's result for the airports built so far
  features.push({
    type: 'Feature',
    id: `${el.type as string}/${el.id as number}`,
    properties: { osm_type: el.type, osm_id: el.id, aeroway, ref: tags.ref ?? null, name: tags.name ?? null, tags },
    geometry,
  });
}
const out = {
  type: 'FeatureCollection',
  properties: {
    source: 'OpenStreetMap via Overpass API (https://overpass-api.de/api/interpreter)',
    osm_base_timestamp: raw.osm3s.timestamp_osm_base,
    retrieved,
    query: `nwr["aeroway"~"^(runway|taxiway|apron|parking_position|holding_position|helipad|terminal|gate|taxilane|aerodrome|hangar|stopway|navigationaid|windsock)$"](around:${radius},${latArg},${lonArg}); out geom;`,
    license: 'ODbL 1.0 - (c) OpenStreetMap contributors - https://www.openstreetmap.org/copyright',
  },
  features,
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n');
console.log(`${features.length} features -> ${outPath}`);
