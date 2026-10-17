/** Debug rendering of the built KACY graph, north up (x east, y north; SVG y flipped). */
import type { KacyAirport } from '../../src/airport/types.ts';

const PALETTE: Record<string, string> = {
  A: '#e6194b',
  B: '#3cb44b',
  C: '#4363d8',
  D: '#f58231',
  G: '#911eb4',
  H: '#008080',
  J: '#9a6324',
  K: '#800000',
  L: '#808000',
  M: '#000075',
  N: '#e6beff',
  P: '#fa8072',
};
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function renderDebugSvg(ap: KacyAirport, diagramLabels: { id: string; x: number; y: number }[]): string {
  const g = ap.taxiwayGraph;
  const nodes = Object.values(g.nodes);
  const xs = nodes.map((n) => n.pos.x);
  const ys = nodes.map((n) => n.pos.y);
  const pad = 120;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  const W = maxX - minX;
  const H = maxY - minY;
  const X = (x: number): string => (x - minX).toFixed(1);
  const Y = (y: number): string => (maxY - y).toFixed(1);
  const pts = (poly: { x: number; y: number }[]): string => poly.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ');
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" width="${Math.round(W * 0.6)}" height="${Math.round(H * 0.6)}" font-family="Helvetica, Arial, sans-serif">`);
  out.push(`<title>KACY taxiway graph (debug) - north up. Source: FAA NASR/d-TPP + OpenStreetMap (c) OpenStreetMap contributors, ODbL 1.0</title>`);
  out.push(`<rect width="100%" height="100%" fill="#fbfbf8"/>`);
  // grid every 500 m
  for (let gx = Math.ceil(minX / 500) * 500; gx < maxX; gx += 500) out.push(`<line x1="${X(gx)}" y1="0" x2="${X(gx)}" y2="${H}" stroke="#e6e6e0" stroke-width="1.5"/>`);
  for (let gy = Math.ceil(minY / 500) * 500; gy < maxY; gy += 500) out.push(`<line x1="0" y1="${Y(gy)}" x2="${W}" y2="${Y(gy)}" stroke="#e6e6e0" stroke-width="1.5"/>`);
  out.push(`<text x="10" y="${H - 12}" font-size="22" fill="#888">grid 500 m; ARP at (${X(0)}, ${Y(0)}); north up</text>`);
  // aprons and buildings
  for (const a of g.aprons) out.push(`<polygon points="${pts(a)}" fill="#dcdcd6" stroke="#b8b8b0" stroke-width="1"/>`);
  for (const b of ap.buildings) out.push(`<polygon points="${pts(b.polygon)}" fill="${b.kind === 'terminal' ? '#8a8a84' : b.kind === 'helipad' ? '#c9d9e8' : '#9a9a94'}" stroke="#666" stroke-width="0.8"/>`);
  // runways
  for (const r of ap.runways) {
    out.push(`<polygon points="${pts(r.polygon)}" fill="#2b2b2b"/>`);
    out.push(`<line x1="${X(r.ends[0].threshold.x)}" y1="${Y(r.ends[0].threshold.y)}" x2="${X(r.ends[1].threshold.x)}" y2="${Y(r.ends[1].threshold.y)}" stroke="#fff" stroke-width="2" stroke-dasharray="30 24"/>`);
    for (const e of r.ends) {
      out.push(`<text x="${X(e.threshold.x)}" y="${Y(e.threshold.y)}" font-size="34" font-weight="700" fill="#111" stroke="#fff" stroke-width="5" paint-order="stroke" text-anchor="middle" dy="-14">${esc(e.id.padStart(2, '0'))}</text>`);
      out.push(`<circle cx="${X(e.threshold.x)}" cy="${Y(e.threshold.y)}" r="6" fill="#ffd400" stroke="#000" stroke-width="1"/>`);
    }
  }
  // taxiway polylines
  const nodeById = g.nodes;
  for (const [id, lines] of Object.entries(g.taxiwayPolylines)) {
    const col = PALETTE[id] ?? '#8a8a8a';
    for (const l of lines) {
      out.push(`<polyline points="${pts(l)}" fill="none" stroke="${col}" stroke-width="${id === 'UNNAMED' ? 3 : 5}" stroke-linejoin="round" stroke-linecap="round" ${id === 'UNNAMED' ? 'stroke-dasharray="8 6" opacity="0.9"' : 'opacity="0.9"'}/>`);
    }
  }
  // apron connectors
  for (const e of g.edges) {
    if (e.kind !== 'apron_connector') continue;
    const a = nodeById[e.from].pos;
    const b = nodeById[e.to].pos;
    out.push(`<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" stroke="#2a7ab0" stroke-width="2" stroke-dasharray="4 4"/>`);
  }
  // identifier labels (one per way polyline, at the middle vertex)
  for (const [id, lines] of Object.entries(g.taxiwayPolylines)) {
    if (id === 'UNNAMED') continue;
    const col = PALETTE[id] ?? '#444';
    for (const l of lines) {
      let total = 0;
      for (let i = 1; i < l.length; i++) total += Math.hypot(l[i].x - l[i - 1].x, l[i].y - l[i - 1].y);
      if (total < 45) continue;
      let acc = 0;
      let mid = l[0];
      for (let i = 1; i < l.length; i++) {
        const seg = Math.hypot(l[i].x - l[i - 1].x, l[i].y - l[i - 1].y);
        if (acc + seg >= total / 2) {
          const t = (total / 2 - acc) / seg;
          mid = { x: l[i - 1].x + (l[i].x - l[i - 1].x) * t, y: l[i - 1].y + (l[i].y - l[i - 1].y) * t };
          break;
        }
        acc += seg;
      }
      out.push(`<text x="${X(mid.x)}" y="${Y(mid.y)}" font-size="30" font-weight="700" fill="${col}" stroke="#fff" stroke-width="5" paint-order="stroke" text-anchor="middle" dy="10">${esc(id)}</text>`);
    }
  }
  // FAA diagram labels (for comparison)
  for (const l of diagramLabels) {
    out.push(`<text x="${X(l.x)}" y="${Y(l.y)}" font-size="22" fill="#7a00b8" text-anchor="middle" dy="8" opacity="0.8">[${esc(l.id)}]</text>`);
  }
  // runway nodes
  for (const n of nodes) {
    if (n.kind === 'runway') out.push(`<circle cx="${X(n.pos.x)}" cy="${Y(n.pos.y)}" r="5" fill="#fff" stroke="#000" stroke-width="1.5"/>`);
  }
  // holding positions: red tick perpendicular to the taxi edge, pointing at the runway
  for (const n of nodes) {
    if (n.kind !== 'holding_position') continue;
    const entry = n.entryNodeId ? nodeById[n.entryNodeId] : undefined;
    let ux = 1;
    let uy = 0;
    if (entry) {
      const dx = entry.pos.x - n.pos.x;
      const dy = entry.pos.y - n.pos.y;
      const l = Math.hypot(dx, dy) || 1;
      ux = dx / l;
      uy = dy / l;
    }
    const px = -uy * 20;
    const py = ux * 20;
    out.push(`<line x1="${X(n.pos.x - px)}" y1="${Y(n.pos.y - py)}" x2="${X(n.pos.x + px)}" y2="${Y(n.pos.y + py)}" stroke="#e00000" stroke-width="6"/>`);
  }
  // parking
  const catCol: Record<string, string> = { airline: '#0057b8', ga: '#00a651', fbo: '#f39200', military: '#6d4c41', cargo: '#8e24aa', other: '#666' };
  for (const p of ap.parking) {
    out.push(`<circle cx="${X(p.pos.x)}" cy="${Y(p.pos.y)}" r="${p.category === 'airline' ? 7 : 6}" fill="${catCol[p.category] ?? '#666'}" stroke="#fff" stroke-width="1.5"${(p as { approximate?: boolean }).approximate ? ' stroke-dasharray="3 2"' : ''}/>`);
    if (p.category === 'airline') out.push(`<text x="${X(p.pos.x)}" y="${Y(p.pos.y)}" font-size="18" fill="#0057b8" dx="9" dy="-6">${esc(p.name.replace('Gate ', ''))}</text>`);
  }
  // HS 1
  const hs = ap.hotSpots[0]?.pos;
  if (hs) {
    out.push(`<ellipse cx="${X(hs.x)}" cy="${Y(hs.y)}" rx="130" ry="95" transform="rotate(-27 ${X(hs.x)} ${Y(hs.y)})" fill="none" stroke="#b35900" stroke-width="5"/>`);
    out.push(`<text x="${X(hs.x)}" y="${Y(hs.y)}" font-size="30" font-weight="700" fill="#b35900" stroke="#fff" stroke-width="5" paint-order="stroke" dx="120" dy="-90">HS 1</text>`);
  }
  // legend
  out.push(`<g font-size="22"><rect x="10" y="10" width="360" height="150" fill="#fff" stroke="#999" opacity="0.92"/>`);
  out.push(`<text x="20" y="38" font-weight="700">KACY debug graph (north up)</text>`);
  out.push(`<line x1="20" y1="58" x2="60" y2="58" stroke="#e00000" stroke-width="6"/><text x="70" y="65">holding position (derived)</text>`);
  out.push(`<circle cx="40" cy="86" r="7" fill="#0057b8"/><text x="70" y="93">parking (dashed ring = synthetic)</text>`);
  out.push(`<line x1="20" y1="112" x2="60" y2="112" stroke="#888" stroke-width="3" stroke-dasharray="8 6"/><text x="70" y="119">unnamed lane</text>`);
  out.push(`<text x="20" y="146" fill="#7a00b8">[X] = FAA diagram label position</text></g>`);
  out.push('</svg>');
  return out.join('\n') + '\n';
}
