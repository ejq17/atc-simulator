/**
 * Minimum Vectoring Altitude sectors for the Atlantic City TRACON (ACY).
 *
 * Source: FAA MVA/MIA digital product,
 *   https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/mva_mia/mva/
 * files https://aeronav.faa.gov/MVA_Charts/{pdf,aixm,kmz}/ACY_MVA_FUS3.{pdf,xml,kml}
 * (FUS5 variants are published alongside; chart id ACY_MVA_FUS3_2025). The KML carries the
 * sector polygons (outer ring + inner "hole" rings where another sector lies inside) and each
 * sector's altitude in feet MSL in the Placemark <Snippet>. The raw/ directory is git-ignored,
 * so the extraction is cached in data/sources/kacy-mva.json and reused when the KML is absent.
 */
import fs from 'node:fs';

export interface MvaSectorSrc {
  id: string;
  altitudeFt: number;
  remarks: string;
  controllingObstruction?: string;
  /** [lon, lat] vertices, closing duplicate removed. */
  outer: [number, number][];
  holes: [number, number][][];
}

const ring = (coords: string): [number, number][] => {
  const pts = coords
    .trim()
    .split(/\s+/)
    .map((p) => p.split(',').slice(0, 2).map(Number) as [number, number]);
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  return pts.map(([lon, lat]) => [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]);
};

export function parseMvaKml(kml: string): MvaSectorSrc[] {
  const out: MvaSectorSrc[] = [];
  const obstructions = new Map<string, string>();
  for (const blk of kml.split('<Placemark').slice(1)) {
    const id = /id="([^"]*)"/.exec(blk)![1];
    if (/ Ctrl_Obs$|_Ctrl_Obs$/.test(id) || id.endsWith('Ctrl_Obs')) {
      const m = /Controlling Obstruction:[^<]*/.exec(blk);
      if (m) obstructions.set(id.split(' ')[0], m[0].replace(/\s+/g, ' ').trim());
    }
  }
  for (const blk of kml.split('<Placemark').slice(1)) {
    const id = /id="([^"]*)"/.exec(blk)![1];
    if (id.includes(' ')) continue; // "A buffer", "A Ctrl_Obs"
    const alt = /<Snippet[^>]*>(\d+)ft<\/Snippet>/.exec(blk);
    const outer = /<outerBoundaryIs>[\s\S]*?<coordinates>([^<]*)<\/coordinates>/.exec(blk);
    if (!alt || !outer) continue;
    const holes = [...blk.matchAll(/<innerBoundaryIs>[\s\S]*?<coordinates>([^<]*)<\/coordinates>/g)].map((m) => ring(m[1]));
    const remarksM = /<td style='vertical-align:text-top;'>Remarks:<\/td><td>([^<]*)<\/td>/.exec(blk);
    out.push({
      id,
      altitudeFt: parseInt(alt[1], 10),
      remarks: (remarksM?.[1] ?? '').trim(),
      ...(obstructions.has(id) ? { controllingObstruction: obstructions.get(id) } : {}),
      outer: ring(outer[1]),
      holes,
    });
  }
  return out;
}

export function loadMva(rawKml: string, cachePath: string, meta: Record<string, unknown>): { sectors: MvaSectorSrc[]; meta: Record<string, unknown> } {
  if (fs.existsSync(rawKml)) {
    const sectors = parseMvaKml(fs.readFileSync(rawKml, 'utf8'));
    fs.writeFileSync(cachePath, JSON.stringify({ _provenance: meta, sectors }, null, 0).replace(/\},\{"id"/g, '},\n{"id"') + '\n');
    return { sectors, meta };
  }
  const c = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { _provenance: Record<string, unknown>; sectors: MvaSectorSrc[] };
  return { sectors: c.sectors, meta: c._provenance };
}
