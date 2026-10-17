/**
 * Orchestrates push-to-talk + a speech recognition provider.
 *
 *   PTT down -> provider.start -> partials -> PTT up -> provider.stop
 *            -> wait for final (timeout, then last partial) -> onTransmission(text, meta)
 */
import { createPushToTalk } from './ptt.ts';
import type { PttMode, PushToTalk } from './ptt.ts';
import { createDeepgramProvider } from './stt/deepgramProvider.ts';
import { createNoneProvider } from './stt/noneProvider.ts';
import { sttErrorCode } from './stt/types.ts';
import type { SpeechRecognitionProvider, SttProviderId, VoiceStatus } from './stt/types.ts';
import { createWebSpeechProvider } from './stt/webSpeechProvider.ts';

export interface TransmissionMeta {
  confidence?: number;
  durationMs: number;
  providerId: SttProviderId | 'typed';
  source: 'speech' | 'typed';
  /** True when the final transcript never arrived and the last partial was used. */
  usedPartial: boolean;
}

export interface VoiceStatusEvent {
  status: VoiceStatus;
  providerId: SttProviderId;
  /** Human-readable explanation for error-ish states, or a soft notice ("No speech detected"). */
  message?: string;
  error?: Error;
  timestamp: number;
}

export interface VoiceControllerOptions {
  onTransmission(text: string, meta: TransmissionMeta): void;
  providerId?: SttProviderId;
  /** Override or supply providers (tests, future cloud providers). */
  providers?: Partial<Record<SttProviderId, SpeechRecognitionProvider>>;
  /** Push-to-talk binding. `false` = no key listeners; drive via beginTransmission()/endTransmission(). */
  ptt?: { key: string; mode: PttMode; debounceMs?: number } | false;
  /** How long to wait for the final transcript after PTT release. Default 2500 ms. */
  finalTimeoutMs?: number;
  /** Keep the mic open briefly after release so the last syllable is not clipped. Default 150 ms. */
  releaseTailMs?: number;
  now?: () => number;
}

export interface VoiceController {
  readonly status: VoiceStatus;
  readonly ptt: PushToTalk | null;
  getProviderId(): SttProviderId;
  /** Switch recognition provider. Resolves to whether it is usable (status becomes 'unsupported' if not). */
  setProvider(id: SttProviderId): Promise<boolean>;
  getLastTranscript(): string;
  getLastPartial(): string;
  /** Feed a typed transcript through the same path as speech (typed fallback, tests). */
  simulateTransmission(text: string): void;
  beginTransmission(): void;
  endTransmission(): void;
  isTransmitting(): boolean;
  onStatusChange(listener: (e: VoiceStatusEvent) => void): () => void;
  onPartial(listener: (text: string) => void): () => void;
  /** Fires immediately on PTT down/up (before the provider is ready). Wire to TransmissionQueue.setControllerTransmitting. */
  onTransmittingChange(listener: (transmitting: boolean) => void): () => void;
  dispose(): void;
}

type Phase = 'starting' | 'listening' | 'processing' | 'done';

interface Session {
  id: number;
  phase: Phase;
  startedAt: number;
  partial: string;
  finals: string[];
  confidences: number[];
  provider: SpeechRecognitionProvider;
  startPromise: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  stopRequested: boolean;
}

export function createVoiceController(options: VoiceControllerOptions): VoiceController {
  const now = options.now ?? (() => Date.now());
  const finalTimeoutMs = options.finalTimeoutMs ?? 2500;
  const releaseTailMs = options.releaseTailMs ?? 150;

  const providers: Partial<Record<SttProviderId, SpeechRecognitionProvider>> = {
    webspeech: createWebSpeechProvider(),
    deepgram: createDeepgramProvider(),
    none: createNoneProvider(),
    ...options.providers,
  };

  let providerId: SttProviderId = options.providerId ?? 'webspeech';
  let status: VoiceStatus = 'idle';
  let lastTranscript = '';
  let lastPartial = '';
  let session: Session | null = null;
  let nextId = 1;
  let transmitting = false;
  let disposed = false;

  const statusListeners = new Set<(e: VoiceStatusEvent) => void>();
  const partialListeners = new Set<(t: string) => void>();
  const txListeners = new Set<(t: boolean) => void>();

  function emitStatus(next: VoiceStatus, message?: string, error?: Error) {
    status = next;
    const event: VoiceStatusEvent = { status: next, providerId, message, error, timestamp: now() };
    statusListeners.forEach((l) => l(event));
  }
  function setTransmitting(v: boolean) {
    if (transmitting === v) return;
    transmitting = v;
    txListeners.forEach((l) => l(v));
  }

  function currentProvider(): SpeechRecognitionProvider {
    return providers[providerId] ?? createNoneProvider();
  }

  function clearTimer(s: Session) {
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
  }

  function finish(s: Session, text: string, usedPartial: boolean) {
    if (s.phase === 'done') return;
    s.phase = 'done';
    clearTimer(s);
    if (session === s) session = null;
    const trimmed = text.trim();
    if (!trimmed) {
      emitStatus('idle', 'No speech detected.');
      return;
    }
    const confidence = s.confidences.length ? Math.min(...s.confidences) : undefined;
    lastTranscript = trimmed;
    lastPartial = '';
    emitStatus('idle');
    options.onTransmission(trimmed, {
      confidence,
      durationMs: Math.max(0, now() - s.startedAt),
      providerId: s.provider.id === 'none' ? 'typed' : s.provider.id,
      source: 'speech',
      usedPartial,
    });
  }

  function fail(s: Session, err: Error) {
    if (s.phase === 'done') return;
    s.phase = 'done';
    clearTimer(s);
    if (session === s) session = null;
    s.provider.stop().catch(() => undefined);
    setTransmitting(ptt ? ptt.isTransmitting() : false);
    const code = sttErrorCode(err);
    switch (code) {
      case 'no_speech':
        emitStatus('idle', err.message, err);
        break;
      case 'not_allowed':
        emitStatus('permission_denied', err.message, err);
        break;
      case 'unsupported':
        emitStatus('unsupported', err.message, err);
        break;
      default:
        emitStatus('error', err.message || 'Voice input failed.', err);
    }
  }

  /** Complete a session that is waiting for a final using whatever we have. */
  function flush(s: Session) {
    if (s.phase === 'done') return;
    if (s.finals.length) finish(s, s.finals.join(' '), false);
    else finish(s, s.partial, true);
  }

  function beginTransmission() {
    if (disposed) return;
    if (session && (session.phase === 'starting' || session.phase === 'listening')) return;
    if (session && session.phase === 'processing') flush(session); // new key-down supersedes the wait

    const provider = currentProvider();
    const s: Session = {
      id: nextId++,
      phase: 'starting',
      startedAt: now(),
      partial: '',
      finals: [],
      confidences: [],
      provider,
      startPromise: Promise.resolve(),
      timer: null,
      stopRequested: false,
    };
    session = s;
    lastPartial = '';
    setTransmitting(true);
    emitStatus('listening');

    s.startPromise = provider
      .start({
        onPartial(text) {
          if (s.phase === 'done') return;
          s.partial = text;
          lastPartial = text;
          partialListeners.forEach((l) => l(text));
        },
        onFinal(text, meta) {
          if (s.phase === 'done') return;
          if (text.trim()) s.finals.push(text.trim());
          if (typeof meta.confidence === 'number') s.confidences.push(meta.confidence);
          if (s.phase === 'processing') finish(s, s.finals.join(' '), false);
        },
        onError(err) {
          fail(s, err);
        },
      })
      .then(() => {
        if (s.phase === 'starting') s.phase = 'listening';
      })
      .catch((err: unknown) => {
        fail(s, err instanceof Error ? err : new Error(String(err)));
      });
  }

  async function endTransmission() {
    const s = session;
    if (!s || s.phase === 'processing' || s.phase === 'done') return;
    setTransmitting(false);
    if (releaseTailMs > 0 && s.phase === 'listening') {
      await new Promise<void>((r) => setTimeout(r, releaseTailMs));
    }
    if ((s.phase as Phase) === 'done' || s.stopRequested) return;
    s.stopRequested = true;
    await s.startPromise; // PTT may be released before the mic is ready
    if ((s.phase as Phase) === 'done') return;
    s.phase = 'processing';
    emitStatus('processing');
    s.timer = setTimeout(() => flush(s), finalTimeoutMs);
    try {
      await s.provider.stop();
    } catch (err) {
      fail(s, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if ((s.phase as Phase) === 'done') return;
    if (s.finals.length > 0) finish(s, s.finals.join(' '), false);
    else if (!s.partial.trim()) finish(s, '', false);
    // else: wait for the final or the timeout
  }

  const pttConfig = options.ptt === undefined ? { key: 'Space', mode: 'hold' as PttMode } : options.ptt;
  const ptt =
    pttConfig === false || typeof window === 'undefined'
      ? null
      : createPushToTalk({
          key: pttConfig.key,
          mode: pttConfig.mode,
          debounceMs: pttConfig.debounceMs,
          onStart: beginTransmission,
          onEnd: () => void endTransmission(),
        });

  return {
    get status() {
      return status;
    },
    ptt,
    getProviderId: () => providerId,
    async setProvider(id) {
      if (session && session.phase !== 'done') {
        const s = session;
        s.phase = 'done';
        clearTimer(s);
        session = null;
        s.provider.stop().catch(() => undefined);
        setTransmitting(ptt ? ptt.isTransmitting() : false);
      }
      providerId = id;
      const p = currentProvider();
      let ok = false;
      try {
        ok = await p.isAvailable();
      } catch {
        ok = false;
      }
      if (providerId !== id) return ok; // superseded by a later call
      if (ok) emitStatus('idle');
      else if (id === 'none') emitStatus('idle', 'Speech input is off. Type your transmissions.');
      else emitStatus('unsupported', `${p.label} is not available. Check browser support / server configuration, or pick another provider.`);
      return ok;
    },
    getLastTranscript: () => lastTranscript,
    getLastPartial: () => lastPartial,
    simulateTransmission(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      lastTranscript = trimmed;
      emitStatus('processing');
      emitStatus('idle');
      options.onTransmission(trimmed, {
        confidence: 1,
        durationMs: 0,
        providerId: 'typed',
        source: 'typed',
        usedPartial: false,
      });
    },
    beginTransmission,
    endTransmission: () => void endTransmission(),
    isTransmitting: () => transmitting,
    onStatusChange(l) {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    onPartial(l) {
      partialListeners.add(l);
      return () => partialListeners.delete(l);
    },
    onTransmittingChange(l) {
      txListeners.add(l);
      return () => txListeners.delete(l);
    },
    dispose() {
      disposed = true;
      ptt?.destroy();
      if (session) {
        clearTimer(session);
        session.provider.stop().catch(() => undefined);
        session = null;
      }
      statusListeners.clear();
      partialListeners.clear();
      txListeners.clear();
    },
  };
}
