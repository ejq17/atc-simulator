/**
 * Deepgram streaming speech-to-text over WebSocket.
 *
 * Docs verified (see README for dates):
 *  - Live streaming reference (params, message types, CloseStream):
 *    https://developers.deepgram.com/reference/speech-to-text/listen-streaming
 *  - Temporary tokens (POST /v1/auth/grant, 30 s default TTL, max 3600 s):
 *    https://developers.deepgram.com/reference/auth/tokens/grant
 *    https://developers.deepgram.com/docs/token-based-authentication
 *  - Browser auth via Sec-WebSocket-Protocol:
 *    https://developers.deepgram.com/docs/using-the-sec-websocket-protocol
 *    The docs show `['token', <api key>]`. They do not state the subprotocol for
 *    JWT access tokens, so we try `['token', jwt]` first (as specified for this
 *    project) and fall back to `['bearer', jwt]`, remembering whichever works.
 *
 * The API key is NEVER in the browser: a short-lived token is fetched from our
 * own backend (server/voice/deepgramToken.ts).
 */
import { AVIATION_KEYTERMS } from './aviationVocab.ts';
import { startPcmCapture, TARGET_SAMPLE_RATE, warmUpAudio } from './pcmCapture.ts';
import type { PcmCapture, WarmAudio } from './pcmCapture.ts';
import type { SpeechRecognitionProvider, SttStartOptions } from './types.ts';
import { mapMediaError } from './mediaErrors.ts';
import { SttError } from './types.ts';

export const DEEPGRAM_WS_BASE = 'wss://api.deepgram.com';
export const DEEPGRAM_LISTEN_PATH = '/v1/listen';
export const DEEPGRAM_LISTEN_URL = `${DEEPGRAM_WS_BASE}${DEEPGRAM_LISTEN_PATH}`;
/** Runtime override for tests only: honoured when it is a ws:// URL on this machine (see resolveDeepgramWsBase). */
export const DEEPGRAM_WS_BASE_STORAGE_KEY = 'kacy.deepgram.wsBase';

const isLoopbackHost = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

/**
 * Where to open the streaming socket. Default wss://api.deepgram.com.
 *  - `VITE_DEEPGRAM_WS_BASE` (build/dev-server env) may point at any ws(s) URL, e.g. a company proxy.
 *  - localStorage `kacy.deepgram.wsBase` (set by e2e/deepgram.spec.ts) is honoured only for ws://localhost or
 *    ws://127.0.0.1, so a stray storage value can never send microphone audio to a remote host.
 */
export function resolveDeepgramWsBase(sources: { env?: string; stored?: string | null } = {}): string {
  const env = sources.env ?? (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_DEEPGRAM_WS_BASE;
  let stored = sources.stored;
  if (stored === undefined) {
    try {
      stored = typeof localStorage !== 'undefined' ? localStorage.getItem(DEEPGRAM_WS_BASE_STORAGE_KEY) : null;
    } catch {
      stored = null;
    }
  }
  const parse = (raw: string | null | undefined, loopbackOnly: boolean): string | undefined => {
    if (!raw?.trim()) return undefined;
    try {
      const u = new URL(raw.trim());
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return undefined;
      if (loopbackOnly && !(u.protocol === 'ws:' && isLoopbackHost(u.hostname))) return undefined;
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      return undefined;
    }
  };
  return parse(stored, true) ?? parse(env, false) ?? DEEPGRAM_WS_BASE;
}
export const DEEPGRAM_TOKEN_PATH = '/api/voice/deepgram-token';

export type DeepgramAuthScheme = 'token' | 'bearer';

export function buildDeepgramListenUrl(model: string, baseUrl: string = DEEPGRAM_LISTEN_URL): string {
  const p = new URLSearchParams();
  p.set('model', model);
  p.set('language', 'en-US');
  p.set('smart_format', 'false');
  p.set('punctuate', 'false');
  p.set('interim_results', 'true');
  p.set('endpointing', '300');
  p.set('encoding', 'linear16');
  p.set('sample_rate', String(TARGET_SAMPLE_RATE));
  p.set('channels', '1');
  if (model.startsWith('nova-3')) {
    for (const term of AVIATION_KEYTERMS) p.append('keyterm', term);
  } else {
    // Nova-2 and earlier use boosted `keywords` instead of `keyterm`.
    for (const term of AVIATION_KEYTERMS) p.append('keywords', `${term}:2`);
  }
  return `${baseUrl}?${p.toString()}`;
}

interface DgAlternative { transcript?: string; confidence?: number }
interface DgMessage {
  type?: string;
  is_final?: boolean;
  channel?: { alternatives?: DgAlternative[] };
}

type WebSocketLike = {
  binaryType: string;
  readyState: number;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: ((e: { code?: number }) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
};
type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

export interface DeepgramProviderOptions {
  tokenUrl?: string;
  model?: string;
  fallbackModel?: string;
  fetchFn?: typeof fetch;
  WebSocketCtor?: WebSocketCtor;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  startCapture?: (stream: MediaStream, onChunk: (pcm: ArrayBuffer) => void, warm?: WarmAudio) => Promise<PcmCapture>;
  /** Test seam for the idle audio graph (see warmUpAudio). */
  warmUpAudio?: () => Promise<WarmAudio>;
  /** Streaming socket base, e.g. `ws://127.0.0.1:8799`; default resolveDeepgramWsBase(). */
  wsBase?: string;
  closeTimeoutMs?: number;
  now?: () => number;
}

let preferredScheme: DeepgramAuthScheme = 'token';

export function createDeepgramProvider(options: DeepgramProviderOptions = {}): SpeechRecognitionProvider {
  const tokenUrl = options.tokenUrl ?? DEEPGRAM_TOKEN_PATH;
  const models = [options.model ?? 'nova-3', options.fallbackModel ?? 'nova-2'];
  const closeTimeoutMs = options.closeTimeoutMs ?? 2000;
  const now = options.now ?? (() => Date.now());
  const doFetch = (...a: Parameters<typeof fetch>) => (options.fetchFn ?? fetch)(...a);
  const getWS = () => options.WebSocketCtor ?? (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket;
  const getMedia = () =>
    options.getUserMedia ??
    (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
      ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
      : undefined);

  async function fetchToken(): Promise<string> {
    let res: Response;
    try {
      res = await doFetch(tokenUrl, { method: 'POST', headers: { Accept: 'application/json' } });
    } catch (err) {
      throw new SttError('network', 'Could not reach the local voice server to get a Deepgram token. Is `npm run server` running?', { cause: err });
    }
    let body: { access_token?: string; error?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const code = res.status === 503 ? 'unavailable' : 'network';
      throw new SttError(code, body.error ?? `Deepgram token request failed (HTTP ${res.status}).`);
    }
    if (!body.access_token) throw new SttError('unavailable', 'The voice server did not return a Deepgram token.');
    return body.access_token;
  }

  function openSocket(WS: WebSocketCtor, url: string, protocols: string[]): Promise<WebSocketLike> {
    return new Promise((resolve, reject) => {
      const ws = new WS(url, protocols);
      ws.binaryType = 'arraybuffer';
      let opened = false;
      ws.onopen = () => {
        opened = true;
        resolve(ws);
      };
      ws.onerror = () => { /* the close event carries the outcome */ };
      ws.onclose = (e) => {
        if (!opened) reject(new Error(`WebSocket closed before opening (code ${e.code ?? 'unknown'})`));
      };
    });
  }

  async function connect(WS: WebSocketCtor, token: string): Promise<WebSocketLike> {
    const schemes: DeepgramAuthScheme[] = preferredScheme === 'token' ? ['token', 'bearer'] : ['bearer', 'token'];
    let lastErr: unknown;
    for (const model of models) {
      for (const scheme of schemes) {
        try {
          const ws = await openSocket(WS, buildDeepgramListenUrl(model, `${options.wsBase ?? resolveDeepgramWsBase()}${DEEPGRAM_LISTEN_PATH}`), [scheme, token]);
          preferredScheme = scheme;
          return ws;
        } catch (err) {
          lastErr = err;
        }
      }
    }
    throw new SttError('network', 'Could not connect to Deepgram. Check your internet connection and that the API key has access to streaming.', { cause: lastErr });
  }

  let active: {
    ws: WebSocketLike;
    capture: PcmCapture;
    opts: SttStartOptions;
    finals: string[];
    confidences: number[];
    interim: string;
    startedAt: number;
    closed: boolean;
    stopping: boolean;
    onClosed: (() => void)[];
    delivered: boolean;
  } | null = null;

  function text(s: NonNullable<typeof active>): string {
    return [...s.finals, s.interim].filter(Boolean).join(' ').trim();
  }

  function handleMessage(s: NonNullable<typeof active>, data: unknown) {
    if (typeof data !== 'string') return;
    let msg: DgMessage;
    try {
      msg = JSON.parse(data) as DgMessage;
    } catch {
      return;
    }
    if (msg.type !== 'Results') return;
    const alt = msg.channel?.alternatives?.[0];
    const t = (alt?.transcript ?? '').trim();
    if (msg.is_final) {
      if (t) {
        s.finals.push(t);
        if (typeof alt?.confidence === 'number') s.confidences.push(alt.confidence);
      }
      s.interim = '';
    } else {
      s.interim = t;
    }
    const running = text(s);
    if (running) s.opts.onPartial(running);
  }

  function deliver(s: NonNullable<typeof active>, error?: Error) {
    if (s.delivered) return;
    s.delivered = true;
    if (error) {
      s.opts.onError(error);
    } else {
      const t = text(s);
      if (!t) {
        s.opts.onError(new SttError('no_speech', 'No speech detected. Hold the key, then speak.'));
      } else {
        const conf = s.confidences.length ? s.confidences.reduce((a, b) => a + b, 0) / s.confidences.length : undefined;
        s.opts.onFinal(t, { confidence: conf, durationMs: now() - s.startedAt });
      }
    }
  }

  let warm: Promise<WarmAudio | null> | null = null;
  const getWarm = (): Promise<WarmAudio | null> => {
    warm ??= (options.warmUpAudio ?? warmUpAudio)().catch(() => null);
    return warm;
  };

  const provider: SpeechRecognitionProvider = {
    id: 'deepgram',
    label: 'Deepgram',
    async prepare() {
      await getWarm();
    },
    async dispose() {
      const w = warm;
      warm = null;
      await (await w)?.close();
    },
    async isAvailable() {
      if (!getWS() || !getMedia()) return false;
      try {
        const res = await doFetch(tokenUrl, { method: 'GET', headers: { Accept: 'application/json' } });
        if (!res.ok) return false;
        const body = (await res.json()) as { configured?: boolean };
        return body.configured === true;
      } catch {
        return false;
      }
    },
    async start(opts) {
      const WS = getWS();
      const media = getMedia();
      if (!WS || !media) throw new SttError('unsupported', 'This browser cannot stream microphone audio to Deepgram.');
      if (active) await provider.stop();

      let stream: MediaStream;
      let graph: WarmAudio | null;
      try {
        // Open the microphone and (first press only) build the audio graph at the same time: building it on demand
        // costs about half a second of speech (see pcmCapture.warmUpAudio).
        [stream, graph] = await Promise.all([media({ audio: { echoCancellation: true, noiseSuppression: true } }), getWarm()]);
      } catch (err) {
        throw mapMediaError(err);
      }
      if (graph && graph.ctx.state === 'closed') {
        warm = null;
        graph = null;
      }

      // Start capturing right away and buffer, so connection latency never clips the first word.
      const pending: ArrayBuffer[] = [];
      let live: WebSocketLike | null = null;
      const startCapture = options.startCapture ?? startPcmCapture;
      let capture: PcmCapture;
      try {
        capture = await startCapture(
          stream,
          (pcm) => {
            if (live) live.send(pcm);
            else pending.push(pcm);
          },
          graph ?? undefined,
        );
      } catch (err) {
        stream.getTracks().forEach((t) => t.stop());
        throw new SttError('no_microphone', 'Could not process microphone audio in this browser.', { cause: err });
      }
      const startedAt = now();

      let ws: WebSocketLike;
      try {
        const token = await fetchToken();
        ws = await connect(WS, token);
      } catch (err) {
        await capture.stop().catch(() => undefined);
        throw err;
      }

      const s: NonNullable<typeof active> = {
        ws,
        capture,
        opts,
        finals: [],
        confidences: [],
        interim: '',
        startedAt,
        closed: false,
        stopping: false,
        onClosed: [],
        delivered: false,
      };
      active = s;
      ws.onmessage = (e) => handleMessage(s, e.data);
      ws.onclose = () => {
        s.closed = true;
        s.onClosed.splice(0).forEach((f) => f());
        if (!s.stopping) {
          // Dropped mid-transmission.
          void capture.stop().catch(() => undefined);
          deliver(s, new SttError('network', 'The connection to Deepgram was lost.'));
          if (active === s) active = null;
        }
      };
      ws.onerror = () => { /* followed by close */ };
      live = ws;
      for (const chunk of pending.splice(0)) ws.send(chunk);
    },
    async stop() {
      const s = active;
      if (!s) return;
      s.stopping = true;
      active = null;
      await s.capture.stop().catch(() => undefined);
      if (!s.closed) {
        const closed = new Promise<void>((resolve) => s.onClosed.push(resolve));
        try {
          s.ws.send(JSON.stringify({ type: 'CloseStream' }));
        } catch { /* socket already gone */ }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, closeTimeoutMs);
        });
        await Promise.race([closed, timeout]);
        clearTimeout(timer);
        try { s.ws.close(); } catch { /* ignore */ }
      }
      deliver(s);
    },
  };
  return provider;
}
