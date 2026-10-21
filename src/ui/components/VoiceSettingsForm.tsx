import { addWindowListener } from '../layout/windows';
import { useEffect, useState } from 'react';
import { STT_PROVIDER_NOTES, VOICE_PRIVACY_NOTES, TRANSCRIPT_STORAGE_KEY, NEURAL_MODEL_MB, createBrowserTts, createRadioEffects, createSessionNeuralTts, createWebSpeechProvider, deviceLabel, getLocalWhisperProvider, getSharedNeuralSynth, hasWebGpu, isWebGpuMarkedFailed, resolveNeuralDevice, resolveWhisper, unlockAudio, WHISPER_MODELS } from '../../voice';
import type { NeuralDeviceChoice, NeuralProgress, NeuralTts, SttProviderId, TtsEngineId, WhisperDeviceChoice, WhisperModelChoice, WhisperProgress } from '../../voice';
import { voiceSettings, useVoiceSettings } from '../store/voiceSettings';
import { isStaticHosting } from '../../hosting';
import { checkLlmAvailability } from '../../commands/llm/client';
import type { LlmAvailability } from '../../commands/llm/client';
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
          return !cancelled && setState({ checking: false, available: ok, detail: ok ? 'Runs on this device (GPU when available, else CPU). Prepare the model once below; your voice never leaves this computer.' : 'This browser lacks WebAssembly or microphone support.' });
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

function useLlmAvailability(): { checking: boolean } & Partial<LlmAvailability> {
  const [state, setState] = useState<{ checking: boolean } & Partial<LlmAvailability>>({ checking: true });
  useEffect(() => {
    let cancelled = false;
    void checkLlmAvailability().then((a) => { if (!cancelled) setState({ checking: false, ...a }); });
    return () => { cancelled = true; };
  }, []);
  return state;
}

/** Settings block for the phrase interpreter fallback (src/commands/llm). */
function PhraseInterpreterSettings() {
  const s = useVoiceSettings();
  const avail = useLlmAvailability();
  return (
    <section className="flex flex-col gap-1.5" data-testid="phrase-interpreter">
      <h3 className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.18em] text-atc-cyan">Phrase interpreter</h3>
      <Toggle checked={s.interpreterEnabled} onChange={(v) => voiceSettings.update({ interpreterEnabled: v })} label="Phrase interpreter" hint="When the rule grammar is unsure about a radio call, ask a language model to read it. Clear instructions are never sent." />
      <div className={`border px-2 py-1.5 leading-snug ${avail.available === false ? 'border-atc-amber/60 text-atc-amber' : 'border-atc-border text-atc-muted'}`} data-testid="phrase-interpreter-status" role="status">
        {avail.checking ? 'Checking availability…' : avail.available ? `Available: model ${avail.model ?? 'configured on the local backend'}.` : avail.detail}
      </div>
      <p className="leading-snug text-atc-muted" data-testid="phrase-interpreter-privacy">{VOICE_PRIVACY_NOTES.interpreter}</p>
    </section>
  );
}

/** One shared speech provider for the "Play test call" button (the session has its own). */
let testTts: ReturnType<typeof createBrowserTts> | undefined;
let testNeural: NeuralTts | undefined;

const TEST_CALL = 'Atlantic City Tower, Cessna seven two three echo juliet, holding short runway one three, ready for departure.';

/** One-time hint for machines with WebGPU: the realistic radio voices exist and how big the download is. Remembered once dismissed. */
function NeuralVoiceNotice() {
  const s = useVoiceSettings();
  if (s.ttsEngine !== 'browser' || s.neuralNoticeDismissed || !hasWebGpu()) return null;
  const enable = () => {
    voiceSettings.update({ ttsEngine: 'neural', neuralNoticeDismissed: true });
    unlockAudio();
    void getSharedNeuralSynth(voiceSettings).ensureLoaded().catch(() => undefined);
  };
  return (
    <div className="flex flex-col gap-1.5 border border-atc-cyan/60 px-2 py-1.5 leading-snug" data-testid="neural-notice" role="note">
      <span><b className="text-atc-text">Realistic radio voices available.</b> <span className="text-atc-muted">Pilots and controllers can sound like a VHF radio, generated on this computer&apos;s GPU. One-time download of {NEURAL_MODEL_MB.webgpu} MB, no account, works offline afterwards.</span></span>
      <div className="flex gap-2">
        <Btn size="xs" onClick={enable} data-testid="neural-notice-enable">Enable and download</Btn>
        <Btn size="xs" onClick={() => voiceSettings.update({ neuralNoticeDismissed: true })} data-testid="neural-notice-dismiss">Not now</Btn>
      </div>
    </div>
  );
}

function PilotVoiceTest() {
  const engine = useVoiceSettings().ttsEngine;
  const [state, setState] = useState<{ voices: number; supported: boolean; playing: boolean }>({ voices: 0, supported: true, playing: false });
  useEffect(() => {
    testTts ??= createBrowserTts();
    const tts = testTts;
    let alive = true;
    void tts.whenVoicesReady().then((n) => alive && setState((s) => ({ ...s, voices: n, supported: tts.isSupported() })));
    return () => { alive = false; };
  }, []);
  const play = async (distanceNm?: number) => {
    unlockAudio();
    testTts ??= createBrowserTts();
    const s = voiceSettings.get();
    setState((x) => ({ ...x, playing: true }));
    try {
      if (s.ttsEngine === 'neural') {
        testNeural ??= createSessionNeuralTts(testTts, testRadio(), getSharedNeuralSynth(voiceSettings));
        testNeural.reset();
        await testNeural.speak({ text: TEST_CALL, voiceId: 'voice-1', callsign: 'N723EJ', distanceNm, rate: s.ttsRate, volume: s.ttsVolume });
      } else {
        await testTts.speak({ text: TEST_CALL, voiceId: 'voice-1', rate: s.ttsRate, volume: s.ttsVolume });
      }
    } finally {
      setState((x) => ({ ...x, playing: false }));
    }
  };
  return (
    <div className="flex items-center gap-2 border border-atc-border px-2 py-1.5" data-testid="pilot-voice-test">
      <Btn size="xs" onClick={() => { void play(); }} disabled={!state.supported || state.playing} data-testid="play-test-call">{state.playing ? 'Speaking…' : 'Play test call'}</Btn>
      {engine === 'neural' && <Btn size="xs" onClick={() => { void play(35); }} disabled={state.playing} data-testid="play-test-call-far">Play distant call (35 nm)</Btn>}
      <span className={state.supported && state.voices > 0 ? 'text-atc-muted' : 'text-atc-amber'}>
        {!state.supported ? 'This browser has no speech synthesis: pilots can only be read, not heard.' : state.voices === 0 ? 'No speech voices found yet. Install a system voice or try Chrome / Edge.' : `${state.voices} voices available; each aircraft gets its own voice.`}
      </span>
    </div>
  );
}

let sharedTestRadio: ReturnType<typeof createRadioEffects> | undefined;
/** The Settings test button needs a radio chain even before a session exists. */
function testRadio() {
  sharedTestRadio ??= createRadioEffects({ enabled: voiceSettings.get().radioEffectsEnabled });
  sharedTestRadio.setEnabled(voiceSettings.get().radioEffectsEnabled);
  return sharedTestRadio;
}

const NEURAL_DEVICE_OPTIONS: Array<[NeuralDeviceChoice, string]> = [['auto', 'Auto'], ['wasm', 'CPU (WebAssembly)'], ['webgpu', 'GPU (WebGPU)']];

function NeuralVoiceControls() {
  const s = useVoiceSettings();
  const synth = getSharedNeuralSynth(voiceSettings);
  const gpu = hasWebGpu();
  const device = resolveNeuralDevice(s.neuralDevice, gpu, false);
  const [p, setP] = useState<NeuralProgress>(synth.getProgress());
  useEffect(() => synth.onProgress(setP), [synth]);
  const busy = p.phase === 'downloading' || p.phase === 'loading';
  return (
    <div className="flex flex-col gap-1.5 border border-atc-border px-2 py-1.5" data-testid="neural-voice">
      <Field label="Run the voice model on">
        <select className={SELECT} value={s.neuralDevice} onChange={(e) => voiceSettings.update({ neuralDevice: e.target.value as NeuralDeviceChoice })} aria-label="Neural voice device" data-testid="neural-device-select">
          {NEURAL_DEVICE_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>{v === 'auto' ? `Auto (${gpu ? 'GPU' : 'CPU'})` : label}</option>
          ))}
        </select>
      </Field>
      <span className="text-atc-muted" data-testid="neural-resolved">
        WebGPU: <b className={gpu ? 'text-atc-text' : 'text-atc-amber'} data-testid="neural-webgpu">{gpu ? 'available' : 'not available in this browser'}</b>. {device === 'webgpu' ? 'Kokoro-82M' : 'Piper (libritts_r)'} on {deviceLabel(device)}, about {NEURAL_MODEL_MB[device]} MB once (cached by the browser, then works offline).
        If the model is not ready, or a call takes too long to synthesise, that call is spoken by the browser voice instead.
      </span>
      <div className="flex items-center gap-2">
        <Btn size="xs" onClick={() => { void synth.ensureLoaded().catch(() => undefined); }} disabled={busy || p.phase === 'ready'} data-testid="neural-warmup">
          {p.phase === 'ready' ? 'Neural voice ready' : busy ? 'Preparing…' : p.phase === 'error' ? 'Retry download' : 'Download / prepare neural voice'}
        </Btn>
        <span className="text-atc-muted" data-testid="neural-phase" data-phase={p.phase}>{p.phase}</span>
      </div>
      {busy && <progress className="h-1.5 w-full" max={100} value={p.percent} aria-label="Neural voice download progress" />}
      <span className={p.phase === 'error' ? 'text-atc-amber' : 'text-atc-muted'} data-testid="neural-message" role="status">{p.message}</span>
    </div>
  );
}

const MODEL_ORDER = ['small.en', 'base.en', 'tiny.en'] as const;
const DEVICE_OPTIONS: Array<[WhisperDeviceChoice, string]> = [['auto', 'Auto'], ['wasm', 'CPU (WebAssembly)'], ['webgpu', 'GPU (WebGPU)']];

function LocalModelControls() {
  const provider = getLocalWhisperProvider();
  const s = useVoiceSettings();
  const gpu = hasWebGpu();
  const resolved = resolveWhisper(s.whisperModel, s.whisperDevice, { gpu, webGpuFailed: isWebGpuMarkedFailed() });
  const [p, setP] = useState<WhisperProgress>(provider.getProgress());
  useEffect(() => provider.onProgress(setP), [provider]);
  const busy = p.phase === 'downloading' || p.phase === 'loading';
  return (
    <div className="flex flex-col gap-1.5 border border-atc-border px-2 py-1.5" data-testid="whisper-model">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Speech model">
          <select className={SELECT} value={s.whisperModel} onChange={(e) => voiceSettings.update({ whisperModel: e.target.value as WhisperModelChoice })} aria-label="Speech model" data-testid="whisper-model-select">
            <option value="auto">Auto (small.en on GPU, else base.en)</option>
            {MODEL_ORDER.map((m) => (
              <option key={m} value={m}>{`${m} - ${WHISPER_MODELS[m].mb[resolved.device]} MB${m === 'tiny.en' ? ' (fastest)' : m === 'small.en' ? ' (most accurate)' : ''}`}</option>
            ))}
          </select>
        </Field>
        <Field label="Run on">
          <select className={SELECT} value={s.whisperDevice} onChange={(e) => voiceSettings.update({ whisperDevice: e.target.value as WhisperDeviceChoice })} aria-label="Speech device" data-testid="whisper-device-select">
            {DEVICE_OPTIONS.map(([v, label]) => (
              <option key={v} value={v}>{v === 'auto' ? `Auto (${gpu ? 'GPU' : 'CPU'})` : label}</option>
            ))}
          </select>
        </Field>
      </div>
      <span className="text-atc-muted" data-testid="whisper-resolved">
        Using Whisper {resolved.size} on {deviceLabel(resolved.device)}, about {resolved.mb} MB once. {WHISPER_MODELS[resolved.size].hint}
        {s.whisperDevice === 'webgpu' && !gpu ? ' This browser has no WebGPU, so the CPU is used.' : ''}
        {resolved.requestedDevice === 'webgpu' && resolved.device === 'wasm' && gpu ? ' WebGPU failed earlier in this session, so the CPU is used.' : ''}
      </span>
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
  const [capturing, setCapturingKey] = useState<'ptt' | 'landline' | null>(null);
  const setCapturing = (on: boolean) => setCapturingKey(on ? 'ptt' : null);
  const avail = useProviderAvailability(s.providerId);
  const note = STT_PROVIDER_NOTES[s.providerId];

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setCapturing(false);
      const key = e.code && e.code !== 'Unidentified' ? e.code : e.key;
      voiceSettings.update(capturing === 'landline' ? { landlineKey: key } : { pttKey: key });
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
            <Btn onClick={() => setCapturing(true)} tone={capturing === 'ptt' ? 'amber' : 'default'} aria-label="Change push-to-talk key">
              {capturing === 'ptt' ? 'Press a key… (Esc)' : <>Key: <Kbd>{keyLabel(s.pttKey)}</Kbd></>}
            </Btn>
          </Field>
          <Field label="Landline key (hold)" hint="Calls to the other positions, e.g. “Tower, Ground, cross runway one three at Alpha with Cessna …”.">
            <Btn onClick={() => setCapturingKey('landline')} tone={capturing === 'landline' ? 'amber' : 'default'} aria-label="Change landline key">
              {capturing === 'landline' ? 'Press a key… (Esc)' : <>Key: <Kbd>{keyLabel(s.landlineKey)}</Kbd></>}
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
        <Toggle checked={s.ttsEnabled} onChange={(v) => voiceSettings.update({ ttsEnabled: v })} label="Pilot audio" hint="Pilots (and AI controllers you can hear) are spoken aloud, one voice per aircraft (browser text-to-speech or the local neural voice, see Pilot voice engine). Off = text only. This is separate from the microphone." />
        <Toggle checked={s.monitorAll} onChange={(v) => voiceSettings.update({ monitorAll: v })} label="Monitor all frequencies" hint="Also hear the positions you do not work (AI Tower, Ground...) and their pilots, at lower volume. Default: only your own frequencies." />
        <NeuralVoiceNotice />
        <Field label="Pilot voice engine">
          <select className={SELECT} value={s.ttsEngine} onChange={(e) => voiceSettings.update({ ttsEngine: e.target.value as TtsEngineId })} aria-label="Pilot voice engine" data-testid="tts-engine-select">
            <option value="browser">Browser voices (instant, clean)</option>
            <option value="neural">Local neural voice (on-device, radio-filtered)</option>
          </select>
        </Field>
        {s.ttsEngine === 'neural' && <NeuralVoiceControls />}
        <PilotVoiceTest />
        <div className="grid grid-cols-2 gap-3 py-1">
          <Field label={`Volume ${Math.round(s.ttsVolume * 100)}%`}>
            <input type="range" min={0} max={1} step={0.05} value={s.ttsVolume} onChange={(e) => voiceSettings.update({ ttsVolume: Number(e.target.value) })} className="accent-[#39c5e8]" aria-label="Pilot voice volume" />
          </Field>
          <Field label={`Speech rate ${s.ttsRate.toFixed(2)}×`}>
            <input type="range" min={0.5} max={2} step={0.05} value={s.ttsRate} onChange={(e) => voiceSettings.update({ ttsRate: Number(e.target.value) })} className="accent-[#39c5e8]" aria-label="Pilot voice rate" />
          </Field>
        </div>
        <Toggle checked={s.radioEffectsEnabled} onChange={(v) => voiceSettings.update({ radioEffectsEnabled: v })} label="Radio effects" hint="Key-up and key-down clicks. With the local neural voice the pilot voices also go through the radio filter, with per-aircraft quality and distance fading; browser voices cannot be filtered." />
      </section>

      <PhraseInterpreterSettings />

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
