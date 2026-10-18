/**
 * Local Whisper speech-to-text: runs entirely in this browser tab (WebAssembly, optionally WebGPU) through
 * transformers.js (@huggingface/transformers). NO cloud account, API key or server is involved.
 *
 * Privacy: microphone audio is captured to an in-memory buffer while push-to-talk is held, transcribed on this
 * machine when the key is released, then dropped. It is never uploaded, stored or sent anywhere. The only
 * network traffic is the one-time download of the MODEL FILES (not your voice) from huggingface.co and of the
 * ONNX WebAssembly runtime from cdn.jsdelivr.net; the browser caches both (Cache API / HTTP cache), so later
 * sessions work offline.
 *
 * Flow:  start() -> getUserMedia + pcmCapture (16 kHz mono Int16 chunks, buffered)   [model starts loading]
 *        stop()  -> onPartial("Transcribing...") -> pipeline('automatic-speech-recognition') -> onFinal(text)
 *
 * Library notes (verified against @huggingface/transformers 4.3.1 source, not just docs):
 *  - English-only checkpoints (`*.en`) THROW if `language` or `task` is passed, so those are only sent to
 *    multilingual checkpoints (`whisper-base`, ...). The `.en` models are always English transcription.
 *  - `prompt_ids` exists on WhisperGenerationConfig but generate() in 4.3.1 does not use it and the processor has
 *    no get_prompt_ids(), so an aviation-vocabulary prompt is NOT supported yet. Callsign/phonetic repair is done
 *    in aviationPostProcess.ts and the command parser's lexicon instead.
 *  - Timestamps are off (return_timestamps default false) = faster decoding and one plain string.
 *  - The ONNX runtime's .wasm/.mjs are fetched from cdn.jsdelivr.net by default (see node_modules/.../backends/onnx.js).
 */
import { postProcessTranscript } from './aviationPostProcess.ts';
import { getSharedVoiceSettingsStore } from '../settings.ts';
import type { VoiceSettings } from '../settings.ts';
import { withPreferredInput } from './inputDevice.ts';
import { mapMediaError } from './mediaErrors.ts';
import { hasTrackProcessor, startPcmCapture, TARGET_SAMPLE_RATE, warmUpAudio } from './pcmCapture.ts';
import type { PcmCapture, WarmAudio } from './pcmCapture.ts';
import type { SpeechRecognitionProvider, SttStartOptions } from './types.ts';
import { SttError, sttErrorCode } from './types.ts';
import { deviceLabel, hasWebGpu, isWebGpuMarkedFailed, markWebGpuFailed, resolveWhisper, WHISPER_MODELS, whisperDtype } from './whisperModels.ts';
import type { WhisperDevice } from './whisperModels.ts';
import { errorText, importError, isEnglishOnly, mapPipelineError } from './whisperProtocol.ts';
import type { WhisperWorkerEvent, WhisperWorkerRequest } from './whisperProtocol.ts';

export const LOCAL_WHISPER_ID = 'whisper-local' as const;
export const LOCAL_WHISPER_LABEL = 'Local Whisper (on-device, no cloud)';
/** The CPU default when nothing else is chosen: English-only base, ~77 MB quantised (q8). See whisperModels.ts for the rest. */
export const DEFAULT_WHISPER_MODEL = WHISPER_MODELS['base.en'].hfId;
/** Shown through onPartial while the model decodes. Not part of the transcript. */
export const WHISPER_PLACEHOLDER = 'Transcribing…';

const MIN_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.25);
const MAX_SECONDS = 60;
/** Mean absolute amplitude below which a capture is treated as silence (about -66 dBFS). */
const SILENCE_LEVEL = 0.0005;

export type WhisperPhase = 'idle' | 'downloading' | 'loading' | 'ready' | 'error';

export interface WhisperProgress {
  phase: WhisperPhase;
  /** 0..100 across all files seen so far (a best-effort aggregate). */
  percent: number;
  message: string;
  /** Present when phase is 'error'. */
  error?: Error;
}

type ProgressInfo = { status?: string; file?: string; loaded?: number; total?: number; progress?: number; name?: string };
type AsrCall = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: string } | Array<{ text?: string }>>;
/** transformers.js `pipeline()` signature, reduced to what we use. */
type PipelineFactory = (task: string, model: string, options?: Record<string, unknown>) => Promise<AsrCall>;
export interface TransformersModule {
  pipeline: PipelineFactory;
  env?: Record<string, unknown>;
}

/** The slice of the Worker API the provider uses (so tests can fake it). */
export interface WorkerLike {
  postMessage(message: WhisperWorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WhisperWorkerEvent>) => void) | null;
  onerror: ((e: ErrorEvent) => any) | null;
  onmessageerror: ((e: MessageEvent) => any) | null;
  terminate(): void;
}

const defaultCreateWorker = (): WorkerLike => new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' });

/** Raised when the worker itself cannot run (script failed to load, crashed), as opposed to a model/network error. */
class WorkerUnavailableError extends Error {}

interface AsrBackend {
  readonly kind: 'worker' | 'main';
  alive(): boolean;
  /** Device the loaded model actually runs on ('' before load). */
  readonly device: string;
  load(req: { model: string; device: string; dtype: string | Record<string, string> }, onProgress: (info: ProgressInfo) => void): Promise<void>;
  /** Release the model (terminates the worker). */
  dispose(): void;
  transcribe(audio: Float32Array, call: Record<string, unknown>): Promise<string>;
}

function mainBackend(loadTransformers: () => Promise<TransformersModule>): AsrBackend {
  let asr: AsrCall | null = null;
  let device = '';
  return {
    kind: 'main',
    alive: () => true,
    get device() {
      return device;
    },
    dispose() {
      asr = null;
    },
    async load(req, onProgress) {
      device = req.device;
      let tf: TransformersModule;
      try {
        tf = await loadTransformers();
      } catch (cause) {
        throw importError(cause);
      }
      if (tf.env) {
        tf.env.allowLocalModels = false; // never probe the dev server for /models/... (it answers index.html)
        tf.env.useBrowserCache = true; // persist model files in the Cache API
      }
      try {
        asr = await tf.pipeline('automatic-speech-recognition', req.model, { device: req.device, dtype: req.dtype, progress_callback: onProgress });
      } catch (cause) {
        throw mapPipelineError(cause, req.model);
      }
    },
    async transcribe(audio, call) {
      if (!asr) throw new Error('The speech model has not been loaded.');
      const out = await asr(audio, call);
      const first = Array.isArray(out) ? out[0] : out;
      return typeof first?.text === 'string' ? first.text : '';
    },
  };
}

function workerBackend(createWorker: () => WorkerLike): AsrBackend {
  let worker: WorkerLike;
  try {
    worker = createWorker();
  } catch (cause) {
    throw new WorkerUnavailableError(errorText(cause));
  }
  let dead = false;
  let loaded = false;
  let nextId = 1;
  let onProgress: (info: ProgressInfo) => void = () => undefined;
  let loadSettle: { resolve(): void; reject(e: unknown): void } | null = null;
  const pending = new Map<number, { resolve(t: string): void; reject(e: unknown): void }>();
  let model = '';
  let device = '';

  const die = (cause: unknown) => {
    if (dead) return;
    dead = true;
    worker.terminate();
    const err = loaded ? new SttError('unknown', `The local speech worker stopped unexpectedly. (${errorText(cause)})`, { cause }) : new WorkerUnavailableError(errorText(cause));
    loadSettle?.reject(err);
    loadSettle = null;
    pending.forEach((p) => p.reject(err));
    pending.clear();
  };
  worker.onerror = (e) => die(e?.message || 'worker error');
  worker.onmessageerror = () => die('worker message error');
  worker.onmessage = (e) => {
    const m = e.data;
    switch (m.type) {
      case 'progress':
        onProgress(m.info as ProgressInfo);
        break;
      case 'ready':
        loaded = true;
        loadSettle?.resolve();
        loadSettle = null;
        break;
      case 'result':
        pending.get(m.id)?.resolve(m.text);
        pending.delete(m.id);
        break;
      case 'error':
        if (m.id !== undefined) {
          pending.get(m.id)?.reject(new SttError('unknown', `Local speech recognition failed: ${m.message}`));
          pending.delete(m.id);
        } else if (m.stage === 'import') {
          loadSettle?.reject(importError(new Error(m.message)));
          loadSettle = null;
        } else {
          loadSettle?.reject(mapPipelineError(new Error(m.message), model));
          loadSettle = null;
        }
        break;
    }
  };

  return {
    kind: 'worker',
    alive: () => !dead,
    get device() {
      return device;
    },
    dispose() {
      dead = true;
      worker.terminate();
    },
    load(req, progress) {
      model = req.model;
      device = req.device;
      onProgress = progress;
      return new Promise<void>((resolve, reject) => {
        loadSettle = { resolve, reject };
        worker.postMessage({ type: 'load', ...req });
      }).catch((err: unknown) => {
        if (!(err instanceof WorkerUnavailableError)) worker.terminate(); // model error: a fresh worker retries cleanly
        dead = true;
        throw err;
      });
    },
    transcribe(audio, call) {
      if (dead) return Promise.reject(new SttError('unknown', 'The local speech worker is not running.'));
      const id = nextId++;
      return new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'transcribe', id, audio, call }, [audio.buffer]); // transfer: no copy, no main-thread work
      });
    },
  };
}

export interface LocalWhisperOptions {
  /** Explicit Hugging Face model id. Overrides the settings-driven choice (tests, tooling). */
  model?: string;
  /** Explicit device for an explicit `model`: 'wasm' (default) or 'webgpu'. Ignored when the model comes from settings. */
  device?: WhisperDevice;
  /** Overrides the per-device default dtype ('q8' on WASM; fp32 encoder + q4 decoder on WebGPU). */
  dtype?: string | Record<string, string>;
  /**
   * Where the model/device choice comes from (the app uses the shared voice-settings store). The provider re-reads it
   * on every use and switches backend (terminating the old worker) when it changes. Without it, 'auto'/'auto' applies.
   */
  settings?: { get(): Pick<VoiceSettings, 'whisperModel' | 'whisperDevice'>; subscribe(listener: () => void): () => void };
  /** Test seam for WebGPU detection (default: `navigator.gpu` exists). */
  gpu?: boolean;
  /**
   * Beam search width passed to generate() as `num_beams`. Off by default (greedy): beams are noticeably slower on WASM.
   * Supported by transformers.js 4.3.1 Whisper generation; try 2 to 5 on a GPU if accuracy still falls short.
   */
  numBeams?: number;
  /**
   * Main-thread engine seam; defaults to `import('@huggingface/transformers')` (code-split, loaded only when used).
   * Supplying it (tests) selects the main-thread engine unless `createWorker` is also given.
   */
  loadTransformers?: () => Promise<TransformersModule>;
  /**
   * Worker factory. Default: a module Web Worker running whisperWorker.ts when `Worker` exists. `null` forces the
   * main-thread engine. Anything that makes the worker fail to start also falls back to the main thread.
   */
  createWorker?: (() => WorkerLike) | null;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  startCapture?: (stream: MediaStream, onChunk: (pcm: ArrayBuffer) => void, warm?: WarmAudio) => Promise<PcmCapture>;
  /** Test seam for the idle audio graph (see warmUpAudio). */
  warmUpAudio?: () => Promise<WarmAudio>;
  now?: () => number;
  /** Per-capture wait budget the controller should allow for model load + decode. Default 180 s. */
  finalTimeoutMs?: number;
}

/** Level statistics of one capture. `ambient*` covers the first 500 ms (speak after that, so it is the room's noise floor). */
export interface CaptureStats {
  seconds: number;
  ambientRms: number;
  ambientDbfs: number;
  rms: number;
  peak: number;
}

const toDb = (x: number) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -Infinity);

export function captureStats(audio: Float32Array): CaptureStats {
  const rmsOf = (a: Float32Array) => {
    if (!a.length) return 0;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / a.length);
  };
  let peak = 0;
  for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]));
  const ambient = rmsOf(audio.subarray(0, Math.round(TARGET_SAMPLE_RATE * 0.5)));
  return { seconds: audio.length / TARGET_SAMPLE_RATE, ambientRms: ambient, ambientDbfs: toDb(ambient), rms: rmsOf(audio), peak };
}

export interface LocalWhisperProvider extends SpeechRecognitionProvider {
  readonly id: typeof LOCAL_WHISPER_ID;
  /** Hugging Face id currently selected (follows the settings). */
  readonly model: string;
  /** Download (first run only) and initialise the model without recording anything. Safe to call repeatedly. */
  warmUp(): Promise<void>;
  /** Subscribe to model download/initialisation progress. Replays the current state immediately. */
  onProgress(listener: (p: WhisperProgress) => void): () => void;
  getProgress(): WhisperProgress;
  /** Level statistics of the most recent capture (debug/e2e hook; no audio is kept). */
  getLastCapture(): CaptureStats | null;
  /** Where decoding runs: 'worker' (default), 'main' (fallback), or 'none' until the model has been prepared. */
  getEngine(): 'worker' | 'main' | 'none';
  prepare(): Promise<void>;
  dispose(): Promise<void>;
}

function int16ToFloat32(chunks: Int16Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) out[o++] = c[i] / 32768;
  }
  return out;
}

function meanAbs(a: Float32Array): number {
  if (a.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]);
  return s / a.length;
}

/** Loaded engines are expensive (tens of MB): share one per model+device across provider instances. */
const backendCache = new Map<string, Promise<AsrBackend>>();

/** Terminate and forget every loaded engine (tests; also a clean slate after changing environment). */
export function resetLocalWhisperBackends(): void {
  for (const p of backendCache.values()) void p.then((b) => b.dispose(), () => undefined);
  backendCache.clear();
}

interface WhisperConfig {
  model: string;
  /** Short name for messages, e.g. "Whisper small.en". */
  name: string;
  device: WhisperDevice;
  dtype: string | Record<string, string>;
  /** Approximate download in MB (0 when unknown). */
  mb: number;
}

const configKey = (c: WhisperConfig) => `${c.model}|${c.device}|${JSON.stringify(c.dtype)}`;

export function createLocalWhisperProvider(options: LocalWhisperOptions = {}): LocalWhisperProvider {
  const now = options.now ?? (() => Date.now());
  const finalTimeoutMs = options.finalTimeoutMs ?? 180_000;
  const getMedia = () =>
    options.getUserMedia ??
    (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
      ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
      : undefined);

  /** The model/device to use right now: explicit options, else the settings choice (auto = WebGPU + small.en, or CPU + base.en). */
  function config(): WhisperConfig {
    const gpu = options.gpu ?? hasWebGpu();
    if (options.model !== undefined) {
      const requested: WhisperDevice = options.device ?? 'wasm';
      const device: WhisperDevice = requested === 'webgpu' && isWebGpuMarkedFailed() ? 'wasm' : requested;
      return { model: options.model, name: `Whisper ${options.model.split('/').pop()!.replace(/^whisper-/, '')}`, device, dtype: options.dtype ?? whisperDtype(device), mb: 0 };
    }
    const s = options.settings?.get();
    const r = resolveWhisper(s?.whisperModel ?? 'auto', s?.whisperDevice ?? 'auto', { gpu, webGpuFailed: isWebGpuMarkedFailed() });
    return { model: r.hfId, name: `Whisper ${r.size}`, device: r.device, dtype: options.dtype ?? r.dtype, mb: r.mb };
  }
  const where = (c: WhisperConfig) => `${c.name} on ${deviceLabel(c.device)}`;
  const downloadingText = (c: WhisperConfig) => `Downloading ${c.name}${c.mb ? ` (${c.mb} MB)` : ''}…`;

  let progress: WhisperProgress = { phase: 'idle', percent: 0, message: 'Local model not downloaded yet.' };
  const listeners = new Set<(p: WhisperProgress) => void>();
  const emit = (p: WhisperProgress) => {
    progress = p;
    listeners.forEach((l) => l(p));
  };
  /** Bumped whenever the selected backend changes, so a stale in-flight load cannot overwrite the current status. */
  let epoch = 0;

  /** Aggregate per-file byte counts into one percentage. */
  const files = new Map<string, { loaded: number; total: number }>();
  function fileProgress(info: ProgressInfo, c: WhisperConfig, myEpoch: number) {
    if (myEpoch !== epoch || info.status === 'ready') return;
    if (info.file && typeof info.total === 'number' && info.total > 0 && typeof info.loaded === 'number') {
      files.set(info.file, { loaded: info.loaded, total: info.total });
    }
    if (info.status === 'done' && info.file) {
      const f = files.get(info.file);
      if (f) files.set(info.file, { loaded: f.total, total: f.total });
    }
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    const percent = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : progress.percent;
    const mb = (n: number) => (n / 1e6).toFixed(1);
    emit({
      phase: 'downloading',
      percent,
      message: total > 0 ? `Downloading ${c.name}: ${percent}% (${mb(loaded)} of ${mb(total)} MB)` : downloadingText(c),
    });
  }

  const useWorker = options.createWorker !== null && (options.createWorker !== undefined || (options.loadTransformers === undefined && typeof Worker !== 'undefined'));
  let engineKind: 'worker' | 'main' | 'none' = 'none';
  let activeKey: string | null = null;

  /** Drop the backend for `key` (terminating its worker) and forget it. */
  function retire(key: string) {
    const old = backendCache.get(key);
    backendCache.delete(key);
    void old?.then((b) => b.dispose(), () => undefined);
  }

  /** Load a backend for one concrete config (worker first, main thread if workers are unavailable). */
  async function loadBackend(c: WhisperConfig, myEpoch: number): Promise<AsrBackend> {
    const req = { model: c.model, device: c.device, dtype: c.dtype };
    const onFile = (info: ProgressInfo) => fileProgress(info, c, myEpoch);
    let backend: AsrBackend | null = null;
    if (useWorker) {
      try {
        backend = workerBackend(options.createWorker ?? defaultCreateWorker);
        await backend.load(req, onFile);
      } catch (err) {
        if (!(err instanceof WorkerUnavailableError)) throw err;
        console.info('[whisper-local] Web Workers are unavailable here; decoding on the main thread, so the page may pause briefly.');
        if (myEpoch === epoch) emit({ phase: 'downloading', percent: 0, message: 'Web Workers unavailable: decoding on the main thread (the page may pause briefly).' });
        backend = null;
      }
    }
    if (!backend) {
      backend = mainBackend(options.loadTransformers ?? (() => import('@huggingface/transformers') as unknown as Promise<TransformersModule>));
      await backend.load(req, onFile);
    }
    return backend;
  }

  /** Remember that WebGPU does not work here (for this page session) and say so once. */
  function noteWebGpuFailure(why: unknown, c: WhisperConfig) {
    if (!isWebGpuMarkedFailed()) console.info(`[whisper-local] WebGPU failed for ${c.name}; using WebAssembly (CPU) for the rest of this session. (${errorText(why)})`);
    markWebGpuFailed();
  }

  /** Called when the selected model/device may have changed: release the old backend and reset the status. */
  function syncConfig() {
    const c = config();
    const key = configKey(c);
    if (activeKey === null || activeKey === key) return;
    retire(activeKey);
    activeKey = null;
    engineKind = 'none';
    epoch++;
    files.clear();
    emit({ phase: 'idle', percent: 0, message: `${where(c)} selected${c.mb ? ` (${c.mb} MB download the first time)` : ''}. Press the button to prepare it.` });
  }
  options.settings?.subscribe(syncConfig);

  function ensureBackend(): Promise<AsrBackend> {
    syncConfig();
    const c = config();
    const key = configKey(c);
    const cached = backendCache.get(key);
    if (cached) {
      activeKey = key;
      return cached.then((b) => {
        if (b.alive()) {
          engineKind = b.kind;
          if (progress.phase !== 'ready' || !progress.message.includes(where(c))) emit({ phase: 'ready', percent: 100, message: `Ready: ${where(c)}` });
          return b;
        }
        backendCache.delete(key); // the worker died after loading: rebuild
        return ensureBackend();
      });
    }
    if (typeof WebAssembly === 'undefined') {
      const err = new SttError('unsupported', 'This browser has no WebAssembly support, which the local Whisper model needs.');
      emit({ phase: 'error', percent: 0, message: err.message, error: err });
      return Promise.reject(err);
    }
    activeKey = key;
    const myEpoch = ++epoch;
    files.clear();
    emit({ phase: 'downloading', percent: 0, message: downloadingText(c) });
    let used = c;
    const p = (async () => {
      let backend: AsrBackend;
      try {
        backend = await loadBackend(c, myEpoch);
      } catch (err) {
        if (c.device !== 'webgpu' || sttErrorCode(err) === 'network') throw err;
        noteWebGpuFailure(err, c);
        used = config(); // same model, now WebAssembly
        files.clear();
        activeKey = configKey(used);
        if (myEpoch === epoch) emit({ phase: 'downloading', percent: 0, message: `WebGPU is not available here; using WebAssembly instead. ${downloadingText(used)}` });
        backend = await loadBackend(used, myEpoch);
      }
      if (myEpoch === epoch) emit({ phase: 'loading', percent: 99, message: `Starting ${used.name}…` });
      engineKind = backend.kind;
      return backend;
    })();
    backendCache.set(key, p);
    p.then(
      () => {
        if (configKey(used) !== key) {
          // WebGPU fell back to WebAssembly: file the backend under its real key so the next press finds it.
          backendCache.delete(key);
          backendCache.set(configKey(used), p);
        }
        if (myEpoch === epoch) emit({ phase: 'ready', percent: 100, message: `Ready: ${where(used)}${used.device !== c.device ? ' (WebGPU unavailable, fell back to CPU)' : ''}` });
      },
      (err: unknown) => {
        backendCache.delete(key); // allow a retry
        if (myEpoch !== epoch) return;
        const e = err instanceof Error ? err : new Error(String(err));
        emit({ phase: 'error', percent: 0, message: e.message, error: e });
      },
    );
    return p;
  }

  interface Capture {
    opts: SttStartOptions;
    cap: PcmCapture;
    chunks: Int16Array[];
    samples: number;
    startedAt: number;
  }
  let current: Capture | null = null;
  let lastCapture: CaptureStats | null = null;

  /**
   * Idle audio graph kept between key presses so the microphone is heard from the first instant (building it on demand
   * loses roughly the first half second of speech). It has no microphone attached while idle.
   */
  let warm: Promise<WarmAudio | null> | null = null;
  const getWarm = (): Promise<WarmAudio | null> => {
    // The track-processor capture path needs no AudioContext, so there is nothing to warm up.
    warm ??= (options.warmUpAudio === undefined && hasTrackProcessor() ? Promise.resolve(null) : (options.warmUpAudio ?? warmUpAudio)().catch(() => null));
    return warm;
  };

  return {
    id: LOCAL_WHISPER_ID,
    label: LOCAL_WHISPER_LABEL,
    get model() {
      return config().model;
    },
    finalTimeoutMs,
    placeholderPartial: WHISPER_PLACEHOLDER,

    async isAvailable() {
      return typeof WebAssembly !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices;
    },

    getProgress: () => progress,
    getEngine: () => engineKind,
    getLastCapture: () => lastCapture,
    onProgress(listener) {
      listeners.add(listener);
      listener(progress);
      return () => listeners.delete(listener);
    },

    async warmUp() {
      void getWarm(); // also prepare the idle audio graph (the click is a user gesture, so it can start running)
      await ensureBackend();
    },

    async prepare() {
      await getWarm();
    },

    async dispose() {
      const w = warm;
      warm = null;
      await (await w)?.close();
    },

    async start(opts) {
      if (current) await this.stop().catch(() => undefined);
      const media = getMedia();
      if (!media || typeof WebAssembly === 'undefined') {
        throw new SttError('unsupported', 'This browser cannot capture the microphone or run WebAssembly, so local Whisper is unavailable.');
      }
      let stream: MediaStream;
      let graph: WarmAudio | null;
      try {
        // Open the microphone and (first press only) build the audio graph at the same time.
        [stream, graph] = await Promise.all([
          media({ audio: withPreferredInput({ channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }) }),
          getWarm(),
        ]);
      } catch (err) {
        throw mapMediaError(err);
      }
      if (graph && graph.ctx.state === 'closed') {
        warm = null;
        graph = null;
      }
      const c: Capture = { opts, cap: null as unknown as PcmCapture, chunks: [], samples: 0, startedAt: now() };
      const maxSamples = TARGET_SAMPLE_RATE * MAX_SECONDS;
      try {
        c.cap = await (options.startCapture ?? startPcmCapture)(
          stream,
          (pcm) => {
            if (c.samples >= maxSamples) return;
            const i16 = new Int16Array(pcm);
            c.chunks.push(i16);
            c.samples += i16.length;
          },
          graph ?? undefined,
        );
      } catch (err) {
        stream.getTracks().forEach((t) => t.stop());
        throw new SttError('no_microphone', 'Could not process microphone audio in this browser.', { cause: err });
      }
      c.startedAt = now();
      current = c;
      // Overlap model download/initialisation with the user speaking. Errors surface at stop().
      void ensureBackend().catch(() => undefined);
    },

    async stop() {
      const c = current;
      if (!c) return;
      current = null;
      const durationMs = Math.max(0, now() - c.startedAt);
      try {
        await c.cap.stop();
      } catch {
        /* the graph is already being torn down */
      }
      const audio = int16ToFloat32(c.chunks, c.samples);
      lastCapture = captureStats(audio);
      if (audio.length < MIN_SAMPLES || meanAbs(audio) < SILENCE_LEVEL) {
        c.opts.onError(new SttError('no_speech', 'No speech detected. Hold the key, then speak.'));
        return;
      }
      c.opts.onPartial(WHISPER_PLACEHOLDER);
      let backend: AsrBackend;
      try {
        backend = await ensureBackend();
      } catch (err) {
        c.opts.onError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let text: string;
      try {
        const cfg = config();
        const call: Record<string, unknown> = { chunk_length_s: 30, return_timestamps: false };
        if (options.numBeams && options.numBeams > 1) call.num_beams = options.numBeams;
        if (!isEnglishOnly(cfg.model)) {
          call.language = 'en';
          call.task = 'transcribe';
        }
        try {
          // The worker takes ownership of the buffer, so keep a copy while a WebGPU retry on the CPU is still possible.
          text = await backend.transcribe(backend.device === 'webgpu' ? audio.slice() : audio, call);
        } catch (cause) {
          if (backend.device !== 'webgpu') throw cause;
          noteWebGpuFailure(cause, cfg);
          retire(configKey(cfg));
          activeKey = null;
          const wasm = config();
          emit({ phase: 'downloading', percent: 0, message: `WebGPU failed while transcribing; switching to WebAssembly. ${downloadingText(wasm)}` });
          backend = await ensureBackend();
          text = await backend.transcribe(audio, call);
        }
      } catch (cause) {
        c.opts.onError(cause instanceof SttError ? cause : new SttError('unknown', `Local speech recognition failed: ${errorText(cause)}`, { cause }));
        return;
      }
      const cleaned = postProcessTranscript(text);
      if (!cleaned) {
        c.opts.onError(new SttError('no_speech', 'No speech detected. Hold the key, then speak.'));
        return;
      }
      c.opts.onPartial(cleaned);
      c.opts.onFinal(cleaned, { durationMs }); // Whisper reports no confidence
    },
  };
}

let shared: LocalWhisperProvider | null = null;
/** The app-wide instance: the voice controller and the Settings “prepare model” button share its loaded model. */
export function getLocalWhisperProvider(): LocalWhisperProvider {
  if (!shared) {
    shared = createLocalWhisperProvider({ settings: getSharedVoiceSettingsStore() });
    // Debug hook for e2e/realmic.spec.ts (reads getLastCapture() for the measured room noise).
    if (typeof window !== 'undefined') (globalThis as unknown as { __kacyLocalWhisper?: LocalWhisperProvider }).__kacyLocalWhisper = shared;
  }
  return shared;
}
