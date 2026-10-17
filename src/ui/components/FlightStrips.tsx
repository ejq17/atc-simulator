import { useMemo } from 'react';
import type { Aircraft, ControllerPositionId, SimulationState } from '../../sim/types';
import { sameFrequency } from '../../radio/frequencies';
import { controllerFrequencies } from '../commands/transmit';
import { useSimState, useSimStore } from '../store/simStore';
import { TONE_COLOR, formatMhz, phaseLabel, statusTone } from '../lib/format';
import { ifrClearanceSummary, navLetter, requestBadge, stripClearance } from '../lib/ifr';
import { Panel } from './ui';

const POSITION_RANK: Record<string, number> = { CLNC: 0, GND: 1, TWR: 2, APP: 3, DEP: 4 };

export interface StripGroup {
  mhz: number;
  /** "CLNC", "APP/DEP" ... from the airport data; "OTHER" when the aircraft is on an unknown frequency. */
  label: string;
  rank: number;
  aircraft: Aircraft[];
}

/** Aircraft grouped by their current frequency, groups ordered CLNC, GND, TWR, APP/DEP; requests first inside a group. */
export function groupByFrequency(state: Pick<SimulationState, 'airport'>, list: readonly Aircraft[]): StripGroup[] {
  const groups: StripGroup[] = [];
  for (const ac of list) {
    let g = groups.find((x) => sameFrequency(x.mhz, ac.frequencyMhz));
    if (!g) {
      const ids = state.airport.frequencies.filter((f) => sameFrequency(f.mhz, ac.frequencyMhz));
      const positions = [...new Set(ids.map((f) => f.position).filter((p): p is ControllerPositionId => p in POSITION_RANK))];
      const label = positions.length ? positions.join('/') : (ids[0]?.id ?? 'OTHER');
      g = { mhz: ac.frequencyMhz, label, rank: positions.length ? Math.min(...positions.map((p) => POSITION_RANK[p])) : 9, aircraft: [] };
      groups.push(g);
    }
    g.aircraft.push(ac);
  }
  for (const g of groups) {
    g.aircraft.sort((a, b) => (a.pendingRequest ? 0 : 1) - (b.pendingRequest ? 0 : 1) || a.callsign.localeCompare(b.callsign));
  }
  return groups.sort((a, b) => a.rank - b.rank || a.mhz - b.mhz);
}

function Strip({ state, ac, selected, mine, onSelect }: { state: SimulationState; ac: Aircraft; selected: boolean; mine: boolean; onSelect: () => void }) {
  const tone = statusTone(ac);
  const ic = ac.flightPlan?.ifrClearance;
  const clr = stripClearance(state, ac);
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`fps-${ac.callsign}`}
      aria-pressed={selected}
      className={`relative flex w-full flex-col gap-0.5 border-b border-atc-border/70 py-1.5 pl-3.5 pr-2.5 text-left transition-colors ${selected ? 'bg-atc-cyan/10' : 'hover:bg-atc-panel-2'} ${mine ? '' : 'opacity-60'}`}
    >
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: TONE_COLOR[tone] }} />
      <span className="flex items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <span className={`text-[13px] font-semibold ${selected ? 'text-atc-cyan' : 'text-atc-text'}`}>{ac.callsign}</span>
          <span className="text-[10.5px] text-atc-muted">{ac.type}</span>
          <span className={`border px-1 text-[9.5px] font-semibold leading-4 ${ac.flightRules === 'IFR' ? 'border-atc-cyan/60 text-atc-cyan' : 'border-atc-border text-atc-muted'}`}>{ac.flightRules}</span>
        </span>
        <span className="text-[11px] tabular-nums text-atc-text">{ac.squawk ?? <span className="text-atc-muted/60">----</span>}</span>
      </span>
      <span className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-atc-muted">
          {ac.origin} → {ac.destination}
          {ac.assignedRunwayEnd && <> · RWY <b className="text-atc-text">{ac.assignedRunwayEnd}</b></>}
          {navLetter(ac) && <> · <b className="text-atc-text">{navLetter(ac)}</b></>}
        </span>
        {ac.pendingRequest ? (
          <span className="atc-blink shrink-0 border border-atc-amber/70 px-1 text-[9.5px] font-semibold uppercase leading-4 tracking-wider text-atc-amber" title={ac.pendingRequest.text}>
            {requestBadge(ac.pendingRequest.kind)}
          </span>
        ) : (
          <span className="shrink-0 font-semibold" style={{ color: TONE_COLOR[tone] }}>{phaseLabel(ac.phase)}</span>
        )}
      </span>
      {(clr || ic) && (
        <span className="break-words text-[10.5px] leading-snug text-atc-text/85" data-testid="fps-clearance">
          {ic && ac.onGround ? ifrClearanceSummary(ic) : clr}
          {!ac.onGround && ac.flightPlan && ac.flightPlan.route.length > 0 && <span className="text-atc-muted"> · {ac.flightPlan.route.join(' ')}</span>}
        </span>
      )}
    </button>
  );
}

/** Compact flight-progress-strip view of the traffic, one bay per frequency. */
export function FlightStrips() {
  const state = useSimState();
  const select = useSimStore((s) => s.selectAircraft);
  const controller = useSimStore((s) => s.controller);
  const list = state ? Object.values(state.aircraft) : [];
  const groups = useMemo(() => (state ? groupByFrequency(state, list) : []), [state, state?.clock.tick, list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!state) return null;
  const mine = controllerFrequencies(state, controller);
  return (
    <Panel title="Flight strips" count={list.length} className="min-h-[132px] flex-1" right={<span className="font-sans text-[10px] text-atc-muted">by frequency</span>}>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="flight-strips">
        {list.length === 0 && <div className="p-4 text-center text-xs text-atc-muted">No aircraft yet.</div>}
        {groups.map((g) => {
          const worked = mine.some((m) => sameFrequency(m, g.mhz));
          return (
            <div key={g.mhz} data-testid={`bay-${g.mhz.toFixed(3)}`}>
              <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-atc-border bg-atc-panel-2 px-3 py-0.5 font-sans text-[10px] uppercase tracking-wider">
                <span className="text-atc-text">{g.label} <span className="tabular-nums text-atc-green">{formatMhz(g.mhz)}</span></span>
                <span className={worked ? 'text-atc-muted' : 'text-atc-amber'}>{worked ? `${g.aircraft.length}` : `not worked · ${g.aircraft.length}`}</span>
              </div>
              {g.aircraft.map((ac) => (
                <Strip key={ac.id} state={state} ac={ac} selected={state.selectedAircraftId === ac.id} mine={worked} onSelect={() => select(state.selectedAircraftId === ac.id ? undefined : ac.id)} />
              ))}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
