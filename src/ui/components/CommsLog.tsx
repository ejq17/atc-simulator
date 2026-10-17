import { useEffect, useMemo, useRef, useState } from 'react';
import type { SimEvent, SimEventKind, SimulationState } from '../../sim/types';
import { sameFrequency } from '../../radio/frequencies';
import { useSimState, useSimStore } from '../store/simStore';
import { formatElapsed, formatMhz } from '../lib/format';
import { Panel, Segmented } from './ui';

/** Event kinds a controller cares about in the radio log. Everything else is "system detail". */
const COMMS_KINDS = new Set<SimEventKind>([
  'TRANSMISSION', 'COMMAND_REJECTED', 'CLARIFICATION', 'READBACK_ERROR', 'HANDOFF', 'GO_AROUND',
  'RUNWAY_INCURSION', 'SEPARATION_VIOLATION', 'CONFLICT', 'SCENARIO',
]);

export type LogFilter = 'comms' | 'all';

/** The session logs its own weather line (with METAR/ATIS context), so the engine's "Weather updated" note is hidden to avoid a duplicate. */
const isEngineWeatherNote = (e: SimEvent) => e.kind === 'INFO' && e.text.startsWith('Weather updated:');

export function filterEvents(events: readonly SimEvent[], filter: LogFilter): SimEvent[] {
  if (filter === 'all') return events.filter((e) => !isEngineWeatherNote(e));
  events = events.filter((e) => !isEngineWeatherNote(e));
  return events.filter((e) => COMMS_KINDS.has(e.kind) || e.severity !== 'info' || (e.kind === 'INFO' && e.speaker === 'SYSTEM' && /ATIS|Weather/i.test(e.text)));
}

function speakerOf(e: SimEvent): 'ATC' | 'PILOT' | 'SYSTEM' {
  return e.speaker ?? 'SYSTEM';
}

function freqTag(state: SimulationState, e: SimEvent): string {
  if (e.frequencyMhz === undefined) return '';
  const f = state.airport.frequencies.find((x) => sameFrequency(x.mhz, e.frequencyMhz!));
  return `${formatMhz(e.frequencyMhz)}${f ? ` ${f.id.replace(/-N$/, '')}` : ''}`;
}

const SPEAKER_STYLE = {
  ATC: { tag: 'ATC', cls: 'text-atc-cyan', border: 'border-l-atc-cyan' },
  PILOT: { tag: 'PLT', cls: 'text-atc-green', border: 'border-l-atc-green-dim' },
  SYSTEM: { tag: 'SYS', cls: 'text-atc-muted', border: 'border-l-atc-border' },
} as const;

export function CommsLog() {
  const state = useSimState();
  const select = useSimStore((s) => s.selectAircraft);
  const [filter, setFilter] = useState<LogFilter>('comms');
  const [hover, setHover] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const events = state?.events;
  const lastId = events?.[events.length - 1]?.id;
  const rows = useMemo(() => (events ? filterEvents(events, filter).slice(-300) : []), [events, filter, lastId, events?.length]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && !hover) el.scrollTop = el.scrollHeight;
  }, [rows.length, lastId, hover, filter]);

  if (!state) return null;
  const idFor = (e: SimEvent): string | undefined => e.aircraftId ?? (e.callsign ? Object.values(state.aircraft).find((a) => a.callsign === e.callsign)?.id : undefined);

  return (
    <Panel
      title="Communications"
      count={rows.length}
      className="h-full min-h-0"
      right={
        <div className="flex items-center gap-2">
          <span className={`font-sans text-[10px] uppercase tracking-wider ${hover ? 'text-atc-amber' : 'text-atc-muted'}`}>{hover ? 'scroll paused' : 'live'}</span>
          <Segmented size="xs" value={filter} onChange={setFilter} options={[{ value: 'comms', label: 'Radio' }, { value: 'all', label: 'All events' }]} />
        </div>
      }
    >
      <div
        ref={boxRef}
        data-testid="comms-log"
        role="log"
        aria-live="polite"
        className="min-h-0 flex-1 overflow-y-auto py-1"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {rows.length === 0 && <div className="px-3 py-3 text-xs text-atc-muted">No transmissions yet. Hold the PTT key or type a command to talk to traffic.</div>}
        {rows.map((e) => {
          const sp = speakerOf(e);
          const st = SPEAKER_STYLE[sp];
          const sev = e.severity === 'critical' ? 'text-atc-red' : e.severity === 'warning' ? 'text-atc-amber' : sp === 'SYSTEM' ? 'text-atc-muted' : 'text-atc-text';
          const id = idFor(e);
          return (
            <div
              key={e.id}
              data-testid={`log-${sp.toLowerCase()}`}
              data-kind={e.kind}
              className={`flex items-baseline gap-2 border-l-2 px-3 py-[2px] text-[12px] leading-[1.45] hover:bg-atc-panel-2 ${st.border}`}
            >
              <span className="w-[58px] shrink-0 tabular-nums text-atc-muted">{formatElapsed(e.timeSec)}</span>
              <span className="w-[74px] shrink-0 truncate tabular-nums text-[10.5px] text-atc-muted">{freqTag(state, e)}</span>
              <span className={`w-7 shrink-0 font-semibold ${st.cls}`}>{st.tag}</span>
              {e.callsign ? (
                <button type="button" disabled={!id} onClick={() => id && select(id)} className={`w-[64px] shrink-0 truncate text-left font-semibold hover:underline ${st.cls}`}>
                  {e.callsign}
                </button>
              ) : (
                <span className="w-[64px] shrink-0" />
              )}
              <span className={`min-w-0 flex-1 ${sev} ${sp === 'SYSTEM' ? 'italic' : ''}`}>
                {e.kind === 'COMMAND_REJECTED' && <b className="not-italic text-atc-amber">REJECTED · </b>}
                {e.kind === 'CLARIFICATION' && <b className="not-italic text-atc-amber">CLARIFY · </b>}
                {e.text}
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
