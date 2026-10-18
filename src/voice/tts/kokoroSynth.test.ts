import { describe, expect, it, vi } from 'vitest';
import { createKokoroSynth, resolveNeuralDevice } from './kokoroSynth.ts';
import type { KokoroWorkerLike } from './kokoroSynth.ts';
import type { KokoroWorkerEvent, KokoroWorkerRequest } from './kokoroProtocol.ts';

/** A worker the test drives by hand. */
interface Driver { emit(e: KokoroWorkerEvent): void; terminated: boolean; sent: KokoroWorkerRequest[] }

function fakeWorkers(script: (w: Driver, req: KokoroWorkerRequest) => void) {
  const made: Driver[] = [];
  class Fake implements KokoroWorkerLike, Driver {
    sent: KokoroWorkerRequest[] = [];
    terminated = false;
    onmessage: ((e: MessageEvent<KokoroWorkerEvent>) => void) | null = null;
    onerror: ((e: ErrorEvent) => unknown) | null = null;
    postMessage(m: KokoroWorkerRequest) {
      this.sent.push(m);
      script(this, m);
    }
    terminate() { this.terminated = true; }
    emit(e: KokoroWorkerEvent) { this.onmessage?.({ data: e } as MessageEvent<KokoroWorkerEvent>); }
  }
  return { made, create: () => { const w = new Fake(); made.push(w); return w as KokoroWorkerLike; } };
}

const audio = (id: number): KokoroWorkerEvent => ({ type: 'audio', id, samples: new Float32Array(240), sampleRate: 24000, genMs: 5 });

/** A worker that loads fine and answers every generate request. */
const healthy = (w: { emit(e: KokoroWorkerEvent): void }, req: KokoroWorkerRequest) => {
  if (req.type === 'load') queueMicrotask(() => w.emit({ type: 'ready', device: req.device, dtype: req.dtype }));
  else queueMicrotask(() => w.emit(audio(req.id)));
};

describe('device choice', () => {
  it('uses WebGPU only when the browser has it, the user allows it, and it has not failed', () => {
    expect(resolveNeuralDevice('auto', true, false)).toBe('webgpu');
    expect(resolveNeuralDevice('auto', false, false)).toBe('wasm');
    expect(resolveNeuralDevice('webgpu', true, false)).toBe('webgpu');
    expect(resolveNeuralDevice('webgpu', false, false)).toBe('wasm');
    expect(resolveNeuralDevice('wasm', true, false)).toBe('wasm');
    expect(resolveNeuralDevice('auto', true, true)).toBe('wasm');
  });
});

describe('Kokoro synthesiser', () => {
  it('asks for a Kokoro worker on WebGPU and a Piper worker on WebAssembly', async () => {
    const seen: string[] = [];
    const w = fakeWorkers(healthy);
    for (const gpu of [true, false]) {
      const synth = createKokoroSynth({ createWorker: (d) => { seen.push(d); return w.create(); }, gpu });
      await synth.ensureLoaded();
    }
    expect(seen).toEqual(['webgpu', 'wasm']);
  });

  it('loads Kokoro on WebGPU with the dtype that was verified for it, warms up, then is ready', async () => {
    const w = fakeWorkers(healthy);
    const synth = createKokoroSynth({ createWorker: w.create, gpu: true, getDeviceChoice: () => 'auto' });
    const seen: string[] = [];
    synth.onProgress((p) => seen.push(p.phase));
    expect(synth.isReady()).toBe(false);
    await synth.ensureLoaded();
    expect(synth.isReady()).toBe(true);
    expect(w.made).toHaveLength(1);
    expect(w.made[0].sent[0]).toMatchObject({ type: 'load', device: 'webgpu', dtype: 'fp32' });
    expect(w.made[0].sent[1]).toMatchObject({ type: 'generate' }); // warm-up before ready
    expect(seen).toContain('loading');
    expect(seen[seen.length - 1]).toBe('ready');
    expect(synth.getDevice()).toBe('webgpu');
    expect(synth.getEngine()).toBe('kokoro');
    await synth.ensureLoaded();
    expect(w.made).toHaveLength(1); // joined, not reloaded
  });

  it('runs the Piper worker on WebAssembly', async () => {
    const w = fakeWorkers(healthy);
    const synth = createKokoroSynth({ createWorker: w.create, gpu: false });
    await synth.ensureLoaded();
    expect(w.made[0].sent[0]).toMatchObject({ device: 'wasm' });
    expect(synth.getEngine()).toBe('piper');
  });

  it('aggregates file progress into one percentage', async () => {
    let worker: { emit(e: KokoroWorkerEvent): void } | null = null;
    const w = fakeWorkers((fw, req) => {
      worker = fw;
      if (req.type === 'load') {
        fw.emit({ type: 'progress', info: { status: 'progress', file: 'a.onnx', loaded: 50, total: 100 } });
        fw.emit({ type: 'progress', info: { status: 'progress', file: 'b.json', loaded: 0, total: 100 } });
      }
    });
    const synth = createKokoroSynth({ createWorker: w.create, gpu: false });
    void synth.ensureLoaded().catch(() => undefined);
    expect(synth.getProgress().phase).toBe('downloading');
    expect(synth.getProgress().percent).toBe(25);
    expect(worker).not.toBeNull();
  });

  it('synthesises PCM through the worker and rejects before the model is ready', async () => {
    const w = fakeWorkers(healthy);
    const synth = createKokoroSynth({ createWorker: w.create, gpu: false });
    await expect(synth.synthesize({ text: 'x', voice: 'am_michael', speed: 1 })).rejects.toThrow(/not ready/);
    await synth.ensureLoaded();
    const pcm = await synth.synthesize({ text: 'Roger', voice: 'af_heart', speed: 1.1 });
    expect(pcm.sampleRate).toBe(24000);
    expect(pcm.samples).toHaveLength(240);
    const sent = w.made[0].sent.at(-1);
    expect(sent).toMatchObject({ type: 'generate', text: 'Roger', voice: 'af_heart', speed: 1.1 });
  });

  it('falls back from WebGPU to WebAssembly when the GPU load fails', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const w = fakeWorkers((fw, req) => {
      if (req.type === 'load' && req.device === 'webgpu') queueMicrotask(() => fw.emit({ type: 'error', stage: 'load', message: 'No WebGPU adapter was found.' }));
      else healthy(fw, req);
    });
    const synth = createKokoroSynth({ createWorker: w.create, gpu: true });
    await synth.ensureLoaded();
    expect(w.made).toHaveLength(2);
    expect(w.made[0].terminated).toBe(true);
    expect(w.made[1].sent[0]).toMatchObject({ device: 'wasm' });
    expect(synth.getDevice()).toBe('wasm');
    expect(synth.getProgress().message).toMatch(/fell back to CPU/);
    info.mockRestore();
  });

  it('reports a load failure on WebAssembly and allows a retry', async () => {
    let fail = true;
    const w = fakeWorkers((fw, req) => {
      if (req.type === 'load' && fail) queueMicrotask(() => fw.emit({ type: 'error', stage: 'load', message: 'Failed to fetch' }));
      else healthy(fw, req);
    });
    const synth = createKokoroSynth({ createWorker: w.create, gpu: false });
    await expect(synth.ensureLoaded()).rejects.toThrow(/Failed to fetch/);
    expect(synth.getProgress().phase).toBe('error');
    fail = false;
    await synth.ensureLoaded();
    expect(synth.isReady()).toBe(true);
  });

  it('drops the GPU path when synthesis fails on WebGPU, and the next load runs on WebAssembly', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let breakGenerate = false;
    const w = fakeWorkers((fw, req) => {
      if (req.type === 'generate' && breakGenerate) queueMicrotask(() => fw.emit({ type: 'error', id: req.id, stage: 'generate', message: 'device lost' }));
      else healthy(fw, req);
    });
    const synth = createKokoroSynth({ createWorker: w.create, gpu: true });
    await synth.ensureLoaded();
    breakGenerate = true;
    await expect(synth.synthesize({ text: 'x', voice: 'am_michael', speed: 1 })).rejects.toThrow(/device lost/);
    expect(synth.isReady()).toBe(false);
    breakGenerate = false;
    await synth.ensureLoaded();
    expect(synth.getDevice()).toBe('wasm');
    info.mockRestore();
  });

  it('setDeviceChoice() resets the loaded model', async () => {
    const w = fakeWorkers(healthy);
    const synth = createKokoroSynth({ createWorker: w.create, gpu: true });
    await synth.ensureLoaded();
    synth.setDeviceChoice();
    expect(synth.isReady()).toBe(false);
    expect(w.made[0].terminated).toBe(true);
    expect(synth.getProgress().phase).toBe('idle');
  });
});
