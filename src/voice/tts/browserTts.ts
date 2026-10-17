import type { SpeakRequest, SpeechSynthesisProvider, VoiceInfo } from './types.ts';
import { prepareForTts } from './prepareForTts.ts';
import { assignVoice } from './voiceAssignment.ts';
import { ttsDebug } from './ttsDebug.ts';
import type { KacyTtsUtterance } from './ttsDebug.ts';

export interface BrowserTtsOptions {
  /** Injectable for tests; defaults to `window.speechSynthesis`. */
  synth?: SpeechSynthesis;
  /** Injectable for tests; defaults to the global constructor. */
  UtteranceCtor?: typeof SpeechSynthesisUtterance;
  /** Run text through prepareForTts (default true). */
  prepare?: boolean;
  /** How long the first `speak` waits for Chrome's asynchronous voice list before using the default voice. Default 2000 ms. */
  voicesTimeoutMs?: number;
}

function toInfo(v: SpeechSynthesisVoice): VoiceInfo {
  return { id: v.voiceURI, name: v.name, lang: v.lang, localService: v.localService, isDefault: v.default };
}

/**
 * Chrome drops an utterance whose JS object was garbage collected before it finished (no `end`, sometimes no sound), so every
 * in-flight utterance is kept reachable here until it ends.
 */
const inFlight = new Set<SpeechSynthesisUtterance>();

export function createBrowserTts(options: BrowserTtsOptions = {}): SpeechSynthesisProvider & { isSupported(): boolean; whenVoicesReady(): Promise<number> } {
  const synth = options.synth ?? (typeof speechSynthesis !== 'undefined' ? speechSynthesis : undefined);
  const Utterance = options.UtteranceCtor ?? (typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : undefined);
  const prepare = options.prepare ?? true;

  let nativeVoices: SpeechSynthesisVoice[] = synth?.getVoices() ?? [];
  const publishVoices = () => {
    const dbg = ttsDebug();
    if (dbg) {
      dbg.supported = Boolean(synth && Utterance);
      dbg.voices = nativeVoices.length;
      dbg.voiceNames = nativeVoices.map((v) => v.name);
    }
  };
  // Voices load asynchronously in Chrome (`voiceschanged`); keep the cache fresh and let the first call wait for them.
  let voicesLoaded = nativeVoices.length > 0;
  let resolveVoices: (n: number) => void = () => undefined;
  const voicesReady = new Promise<number>((resolve) => { resolveVoices = resolve; });
  if (voicesLoaded) resolveVoices(nativeVoices.length);
  synth?.addEventListener?.('voiceschanged', () => {
    nativeVoices = synth.getVoices();
    publishVoices();
    if (nativeVoices.length > 0) {
      voicesLoaded = true;
      resolveVoices(nativeVoices.length);
    }
  });
  publishVoices();
  const whenVoicesReady = (): Promise<number> => {
    if (voicesLoaded || !synth) return Promise.resolve(nativeVoices.length);
    const timeout = new Promise<number>((resolve) => setTimeout(() => resolve(synth.getVoices().length), options.voicesTimeoutMs ?? 2000));
    return Promise.race([voicesReady, timeout]).then((n) => {
      // Some browsers never fire `voiceschanged` but do have the voices by now.
      nativeVoices = synth.getVoices();
      voicesLoaded = nativeVoices.length > 0;
      publishVoices();
      return n;
    });
  };
  const refresh = () => {
    if (synth && nativeVoices.length === 0) nativeVoices = synth.getVoices();
    return nativeVoices;
  };

  let current: { finish: () => void } | null = null;

  return {
    isSupported: () => Boolean(synth && Utterance),
    whenVoicesReady,
    listVoices: () => refresh().map(toInfo),
    cancel() {
      if (!synth) return;
      const c = current;
      synth.cancel();
      c?.finish();
    },
    speak(req: SpeakRequest) {
      if (!synth || !Utterance) {
        req.onEnd?.();
        return Promise.resolve();
      }
      // First call in a fresh Chrome: wait (bounded) for the voice list so the pilot gets its own voice, not the default one.
      if (!voicesLoaded) return whenVoicesReady().then(() => speakNow(synth, Utterance, req));
      return speakNow(synth, Utterance, req);
    },
  };

  function speakNow(synth: SpeechSynthesis, Utterance: typeof SpeechSynthesisUtterance, req: SpeakRequest): Promise<void> {
    const spoken = prepare ? prepareForTts(req.text) : req.text;
    const natives = refresh();
    const infos = natives.map(toInfo);
    const profile = assignVoice(req.voiceId, infos);
    const dbg = ttsDebug();
    publishVoices();

    return new Promise<void>((resolve) => {
      const u = new Utterance(spoken);
      let chosen: SpeechSynthesisVoice | undefined;
      if (profile.voice) {
        chosen = natives.find((v) => v.voiceURI === profile.voice?.id);
        if (chosen) u.voice = chosen;
      }
      u.lang = profile.voice?.lang ?? 'en-US';
      u.rate = Math.min(2, Math.max(0.5, profile.rate * (req.rate ?? 1)));
      u.pitch = Math.min(2, Math.max(0, profile.pitch * (req.pitch ?? 1)));
      u.volume = Math.min(1, Math.max(0, req.volume ?? 1));

      const rec: KacyTtsUtterance | undefined = dbg && {
        text: req.text, utterance: spoken, voiceId: req.voiceId, voiceName: chosen?.name ?? null, voiceUri: chosen?.voiceURI ?? null,
        rate: u.rate, pitch: u.pitch, volume: u.volume, requestedAtMs: Date.now(),
      };
      if (dbg && rec) dbg.spoken.push(rec);

      const cur = { finish: () => finish('cancelled') };
      let done = false;
      let safety: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: string) => {
        if (done) return;
        done = true;
        clearTimeout(safety);
        inFlight.delete(u);
        if (current === cur) current = null;
        if (rec) {
          rec.endedAtMs = Date.now();
          rec.outcome = outcome;
        }
        if (dbg) {
          if (outcome === 'end') dbg.ended.push(req.text);
          else dbg.errors.push({ text: req.text, error: outcome });
        }
        req.onEnd?.();
        resolve();
      };
      current = cur;
      u.onstart = () => {
        if (rec) rec.startedAtMs = Date.now();
        dbg?.started.push(req.text);
        req.onStart?.();
      };
      u.onend = () => finish('end');
      u.onerror = (e) => finish(`error:${(e as SpeechSynthesisErrorEvent).error ?? 'unknown'}`); // canceled / interrupted / not-allowed ...
      // Some browsers never fire `end` (long utterances, tab throttling).
      const words = spoken.split(/\s+/).length;
      safety = setTimeout(() => {
        synth.cancel();
        finish('timeout');
      }, 4000 + (words * 600) / Math.max(0.5, u.rate));
      // A previous cancel() or a hidden-tab throttle can leave the queue paused, which silences every later utterance.
      if (synth.paused) synth.resume();
      inFlight.add(u);
      synth.speak(u);
    });
  }
}
