// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceController } from './voiceController.ts';
import type { TransmissionMeta, VoiceStatusEvent } from './voiceController.ts';
import { SttError } from './stt/types.ts';
import type { SpeechRecognitionProvider, SttStartOptions } from './stt/types.ts';

interface Fake extends SpeechRecognitionProvider {
  opts: SttStartOptions | null;
  startCalls: number;
  stopCalls: number;
  /** What stop() does; default resolves and emits nothing. */
  onStop: () => void | Promise<void>;
  startError: Error | null;
}

function makeFake(available = true): Fake {
  const f: Fake = {
    id: 'webspeech',
    label: 'Fake',
    opts: null,
    startCalls: 0,
    stopCalls: 0,
    startError: null,
    onStop: () => undefined,
    isAvailable: async () => available,
    async start(opts) {
      f.startCalls++;
      f.opts = opts;
      if (f.startError) throw f.startError;
    },
    async stop() {
      f.stopCalls++;
      await f.onStop();
    },
  };
  return f;
}

function setup(fake: Fake, extra: Partial<Parameters<typeof createVoiceController>[0]> = {}) {
  const transmissions: Array<{ text: string; meta: TransmissionMeta }> = [];
  const events: VoiceStatusEvent[] = [];
  const controller = createVoiceController({
    providers: { webspeech: fake },
    ptt: false,
    releaseTailMs: 0,
    onTransmission: (text, meta) => transmissions.push({ text, meta }),
    ...extra,
  });
  controller.onStatusChange((e) => events.push(e));
  return { controller, transmissions, events, statuses: () => events.map((e) => e.status) };
}

describe('voiceController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('partial -> final flow delivers one transmission', async () => {
    const fake = makeFake();
    const { controller, transmissions, statuses } = setup(fake);
    const partials: string[] = [];
    controller.onPartial((t) => partials.push(t));
    const tx: boolean[] = [];
    controller.onTransmittingChange((t) => tx.push(t));

    controller.beginTransmission();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status).toBe('listening');
    expect(controller.isTransmitting()).toBe(true);

    fake.opts!.onPartial('spirit one two');
    fake.opts!.onPartial('spirit one two three taxi');
    expect(partials).toEqual(['spirit one two', 'spirit one two three taxi']);

    fake.onStop = () => {
      setTimeout(() => fake.opts!.onFinal('Spirit 123 taxi to runway 13', { confidence: 0.9, durationMs: 1200 }), 100);
    };
    controller.endTransmission();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status).toBe('processing');
    expect(transmissions).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(150);
    expect(transmissions).toHaveLength(1);
    expect(transmissions[0].text).toBe('Spirit 123 taxi to runway 13');
    expect(transmissions[0].meta).toMatchObject({ confidence: 0.9, source: 'speech', usedPartial: false });
    expect(controller.getLastTranscript()).toBe('Spirit 123 taxi to runway 13');
    expect(controller.status).toBe('idle');
    expect(statuses()).toEqual(['listening', 'processing', 'idle']);
    expect(tx).toEqual([true, false]);
  });

  it('falls back to the last partial after the 2.5 s timeout', async () => {
    const fake = makeFake();
    const { controller, transmissions } = setup(fake);
    controller.beginTransmission();
    await vi.advanceTimersByTimeAsync(0);
    fake.opts!.onPartial('delta four five six hold short');
    controller.endTransmission();
    await vi.advanceTimersByTimeAsync(2400);
    expect(transmissions).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(transmissions).toHaveLength(1);
    expect(transmissions[0].text).toBe('delta four five six hold short');
    expect(transmissions[0].meta.usedPartial).toBe(true);
    expect(controller.status).toBe('idle');
  });

  it('a late final after the timeout is ignored (no double delivery)', async () => {
    const fake = makeFake();
    const { controller, transmissions } = setup(fake);
    controller.beginTransmission();
    await vi.advanceTimersByTimeAsync(0);
    fake.opts!.onPartial('hold position');
    controller.endTransmission();
    await vi.advanceTimersByTimeAsync(2600);
    fake.opts!.onFinal('hold position', { durationMs: 1 });
    expect(transmissions).toHaveLength(1);
  });

  it('finishes immediately with nothing when no speech was heard', async () => {
    const fake = makeFake();
    const { controller, transmissions, events } = setup(fake);
    controller.beginTransmission();
    await vi.advanceTimersByTimeAsync(0);
    controller.endTransmission();
    await vi.advanceTimersByTimeAsync(0);
    expect(transmissions).toHaveLength(0);
    expect(controller.status).toBe('idle');
    expect(events.at(-1)?.message).toMatch(/no speech/i);
  });

  it('surfaces provider errors as status events', async () => {
    const fake = makeFake();
    const { controller, events } = setup(fake);
    controller.beginTransmission();
    await vi.advanceTimersByTimeAsync(0);
    fake.opts!.onError(new SttError('network', 'Speech service unreachable'));
    expect(controller.status).toBe('error');
    expect(events.at(-1)).toMatchObject({ status: 'error', message: 'Speech service unreachable' });
  });

  it('maps permission and unsupported failures at start()', async () => {
    const denied = makeFake();
    denied.startError = new SttError('not_allowed', 'Mic blocked');
    const a = setup(denied);
    a.controller.beginTransmission();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.controller.status).toBe('permission_denied');
    expect(a.controller.isTransmitting()).toBe(false);

    const unsupported = makeFake();
    unsupported.startError = new SttError('unsupported', 'No API');
    const b = setup(unsupported);
    b.controller.beginTransmission();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.controller.status).toBe('unsupported');
  });

  it('treats no_speech as a soft idle notice', async () => {
    const fake = makeFake();
    const { controller, events } = setup(fake);
    controller.beginTransmission();
    await vi.advanceTimersByTimeAsync(0);
    fake.opts!.onError(new SttError('no_speech', 'No speech detected.'));
    expect(controller.status).toBe('idle');
    expect(events.at(-1)?.message).toBe('No speech detected.');
  });

  it('release before the provider is ready still stops cleanly', async () => {
    const fake = makeFake();
    let resolveStart!: () => void;
    fake.start = async (opts) => {
      fake.startCalls++;
      fake.opts = opts;
      await new Promise<void>((r) => (resolveStart = r));
    };
    const { controller, transmissions } = setup(fake);
    controller.beginTransmission();
    controller.endTransmission();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.stopCalls).toBe(0);
    resolveStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.stopCalls).toBe(1);
    expect(transmissions).toHaveLength(0);
  });

  it('simulateTransmission uses the same output path', () => {
    const fake = makeFake();
    const { controller, transmissions, statuses } = setup(fake);
    controller.simulateTransmission('  Tower, Spirit 123 ready  ');
    expect(transmissions[0].text).toBe('Tower, Spirit 123 ready');
    expect(transmissions[0].meta).toMatchObject({ source: 'typed', providerId: 'typed' });
    expect(controller.getLastTranscript()).toBe('Tower, Spirit 123 ready');
    expect(statuses()).toEqual(['processing', 'idle']);
  });

  it('setProvider reports unavailable providers as unsupported', async () => {
    const dg = { ...makeFake(false), id: 'deepgram' as const };
    const { controller } = setup(makeFake(), { providers: { webspeech: makeFake(), deepgram: dg } });
    expect(await controller.setProvider('deepgram')).toBe(false);
    expect(controller.status).toBe('unsupported');
    expect(controller.getProviderId()).toBe('deepgram');
    expect(await controller.setProvider('webspeech')).toBe(true);
    expect(controller.status).toBe('idle');
  });

  it('drives from real key events when a ptt binding is configured', async () => {
    const fake = makeFake();
    const { controller } = setup(fake, { ptt: { key: 'Space', mode: 'hold', debounceMs: 0 } });
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.startCalls).toBe(1);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.stopCalls).toBe(1);
    controller.dispose();
  });
});
