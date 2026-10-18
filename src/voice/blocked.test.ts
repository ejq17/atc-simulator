/** Blocked transmissions (two pilots keyed up together, decided by the engine): rendered as a squeal, never as speech. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPilotVoice } from './pilotVoice.ts';
import { createTransmissionQueue } from './transmissionQueue.ts';
import type { QueuedTransmission, TransmissionEvent } from './transmissionQueue.ts';
import { createVoiceSettingsStore } from './settings.ts';
import { createRadioEffects } from './audio/radioEffects.ts';
import type { RadioEffects } from './audio/radioEffects.ts';
import { BLOCKED_SQUEAL_SEC } from '../sim/radioDiscipline.ts';
import type { SpeakRequest, SpeechSynthesisProvider } from './tts/types.ts';

const blocked = (extra: Partial<QueuedTransmission> = {}): QueuedTransmission => ({ text: '[blocked]', voiceId: 'v1', frequencyMhz: 120.3, kind: 'blocked', ...extra });
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 } as unknown as Storage;
};

describe('blocked transmission through the pilot voice', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make() {
    const reqs: SpeakRequest[] = [];
    const tts: SpeechSynthesisProvider = { speak: (r) => { reqs.push(r); return Promise.resolve(); }, cancel: () => undefined, listVoices: () => [] };
    let squeals = 0;
    const radio = {
      playPttOpen: () => undefined, playPttClose: () => undefined, setEnabled: () => undefined,
      playBlocked: () => { squeals++; return 1.4; },
    } as unknown as RadioEffects;
    const events: TransmissionEvent[] = [];
    const pilots = createPilotVoice({ tts, settings: createVoiceSettingsStore(memory()), radio, monitoredFrequenciesMhz: [120.3], onEvent: (e) => events.push(e) });
    return { pilots, reqs, events, squeals: () => squeals };
  }

  it('plays the squeal and speaks nothing', async () => {
    const { pilots, reqs, squeals } = make();
    expect(pilots.enqueue(blocked())).toBe(true);
    expect(squeals()).toBe(1);
    expect(reqs).toHaveLength(0);
    expect(pilots.isSpeaking()).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(pilots.isSpeaking()).toBe(false);
    pilots.dispose();
  });

  it('keeps the order: a call after the squeal waits for it', async () => {
    const { pilots, reqs } = make();
    pilots.enqueue(blocked());
    pilots.enqueue({ text: 'retry', voiceId: 'v1', frequencyMhz: 120.3 });
    expect(reqs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1500 + 300);
    expect(reqs.map((r) => r.text)).toEqual(['retry']);
    pilots.dispose();
  });

  it('a controller who keys up over the squeal cuts it, and it is not replayed', async () => {
    const { pilots, events } = make();
    pilots.enqueue(blocked());
    pilots.setControllerTransmitting(true);
    expect(pilots.isSpeaking()).toBe(false);
    expect(events.some((e) => e.type === 'dropped' && e.reason === 'blocked_stepped_on')).toBe(true);
    pilots.setControllerTransmitting(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(pilots.pendingCount()).toBe(0);
    pilots.dispose();
  });

  it('is silent with Pilot audio off', () => {
    const settings = createVoiceSettingsStore(memory());
    settings.update({ ttsEnabled: false });
    const { pilots } = make();
    const p2 = createPilotVoice({ tts: { speak: () => Promise.resolve(), cancel: () => undefined, listVoices: () => [] }, settings, monitoredFrequenciesMhz: [120.3] });
    expect(p2.enqueue(blocked())).toBe(false);
    pilots.dispose();
    p2.dispose();
  });

  it('the queue itself treats a blocked item like any other for frequency filtering', () => {
    const q = createTransmissionQueue({ monitoredFrequencyMhz: 121.9, speaker: { speak: () => Promise.resolve(), cancel: () => undefined } });
    expect(q.enqueue(blocked())).toBe(false);
    q.dispose();
  });
});

describe('squeal in the radio effects (WebAudio only)', () => {
  it('is a no-op returning 0 without WebAudio', () => {
    const fx = createRadioEffects({ contextFactory: () => null });
    expect(fx.playBlocked()).toBe(0);
  });

  it('builds two detuned oscillators and a noise burst through the radio chain, and returns its length', () => {
    const made = { osc: 0, src: 0, gains: 0 };
    const node = () => ({ connect: () => undefined, disconnect: () => undefined, gain: { value: 0, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, frequency: { value: 0, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined }, type: '', curve: null, threshold: { value: 0 }, ratio: { value: 0 }, start: () => undefined, stop: () => undefined, buffer: null, loop: false });
    const ctx = {
      currentTime: 0, sampleRate: 8000, state: 'running', destination: {},
      createGain: () => (made.gains++, node()),
      createBiquadFilter: () => node(), createWaveShaper: () => node(), createDynamicsCompressor: () => node(),
      createOscillator: () => (made.osc++, node()),
      createBufferSource: () => (made.src++, node()),
      createBuffer: () => ({ getChannelData: () => new Float32Array(16000) }),
      resume: () => Promise.resolve(), close: () => Promise.resolve(),
    } as unknown as AudioContext;
    const fx = createRadioEffects({ contextFactory: () => ctx });
    const sec = fx.playBlocked();
    expect(sec).toBe(BLOCKED_SQUEAL_SEC); // the engine's constant (src/sim/radioDiscipline.ts) and the squeal agree
    expect(made.osc).toBe(2);
    expect(made.src).toBe(1);
    fx.dispose();
  });
});
