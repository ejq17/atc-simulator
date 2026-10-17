/** Pilot audibility: everything that decides whether a pilot is heard, short of a person listening (that is e2e/pilot-tts.spec.ts). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransmissionQueue } from './transmissionQueue.ts';
import type { QueuedTransmission } from './transmissionQueue.ts';
import { createPilotVoice } from './pilotVoice.ts';
import { createVoiceSettingsStore, DEFAULT_VOICE_SETTINGS, sanitizeVoiceSettings } from './settings.ts';
import { createBrowserTts } from './tts/browserTts.ts';
import { unlockAudio } from './audio/unlock.ts';
import type { SpeakRequest, SpeechSynthesisProvider } from './tts/types.ts';

const call = (text: string, mhz: number, extra: Partial<QueuedTransmission> = {}): QueuedTransmission => ({ text, voiceId: 'v1', frequencyMhz: mhz, ...extra });

function queueWith(opts: Partial<Parameters<typeof createTransmissionQueue>[0]> = {}) {
  const spoken: string[] = [];
  const resolvers: Array<() => void> = [];
  const queue = createTransmissionQueue({
    monitoredFrequenciesMhz: [120.3, 121.9],
    speaker: { speak: (i) => { spoken.push(i.text); return new Promise<void>((r) => resolvers.push(r)); }, cancel: () => resolvers.splice(0).forEach((r) => r()) },
    ...opts,
  });
  return { queue, spoken, finish: () => resolvers.splice(0).forEach((r) => r()) };
}

describe('several monitored frequencies', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a player working Tower + Ground hears both frequencies; others stay inaudible', async () => {
    const { queue, spoken, finish } = queueWith();
    expect(queue.enqueue(call('tower pilot', 120.3))).toBe(true);
    expect(queue.enqueue(call('ground pilot', 121.9))).toBe(true);
    expect(queue.enqueue(call('approach pilot', 124.6))).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(300);
    expect(spoken).toEqual(['tower pilot', 'ground pilot']);
  });

  it('a call queued on one frequency survives a call arriving on the other (no retargeting)', async () => {
    const { queue, spoken, finish } = queueWith();
    queue.enqueue(call('first', 120.3));
    queue.enqueue(call('second', 121.9));
    queue.enqueue(call('third', 120.3));
    for (let i = 0; i < 3; i++) { finish(); await vi.advanceTimersByTimeAsync(300); }
    expect(spoken).toEqual(['first', 'second', 'third']);
  });

  it('setMonitoredFrequencies replaces the set, dropping only the calls that became inaudible', () => {
    const { queue, spoken } = queueWith();
    queue.enqueue(call('a', 120.3));
    queue.enqueue(call('b', 121.9));
    queue.setMonitoredFrequencies([121.9]);
    // The call speaking on 120.3 is cut; the one waiting on 121.9 is still audible and goes next.
    expect(spoken).toEqual(['a', 'b']);
    expect(queue.pendingCount()).toBe(0);
    queue.setMonitoredFrequencies(undefined);
    expect(queue.enqueue(call('anything', 99.9))).toBe(true);
  });

  it('passes the volume multiplier and speaker name through to the speaker', () => {
    const seen: QueuedTransmission[] = [];
    const queue = createTransmissionQueue({ monitoredFrequenciesMhz: [120.3], speaker: { speak: (i) => { seen.push(i); return Promise.resolve(); }, cancel: () => undefined } });
    queue.enqueue(call('monitored AI', 120.3, { volume: 0.45, speaker: 'TWR (AI)' }));
    expect(seen[0]).toMatchObject({ volume: 0.45, speaker: 'TWR (AI)' });
  });
});

describe('a stuck push-to-talk must not silence the pilots for good', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('releases a controller key that stays down past the watchdog', async () => {
    const { queue, spoken } = queueWith({ maxControllerKeyMs: 5000 });
    queue.setControllerTransmitting(true);
    queue.enqueue(call('waiting', 120.3));
    await vi.advanceTimersByTimeAsync(4900);
    expect(spoken).toEqual([]);
    expect(queue.isControllerTransmitting()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); // watchdog + resume delay
    expect(queue.isControllerTransmitting()).toBe(false);
    expect(spoken).toEqual(['waiting']);
  });

  it('a normal release cancels the watchdog', async () => {
    const { queue } = queueWith({ maxControllerKeyMs: 5000 });
    queue.setControllerTransmitting(true);
    queue.setControllerTransmitting(false);
    queue.setControllerTransmitting(true); // a fresh press gets a fresh timer
    await vi.advanceTimersByTimeAsync(4000);
    expect(queue.isControllerTransmitting()).toBe(true);
  });

  it('abandons speech that never reports back so the next call still plays', async () => {
    const spoken: string[] = [];
    const queue = createTransmissionQueue({ monitoredFrequenciesMhz: [120.3], maxSpeakMs: 3000, speaker: { speak: (i) => { spoken.push(i.text); return new Promise<void>(() => undefined); }, cancel: () => undefined } });
    queue.enqueue(call('hangs', 120.3));
    queue.enqueue(call('next', 120.3));
    await vi.advanceTimersByTimeAsync(2900);
    expect(spoken).toEqual(['hangs']);
    await vi.advanceTimersByTimeAsync(600);
    expect(spoken).toEqual(['hangs', 'next']);
  });
});

describe('pilot audio switch', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 } as unknown as Storage;
  };

  it('speaks by default and honours the volume multiplier', async () => {
    const settings = createVoiceSettingsStore(memory());
    expect(settings.get().ttsEnabled).toBe(true);
    expect(DEFAULT_VOICE_SETTINGS.monitorAll).toBe(false);
    const reqs: SpeakRequest[] = [];
    const tts: SpeechSynthesisProvider = { speak: (r) => { reqs.push(r); r.onStart?.(); r.onEnd?.(); return Promise.resolve(); }, cancel: () => undefined, listVoices: () => [] };
    const speaking: boolean[] = [];
    const pilots = createPilotVoice({ tts, settings, monitoredFrequenciesMhz: [120.3], onSpeaking: (on) => speaking.push(on) });
    settings.update({ ttsVolume: 0.8 });
    expect(pilots.enqueue(call('hello', 120.3, { volume: 0.5 }))).toBe(true);
    expect(reqs[0].text).toBe('hello');
    expect(reqs[0].volume).toBeCloseTo(0.4);
    expect(speaking).toEqual([true, false]);
    pilots.dispose();
  });

  it('with Pilot audio off nothing is queued or spoken, and speech in progress is cut', () => {
    const settings = createVoiceSettingsStore(memory());
    const cancelled: string[] = [];
    const reqs: SpeakRequest[] = [];
    const events: string[] = [];
    const tts: SpeechSynthesisProvider = { speak: (r) => { reqs.push(r); return new Promise<void>(() => undefined); }, cancel: () => void cancelled.push('cancel'), listVoices: () => [] };
    const pilots = createPilotVoice({ tts, settings, monitoredFrequenciesMhz: [120.3], onEvent: (e) => events.push(e.type === 'dropped' ? e.reason : e.type) });
    pilots.enqueue(call('talking', 120.3));
    expect(pilots.isSpeaking()).toBe(true);
    settings.update({ ttsEnabled: false });
    expect(cancelled).toEqual(['cancel']);
    expect(pilots.isSpeaking()).toBe(false);
    expect(pilots.enqueue(call('muted', 120.3))).toBe(false);
    expect(reqs.map((r) => r.text)).toEqual(['talking']);
    expect(events).toContain('audio_off');
    settings.update({ ttsEnabled: true });
    pilots.dispose();
  });

  it('monitorAll is a persisted boolean that defaults to off', () => {
    expect(sanitizeVoiceSettings(undefined).monitorAll).toBe(false);
    expect(sanitizeVoiceSettings({ monitorAll: true }).monitorAll).toBe(true);
    expect(sanitizeVoiceSettings({ monitorAll: 'yes' }).monitorAll).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Browser TTS against a fake speechSynthesis
// ------------------------------------------------------------------------------------------------------------------

class FakeUtterance {
  voice: unknown = null; lang = ''; rate = 1; pitch = 1; volume = 1;
  onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: ((e: { error: string }) => void) | null = null;
  text: string;
  constructor(text: string) { this.text = text; }
}

function fakeSynth(initialVoices: { name: string; voiceURI: string; lang: string; localService: boolean; default: boolean }[] = []) {
  const listeners = new Map<string, Array<() => void>>();
  let voices = initialVoices;
  const spoken: FakeUtterance[] = [];
  const synth = {
    paused: false,
    speaking: false,
    getVoices: () => voices,
    addEventListener: (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    speak: (u: FakeUtterance) => { spoken.push(u); queueMicrotask(() => u.onstart?.()); },
    cancel: () => undefined,
    resume() { this.paused = false; },
  };
  return { synth: synth as unknown as SpeechSynthesis, spoken, setVoices(v: typeof voices) { voices = v; listeners.get('voiceschanged')?.forEach((f) => f()); }, raw: synth };
}

const VOICE = (n: string) => ({ name: n, voiceURI: `uri:${n}`, lang: 'en-US', localService: true, default: false });

describe('browser TTS', () => {
  beforeEach(() => { vi.stubGlobal('window', { localStorage: { getItem: () => null } }); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('waits for Chrome\'s asynchronous voice list before the first utterance, so the pilot gets its own voice', async () => {
    const f = fakeSynth([]);
    const tts = createBrowserTts({ synth: f.synth, UtteranceCtor: FakeUtterance as unknown as typeof SpeechSynthesisUtterance });
    const done = tts.speak({ text: 'Runway one three, cleared for takeoff', voiceId: 'v3' });
    await Promise.resolve();
    expect(f.spoken).toHaveLength(0); // still waiting for voices
    f.setVoices([VOICE('Samantha'), VOICE('Alex'), VOICE('Daniel')]);
    await vi.waitFor(() => expect(f.spoken).toHaveLength(1));
    expect((f.spoken[0].voice as { name: string }).name).toMatch(/Samantha|Alex|Daniel/);
    f.spoken[0].onend?.();
    await done;
  });

  it('does not wait forever when the browser has no voices at all', async () => {
    vi.useFakeTimers();
    const f = fakeSynth([]);
    const tts = createBrowserTts({ synth: f.synth, UtteranceCtor: FakeUtterance as unknown as typeof SpeechSynthesisUtterance, voicesTimeoutMs: 500 });
    void tts.speak({ text: 'hello', voiceId: 'v1' });
    await vi.advanceTimersByTimeAsync(600);
    expect(f.spoken).toHaveLength(1);
    expect(f.spoken[0].voice).toBeNull(); // default voice
  });

  it('records what it asked the browser to say and what the browser did (window.__kacyTts)', async () => {
    const f = fakeSynth([VOICE('Samantha'), VOICE('Alex')]);
    const tts = createBrowserTts({ synth: f.synth, UtteranceCtor: FakeUtterance as unknown as typeof SpeechSynthesisUtterance });
    const p = tts.speak({ text: 'Cleared ILS runway 13 approach, Spirit four fifty one', voiceId: 'v7', volume: 0.5 });
    const dbg = (globalThis as unknown as { window: { __kacyTts: import('./tts/ttsDebug.ts').KacyTtsDebug } }).window.__kacyTts;
    expect(dbg.voices).toBe(2);
    expect(dbg.spoken[0]).toMatchObject({ text: 'Cleared ILS runway 13 approach, Spirit four fifty one', utterance: 'Cleared I L S runway one three approach, Spirit four fifty one', volume: 0.5 });
    await Promise.resolve();
    expect(dbg.started).toEqual(['Cleared ILS runway 13 approach, Spirit four fifty one']);
    f.spoken[0].onend?.();
    await p;
    expect(dbg.ended).toHaveLength(1);
    expect(dbg.spoken[0].outcome).toBe('end');
    // A browser error (interrupted, not-allowed...) is recorded, not swallowed silently.
    const p2 = tts.speak({ text: 'second', voiceId: 'v8' });
    f.spoken[1].onerror?.({ error: 'not-allowed' });
    await p2;
    expect(dbg.errors).toEqual([{ text: 'second', error: 'error:not-allowed' }]);
  });

  it('resumes a paused speech queue before speaking', async () => {
    const f = fakeSynth([VOICE('Samantha')]);
    f.raw.paused = true;
    const tts = createBrowserTts({ synth: f.synth, UtteranceCtor: FakeUtterance as unknown as typeof SpeechSynthesisUtterance });
    void tts.speak({ text: 'hi', voiceId: 'v1' });
    expect(f.raw.paused).toBe(false);
  });
});

describe('unlockAudio', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is harmless where there is no audio at all', () => {
    expect(unlockAudio()).toEqual({ audioContext: 'unsupported', ttsPrimed: false, voices: 0 });
  });

  it('resumes the AudioContext and primes speech with a silent utterance on the user gesture', () => {
    const resumed: string[] = [];
    class Ctx {
      state: AudioContextState = 'suspended';
      sampleRate = 48000;
      destination = {};
      resume() { resumed.push('resume'); this.state = 'running'; return Promise.resolve(); }
      createBuffer() { return {}; }
      createBufferSource() { return { connect() {}, start() {}, buffer: null }; }
    }
    const spoken: FakeUtterance[] = [];
    vi.stubGlobal('window', { localStorage: { getItem: () => '1' } });
    vi.stubGlobal('AudioContext', Ctx);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('speechSynthesis', { paused: false, getVoices: () => [VOICE('Alex')], speak: (u: FakeUtterance) => spoken.push(u), resume() {} });
    const r = unlockAudio();
    expect(resumed).toEqual(['resume']);
    expect(r).toMatchObject({ ttsPrimed: true, voices: 1 });
    expect(spoken).toHaveLength(1);
    expect(spoken[0].volume).toBe(0); // silent
  });
});
