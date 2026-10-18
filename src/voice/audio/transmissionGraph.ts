/**
 * The WebAudio graph for ONE synthesised transmission, built per aircraft and per call:
 *
 *   speech sources -> highpass -> lowpass -> drive -> soft clipper -> compressor -> fading flutter -> output -> destination
 *   noise source  -> highpass -> lowpass -> noise gain (carrier hiss, squelch tail) -----------------^
 *
 * `destination` is the shared radio chain's input (`RadioEffects.getInputNode()`: 300-3000 Hz band, light waveshaper,
 * compressor, master volume) when radio effects are on, or the context destination when they are off. The per-transmission
 * part only narrows the band, adds noise, compression, mild clipping and fading for this aircraft and its distance.
 */
import { seededRandom } from '../tts/radioVariation.ts';
import type { RadioConditions } from '../tts/radioVariation.ts';

/** Silent carrier before the voice starts (the transmitter is keyed a moment before the pilot speaks). */
export const CARRIER_LEAD_SEC = 0.05;

export interface TransmissionGraphOptions {
  ctx: AudioContext;
  destination: AudioNode;
  /** First piece of speech. More pieces can follow with `append()` while this one is already playing. */
  audio: AudioBuffer;
  conditions: RadioConditions;
  /** Linear output level, 0..1. */
  volume: number;
  /** Playback speed of the buffer (a pitch shift); 1 = as synthesised. */
  playbackRate: number;
  /** Seeds the flutter pattern so a given call always fades the same way. */
  seed: number;
}

export interface TransmissionGraph {
  nodes: {
    /** One source per piece of speech, in order (the array grows with `append`). */
    sources: AudioBufferSourceNode[];
    highpass: BiquadFilterNode;
    lowpass: BiquadFilterNode;
    drive: GainNode;
    shaper: WaveShaperNode;
    compressor: DynamicsCompressorNode;
    flutter: GainNode;
    output: GainNode;
    noise: AudioBufferSourceNode;
    noiseHighpass: BiquadFilterNode;
    noiseLowpass: BiquadFilterNode;
    noiseGain: GainNode;
  };
  /** Seconds of speech scheduled so far, at the playback speed. */
  readonly speechSec: number;
  /** Seconds from start() until the squelch tail has died away (known once `finish()` was called). */
  readonly totalSec: number;
  /** Keys the transmitter and starts the first piece of speech. */
  start(): void;
  /** Queue the next piece of speech to follow the previous one without a gap. Ignored after `finish()` or `stop()`. */
  append(audio: AudioBuffer): void;
  /** No more speech is coming: release the key (squelch tail follows) once the last piece has played. */
  finish(): void;
  /** Stop immediately (stepped on, cleared). Safe to call twice. */
  stop(): void;
  /** Resolves when the transmission (voice plus squelch tail) is over or stopped. */
  ended: Promise<void>;
}

/** Soft clipper: unity-ish for small signals, rounding off peaks the harder the signal is driven. */
export function softClipCurve(strength: number, points = 1024): Float32Array<ArrayBuffer> {
  const k = Math.max(1, strength);
  const curve = new Float32Array(points);
  const norm = Math.tanh(k);
  for (let i = 0; i < points; i++) {
    const x = (i * 2) / (points - 1) - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/**
 * Gain pattern for weak-signal fading, one value per 1/rateHz seconds, each in [1 - depth, 1]. Deterministic in the seed.
 * Returns an empty array when depth is 0 (no flutter node automation needed).
 */
export function flutterCurve(depth: number, seed: number, durationSec: number, rateHz = 22): Float32Array<ArrayBuffer> {
  if (depth <= 0) return new Float32Array(0);
  const n = Math.max(2, Math.ceil(durationSec * rateHz) + 1);
  const rnd = seededRandom(seed);
  const out = new Float32Array(n);
  let prev = 1;
  for (let i = 0; i < n; i++) {
    // Mostly gentle movement, occasionally a deeper dip.
    const dip = rnd() < 0.12 ? 1 : rnd() * 0.5;
    const target = 1 - depth * dip;
    prev = prev * 0.45 + target * 0.55;
    out[i] = Math.min(1, Math.max(1 - depth, prev));
  }
  return out;
}

const noiseCache = new WeakMap<object, AudioBuffer>();

/** A shared 2 s mono noise buffer per context (seeded, so identical every run). */
export function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const hit = noiseCache.get(ctx);
  if (hit) return hit;
  const len = Math.max(1, Math.floor(ctx.sampleRate * 2));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rnd = seededRandom(0x5eed1234);
  for (let i = 0; i < len; i++) data[i] = rnd() * 2 - 1;
  noiseCache.set(ctx, buf);
  return buf;
}

export function buildTransmissionGraph(o: TransmissionGraphOptions): TransmissionGraph {
  const { ctx, destination, conditions: c } = o;
  const rate = o.playbackRate > 0 ? o.playbackRate : 1;
  const tailSec = c.tailMs / 1000;

  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = c.highpassHz;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = c.lowpassHz;
  const drive = ctx.createGain();
  drive.gain.value = c.drive;
  const shaper = ctx.createWaveShaper();
  shaper.curve = softClipCurve(c.drive > 1 ? 1 + (c.drive - 1) * 1.5 : 1);
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = c.compThresholdDb;
  compressor.ratio.value = c.compRatio;
  const flutter = ctx.createGain();
  flutter.gain.value = 1;
  const output = ctx.createGain();
  output.gain.value = Math.min(1.5, Math.max(0, o.volume * c.gain));

  highpass.connect(lowpass);
  lowpass.connect(drive);
  drive.connect(shaper);
  shaper.connect(compressor);
  compressor.connect(flutter);
  flutter.connect(output);
  output.connect(destination);

  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer(ctx);
  noise.loop = true;
  const noiseHighpass = ctx.createBiquadFilter();
  noiseHighpass.type = 'highpass';
  noiseHighpass.frequency.value = Math.max(250, c.highpassHz - 60);
  const noiseLowpass = ctx.createBiquadFilter();
  noiseLowpass.type = 'lowpass';
  noiseLowpass.frequency.value = Math.min(3200, c.lowpassHz + 300);
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;
  noise.connect(noiseHighpass);
  noiseHighpass.connect(noiseLowpass);
  noiseLowpass.connect(noiseGain);
  noiseGain.connect(output);

  let resolveEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  let started = false;
  let stopped = false;
  let finished = false;
  let t0 = 0;
  /** ctx time at which the next piece of speech starts. */
  let cursor = 0;
  let speechSec = 0;
  let totalSec = 0;
  let pieces = 0;
  const sources: AudioBufferSourceNode[] = [];
  let safety: ReturnType<typeof setTimeout> | undefined;

  const finishNow = () => {
    if (safety) clearTimeout(safety);
    safety = undefined;
    for (const n of [...sources, noise] as AudioScheduledSourceNode[]) {
      try {
        n.disconnect();
      } catch { /* already disconnected */ }
    }
    try {
      output.disconnect();
    } catch { /* already disconnected */ }
    resolveEnded();
  };
  noise.onended = finishNow;

  function schedule(buffer: AudioBuffer) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(highpass);
    const len = buffer.duration / rate;
    // Never schedule in the past: a piece that arrives late starts now (the carrier simply stays up in between).
    const at = Math.max(cursor, ctx.currentTime);
    const pattern = flutterCurve(c.flutterDepth, o.seed + pieces * 7919, len);
    if (pattern.length > 1) flutter.gain.setValueCurveAtTime(pattern, at, len);
    src.start(at);
    cursor = at + len;
    speechSec += len;
    pieces++;
    sources.push(src);
  }

  return {
    nodes: { sources, highpass, lowpass, drive, shaper, compressor, flutter, output, noise, noiseHighpass, noiseLowpass, noiseGain },
    get speechSec() {
      return speechSec;
    },
    get totalSec() {
      return totalSec;
    },
    ended,
    start() {
      if (started || stopped) return;
      started = true;
      t0 = ctx.currentTime;
      cursor = t0 + CARRIER_LEAD_SEC;
      // Carrier hiss: fades in when keyed and holds until the key is released.
      noiseGain.gain.setValueAtTime(0, t0);
      noiseGain.gain.linearRampToValueAtTime(c.noiseFloor, t0 + 0.02);
      noise.start(t0);
      schedule(o.audio);
      safety = setTimeout(finishNow, (speechSec + CARRIER_LEAD_SEC + tailSec + 20) * 1000);
    },
    append(audio) {
      if (!started || stopped || finished) return;
      schedule(audio);
    },
    finish() {
      if (!started || stopped || finished) return;
      finished = true;
      const speechEnd = cursor;
      totalSec = speechEnd - t0 + tailSec;
      noiseGain.gain.setValueAtTime(c.noiseFloor, speechEnd);
      // The tail is a short burst of hiss, a little louder than the carrier, that dies away when the key is released.
      noiseGain.gain.linearRampToValueAtTime(c.noiseFloor * 2.2, speechEnd + 0.008);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, speechEnd + Math.max(0.02, tailSec));
      noise.stop(speechEnd + tailSec + 0.03);
      if (safety) clearTimeout(safety);
      safety = setTimeout(finishNow, (totalSec + 1.5) * 1000);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (started) {
        for (const n of [...sources, noise] as AudioScheduledSourceNode[]) {
          try {
            n.stop();
          } catch { /* already stopped */ }
        }
      }
      finishNow();
    },
  };
}
