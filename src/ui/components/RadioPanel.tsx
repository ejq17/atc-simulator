import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { frequencyForPosition } from '../../radio/frequencies';
import { useSimState, useSimStore, POSITION_CHOICES, choiceFromSetup } from '../store/simStore';
import type { PositionChoice } from '../store/simStore';
import { useUiStore } from '../store/uiStore';
import { useVoiceSettings } from '../store/voiceSettings';
import { describeVoiceStatus, keyLabel } from '../lib/voiceStatus';
import { formatMhz } from '../lib/format';
import { Btn, INPUT, Kbd, LABEL, Panel } from './ui';
import { STT_PROVIDER_NOTES } from '../../voice';

const TONE_CLASS = {
  ok: 'text-atc-green border-atc-green-dim',
  live: 'text-atc-red border-atc-red',
  warn: 'text-atc-amber border-atc-amber/70',
  bad: 'text-atc-red border-atc-red/70',
  off: 'text-atc-muted border-atc-border',
} as const;

const POSITION_NAMES: Record<PositionChoice, string> = {
  TWR: 'Tower', GND: 'Ground', APP: 'Approach / Departure', CLNC: 'Clearance Delivery', 'TWR+GND': 'Tower + Ground',
};

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
  const freqs = controller.positions
    .map((p) => frequencyForPosition(state.airport, p))
    .filter((f): f is NonNullable<typeof f> => !!f);
  const status = describeVoiceStatus(voice.status, settings.providerId, voice.message, keyLabel(settings.pttKey));
  const pttDisabled = settings.providerId === 'none' || voice.status === 'unsupported' || voice.status === 'permission_denied';
  const provider = STT_PROVIDER_NOTES[settings.providerId];

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

  const providerShort = settings.providerId === 'none' ? 'Voice off' : settings.providerId === 'deepgram' ? 'Deepgram' : settings.providerId === 'whisper-local' ? 'Local Whisper' : 'Browser speech';

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
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2">
        <div className="flex items-stretch gap-2">
          <select
            aria-label="Controller position"
            data-testid="position-select"
            value={choice}
            onChange={(e) => setChoice(e.target.value as PositionChoice)}
            className={`${INPUT} h-[38px] flex-1 appearance-none`}
          >
            {(Object.keys(POSITION_CHOICES) as PositionChoice[]).map((k) => (
              <option key={k} value={k}>{POSITION_NAMES[k]}</option>
            ))}
          </select>
          <div className="flex min-w-[118px] flex-col items-end justify-center border border-atc-border bg-atc-bg px-2" data-testid="frequency">
            {freqs.map((f) => (
              <div key={f.id} className="flex items-baseline gap-2 leading-tight">
                <span className="text-[10px] text-atc-muted">{f.id}</span>
                <span className={`${freqs.length > 1 ? 'text-[13px]' : 'text-[18px]'} font-semibold tabular-nums text-atc-green`}>{formatMhz(f.mhz)}</span>
              </div>
            ))}
          </div>
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
        <div className="line-clamp-2 min-h-[30px] text-[11px] leading-snug text-atc-muted" data-testid="mic-status" title={status.text}>{status.text}</div>
        <div className="flex items-baseline gap-2 text-[11.5px]">
          <span className={LABEL}>Heard</span>
          <span className="min-w-0 flex-1 truncate text-atc-text" data-testid="partial">{voice.partial || <span className="text-atc-muted/60">—</span>}</span>
        </div>

        <div className="flex flex-col gap-1">
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
            <span className={`min-h-4 min-w-0 flex-1 truncate text-[11px] ${resultTone}`} data-testid="last-result" title={last?.message}>
              {last ? last.message : <span className="text-atc-muted">Spoken and typed calls use the same parser.</span>}
            </span>
            <span className="shrink-0 text-[10px] text-atc-muted"><Kbd>Enter</Kbd> focus · <Kbd>↑</Kbd><Kbd>↓</Kbd> history</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
