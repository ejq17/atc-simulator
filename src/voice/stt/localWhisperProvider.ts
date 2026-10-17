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
import { mapMediaError } from './mediaErrors.ts';
import { startPcmCapture, TARGET_SAMPLE_RATE, warmUpAudio } from './pcmCapture.ts';
import type { PcmCapture, WarmAudio } from './pcmCapture.ts';
import type { SpeechRecognitionProvider, SttStartOptions } from './types.ts';
import { SttError } from './types.ts';

export const LOCAL_WHISPER_ID = 'whisper-local' as const;
export const LOCAL_WHISPER_LABEL = 'Local Whisper (on-device, no cloud)';
/** English-only, ~40 MB quantised (q8). Works with transformers.js 4.3.1; see README for accuracy notes. */
export const DEFAULT_WHISPER_MODEL = 'onnx-community/whisper-tiny.en';
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
type PipelineFactory = (task: string, model: string, options?: Record<string, unknown>) => Promise<AsrCall>;
export interface TransformersModule {
  pipeline: PipelineFactory;
  env?: Record<string, unknown>;
}

export interface LocalWhisperOptions {
  model?: string;
  /** 'wasm' (default, deterministic and works headless) or 'webgpu' (faster on a real GPU). */
  device?: 'wasm' | 'webgpu';
  /** Defaults to 'q8' (smallest download). */
  dtype?: string;
  /** Test seam; defaults to `import('@huggingface/transformers')` (code-split, loaded only when used). */
  loadTransformers?: () => Promise<TransformersModule>;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  startCapture?: (stream: MediaStream, onChunk: (pcm: ArrayBuffer) => void, warm?: WarmAudio) => Promise<PcmCapture>;
  /** Test seam for the idle audio graph (see warmUpAudio). */
  warmUpAudio?: () => Promise<WarmAudio>;
  now?: () => number;
  /** Per-capture wait budget the controller should allow for model load + decode. Default 180 s. */
  finalTimeoutMs?: number;
}

export interface LocalWhisperProvider extends SpeechRecognitionProvider {
  readonly id: typeof LOCAL_WHISPER_ID;
  readonly model: string;
  /** Download (first run only) and initialise the model without recording anything. Safe to call repeatedly. */
  warmUp(): Promise<void>;
  /** Subscribe to model download/initialisation progress. Replays the current state immediately. */
  onProgress(listener: (p: WhisperProgress) => void): () => void;
  getProgress(): WhisperProgress;
  prepare(): Promise<void>;
  dispose(): Promise<void>;
}

const isEnglishOnly = (model: string) => model.endsWith('.en');

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

/** Pipelines are expensive (tens of MB in memory): share one per model+device across provider instances. */
const pipelineCache = new Map<string, Promise<AsrCall>>();

export function createLocalWhisperProvider(options: LocalWhisperOptions = {}): LocalWhisperProvider {
  const model = options.model ?? DEFAULT_WHISPER_MODEL;
  const device = options.device ?? 'wasm';
  const dtype = options.dtype ?? 'q8';
  const now = options.now ?? (() => Date.now());
  const finalTimeoutMs = options.finalTimeoutMs ?? 180_000;
  const loadTransformers =
    options.loadTransformers ?? (() => import('@huggingface/transformers') as unknown as Promise<TransformersModule>);
  const getMedia = () =>
    options.getUserMedia ??
    (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
      ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
      : undefined);
  const cacheKey = `${model}|${device}|${dtype}`;

  let progress: WhisperProgress = { phase: 'idle', percent: 0, message: 'Local model not downloaded yet.' };
  const listeners = new Set<(p: WhisperProgress) => void>();
  const emit = (p: WhisperProgress) => {
    progress = p;
    listeners.forEach((l) => l(p));
  };

  /** Aggregate per-file byte counts into one percentage. */
  const files = new Map<string, { loaded: number; total: number }>();
  function onFileProgress(info: ProgressInfo) {
    if (info.status === 'ready') return;
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
      message: total > 0 ? `Downloading local speech model: ${percent}% (${mb(loaded)} of ${mb(total)} MB)` : 'Preparing local speech model…',
    });
  }

  function ensurePipeline(): Promise<AsrCall> {
    const cached = pipelineCache.get(cacheKey);
    if (cached) {
      if (progress.phase !== 'ready') cached.then(() => emit({ phase: 'ready', percent: 100, message: 'Local speech model ready (runs on this device).' }), () => undefined);
      return cached;
    }
    if (typeof WebAssembly === 'undefined') {
      const err = new SttError('unsupported', 'This browser has no WebAssembly support, which the local Whisper model needs.');
      emit({ phase: 'error', percent: 0, message: err.message, error: err });
      return Promise.reject(err);
    }
    files.clear();
    emit({ phase: 'downloading', percent: 0, message: 'Preparing local speech model…' });
    const p = (async () => {
      let tf: TransformersModule;
      try {
        tf = await loadTransformers();
      } catch (cause) {
        throw new SttError('network', 'Could not load the local speech engine code. Check your connection and reload the page.', { cause });
      }
      if (tf.env) {
        tf.env.allowLocalModels = false; // never probe the dev server for /models/... (it answers index.html)
        tf.env.useBrowserCache = true; // persist model files in the Cache API
      }
      try {
        const asr = await tf.pipeline('automatic-speech-recognition', model, {
          device,
          dtype,
          progress_callback: onFileProgress,
        });
        emit({ phase: 'loading', percent: 99, message: 'Starting local speech model…' });
        return asr;
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : String(cause);
        const offline = /failed to fetch|fetch failed|networkerror|network|load failed|could not locate|\b(?:401|403|404|5\d\d)\b|cors|huggingface/i.test(text);
        throw new SttError(
          offline ? 'network' : 'unsupported',
          offline
            ? `Could not download the local speech model (${model}) from huggingface.co. Check your internet connection and try “Download / prepare local model” again. (${text})`
            : `The local speech model could not start in this browser (WebAssembly/WebGPU problem). (${text})`,
          { cause },
        );
      }
    })();
    pipelineCache.set(cacheKey, p);
    p.then(
      () => emit({ phase: 'ready', percent: 100, message: 'Local speech model ready (runs on this device).' }),
      (err: unknown) => {
        pipelineCache.delete(cacheKey); // allow a retry
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

  /**
   * Idle audio graph kept between key presses so the microphone is heard from the first instant (building it on demand
   * loses roughly the first half second of speech). It has no microphone attached while idle.
   */
  let warm: Promise<WarmAudio | null> | null = null;
  const getWarm = (): Promise<WarmAudio | null> => {
    warm ??= (options.warmUpAudio ?? warmUpAudio)().catch(() => null);
    return warm;
  };

  return {
    id: LOCAL_WHISPER_ID,
    label: LOCAL_WHISPER_LABEL,
    model,
    finalTimeoutMs,
    placeholderPartial: WHISPER_PLACEHOLDER,

    async isAvailable() {
      return typeof WebAssembly !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices;
    },

    getProgress: () => progress,
    onProgress(listener) {
      listeners.add(listener);
      listener(progress);
      return () => listeners.delete(listener);
    },

    async warmUp() {
      void getWarm(); // also prepare the idle audio graph (the click is a user gesture, so it can start running)
      await ensurePipeline();
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
          media({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }),
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
      void ensurePipeline().catch(() => undefined);
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
      if (audio.length < MIN_SAMPLES || meanAbs(audio) < SILENCE_LEVEL) {
        c.opts.onError(new SttError('no_speech', 'No speech detected. Hold the key, then speak.'));
        return;
      }
      c.opts.onPartial(WHISPER_PLACEHOLDER);
      let asr: AsrCall;
      try {
        asr = await ensurePipeline();
      } catch (err) {
        c.opts.onError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let text: string;
      try {
        const call: Record<string, unknown> = { chunk_length_s: 30, return_timestamps: false };
        if (!isEnglishOnly(model)) {
          call.language = 'en';
          call.task = 'transcribe';
        }
        const out = await asr(audio, call);
        const first = Array.isArray(out) ? out[0] : out;
        text = typeof first?.text === 'string' ? first.text : '';
      } catch (cause) {
        c.opts.onError(new SttError('unknown', `Local speech recognition failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }));
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
  return (shared ??= createLocalWhisperProvider());
}
