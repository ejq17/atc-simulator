import { describe, expect, it, vi } from 'vitest';
import { pickBestAlternative, scoreAviationPlausibility } from './aviationVocab.ts';
import { buildDeepgramListenUrl, createDeepgramProvider, DEEPGRAM_WS_BASE, resolveDeepgramWsBase } from './deepgramProvider.ts';
import { createResampler, floatToInt16, hasTrackProcessor, startPcmCapture } from './pcmCapture.ts';
import { appendTranscript, createWebSpeechProvider, describeWebSpeechError, sameStart } from './webSpeechProvider.ts';
import { sttErrorCode } from './types.ts';

describe('aviation plausibility', () => {
  it('prefers the alternative with aviation keywords', () => {
    const best = pickBestAlternative([
      { transcript: 'spirit wine two tree tax he to run way', confidence: 0.9 },
      { transcript: 'spirit one two three taxi runway one three hold short', confidence: 0.7 },
      { transcript: 'spirit one two tree', confidence: 0.8 },
    ]);
    expect(best?.transcript).toContain('runway');
  });
  it('keeps the first alternative on ties and skips empties', () => {
    expect(pickBestAlternative([{ transcript: 'hello there' }, { transcript: 'hello where' }])?.transcript).toBe('hello there');
    expect(pickBestAlternative([{ transcript: '  ' }])).toBeUndefined();
    expect(scoreAviationPlausibility('niner alpha')).toBeGreaterThan(scoreAviationPlausibility('banana'));
  });
});

describe('pcm helpers', () => {
  it('converts float to int16 with clipping', () => {
    const out = floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });
  it('downsamples 48 kHz to 16 kHz across chunk boundaries', () => {
    const r = createResampler(48000, 16000);
    const input = new Float32Array(4800).fill(0.5);
    const a = r.process(input.subarray(0, 1001));
    const b = r.process(input.subarray(1001));
    expect(a.length + b.length).toBe(1600);
    expect(Array.from(a).every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });
  it('passes through at 16 kHz', () => {
    const f = Float32Array.from([0.1, 0.2]);
    expect(createResampler(16000).process(f)).toBe(f);
  });
});

describe('deepgram', () => {
  it('builds the streaming URL with required params and keyterms', () => {
    const u = new URL(buildDeepgramListenUrl('nova-3'));
    expect(u.origin + u.pathname).toBe('wss://api.deepgram.com/v1/listen');
    expect(u.searchParams.get('model')).toBe('nova-3');
    expect(u.searchParams.get('language')).toBe('en-US');
    expect(u.searchParams.get('smart_format')).toBe('false');
    expect(u.searchParams.get('interim_results')).toBe('true');
    expect(u.searchParams.get('endpointing')).toBe('300');
    expect(u.searchParams.get('encoding')).toBe('linear16');
    expect(u.searchParams.get('sample_rate')).toBe('16000');
    const terms = u.searchParams.getAll('keyterm');
    for (const w of ['Spirit', 'JetBlue', 'niner', 'tree', 'fife', 'runway', 'zulu']) expect(terms).toContain(w);
  });
  it('uses boosted keywords (not keyterm) for nova-2', () => {
    const u = new URL(buildDeepgramListenUrl('nova-2'));
    expect(u.searchParams.getAll('keyterm')).toHaveLength(0);
    expect(u.searchParams.getAll('keywords')).toContain('niner:2');
  });

  class FakeWS {
    static instances: FakeWS[] = [];
    static failFirst = 0;
    binaryType = '';
    readyState = 0;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onclose: ((e: { code?: number }) => void) | null = null;
    sent: unknown[] = [];
    url: string;
    protocols?: string | string[];
    constructor(url: string, protocols?: string | string[]) {
      this.url = url;
      this.protocols = protocols;
      FakeWS.instances.push(this);
      const fail = FakeWS.instances.length <= FakeWS.failFirst;
      queueMicrotask(() => (fail ? this.onclose?.({ code: 1006 }) : this.onopen?.({})));
    }
    send(d: unknown) {
      this.sent.push(d);
      if (typeof d === 'string' && d.includes('CloseStream')) queueMicrotask(() => this.onclose?.({ code: 1000 }));
    }
    close() {}
  }

  it('streams, accumulates finals and uses the token subprotocol', async () => {
    FakeWS.instances = [];
    FakeWS.failFirst = 0;
    let onChunk: (b: ArrayBuffer) => void = () => undefined;
    const stopCapture = vi.fn(async () => undefined);
    const provider = createDeepgramProvider({
      fetchFn: (async () => new Response(JSON.stringify({ access_token: 'jwt123', expires_in: 60 }), { status: 200 })) as typeof fetch,
      WebSocketCtor: FakeWS as never,
      getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
      startCapture: async (_s, cb) => {
        onChunk = cb;
        return { stop: stopCapture, inputSampleRate: 16000 };
      },
    });
    const partials: string[] = [];
    const finals: Array<[string, number | undefined]> = [];
    const errors: Error[] = [];
    await provider.start({
      onPartial: (t) => partials.push(t),
      onFinal: (t, m) => finals.push([t, m.confidence]),
      onError: (e) => errors.push(e),
    });
    const ws = FakeWS.instances[0];
    expect(ws.protocols).toEqual(['token', 'jwt123']);
    expect(ws.url).toContain('model=nova-3');
    onChunk(new ArrayBuffer(8));
    expect(ws.sent[0]).toBeInstanceOf(ArrayBuffer);
    const msg = (transcript: string, is_final: boolean, confidence = 0.9) =>
      ({ data: JSON.stringify({ type: 'Results', is_final, channel: { alternatives: [{ transcript, confidence }] } }) });
    ws.onmessage?.(msg('spirit one two', false));
    ws.onmessage?.(msg('spirit one two three', true, 0.8));
    ws.onmessage?.(msg('taxi', false));
    expect(partials.at(-1)).toBe('spirit one two three taxi');
    ws.onmessage?.(msg('taxi to runway one three', true, 1));
    await provider.stop();
    expect(stopCapture).toHaveBeenCalled();
    expect(finals).toEqual([['spirit one two three taxi to runway one three', 0.9]]);
    expect(errors).toEqual([]);
  });

  it('falls back to the bearer subprotocol when the token one is rejected', async () => {
    FakeWS.instances = [];
    FakeWS.failFirst = 1;
    const provider = createDeepgramProvider({
      fetchFn: (async () => new Response(JSON.stringify({ access_token: 'jwt' }), { status: 200 })) as typeof fetch,
      WebSocketCtor: FakeWS as never,
      getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
      startCapture: async () => ({ stop: async () => undefined, inputSampleRate: 16000 }),
    });
    await provider.start({ onPartial() {}, onFinal() {}, onError() {} });
    expect(FakeWS.instances.map((w) => w.protocols?.[0])).toEqual(['token', 'bearer']);
    await provider.stop();
  });

  it('reports an unconfigured server (503) as unavailable and releases the mic', async () => {
    const stopCapture = vi.fn(async () => undefined);
    const provider = createDeepgramProvider({
      fetchFn: (async () => new Response(JSON.stringify({ error: 'Deepgram is not configured' }), { status: 503 })) as typeof fetch,
      WebSocketCtor: FakeWS as never,
      getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
      startCapture: async () => ({ stop: stopCapture, inputSampleRate: 16000 }),
    });
    const err = await provider.start({ onPartial() {}, onFinal() {}, onError() {} }).catch((e: unknown) => e);
    expect(sttErrorCode(err)).toBe('unavailable');
    expect(stopCapture).toHaveBeenCalled();
  });

  it('maps a denied microphone to not_allowed', async () => {
    const provider = createDeepgramProvider({
      WebSocketCtor: FakeWS as never,
      getUserMedia: async () => {
        throw Object.assign(new Error('x'), { name: 'NotAllowedError' });
      },
    });
    const err = await provider.start({ onPartial() {}, onFinal() {}, onError() {} }).catch((e: unknown) => e);
    expect(sttErrorCode(err)).toBe('not_allowed');
  });

  it('isAvailable reflects server configuration', async () => {
    const mk = (configured: boolean) =>
      createDeepgramProvider({
        fetchFn: (async () => new Response(JSON.stringify({ configured }), { status: 200 })) as typeof fetch,
        WebSocketCtor: FakeWS as never,
        getUserMedia: async () => ({}) as MediaStream,
      });
    expect(await mk(true).isAvailable()).toBe(true);
    expect(await mk(false).isAvailable()).toBe(false);
  });
});

describe('track-processor capture (no AudioContext, so no dependence on an audio output device)', () => {
  /** 48 kHz stereo AudioData-like frames of 480 samples (10 ms) with a constant value per channel. */
  const frame = (l: number, r: number) => ({
    numberOfFrames: 480, numberOfChannels: 2, sampleRate: 48000,
    copyTo(dest: Float32Array, o: { planeIndex: number }) { dest.fill(o.planeIndex === 0 ? l : r); },
    close: vi.fn(),
  });
  function stubProcessor(frames: Array<ReturnType<typeof frame>>) {
    class FakeProcessor {
      readable: ReadableStream<unknown>;
      constructor(_init: { track: unknown }) {
        let i = 0;
        this.readable = new ReadableStream({ pull(c) { if (i < frames.length) c.enqueue(frames[i++]); else c.close(); } });
      }
    }
    vi.stubGlobal('MediaStreamTrackProcessor', FakeProcessor);
  }
  const fakeStream = () => {
    const stop = vi.fn();
    return { stop, stream: { getAudioTracks: () => [{ getSettings: () => ({ sampleRate: 48000 }) }], getTracks: () => [{ stop }] } as unknown as MediaStream };
  };

  it('is detected, downmixes to mono, resamples 48 kHz to 16 kHz and delivers 100 ms Int16 chunks', async () => {
    const frames = Array.from({ length: 30 }, () => frame(0.5, -0.1)); // 300 ms
    stubProcessor(frames);
    try {
      expect(hasTrackProcessor()).toBe(true);
      const chunks: ArrayBuffer[] = [];
      const { stream, stop } = fakeStream();
      const cap = await startPcmCapture(stream, (c) => chunks.push(c));
      await new Promise((r) => setTimeout(r, 20));
      await cap.stop();
      const samples = chunks.flatMap((c) => Array.from(new Int16Array(c)));
      expect(samples.length).toBeGreaterThanOrEqual(4700); // about 0.3 s * 16000, minus resampler tail
      expect(samples.length).toBeLessThanOrEqual(4800);
      expect(chunks[0].byteLength).toBe(3200); // 1600 samples
      expect(Math.abs(samples[100] - Math.round(0.2 * 32767))).toBeLessThanOrEqual(2); // (0.5 + -0.1) / 2
      expect(stop).toHaveBeenCalled(); // microphone released
      expect(frames.every((f) => f.close.mock.calls.length === 1)).toBe(true); // every AudioData closed
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back (returns null path) when the stream has no audio track', async () => {
    stubProcessor([]);
    try {
      const noTrack = { getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
      // No AudioContext in node either, so the fallback path rejects with the Web Audio error rather than hanging.
      await expect(startPcmCapture(noTrack, () => undefined)).rejects.toThrow(/Web Audio/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('deepgram socket base override', () => {
  it('defaults to wss://api.deepgram.com', () => {
    expect(resolveDeepgramWsBase({ env: undefined, stored: null })).toBe(DEEPGRAM_WS_BASE);
    expect(resolveDeepgramWsBase({ env: ' ', stored: '' })).toBe('wss://api.deepgram.com');
  });
  it('VITE_DEEPGRAM_WS_BASE may point at any ws(s) URL; junk and other schemes are ignored', () => {
    expect(resolveDeepgramWsBase({ env: 'wss://proxy.example.test/dg/', stored: null })).toBe('wss://proxy.example.test/dg');
    expect(resolveDeepgramWsBase({ env: 'https://api.deepgram.com', stored: null })).toBe(DEEPGRAM_WS_BASE);
    expect(resolveDeepgramWsBase({ env: 'not a url', stored: null })).toBe(DEEPGRAM_WS_BASE);
  });
  it('the runtime (localStorage) override is honoured only for ws://localhost or ws://127.0.0.1', () => {
    expect(resolveDeepgramWsBase({ env: undefined, stored: 'ws://127.0.0.1:8799' })).toBe('ws://127.0.0.1:8799');
    expect(resolveDeepgramWsBase({ env: undefined, stored: 'ws://localhost:9' })).toBe('ws://localhost:9');
    // a remote host (or wss to a remote host) in storage must never receive microphone audio
    expect(resolveDeepgramWsBase({ env: undefined, stored: 'ws://evil.example:80' })).toBe(DEEPGRAM_WS_BASE);
    expect(resolveDeepgramWsBase({ env: undefined, stored: 'wss://evil.example' })).toBe(DEEPGRAM_WS_BASE);
  });
  it('the provider opens the socket on the overridden base with the token subprotocol', async () => {
    const urls: string[] = [];
    const protocols: unknown[] = [];
    class WS {
      static OPEN = 1;
      binaryType = ''; readyState = 1;
      onopen: ((e: unknown) => void) | null = null; onmessage = null; onerror = null; onclose = null;
      constructor(url: string, p?: string | string[]) { urls.push(url); protocols.push(p); queueMicrotask(() => this.onopen?.({})); }
      send() {} close() {}
    }
    const provider = createDeepgramProvider({
      wsBase: 'ws://127.0.0.1:8799', WebSocketCtor: WS as never,
      fetchFn: (async () => new Response(JSON.stringify({ access_token: 'jwt-1' }), { status: 200 })) as typeof fetch,
      getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
      startCapture: async () => ({ stop: async () => undefined, inputSampleRate: 16000 }),
      warmUpAudio: async () => { throw new Error('none'); },
    });
    await provider.start({ onPartial() {}, onFinal() {}, onError() {} });
    expect(urls[0]).toMatch(/^ws:\/\/127\.0\.0\.1:8799\/v1\/listen\?model=nova-3&/);
    expect(protocols[0]).toEqual([expect.stringMatching(/^(token|bearer)$/), 'jwt-1']);
    await provider.stop();
  });
});

describe('web speech provider', () => {
  it('maps error codes to readable messages', () => {
    expect(sttErrorCode(describeWebSpeechError('not-allowed'))).toBe('not_allowed');
    expect(sttErrorCode(describeWebSpeechError('audio-capture'))).toBe('no_microphone');
    expect(sttErrorCode(describeWebSpeechError('no-speech'))).toBe('no_speech');
    const net = describeWebSpeechError('network');
    expect(sttErrorCode(net)).toBe('network');
    expect(net.message).toMatch(/Google/);
  });

  class FakeRec {
    static last: FakeRec;
    continuous = true;
    interimResults = false;
    lang = '';
    maxAlternatives = 1;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onresult: ((e: unknown) => void) | null = null;
    starts = 0;
    constructor() {
      FakeRec.last = this;
    }
    start() {
      this.starts++;
      queueMicrotask(() => this.onstart?.());
    }
    stop() {
      queueMicrotask(() => this.onend?.());
    }
    abort() {}
  }
  const result = (isFinal: boolean, alts: Array<[string, number]>) => {
    const r: Record<number, { transcript: string; confidence: number }> & { isFinal: boolean; length: number } = { isFinal, length: alts.length };
    alts.forEach(([transcript, confidence], i) => (r[i] = { transcript, confidence }));
    return r;
  };

  it('configures recognition, picks the best alternative and restarts across pauses', async () => {
    const provider = createWebSpeechProvider({ ctor: FakeRec as never });
    const partials: string[] = [];
    const finals: string[] = [];
    await provider.start({ onPartial: (t) => partials.push(t), onFinal: (t) => finals.push(t), onError: () => undefined });
    const rec = FakeRec.last;
    expect(rec.continuous).toBe(true); // keeps listening through pauses in a call
    expect(rec.interimResults).toBe(true);
    expect(rec.lang).toBe('en-US');
    expect(rec.maxAlternatives).toBe(3);

    rec.onresult?.({ resultIndex: 0, results: { length: 1, 0: result(true, [['spirit wine two', 0.9], ['spirit one two taxi runway one three', 0.6]]) } });
    expect(partials.at(-1)).toBe('spirit one two taxi runway one three');
    rec.onend?.(); // Chrome ended the session while the key is still held -> restart
    await Promise.resolve();
    expect(rec.starts).toBe(2);
    rec.onresult?.({ resultIndex: 0, results: { length: 1, 0: result(false, [['hold short', 0.5]]) } });
    await provider.stop();
    expect(finals).toEqual(['spirit one two taxi runway one three hold short']);
  });

  it('reports no_speech when nothing was heard at stop', async () => {
    const provider = createWebSpeechProvider({ ctor: FakeRec as never });
    const errors: Error[] = [];
    await provider.start({ onPartial() {}, onFinal() {}, onError: (e) => errors.push(e) });
    await provider.stop();
    expect(errors.map(sttErrorCode)).toEqual(['no_speech']);
  });

  it('rebuilds the transcript from ALL results, so earlier not-yet-final segments are not lost (real Chrome keeps several)', async () => {
    const provider = createWebSpeechProvider({ ctor: FakeRec as never });
    const partials: string[] = [];
    const finals: Array<[string, number | undefined]> = [];
    await provider.start({ onPartial: (t) => partials.push(t), onFinal: (t, m) => finals.push([t, m.confidence]), onError: () => undefined });
    const rec = FakeRec.last;
    // Event 2 reports resultIndex 1, but result 0 is still alive and non-final: it must stay in the text.
    rec.onresult?.({ resultIndex: 0, results: { length: 1, 0: result(false, [['Cessna 723 Echo Juliet', 0.01]]) } });
    rec.onresult?.({ resultIndex: 1, results: { length: 2, 0: result(false, [['Cessna 723 Echo Juliet runway 13', 0.9]]), 1: result(false, [['clear', 0.01]]) } });
    expect(partials.at(-1)).toBe('Cessna 723 Echo Juliet runway 13 clear');
    rec.onresult?.({ resultIndex: 1, results: { length: 2, 0: result(true, [['Cessna 723 Echo Juliet runway 13', 0.9]]), 1: result(true, [['cleared for takeoff', 0.95]]) } });
    await provider.stop();
    expect(finals).toEqual([['Cessna 723 Echo Juliet runway 13 cleared for takeoff', 0.925]]);
  });

  it('survives Chrome replacing its whole result list with only the last final chunk (observed with Google\'s service)', async () => {
    const provider = createWebSpeechProvider({ ctor: FakeRec as never });
    const finals: string[] = [];
    await provider.start({ onPartial() {}, onFinal: (t) => finals.push(t), onError: () => undefined });
    const rec = FakeRec.last;
    const ev = (...segs: Array<[boolean, string]>) => rec.onresult?.({ resultIndex: 0, results: { length: segs.length, ...Object.fromEntries(segs.map(([f, t], i) => [i, result(f, [[t, 0.9]])])) } });
    ev([false, 'Cessna 723 Echo']);
    ev([false, 'Cessna 723 Echo Juliet Runway 13']);
    ev([false, 'Cessna 723 Echo Juliet Runway 13'], [false, ' clear']);
    ev([false, 'Cessna 723 Echo Juliet Runway 13 cleared for'], [false, ' takeoff']);
    ev([true, 'cleared for takeoff']); // the whole list collapsed to the final chunk
    await provider.stop();
    expect(finals).toEqual(['Cessna 723 Echo Juliet Runway 13 cleared for takeoff']);
  });

  it('a short hypothesis that is revised (sesame -> Cessna 723) is not kept as extra text', async () => {
    const provider = createWebSpeechProvider({ ctor: FakeRec as never });
    const finals: string[] = [];
    await provider.start({ onPartial() {}, onFinal: (t) => finals.push(t), onError: () => undefined });
    const ev = (f: boolean, t: string) => FakeRec.last.onresult?.({ resultIndex: 0, results: { length: 1, 0: result(f, [[t, 0.9]]) } });
    ev(false, 'sesame');
    ev(false, 'Cessna 723 Echo');
    ev(true, 'Cessna 723 Echo Juliet hold position');
    await provider.stop();
    expect(finals).toEqual(['Cessna 723 Echo Juliet hold position']);
  });

  it('transcript helpers', () => {
    expect(appendTranscript('a b c', 'c d')).toBe('a b c d');
    expect(appendTranscript('runway 13', 'cleared for takeoff')).toBe('runway 13 cleared for takeoff');
    expect(appendTranscript('', 'x y')).toBe('x y');
    expect(appendTranscript('Cleared for', 'cleared FOR takeoff')).toBe('Cleared for takeoff');
    expect(sameStart('Cessna 723', 'cessna 723 echo')).toBe(true);
    expect(sameStart('Cessna 723 echo', 'cleared for takeoff')).toBe(false);
    expect(sameStart('cess', 'Cessna 723')).toBe(true);
  });

  it('continuous can be switched off by option or localStorage', async () => {
    const mk = async (opts: object) => {
      const provider = createWebSpeechProvider({ ctor: FakeRec as never, ...opts });
      await provider.start({ onPartial() {}, onFinal() {}, onError() {} });
      await provider.stop();
      return FakeRec.last.continuous;
    };
    expect(await mk({})).toBe(true);
    expect(await mk({ continuous: false })).toBe(false);
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'kacy.webspeech.continuous' ? '0' : null) });
    try {
      expect(await mk({})).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('track audio source: opens the mic with getUserMedia, hands the track to start(track), releases it afterwards', async () => {
    const stopped = vi.fn();
    const track = { kind: 'audio' } as MediaStreamTrack;
    const stream = { getAudioTracks: () => [track], getTracks: () => [{ stop: stopped }] } as unknown as MediaStream;
    class TrackRec extends FakeRec {
      got: unknown[] = [];
      override start(t?: MediaStreamTrack) { this.got.push(t); super.start(); }
    }
    const provider = createWebSpeechProvider({ ctor: TrackRec as never, audioSource: 'track', getUserMedia: async () => stream });
    await provider.start({ onPartial() {}, onFinal() {}, onError() {} });
    expect((FakeRec.last as TrackRec).got).toEqual([track]);
    await provider.stop();
    expect(stopped).toHaveBeenCalled();
  });

  it('track audio source falls back to Chrome\'s own capture when start(track) is not supported', async () => {
    const stream = { getAudioTracks: () => [{}], getTracks: () => [{ stop() {} }] } as unknown as MediaStream;
    let calls = 0;
    class OldRec extends FakeRec {
      override start(t?: MediaStreamTrack) { if (t && calls++ === 0) throw new TypeError('too many arguments'); super.start(); }
    }
    const provider = createWebSpeechProvider({ ctor: OldRec as never, audioSource: 'track', getUserMedia: async () => stream });
    await provider.start({ onPartial() {}, onFinal() {}, onError() {} });
    expect((FakeRec.last as OldRec).starts).toBe(1);
  });

  it('does not hang when the browser exposes SpeechRecognition but never starts it (headless Chromium)', async () => {
    class SilentRec extends FakeRec {
      aborted = false;
      override start() { /* never fires onstart or onerror */ }
      override abort() { this.aborted = true; }
    }
    const provider = createWebSpeechProvider({ ctor: SilentRec as never, startTimeoutMs: 20 });
    const err = await provider.start({ onPartial() {}, onFinal() {}, onError() {} }).catch((e: unknown) => e);
    expect(sttErrorCode(err)).toBe('unsupported');
    expect((err as Error).message).toMatch(/did not start/);
    expect((SilentRec.last as SilentRec).aborted).toBe(true);
    await provider.stop(); // no session left: must be a harmless no-op
  });

  it('reports unsupported without an implementation', async () => {
    const provider = createWebSpeechProvider({ ctor: undefined });
    // jsdom has no SpeechRecognition either
    expect(await provider.isAvailable()).toBe(false);
    const err = await provider.start({ onPartial() {}, onFinal() {}, onError() {} }).catch((e: unknown) => e);
    expect(sttErrorCode(err)).toBe('unsupported');
  });
});
