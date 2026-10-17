/**
 * FAA airport-diagram label positions for taxiway identifiers.
 *
 * Source: pdftotext -bbox output of 00669AD.PDF (data/sources/raw/dtpp_2610_txt/00669AD_bbox.html),
 * single-letter words A B C D G H J K L M N P with their bounding boxes in PDF points.
 * The diagram is printed rotated 90 degrees counter-clockwise (north points left, east points up).
 * Georeferencing uses the diagram graticule measured on the rendered AD-1.png
 * (rendered at 1184 px / 387.36 pt = 3.0563 px per pt):
 *   vertical rule x = 91 px  -> 39 deg 28' N,   x = 898 px -> 39 deg 27' N
 *   horizontal rule y = 525.5 px -> 74 deg 34' W, y = 1152 px -> 74 deg 35' W
 * so latitude = 39.45 + (898 - x) / (807 * 60), longitude = -74.566667 - (y - 525.5) / (626.5 * 60).
 * Residual alignment against the NASR runway thresholds is a few pixels (~10 m).
 *
 * The raw/ directory is git-ignored, so the parsed result is cached in
 * scripts/data/kacy-diagram-labels.json and reused when the raw file is absent.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface RawLabel {
  id: string;
  ptX: number;
  ptY: number;
  lat: number;
  lon: number;
}

const PX_PER_PT = 1184 / 387.36;
const IDS = new Set(['A', 'B', 'C', 'D', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P']);

export function pxToLatLon(x: number, y: number): { lat: number; lon: number } {
  return { lat: 39.45 + (898 - x) / (807 * 60), lon: -74.566667 - (y - 525.5) / (626.5 * 60) };
}

export function latLonToPx(lat: number, lon: number): { x: number; y: number } {
  return { x: 898 - (lat - 39.45) * 60 * 807, y: 525.5 + (-74.566667 - lon) * 60 * 626.5 };
}

export function loadDiagramLabels(rawBbox: string, cachePath: string): { labels: RawLabel[]; from: string } {
  if (fs.existsSync(rawBbox)) {
    const html = fs.readFileSync(rawBbox, 'utf8');
    const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
    const labels: RawLabel[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      if (!IDS.has(m[5])) continue;
      const ptX = (parseFloat(m[1]) + parseFloat(m[3])) / 2;
      const ptY = (parseFloat(m[2]) + parseFloat(m[4])) / 2;
      const { lat, lon } = pxToLatLon(ptX * PX_PER_PT, ptY * PX_PER_PT);
      labels.push({ id: m[5], ptX: +ptX.toFixed(2), ptY: +ptY.toFixed(2), lat: +lat.toFixed(7), lon: +lon.toFixed(7) });
    }
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ source: 'data/sources/raw/dtpp_2610_txt/00669AD_bbox.html (pdftotext -bbox of FAA 00669AD.PDF, cycle 2610)', labels }, null, 1) + '\n');
    return { labels, from: rawBbox };
  }
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { labels: RawLabel[] };
  return { labels: cached.labels, from: cachePath };
}
