import type { SpeakRequest, SpeechSynthesisProvider, VoiceInfo } from './types.ts';
import { prepareForTts } from './prepareForTts.ts';
import { assignVoice } from './voiceAssignment.ts';

export interface BrowserTtsOptions {
  /** Injectable for tests; defaults to `window.speechSynthesis`. */
  synth?: SpeechSynthesis;
  /** Injectable for tests; defaults to the global constructor. */
  UtteranceCtor?: typeof SpeechSynthesisUtterance;
  /** Run text through prepareForTts (default true). */
  prepare?: boolean;
}

function toInfo(v: SpeechSynthesisVoice): VoiceInfo {
  return { id: v.voiceURI, name: v.name, lang: v.lang, localService: v.localService, isDefault: v.default };
}

export function createBrowserTts(options: BrowserTtsOptions = {}): SpeechSynthesisProvider & { isSupported(): boolean } {
  const synth = options.synth ?? (typeof speechSynthesis !== 'undefined' ? speechSynthesis : undefined);
  const Utterance = options.UtteranceCtor ?? (typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : undefined);
  const prepare = options.prepare ?? true;

  let nativeVoices: SpeechSynthesisVoice[] = synth?.getVoices() ?? [];
  // Voices load asynchronously in Chrome; keep the cache fresh.
  synth?.addEventListener?.('voiceschanged', () => {
    nativeVoices = synth.getVoices();
  });
  const refresh = () => {
    if (synth && nativeVoices.length === 0) nativeVoices = synth.getVoices();
    return nativeVoices;
  };

  let current: { finish: () => void } | null = null;

  return {
    isSupported: () => Boolean(synth && Utterance),
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
      const spoken = prepare ? prepareForTts(req.text) : req.text;
      const natives = refresh();
      const infos = natives.map(toInfo);
      const profile = assignVoice(req.voiceId, infos);

      return new Promise<void>((resolve) => {
        const u = new Utterance(spoken);
        if (profile.voice) {
          const match = natives.find((v) => v.voiceURI === profile.voice?.id);
          if (match) u.voice = match;
        }
        u.lang = profile.voice?.lang ?? 'en-US';
        u.rate = Math.min(2, Math.max(0.5, profile.rate * (req.rate ?? 1)));
        u.pitch = Math.min(2, Math.max(0, profile.pitch * (req.pitch ?? 1)));
        u.volume = Math.min(1, Math.max(0, req.volume ?? 1));

        let done = false;
        let safety: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(safety);
          if (current?.finish === finish) current = null;
          req.onEnd?.();
          resolve();
        };
        current = { finish };
        u.onstart = () => req.onStart?.();
        u.onend = finish;
        u.onerror = finish; // 'canceled' / 'interrupted' / failures all just end the turn
        // Some browsers never fire `end` (long utterances, tab throttling).
        const words = spoken.split(/\s+/).length;
        safety = setTimeout(() => {
          synth.cancel();
          finish();
        }, 4000 + (words * 600) / Math.max(0.5, u.rate));
        synth.speak(u);
      });
    },
  };
}
