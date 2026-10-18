import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNeuralTts } from './neuralTts.ts';
import type { NeuralTtsEvent, RadioOutput } from './neuralTts.ts';
import type { NeuralProgress, NeuralSynth, PcmAudio, SynthesisRequest } from './neuralTypes.ts';
import type { SpeakRequest, SpeechSynthesisProvider } from './types.ts';
import type { TransmissionGraph, TransmissionGraphOptions } from '../audio/transmissionGraph.ts';

interface Deferred { req: SynthesisRequest; resolve(a?: PcmAudio): void; reject(e: Error): void }

/** A synthesiser the test completes by hand. */
function mockSynth(ready = true) {
  const calls: Deferred[] = [];
  const state = { ready, loads: 0 };
  const synth: NeuralSynth = {
    ensureLoaded: () => { state.loads++; return Promise.resolve(); },
    isReady: () => state.ready,
    synthesize: (req) => new Promise<PcmAudio>((resolve, reject) => {
      calls.push({ req, resolve: (a) => resolve(a ?? { samples: new Float32Array(2400), sampleRate: 24000 }), reject });
    }),
    getProgress: (): NeuralProgress => ({ phase: state.ready ? 'ready' : 'idle', percent: 0, message: '' }),
    onProgress: () => () => undefined,
    dispose: () => undefined,
  };
  return { synth, calls, state };
}

function mockFallback() {
  const spoken: SpeakRequest[] = [];
  let cancels = 0;
  const provider: SpeechSynthesisProvider = {
    speak: (req) => { spoken.push(req); req.onStart?.(); req.onEnd?.(); return Promise.resolve(); },
    cancel: () => { cancels++; },
    listVoices: () => [],
  };
  return { provider, spoken, cancels: () => cancels };
}

/** A graph whose end the test controls. */
function mockGraphFactory() {
  const built: Array<{ opts: TransmissionGraphOptions; started: boolean; stopped: boolean; finished: boolean; appended: AudioBuffer[]; end(): void }> = [];
  const build = (opts: TransmissionGraphOptions): TransmissionGraph => {
    let end: () => void = () => undefined;
    const ended = new Promise<void>((r) => { end = r; });
    const rec = { opts, started: false, stopped: false, finished: false, appended: [] as AudioBuffer[], end: () => end() };
    built.push(rec);
    return {
      nodes: {} as TransmissionGraph['nodes'], totalSec: 1, speechSec: 0.9, ended,
      start: () => { rec.started = true; },
      append: (a) => { rec.appended.push(a); },
      finish: () => { rec.finished = true; },
      stop: () => { rec.stopped = true; end(); },
    };
  };
  return { build, built };
}

const fakeCtx = {
  createBuffer: (_c: number, len: number, rate: number) => {
    const data = new Float32Array(len);
    return { length: len, sampleRate: rate, duration: len / rate, getChannelData: () => data };
  },
};
const output: RadioOutput = { ctx: fakeCtx as unknown as AudioContext, destination: {} as AudioNode };

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const req = (text: string, extra: Partial<SpeakRequest> = {}): SpeakRequest => ({ text, voiceId: 'v1', callsign: 'N723EJ', volume: 0.9, ...extra });

describe('neural TTS provider', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function make(over: { ready?: boolean; output?: RadioOutput | null; budget?: number; maxFailures?: number; cacheSize?: number } = {}) {
    const m = mockSynth(over.ready ?? true);
    const f = mockFallback();
    const g = mockGraphFactory();
    const events: NeuralTtsEvent[] = [];
    const tts = createNeuralTts({
      synth: m.synth, fallback: f.provider, getOutput: () => (over.output === undefined ? output : over.output), buildGraph: g.build,
      latencyBudgetMs: over.budget ?? 1000, maxConsecutiveFailures: over.maxFailures ?? 2, cooldownMs: 5000, cacheSize: over.cacheSize,
      onEvent: (e) => events.push(e),
    });
    return { tts, m, f, g, events };
  }

  it('synthesises with the callsign voice, plays through the graph, and reports start and end', async () => {
    const { tts, m, g } = make();
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const done = tts.speak(req('Runway one three, cleared for takeoff', { onStart, onEnd }));
    await flush();
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].req.voice.length).toBeGreaterThan(2);
    expect(m.calls[0].req.text).toContain('cleared for takeoff');
    expect(g.built).toHaveLength(0);
    m.calls[0].resolve();
    await flush();
    expect(g.built).toHaveLength(1);
    expect(g.built[0].started).toBe(true);
    expect(g.built[0].opts.volume).toBeCloseTo(0.9);
    expect(g.built[0].opts.audio.sampleRate).toBe(24000);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    g.built[0].end();
    await done;
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(tts.getStats().played).toBe(1);
  });

  it('keys up (PTT click) right before the first sound: after synthesis, with the graph start, once per call', async () => {
    const { tts, m, g } = make();
    const order: string[] = [];
    const done = tts.speak(req('keyed call', { onKeyUp: () => order.push(`key:${g.built.length}:${g.built[0]?.started ?? false}`), onStart: () => order.push('start') }));
    await flush();
    expect(order).toEqual([]); // model still working: no click yet
    m.calls[0].resolve();
    await flush();
    expect(order).toEqual(['key:1:false', 'start']); // graph built, not yet started, when the click is requested
    g.built[0].end();
    await done;
  });

  it('keys up before the browser voice when it falls back', async () => {
    const { tts, f } = make({ ready: false });
    const onKeyUp = vi.fn();
    await tts.speak(req('fallback call', { onKeyUp }));
    expect(onKeyUp).toHaveBeenCalledTimes(1);
    expect(f.spoken).toHaveLength(1);
  });

  it('uses the same voice and radio character for the same callsign and applies distance to the conditions', async () => {
    const { tts, m, g } = make();
    const a = tts.speak(req('one', { distanceNm: 2 }));
    await flush();
    m.calls[0].resolve();
    await flush();
    g.built[0].end();
    await a;
    const b = tts.speak(req('two', { distanceNm: 40 }));
    await flush();
    m.calls[1].resolve();
    await flush();
    g.built[1].end();
    await b;
    expect(m.calls[1].req.voice).toBe(m.calls[0].req.voice);
    expect(m.calls[1].req.speed).toBeCloseTo(m.calls[0].req.speed, 6);
    expect(g.built[0].opts.conditions.quality).toBe(1);
    expect(g.built[1].opts.conditions.quality).toBeLessThan(0.2);
    expect(g.built[1].opts.conditions.noiseFloor).toBeGreaterThan(g.built[0].opts.conditions.noiseFloor);
  });

  it('picks the Piper speaker id when the loaded engine is Piper', async () => {
    const m = mockSynth(true);
    (m.synth as { getEngine?: () => 'piper' }).getEngine = () => 'piper';
    const tts = createNeuralTts({ synth: m.synth, fallback: mockFallback().provider, getOutput: () => output, buildGraph: mockGraphFactory().build });
    void tts.speak(req('hello there'));
    await flush();
    expect(m.calls[0].req.voice).toMatch(/^\d+$/);
  });

  it('keeps the tempo when pitch-shifting: model speed times playback rate equals the profile rate times the user rate', async () => {
    const { tts, m, g } = make();
    void tts.speak(req('hello there', { rate: 1.2 }));
    await flush();
    m.calls[0].resolve();
    await flush();
    const tempo = m.calls[0].req.speed * g.built[0].opts.playbackRate;
    expect(tempo).toBeGreaterThan(0.9 * 1.2);
    expect(tempo).toBeLessThan(1.18 * 1.2 + 0.001);
  });

  it('prepare() synthesises ahead, and speak() then reuses that result without a second model call', async () => {
    const { tts, m, g } = make();
    tts.prepare(req('next call'));
    await flush();
    expect(m.calls).toHaveLength(1);
    m.calls[0].resolve();
    await flush();
    const done = tts.speak(req('next call'));
    await flush();
    expect(m.calls).toHaveLength(1); // cached
    expect(g.built).toHaveLength(1);
    expect(tts.getStats().cacheHits).toBe(1);
    g.built[0].end();
    await done;
  });

  it('pre-synthesises the next call while the current one plays, so there is no gap', async () => {
    const { tts, m, g } = make();
    const first = tts.speak(req('first call', { callsign: 'N1A' }));
    await flush();
    m.calls[0].resolve();
    await flush();
    expect(g.built).toHaveLength(1); // first is playing
    tts.prepare(req('second call', { callsign: 'N2B' }));
    await flush();
    expect(m.calls).toHaveLength(2); // model works while the first one plays
    m.calls[1].resolve();
    await flush();
    g.built[0].end();
    await first;
    const second = tts.speak(req('second call', { callsign: 'N2B' }));
    await flush();
    expect(g.built).toHaveLength(2); // started immediately, no waiting on the model
    expect(g.built[1].started).toBe(true);
    g.built[1].end();
    await second;
  });

  it('runs model calls one at a time, in order', async () => {
    const { tts, m } = make();
    tts.prepare(req('a', { callsign: 'N1A' }));
    tts.prepare(req('b', { callsign: 'N2B' }));
    await flush();
    expect(m.calls).toHaveLength(1);
    m.calls[0].resolve();
    await flush();
    expect(m.calls).toHaveLength(2);
  });

  it('falls back to the browser voice while the model is not ready, and keeps loading it', async () => {
    const { tts, m, f, events } = make({ ready: false });
    await tts.speak(req('hello'));
    expect(f.spoken).toHaveLength(1);
    expect(m.state.loads).toBe(1);
    expect(m.calls).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'fallback', reason: 'not_ready' }));
    tts.prepare(req('hello'));
    expect(m.calls).toHaveLength(0);
  });

  it('falls back when no audio output exists', async () => {
    const { tts, f } = make({ output: null });
    await tts.speak(req('hello'));
    expect(f.spoken).toHaveLength(1);
    expect(tts.getStats().fallbacks.no_audio_output).toBe(1);
  });

  it('falls back to the browser voice when synthesis exceeds the latency budget', async () => {
    const { tts, m, f, g } = make({ budget: 1000, maxFailures: 5 });
    const done = tts.speak(req('slow call'));
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(f.spoken).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    await done;
    expect(f.spoken).toHaveLength(1);
    expect(f.spoken[0].text).toBe('slow call');
    expect(tts.getStats().fallbacks.budget).toBe(1);
    // The late audio is discarded, never played over the browser voice.
    m.calls[0].resolve();
    await flush();
    expect(g.built).toHaveLength(0);
  });

  it('measures the budget from the moment speak() is called, not from the prepare() request', async () => {
    const { tts, m, g } = make({ budget: 1000 });
    tts.prepare(req('queued call'));
    await flush();
    await vi.advanceTimersByTimeAsync(4000); // the call waited its turn behind another transmission
    const done = tts.speak(req('queued call'));
    await flush();
    await vi.advanceTimersByTimeAsync(300);
    m.calls[0].resolve();
    await flush();
    expect(g.built).toHaveLength(1); // still within 1000 ms of speak()
    g.built[0].end();
    await done;
  });

  it('falls back on a synthesis error, does not cache the failure, and retries the model next time', async () => {
    const { tts, m, f, g } = make({ maxFailures: 5 });
    const a = tts.speak(req('boom'));
    await flush();
    m.calls[0].reject(new Error('model crashed'));
    await a;
    expect(f.spoken).toHaveLength(1);
    expect(tts.getStats().fallbacks.error).toBe(1);
    const b = tts.speak(req('boom'));
    await flush();
    expect(m.calls).toHaveLength(2);
    m.calls[1].resolve();
    await flush();
    g.built[0].end();
    await b;
    expect(f.spoken).toHaveLength(1);
  });

  it('switches the neural voice off for a cool-down after repeated failures, then recovers', async () => {
    const { tts, m, f, events } = make({ maxFailures: 2 });
    for (let i = 0; i < 2; i++) {
      const p = tts.speak(req(`fail ${i}`));
      await flush();
      m.calls[i].reject(new Error('nope'));
      await p;
    }
    expect(events).toContainEqual(expect.objectContaining({ type: 'cooldown' }));
    expect(tts.getStats().coolingDown).toBe(true);
    await tts.speak(req('during cooldown'));
    expect(m.calls).toHaveLength(2); // the model was not asked again
    expect(f.spoken).toHaveLength(3);
    expect(tts.getStats().fallbacks.cooldown).toBe(1);
    await vi.advanceTimersByTimeAsync(5001);
    expect(tts.getStats().coolingDown).toBe(false);
    void tts.speak(req('after cooldown'));
    await flush();
    expect(m.calls).toHaveLength(3);
  });

  it('a successful call resets the failure run', async () => {
    const { tts, m, g } = make({ maxFailures: 2 });
    const fail = tts.speak(req('x'));
    await flush();
    m.calls[0].reject(new Error('nope'));
    await fail;
    const ok = tts.speak(req('y'));
    await flush();
    m.calls[1].resolve();
    await flush();
    g.built[0].end();
    await ok;
    const fail2 = tts.speak(req('z'));
    await flush();
    m.calls[2].reject(new Error('nope'));
    await fail2;
    expect(tts.getStats().coolingDown).toBe(false);
  });

  it('cancel() stops the playing transmission, the fallback, and suppresses audio that arrives afterwards', async () => {
    const { tts, m, f, g } = make();
    const playing = tts.speak(req('playing', { callsign: 'N1A' }));
    await flush();
    m.calls[0].resolve();
    await flush();
    tts.cancel();
    await playing;
    expect(g.built[0].stopped).toBe(true);
    expect(f.cancels()).toBe(1);

    const waiting = tts.speak(req('waiting', { callsign: 'N2B' }));
    await flush();
    tts.cancel(); // stepped on while the model is still working
    m.calls[1].resolve();
    await waiting;
    expect(g.built).toHaveLength(1);
    expect(f.spoken).toHaveLength(0);
  });

  it('keeps a cancelled call in the cache so the stepped-on retry needs no new model call', async () => {
    const { tts, m, g } = make();
    const first = tts.speak(req('retry me'));
    await flush();
    tts.cancel();
    m.calls[0].resolve();
    await first;
    const again = tts.speak(req('retry me'));
    await flush();
    expect(m.calls).toHaveLength(1);
    expect(g.built).toHaveLength(1);
    g.built[0].end();
    await again;
  });

  it('uses a prepared result once: an identical later call is synthesised again', async () => {
    const { tts, m, g } = make();
    const a = tts.speak(req('same words'));
    await flush();
    m.calls[0].resolve();
    await flush();
    g.built[0].end();
    await a;
    void tts.speak(req('same words'));
    await flush();
    expect(m.calls).toHaveLength(2);
  });

  it('bounds the cache', async () => {
    const { tts, m } = make({ cacheSize: 2 });
    for (const [i, c] of ['N1A', 'N2B', 'N3C'].entries()) {
      tts.prepare(req(`call ${i}`, { callsign: c }));
      await flush();
      m.calls[i].resolve();
      await flush();
    }
    tts.prepare(req('call 0', { callsign: 'N1A' })); // evicted: needs the model again
    await flush();
    expect(m.calls).toHaveLength(4);
  });

  it('records time to first audio from the request', async () => {
    const { tts, m, g } = make();
    const done = tts.speak(req('timing'));
    await flush();
    await vi.advanceTimersByTimeAsync(700);
    m.calls[0].resolve();
    await flush();
    expect(tts.getStats().lastFirstAudioMs).toBeGreaterThanOrEqual(700);
    expect(tts.getStats().lastFirstAudioMs).toBeLessThan(900);
    g.built[0].end();
    await done;
  });

  describe('long calls are split and streamed', () => {
    const LONG = 'Runway one three, cleared for takeoff, Cessna seven two three echo juliet, contact departure one two zero point three';

    it('starts playing after the first piece and appends the rest in order', async () => {
      const { tts, m, g } = make();
      const done = tts.speak(req(LONG));
      await flush();
      expect(m.calls).toHaveLength(1); // the model takes one piece at a time
      expect(m.calls[0].req.text).toBe('Runway one three,');
      expect(g.built).toHaveLength(0);
      m.calls[0].resolve();
      await flush();
      expect(g.built).toHaveLength(1); // audio starts with only the first piece done
      expect(g.built[0].started).toBe(true);
      expect(g.built[0].appended).toHaveLength(0);
      for (let i = 1; m.calls.length > i; i++) {
        m.calls[i].resolve();
        await flush();
        expect(g.built[0].appended).toHaveLength(i);
      }
      expect(m.calls.length).toBeGreaterThan(2);
      expect(g.built[0].finished).toBe(true);
      expect(m.calls.map((c) => c.req.text).join(' ')).toBe('Runway one three, cleared for takeoff, Cessna seven two three echo juliet, contact departure one two zero point three');
      g.built[0].end();
      await done;
      expect(tts.getStats().played).toBe(1);
    });

    it('says the unsynthesised rest with the browser voice if a later piece fails', async () => {
      const { tts, m, f, g } = make({ maxFailures: 9 });
      const onEnd = vi.fn();
      const done = tts.speak(req(LONG, { onEnd }));
      await flush();
      m.calls[0].resolve();
      await flush();
      m.calls[1].reject(new Error('worker died'));
      await flush();
      g.built[0].end();
      await done;
      expect(g.built[0].finished).toBe(true);
      expect(f.spoken).toHaveLength(1);
      expect(f.spoken[0].text.startsWith(m.calls[1].req.text)).toBe(true);
      expect(f.spoken[0].text).toContain('zero point three');
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it('a cancel in the middle of a streamed call stops it and speaks nothing more', async () => {
      const { tts, m, f, g } = make();
      const done = tts.speak(req(LONG));
      await flush();
      m.calls[0].resolve();
      await flush();
      tts.cancel();
      m.calls[1].resolve();
      await done;
      expect(g.built[0].stopped).toBe(true);
      expect(g.built[0].appended).toHaveLength(0);
      expect(f.spoken).toHaveLength(0);
    });
  });
});
