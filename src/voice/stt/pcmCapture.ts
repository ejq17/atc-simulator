/**
 * Microphone -> 16 kHz mono linear16 PCM, using only browser APIs.
 * AudioWorklet (inline source via Blob URL) with a ScriptProcessor fallback.
 */

export const TARGET_SAMPLE_RATE = 16000;

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Stateful box-filter resampler so chunk boundaries do not click. */
export function createResampler(inRate: number, outRate: number = TARGET_SAMPLE_RATE) {
  const ratio = inRate / outRate;
  let leftover = new Float32Array(0);
  let idx = 0;
  return {
    process(input: Float32Array): Float32Array {
      if (inRate === outRate) return input;
      const buf = new Float32Array(leftover.length + input.length);
      buf.set(leftover, 0);
      buf.set(input, leftover.length);
      const out: number[] = [];
      while (idx + ratio <= buf.length) {
        const start = Math.floor(idx);
        const end = Math.max(start + 1, Math.floor(idx + ratio));
        let sum = 0;
        for (let i = start; i < end; i++) sum += buf[i];
        out.push(sum / (end - start));
        idx += ratio;
      }
      const consumed = Math.floor(idx);
      leftover = buf.slice(consumed);
      idx -= consumed;
      return Float32Array.from(out);
    },
  };
}

export const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.count = 0;
    this.port.onmessage = (e) => { if (e.data && e.data.flush) this.flush(); };
  }
  flush() {
    if (this.count === 0) return;
    const out = new Float32Array(this.count);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    this.chunks = [];
    this.count = 0;
    this.port.postMessage(out, [out.buffer]);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.chunks.push(new Float32Array(ch));
      this.count += ch.length;
      if (this.count >= 2048) this.flush();
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

export interface PcmCapture {
  /** Flush buffered audio, release the microphone and audio graph. */
  stop(): Promise<void>;
  readonly inputSampleRate: number;
}

type AudioContextCtor = new (opts?: AudioContextOptions) => AudioContext;

/**
 * An AudioContext that is already running with the capture worklet registered, but with NO microphone attached.
 * Creating a context and compiling the worklet takes ~0.5 s, and anything spoken in that window is lost (measured with
 * Chrome's fake microphone: the first ~0.5 s of the clip vanished). A provider can build this once (it never touches
 * the microphone, so it is privacy-neutral) and hand it to every startPcmCapture call; the caller owns its lifetime.
 */
export interface WarmAudio {
  readonly ctx: AudioContext;
  /** False when AudioWorklet is unavailable and startPcmCapture will use the ScriptProcessor fallback. */
  readonly workletReady: boolean;
  close(): Promise<void>;
}

function audioContextCtor(): AudioContextCtor {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio is not available in this browser.');
  return Ctor;
}

/**
 * resume() on a context created without a user gesture can stay pending for a long time; never block capture on it.
 * Real key presses are gestures, so the context is normally running by the time audio is needed.
 */
function resumeQuietly(ctx: AudioContext): Promise<void> {
  if (ctx.state !== 'suspended') return Promise.resolve();
  return Promise.race([ctx.resume().catch(() => undefined), new Promise<void>((r) => setTimeout(r, 300))]);
}

async function registerWorklet(ctx: AudioContext): Promise<boolean> {
  if (!(ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined' && typeof URL.createObjectURL === 'function')) return false;
  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    return true;
  } catch {
    return false;
  }
}

export async function warmUpAudio(): Promise<WarmAudio> {
  const Ctor = audioContextCtor();
  let ctx: AudioContext;
  try {
    ctx = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    ctx = new Ctor();
  }
  void resumeQuietly(ctx);
  const workletReady = await registerWorklet(ctx);
  return { ctx, workletReady, close: () => ctx.close().catch(() => undefined) };
}

// ---- track-processor capture (preferred) ---------------------------------------------------------------------------------
// MediaStreamTrackProcessor hands us the microphone's AudioData frames directly. Unlike the AudioContext/AudioWorklet path it does
// not depend on an audio OUTPUT device: an AudioContext's clock is driven by the speakers/headphones, and when that device is
// stalled (closed laptop lid, a Bluetooth headset in call mode) the worklet never runs and capture silently returns nothing.
// It also needs no warm-up, so the first word is not clipped.

interface AudioDataLike {
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  copyTo(dest: Float32Array, opts: { planeIndex: number; format: 'f32-planar' }): void;
  close(): void;
}
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<AudioDataLike> };

const trackProcessorCtor = (): TrackProcessorCtor | undefined =>
  (globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;

export const hasTrackProcessor = (): boolean => typeof trackProcessorCtor() === 'function';

/** Chunk size handed to the consumer: 100 ms at 16 kHz (the processor itself delivers 10 ms frames). */
const CHUNK_SAMPLES = TARGET_SAMPLE_RATE / 10;

function startTrackProcessorCapture(stream: MediaStream, onChunk: (pcm: ArrayBuffer) => void): PcmCapture | null {
  const Ctor = trackProcessorCtor();
  const track = stream.getAudioTracks()[0];
  if (!Ctor || !track) return null;
  let reader: ReadableStreamDefaultReader<AudioDataLike>;
  try {
    reader = new Ctor({ track }).readable.getReader();
  } catch {
    return null;
  }
  let resampler: ReturnType<typeof createResampler> | null = null;
  let rate = (track.getSettings().sampleRate as number | undefined) ?? 48000;
  let pending = new Float32Array(0);
  const send = (f: Float32Array) => {
    const i16 = floatToInt16(f);
    onChunk(i16.buffer.slice(i16.byteOffset, i16.byteOffset + i16.byteLength) as ArrayBuffer);
  };
  const push = (down: Float32Array) => {
    if (!down.length) return;
    const all = new Float32Array(pending.length + down.length);
    all.set(pending, 0);
    all.set(down, pending.length);
    let o = 0;
    while (all.length - o >= CHUNK_SAMPLES) {
      send(all.subarray(o, o + CHUNK_SAMPLES));
      o += CHUNK_SAMPLES;
    }
    pending = all.slice(o);
  };

  const loop = (async () => {
    for (;;) {
      const { value: data, done } = await reader.read();
      if (done || !data) break;
      try {
        if (!resampler || data.sampleRate !== rate) {
          rate = data.sampleRate;
          resampler = createResampler(rate);
        }
        const n = data.numberOfFrames;
        const mono = new Float32Array(n);
        const plane = new Float32Array(n);
        for (let c = 0; c < data.numberOfChannels; c++) {
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          for (let i = 0; i < n; i++) mono[i] += plane[i] / data.numberOfChannels;
        }
        push(resampler.process(mono));
      } finally {
        data.close();
      }
    }
  })().catch(() => undefined);

  return {
    get inputSampleRate() {
      return rate;
    },
    async stop() {
      await new Promise((r) => setTimeout(r, 30)); // let in-flight frames arrive
      await reader.cancel().catch(() => undefined);
      stream.getTracks().forEach((t) => t.stop());
      await loop;
      if (pending.length) send(pending);
      pending = new Float32Array(0);
    },
  };
}

export async function startPcmCapture(
  stream: MediaStream,
  onChunk: (pcm: ArrayBuffer) => void,
  warm?: WarmAudio,
): Promise<PcmCapture> {
  const viaTrack = startTrackProcessorCapture(stream, onChunk);
  if (viaTrack) return viaTrack;

  const usable = warm && warm.ctx.state !== 'closed' ? warm : undefined;
  const w = usable ?? (await warmUpAudio());
  const ctx = w.ctx;
  await resumeQuietly(ctx);

  const resampler = createResampler(ctx.sampleRate);
  const emit = (f: Float32Array) => {
    const down = resampler.process(f);
    if (down.length) {
      const i16 = floatToInt16(down);
      onChunk(i16.buffer.slice(i16.byteOffset, i16.byteOffset + i16.byteLength) as ArrayBuffer);
    }
  };

  const source = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain();
  sink.gain.value = 0; // keep the graph pulled without playing the mic back
  sink.connect(ctx.destination);

  let teardown: () => Promise<void>;
  if (w.workletReady) {
    const node = new AudioWorkletNode(ctx, 'pcm-capture');
    node.port.onmessage = (e: MessageEvent<Float32Array>) => emit(e.data);
    source.connect(node);
    node.connect(sink);
    teardown = async () => {
      node.port.postMessage({ flush: true });
      await new Promise((r) => setTimeout(r, 40));
      node.port.onmessage = null;
      node.disconnect();
    };
  } else {
    // Deprecated but universally available fallback.
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => emit(new Float32Array(e.inputBuffer.getChannelData(0)));
    source.connect(proc);
    proc.connect(sink);
    teardown = async () => {
      proc.onaudioprocess = null;
      proc.disconnect();
    };
  }

  return {
    inputSampleRate: ctx.sampleRate,
    async stop() {
      await teardown();
      source.disconnect();
      sink.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      if (!usable) await w.close(); // a caller-supplied warm context stays open for the next press
    },
  };
}
