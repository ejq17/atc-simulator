import { describe, expect, it, vi } from 'vitest';
import { pickBestAlternative, scoreAviationPlausibility } from './aviationVocab.ts';
import { buildDeepgramListenUrl, createDeepgramProvider } from './deepgramProvider.ts';
import { createResampler, floatToInt16 } from './pcmCapture.ts';
import { createWebSpeechProvider, describeWebSpeechError } from './webSpeechProvider.ts';
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
    expect(rec.continuous).toBe(false);
    expect(rec.interimResults).toBe(true);
    expect(rec.lang).toBe('en-US');
    expect(rec.maxAlternatives).toBe(3);

    rec.onresult?.({ resultIndex: 0, results: { length: 1, 0: result(true, [['spirit wine two', 0.9], ['spirit one two taxi runway one three', 0.6]]) } });
    expect(partials.at(-1)).toBe('spirit one two taxi runway one three');
    rec.onend?.(); // Chrome ended on a pause while key still held -> restart
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
