import { useMemo } from 'react';
import type { Airport } from '../../sim/types';
import { buildSurfaceStatic } from '../display/surfaceStatic';

/** Decorative-but-true plan view for the setup header, drawn from the real taxiway and runway geometry. */
export function AirportGlyph({ airport, className = '' }: { airport: Airport; className?: string }) {
  const { paths, runways, viewBox } = useMemo(() => {
    const b = buildSurfaceStatic(airport).bounds;
    const pad = 120;
    const w = b.maxX - b.minX + pad * 2;
    const h = b.maxY - b.minY + pad * 2;
    const X = (x: number) => (x - b.minX + pad).toFixed(1);
    const Y = (y: number) => (b.maxY - y + pad).toFixed(1);
    const paths: string[] = [];
    for (const [name, lines] of Object.entries(airport.taxiwayGraph.taxiwayPolylines)) {
      if (name === 'UNNAMED') continue;
      for (const l of lines) paths.push(l.map((p, i) => `${i ? 'L' : 'M'}${X(p.x)} ${Y(p.y)}`).join(''));
    }
    const runways = airport.runways.map((r) => r.polygon.map((p, i) => `${i ? 'L' : 'M'}${X(p.x)} ${Y(p.y)}`).join('') + 'Z');
    return { paths, runways, viewBox: `0 0 ${w.toFixed(0)} ${h.toFixed(0)}` };
  }, [airport]);
  return (
    <svg viewBox={viewBox} className={className} role="img" aria-label={`${airport.icao} runway and taxiway layout`}>
      {paths.map((d, i) => (<path key={i} d={d} fill="none" stroke="#2c3946" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />))}
      {runways.map((d, i) => (<path key={i} d={d} fill="#1f272e" stroke="#39c5e8" strokeWidth="9" strokeLinejoin="round" />))}
    </svg>
  );
}
