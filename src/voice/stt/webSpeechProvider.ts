/**
 * Web Speech API provider (`SpeechRecognition` / `webkitSpeechRecognition`).
 *
 * PRIVACY NOTE: Chrome's implementation does NOT recognise speech on-device.
 * It streams the microphone audio to Google's servers (Edge: Microsoft's).
 * That must be stated plainly to users; the settings copy lives in
 * `STT_PROVIDER_NOTES` (./providerNotes.ts) and is re-exported below.
 *
 * Behaviour: the API is configured with continuous=true so Chrome keeps listening through the pauses in an ATC call
 * ("... echo juliet, <pause> runway one three ..."). With continuous=false Chrome closes the session at the first pause
 * and the rest of the call is lost (observed with a real Google Chrome and the fixture clips). The whole transcript is
 * rebuilt from `event.results` on every event, because Chrome keeps several not-yet-final segments alive at once and an
 * incremental update from `resultIndex` drops the earlier ones. If Chrome still ends the session while the PTT key is
 * held, recognition is restarted and what was heard is kept. A single onFinal is emitted after stop().
 *
 * Measured with Chrome 155 and Google's service (fixture clips, repeatable):
 *  - The service takes 1-3 s to start returning text, and audio spoken before its streaming connection is up is NOT
 *    transcribed ("Cessna 723 Echo Juliet" vanished and "Runway 13 cleared for takeoff" came back). With 3 s of lead-in
 *    silence the whole call is transcribed in either mode. Nothing in the page can buffer audio for Chrome's recognizer,
 *    so a user should wait a beat after keying (the e2e clips have a lead-in for the same reason).
 *  - In continuous mode Chrome may replace its whole result list with just the last final chunk ("cleared for takeoff"),
 *    dropping the interim text before it; appendTranscript() merges those so nothing is lost.
 *  - continuous=false stalled after "723 Echo" in one slow-connection run and ends at the first pause in a call.
 * continuous=true is therefore the default; `continuous: false` (or localStorage `kacy.webspeech.continuous` = `0`) selects
 * the other behaviour for diagnostics.
 *
 * Audio source: by default Chrome listens to the system default microphone itself. `audioSource: 'track'` (or localStorage
 * `kacy.webspeech.audioSource` = `track`) instead opens the microphone with getUserMedia and hands that track to
 * `SpeechRecognition.start(track)` (Chrome 14x+). It is the only way to feed Chrome's recognizer from a WAV through the fake
 * microphone in automation (see e2e/webspeech.spec.ts); it is off by default so older browsers are unaffected.
 */
import { pickBestAlternative } from './aviationVocab.ts';
import { withPreferredInput } from './inputDevice.ts';
import { mapMediaError } from './mediaErrors.ts';
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
  start(track?: MediaStreamTrack): void;
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

const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

/** True when `next` looks like a revision/extension of `prev` (same first word), not a fresh chunk. */
export function sameStart(prev: string, next: string): boolean {
  const a = words(prev)[0];
  const b = words(next)[0];
  return a === undefined || b === undefined || a === b || a.startsWith(b) || b.startsWith(a); // "cess" -> "cessna"
}

/**
 * `base` + `add`, dropping words at the start of `add` that merely repeat the end of `base` (Chrome's final chunk often
 * re-states the tail it already showed as interim text: "... cleared for" + "cleared for takeoff").
 */
export function appendTranscript(base: string, add: string): string {
  const b = base.trim().split(/\s+/).filter(Boolean);
  const a = add.trim().split(/\s+/).filter(Boolean);
  if (!b.length) return a.join(' ');
  if (!a.length) return b.join(' ');
  const bw = b.map((w) => words(w).join(''));
  const aw = a.map((w) => words(w).join(''));
  let k = Math.min(b.length, a.length);
  for (; k > 0; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) if (bw[b.length - k + i] !== aw[i]) { ok = false; break; }
    if (ok) break;
  }
  return [...b, ...a.slice(k)].join(' ');
}

const MAX_RESTARTS = 8;
const STOP_SETTLE_TIMEOUT_MS = 3000;
/**
 * Some browsers expose SpeechRecognition but never fire `start` or `error` (headless Chromium, embedded webviews, no
 * speech service). Without a deadline start() hangs and the UI stays on "Transmitting" forever. Not applied while the
 * microphone permission prompt is open, because the user may legitimately take a while to answer it.
 */
const START_TIMEOUT_MS = 6000;

async function micPermissionPending(): Promise<boolean> {
  try {
    const perms = typeof navigator !== 'undefined' ? navigator.permissions : undefined;
    if (!perms?.query) return false;
    const status = await perms.query({ name: 'microphone' as PermissionName });
    return status.state === 'prompt';
  } catch {
    return false;
  }
}

export interface WebSpeechProviderOptions {
  /** Injectable for tests. */
  ctor?: RecCtor;
  now?: () => number;
  /** 'default' = Chrome's own microphone capture; 'track' = getUserMedia track passed to start(track). */
  audioSource?: 'default' | 'track';
  /** Default true (see the header). */
  continuous?: boolean;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  /** Override the start() deadline in tests. */
  startTimeoutMs?: number;
}

export function createWebSpeechProvider(options: WebSpeechProviderOptions = {}): SpeechRecognitionProvider {
  const getCtor = () => options.ctor ?? findCtor();
  const now = options.now ?? (() => Date.now());

  const audioSource = (): 'default' | 'track' => {
    if (options.audioSource) return options.audioSource;
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem('kacy.webspeech.audioSource') === 'track' ? 'track' : 'default';
    } catch {
      return 'default';
    }
  };
  const continuous = (): boolean => {
    if (options.continuous !== undefined) return options.continuous;
    try {
      return !(typeof localStorage !== 'undefined' && localStorage.getItem('kacy.webspeech.continuous') === '0');
    } catch {
      return true;
    }
  };
  const getMedia = () =>
    options.getUserMedia ??
    (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
      ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
      : undefined);

  let rec: RecInstance | null = null;
  let stream: MediaStream | null = null;
  const releaseStream = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };
  /** Begin one recognizer run, feeding it a getUserMedia track when audioSource is 'track'. */
  async function beginRun(r: RecInstance): Promise<void> {
    if (audioSource() === 'track') {
      const media = getMedia();
      if (media) {
        releaseStream();
        stream = await media({ audio: withPreferredInput(true) });
        const track = stream.getAudioTracks()[0];
        try {
          r.start(track);
          return;
        } catch (err) {
          if (!(err instanceof TypeError)) throw err;
          releaseStream(); // this Chrome has no start(track): use its own microphone capture
        }
      }
    }
    r.start();
  }

  type Segment = { text: string; final: boolean; confidence: number };
  let session: {
    opts: SttStartOptions;
    /** Text kept from earlier in this transmission (recognizer restarts, and results Chrome later dropped). */
    archived: string;
    confidences: number[];
    /** The latest results of the current run, rebuilt from event.results on every event. */
    segments: Segment[];
    /** `segments` joined: the text of the previous event, to notice when Chrome resets its result list. */
    runText: string;
    startedAt: number;
    wantListening: boolean;
    restarts: number;
    done: boolean;
    settle: (() => void)[];
  } | null = null;

  function runningText(s: NonNullable<typeof session>): string {
    return appendTranscript(s.archived, s.runText);
  }

  /** Keep what the ending run heard (interim text counts: Chrome sometimes ends without marking the last segment final). */
  function archiveRun(s: NonNullable<typeof session>) {
    s.archived = appendTranscript(s.archived, s.runText);
    for (const g of s.segments) if (g.final && g.confidence > 0) s.confidences.push(g.confidence);
    s.segments = [];
    s.runText = '';
  }

  function finish(s: NonNullable<typeof session>, error?: Error) {
    if (s.done) return;
    s.done = true;
    s.wantListening = false;
    releaseStream();
    if (!error) archiveRun(s);
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
      const segments: Segment[] = [];
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i];
        const alts: RecAlternative[] = [];
        for (let a = 0; a < result.length; a++) alts.push(result[a]);
        const best = pickBestAlternative(alts) ?? alts[0];
        if (!best || !best.transcript.trim()) continue;
        segments.push({ text: best.transcript.trim(), final: result.isFinal, confidence: best.confidence ?? 0 });
      }
      const cur = segments.map((g) => g.text).join(' ').replace(/\s+/g, ' ').trim();
      // Chrome can replace its whole result list with a single final chunk ("cleared for takeoff") and drop the interim
      // text before it. When the new text no longer starts like the previous event's text, keep the previous text.
      // A one- or two-word hypothesis that changes (sesame -> Cessna 723) is a revision, not text worth keeping.
      if (s.runText && cur && !sameStart(s.runText, cur) && words(s.runText).length >= 3) {
        for (const g of s.segments) if (g.final && g.confidence > 0) s.confidences.push(g.confidence);
        s.archived = appendTranscript(s.archived, s.runText);
      }
      s.segments = segments;
      s.runText = cur;
      const text = runningText(s);
      if (text) s.opts.onPartial(text);
    };
    r.onerror = (e) => {
      if (s.done) return;
      if (e.error === 'aborted') return;
      // While the key is still held, silence is not an error: keep waiting.
      if (e.error === 'no-speech' && s.wantListening) return;
      if (e.error === 'no-speech' && (s.archived.length > 0 || s.runText.length > 0)) return;
      finish(s, describeWebSpeechError(e.error));
    };
    r.onend = () => {
      if (s.done) return;
      if (s.wantListening && s.restarts < MAX_RESTARTS) {
        // Chrome ended the session on a pause but the key is still down.
        s.restarts++;
        archiveRun(s);
        const next = rec ?? r;
        beginRun(next).catch((err: unknown) => finish(s, err instanceof SttError ? err : new SttError('unknown', 'Could not restart speech recognition.', { cause: err })));
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
      r.continuous = continuous();
      r.interimResults = true;
      r.lang = 'en-US';
      r.maxAlternatives = 3;
      const s = {
        opts,
        archived: '',
        confidences: [] as number[],
        segments: [] as Segment[],
        runText: '',
        startedAt: now(),
        wantListening: true,
        restarts: 0,
        done: false,
        settle: [] as (() => void)[],
      };
      session = s;
      rec = r;
      wire(r, s);
      const startTimeoutMs = options.startTimeoutMs ?? ((await micPermissionPending()) ? 0 : START_TIMEOUT_MS);
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (startTimeoutMs > 0) {
          timer = setTimeout(() => {
            s.done = true;
            session = null;
            rec = null;
            try { r.abort(); } catch { /* ignore */ }
            reject(new SttError('unsupported', 'Browser speech recognition did not start (no speech service is available in this browser). Pick another provider in Settings, or type your transmission.'));
          }, startTimeoutMs);
        }
        r.onstart = () => {
          clearTimeout(timer);
          resolve();
        };
        const prevError = r.onerror;
        r.onerror = (e) => {
          // Errors before the session started reject start() directly.
          if (e.error !== 'no-speech' && e.error !== 'aborted') {
            clearTimeout(timer);
            s.done = true;
            session = null;
            rec = null;
            reject(describeWebSpeechError(e.error));
            return;
          }
          prevError?.(e);
        };
        beginRun(r).catch((err: unknown) => {
          clearTimeout(timer);
          s.done = true;
          session = null;
          rec = null;
          const named = (err as { name?: string } | null)?.name;
          reject(
            named === 'NotAllowedError' || named === 'NotFoundError' || named === 'NotReadableError' || named === 'SecurityError'
              ? mapMediaError(err)
              : new SttError('unknown', 'Could not start speech recognition.', { cause: err }),
          );
        });
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
