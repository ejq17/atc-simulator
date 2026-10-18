import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import type { Aircraft, ControllerPositionId, SimulationState } from '../../sim/types';
import { sameFrequency } from '../../radio/frequencies';
import { useSimState, useSimStore } from '../store/simStore';
import { TONE_COLOR, formatMhz, phaseLabel, statusTone } from '../lib/format';
import { requestBadge } from '../lib/ifr';
import { BAY_LABEL, BAY_ORDER, STRIP_KEYS, STRIP_LEGEND, bayListFor, bayWorkedByPlayer, zuluHm } from '../strips/stripModel';
import type { BayId, Strip, StripBoard, UtcSource } from '../strips/stripModel';
import { Panel } from './ui';
import { ClosureBar } from './AirportNotices';

const AI_TEXT = 'text-[#b79cff]';
const BAY_POSITIONS: Record<BayId, ControllerPositionId[]> = { CLNC: ['CLNC'], GND: ['GND'], TWR: ['TWR'], APPDEP: ['APP', 'DEP'], OTHER: [] };
/** A strip is "fresh" (print / move animation) for this long after it entered its bay. */
const FRESH_MS = 2200;

const ft = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString('en-US'));

/** Frequencies of a bay from the airport data ("124.6" for APP/DEP, which share one). */
export function bayFrequencies(state: Pick<SimulationState, 'airport'>, bay: BayId): number[] {
  const out: number[] = [];
  for (const f of state.airport.frequencies) {
    if (!BAY_POSITIONS[bay].includes(f.position as ControllerPositionId)) continue;
    if (f.id.endsWith('-N') || out.some((m) => sameFrequency(m, f.mhz))) continue;
    out.push(f.mhz);
  }
  return out;
}

interface StripViewProps {
  strip: Strip;
  ac: Aircraft | undefined;
  board: StripBoard;
  startUtcMs: UtcSource;
  selected: boolean;
  owner: 'player' | 'ai';
  fresh: boolean;
  dropMark: 'before' | 'after' | null;
  onSelect(): void;
  onChanged(): void;
  drag: {
    start(e: DragEvent, strip: Strip, root: HTMLElement | null): void;
    over(e: DragEvent, strip: Strip, root: HTMLElement | null): void;
    drop(e: DragEvent, strip: Strip, root: HTMLElement | null): void;
    end(): void;
  };
}

function StripView({ strip, ac, board, startUtcMs, selected, owner, fresh, dropMark, onSelect, onChanged, drag }: StripViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const f = strip.fields;
  const tone = ac ? statusTone(ac) : 'idle';
  const finished = strip.struck || strip.gone;
  const request = ac?.pendingRequest;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') { e.preventDefault(); onSelect(); }
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (board.nudge(strip.id, e.key === 'ArrowUp' ? -1 : 1)) onChanged();
    }
  };
  return (
    <div
      ref={rootRef}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Flight strip ${f.callsign}`}
      data-testid={`fps-${strip.callsign}`}
      data-bay={strip.bay}
      data-struck={strip.struck ? 'true' : 'false'}
      data-gone={strip.gone ? 'true' : 'false'}
      data-entry={strip.entry}
      onClick={onSelect}
      onKeyDown={onKey}
      onDragOver={(e) => drag.over(e, strip, rootRef.current)}
      onDrop={(e) => drag.drop(e, strip, rootRef.current)}
      className={[
        'group relative flex flex-col gap-0.5 border-b border-atc-border/70 py-1 pl-5 pr-2 text-left outline-none transition-colors',
        selected ? 'bg-atc-cyan/10' : owner === 'ai' ? 'bg-atc-panel' : 'bg-atc-panel-2/70 hover:bg-atc-panel-2',
        finished ? 'opacity-55' : '',
        fresh ? (strip.entry === 'move' ? 'strip-move' : 'strip-print') : '',
        dropMark === 'before' ? 'shadow-[inset_0_2px_0_0_#39c5e8]' : dropMark === 'after' ? 'shadow-[inset_0_-2px_0_0_#39c5e8]' : '',
      ].join(' ')}
    >
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: strip.gone ? '#3a4552' : TONE_COLOR[tone] }} />
      {selected && <span className="absolute inset-y-0 left-1 w-px bg-atc-cyan" />}
      {!finished && (
        <span
          draggable
          role="img"
          aria-label="Drag to resequence"
          title="Drag to resequence within the bay (Alt+↑ / Alt+↓ when the strip is focused)"
          data-testid={`strip-grip-${strip.callsign}`}
          onDragStart={(e) => drag.start(e, strip, rootRef.current)}
          onDragEnd={drag.end}
          onClick={(e) => e.stopPropagation()}
          className="absolute left-1.5 top-1 flex h-5 w-3 cursor-grab select-none items-center justify-center text-[11px] leading-none text-atc-muted/70 hover:text-atc-cyan active:cursor-grabbing"
        >
          ⠿
        </span>
      )}

      <div className="flex items-baseline gap-2">
        <span className={`text-[13.5px] font-bold tracking-wide ${selected ? 'text-atc-cyan' : 'text-atc-text'} ${finished ? 'line-through decoration-atc-muted' : ''}`} data-testid="strip-callsign">{f.callsign}</span>
        <span className="text-[11px] text-atc-muted" data-testid="strip-type">{f.typeEquip}</span>
        <span className={`border px-1 text-[9.5px] font-semibold leading-4 ${f.flightRules === 'IFR' ? 'border-atc-cyan/60 text-atc-cyan' : 'border-atc-border text-atc-muted'}`} data-testid="strip-rules">{f.flightRules}</span>
        {strip.struck && <span className="border border-atc-green-dim px-1 font-sans text-[9px] font-semibold uppercase leading-4 tracking-wider text-atc-green">handled</span>}
        {strip.gone && <span className="border border-atc-border px-1 font-sans text-[9px] font-semibold uppercase leading-4 tracking-wider text-atc-muted">left</span>}
        <span className="ml-auto flex items-baseline gap-2">
          <span className="text-[12px] font-semibold tabular-nums text-atc-text" data-testid="strip-squawk" title="Squawk">{f.squawk ?? <span className="text-atc-muted/50">----</span>}</span>
          <span className="text-[10px] tabular-nums text-atc-muted" title={`Strip printed ${zuluHm(startUtcMs, strip.printedSec)}`} data-testid="strip-printed">{zuluHm(startUtcMs, strip.printedSec)}</span>
        </span>
      </div>

      <div className={`flex items-baseline gap-x-2.5 text-[11px] ${finished ? 'line-through decoration-atc-muted/60' : ''}`}>
        <span className="font-semibold tabular-nums text-atc-text" data-testid="strip-route-od">{f.origin}<span className="px-0.5 text-atc-muted">→</span>{f.destination}</span>
        <span className="text-atc-muted" title="Assigned runway">RWY <b className="font-semibold text-atc-text" data-testid="strip-runway">{f.runway ?? '—'}</b></span>
        {(f.assignedAltitudeFt !== undefined || f.requestedAltitudeFt !== undefined) && (
          <span className="text-atc-muted" title="Assigned altitude / requested (filed) altitude" data-testid="strip-alt">ALT <b className="font-semibold text-atc-text">{ft(f.assignedAltitudeFt)}</b> / {ft(f.requestedAltitudeFt)}</span>
        )}
        <span className="ml-auto shrink-0">
          {request ? (
            <span className="atc-blink border border-atc-amber/70 px-1 text-[9.5px] font-semibold uppercase leading-4 tracking-wider text-atc-amber" title={request.text} data-testid="request-badge" data-kind={request.kind}>{requestBadge(request.kind)}</span>
          ) : (
            <span className="text-[10.5px] font-semibold" style={{ color: strip.gone ? '#7f8a96' : TONE_COLOR[tone] }}>{phaseLabel(ac?.phase ?? f.phase)}</span>
          )}
        </span>
      </div>

      {f.route.length > 0 && (
        <div className="truncate text-[10.5px] text-atc-muted" title={f.route.join(' ')} data-testid="strip-fixes">{f.route.join(' ')}</div>
      )}

      <div className={`flex flex-wrap items-center gap-1 ${strip.marks.length ? 'min-h-[18px]' : ''}`} data-testid="strip-marks">
        {strip.marks.map((m) => (
          <span
            key={m.id}
            title={m.title}
            data-testid="strip-mark"
            className={`border px-1 font-mono text-[10.5px] font-semibold leading-[15px] ${m.kind === 'time' ? 'border-atc-green-dim text-atc-green' : 'border-atc-border text-atc-text'}`}
          >
            {m.text}
          </span>
        ))}
      </div>

      <input
        data-testid={`strip-notes-${strip.callsign}`}
        aria-label={`Notes for ${f.callsign}`}
        defaultValue={strip.notes}
        maxLength={160}
        spellCheck={false}
        autoComplete="off"
        placeholder="notes"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => { board.setNotes(strip.id, e.target.value); }}
        onBlur={onChanged}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' || e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="h-[18px] w-full border-0 border-b border-dashed border-atc-border bg-transparent px-0 text-[11px] text-atc-text placeholder:text-atc-muted/40 focus:border-atc-cyan focus:outline-none"
      />
    </div>
  );
}

function Legend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0 border-t border-atc-border bg-atc-panel-2/60" data-testid="strip-legend" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-1 font-sans text-[10px] font-semibold uppercase tracking-[0.16em] text-atc-muted hover:text-atc-text"
      >
        <span>Strip marking</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="absolute inset-x-0 bottom-full z-20 max-h-[360px] overflow-y-auto border border-atc-border bg-atc-panel px-3 pb-2 pt-1.5 shadow-[0_-8px_24px_rgba(0,0,0,0.55)]" role="region" aria-label="Strip marking legend">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10.5px] leading-snug">
            {STRIP_LEGEND.map((l) => (
              <div key={l.mark} className="contents">
                <dt className="whitespace-nowrap font-mono font-semibold text-atc-text">{l.mark}</dt>
                <dd className="text-atc-muted">{l.meaning}</dd>
              </div>
            ))}
            {STRIP_KEYS.map((k) => (
              <div key={k.key} className="contents">
                <dt className="whitespace-nowrap font-mono font-semibold text-atc-cyan">{k.key}</dt>
                <dd className="text-atc-muted">{k.meaning}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

/** The strip board: one bay per position, the player's bays highlighted and AI bays dimmed. */
export function FlightStrips() {
  const state = useSimState();
  const session = useSimStore((s) => s.session);
  const select = useSimStore((s) => s.selectAircraft);
  const controller = useSimStore((s) => s.controller);
  const touch = useSimStore((s) => s.touch);
  const hint = useSimStore((s) => s.stripHint);
  const setHint = useSimStore((s) => s.setStripHint);
  const dragging = useRef<{ id: string; bay: BayId } | null>(null);
  const [over, setOver] = useState<{ id: string; pos: 'before' | 'after' } | null>(null);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 4000);
    return () => clearTimeout(t);
  }, [hint, setHint]);

  const board = session?.strips;
  const sessionPositions = useMemo(() => [...controller.positions, ...(controller.aiPositions ?? [])], [controller]);
  if (!state || !session || !board) return null;

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const used = board.usedBays();
  const bays: BayId[] = [...BAY_ORDER.filter((b) => bayListFor(sessionPositions).includes(b) || used.includes(b)), ...(used.includes('OTHER') ? (['OTHER'] as BayId[]) : [])];
  const total = board.all().filter((s) => !s.gone).length;

  const drag: StripViewProps['drag'] = {
    start(e, strip, root) {
      dragging.current = { id: strip.id, bay: strip.bay };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', strip.id);
      if (root) e.dataTransfer.setDragImage(root, 16, 10);
    },
    over(e, strip, root) {
      const d = dragging.current;
      if (!d || d.bay !== strip.bay || d.id === strip.id || strip.struck || strip.gone) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = root?.getBoundingClientRect();
      const pos = r && e.clientY > r.top + r.height / 2 ? 'after' : 'before';
      setOver((cur) => (cur && cur.id === strip.id && cur.pos === pos ? cur : { id: strip.id, pos }));
    },
    drop(e, strip, root) {
      const d = dragging.current;
      dragging.current = null;
      setOver(null);
      if (!d || d.bay !== strip.bay || d.id === strip.id) return;
      e.preventDefault();
      const r = root?.getBoundingClientRect();
      const after = r ? e.clientY > r.top + r.height / 2 : false;
      let beforeId: string | null = strip.id;
      if (after) {
        const lane = board.bay(strip.bay).filter((s) => !s.struck && !s.gone && s.id !== d.id);
        const i = lane.findIndex((s) => s.id === strip.id);
        beforeId = lane[i + 1]?.id ?? null;
      }
      if (board.reorder(d.id, beforeId)) touch();
    },
    end() {
      dragging.current = null;
      setOver(null);
    },
  };

  return (
    <Panel
      title="Flight strips"
      count={total}
      className="relative min-h-[132px] flex-1"
      right={<span className="font-sans text-[10px] text-atc-muted"><kbd className="font-mono text-atc-text">S</kbd> strike · <kbd className="font-mono text-atc-text">X</kbd> drop · drag <span className="text-atc-text">⠿</span> to resequence</span>}
    >
      <ClosureBar state={state} />
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="flight-strips">
        {bays.map((bay) => {
          const owner = bayWorkedByPlayer(bay, controller.positions) ? 'player' : 'ai';
          const strips = board.bay(bay);
          const freqs = bayFrequencies(state, bay);
          const aiPos = (controller.aiPositions ?? []).find((p) => BAY_POSITIONS[bay].includes(p));
          return (
            <section
              key={bay}
              data-testid={`bay-${bay}`}
              data-owner={owner}
              aria-label={`${BAY_LABEL[bay]} bay, ${owner === 'player' ? 'you work this position' : 'worked by AI'}`}
              className={`border-b border-atc-border ${owner === 'player' ? 'border-l-2 border-l-atc-cyan' : 'border-l-2 border-l-[#b79cff]/50 bg-atc-bg/40'}`}
            >
              <div className={`sticky top-0 z-[1] flex items-center justify-between border-b border-atc-border px-3 py-0.5 font-sans text-[10px] uppercase tracking-wider ${owner === 'player' ? 'bg-atc-cyan/10' : 'bg-atc-panel-2'}`}>
                <span className="flex items-center gap-2">
                  <span className={`text-[11px] font-semibold ${owner === 'player' ? 'text-atc-cyan' : AI_TEXT}`} data-testid={`bay-title-${bay}`}>{bay === 'OTHER' ? 'OTHER' : aiPos && owner === 'ai' ? `${aiPos === 'APP' || aiPos === 'DEP' ? 'APP/DEP' : aiPos}·AI` : BAY_LABEL[bay]}</span>
                  {freqs.map((m) => <span key={m} className="tabular-nums text-atc-green">{formatMhz(m)}</span>)}
                </span>
                <span className="flex items-center gap-2">
                  <span className={owner === 'player' ? 'font-semibold text-atc-cyan' : AI_TEXT}>{owner === 'player' ? 'you' : 'AI'}</span>
                  <span className="text-atc-muted" data-testid={`bay-count-${bay}`}>{strips.filter((s) => !s.gone).length}</span>
                </span>
              </div>
              <div className={owner === 'ai' ? 'opacity-[0.72]' : ''}>
                {strips.map((strip) => (
                  <StripView
                    key={strip.id}
                    strip={strip}
                    ac={state.aircraft[strip.id]}
                    board={board}
                    startUtcMs={session.utcAt}
                    selected={state.selectedAircraftId === strip.id}
                    owner={owner}
                    fresh={strip.bayEnteredWall > 0 && now - strip.bayEnteredWall < FRESH_MS}
                    dropMark={over?.id === strip.id ? over.pos : null}
                    onSelect={() => select(strip.id)}
                    onChanged={touch}
                    drag={drag}
                  />
                ))}
              </div>
            </section>
          );
        })}
        {bays.length === 0 && <div className="p-4 text-center text-xs text-atc-muted">No aircraft yet.</div>}
      </div>
      <div className="min-h-[18px] shrink-0 border-t border-atc-border px-3 py-0.5 text-[10.5px] text-atc-muted" data-testid="strip-hint" aria-live="polite">{hint}</div>
      <Legend />
    </Panel>
  );
}
