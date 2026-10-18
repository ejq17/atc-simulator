// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceController } from './voiceController.ts';
import type { TransmissionMeta } from './voiceController.ts';
import type { SpeechRecognitionProvider } from './stt/types.ts';
import { createTransmissionQueue } from './transmissionQueue.ts';
import { createRadioEffects } from './audio/radioEffects.ts';
import { DEFAULT_VOICE_SETTINGS, sanitizeVoiceSettings } from './settings.ts';

describe('landline channel (voice layer)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the landline key is a second push-to-talk: its transmission carries channel "landline", the radio key "radio"', async () => {
    const fake: SpeechRecognitionProvider = {
      id: 'webspeech', label: 'Fake', isAvailable: async () => true,
      async start(o) { setTimeout(() => o.onFinal('tower ground cross approved', { durationMs: 10 }), 10); },
      async stop() {},
    };
    const got: Array<{ text: string; meta: TransmissionMeta }> = [];
    const c = createVoiceController({
      providers: { webspeech: fake }, ptt: { key: 'Space', mode: 'hold' }, landline: { key: 'KeyL' }, releaseTailMs: 0, onTransmission: (text, meta) => got.push({ text, meta }),
    });
    expect(c.landlinePtt?.getKey()).toBe('KeyL');
    c.landlinePtt!.press();
    await vi.advanceTimersByTimeAsync(20);
    c.landlinePtt!.release();
    await vi.advanceTimersByTimeAsync(3000);
    expect(got).toHaveLength(1);
    expect(got[0].meta.channel).toBe('landline');
    c.ptt!.press();
    await vi.advanceTimersByTimeAsync(20);
    c.ptt!.release();
    await vi.advanceTimersByTimeAsync(3000);
    expect(got.at(-1)!.meta.channel).toBe('radio');
    c.dispose();
  });

  it('a controller without a landline binding has none', () => {
    const c = createVoiceController({ ptt: false, onTransmission: () => undefined });
    expect(c.landlinePtt).toBeNull();
    c.dispose();
  });

  it('the queue rings for a landline item instead of the PTT clicks', async () => {
    const clicks: string[] = [];
    let release = () => undefined as void;
    const q = createTransmissionQueue({
      monitoredFrequencyMhz: 120.3,
      radio: { playPttOpen: () => clicks.push('open'), playPttClose: () => clicks.push('close'), playLandline: () => clicks.push('ring') },
      speaker: { speak: () => new Promise<void>((r) => { release = () => r(); }), cancel: () => undefined },
    });
    q.enqueue({ text: 'Ground, Tower, cross runway one three at alpha', voiceId: 'atc-twr', frequencyMhz: 120.3, channel: 'landline' });
    expect(clicks).toEqual(['ring']);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(clicks).toEqual(['ring']);
    q.enqueue({ text: 'N1, cleared', voiceId: 'v', frequencyMhz: 120.3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(clicks).toEqual(['ring', 'open']);
    q.dispose();
  });

  it('the ring is a safe no-op without WebAudio', () => {
    const fx = createRadioEffects({ contextFactory: () => null });
    expect(() => fx.playLandline()).not.toThrow();
  });

  it('settings: the landline key defaults to L and is validated', () => {
    expect(DEFAULT_VOICE_SETTINGS.landlineKey).toBe('KeyL');
    expect(sanitizeVoiceSettings({ landlineKey: 'F4' }).landlineKey).toBe('F4');
    expect(sanitizeVoiceSettings({ landlineKey: '' }).landlineKey).toBe('KeyL');
    expect(sanitizeVoiceSettings({ landlineKey: 7 }).landlineKey).toBe('KeyL');
  });
});
