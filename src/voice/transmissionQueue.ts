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
  /** Volume multiplier on top of the user's pilot-voice volume (0..1). Used for traffic the controller only monitors. Default 1. */
  volume?: number;
  /** Who is talking, for the UI's "speaking" lamp and the debug log: a pilot callsign or "TWR (AI)". */
  speaker?: string;
  /** Callsign (pilots) or position (controllers) that seeds the voice and radio character. Defaults to `speaker`, then `voiceId`. */
  callsign?: string;
  speakerKind?: 'airline' | 'ga' | 'controller';
  /** Distance of the transmitting aircraft from the airport, nautical miles. Far = weak and scratchy. Omitted = clear. */
  distanceNm?: number;
}

export interface TransmissionSpeaker {
  /**
   * Speak and resolve when finished or cancelled. `keyUp` plays the PTT-open click; call it once, right before the first sound.
   * Only speakers that return true from `keysItself` are expected to call it (the queue otherwise clicks when the call is dequeued).
   */
  speak(item: QueuedTransmission, keyUp?: () => void): Promise<void>;
  /** True when the speaker keys the transmitter itself, e.g. once its first synthesised piece is ready. */
  keysItself?(): boolean;
  cancel(): void;
  /** Optional: called when a call is accepted into the queue, so a slow engine can prepare it before its turn. */
  prepare?(item: QueuedTransmission): void;
}

export type TransmissionEvent =
  | { type: 'start'; item: QueuedTransmission }
  | { type: 'end'; item: QueuedTransmission }
  | { type: 'stepped_on'; item: QueuedTransmission; attempt: number }
  | { type: 'dropped'; item: QueuedTransmission; reason: 'wrong_frequency' | 'too_many_retries' | 'cleared' | 'audio_off' };

export interface TransmissionQueueOptions {
  speaker: TransmissionSpeaker;
  /** Optional radio clicks around each pilot call. */
  radio?: { playPttOpen(): void; playPttClose(): void };
  onEvent?: (e: TransmissionEvent) => void;
  monitoredFrequencyMhz?: number;
  /** Several monitored frequencies at once (a controller working Tower + Ground hears both). Wins over `monitoredFrequencyMhz`. */
  monitoredFrequenciesMhz?: number[];
  /**
   * Safety net: a controller key that is still down this long after it was pressed is treated as released (a lost key-up,
   * a window that lost focus mid-call, a toggle-mode press nobody undid). Without it pilots would stay silent forever.
   */
  maxControllerKeyMs?: number;
  /** Safety net: speech that has neither finished nor failed after this long is abandoned so the queue keeps moving. */
  maxSpeakMs?: number;
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
  isControllerTransmitting(): boolean;
  setMonitoredFrequency(mhz: number): void;
  /** Replace the audible frequency set. `undefined` = everything is audible. Items waiting on a frequency that is no longer audible are dropped. */
  setMonitoredFrequencies(mhz: number[] | undefined): void;
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
  const maxKeyMs = opts.maxControllerKeyMs ?? 30_000;
  const maxSpeakMs = opts.maxSpeakMs ?? 60_000;

  let monitored: number[] | undefined = opts.monitoredFrequenciesMhz ?? (opts.monitoredFrequencyMhz !== undefined ? [opts.monitoredFrequencyMhz] : undefined);
  let controllerKeyed = false;
  let queue: Entry[] = [];
  let speaking: Entry | null = null;
  let generation = 0; // invalidates completions of cancelled speech
  let seq = 0;
  let blockedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let keyTimer: ReturnType<typeof setTimeout> | null = null;
  let speakTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const emit = (e: TransmissionEvent) => opts.onEvent?.(e);
  const audible = (mhz: number) => monitored === undefined || monitored.some((m) => sameFreq(mhz, m));

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
    let keyed = false;
    const keyUp = () => {
      if (keyed || myGen !== generation) return;
      keyed = true;
      opts.radio?.playPttOpen();
    };
    if (!(opts.speaker.keysItself?.() ?? false)) keyUp();
    if (speakTimer) clearTimeout(speakTimer);
    speakTimer = setTimeout(() => {
      speakTimer = null;
      if (myGen !== generation || speaking !== next) return;
      // The speaker never reported back: abandon this call and carry on.
      generation++;
      speaking = null;
      opts.speaker.cancel();
      opts.radio?.playPttClose();
      emit({ type: 'end', item: next.item });
      blockedUntil = now() + gapMs;
      schedule(gapMs);
    }, maxSpeakMs);
    opts.speaker
      .speak(next.item, keyUp)
      .catch(() => undefined)
      .then(() => {
        if (myGen !== generation) return; // stepped on / cleared
        if (speakTimer) clearTimeout(speakTimer);
        speakTimer = null;
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
    if (speakTimer) clearTimeout(speakTimer);
    speakTimer = null;
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

  function setMonitored(list: number[] | undefined) {
    monitored = list ? [...list] : undefined;
    if (speaking && !audible(speaking.item.frequencyMhz)) {
      generation++;
      const s = speaking;
      speaking = null;
      if (speakTimer) clearTimeout(speakTimer);
      speakTimer = null;
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
  }

  return {
    enqueue(item) {
      if (!audible(item.frequencyMhz)) {
        emit({ type: 'dropped', item, reason: 'wrong_frequency' });
        return false;
      }
      queue.push({ item, seq: seq++, notBefore: 0, steppedOn: 0 });
      try {
        opts.speaker.prepare?.(item);
      } catch { /* preparing is an optimisation only */ }
      pump();
      return true;
    },
    setControllerTransmitting(transmitting) {
      if (transmitting === controllerKeyed) return;
      controllerKeyed = transmitting;
      if (keyTimer) clearTimeout(keyTimer);
      keyTimer = null;
      if (transmitting) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        stepOn();
        // Never let a stuck key silence the pilots for good.
        keyTimer = setTimeout(() => {
          keyTimer = null;
          if (controllerKeyed && !disposed) {
            controllerKeyed = false;
            blockedUntil = Math.max(blockedUntil, now() + resumeDelayMs);
            schedule(resumeDelayMs);
          }
        }, maxKeyMs);
      } else {
        blockedUntil = Math.max(blockedUntil, now() + resumeDelayMs);
        schedule(resumeDelayMs);
      }
    },
    isControllerTransmitting: () => controllerKeyed,
    setMonitoredFrequency: (mhz) => setMonitored([mhz]),
    setMonitoredFrequencies: (list) => setMonitored(list),
    clear() {
      if (speaking) {
        generation++;
        speaking = null;
        if (speakTimer) clearTimeout(speakTimer);
        speakTimer = null;
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
      if (keyTimer) clearTimeout(keyTimer);
      if (speakTimer) clearTimeout(speakTimer);
      timer = null;
      keyTimer = null;
      speakTimer = null;
      queue = [];
      if (speaking) opts.speaker.cancel();
      speaking = null;
    },
  };
}
