import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { sameFrequency } from '../../radio/frequencies';
import type { SimulationState } from '../../sim/types';
import { useSimState, useSimStore, choiceFromSetup } from '../store/simStore';
import type { AiPositionView } from '../store/session';
import type { PositionChoice } from '../store/simStore';
import { POSITION_LABEL, POSITION_ORDER, frequencyRows, positionListText, rowLabel } from '../lib/positions';
import type { FrequencyRow } from '../lib/positions';
import { useUiStore } from '../store/uiStore';
import { useVoiceSettings, voiceSettings } from '../store/voiceSettings';
import { describeVoiceStatus, keyLabel } from '../lib/voiceStatus';
import { formatMhz } from '../lib/format';
import { Btn, INPUT, Kbd, LABEL, Panel } from './ui';
import { SpeakerIcon } from './SpeakerIcon';
import { STT_PROVIDER_NOTES } from '../../voice';

const TONE_CLASS = {
  ok: 'text-atc-green border-atc-green-dim',
  live: 'text-atc-red border-atc-red',
  warn: 'text-atc-amber border-atc-amber/70',
  bad: 'text-atc-red border-atc-red/70',
  off: 'text-atc-muted border-atc-border',
} as const;

/** How long (sim seconds) the RX / TX lamp of a frequency stays lit after a call. */
const LAMP_SEC = 6;

export interface FrequencyActivity { dir: 'RX' | 'TX'; callsign?: string; timeSec: number }

/** The most recent pilot (RX) or controller (TX) call on each of the controller's frequencies. */
export function lastActivity(state: Pick<SimulationState, 'events'>, rows: readonly FrequencyRow[]): Map<number, FrequencyActivity> {
  const out = new Map<number, FrequencyActivity>();
  const ev = state.events;
  for (let i = ev.length - 1; i >= 0 && out.size < rows.length && i > ev.length - 500; i--) {
    const e = ev[i];
    if (e.frequencyMhz === undefined || (e.speaker !== 'PILOT' && e.speaker !== 'ATC')) continue;
    const row = rows.find((r) => sameFrequency(r.mhz, e.frequencyMhz!));
    if (row && !out.has(row.mhz)) out.set(row.mhz, { dir: e.speaker === 'PILOT' ? 'RX' : 'TX', callsign: e.callsign, timeSec: e.timeSec });
  }
  return out;
}

/** AI positions that share a frequency (KACY Approach and Departure, 124.6) are listed as one row: "APP/DEP·AI". */
export function mergeAiRows(rows: readonly AiPositionView[]): { positions: AiPositionView['position'][]; mhz?: number; text: string }[] {
  const out: { positions: AiPositionView['position'][]; mhz?: number; text: string }[] = [];
  for (const r of rows) {
    const same = r.mhz === undefined ? undefined : out.find((o) => o.mhz !== undefined && sameFrequency(o.mhz, r.mhz!));
    if (same) {
      same.positions.push(r.position);
      if (r.text && r.text !== same.text) same.text = same.text ? `${same.text} | ${r.text}` : r.text;
    } else out.push({ positions: [r.position], mhz: r.mhz, text: r.text });
  }
  return out;
}

export function RadioPanel() {
  const state = useSimState();
  const session = useSimStore((s) => s.session);
  const controller = useSimStore((s) => s.controller);
  const setChoice = useSimStore((s) => s.setControllerChoice);
  const voice = useSimStore((s) => s.voice);
  const last = useSimStore((s) => s.lastTransmit);
  const history = useSimStore((s) => s.typedHistory);
  const submitTyped = useSimStore((s) => s.submitTyped);
  const settings = useVoiceSettings();
  const draft = useUiStore((s) => s.draft);
  const setDraft = useUiStore((s) => s.setDraft);
  const toggleDrawer = useUiStore((s) => s.toggleDrawer);
  const atis = useSimStore((s) => s.atis);
  const audio = useSimStore((s) => s.audio);
  const pttRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [histIdx, setHistIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = pttRef.current;
    const ptt = session?.voice?.ptt;
    if (!el || !ptt) return;
    return ptt.bindButton(el);
  }, [session]);

  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener('atc:focus-input', focus);
    return () => window.removeEventListener('atc:focus-input', focus);
  }, []);

  if (!state || !session) return null;
  const choice = choiceFromSetup(controller);
  const rows = frequencyRows(state.airport, controller.positions);
  const activity = lastActivity(state, rows);
  const newest = [...activity.entries()].sort((a, b) => b[1].timeSec - a[1].timeSec)[0];
  const status = describeVoiceStatus(voice.status, settings.providerId, voice.message, keyLabel(settings.pttKey));
  const pttDisabled = settings.providerId === 'none' || voice.status === 'unsupported' || voice.status === 'permission_denied';
  const provider = STT_PROVIDER_NOTES[settings.providerId];
  /** With voice off the badge already says so; the status and Heard lines only appear when there is a microphone path. */
  const voiceOn = settings.providerId !== 'none';

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    submitTyped(text);
    setDraft('');
    setHistIdx(null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setDraft(history[next]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx === null) return;
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(null);
        setDraft('');
      } else {
        setHistIdx(next);
        setDraft(history[next]);
      }
    } else if (e.key === 'Escape') {
      (e.target as HTMLInputElement).blur();
    }
  };

  const resultTone = last?.summary === 'accepted' ? 'text-atc-green' : last?.summary === 'rejected' ? 'text-atc-red' : last?.summary === 'clarify' ? 'text-atc-amber' : 'text-atc-muted';

  const aiRows = session.aiPositions();
  const info = session.audioInfo();
  const providerShort = settings.providerId === 'none' ? 'Mic off' : settings.providerId === 'deepgram' ? 'Deepgram' : settings.providerId === 'whisper-local' ? 'Local Whisper' : 'Browser speech';

  return (
    <Panel
      title="Radio"
      className="h-full min-h-0"
      right={
        <div className="flex items-center gap-3 font-sans text-[10px] uppercase tracking-wider text-atc-muted">
          <span>Dep <b className="text-atc-text">{state.activeRunways.departing.join('/')}</b> Arr <b className="text-atc-text">{state.activeRunways.landing.join('/')}</b></span>
          <button type="button" onClick={() => toggleDrawer('atis')} className="text-atc-cyan hover:underline">ATIS {atis?.letter ?? '-'}</button>
          <button type="button" onClick={() => toggleDrawer('settings')} className="hover:text-atc-cyan" title={provider.summary}>{providerShort}</button>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-1.5">
        <div className="flex shrink-0 items-center gap-2">
          <span className={`${LABEL} shrink-0`}>I work</span>
          <select
            aria-label="Controller position"
            data-testid="position-select"
            value={choice}
            onChange={(e) => setChoice(e.target.value as PositionChoice)}
            className={`${INPUT} h-8 min-w-0 flex-1 appearance-none`}
          >
            {POSITION_ORDER.map((k) => (
              <option key={k} value={k}>{POSITION_LABEL[k]}{k === 'APP' ? ' (124.6)' : ''}</option>
            ))}
          </select>
        </div>
        <div className="grid shrink-0 gap-1" style={{ gridTemplateColumns: rows.length > 1 ? 'repeat(2, minmax(0, 1fr))' : '1fr' }} data-testid="frequency">
          {rows.map((r) => {
            const act = activity.get(r.mhz);
            const lit = !!act && state.clock.timeSec - act.timeSec <= LAMP_SEC;
            const isLast = newest?.[0] === r.mhz;
            const lamp = lit ? (act!.dir === 'RX' ? 'bg-atc-green' : 'bg-atc-cyan') : 'bg-atc-border';
            return (
              <div
                key={r.mhz}
                data-testid={`freq-${r.mhz.toFixed(3)}`}
                data-lit={lit ? act!.dir : 'off'}
                data-last={isLast ? 'true' : 'false'}
                title={act ? `Last ${act.dir === 'RX' ? 'call received' : 'transmission'}${act.callsign ? ` · ${act.callsign}` : ''}` : 'No traffic yet'}
                className={`flex h-[26px] items-center gap-1.5 border px-2 leading-none ${lit ? (act!.dir === 'RX' ? 'border-atc-green bg-atc-green/10' : 'border-atc-cyan bg-atc-cyan/10') : isLast ? 'border-atc-muted' : 'border-atc-border'} bg-atc-bg`}
              >
                <span className={`inline-block h-2 w-2 shrink-0 ${lamp}`} />
                <span className="w-[52px] shrink-0 truncate text-[10px] text-atc-muted">{rowLabel(r)}</span>
                <span className="flex-1 text-[13.5px] font-semibold tabular-nums text-atc-green">{formatMhz(r.mhz)}</span>
                <span className={`shrink-0 text-right text-[9.5px] font-semibold ${lit ? (act!.dir === 'RX' ? 'text-atc-green' : 'text-atc-cyan') : 'text-atc-muted'}`}>{lit ? act!.dir : isLast ? `last ${act!.dir}` : ''}</span>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <button
            ref={pttRef}
            type="button"
            disabled={pttDisabled}
            data-testid="ptt"
            aria-label="Push to talk"
            className={`flex h-9 flex-1 select-none items-center justify-center gap-2 border font-sans text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${voice.transmitting ? 'atc-tx border-atc-red bg-atc-red/20 text-atc-red' : 'border-atc-green-dim bg-atc-bg text-atc-green hover:bg-atc-green/10'}`}
          >
            <span className={`inline-block h-2.5 w-2.5 ${voice.transmitting ? 'bg-atc-red' : 'bg-atc-green-dim'}`} />
            {voice.transmitting ? 'Transmitting' : 'Push to talk'}
            <Kbd>{keyLabel(settings.pttKey)}</Kbd>
          </button>
          <span data-testid="mic-badge" className={`border px-2 py-1.5 font-sans text-[10px] font-semibold uppercase tracking-wider ${TONE_CLASS[status.tone]}`}>{status.badge}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2" data-testid="pilot-audio-row">
          <button
            type="button"
            role="switch"
            aria-checked={settings.ttsEnabled}
            aria-label={`Pilot audio: ${settings.ttsEnabled ? 'on' : 'off'}`}
            data-testid="pilot-audio"
            data-audio={settings.ttsEnabled ? 'on' : 'off'}
            data-speaking={settings.ttsEnabled && audio.speaking ? 'true' : 'false'}
            onClick={() => voiceSettings.update({ ttsEnabled: !settings.ttsEnabled })}
            title={settings.ttsEnabled ? 'Pilots (and monitored AI controllers) are spoken aloud. Click to mute.' : 'Pilot audio is off: transmissions appear as text only. Click to turn it on.'}
            className={`flex h-7 shrink-0 items-center gap-1.5 border px-2 font-sans text-[10.5px] font-semibold uppercase tracking-wider transition-colors ${settings.ttsEnabled ? (audio.speaking ? 'border-atc-green bg-atc-green/15 text-atc-green' : 'border-atc-green-dim text-atc-green hover:bg-atc-green/10') : 'border-atc-border text-atc-muted hover:border-atc-muted'}`}
          >
            <SpeakerIcon on={settings.ttsEnabled} speaking={settings.ttsEnabled && audio.speaking} />
            Pilot audio: {settings.ttsEnabled ? 'on' : 'off'}
          </button>
          <span className="min-w-0 flex-1 truncate text-[11px] text-atc-muted" data-testid="speaking" aria-live="polite" title={!info.supported ? 'This browser has no speech synthesis.' : info.voices === 0 ? 'No speech voices are installed or loaded yet.' : `${info.voices} voices available`}>
            {!info.supported ? <span className="text-atc-red">no speech support in this browser</span>
              : !settings.ttsEnabled ? 'muted'
              : audio.speaking ? <span className="text-atc-green">speaking · {audio.who ?? ''}</span>
              : info.voices === 0 ? <span className="text-atc-amber">no voices loaded</span>
              : 'listening'}
          </span>
          <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[10.5px] text-atc-muted" title="Also hear the frequencies you do not work (AI Tower, Ground...) at lower volume.">
            <input type="checkbox" className="accent-[#39c5e8]" checked={settings.monitorAll} onChange={(e) => voiceSettings.update({ monitorAll: e.target.checked })} data-testid="monitor-all" aria-label="Monitor all frequencies" />
            Monitor all
          </label>
        </div>
        {voiceOn && (
          <>
            <div className="truncate text-[11px] leading-snug text-atc-muted" data-testid="mic-status" title={status.text}>{status.text}</div>
            <div className="flex items-baseline gap-2 text-[11.5px]">
              <span className={LABEL}>Heard</span>
              <span className="min-w-0 flex-1 truncate text-atc-text" data-testid="partial">{voice.partial || <span className="text-atc-muted/60">—</span>}</span>
            </div>
          </>
        )}
        {aiRows.length > 0 && (
          <div className="shrink-0 border border-dashed border-atc-border bg-atc-bg/60" data-testid="ai-positions">
            <div className={`${LABEL} px-2 pt-1`}>Other positions (AI)<span className="sr-only" data-testid="ai-works">AI works: {positionListText(aiRows.map((r) => r.position))}</span></div>
            <ul className="flex flex-col gap-px px-2 pb-1 pt-0.5">
              {mergeAiRows(aiRows).map((r) => (
                <li key={r.positions.join('/')} className="flex items-baseline gap-2 text-[11px] leading-snug" data-testid={r.positions.map((p) => `ai-${p}`)[0]} data-positions={r.positions.join(' ')}>
                  <span className="w-[74px] shrink-0 font-semibold text-[#b79cff]">{r.positions.join('/')}·AI</span>
                  <span className="w-[40px] shrink-0 tabular-nums text-atc-muted">{r.mhz !== undefined ? String(Number(r.mhz.toFixed(3))) : ''}</span>
                  <span className="min-w-0 flex-1 truncate text-atc-text/80" title={r.text || 'Idle'}>{r.text || <span className="text-atc-muted/70">idle</span>}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {aiRows.length === 0 && <div className="shrink-0 text-[11px] leading-snug text-atc-muted" data-testid="ai-works">No AI positions: you work everything in this session.</div>}

      </div>
      <div className="flex shrink-0 flex-col gap-1 border-t border-atc-border px-3 py-2">
          <div className="flex gap-1.5">
            <input
              ref={inputRef}
              data-testid="command-input"
              aria-label="Typed command"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setHistIdx(null); }}
              onKeyDown={onKey}
              autoComplete="off"
              spellCheck={false}
              placeholder="Typed command: Cessna 723EJ, runway 13, cleared for takeoff"
              className={INPUT}
            />
            <Btn tone="cyan" data-testid="command-send" onClick={submit} disabled={!draft.trim()}>Send</Btn>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className={`min-h-4 min-w-0 flex-1 line-clamp-2 text-[11px] leading-snug ${last?.offFrequency ? 'font-semibold text-atc-red' : last?.aiBlocked ? 'font-semibold text-[#b79cff]' : resultTone}`} data-testid="last-result" data-off-frequency={last?.offFrequency ? 'true' : undefined} data-ai-blocked={last?.aiBlocked ? 'true' : undefined} title={last?.message}>
              {last ? last.message : <span className="text-atc-muted">Spoken and typed calls use the same parser.</span>}
            </span>
            <span className="shrink-0 text-[10px] text-atc-muted"><Kbd>Enter</Kbd> focus · <Kbd>↑</Kbd><Kbd>↓</Kbd> history</span>
          </div>
      </div>
    </Panel>
  );
}
