import type { SimulationState } from '../../sim/types';
import { airportStatus, closureLines } from '../lib/airportStatus';

/** One line per active closure ("Runway 4/22 closed, 6 min"): the flight strips show this above the bays. */
export function ClosureBar({ state }: { state: Pick<SimulationState, 'ops' | 'clock'> }) {
  const lines = closureLines(state);
  if (!lines.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-atc-amber/50 bg-atc-amber/10 px-3 py-1 font-sans text-[10.5px] text-atc-amber" data-testid="closure-bar" role="status">
      <span className="font-semibold uppercase tracking-wider">NOTAM</span>
      {lines.map((c) => (
        <span key={c.id} data-testid={`closure-${c.kind.toLowerCase()}-${c.ident}`}>
          {c.text}{c.minutesLeft !== undefined ? `, about ${c.minutesLeft} min` : ''}
        </span>
      ))}
    </div>
  );
}

/** Airport state block of the Weather and runways panel. */
export function AirportStatusBlock({ state }: { state: SimulationState }) {
  const s = airportStatus(state);
  const rows: [string, string | undefined][] = [
    ['Runway surface', s.runwayCondition],
    ['Braking action', s.braking],
    ['RVR', s.rvr],
    ['Lights', s.lights],
    ['Birds', s.birds],
  ];
  return (
    <section className="flex flex-col gap-1 border-t border-atc-border pt-4" data-testid="airport-status">
      <span className="font-sans text-[10px] uppercase tracking-[0.16em] text-atc-muted">Airport conditions</span>
      {s.closures.length === 0 && <div className="text-[12px] text-atc-muted" data-testid="no-closures">No closures.</div>}
      {s.closures.map((c) => (
        <div key={c.id} className="text-[12px] text-atc-amber" data-testid={`status-closure-${c.kind.toLowerCase()}-${c.ident}`}>
          {c.text}{c.minutesLeft !== undefined ? ` for about ${c.minutesLeft} more min` : ' for the session'} <span className="text-atc-muted">({c.reason})</span>
        </div>
      ))}
      {rows.filter(([, v]) => v).map(([k, v]) => (
        <div key={k} className="text-[12px]"><span className="text-atc-muted">{k}: </span>{v}</div>
      ))}
    </section>
  );
}
