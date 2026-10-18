/**
 * Neural pilot voice: a `SpeechSynthesisProvider` that synthesises speech with an on-device model (Kokoro-82M) into an
 * AudioBuffer and plays it through the radio chain, which `speechSynthesis` cannot do.
 *
 * - The next queued transmission is synthesised while the current one plays (`prepare`), results are cached briefly so a
 *   stepped-on call that is retried does not need the model again.
 * - The browser provider is the automatic fallback: model not ready (it keeps loading in the background), synthesis failed,
 *   or synthesis did not finish within the latency budget. A run of failures switches the neural voice off for a cool-down.
 * - Per-aircraft voice, rate, pitch and radio character come from `radioVariation.ts`, keyed by callsign.
 */
import { buildTransmissionGraph } from '../audio/transmissionGraph.ts';
import type { TransmissionGraph } from '../audio/transmissionGraph.ts';
import type { NeuralSynth, PcmAudio } from './neuralTypes.ts';
import { prepareForNeuralTts } from './prepareForTts.ts';
import { splitSpeech, trimSilence } from './speechChunks.ts';
import { assignNeuralProfile, classifyCallsign, isOvermodulated, radioConditions } from './radioVariation.ts';
import type { NeuralVoiceProfile } from './radioVariation.ts';
import type { SpeakRequest, SpeechSynthesisProvider } from './types.ts';
import { hashString } from './voiceAssignment.ts';

export interface RadioOutput {
  ctx: AudioContext;
  /** The radio chain input when radio effects are on, otherwise the plain context destination. */
  destination: AudioNode;
}

export type FallbackReason = 'not_ready' | 'budget' | 'error' | 'no_audio_output' | 'cooldown';

export type NeuralTtsEvent =
  | { type: 'synth'; text: string; voice: string; ms: number; audioSec: number; peak: number; rms: number }
  | { type: 'play'; text: string; voice: string; sinceRequestMs: number; speechSec: number }
  | { type: 'fallback'; reason: FallbackReason; text: string; detail?: string }
  | { type: 'cooldown'; untilMs: number; reason: 'budget' | 'error' };

export interface NeuralTtsStats {
  synthesized: number;
  cacheHits: number;
  played: number;
  fallbacks: Record<FallbackReason, number>;
  /** Model time of the last synthesis (including waiting for the worker), ms. */
  lastSynthMs: number | null;
  /** From `speak`/`prepare` being called to the first sample being scheduled, ms. */
  lastFirstAudioMs: number | null;
  coolingDown: boolean;
}

export interface NeuralTtsOptions {
  synth: NeuralSynth;
  fallback: SpeechSynthesisProvider;
  getOutput: () => RadioOutput | null;
  /** Longest wait for synthesis once `speak` is called before the browser voice takes over. Default 3000 ms. */
  latencyBudgetMs?: number;
  /** Consecutive budget overruns or errors that switch the neural voice off for `cooldownMs`. Default 3. */
  maxConsecutiveFailures?: number;
  cooldownMs?: number;
  /** Synthesised calls kept for reuse (also bounds how far ahead `prepare` works). Default 6. */
  cacheSize?: number;
  now?: () => number;
  /** Injectable for tests. */
  buildGraph?: typeof buildTransmissionGraph;
  onEvent?: (e: NeuralTtsEvent) => void;
}

interface Plan {
  key: string;
  text: string;
  chunks: string[];
  profile: NeuralVoiceProfile;
  speed: number;
  /** The engine voice for this plan (Kokoro voice id or Piper speaker id). */
  voice: string;
  playbackRate: number;
  callsign: string;
  conditionsInput: { distanceNm?: number };
}

interface Entry {
  key: string;
  requestedAt: number;
  /** One synthesis per piece of the call, in speaking order. */
  chunks: Array<{ text: string; promise: Promise<PcmAudio> }>;
}

const TIMEOUT = Symbol('budget');

/** Peak and RMS of a synthesised piece (diagnostics: proves the model produced real, non-silent speech). */
function levelOf(samples: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak: Math.round(peak * 1000) / 1000, rms: samples.length ? Math.round(Math.sqrt(sum / samples.length) * 10000) / 10000 : 0 };
}
const MODEL_SPEED_RANGE: readonly [number, number] = [0.6, 1.6];

export type NeuralTts = SpeechSynthesisProvider & {
  /** Start synthesising a call that is expected soon. No-op while the model is not ready or the voice is cooling down. */
  prepare(req: SpeakRequest): void;
  getStats(): NeuralTtsStats;
  /** Forget a cool-down, e.g. after the user pressed the test button. */
  reset(): void;
};

export function createNeuralTts(options: NeuralTtsOptions): NeuralTts {
  const { synth, fallback } = options;
  const now = options.now ?? (() => Date.now());
  const budgetMs = options.latencyBudgetMs ?? 3000;
  const maxFailures = options.maxConsecutiveFailures ?? 3;
  const cooldownMs = options.cooldownMs ?? 60_000;
  const cacheSize = options.cacheSize ?? 6;
  const build = options.buildGraph ?? buildTransmissionGraph;
  const emit = (e: NeuralTtsEvent) => options.onEvent?.(e);

  const cache = new Map<string, Entry>();
  let chain: Promise<unknown> = Promise.resolve();
  let epoch = 0;
  let current: TransmissionGraph | null = null;
  let failures = 0;
  let cooldownUntil = 0;
  const stats: NeuralTtsStats = {
    synthesized: 0, cacheHits: 0, played: 0, lastSynthMs: null, lastFirstAudioMs: null, coolingDown: false,
    fallbacks: { not_ready: 0, budget: 0, error: 0, no_audio_output: 0, cooldown: 0 },
  };

  const coolingDown = () => now() < cooldownUntil;

  function plan(req: SpeakRequest): Plan {
    const callsign = (req.callsign ?? req.voiceId).trim() || req.voiceId;
    const kind = req.speakerKind ?? classifyCallsign(callsign);
    const profile = assignNeuralProfile(callsign, kind);
    const playbackRate = 2 ** (profile.pitchCents / 1200);
    // Tempo after playback = model speed x playbackRate, so divide the pitch shift back out to keep the pace.
    const wanted = profile.rate * Math.min(2, Math.max(0.5, req.rate ?? 1));
    const speed = Math.min(MODEL_SPEED_RANGE[1], Math.max(MODEL_SPEED_RANGE[0], wanted / playbackRate));
    const text = prepareForNeuralTts(req.text);
    const voice = synth.getEngine?.() === 'piper' ? String(profile.piperSid) : profile.voice;
    return {
      key: `${voice}|${speed.toFixed(3)}|${text}`, voice, text, chunks: splitSpeech(text), profile, speed, playbackRate, callsign,
      conditionsInput: { distanceNm: req.distanceNm },
    };
  }

  function start(p: Plan): Entry {
    const hit = cache.get(p.key);
    if (hit) {
      stats.cacheHits++;
      return hit;
    }
    const requestedAt = now();
    const entry: Entry = { key: p.key, requestedAt, chunks: [] };
    p.chunks.forEach((text, i) => {
      // The model handles one piece at a time; keep requests in order.
      const run = chain.then(() => synth.synthesize({ text, voice: p.voice, speed: p.speed }));
      chain = run.catch(() => undefined);
      entry.chunks.push({ text, promise: run });
      run.then(
        (pcm) => {
          stats.synthesized++;
          if (i === 0) stats.lastSynthMs = now() - requestedAt;
          const level = levelOf(pcm.samples);
          emit({ type: 'synth', text, voice: p.voice, ms: now() - requestedAt, audioSec: pcm.samples.length / pcm.sampleRate, ...level });
        },
        () => {
          if (cache.get(p.key) === entry) cache.delete(p.key); // failures are not cached
        },
      );
    });
    cache.set(p.key, entry);
    while (cache.size > cacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return entry;
  }

  function useFallback(req: SpeakRequest, reason: FallbackReason, detail?: string): Promise<void> {
    stats.fallbacks[reason]++;
    emit({ type: 'fallback', reason, text: req.text, detail });
    req.onKeyUp?.(); // the browser voice starts now: click with it
    return fallback.speak(req);
  }

  function noteFailure(kind: 'budget' | 'error') {
    failures++;
    if (failures >= maxFailures) {
      failures = 0;
      cooldownUntil = now() + cooldownMs;
      stats.coolingDown = true;
      emit({ type: 'cooldown', untilMs: cooldownUntil, reason: kind });
    }
  }

  function toBuffer(ctx: AudioContext, pcm: PcmAudio): AudioBuffer {
    const samples = trimSilence(pcm.samples, pcm.sampleRate);
    const buf = ctx.createBuffer(1, samples.length, pcm.sampleRate);
    buf.getChannelData(0).set(samples);
    return buf;
  }

  async function waitWithin<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, ms));
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    listVoices: () => fallback.listVoices(),
    keysOnStart: () => true,
    getStats: () => ({ ...stats, fallbacks: { ...stats.fallbacks }, coolingDown: coolingDown() }),
    reset() {
      failures = 0;
      cooldownUntil = 0;
      stats.coolingDown = false;
    },
    prepare(req) {
      if (!synth.isReady() || coolingDown() || !options.getOutput()) return;
      for (const c of start(plan(req)).chunks) c.promise.catch(() => undefined);
    },
    cancel() {
      epoch++;
      current?.stop();
      current = null;
      fallback.cancel();
    },
    async speak(req) {
      const myEpoch = epoch;
      const calledAt = now();
      if (coolingDown()) return useFallback(req, 'cooldown');
      if (!synth.isReady()) {
        void synth.ensureLoaded().catch(() => undefined); // keep loading in the background; this call uses the browser voice
        return useFallback(req, 'not_ready');
      }
      const out = options.getOutput();
      if (!out) return useFallback(req, 'no_audio_output');
      const p = plan(req);
      const entry = start(p);

      let first: PcmAudio | typeof TIMEOUT;
      try {
        first = await waitWithin(entry.chunks[0].promise, budgetMs);
      } catch (cause) {
        if (myEpoch !== epoch) return void req.onEnd?.();
        noteFailure('error');
        return useFallback(req, 'error', cause instanceof Error ? cause.message : String(cause));
      }
      if (myEpoch !== epoch) return void req.onEnd?.(); // stepped on or cleared while waiting
      if (first === TIMEOUT) {
        noteFailure('budget');
        return useFallback(req, 'budget', `no audio within ${budgetMs} ms`);
      }
      failures = 0;

      const overmod = isOvermodulated(p.callsign, p.text, p.profile.radio.overmodChance);
      const conditions = radioConditions(p.profile.radio, { distanceNm: p.conditionsInput.distanceNm, overmodulated: overmod });
      let graph: TransmissionGraph;
      try {
        graph = build({
          ctx: out.ctx, destination: out.destination, audio: toBuffer(out.ctx, first), conditions,
          volume: Math.min(1, Math.max(0, req.volume ?? 1)), playbackRate: p.playbackRate, seed: hashString(`${p.callsign}|${p.text}`),
        });
      } catch (cause) {
        noteFailure('error');
        return useFallback(req, 'error', cause instanceof Error ? cause.message : String(cause));
      }
      current?.stop();
      current = graph;
      req.onKeyUp?.(); // PTT click at the same instant as the carrier and the first piece
      graph.start();
      if (cache.get(p.key) === entry) cache.delete(p.key); // single use: an identical later call is a new transmission
      stats.played++;
      stats.lastFirstAudioMs = now() - Math.min(calledAt, entry.requestedAt);
      emit({ type: 'play', text: p.text, voice: p.voice, sinceRequestMs: stats.lastFirstAudioMs, speechSec: graph.speechSec });
      req.onStart?.();

      // The rest of the call is appended as it is synthesised (usually already done: the model is faster than speech).
      let unspoken = '';
      for (let i = 1; i < entry.chunks.length; i++) {
        let next: PcmAudio | typeof TIMEOUT | undefined;
        try {
          next = await waitWithin(entry.chunks[i].promise, budgetMs);
        } catch {
          next = undefined;
        }
        if (myEpoch !== epoch) {
          await graph.ended;
          return void req.onEnd?.();
        }
        if (next === undefined || next === TIMEOUT) {
          noteFailure(next === TIMEOUT ? 'budget' : 'error');
          unspoken = entry.chunks.slice(i).map((c) => c.text).join(' ');
          break;
        }
        graph.append(toBuffer(out.ctx, next));
      }
      graph.finish();
      await graph.ended;
      if (current === graph) current = null;
      if (unspoken && myEpoch === epoch) {
        // A later piece failed or was too slow: say the rest with the browser voice rather than dropping part of the call.
        stats.fallbacks.error++;
        emit({ type: 'fallback', reason: 'error', text: unspoken, detail: 'partial: later piece unavailable' });
        await fallback.speak({ ...req, text: unspoken, onKeyUp: undefined, onStart: undefined, onEnd: undefined });
      }
      req.onEnd?.();
    },
  };
}
