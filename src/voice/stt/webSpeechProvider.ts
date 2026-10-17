/**
 * Web Speech API provider (`SpeechRecognition` / `webkitSpeechRecognition`).
 *
 * PRIVACY NOTE: Chrome's implementation does NOT recognise speech on-device.
 * It streams the microphone audio to Google's servers (Edge: Microsoft's).
 * That must be stated plainly to users; the settings copy lives in
 * `STT_PROVIDER_NOTES` (./providerNotes.ts) and is re-exported below.
 *
 * Behaviour: the API is configured with continuous=false (Chrome ends a
 * session after a short silence), so while the controller keeps the PTT key
 * held this provider transparently restarts recognition and accumulates the
 * finals. A single onFinal is emitted after stop().
 */
import { pickBestAlternative } from './aviationVocab.ts';
import type { SpeechRecognitionProvider, SttStartOptions } from './types.ts';
import { SttError } from './types.ts';

export { STT_PROVIDER_NOTES } from './providerNotes.ts';

// Minimal structural types: lib.dom does not ship SpeechRecognition everywhere.
interface RecAlternative { transcript: string; confidence: number }
interface RecResult { isFinal: boolean; length: number; [index: number]: RecAlternative }
interface RecResultList { length: number; [index: number]: RecResult }
interface RecResultEvent { resultIndex: number; results: RecResultList }
interface RecErrorEvent { error: string; message?: string }
interface RecInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: RecErrorEvent) => void) | null;
  onresult: ((e: RecResultEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecCtor = new () => RecInstance;

function findCtor(): RecCtor | undefined {
  const g = globalThis as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition;
}

export function describeWebSpeechError(code: string): SttError {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return new SttError(
        'not_allowed',
        'Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.',
      );
    case 'audio-capture':
      return new SttError('no_microphone', 'No working microphone was found. Check that a microphone is connected and not in use by another app.');
    case 'no-speech':
      return new SttError('no_speech', 'No speech detected. Hold the key, then speak.');
    case 'network':
      return new SttError(
        'network',
        "The browser's speech recognition service could not be reached. Check your internet connection (Chrome sends audio to Google for recognition), or switch to another provider.",
      );
    case 'language-not-supported':
      return new SttError('unsupported', 'This browser does not support English (US) speech recognition.');
    default:
      return new SttError('unknown', `Speech recognition failed (${code}).`);
  }
}

const MAX_RESTARTS = 8;
const STOP_SETTLE_TIMEOUT_MS = 3000;

export interface WebSpeechProviderOptions {
  /** Injectable for tests. */
  ctor?: RecCtor;
  now?: () => number;
}

export function createWebSpeechProvider(options: WebSpeechProviderOptions = {}): SpeechRecognitionProvider {
  const getCtor = () => options.ctor ?? findCtor();
  const now = options.now ?? (() => Date.now());

  let rec: RecInstance | null = null;
  let session: {
    opts: SttStartOptions;
    finals: string[];
    confidences: number[];
    interim: string;
    startedAt: number;
    wantListening: boolean;
    restarts: number;
    done: boolean;
    settle: (() => void)[];
  } | null = null;

  function runningText(s: NonNullable<typeof session>): string {
    return [...s.finals, s.interim].filter(Boolean).join(' ').trim();
  }

  function finish(s: NonNullable<typeof session>, error?: Error) {
    if (s.done) return;
    s.done = true;
    s.wantListening = false;
    if (error) {
      s.opts.onError(error);
    } else {
      // A cut-off final may only exist as an interim: use it.
      const text = runningText(s);
      if (text) {
        const conf = s.confidences.length ? s.confidences.reduce((a, b) => a + b, 0) / s.confidences.length : undefined;
        s.opts.onFinal(text, { confidence: conf, durationMs: now() - s.startedAt });
      } else {
        s.opts.onError(describeWebSpeechError('no-speech'));
      }
    }
    const waiters = s.settle.splice(0);
    waiters.forEach((w) => w());
    if (session === s) {
      session = null;
      rec = null;
    }
  }

  function wire(r: RecInstance, s: NonNullable<typeof session>) {
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const alts: RecAlternative[] = [];
        for (let a = 0; a < result.length; a++) alts.push(result[a]);
        const best = pickBestAlternative(alts) ?? alts[0];
        if (!best) continue;
        if (result.isFinal) {
          if (best.transcript.trim()) {
            s.finals.push(best.transcript.trim());
            if (typeof best.confidence === 'number' && best.confidence > 0) s.confidences.push(best.confidence);
          }
        } else {
          interim += (interim ? ' ' : '') + best.transcript.trim();
        }
      }
      s.interim = interim;
      const text = runningText(s);
      if (text) s.opts.onPartial(text);
    };
    r.onerror = (e) => {
      if (s.done) return;
      if (e.error === 'aborted') return;
      // While the key is still held, silence is not an error: keep waiting.
      if (e.error === 'no-speech' && s.wantListening) return;
      if (e.error === 'no-speech' && s.finals.length > 0) return;
      finish(s, describeWebSpeechError(e.error));
    };
    r.onend = () => {
      if (s.done) return;
      if (s.wantListening && s.restarts < MAX_RESTARTS) {
        // Chrome ended the session on a pause but the key is still down.
        s.restarts++;
        s.interim = '';
        try {
          const next = rec ?? r;
          next.start();
        } catch {
          finish(s);
        }
        return;
      }
      finish(s);
    };
  }

  return {
    id: 'webspeech',
    label: 'Browser speech recognition',
    async isAvailable() {
      return getCtor() !== undefined;
    },
    async start(opts) {
      const Ctor = getCtor();
      if (!Ctor) {
        throw new SttError('unsupported', 'This browser does not support speech recognition. Use Chrome or Edge, enable Deepgram, or type your transmission.');
      }
      if (session) {
        try { rec?.abort(); } catch { /* ignore */ }
        session = null;
      }
      const r = new Ctor();
      r.continuous = false;
      r.interimResults = true;
      r.lang = 'en-US';
      r.maxAlternatives = 3;
      const s = {
        opts,
        finals: [] as string[],
        confidences: [] as number[],
        interim: '',
        startedAt: now(),
        wantListening: true,
        restarts: 0,
        done: false,
        settle: [] as (() => void)[],
      };
      session = s;
      rec = r;
      wire(r, s);
      await new Promise<void>((resolve, reject) => {
        r.onstart = () => resolve();
        const prevError = r.onerror;
        r.onerror = (e) => {
          // Errors before the session started reject start() directly.
          if (e.error !== 'no-speech' && e.error !== 'aborted') {
            s.done = true;
            session = null;
            rec = null;
            reject(describeWebSpeechError(e.error));
            return;
          }
          prevError?.(e);
        };
        try {
          r.start();
        } catch (err) {
          s.done = true;
          session = null;
          rec = null;
          reject(new SttError('unknown', 'Could not start speech recognition.', { cause: err }));
        }
      });
      // After start succeeded, restore the normal error handler.
      wire(r, s);
      r.onstart = null;
    },
    async stop() {
      const s = session;
      const r = rec;
      if (!s || !r || s.done) return;
      s.wantListening = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = new Promise<void>((resolve) => {
        s.settle.push(resolve);
        timer = setTimeout(() => {
          finish(s);
        }, STOP_SETTLE_TIMEOUT_MS);
      });
      try {
        r.stop();
      } catch {
        finish(s);
      }
      await settled;
      clearTimeout(timer);
    },
  };
}
