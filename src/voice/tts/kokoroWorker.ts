/**
 * Web Worker that owns the Kokoro-82M model (kokoro-js, on top of transformers.js / onnxruntime-web), so model start-up and
 * synthesis never block the UI thread. Loaded by kokoroSynth.ts via `new Worker(new URL('./kokoroWorker.ts', import.meta.url),
 * { type: 'module' })`; protocol in kokoroProtocol.ts.
 *
 * The only network traffic is the one-time download of the model files and voice style files from huggingface.co and of the
 * ONNX WebAssembly runtime from cdn.jsdelivr.net; the browser caches them. The text to speak never leaves the machine.
 */
import { KOKORO_MODEL_ID, errorText } from './kokoroProtocol.ts';
import type { KokoroWorkerEvent, KokoroWorkerRequest } from './kokoroProtocol.ts';

interface KokoroModel {
  generate(text: string, opts: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

interface WorkerScope {
  postMessage(message: KokoroWorkerEvent, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<KokoroWorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let model: Promise<KokoroModel> | null = null;

async function load(req: Extract<KokoroWorkerRequest, { type: 'load' }>): Promise<KokoroModel> {
  let mod: typeof import('kokoro-js');
  try {
    mod = await import('kokoro-js');
  } catch (cause) {
    scope.postMessage({ type: 'error', stage: 'import', message: errorText(cause) });
    throw cause;
  }
  try {
    if (req.device === 'webgpu') {
      const gpu = (self as unknown as { navigator?: { gpu?: { requestAdapter(): Promise<unknown> } } }).navigator?.gpu;
      if (!gpu) throw new Error('WebGPU is not available in this worker.');
      if (!(await gpu.requestAdapter())) throw new Error('No WebGPU adapter was found.');
    }
    const tts = await mod.KokoroTTS.from_pretrained(req.model || KOKORO_MODEL_ID, {
      dtype: req.dtype,
      device: req.device,
      progress_callback: (info: unknown) => scope.postMessage({ type: 'progress', info: info as Record<string, unknown> }),
    });
    scope.postMessage({ type: 'ready', device: req.device, dtype: req.dtype });
    return tts as unknown as KokoroModel;
  } catch (cause) {
    scope.postMessage({ type: 'error', stage: 'load', message: errorText(cause) });
    throw cause;
  }
}

scope.onmessage = (e) => {
  const req = e.data;
  if (req.type === 'load') {
    model ??= load(req);
    model.catch(() => {
      model = null; // allow a retry after a failed download
    });
    return;
  }
  void (async () => {
    try {
      if (!model) throw new Error('The speech model has not been loaded.');
      const m = await model;
      const t0 = performance.now();
      const out = await m.generate(req.text, { voice: req.voice, speed: req.speed });
      const samples = new Float32Array(out.audio); // own copy so the buffer can be transferred
      scope.postMessage({ type: 'audio', id: req.id, samples, sampleRate: out.sampling_rate, genMs: performance.now() - t0 }, [samples.buffer]);
    } catch (cause) {
      scope.postMessage({ type: 'error', id: req.id, stage: 'generate', message: errorText(cause) });
    }
  })();
};
