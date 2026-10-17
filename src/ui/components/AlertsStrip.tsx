import { useSimState, useSimStore } from '../store/simStore';
import { formatRef, refsForAlert } from '../references';
import { formatElapsed } from '../lib/format';

export function AlertsStrip() {
  const state = useSimState();
  const select = useSimStore((s) => s.selectAircraft);
  if (!state) return null;
  const alerts = [...state.conflicts].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
  const critical = alerts.some((a) => a.severity === 'critical');
  return (
    <div
      data-testid="alerts-strip"
      role="status"
      aria-live="polite"
      className={`flex h-9 shrink-0 items-center gap-3 overflow-x-auto border-y px-3 ${critical ? 'border-atc-red/80 bg-atc-red/10' : alerts.length ? 'border-atc-amber/60 bg-atc-amber/10' : 'border-atc-border bg-atc-panel'}`}
    >
      <span className={`shrink-0 font-sans text-[10px] font-semibold uppercase tracking-[0.18em] ${critical ? 'text-atc-red' : alerts.length ? 'text-atc-amber' : 'text-atc-muted'}`}>
        Alerts
      </span>
      {alerts.length === 0 && (
        <span className="flex items-center gap-1.5 text-[11.5px] text-atc-muted"><span className="inline-block h-1.5 w-1.5 bg-atc-green" />No conflicts. Runways and taxiways clear of incursions.</span>
      )}
      {alerts.map((a) => (
        <span key={a.id} data-testid="alert" title={refsForAlert(a.kind).map(formatRef).join('\n')} className={`flex shrink-0 items-center gap-2 border px-2 py-0.5 text-[11.5px] ${a.severity === 'critical' ? 'atc-blink border-atc-red text-atc-red' : 'border-atc-amber/70 text-atc-amber'}`}>
          <b className="font-sans text-[10px] uppercase tracking-wider">{a.kind.replace(/_/g, ' ')}</b>
          <span className="text-atc-text">{a.text}</span>
          {a.aircraftIds.map((id) => {
            const ac = state.aircraft[id];
            return (
              <button key={id} type="button" disabled={!ac} onClick={() => select(id)} className="font-semibold underline decoration-dotted underline-offset-2 hover:text-atc-cyan">
                {ac?.callsign ?? id}
              </button>
            );
          })}
          <span className="text-[10px] text-atc-muted">{formatElapsed(a.sinceSec).slice(3)}</span>
        </span>
      ))}
    </div>
  );
}
