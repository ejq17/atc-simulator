/**
 * Test/diagnostic window into the pilot voice layer: `window.__kacyTts`.
 *
 * Present in every non-production build, and in a production build when localStorage `kacy.debug.tts` is "1" (set by the
 * real-Chrome Playwright test, which can therefore run against `vite preview` too). It records what the app ASKED the browser to
 * say and what the browser then did (utterance `start` / `end` / `error`), which is the only observable proof that a pilot was
 * audible without a person listening.
 */

export interface KacyTtsUtterance {
  /** The request text (what the engine's pilot said, e.g. the readback). */
  text: string;
  /** The text actually handed to the browser after `prepareForTts` (usually identical). */
  utterance: string;
  voiceId: string;
  /** Browser voice the profile resolved to, or null for the browser default. */
  voiceName: string | null;
  voiceUri: string | null;
  rate: number;
  pitch: number;
  volume: number;
  requestedAtMs: number;
  startedAtMs?: number;
  endedAtMs?: number;
  /** 'end' = spoken to the end; 'error:<code>' = the browser reported an error (interrupted / canceled / not-allowed...); 'timeout'. */
  outcome?: string;
}

export interface KacyTtsDebug {
  supported: boolean;
  /** `speechSynthesis.getVoices().length` as last seen. */
  voices: number;
  voiceNames: string[];
  /** Texts whose utterance `onstart` fired, in order. */
  started: string[];
  /** Texts whose utterance ended normally. */
  ended: string[];
  errors: { text: string; error: string }[];
  spoken: KacyTtsUtterance[];
  /** Result of the user-gesture unlock (`unlockAudio`). */
  unlock?: { at: number; audioContext: string; ttsPrimed: boolean; voices: number };
}

declare global {
  interface Window {
    __kacyTts?: KacyTtsDebug;
  }
}

function enabled(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const prod = Boolean((import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD);
    if (!prod) return true;
    return window.localStorage?.getItem('kacy.debug.tts') === '1';
  } catch {
    return false;
  }
}

/** The debug object, created on first use, or undefined when debugging is off. */
export function ttsDebug(): KacyTtsDebug | undefined {
  if (!enabled()) return undefined;
  const w = window;
  w.__kacyTts ??= { supported: false, voices: 0, voiceNames: [], started: [], ended: [], errors: [], spoken: [] };
  return w.__kacyTts;
}
