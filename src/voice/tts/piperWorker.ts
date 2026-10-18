/**
 * Web Worker for the WebAssembly (non-WebGPU) neural voice: Piper (VITS) voice en_US libritts_r medium, run with onnxruntime-web
 * and phonemised with espeak-ng (the `phonemizer` package, the same one kokoro-js uses). It speaks the same message protocol as
 * kokoroWorker.ts (kokoroProtocol.ts), where `voice` is a Piper speaker id as a string and `speed` divides the length scale.
 *
 * The 79 MB model file is downloaded from huggingface.co once and kept in the Cache API (`piper-voices`); the ONNX runtime
 * comes from cdn.jsdelivr.net. The text to speak never leaves the machine.
 */
import * as ort from 'onnxruntime-web/wasm';
import { phonemize } from 'phonemizer';
import { PIPER_CONFIG_URL, PIPER_MODEL_URL, errorText } from './kokoroProtocol.ts';
import type { KokoroWorkerEvent, KokoroWorkerRequest } from './kokoroProtocol.ts';

interface PiperConfig {
  audio: { sample_rate: number };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: Record<string, number[]>;
}

interface WorkerScope {
  postMessage(message: KokoroWorkerEvent, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<KokoroWorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
const CACHE_NAME = 'piper-voices';

interface Loaded { session: ort.InferenceSession; config: PiperConfig }
let loaded: Promise<Loaded> | null = null;

/** Download with byte progress; the result is kept in the Cache API so later visits read it from storage. */
async function fetchCached(url: string, report: boolean): Promise<Uint8Array> {
  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch { /* no Cache API (private window): download every time */ }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const file = url.split('/').pop() ?? url;
  const chunks: Uint8Array[] = [];
  let got = 0;
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    chunks.push(buf);
    got = buf.length;
  } else {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (report && total) scope.postMessage({ type: 'progress', info: { status: 'progress', file, loaded: got, total } });
    }
  }
  const all = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  if (report) scope.postMessage({ type: 'progress', info: { status: 'done', file } });
  try {
    await cache?.put(url, new Response(all, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch (cause) {
    console.warn('Unable to cache the Piper voice', cause);
  }
  return all;
}

async function load(): Promise<Loaded> {
  try {
    ort.env.wasm.numThreads = 1; // GitHub Pages cannot send the cross-origin-isolation headers threads need
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
    const [configBytes, modelBytes] = await Promise.all([fetchCached(PIPER_CONFIG_URL, false), fetchCached(PIPER_MODEL_URL, true)]);
    const config = JSON.parse(new TextDecoder().decode(configBytes)) as PiperConfig;
    const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });
    scope.postMessage({ type: 'ready', device: 'wasm', dtype: 'fp32' });
    return { session, config };
  } catch (cause) {
    scope.postMessage({ type: 'error', stage: 'load', message: errorText(cause) });
    throw cause;
  }
}

async function synthesize(l: Loaded, text: string, speaker: number, speed: number): Promise<{ samples: Float32Array; sampleRate: number }> {
  const phonemes = (await phonemize(text, 'en-us')).join(' ');
  const map = l.config.phoneme_id_map;
  // Piper input: BOS, then each phoneme id followed by a pad, then EOS.
  const ids: number[] = [...(map['^'] ?? [1])];
  for (const ch of phonemes) {
    const m = map[ch];
    if (m) ids.push(...m, ...(map['_'] ?? [0]));
  }
  ids.push(...(map['$'] ?? [2]));
  const inf = l.config.inference;
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale, inf.length_scale / Math.max(0.3, speed), inf.noise_w]), [3]),
    sid: new ort.Tensor('int64', BigInt64Array.from([BigInt(speaker)]), [1]),
  };
  const out = await l.session.run(feeds);
  const data = out.output.data as Float32Array;
  return { samples: new Float32Array(data), sampleRate: l.config.audio.sample_rate };
}

scope.onmessage = (e) => {
  const req = e.data;
  if (req.type === 'load') {
    loaded ??= load();
    loaded.catch(() => {
      loaded = null; // allow a retry after a failed download
    });
    return;
  }
  void (async () => {
    try {
      if (!loaded) throw new Error('The speech model has not been loaded.');
      const l = await loaded;
      const t0 = performance.now();
      const speaker = Number.parseInt(req.voice, 10);
      const r = await synthesize(l, req.text, Number.isFinite(speaker) ? speaker : 0, req.speed);
      scope.postMessage({ type: 'audio', id: req.id, samples: r.samples, sampleRate: r.sampleRate, genMs: performance.now() - t0 }, [r.samples.buffer]);
    } catch (cause) {
      scope.postMessage({ type: 'error', id: req.id, stage: 'generate', message: errorText(cause) });
    }
  })();
};
