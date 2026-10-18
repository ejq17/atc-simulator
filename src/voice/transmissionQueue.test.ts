import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransmissionQueue } from './transmissionQueue.ts';
import type { QueuedTransmission, TransmissionEvent } from './transmissionQueue.ts';

function setup(opts: { freq?: number } = {}) {
  const spoken: string[] = [];
  const cancelled: string[] = [];
  const resolvers: Array<() => void> = [];
  let current: string | null = null;
  const events: TransmissionEvent[] = [];
  const clicks: string[] = [];
  const queue = createTransmissionQueue({
    monitoredFrequencyMhz: opts.freq ?? 119.4,
    onEvent: (e) => events.push(e),
    radio: { playPttOpen: () => clicks.push('open'), playPttClose: () => clicks.push('close') },
    speaker: {
      speak(item) {
        spoken.push(item.text);
        current = item.text;
        return new Promise<void>((resolve) => resolvers.push(resolve));
      },
      cancel() {
        if (current) cancelled.push(current);
        resolvers.splice(0).forEach((r) => r());
      },
    },
  });
  const finishSpeech = () => {
    current = null;
    resolvers.splice(0).forEach((r) => r());
  };
  return { queue, spoken, cancelled, events, clicks, finishSpeech };
}
const t = (text: string, extra: Partial<QueuedTransmission> = {}): QueuedTransmission => ({
  text,
  voiceId: 'v1',
  frequencyMhz: 119.4,
  ...extra,
});

describe('transmissionQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('speaks one at a time in FIFO order', async () => {
    const { queue, spoken, finishSpeech, clicks } = setup();
    queue.enqueue(t('first'));
    queue.enqueue(t('second'));
    expect(spoken).toEqual(['first']);
    expect(queue.isSpeaking()).toBe(true);
    finishSpeech();
    await vi.advanceTimersByTimeAsync(0);
    expect(spoken).toEqual(['first']); // inter-transmission gap
    await vi.advanceTimersByTimeAsync(300);
    expect(spoken).toEqual(['first', 'second']);
    expect(clicks).toEqual(['open', 'close', 'open']);
  });

  it('plays higher priority first', async () => {
    const { queue, spoken, finishSpeech } = setup();
    queue.enqueue(t('busy'));
    queue.enqueue(t('routine'));
    queue.enqueue(t('emergency', { priority: 10 }));
    finishSpeech();
    await vi.advanceTimersByTimeAsync(300);
    expect(spoken).toEqual(['busy', 'emergency']);
    finishSpeech();
    await vi.advanceTimersByTimeAsync(300);
    expect(spoken).toEqual(['busy', 'emergency', 'routine']);
  });

  it('only the monitored frequency is audible', async () => {
    const { queue, spoken, events } = setup();
    expect(queue.enqueue(t('ground call', { frequencyMhz: 121.9 }))).toBe(false);
    expect(spoken).toEqual([]);
    expect(events[0]).toMatchObject({ type: 'dropped', reason: 'wrong_frequency' });
    queue.setMonitoredFrequency(121.9);
    expect(queue.enqueue(t('ground call', { frequencyMhz: 121.9 }))).toBe(true);
    expect(spoken).toEqual(['ground call']);
  });

  it('retuning drops queued calls on the old frequency and cuts off the speaker', () => {
    const { queue, spoken, cancelled } = setup();
    queue.enqueue(t('a'));
    queue.enqueue(t('b'));
    queue.setMonitoredFrequency(121.9);
    expect(cancelled).toEqual(['a']);
    expect(queue.pendingCount()).toBe(0);
    expect(spoken).toEqual(['a']);
  });

  it('controller keying blocks waiting pilots until release + resume delay', async () => {
    const { queue, spoken } = setup();
    queue.setControllerTransmitting(true);
    queue.enqueue(t('waiting'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(spoken).toEqual([]);
    queue.setControllerTransmitting(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(spoken).toEqual([]);
    await vi.advanceTimersByTimeAsync(150);
    expect(spoken).toEqual(['waiting']);
  });

  it('steps on a speaking pilot and re-queues the text after 1.5 s', async () => {
    const { queue, spoken, cancelled, events, finishSpeech } = setup();
    queue.enqueue(t('cleared for takeoff readback'));
    expect(spoken).toHaveLength(1);
    queue.setControllerTransmitting(true);
    expect(cancelled).toEqual(['cleared for takeoff readback']);
    expect(queue.isSpeaking()).toBe(false);
    expect(events.some((e) => e.type === 'stepped_on')).toBe(true);
    // Controller releases quickly; pilot must still wait the full 1.5 s.
    await vi.advanceTimersByTimeAsync(200);
    queue.setControllerTransmitting(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spoken).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400); // t = 1.6 s after being stepped on
    expect(spoken).toEqual(['cleared for takeoff readback', 'cleared for takeoff readback']);
    finishSpeech();
  });

  it('does not treat a stepped-on completion as finished and gives up after max retries', async () => {
    const { queue, spoken, events } = setup();
    queue.enqueue(t('doomed'));
    for (let i = 0; i < 4; i++) {
      queue.setControllerTransmitting(true);
      queue.setControllerTransmitting(false);
      await vi.advanceTimersByTimeAsync(2500);
    }
    expect(events.some((e) => e.type === 'dropped' && e.reason === 'too_many_retries')).toBe(true);
    expect(spoken.length).toBe(4);
    expect(queue.pendingCount()).toBe(0);
  });

  it('clear() cancels speech and empties the queue', async () => {
    const { queue, spoken, cancelled } = setup();
    queue.enqueue(t('a'));
    queue.enqueue(t('b'));
    queue.clear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(cancelled).toEqual(['a']);
    expect(spoken).toEqual(['a']);
    expect(queue.pendingCount()).toBe(0);
  });
});

describe('deferred keying (speaker that keys itself)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not click at dequeue time; the click happens when the speaker calls keyUp, once', async () => {
    const clicks: string[] = [];
    let keyUp: (() => void) | undefined;
    let done: () => void = () => undefined;
    const queue = createTransmissionQueue({
      monitoredFrequencyMhz: 119.4,
      radio: { playPttOpen: () => clicks.push('open'), playPttClose: () => clicks.push('close') },
      speaker: {
        keysItself: () => true,
        speak(_item, k) { keyUp = k; return new Promise<void>((r) => { done = r; }); },
        cancel() { /* nothing */ },
      },
    });
    queue.enqueue(t('hello'));
    await vi.advanceTimersByTimeAsync(0);
    expect(clicks).toEqual([]); // dequeued, model still working
    keyUp?.();
    keyUp?.();
    expect(clicks).toEqual(['open']);
    done();
    await vi.advanceTimersByTimeAsync(0);
    expect(clicks).toEqual(['open', 'close']);
  });

  it('a stepped-on call whose keyUp arrives late makes no click', async () => {
    const clicks: string[] = [];
    let keyUp: (() => void) | undefined;
    const queue = createTransmissionQueue({
      monitoredFrequencyMhz: 119.4,
      radio: { playPttOpen: () => clicks.push('open'), playPttClose: () => clicks.push('close') },
      speaker: { keysItself: () => true, speak(_i, k) { keyUp = k; return new Promise<void>(() => undefined); }, cancel() { /* nothing */ } },
    });
    queue.enqueue(t('hello'));
    await vi.advanceTimersByTimeAsync(0);
    queue.setControllerTransmitting(true);
    keyUp?.();
    expect(clicks).toEqual([]);
  });
});
