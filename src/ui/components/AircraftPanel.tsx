import { useMemo } from 'react';
import type { Aircraft, SimulationState } from '../../sim/types';
import { sameFrequency } from '../../radio/frequencies';
import { controllerFrequencies } from '../commands/transmit';
import { useSimState, useSimStore } from '../store/simStore';
import { TONE_COLOR, formatMhz, phaseLabel, statusTone } from '../lib/format';
import { navLetter, requestBadge, stripClearance } from '../lib/ifr';
import { Panel } from './ui';

const TONE_ORDER = ['alert', 'runway', 'hold', 'arrival', 'taxi', 'airborne', 'idle'] as const;

export function sortAircraft(list: Aircraft[]): Aircraft[] {
  return [...list].sort((a, b) => {
    const pa = a.pendingRequest ? 0 : 1;
    const pb = b.pendingRequest ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const ta = TONE_ORDER.indexOf(statusTone(a));
    const tb = TONE_ORDER.indexOf(statusTone(b));
    if (ta !== tb) return ta - tb;
    return a.callsign.localeCompare(b.callsign);
  });
}

export function freqLabel(state: SimulationState, mhz: number): string {
  const f = state.airport.frequencies.find((x) => sameFrequency(x.mhz, mhz));
  return `${formatMhz(mhz)}${f ? ` ${f.id.replace(/-N$/, '')}` : ''}`;
}

export function AircraftPanel() {
  const state = useSimState();
  const select = useSimStore((s) => s.selectAircraft);
  const controller = useSimStore((s) => s.controller);
  const list = useMemo(() => (state ? sortAircraft(Object.values(state.aircraft)) : []), [state, state?.clock.tick]);
  if (!state) return null;
  const mine = controllerFrequencies(state, controller);
  return (
    <Panel title="Aircraft" count={list.length} className="min-h-[132px] flex-1" right={<span className="font-sans text-[10px] text-atc-muted">requests first</span>}>
      <div className="min-h-0 flex-1 overflow-y-auto" role="list" aria-label="Active aircraft">
        {list.length === 0 && <div className="p-4 text-center text-xs text-atc-muted">No aircraft yet. Traffic appears as the scenario runs.</div>}
        {list.map((ac) => {
          const tone = statusTone(ac);
          const selected = state.selectedAircraftId === ac.id;
          const onMine = mine.some((m) => sameFrequency(m, ac.frequencyMhz));
          return (
            <button
              key={ac.id}
              type="button"
              role="listitem"
              data-testid={`strip-${ac.callsign}`}
              aria-pressed={selected}
              onClick={() => select(selected ? undefined : ac.id)}
              className={`group relative flex w-full flex-col gap-0.5 border-b border-atc-border/70 py-1.5 pl-3.5 pr-2.5 text-left transition-colors ${selected ? 'bg-atc-cyan/10' : 'hover:bg-atc-panel-2'} ${onMine ? '' : 'opacity-60'}`}
            >
              <span className="absolute inset-y-0 left-0 w-1" style={{ background: TONE_COLOR[tone] }} />
              {selected && <span className="absolute inset-y-0 left-1 w-px bg-atc-cyan" />}
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-baseline gap-2">
                  <span className={`text-[13px] font-semibold ${selected ? 'text-atc-cyan' : 'text-atc-text'}`}>{ac.callsign}</span>
                  <span className="text-[10.5px] text-atc-muted">{ac.type}</span>
                  <span className="text-[10.5px] text-atc-muted">{ac.isDeparture ? 'DEP' : 'ARR'}</span>
                  <span className={`text-[10px] font-semibold ${ac.flightRules === 'IFR' ? 'text-atc-cyan' : 'text-atc-muted'}`} data-testid="rules">{ac.flightRules}</span>
                  {ac.squawk && <span className="text-[10px] tabular-nums text-atc-muted" title="Transponder code">{ac.squawk}</span>}
                </span>
                <span className="flex items-center gap-1.5">
                  {ac.flags.readbackErrorPending && (
                    <span title="Readback error pending: re-issue the instruction" className="border border-atc-red px-1 text-[9px] font-semibold leading-4 text-atc-red">RB ERR</span>
                  )}
                  <span className="text-[10.5px] tabular-nums text-atc-muted">{freqLabel(state, ac.frequencyMhz)}</span>
                </span>
              </span>
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px]" style={{ color: TONE_COLOR[tone] }}>
                  <span data-testid="phase" data-phase={ac.phase} title={ac.phase} className="font-semibold">{phaseLabel(ac.phase)}</span>
                  {navLetter(ac) && <span title="Navigation: V vectors, R route, A approach" className="border border-atc-border px-1 text-[9.5px] leading-4 text-atc-text">{navLetter(ac)}</span>}
                  {ac.radarIdentified && <span title="Radar identified" className="text-[9.5px] text-atc-green">RADAR ID</span>}
                </span>
                {ac.pendingRequest ? (
                  <span data-testid="request-badge" data-kind={ac.pendingRequest.kind} title={ac.pendingRequest.text} className="atc-blink border border-atc-amber/70 px-1 text-[9.5px] font-semibold uppercase leading-4 tracking-wider text-atc-amber">
                    {requestBadge(ac.pendingRequest.kind)}
                  </span>
                ) : (
                  <span className="text-[10.5px] tabular-nums text-atc-muted">{Math.round(ac.groundSpeedKt)} kt{ac.onGround ? '' : ` · ${Math.round(ac.altitudeFt).toLocaleString()} ft`}</span>
                )}
              </span>
              {ac.flightRules === 'IFR' && stripClearance(state, ac) && <span className="truncate text-[10.5px] text-atc-muted" data-testid="strip-clearance">{stripClearance(state, ac)}</span>}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
