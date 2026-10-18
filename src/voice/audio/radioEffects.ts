/**
 * Radio audio effects built from WebAudio only (no audio files).
 *
 * LIMITATION: browser `speechSynthesis` output cannot be routed through
 * WebAudio, so the pilot's voice itself is NOT band-passed when browser TTS is
 * used. Here the radio chain is applied to what we synthesise ourselves: the PTT
 * open/close clicks, the low static bed, and, with the "Local neural" pilot voice
 * engine, the voices themselves: `getInputNode()` is the entry of the shared
 * 300-3000 Hz, lightly distorted, compressed path, and tts/neuralTts.ts plays each
 * transmission into it through its own per-aircraft graph (audio/transmissionGraph.ts).
 */

import { getSharedAudioContext } from './unlock.ts';

export interface RadioEffects {
  isSupported(): boolean;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  /** 0..1 */
  setMasterVolume(volume: number): void;
  playPttOpen(): void;
  playPttClose(): void;
  /** A short two-tone ring for a landline call between positions (WebAudio only, no file). */
  playLandline(): void;
  startStatic(): void;
  stopStatic(): void;
  /** Entry node of the radio chain, for routing cloud TTS through it. Null if WebAudio is unavailable. */
  getInputNode(): AudioNode | null;
  getContext(): AudioContext | null;
  dispose(): void;
}

export interface RadioEffectsOptions {
  enabled?: boolean;
  masterVolume?: number;
  /** Static bed level (linear gain). Kept very low so speech stays clear. */
  staticGain?: number;
  contextFactory?: () => AudioContext | null;
}

/** Default: the page-wide context that `unlockAudio()` resumed on the user's click. */
function defaultFactory(): AudioContext | null {
  return getSharedAudioContext();
}

function distortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
}

export function createRadioEffects(options: RadioEffectsOptions = {}): RadioEffects {
  let enabled = options.enabled ?? true;
  let master = options.masterVolume ?? 0.6;
  const staticLevel = options.staticGain ?? 0.012;
  const factory = options.contextFactory ?? defaultFactory;
  /** The shared context outlives one session: dispose only disconnects from it. */
  const sharedContext = !options.contextFactory;

  let ctx: AudioContext | null = null;
  let chainIn: GainNode | null = null;
  let masterGain: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let staticSource: AudioBufferSourceNode | null = null;
  let staticGainNode: GainNode | null = null;
  let wantStatic = false;
  let failed = false;

  function ensure(): AudioContext | null {
    if (ctx || failed) return ctx;
    try {
      ctx = factory();
    } catch {
      ctx = null;
    }
    if (!ctx) {
      failed = true;
      return null;
    }
    // input -> highpass 300 -> lowpass 3000 -> light waveshaper -> compressor -> master -> out
    chainIn = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3000;
    const shaper = ctx.createWaveShaper();
    shaper.curve = distortionCurve(1.5);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.ratio.value = 6;
    masterGain = ctx.createGain();
    masterGain.gain.value = enabled ? master : 0;
    chainIn.connect(hp);
    hp.connect(lp);
    lp.connect(shaper);
    shaper.connect(comp);
    comp.connect(masterGain);
    masterGain.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  function ready(): AudioContext | null {
    if (!enabled) return null;
    const c = ensure();
    if (c && c.state === 'suspended') void c.resume().catch(() => undefined);
    return c;
  }

  function noiseBurst(c: AudioContext, start: number, duration: number, peak: number) {
    if (!noiseBuffer || !chainIn) return;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer;
    const env = c.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    src.connect(env);
    env.connect(chainIn);
    src.start(start);
    src.stop(start + duration + 0.02);
  }

  function tick(c: AudioContext, start: number, freq: number, duration: number, peak: number) {
    if (!chainIn) return;
    const osc = c.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const env = c.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(env);
    env.connect(chainIn);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function startStaticNow() {
    const c = ready();
    if (!c || !noiseBuffer || !chainIn || staticSource) return;
    staticSource = c.createBufferSource();
    staticSource.buffer = noiseBuffer;
    staticSource.loop = true;
    staticGainNode = c.createGain();
    staticGainNode.gain.value = staticLevel;
    staticSource.connect(staticGainNode);
    staticGainNode.connect(chainIn);
    staticSource.start();
  }
  function stopStaticNow() {
    try {
      staticSource?.stop();
    } catch { /* already stopped */ }
    staticSource?.disconnect();
    staticGainNode?.disconnect();
    staticSource = null;
    staticGainNode = null;
  }

  return {
    isSupported: () => ensure() !== null,
    isEnabled: () => enabled,
    setEnabled(next) {
      enabled = next;
      if (masterGain) masterGain.gain.value = next ? master : 0;
      if (!next) stopStaticNow();
      else if (wantStatic) startStaticNow();
    },
    setMasterVolume(v) {
      master = Math.min(1, Math.max(0, v));
      if (masterGain && enabled) masterGain.gain.value = master;
    },
    playPttOpen() {
      const c = ready();
      if (!c) return;
      const t = c.currentTime;
      tick(c, t, 1400, 0.018, 0.5);
      noiseBurst(c, t + 0.012, 0.045, 0.35);
    },
    playPttClose() {
      const c = ready();
      if (!c) return;
      const t = c.currentTime;
      tick(c, t, 900, 0.014, 0.4);
      noiseBurst(c, t + 0.008, 0.11, 0.45); // squelch tail
    },
    playLandline() {
      const c = ready();
      if (!c || !chainIn) return;
      const t = c.currentTime;
      // two short bursts of a 440 + 480 Hz pair (a telephone ring), softer than the PTT clicks
      for (const start of [0, 0.32]) {
        for (const f of [440, 480]) {
          const osc = c.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = f;
          const env = c.createGain();
          env.gain.setValueAtTime(0, t + start);
          env.gain.linearRampToValueAtTime(0.18, t + start + 0.02);
          env.gain.setValueAtTime(0.18, t + start + 0.2);
          env.gain.linearRampToValueAtTime(0.0001, t + start + 0.24);
          osc.connect(env);
          env.connect(chainIn);
          osc.start(t + start);
          osc.stop(t + start + 0.26);
        }
      }
    },
    startStatic() {
      wantStatic = true;
      startStaticNow();
    },
    stopStatic() {
      wantStatic = false;
      stopStaticNow();
    },
    getInputNode() {
      ensure();
      return chainIn;
    },
    getContext: () => ctx,
    dispose() {
      wantStatic = false;
      stopStaticNow();
      if (sharedContext) {
        try {
          masterGain?.disconnect();
          chainIn?.disconnect();
        } catch { /* already disconnected */ }
      } else {
        void ctx?.close().catch(() => undefined);
      }
      ctx = null;
      chainIn = null;
      masterGain = null;
      failed = true;
    },
  };
}
