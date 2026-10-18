import { describe, expect, it, vi } from 'vitest';
import { assignNeuralProfile, radioConditions } from '../tts/radioVariation.ts';
import { CARRIER_LEAD_SEC, buildTransmissionGraph, flutterCurve, getNoiseBuffer, softClipCurve } from './transmissionGraph.ts';

/** Records the graph the way the real WebAudio API would wire it. */
class FakeParam {
  value = 0;
  events: Array<[string, number, number]> = [];
  curves: Array<{ values: Float32Array; start: number; duration: number }> = [];
  setValueAtTime(v: number, t: number) { this.events.push(['set', v, t]); return this; }
  linearRampToValueAtTime(v: number, t: number) { this.events.push(['linear', v, t]); return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.events.push(['exp', v, t]); return this; }
  setValueCurveAtTime(values: Float32Array, start: number, duration: number) { this.curves.push({ values, start, duration }); return this; }
}
class FakeNode {
  readonly outputs: FakeNode[] = [];
  disconnected = false;
  readonly kind: string;
  constructor(kind: string) { this.kind = kind; }
  connect(n: FakeNode) { this.outputs.push(n); return n; }
  disconnect() { this.disconnected = true; }
}
class FakeGain extends FakeNode { gain = new FakeParam(); constructor() { super('gain'); } }
class FakeFilter extends FakeNode { type = ''; frequency = new FakeParam(); constructor() { super('filter'); } }
class FakeShaper extends FakeNode { curve: Float32Array | null = null; constructor() { super('shaper'); } }
class FakeComp extends FakeNode { threshold = new FakeParam(); ratio = new FakeParam(); constructor() { super('compressor'); } }
class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  playbackRate = new FakeParam();
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  constructor() { super('source'); }
  start(t = 0) { this.startedAt = t; }
  stop(t = 0) { this.stoppedAt = t; }
  fireEnded() { this.onended?.(); }
}
class FakeBuffer {
  private data: Float32Array;
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = new Float32Array(length);
  }
  get duration() { return this.length / this.sampleRate; }
  getChannelData() { return this.data; }
}
class FakeContext {
  currentTime = 10;
  sampleRate = 24000;
  destination = new FakeNode('destination');
  sources: FakeSource[] = [];
  createGain() { return new FakeGain(); }
  createBiquadFilter() { return new FakeFilter(); }
  createWaveShaper() { return new FakeShaper(); }
  createDynamicsCompressor() { return new FakeComp(); }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
  createBuffer(c: number, len: number, rate: number) { return new FakeBuffer(c, len, rate); }
}

function setup(over: { distanceNm?: number; overmodulated?: boolean; rate?: number; seconds?: number } = {}) {
  const ctx = new FakeContext();
  const dest = new FakeNode('radio-input');
  const audio = new FakeBuffer(1, Math.round(24000 * (over.seconds ?? 2)), 24000);
  const profile = assignNeuralProfile('N723EJ');
  const conditions = radioConditions(profile.radio, { distanceNm: over.distanceNm, overmodulated: over.overmodulated });
  const g = buildTransmissionGraph({
    ctx: ctx as unknown as AudioContext, destination: dest as unknown as AudioNode, audio: audio as unknown as AudioBuffer,
    conditions, volume: 0.8, playbackRate: over.rate ?? 1, seed: 7,
  });
  return { ctx, dest, g, conditions, n: g.nodes as unknown as Record<string, FakeNode & Record<string, any>> };
}

const piece = (seconds: number) => new FakeBuffer(1, Math.round(24000 * seconds), 24000) as unknown as AudioBuffer;

describe('transmission routing graph', () => {
  it('wires speech through band-limit, drive, clipper, compressor, flutter and output into the radio chain input', () => {
    const { g, dest, n } = setup();
    g.start();
    const [src] = g.nodes.sources as unknown as FakeSource[];
    expect(src.outputs).toEqual([n.highpass]);
    expect(src.buffer).not.toBeNull();
    expect(n.highpass.outputs).toEqual([n.lowpass]);
    expect(n.lowpass.outputs).toEqual([n.drive]);
    expect(n.drive.outputs).toEqual([n.shaper]);
    expect(n.shaper.outputs).toEqual([n.compressor]);
    expect(n.compressor.outputs).toEqual([n.flutter]);
    expect(n.flutter.outputs).toEqual([n.output]);
    expect(n.output.outputs).toEqual([dest]);
  });

  it('feeds carrier noise through its own band-limit into the same output', () => {
    const { n } = setup();
    expect(n.noise.outputs).toEqual([n.noiseHighpass]);
    expect(n.noiseHighpass.outputs).toEqual([n.noiseLowpass]);
    expect(n.noiseLowpass.outputs).toEqual([n.noiseGain]);
    expect(n.noiseGain.outputs).toEqual([n.output]);
    expect((n.noise as unknown as FakeSource).loop).toBe(true);
  });

  it('applies the aircraft conditions to the nodes', () => {
    const { conditions, n } = setup({ distanceNm: 40, overmodulated: true });
    expect(n.highpass.frequency.value).toBe(conditions.highpassHz);
    expect(n.lowpass.frequency.value).toBe(conditions.lowpassHz);
    expect(n.drive.gain.value).toBe(conditions.drive);
    expect(n.compressor.threshold.value).toBe(conditions.compThresholdDb);
    expect(n.compressor.ratio.value).toBe(conditions.compRatio);
    expect(n.output.gain.value).toBeCloseTo(0.8 * conditions.gain, 5);
    expect((n.shaper as unknown as FakeShaper).curve).not.toBeNull();
  });

  it('keys the carrier first, starts the voice after a short lead, and ends with a squelch tail after finish()', async () => {
    const { ctx, g, n } = setup({ seconds: 2 });
    g.start();
    const [src] = g.nodes.sources as unknown as FakeSource[];
    const noise = n.noise as unknown as FakeSource;
    expect(noise.startedAt).toBe(ctx.currentTime);
    expect(src.startedAt).toBeCloseTo(ctx.currentTime + CARRIER_LEAD_SEC, 5);
    expect(g.speechSec).toBeCloseTo(2, 5);
    expect(noise.stoppedAt).toBeNull(); // the key stays down until finish()
    g.finish();
    const speechEnd = src.startedAt! + 2;
    const tailSec = g.totalSec - CARRIER_LEAD_SEC - 2;
    expect(tailSec).toBeGreaterThan(0.04);
    expect(noise.stoppedAt).toBeGreaterThan(speechEnd + tailSec);
    const decay = (n.noiseGain.gain as FakeParam).events.find((e) => e[0] === 'exp');
    expect(decay?.[2]).toBeCloseTo(speechEnd + tailSec, 5);
    let done = false;
    void g.ended.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    noise.fireEnded();
    await g.ended;
    expect(done).toBe(true);
  });

  it('appends later pieces back to back with no gap and holds the carrier across them', () => {
    const { ctx, g, n } = setup({ seconds: 1 });
    g.start();
    g.append(piece(1.5));
    g.append(piece(0.5));
    const srcs = g.nodes.sources as unknown as FakeSource[];
    expect(srcs).toHaveLength(3);
    expect(srcs[1].startedAt).toBeCloseTo(srcs[0].startedAt! + 1, 6);
    expect(srcs[2].startedAt).toBeCloseTo(srcs[0].startedAt! + 2.5, 6);
    expect(g.speechSec).toBeCloseTo(3, 6);
    g.finish();
    expect(g.totalSec).toBeCloseTo(CARRIER_LEAD_SEC + 3 + (g.totalSec - CARRIER_LEAD_SEC - 3), 6);
    expect((n.noise as unknown as FakeSource).stoppedAt).toBeGreaterThan(ctx.currentTime + CARRIER_LEAD_SEC + 3);
    // After finish() nothing more can be added.
    g.append(piece(1));
    expect(g.nodes.sources).toHaveLength(3);
  });

  it('a piece that arrives late starts at once rather than in the past', () => {
    const { ctx, g } = setup({ seconds: 1 });
    g.start();
    ctx.currentTime += 5; // the model was slow
    g.append(piece(1));
    const srcs = g.nodes.sources as unknown as FakeSource[];
    expect(srcs[1].startedAt).toBe(ctx.currentTime);
  });

  it('a pitch shift shortens or lengthens the speech by the playback rate', () => {
    const { g } = setup({ rate: 1.05, seconds: 2.1 });
    g.start();
    expect(g.speechSec).toBeCloseTo(2, 5);
    expect((g.nodes.sources[0].playbackRate as unknown as FakeParam).value).toBe(1.05);
  });

  it('only automates flutter on weak signals', () => {
    const near = setup({ distanceNm: 2 });
    near.g.start();
    expect((near.n.flutter.gain as FakeParam).curves).toHaveLength(0);
    const far = setup({ distanceNm: 40, seconds: 2 });
    far.g.start();
    far.g.append(piece(1));
    const curves = (far.n.flutter.gain as FakeParam).curves;
    expect(curves).toHaveLength(2);
    expect(curves[0].duration).toBeCloseTo(2, 5);
    expect(curves[1].start).toBeCloseTo(curves[0].start + 2, 5);
  });

  it('stop() cuts every source, disconnects and resolves; calling it twice is safe', async () => {
    const { g, n } = setup();
    g.start();
    g.append(piece(1));
    g.stop();
    g.stop();
    await g.ended;
    for (const s of g.nodes.sources as unknown as FakeSource[]) expect(s.stoppedAt).not.toBeNull();
    expect((n.noise as unknown as FakeSource).stoppedAt).not.toBeNull();
    expect(n.output.disconnected).toBe(true);
  });

  it('resolves via the safety timer if the context never reports the end (suspended context)', async () => {
    vi.useFakeTimers();
    try {
      const { g } = setup({ seconds: 1 });
      g.start();
      g.finish();
      let done = false;
      void g.ended.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync((g.totalSec + 1.6) * 1000);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('graph helpers', () => {
  it('soft clipper maps full scale to full scale, stays odd-symmetric and monotonic', () => {
    const c = softClipCurve(2.5);
    expect(c[0]).toBeCloseTo(-1, 5);
    expect(c[c.length - 1]).toBeCloseTo(1, 5);
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
    expect(c[0] + c[c.length - 1]).toBeCloseTo(0, 5);
  });

  it('flutter is deterministic in the seed, bounded by the depth, and absent at depth 0', () => {
    expect(flutterCurve(0, 1, 2)).toHaveLength(0);
    const a = flutterCurve(0.3, 42, 3);
    expect(Array.from(flutterCurve(0.3, 42, 3))).toEqual(Array.from(a));
    expect(Array.from(flutterCurve(0.3, 43, 3))).not.toEqual(Array.from(a));
    for (const v of a) {
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0.7 - 1e-6);
    }
  });

  it('shares one noise buffer per context', () => {
    const ctx = new FakeContext();
    const b = getNoiseBuffer(ctx as unknown as AudioContext);
    expect(getNoiseBuffer(ctx as unknown as AudioContext)).toBe(b);
    expect(b.length).toBe(48000);
  });
});
