import { addWindowListener } from '../layout/windows';
import { useEffect, useState } from 'react';
import { STT_PROVIDER_NOTES, VOICE_PRIVACY_NOTES, TRANSCRIPT_STORAGE_KEY, createBrowserTts, createWebSpeechProvider, getLocalWhisperProvider, unlockAudio } from '../../voice';
import type { SttProviderId, WhisperProgress } from '../../voice';
import { voiceSettings, useVoiceSettings } from '../store/voiceSettings';
import { isStaticHosting } from '../../hosting';
import { keyLabel } from '../lib/voiceStatus';
import { Btn, Field, Kbd, SELECT, Toggle } from './ui';

function useProviderAvailability(id: SttProviderId): { checking: boolean; available: boolean | null; detail?: string } {
  const [state, setState] = useState<{ checking: boolean; available: boolean | null; detail?: string }>({ checking: true, available: null });
  useEffect(() => {
    let cancelled = false;
    setState({ checking: true, available: null });
    (async () => {
      try {
        if (id === 'none') return !cancelled && setState({ checking: false, available: true, detail: 'No microphone needed.' });
        if (id === 'webspeech') {
          const ok = await createWebSpeechProvider().isAvailable();
          return !cancelled && setState({ checking: false, available: ok, detail: ok ? 'Speech recognition is available in this browser.' : 'This browser has no Web Speech recognition (use Chrome or Edge, or Deepgram).' });
        }
        if (id === 'whisper-local') {
          const ok = await getLocalWhisperProvider().isAvailable();
          return !cancelled && setState({ checking: false, available: ok, detail: ok ? 'Runs on this device (WebAssembly). Prepare the model once below; your voice never leaves this computer.' : 'This browser lacks WebAssembly or microphone support.' });
        }
        if (isStaticHosting()) return !cancelled && setState({ checking: false, available: false, detail: 'Deepgram needs the local backend (npm run server). It is not available on this hosted site; use Web Speech or Local Whisper.' });
        const res = await fetch('/api/voice/deepgram-token', { headers: { Accept: 'application/json' } });
        const body = (await res.json().catch(() => ({}))) as { configured?: boolean };
        if (cancelled) return;
        if (res.ok && body.configured) setState({ checking: false, available: true, detail: 'Deepgram key is configured on the local server.' });
        else setState({ checking: false, available: false, detail: 'No Deepgram key on the local server. Start it with DEEPGRAM_API_KEY set (see src/voice/README.md).' });
      } catch {
        if (!cancelled) setState({ checking: false, available: false, detail: 'Local backend not reachable (run `npm run server`).' });
      }
    })();
    return () => { cancelled = true; };
  }, [id]);
  return state;
}

/** One shared speech provider for the "Play test call" button (the session has its own). */
let testTts: ReturnType<typeof createBrowserTts> | undefined;

function PilotVoiceTest() {
  const [state, setState] = useState<{ voices: number; supported: boolean; playing: boolean }>({ voices: 0, supported: true, playing: false });
  useEffect(() => {
    testTts ??= createBrowserTts();
    const tts = testTts;
    let alive = true;
    void tts.whenVoicesReady().then((n) => alive && setState((s) => ({ ...s, voices: n, supported: tts.isSupported() })));
    return () => { alive = false; };
  }, []);
  const play = async () => {
    unlockAudio();
    testTts ??= createBrowserTts();
    const s = voiceSettings.get();
    setState((x) => ({ ...x, playing: true }));
    await testTts.speak({ text: 'Atlantic City Tower, Cessna seven two three echo juliet, holding short runway one three, ready for departure.', voiceId: 'voice-1', rate: s.ttsRate, volume: s.ttsVolume });
    setState((x) => ({ ...x, playing: false }));
  };
  return (
    <div className="flex items-center gap-2 border border-atc-border px-2 py-1.5" data-testid="pilot-voice-test">
      <Btn size="xs" onClick={() => { void play(); }} disabled={!state.supported || state.playing} data-testid="play-test-call">{state.playing ? 'Speaking…' : 'Play test call'}</Btn>
      <span className={state.supported && state.voices > 0 ? 'text-atc-muted' : 'text-atc-amber'}>
        {!state.supported ? 'This browser has no speech synthesis: pilots can only be read, not heard.' : state.voices === 0 ? 'No speech voices found yet. Install a system voice or try Chrome / Edge.' : `${state.voices} voices available; each aircraft gets its own voice.`}
      </span>
    </div>
  );
}

function LocalModelControls() {
  const provider = getLocalWhisperProvider();
  const [p, setP] = useState<WhisperProgress>(provider.getProgress());
  useEffect(() => provider.onProgress(setP), [provider]);
  const busy = p.phase === 'downloading' || p.phase === 'loading';
  return (
    <div className="flex flex-col gap-1.5 border border-atc-border px-2 py-1.5" data-testid="whisper-model">
      <div className="flex items-center gap-2">
        <Btn size="xs" onClick={() => { void provider.warmUp().catch(() => undefined); }} disabled={busy || p.phase === 'ready'} data-testid="whisper-warmup">
          {p.phase === 'ready' ? 'Local model ready' : busy ? 'Preparing…' : 'Download / prepare local model'}
        </Btn>
        <span className="text-atc-muted" data-testid="whisper-phase" data-phase={p.phase}>{p.phase}</span>
      </div>
      {busy && <progress className="h-1.5 w-full" max={100} value={p.percent} aria-label="Local model download progress" />}
      <span className={p.phase === 'error' ? 'text-atc-amber' : 'text-atc-muted'} data-testid="whisper-message" role="status">{p.message}</span>
    </div>
  );
}

export function VoiceSettingsForm({ compact = false }: { compact?: boolean }) {
  const s = useVoiceSettings();
  const [capturing, setCapturing] = useState(false);
  const avail = useProviderAvailability(s.providerId);
  const note = STT_PROVIDER_NOTES[s.providerId];

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setCapturing(false);
      voiceSettings.update({ pttKey: e.code && e.code !== 'Unidentified' ? e.code : e.key });
      setCapturing(false);
    };
    return addWindowListener('keydown', onKey, true);
  }, [capturing]);

  return (
    <div className="flex flex-col gap-4 text-xs">
      <section className="flex flex-col gap-2.5">
        <h3 className="font-sans text-[11px] font-semibold uppercase tracking-[0.18em] text-atc-cyan">Speech input (microphone)</h3>
        <Field label="Recognition provider">
          <select className={SELECT} value={s.providerId} onChange={(e) => voiceSettings.update({ providerId: e.target.value as SttProviderId })} aria-label="Recognition provider">
            {(Object.keys(STT_PROVIDER_NOTES) as SttProviderId[]).map((id) => (
              <option key={id} value={id}>{STT_PROVIDER_NOTES[id].label}</option>
            ))}
          </select>
        </Field>
        <p className="leading-snug text-atc-muted">{note.summary}</p>
        <div className={`border px-2 py-1.5 leading-snug ${avail.available === false ? 'border-atc-amber/60 text-atc-amber' : 'border-atc-border text-atc-muted'}`}>
          {avail.checking ? 'Checking availability…' : avail.detail}
        </div>
        {s.providerId === 'whisper-local' && <LocalModelControls />}
        <div className="border border-atc-border bg-atc-bg px-2 py-1.5 leading-snug text-atc-muted">
          <b className="text-atc-text">Where your audio goes: </b>{note.audioGoesTo} <span className="text-atc-muted">Cost: {note.cost}</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Push-to-talk key">
            <Btn onClick={() => setCapturing(true)} tone={capturing ? 'amber' : 'default'} aria-label="Change push-to-talk key">
              {capturing ? 'Press a key… (Esc)' : <>Key: <Kbd>{keyLabel(s.pttKey)}</Kbd></>}
            </Btn>
          </Field>
          <Field label="PTT mode">
            <select className={SELECT} value={s.pttMode} onChange={(e) => voiceSettings.update({ pttMode: e.target.value as 'hold' | 'toggle' })} aria-label="PTT mode">
              <option value="hold">Hold to talk</option>
              <option value="toggle">Press to start / stop</option>
            </select>
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.18em] text-atc-cyan">Pilot voices and radio</h3>
        <Toggle checked={s.ttsEnabled} onChange={(v) => voiceSettings.update({ ttsEnabled: v })} label="Pilot audio" hint="Pilots (and AI controllers you can hear) are spoken aloud by browser text-to-speech, one voice per aircraft. Off = text only. This is separate from the microphone." />
        <Toggle checked={s.monitorAll} onChange={(v) => voiceSettings.update({ monitorAll: v })} label="Monitor all frequencies" hint="Also hear the positions you do not work (AI Tower, Ground...) and their pilots, at lower volume. Default: only your own frequencies." />
        <PilotVoiceTest />
        <div className="grid grid-cols-2 gap-3 py-1">
          <Field label={`Volume ${Math.round(s.ttsVolume * 100)}%`}>
            <input type="range" min={0} max={1} step={0.05} value={s.ttsVolume} onChange={(e) => voiceSettings.update({ ttsVolume: Number(e.target.value) })} className="accent-[#39c5e8]" aria-label="Pilot voice volume" />
          </Field>
          <Field label={`Speech rate ${s.ttsRate.toFixed(2)}×`}>
            <input type="range" min={0.5} max={2} step={0.05} value={s.ttsRate} onChange={(e) => voiceSettings.update({ ttsRate: Number(e.target.value) })} className="accent-[#39c5e8]" aria-label="Pilot voice rate" />
          </Field>
        </div>
        <Toggle checked={s.radioEffectsEnabled} onChange={(v) => voiceSettings.update({ radioEffectsEnabled: v })} label="Radio effects" hint="Key-up and key-down clicks. The browser cannot filter the synthesised voice itself." />
      </section>

      {!compact && (
        <section className="flex flex-col gap-1">
          <h3 className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.18em] text-atc-cyan">Privacy</h3>
          <Toggle checked={s.storeTranscripts} onChange={(v) => voiceSettings.update({ storeTranscripts: v })} label="Store transcripts in this browser" hint="Off by default. Text only, never audio." />
          <Btn size="xs" className="self-start" onClick={() => { try { localStorage.removeItem(TRANSCRIPT_STORAGE_KEY); } catch { /* ignore */ } }}>Erase stored transcripts</Btn>
        </section>
      )}
      <section className="flex flex-col gap-1.5 border-t border-atc-border pt-3 leading-snug text-atc-muted">
        <p className="text-atc-text">{VOICE_PRIVACY_NOTES.headline}</p>
        <p>{VOICE_PRIVACY_NOTES.recordings}</p>
        {!compact && <p>{VOICE_PRIVACY_NOTES.transcripts}</p>}
        <p>{VOICE_PRIVACY_NOTES.analytics}</p>
      </section>
    </div>
  );
}
