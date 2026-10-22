import { useEffect, useMemo, useState } from 'react';
import { cycleFor, listChartGroups, type ChartEntry } from './chartIndex';

export interface LinkOnlyChartsProps {
  icao: string;
  initialChartId?: string;
  onChartChange?: (chart: ChartEntry) => void;
  className?: string;
}

/**
 * Chart list for an airport whose charts are copyrighted and therefore only LINKED (EGLL: UK AIP, (c) NATS Limited; see
 * data/sources/README.md). Nothing is fetched, rendered or cached here: each entry is a link to the official eAIP PDF.
 */
export function LinkOnlyCharts({ icao, initialChartId, onChartChange, className = '' }: LinkOnlyChartsProps) {
  const groups = useMemo(() => listChartGroups(icao), [icao]);
  const charts = useMemo(() => groups.flatMap((g) => g.charts), [groups]);
  const [selectedId, setSelectedId] = useState<string>(() => (charts.find((c) => c.id === initialChartId) ?? charts[0]).id);
  const chart = charts.find((c) => c.id === selectedId) ?? charts[0];
  const cycle = cycleFor(icao);
  useEffect(() => {
    onChartChange?.(chart);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notify on selection only
  }, [chart.id]);
  return (
    <section aria-label="UK AIP chart links" className={`flex h-full min-h-0 w-full overflow-hidden border border-atc-border bg-atc-bg text-atc-text ${className}`}>
      <nav aria-label={`${icao} charts`} className="flex w-72 shrink-0 flex-col border-r border-atc-border bg-atc-panel">
        <div className="border-b border-atc-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-atc-muted">{icao} charts</div>
          <div className="mt-0.5 text-[11px] text-atc-cyan">{cycle.label} - {charts.length} charts</div>
        </div>
        <ul role="listbox" aria-label="Charts" className="min-h-0 flex-1 overflow-y-auto">
          {groups.map((g) => (
            <li key={g.id} role="presentation">
              <div className="sticky top-0 z-10 border-y border-atc-border bg-atc-panel-2 px-3 py-1 text-[10px] uppercase tracking-[0.15em] text-atc-muted">{g.label}</div>
              <ul role="group" aria-label={g.label}>
                {g.charts.map((c) => (
                  <li
                    key={c.id}
                    role="option"
                    aria-selected={c.id === selectedId}
                    onClick={() => setSelectedId(c.id)}
                    className={`cursor-pointer border-l-2 px-3 py-1.5 text-xs leading-snug ${c.id === selectedId ? 'border-atc-green bg-atc-panel-2 text-atc-green' : 'border-transparent text-atc-text hover:bg-atc-panel-2'}`}
                  >
                    {c.name}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <div className="border-t border-atc-border px-3 py-1.5 text-[10px] leading-snug text-atc-muted">Reference only - not for navigation.</div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold tracking-wide text-atc-text" data-testid="chart-title">{chart.name}</h2>
          <span className="shrink-0 rounded-sm border border-atc-green-dim px-1.5 text-[10px] uppercase tracking-wider text-atc-green">Official UK AIP</span>
        </div>
        <p className="text-[11px] text-atc-muted" data-testid="chart-cycle">{cycle.label}</p>
        {chart.note && <p className="text-[11px] text-atc-amber">{chart.note}</p>}
        <p className="text-xs leading-relaxed text-atc-text">
          The UK AIP charts are copyright NATS Limited and are not bundled with this site. The link opens the official eAIP chart on the NATS AIS server (nats.aero/ais); the
          path changes with every AIRAC cycle, so after {cycle.effectiveTo} use the AIP page of the NATS AIS website to reach the current edition.
        </p>
        <div className="flex flex-wrap gap-4">
          <a href={chart.pdfUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-atc-cyan underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-atc-cyan">
            Open official chart ({chart.pdfName}) {'↗'}
          </a>
          <a href="https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/AIP/" target="_blank" rel="noopener noreferrer" className="text-xs text-atc-cyan underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-atc-cyan">
            UK AIP (NATS AIS) {'↗'}
          </a>
        </div>
      </div>
    </section>
  );
}
