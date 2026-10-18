/**
 * Web Worker that owns the transformers.js Whisper pipeline, so model start-up and decoding (about a second of solid
 * WebAssembly work) never block the UI thread. Loaded by localWhisperProvider.ts via
 * `new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' })`; protocol in whisperProtocol.ts.
 *
 * Audio never leaves the machine: the worker only receives PCM from the page and returns text. Its network access is
 * the same one-time model/runtime download described in localWhisperProvider.ts.
 */
import type { TransformersModule } from './localWhisperProvider.ts';
import { errorText } from './whisperProtocol.ts';
import type { WhisperWorkerEvent, WhisperWorkerRequest } from './whisperProtocol.ts';

type AsrCall = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: string } | Array<{ text?: string }>>;

interface WorkerScope {
  postMessage(message: WhisperWorkerEvent): void;
  onmessage: ((e: MessageEvent<WhisperWorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let asr: Promise<AsrCall> | null = null;

async function load(req: Extract<WhisperWorkerRequest, { type: 'load' }>): Promise<AsrCall> {
  let tf: TransformersModule;
  try {
    tf = (await import('@huggingface/transformers')) as unknown as TransformersModule;
  } catch (cause) {
    scope.postMessage({ type: 'error', stage: 'import', message: errorText(cause) });
    throw cause;
  }
  if (tf.env) {
    tf.env.allowLocalModels = false; // never probe the dev server for /models/... (it answers index.html)
    tf.env.useBrowserCache = true; // persist model files in the Cache API
  }
  try {
    if (req.device === 'webgpu') {
      // Fail fast and clearly (the page then falls back to WebAssembly) instead of letting onnxruntime guess.
      const gpu = (self as unknown as { navigator?: { gpu?: { requestAdapter(): Promise<unknown> } } }).navigator?.gpu;
      if (!gpu) throw new Error('WebGPU is not available in this worker.');
      if (!(await gpu.requestAdapter())) throw new Error('No WebGPU adapter was found.');
    }
    const pipe = await tf.pipeline('automatic-speech-recognition', req.model, {
      device: req.device,
      dtype: req.dtype,
      progress_callback: (info: Record<string, unknown>) => scope.postMessage({ type: 'progress', info }),
    });
    scope.postMessage({ type: 'ready' });
    return pipe;
  } catch (cause) {
    scope.postMessage({ type: 'error', stage: 'pipeline', message: errorText(cause) });
    throw cause;
  }
}

scope.onmessage = (e) => {
  const req = e.data;
  if (req.type === 'load') {
    asr ??= load(req);
    asr.catch(() => {
      asr = null; // allow a retry after a failed download
    });
    return;
  }
  if (req.type === 'transcribe') {
    void (async () => {
      try {
        if (!asr) throw new Error('The speech model has not been loaded.');
        const out = await (await asr)(req.audio, req.call);
        const first = Array.isArray(out) ? out[0] : out;
        scope.postMessage({ type: 'result', id: req.id, text: typeof first?.text === 'string' ? first.text : '' });
      } catch (cause) {
        scope.postMessage({ type: 'error', id: req.id, stage: 'transcribe', message: errorText(cause) });
      }
    })();
  }
};
