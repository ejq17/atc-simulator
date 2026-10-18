/**
 * Main-thread side of the neural synthesiser: Kokoro-82M on WebGPU, Piper (libritts_r medium) on WebAssembly. Owns the worker, aggregates download progress, picks device and
 * quantisation, and falls back from WebGPU to WebAssembly (same model files family, q8) when the GPU path fails.
 *
 * Download sizes come from the Hugging Face repo `onnx-community/Kokoro-82M-v1.0-ONNX` (see src/voice/README.md for the
 * measured numbers). Static hosting needs nothing from this site: model files come from huggingface.co, the ONNX runtime from
 * cdn.jsdelivr.net, and the browser caches both.
 */
import { KOKORO_MODEL_ID, errorText } from './kokoroProtocol.ts';
import type { KokoroDevice, KokoroDtype, KokoroWorkerEvent, KokoroWorkerRequest, NeuralEngineId } from './kokoroProtocol.ts';
import type { NeuralProgress, NeuralSynth, PcmAudio, SynthesisRequest } from './neuralTypes.ts';

export type NeuralDeviceChoice = 'auto' | 'wasm' | 'webgpu';
export const NEURAL_DEVICE_CHOICES: readonly NeuralDeviceChoice[] = ['auto', 'wasm', 'webgpu'];

export interface KokoroWorkerLike {
  postMessage(message: KokoroWorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<KokoroWorkerEvent>) => void) | null;
  onerror: ((e: ErrorEvent) => unknown) | null;
  terminate(): void;
}

export function hasWebGpuForTts(nav: unknown = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  return !!nav && typeof nav === 'object' && !!(nav as { gpu?: unknown }).gpu;
}

/**
 * Quantisation per device. Measured on this project's target machine (Apple silicon, Chrome): WebGPU with fp16 or q4f16
 * produced unintelligible audio (a Whisper transcription of the output was garbage) and WebGPU q8 ran 10x slower, so WebGPU
 * uses fp32; WebAssembly uses the 8-bit model, which transcribes correctly.
 */
export const NEURAL_DTYPE: Record<KokoroDevice, KokoroDtype> = { wasm: 'fp32', webgpu: 'fp32' };

/** Approximate one-time download (MB), measured from the Hugging Face file listing; see README. */
export const NEURAL_MODEL_MB: Record<KokoroDevice, number> = { wasm: 79, webgpu: 326 };

/** The engine each device runs. */
export const engineForDevice = (d: KokoroDevice): NeuralEngineId => (d === 'webgpu' ? 'kokoro' : 'piper');

function defaultWorker(device: KokoroDevice): KokoroWorkerLike {
  return (device === 'webgpu'
    ? new Worker(new URL('./kokoroWorker.ts', import.meta.url), { type: 'module' })
    : new Worker(new URL('./piperWorker.ts', import.meta.url), { type: 'module' })) as unknown as KokoroWorkerLike;
}

const DTYPES: readonly KokoroDtype[] = ['fp32', 'fp16', 'q8', 'q4', 'q4f16'];

/** Default quantisation per device; localStorage `kacy.neural.dtype` overrides it for measurements. */
function defaultDtype(device: KokoroDevice): KokoroDtype {
  if (device === 'wasm') return 'fp32'; // Piper has one model file
  try {
    const o = typeof localStorage !== 'undefined' ? localStorage.getItem('kacy.neural.dtype') : null;
    if (o && DTYPES.includes(o as KokoroDtype)) return o as KokoroDtype;
  } catch { /* storage blocked */ }
  return NEURAL_DTYPE[device];
}

export function resolveNeuralDevice(choice: NeuralDeviceChoice, gpu: boolean, webGpuFailed: boolean): KokoroDevice {
  if (choice === 'wasm' || webGpuFailed) return 'wasm';
  return gpu ? 'webgpu' : 'wasm';
}

export interface KokoroSynthOptions {
  getDeviceChoice?: () => NeuralDeviceChoice;
  gpu?: boolean;
  createWorker?: (device: KokoroDevice) => KokoroWorkerLike;
  dtypeFor?: (device: KokoroDevice) => KokoroDtype;
}

interface Pending { resolve(a: PcmAudio): void; reject(e: Error): void }

const WARMUP_TEXT = 'Runway one three, cleared for takeoff, Cessna seven two three echo juliet.';

const mb = (bytes: number) => (bytes / 1_048_576).toFixed(0);

export function createKokoroSynth(options: KokoroSynthOptions = {}): NeuralSynth & {
  getDevice(): KokoroDevice | null;
  /** Which engine is loaded (null before the model is ready). */
  getEngine(): NeuralEngineId | null;
  /** Milliseconds the model itself took for the last synthesis. */
  getLastGenMs(): number | null;
  setDeviceChoice(): void;
} {
  const createWorker = options.createWorker ?? defaultWorker;
  const dtypeFor = options.dtypeFor ?? defaultDtype;
  let webGpuFailed = false;
  let worker: KokoroWorkerLike | null = null;
  let loading: Promise<void> | null = null;
  let ready = false;
  let device: KokoroDevice | null = null;
  let nextId = 1;
  let lastGenMs: number | null = null;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(p: NeuralProgress) => void>();
  let progress: NeuralProgress = { phase: 'idle', percent: 0, message: 'Neural voice model not downloaded yet.' };
  const files = new Map<string, { loaded: number; total: number }>();
  let loadWaiters: { resolve(): void; reject(e: Error): void } | null = null;

  const emit = (p: NeuralProgress) => {
    progress = p;
    listeners.forEach((l) => l(p));
  };

  function failAll(err: Error) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  function onProgress(info: Record<string, unknown>, target: KokoroDevice) {
    const file = typeof info.file === 'string' ? info.file : undefined;
    const loaded = typeof info.loaded === 'number' ? info.loaded : undefined;
    const total = typeof info.total === 'number' ? info.total : undefined;
    if (file && loaded !== undefined && total !== undefined && info.status === 'progress') files.set(file, { loaded, total });
    if (file && info.status === 'done') {
      const f = files.get(file);
      if (f) files.set(file, { loaded: f.total, total: f.total });
    }
    let l = 0;
    let t = 0;
    for (const f of files.values()) {
      l += f.loaded;
      t += f.total;
    }
    const percent = t > 0 ? Math.min(99, Math.round((l / t) * 100)) : progress.percent;
    emit({
      phase: 'downloading',
      percent,
      device: target,
      message: t > 0 ? `Downloading the neural voice model: ${percent}% (${mb(l)} of ${mb(t)} MB)` : `Preparing the neural voice model (about ${NEURAL_MODEL_MB[target]} MB the first time, ${engineForDevice(target) === 'kokoro' ? 'Kokoro' : 'Piper'})…`,
    });
  }

  function startWorker(target: KokoroDevice): Promise<void> {
    worker?.terminate();
    files.clear();
    const w = createWorker(target);
    worker = w;
    const dtype = dtypeFor(target);
    emit({ phase: 'downloading', percent: 0, device: target, message: `Preparing the neural voice model (about ${NEURAL_MODEL_MB[target]} MB the first time, ${target === 'webgpu' ? 'GPU' : 'CPU'})…` });
    return new Promise<void>((resolve, reject) => {
      loadWaiters = { resolve, reject };
      w.onerror = (e) => {
        const err = new Error(`The neural voice worker failed: ${(e as ErrorEvent).message ?? 'unknown error'}`);
        failAll(err);
        loadWaiters?.reject(err);
        loadWaiters = null;
      };
      w.onmessage = (e) => {
        if (worker !== w) return;
        const m = e.data;
        if (m.type === 'progress') return onProgress(m.info, target);
        if (m.type === 'ready') {
          device = m.device;
          const finishReady = () => {
            if (worker !== w) return;
            ready = true;
            emit({ phase: 'ready', percent: 100, device: m.device, message: m.device === 'webgpu' ? `Ready: Kokoro-82M on WebGPU (${m.dtype})` : 'Ready: Piper (libritts_r) on WebAssembly' });
            loadWaiters?.resolve();
            loadWaiters = null;
          };
          if (m.device !== 'webgpu') return finishReady();
          emit({ phase: 'loading', percent: 99, device: m.device, message: 'Warming up the neural voice…' });
          // The first WebGPU synthesis compiles the shaders (about 4 s extra, measured); do it now so the first pilot call is fast.
          const warmId = nextId++;
          new Promise<PcmAudio>((resolve, reject) => {
            pending.set(warmId, { resolve, reject });
            w.postMessage({ type: 'generate', id: warmId, text: WARMUP_TEXT, voice: 'am_michael', speed: 1 });
          }).then(finishReady, (err: Error) => {
            loadWaiters?.reject(err);
            loadWaiters = null;
          });
          return;
        }
        if (m.type === 'audio') {
          lastGenMs = m.genMs;
          const p = pending.get(m.id);
          pending.delete(m.id);
          p?.resolve({ samples: m.samples, sampleRate: m.sampleRate });
          return;
        }
        // error
        const err = new Error(m.message);
        if (m.id !== undefined) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          p?.reject(err);
          if (ready && device === 'webgpu') {
            // The GPU path broke while running: drop it, the next call reloads on WebAssembly.
            webGpuFailed = true;
            console.info(`[tts] WebGPU synthesis failed (${m.message}); the next load uses WebAssembly.`);
            w.terminate();
            worker = null;
            ready = false;
            loading = null;
            failAll(err);
            emit({ phase: 'idle', percent: 0, message: 'WebGPU failed; the neural voice will restart on the CPU.' });
          }
          return;
        }
        loadWaiters?.reject(err);
        loadWaiters = null;
      };
      w.postMessage({ type: 'load', model: KOKORO_MODEL_ID, device: target, dtype });
    });
  }

  async function load(): Promise<void> {
    const choice = options.getDeviceChoice?.() ?? 'auto';
    const first = resolveNeuralDevice(choice, options.gpu ?? hasWebGpuForTts(), webGpuFailed);
    try {
      await startWorker(first);
    } catch (cause) {
      if (first === 'webgpu') {
        webGpuFailed = true;
        console.info(`[tts] WebGPU failed for the neural voice (${errorText(cause)}); falling back to WebAssembly.`);
        await startWorker('wasm');
        emit({ ...progress, message: `${progress.message} (WebGPU unavailable, fell back to CPU)` });
        return;
      }
      throw cause;
    }
  }

  return {
    ensureLoaded() {
      if (ready) return Promise.resolve();
      // Ask the browser not to evict the model files under storage pressure (the answer is advisory; Chrome decides silently).
      try {
        void navigator.storage?.persist?.().catch(() => undefined);
      } catch { /* no storage API */ }
      loading ??= load().catch((cause: unknown) => {
        loading = null;
        const err = cause instanceof Error ? cause : new Error(String(cause));
        emit({ phase: 'error', percent: 0, message: `The neural voice could not start: ${err.message}`, error: err });
        throw err;
      });
      return loading;
    },
    isReady: () => ready,
    synthesize(req: SynthesisRequest) {
      const w = worker;
      if (!ready || !w) return Promise.reject(new Error('The neural voice model is not ready.'));
      const id = nextId++;
      return new Promise<PcmAudio>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({ type: 'generate', id, text: req.text, voice: req.voice, speed: req.speed });
      });
    },
    getProgress: () => progress,
    onProgress(listener) {
      listeners.add(listener);
      listener(progress);
      return () => listeners.delete(listener);
    },
    getDevice: () => device,
    getEngine: () => (ready && device ? engineForDevice(device) : null),
    getLastGenMs: () => lastGenMs,
    setDeviceChoice() {
      // A different device choice takes effect on the next load: drop the loaded model.
      worker?.terminate();
      worker = null;
      ready = false;
      loading = null;
      device = null;
      failAll(new Error('The neural voice was reset.'));
      emit({ phase: 'idle', percent: 0, message: 'Neural voice model not downloaded yet.' });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      ready = false;
      loading = null;
      failAll(new Error('The neural voice was disposed.'));
    },
  };
}
