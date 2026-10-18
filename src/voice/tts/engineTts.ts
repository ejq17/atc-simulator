/**
 * Wiring for the pilot voice engine setting: one shared neural synthesiser (the model is loaded once per page), a
 * provider that follows `settings.ttsEngine` at speak time, and the helper that finds the radio chain to play through.
 */
import { getSharedAudioContext } from '../audio/unlock.ts';
import type { RadioEffects } from '../audio/radioEffects.ts';
import { getSharedVoiceSettingsStore } from '../settings.ts';
import type { VoiceSettingsStore } from '../settings.ts';
import { createKokoroSynth } from './kokoroSynth.ts';
import { createNeuralTts } from './neuralTts.ts';
import type { NeuralTts, RadioOutput } from './neuralTts.ts';
import type { NeuralSynth } from './neuralTypes.ts';
import type { SpeakRequest, SpeechSynthesisProvider } from './types.ts';

type SharedSynth = ReturnType<typeof createKokoroSynth>;
let sharedSynth: SharedSynth | null = null;

/** The one app-wide neural synthesiser (Settings progress bar, test button and the running session all share it). */
export function getSharedNeuralSynth(settings: VoiceSettingsStore = getSharedVoiceSettingsStore()): SharedSynth {
  if (!sharedSynth) {
    const synth = createKokoroSynth({ getDeviceChoice: () => settings.get().neuralDevice });
    sharedSynth = synth;
    // Debug hook for e2e/neural-tts.spec.ts and for measuring latency by hand.
    if (typeof window !== 'undefined') (globalThis as unknown as { __kacyNeuralSynth?: SharedSynth }).__kacyNeuralSynth = synth;
    let device = settings.get().neuralDevice;
    settings.subscribe((s) => {
      if (s.neuralDevice !== device) {
        device = s.neuralDevice;
        synth.setDeviceChoice();
        if (s.ttsEngine === 'neural') void synth.ensureLoaded().catch(() => undefined);
      }
    });
  }
  return sharedSynth;
}

/** Where neural speech is played: the radio chain when radio effects are on, else straight to the speakers. */
export function radioOutputFor(radio?: RadioEffects): () => RadioOutput | null {
  return () => {
    let ctx = radio?.getContext() ?? null;
    let input: AudioNode | null = null;
    if (radio?.isEnabled()) {
      input = radio.getInputNode();
      ctx = radio.getContext();
    }
    ctx ??= radio?.getContext() ?? getSharedAudioContext();
    if (!ctx) return null;
    return { ctx, destination: input ?? ctx.destination };
  };
}

export interface EngineTtsOptions {
  browser: SpeechSynthesisProvider;
  neural: NeuralTts;
  getEngine: () => 'browser' | 'neural';
}

/** Speaks with the engine chosen in Settings (read for every call, so switching needs no restart). */
export function createEngineTts(o: EngineTtsOptions): SpeechSynthesisProvider {
  return {
    speak: (req: SpeakRequest) => (o.getEngine() === 'neural' ? o.neural.speak(req) : o.browser.speak(req)),
    cancel() {
      o.neural.cancel();
      o.browser.cancel();
    },
    listVoices: () => o.browser.listVoices(),
    prepare(req) {
      if (o.getEngine() === 'neural') o.neural.prepare(req);
    },
    keysOnStart: () => o.getEngine() === 'neural',
  };
}

/** Convenience for the session: the neural provider on the shared synthesiser, falling back to `browser`. */
export function createSessionNeuralTts(browser: SpeechSynthesisProvider, radio: RadioEffects | undefined, synth: NeuralSynth = getSharedNeuralSynth()): NeuralTts {
  const neural = createNeuralTts({ synth, fallback: browser, getOutput: radioOutputFor(radio), onEvent: recordNeuralEvent, latencyBudgetMs: budgetOverride() });
  try {
    const w = globalThis as unknown as { __kacyNeuralTts?: NeuralDebug };
    (w.__kacyNeuralTts ??= { events: [] }).getStats = () => neural.getStats();
  } catch { /* debugging only */ }
  return neural;
}

/** localStorage `kacy.neural.budgetMs` raises or lowers the latency budget (slow CPUs, tests). Unset = the provider default. */
function budgetOverride(): number | undefined {
  try {
    const n = Number(typeof localStorage !== 'undefined' ? localStorage.getItem('kacy.neural.budgetMs') : null);
    return Number.isFinite(n) && n >= 200 && n <= 600_000 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Debug record (window.__kacyNeuralTts) so tests and bug reports can see what the neural voice did. */
export interface NeuralDebug {
  events: Array<Record<string, unknown>>;
  getStats?: () => unknown;
}
function recordNeuralEvent(e: Record<string, unknown>) {
  try {
    const w = globalThis as unknown as { __kacyNeuralTts?: NeuralDebug };
    const dbg = (w.__kacyNeuralTts ??= { events: [] });
    dbg.events.push({ ...e, atMs: Date.now() });
    if (dbg.events.length > 200) dbg.events.splice(0, dbg.events.length - 200);
  } catch { /* never let debugging break speech */ }
}
