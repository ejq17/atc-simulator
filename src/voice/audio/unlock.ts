/**
 * Browser autoplay policies: audio only plays after a user gesture. `unlockAudio()` must therefore be called synchronously from a
 * click handler (the setup screen's "Start session"). It
 *   - creates the app-wide AudioContext and resumes it (radio clicks, static),
 *   - primes speech synthesis with a silent utterance (Chrome refuses `speak()` until the page has been activated),
 *   - touches `getVoices()` so Chrome starts loading its voice list (it arrives later via `voiceschanged`).
 * Safe to call repeatedly and where no audio exists (tests, SSR).
 */
import { ttsDebug } from '../tts/ttsDebug.ts';

let sharedCtx: AudioContext | null = null;

/** The one AudioContext of the page; created lazily. Radio effects use it so that unlocking it once unlocks them all. */
export function getSharedAudioContext(): AudioContext | null {
  if (sharedCtx) return sharedCtx;
  try {
    const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    sharedCtx = Ctor ? new Ctor() : null;
  } catch {
    sharedCtx = null;
  }
  return sharedCtx;
}

export interface AudioUnlockResult {
  audioContext: AudioContextState | 'unsupported';
  ttsPrimed: boolean;
  voices: number;
}

export function unlockAudio(): AudioUnlockResult {
  let audioContext: AudioUnlockResult['audioContext'] = 'unsupported';
  const ctx = getSharedAudioContext();
  if (ctx) {
    try {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      // A one-sample silent buffer completes the unlock on Safari / iOS.
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* ignore */
    }
    audioContext = ctx.state;
  }

  let ttsPrimed = false;
  let voices = 0;
  try {
    const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : undefined;
    if (synth && typeof SpeechSynthesisUtterance !== 'undefined') {
      voices = synth.getVoices().length;
      if (synth.paused) synth.resume();
      const u = new SpeechSynthesisUtterance('.');
      u.volume = 0;
      u.rate = 2;
      synth.speak(u);
      ttsPrimed = true;
    }
  } catch {
    /* speech unavailable */
  }
  const dbg = ttsDebug();
  if (dbg) dbg.unlock = { at: Date.now(), audioContext, ttsPrimed, voices };
  return { audioContext, ttsPrimed, voices };
}
