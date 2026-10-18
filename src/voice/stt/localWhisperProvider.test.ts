// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalWhisperProvider, LOCAL_WHISPER_ID, resetLocalWhisperBackends, WHISPER_PLACEHOLDER } from './localWhisperProvider.ts';
import type { TransformersModule, WorkerLike } from './localWhisperProvider.ts';
import type { WhisperWorkerEvent, WhisperWorkerRequest } from './whisperProtocol.ts';
import { createVoiceController } from '../voiceController.ts';
import { createVoiceSettingsStore } from '../settings.ts';
import { isWebGpuMarkedFailed, markWebGpuFailed } from './whisperModels.ts';
import { STT_PROVIDER_NOTES } from './providerNotes.ts';
import { SttError, sttErrorCode } from './types.ts';
import type { SttStartOptions } from './types.ts';

/** One second of a 440 Hz tone as Int16 PCM at 16 kHz. */
function tone(seconds = 1): ArrayBuffer {
  const a = new Int16Array(16000 * seconds);
  for (let i = 0; i < a.length; i++) a[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 8000);
  return a.buffer;
}

let uid = 0;
/** Unique model name per test so the module-level pipeline cache never leaks between tests. */
const model = () => `test/whisper-${uid++}.en`;

function harness(opts: { text?: string; pipelineError?: Error; chunk?: () => ArrayBuffer } = {}) {
  const asr = vi.fn(async (_audio: Float32Array, _o?: Record<string, unknown>) => ({ text: opts.text ?? ' Sessna 723 Echo Juliet Hold position' }));
  const pipeline = vi.fn(async (_task: string, _model: string, o?: Record<string, unknown>) => {
    const cb = o?.progress_callback as ((i: unknown) => void) | undefined;
    cb?.({ status: 'initiate', file: 'encoder.onnx' });
    cb?.({ status: 'progress', file: 'encoder.onnx', loaded: 5_000_000, total: 10_000_000 });
    cb?.({ status: 'progress', file: 'decoder.onnx', loaded: 0, total: 10_000_000 });
    cb?.({ status: 'done', file: 'encoder.onnx' });
    if (opts.pipelineError) throw opts.pipelineError;
    return asr;
  });
  const env: Record<string, unknown> = {};
  const loadTransformers = vi.fn(async () => ({ pipeline, env }) as unknown as TransformersModule);
  const trackStop = vi.fn();
  const capStop = vi.fn(async () => undefined);
  const startCapture = vi.fn(async (_s: MediaStream, onChunk: (pcm: ArrayBuffer) => void) => {
    onChunk((opts.chunk ?? (() => tone(1)))());
    return { stop: capStop, inputSampleRate: 16000 };
  });
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }) as unknown as MediaStream);
  let t = 1000;
  const provider = createLocalWhisperProvider({
    model: model(), loadTransformers, startCapture, getUserMedia, now: () => (t += 500),
  });
  const calls = { partial: [] as string[], final: [] as Array<[string, { confidence?: number; durationMs: number }]>, errors: [] as Error[] };
  const handlers: SttStartOptions = {
    onPartial: (x) => calls.partial.push(x),
    onFinal: (x, m) => calls.final.push([x, m]),
    onError: (e) => calls.errors.push(e),
  };
  return { provider, asr, pipeline, env, loadTransformers, capStop, startCapture, getUserMedia, calls, handlers };
}

beforeEach(() => vi.restoreAllMocks());

describe('local whisper settings copy', () => {
  it('is listed with the privacy statement that audio never leaves the machine', () => {
    const n = STT_PROVIDER_NOTES['whisper-local'];
    expect(n.label).toBe('Local Whisper (on-device, no cloud)');
    expect(n.audioGoesTo).toMatch(/Nowhere/);
    expect(n.audioGoesTo).toMatch(/no audio is uploaded/);
  });
});

describe('local whisper provider', () => {
  it('identifies itself and is available when WebAssembly and mediaDevices exist', async () => {
    const { provider } = harness();
    expect(provider.id).toBe(LOCAL_WHISPER_ID);
    expect(provider.label).toBe('Local Whisper (on-device, no cloud)');
    Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
    expect(await provider.isAvailable()).toBe(true);
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    expect(await provider.isAvailable()).toBe(false);
  });

  it('start/stop: buffers PCM, shows the Transcribing placeholder, then delivers a cleaned final with no confidence', async () => {
    const h = harness();
    await h.provider.start(h.handlers);
    expect(h.getUserMedia).toHaveBeenCalledOnce();
    expect(h.calls.partial).toEqual([]); // nothing streams while the key is held
    await h.provider.stop();

    expect(h.calls.partial[0]).toBe(WHISPER_PLACEHOLDER);
    expect(h.calls.final).toHaveLength(1);
    const [text, meta] = h.calls.final[0];
    expect(text).toBe('Cessna 723 Echo Juliet Hold position'); // post-processed
    expect(meta.confidence).toBeUndefined();
    expect(meta.durationMs).toBeGreaterThan(0);
    expect(h.calls.errors).toEqual([]);
    expect(h.capStop).toHaveBeenCalledOnce();

    // The audio handed to the model is 16 kHz float samples, ~1 s, English-only model => no language/task args.
    const [audio, callOpts] = h.asr.mock.calls[0];
    expect(audio).toBeInstanceOf(Float32Array);
    expect(audio.length).toBe(16000);
    expect(Math.max(...audio)).toBeLessThanOrEqual(1);
    expect(callOpts).toMatchObject({ return_timestamps: false });
    expect(callOpts).not.toHaveProperty('language');
    expect(callOpts).not.toHaveProperty('task');
    expect(h.env.allowLocalModels).toBe(false);
  });

  it('passes language and task only to multilingual checkpoints', async () => {
    const asr = vi.fn(async (_a: Float32Array, _o?: Record<string, unknown>) => ({ text: 'runway one three' }));
    const provider = createLocalWhisperProvider({
      model: 'onnx-community/whisper-base-test',
      loadTransformers: async () => ({ pipeline: async () => asr, env: {} }) as unknown as TransformersModule,
      getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
      startCapture: async (_s, onChunk) => { onChunk(tone(1)); return { stop: async () => undefined, inputSampleRate: 16000 }; },
    });
    const finals: string[] = [];
    await provider.start({ onPartial: () => undefined, onFinal: (t) => finals.push(t), onError: () => undefined });
    await provider.stop();
    expect(asr.mock.calls[0][1]).toMatchObject({ language: 'en', task: 'transcribe' });
    expect(finals).toEqual(['runway one three']);
  });

  it('records level statistics of the last capture (ambient noise = first 500 ms)', async () => {
    // 0.5 s of quiet noise (amplitude 0.01) followed by 0.5 s of a loud tone.
    const chunk = () => {
      const a = new Int16Array(16000);
      for (let i = 0; i < 8000; i++) a[i] = i % 2 ? 328 : -328;
      for (let i = 8000; i < 16000; i++) a[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 16000);
      return a.buffer;
    };
    const h = harness({ chunk });
    expect(h.provider.getLastCapture()).toBeNull();
    await h.provider.start(h.handlers);
    await h.provider.stop();
    const st = h.provider.getLastCapture()!;
    expect(st.seconds).toBeCloseTo(1, 5);
    expect(st.ambientRms).toBeCloseTo(0.01, 3);
    expect(st.ambientDbfs).toBeCloseTo(-40, 0);
    expect(st.peak).toBeGreaterThan(0.45);
    expect(st.rms).toBeGreaterThan(st.ambientRms);
  });

  it('builds the idle audio graph once, reuses it for every press, and releases it on dispose', async () => {
    const closeGraph = vi.fn(async () => undefined);
    const graph = { ctx: { state: 'running' } as unknown as AudioContext, workletReady: true, close: closeGraph };
    const warmUpAudio = vi.fn(async () => graph);
    const h = harness();
    const startCapture = vi.fn(async (_s: MediaStream, onChunk: (pcm: ArrayBuffer) => void, _w?: unknown) => {
      onChunk(tone(1));
      return { stop: async () => undefined, inputSampleRate: 16000 };
    });
    const provider = createLocalWhisperProvider({
      model: model(), loadTransformers: h.loadTransformers, getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
      startCapture, warmUpAudio,
    });
    await provider.prepare();
    await provider.start(h.handlers);
    await provider.stop();
    await provider.start(h.handlers);
    await provider.stop();
    expect(warmUpAudio).toHaveBeenCalledOnce();
    expect(startCapture.mock.calls.map((c) => c[2])).toEqual([graph, graph]);
    expect(closeGraph).not.toHaveBeenCalled();
    await provider.dispose();
    expect(closeGraph).toHaveBeenCalledOnce();
  });

  it('still captures (building its own graph) if the idle graph cannot be created', async () => {
    const h = harness();
    const provider = createLocalWhisperProvider({
      model: model(), loadTransformers: h.loadTransformers, getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
      startCapture: async (_s, onChunk, w) => { expect(w).toBeUndefined(); onChunk(tone(1)); return { stop: async () => undefined, inputSampleRate: 16000 }; },
      warmUpAudio: async () => { throw new Error('no AudioContext'); },
    });
    await provider.start(h.handlers);
    await provider.stop();
    expect(h.calls.final).toHaveLength(1);
  });

  it('loads the model once and reuses it across transmissions', async () => {
    const h = harness();
    await h.provider.start(h.handlers);
    await h.provider.stop();
    await h.provider.start(h.handlers);
    await h.provider.stop();
    expect(h.pipeline).toHaveBeenCalledOnce();
    expect(h.calls.final).toHaveLength(2);
  });

  it('reports aggregated download progress, then ready (warmUp)', async () => {
    const h = harness();
    const seen: Array<{ phase: string; percent: number }> = [];
    const off = h.provider.onProgress((p) => seen.push({ phase: p.phase, percent: p.percent }));
    expect(seen[0]).toEqual({ phase: 'idle', percent: 0 }); // replays current state
    await h.provider.warmUp();
    off();
    expect(h.calls.final).toEqual([]); // warm-up never records
    expect(h.getUserMedia).not.toHaveBeenCalled();
    const downloading = seen.filter((s) => s.phase === 'downloading').map((s) => s.percent);
    expect(downloading).toContain(25); // 5 of 20 MB
    expect(downloading).toContain(50); // encoder done = 10 of 20 MB
    expect(seen.at(-1)).toEqual({ phase: 'ready', percent: 100 });
    expect(h.provider.getProgress().phase).toBe('ready');
  });

  it('model download failure -> network error via onError, status error, and a later retry can succeed', async () => {
    const h = harness({ pipelineError: new Error('Failed to fetch https://huggingface.co/...') });
    await h.provider.start(h.handlers);
    await h.provider.stop();
    expect(h.calls.final).toEqual([]);
    expect(h.calls.errors).toHaveLength(1);
    expect(sttErrorCode(h.calls.errors[0])).toBe('network');
    expect(h.calls.errors[0].message).toMatch(/huggingface\.co/);
    expect(h.provider.getProgress().phase).toBe('error');
    await expect(h.provider.warmUp()).rejects.toBeInstanceOf(SttError);
    expect(h.pipeline.mock.calls.length).toBeGreaterThanOrEqual(2); // failed load is not cached
  });

  it('non-network engine failure (no WASM/WebGPU) maps to unsupported', async () => {
    const h = harness({ pipelineError: new Error('no available backend found. ERR: [wasm] RuntimeError: Aborted()') });
    await expect(h.provider.warmUp()).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('fails with unsupported when WebAssembly is missing', async () => {
    const h = harness();
    vi.stubGlobal('WebAssembly', undefined);
    try {
      await expect(h.provider.start(h.handlers)).rejects.toMatchObject({ code: 'unsupported' });
      await expect(h.provider.warmUp()).rejects.toMatchObject({ code: 'unsupported' });
      expect(await h.provider.isAvailable()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps a denied microphone to not_allowed and releases nothing it never opened', async () => {
    const h = harness();
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const provider = createLocalWhisperProvider({
      model: model(), loadTransformers: h.loadTransformers, getUserMedia: async () => { throw denied; },
    });
    await expect(provider.start(h.handlers)).rejects.toMatchObject({ code: 'not_allowed' });
    await provider.stop(); // no-op
    expect(h.calls.final).toEqual([]);
  });

  it('silence or a too-short tap is no_speech and never calls the model', async () => {
    const silent = harness({ chunk: () => new Int16Array(16000).buffer });
    await silent.provider.start(silent.handlers);
    await silent.provider.stop();
    expect(silent.asr).not.toHaveBeenCalled();
    expect(sttErrorCode(silent.calls.errors[0])).toBe('no_speech');

    const tap = harness({ chunk: () => new Int16Array(100).fill(9000).buffer });
    await tap.provider.start(tap.handlers);
    await tap.provider.stop();
    expect(tap.asr).not.toHaveBeenCalled();
    expect(sttErrorCode(tap.calls.errors[0])).toBe('no_speech');
  });

  it('a hallucinated "Thank you." on room noise becomes no_speech', async () => {
    const h = harness({ text: ' Thank you.' });
    await h.provider.start(h.handlers);
    await h.provider.stop();
    expect(h.calls.final).toEqual([]);
    expect(sttErrorCode(h.calls.errors[0])).toBe('no_speech');
  });

  it('a decode crash surfaces as an error, not a throw', async () => {
    const h = harness();
    h.asr.mockRejectedValueOnce(new Error('out of memory'));
    await h.provider.start(h.handlers);
    await expect(h.provider.stop()).resolves.toBeUndefined();
    expect(h.calls.errors[0].message).toMatch(/out of memory/);
  });
});

describe('local whisper inside the voice controller', () => {
  it('waits for the slow transcription (not the 2.5 s streaming timeout) and never submits the placeholder', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const h = harness();
      h.asr.mockImplementationOnce(async () => { await gate; return { text: ' Sessna 723 Echo Juliet Hold position' }; });
      const sent: string[] = [];
      const statuses: string[] = [];
      const controller = createVoiceController({
        providerId: 'whisper-local', ptt: false, releaseTailMs: 0,
        providers: { 'whisper-local': h.provider },
        onTransmission: (t, meta) => { sent.push(t); expect(meta.confidence).toBeUndefined(); expect(meta.providerId).toBe('whisper-local'); },
      });
      controller.onStatusChange((e) => statuses.push(e.status));
      controller.beginTransmission();
      await vi.advanceTimersByTimeAsync(10);
      controller.endTransmission();
      await vi.advanceTimersByTimeAsync(10_000); // far past the default 2.5 s final timeout
      expect(sent).toEqual([]);
      expect(controller.getLastPartial()).toBe(WHISPER_PLACEHOLDER);
      release();
      await vi.advanceTimersByTimeAsync(10);
      expect(sent).toEqual(['Cessna 723 Echo Juliet Hold position']);
      expect(statuses).toContain('processing');
      expect(statuses.at(-1)).toBe('idle');
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Scriptable stand-in for the Whisper Web Worker. */
class FakeWorker implements WorkerLike {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<WhisperWorkerEvent>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  sent: Array<{ msg: WhisperWorkerRequest; transfer?: Transferable[] }> = [];
  terminated = false;
  /** What to do when the page asks for a model load / a transcription. */
  onLoad: (w: FakeWorker) => void = (w) => {
    w.emit({ type: 'progress', info: { status: 'progress', file: 'a.onnx', loaded: 5_000_000, total: 10_000_000 } });
    w.emit({ type: 'progress', info: { status: 'done', file: 'a.onnx' } });
    w.emit({ type: 'ready' });
  };
  onTranscribe: (w: FakeWorker, id: number) => void = (w, id) => w.emit({ type: 'result', id, text: ' Sessna 723 Echo Juliet Hold position' });
  constructor() { FakeWorker.all.push(this); }
  emit(data: WhisperWorkerEvent) { this.onmessage?.({ data } as MessageEvent<WhisperWorkerEvent>); }
  postMessage(msg: WhisperWorkerRequest, transfer?: Transferable[]) {
    this.sent.push({ msg, transfer });
    queueMicrotask(() => (msg.type === 'load' ? this.onLoad(this) : this.onTranscribe(this, msg.id)));
  }
  terminate() { this.terminated = true; }
}

function workerHarness(configure?: (w: FakeWorker) => void, extra: Partial<Parameters<typeof createLocalWhisperProvider>[0]> = {}) {
  FakeWorker.all = [];
  const main = harness();
  const provider = createLocalWhisperProvider({
    model: model(),
    createWorker: () => { const w = new FakeWorker(); configure?.(w); return w; },
    loadTransformers: main.loadTransformers, // only used if the worker cannot start
    getUserMedia: main.getUserMedia, startCapture: main.startCapture,
    ...extra,
  });
  return { provider, main, calls: main.calls, handlers: main.handlers };
}

describe('local whisper in a Web Worker', () => {
  it('decodes in the worker: transfers the PCM buffer, relays progress, never touches the main-thread pipeline', async () => {
    const h = workerHarness();
    const seen: number[] = [];
    h.provider.onProgress((p) => p.phase === 'downloading' && seen.push(p.percent));
    await h.provider.start(h.handlers);
    await h.provider.stop();

    const w = FakeWorker.all[0];
    expect(FakeWorker.all).toHaveLength(1);
    expect(w.sent[0].msg).toMatchObject({ type: 'load', device: 'wasm', dtype: 'q8' });
    const tx = w.sent.find((m) => m.msg.type === 'transcribe')!;
    const req = tx.msg as Extract<WhisperWorkerRequest, { type: 'transcribe' }>;
    expect(req.audio).toBeInstanceOf(Float32Array);
    expect(req.audio.length).toBe(16000);
    expect(tx.transfer).toEqual([req.audio.buffer]); // transferred, not copied
    expect(req.call).toMatchObject({ return_timestamps: false });
    expect(req.call).not.toHaveProperty('language'); // English-only model

    expect(h.calls.partial[0]).toBe(WHISPER_PLACEHOLDER);
    expect(h.calls.final.map(([t]) => t)).toEqual(['Cessna 723 Echo Juliet Hold position']);
    expect(h.calls.final[0][1].confidence).toBeUndefined();
    expect(h.provider.getEngine()).toBe('worker');
    expect(h.main.loadTransformers).not.toHaveBeenCalled();
    expect(seen).toContain(50);
    expect(h.provider.getProgress().phase).toBe('ready');
  });

  it('keeps one worker and one load across presses', async () => {
    const h = workerHarness();
    await h.provider.start(h.handlers);
    await h.provider.stop();
    await h.provider.start(h.handlers);
    await h.provider.stop();
    expect(FakeWorker.all).toHaveLength(1);
    expect(FakeWorker.all[0].sent.filter((m) => m.msg.type === 'load')).toHaveLength(1);
    expect(h.calls.final).toHaveLength(2);
  });

  it('a model download failure inside the worker is a network error (no silent fallback) and a retry gets a fresh worker', async () => {
    let first = true;
    const h = workerHarness((w) => {
      if (first) { first = false; w.onLoad = (x) => x.emit({ type: 'error', stage: 'pipeline', message: 'Failed to fetch huggingface.co/x' }); }
    });
    await expect(h.provider.warmUp()).rejects.toMatchObject({ code: 'network' });
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(h.main.loadTransformers).not.toHaveBeenCalled();
    await h.provider.warmUp();
    expect(FakeWorker.all).toHaveLength(2);
    expect(h.provider.getProgress().phase).toBe('ready');
  });

  it('falls back to the main thread, with one notice, when the worker script cannot start', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const h = workerHarness((w) => { w.onLoad = () => w.onerror?.({ message: 'Failed to load module script' } as ErrorEvent); });
    await h.provider.start(h.handlers);
    await h.provider.stop();
    expect(h.provider.getEngine()).toBe('main');
    expect(h.main.pipeline).toHaveBeenCalledOnce();
    expect(h.calls.final.map(([t]) => t)).toEqual(['Cessna 723 Echo Juliet Hold position']);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(/main thread/);
  });

  it('falls back to the main thread when constructing the worker throws', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const main = harness();
    const provider = createLocalWhisperProvider({
      model: model(), createWorker: () => { throw new Error('Worker is not defined'); }, loadTransformers: main.loadTransformers,
    });
    await provider.warmUp();
    expect(provider.getEngine()).toBe('main');
  });

  it('createWorker: null forces the main-thread engine', async () => {
    const main = harness();
    const provider = createLocalWhisperProvider({ model: model(), createWorker: null, loadTransformers: main.loadTransformers });
    await provider.warmUp();
    expect(provider.getEngine()).toBe('main');
  });

  it('a transcription error from the worker is reported through onError', async () => {
    const h = workerHarness((w) => { w.onTranscribe = (x, id) => x.emit({ type: 'error', id, stage: 'transcribe', message: 'out of memory' }); });
    await h.provider.start(h.handlers);
    await expect(h.provider.stop()).resolves.toBeUndefined();
    expect(h.calls.errors[0].message).toMatch(/out of memory/);
    expect(h.calls.errors[0].message.match(/Local speech recognition failed/g)).toHaveLength(1);
  });

  it('a worker that crashes after loading is replaced on the next press', async () => {
    const h = workerHarness();
    await h.provider.warmUp();
    FakeWorker.all[0].onerror?.({ message: 'boom' } as ErrorEvent);
    await h.provider.start(h.handlers);
    await h.provider.stop();
    expect(FakeWorker.all).toHaveLength(2);
    expect(h.calls.final).toHaveLength(1);
  });
});

describe('local whisper model/device from settings', () => {
  beforeEach(() => {
    resetLocalWhisperBackends();
    markWebGpuFailed(false);
    localStorage.clear();
  });

  function settingsHarness(gpu: boolean, configure?: (w: FakeWorker, index: number) => void) {
    FakeWorker.all = [];
    const store = createVoiceSettingsStore();
    const main = harness();
    const provider = createLocalWhisperProvider({
      settings: store,
      gpu,
      createWorker: () => { const w = new FakeWorker(); configure?.(w, FakeWorker.all.length - 1); return w; },
      loadTransformers: main.loadTransformers,
      getUserMedia: main.getUserMedia,
      startCapture: main.startCapture,
    });
    return { store, provider, main };
  }

  it('auto on a CPU-only browser loads base.en on wasm with q8, and says so', async () => {
    const h = settingsHarness(false);
    expect(h.provider.model).toBe('onnx-community/whisper-base.en');
    const messages: string[] = [];
    h.provider.onProgress((p) => messages.push(p.message));
    await h.provider.warmUp();
    expect(FakeWorker.all[0].sent[0].msg).toMatchObject({ type: 'load', model: 'onnx-community/whisper-base.en', device: 'wasm', dtype: 'q8' });
    expect(messages).toContain('Downloading Whisper base.en (77 MB)…');
    expect(h.provider.getProgress().message).toBe('Ready: Whisper base.en on WebAssembly (CPU)');
  });

  it('auto with WebGPU loads small.en on webgpu with the fp32/q4 dtype combination', async () => {
    const h = settingsHarness(true);
    await h.provider.warmUp();
    expect(FakeWorker.all[0].sent[0].msg).toMatchObject({
      model: 'onnx-community/whisper-small.en', device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    });
    expect(h.provider.getProgress().message).toBe('Ready: Whisper small.en on WebGPU');
  });

  it('switches backend when the settings change: new worker for the new model, old worker terminated, status reset', async () => {
    const h = settingsHarness(false);
    await h.provider.warmUp();
    expect(h.provider.getProgress().phase).toBe('ready');
    h.store.update({ whisperModel: 'tiny.en' });
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(h.provider.getProgress().phase).toBe('idle');
    expect(h.provider.getProgress().message).toMatch(/Whisper tiny\.en on WebAssembly/);
    expect(h.provider.model).toBe('onnx-community/whisper-tiny.en');
    await h.provider.start({ onPartial: () => undefined, onFinal: () => undefined, onError: (e) => { throw e; } });
    await h.provider.stop();
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[1].sent[0].msg).toMatchObject({ model: 'onnx-community/whisper-tiny.en', device: 'wasm' });
    expect(h.provider.getProgress().message).toBe('Ready: Whisper tiny.en on WebAssembly (CPU)');
  });

  it('an unrelated settings change does not reload the model', async () => {
    const h = settingsHarness(false);
    await h.provider.warmUp();
    h.store.update({ ttsVolume: 0.5 });
    expect(FakeWorker.all[0].terminated).toBe(false);
    expect(h.provider.getProgress().phase).toBe('ready');
  });

  it('falls back to wasm with the same model when WebGPU fails to load, once, and remembers it for the session', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const h = settingsHarness(true, (w, i) => {
      if (i === 0) w.onLoad = (x) => x.emit({ type: 'error', stage: 'pipeline', message: 'No WebGPU adapter was found.' });
    });
    await h.provider.warmUp();
    expect(FakeWorker.all[1].sent[0].msg).toMatchObject({ model: 'onnx-community/whisper-small.en', device: 'wasm', dtype: 'q8' });
    expect(isWebGpuMarkedFailed()).toBe(true);
    expect(h.provider.getProgress().message).toContain('Ready: Whisper small.en on WebAssembly (CPU)');
    expect(h.provider.getProgress().message).toContain('fell back');
    expect(info).toHaveBeenCalledTimes(1);
    // The next preparation (or key press) reuses the wasm worker instead of trying WebGPU again.
    await h.provider.warmUp();
    expect(FakeWorker.all).toHaveLength(2);
  });

  it('falls back to wasm and retries the same audio when the first WebGPU transcription throws', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const h = settingsHarness(true, (w, i) => {
      if (i === 0) w.onTranscribe = (x, id) => x.emit({ type: 'error', id, stage: 'transcribe', message: 'GPU device lost' });
    });
    const final: string[] = [];
    const errors: Error[] = [];
    await h.provider.start({ onPartial: () => undefined, onFinal: (t) => final.push(t), onError: (e) => errors.push(e) });
    await h.provider.stop();
    expect(errors).toEqual([]);
    expect(final).toEqual(['Cessna 723 Echo Juliet Hold position']);
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(FakeWorker.all[1].sent[0].msg).toMatchObject({ device: 'wasm', model: 'onnx-community/whisper-small.en' });
    const retry = FakeWorker.all[1].sent.find((m) => m.msg.type === 'transcribe')!.msg as Extract<WhisperWorkerRequest, { type: 'transcribe' }>;
    expect(retry.audio.length).toBe(16000);
    expect(isWebGpuMarkedFailed()).toBe(true);
  });

  it('passes num_beams only when numBeams is set above 1', async () => {
    FakeWorker.all = [];
    const main = harness();
    const provider = createLocalWhisperProvider({
      model: model(), numBeams: 3, createWorker: () => new FakeWorker(), getUserMedia: main.getUserMedia, startCapture: main.startCapture,
    });
    await provider.start(main.handlers);
    await provider.stop();
    const req = FakeWorker.all[0].sent.find((m) => m.msg.type === 'transcribe')!.msg as Extract<WhisperWorkerRequest, { type: 'transcribe' }>;
    expect(req.call).toMatchObject({ num_beams: 3, chunk_length_s: 30, return_timestamps: false });
  });
});
