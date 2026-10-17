/**
 * Pilot transmission queue: one speaker at a time, only on the monitored
 * frequency, and never over the controller's own transmission.
 *
 * - Controller key down while a pilot is speaking => the pilot is "stepped on":
 *   speech is cancelled and the text is re-queued after `steppedOnDelayMs`.
 * - Controller key down with items waiting => they wait until key-up.
 * - Higher `priority` plays first; equal priority is FIFO.
 */

export interface QueuedTransmission {
  text: string;
  voiceId: string;
  frequencyMhz: number;
  /** Higher = sooner (e.g. emergency 10, normal 0). Default 0. */
  priority?: number;
}

export interface TransmissionSpeaker {
  /** Speak and resolve when finished or cancelled. */
  speak(item: QueuedTransmission): Promise<void>;
  cancel(): void;
}

export type TransmissionEvent =
  | { type: 'start'; item: QueuedTransmission }
  | { type: 'end'; item: QueuedTransmission }
  | { type: 'stepped_on'; item: QueuedTransmission; attempt: number }
  | { type: 'dropped'; item: QueuedTransmission; reason: 'wrong_frequency' | 'too_many_retries' | 'cleared' };

export interface TransmissionQueueOptions {
  speaker: TransmissionSpeaker;
  /** Optional radio clicks around each pilot call. */
  radio?: { playPttOpen(): void; playPttClose(): void };
  onEvent?: (e: TransmissionEvent) => void;
  monitoredFrequencyMhz?: number;
  steppedOnDelayMs?: number;
  /** Quiet gap after a transmission before the next pilot keys up. */
  gapMs?: number;
  /** Pause after the controller unkeys before pilots may talk. */
  resumeDelayMs?: number;
  maxSteppedOnRetries?: number;
  now?: () => number;
}

export interface TransmissionQueue {
  /** Returns false if the frequency is not the monitored one (inaudible, dropped). */
  enqueue(t: QueuedTransmission): boolean;
  setControllerTransmitting(transmitting: boolean): void;
  setMonitoredFrequency(mhz: number): void;
  clear(): void;
  isSpeaking(): boolean;
  pendingCount(): number;
  dispose(): void;
}

interface Entry {
  item: QueuedTransmission;
  seq: number;
  notBefore: number;
  steppedOn: number;
}

const sameFreq = (a: number, b: number) => Math.abs(a - b) < 0.0005;

export function createTransmissionQueue(opts: TransmissionQueueOptions): TransmissionQueue {
  const now = opts.now ?? (() => Date.now());
  const steppedOnDelayMs = opts.steppedOnDelayMs ?? 1500;
  const gapMs = opts.gapMs ?? 300;
  const resumeDelayMs = opts.resumeDelayMs ?? 400;
  const maxRetries = opts.maxSteppedOnRetries ?? 3;

  let monitored = opts.monitoredFrequencyMhz;
  let controllerKeyed = false;
  let queue: Entry[] = [];
  let speaking: Entry | null = null;
  let generation = 0; // invalidates completions of cancelled speech
  let seq = 0;
  let blockedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const emit = (e: TransmissionEvent) => opts.onEvent?.(e);
  const audible = (mhz: number) => monitored === undefined || sameFreq(mhz, monitored);

  function schedule(delayMs: number) {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, Math.max(0, delayMs));
  }

  function pickNext(t: number): Entry | null {
    let best: Entry | null = null;
    for (const e of queue) {
      if (e.notBefore > t) continue;
      if (
        !best ||
        (e.item.priority ?? 0) > (best.item.priority ?? 0) ||
        ((e.item.priority ?? 0) === (best.item.priority ?? 0) && e.seq < best.seq)
      ) {
        best = e;
      }
    }
    return best;
  }

  function pump() {
    if (disposed || speaking || controllerKeyed || queue.length === 0) return;
    const t = now();
    if (t < blockedUntil) {
      schedule(blockedUntil - t);
      return;
    }
    const next = pickNext(t);
    if (!next) {
      const soonest = Math.min(...queue.map((e) => e.notBefore));
      schedule(soonest - t);
      return;
    }
    queue = queue.filter((e) => e !== next);
    speaking = next;
    const myGen = ++generation;
    emit({ type: 'start', item: next.item });
    opts.radio?.playPttOpen();
    opts.speaker
      .speak(next.item)
      .catch(() => undefined)
      .then(() => {
        if (myGen !== generation) return; // stepped on / cleared
        speaking = null;
        opts.radio?.playPttClose();
        emit({ type: 'end', item: next.item });
        blockedUntil = now() + gapMs;
        schedule(gapMs);
      });
  }

  function stepOn() {
    const e = speaking;
    if (!e) return;
    generation++; // ignore the speaker's completion
    speaking = null;
    opts.speaker.cancel();
    e.steppedOn += 1;
    if (e.steppedOn > maxRetries) {
      emit({ type: 'dropped', item: e.item, reason: 'too_many_retries' });
      return;
    }
    e.notBefore = now() + steppedOnDelayMs;
    emit({ type: 'stepped_on', item: e.item, attempt: e.steppedOn });
    queue.push(e);
  }

  return {
    enqueue(item) {
      if (!audible(item.frequencyMhz)) {
        emit({ type: 'dropped', item, reason: 'wrong_frequency' });
        return false;
      }
      queue.push({ item, seq: seq++, notBefore: 0, steppedOn: 0 });
      pump();
      return true;
    },
    setControllerTransmitting(transmitting) {
      if (transmitting === controllerKeyed) return;
      controllerKeyed = transmitting;
      if (transmitting) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        stepOn();
      } else {
        blockedUntil = Math.max(blockedUntil, now() + resumeDelayMs);
        schedule(resumeDelayMs);
      }
    },
    setMonitoredFrequency(mhz) {
      monitored = mhz;
      if (speaking && !audible(speaking.item.frequencyMhz)) {
        generation++;
        const s = speaking;
        speaking = null;
        opts.speaker.cancel();
        emit({ type: 'dropped', item: s.item, reason: 'wrong_frequency' });
      }
      const keep: Entry[] = [];
      for (const e of queue) {
        if (audible(e.item.frequencyMhz)) keep.push(e);
        else emit({ type: 'dropped', item: e.item, reason: 'wrong_frequency' });
      }
      queue = keep;
      pump();
    },
    clear() {
      if (speaking) {
        generation++;
        speaking = null;
        opts.speaker.cancel();
      }
      for (const e of queue) emit({ type: 'dropped', item: e.item, reason: 'cleared' });
      queue = [];
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    isSpeaking: () => speaking !== null,
    pendingCount: () => queue.length,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      queue = [];
      if (speaking) opts.speaker.cancel();
      speaking = null;
    },
  };
}
