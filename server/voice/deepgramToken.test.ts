import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEEPGRAM_GRANT_URL, handleDeepgramToken, resetDeepgramTokenRateLimit, resolveGrantUrl } from './deepgramToken.ts';

function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: '',
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    end(b: string) {
      res.body = b;
    },
  };
  return { res: res as unknown as ServerResponse & { body: string }, headers };
}
const req = (method: string) => ({ method }) as IncomingMessage;

describe('handleDeepgramToken', () => {
  beforeEach(() => resetDeepgramTokenRateLimit());

  it('returns 503 with a clear message when DEEPGRAM_API_KEY is unset', async () => {
    const { res } = fakeRes();
    await handleDeepgramToken(req('POST'), res, { env: {} });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toMatch(/DEEPGRAM_API_KEY/);
  });

  it('GET reports configuration without minting a token', async () => {
    const fetchFn = vi.fn();
    const a = fakeRes();
    await handleDeepgramToken(req('GET'), a.res, { env: { DEEPGRAM_API_KEY: 'k' }, fetchFn: fetchFn as never });
    expect(JSON.parse(a.res.body)).toEqual({ configured: true });
    const b = fakeRes();
    await handleDeepgramToken(req('GET'), b.res, { env: {} });
    expect(JSON.parse(b.res.body)).toEqual({ configured: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('mints a token via /v1/auth/grant and never leaks the key', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ access_token: 'jwt-abc', expires_in: 60 }), { status: 200 }));
    const { res, headers } = fakeRes();
    await handleDeepgramToken(req('POST'), res, { env: { DEEPGRAM_API_KEY: 'secret-key' }, fetchFn: fetchFn as never });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ access_token: 'jwt-abc', expires_in: 60 });
    expect(res.body).not.toContain('secret-key');
    expect(headers['cache-control']).toBe('no-store');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepgram.com/v1/auth/grant');
    expect((init.headers as Record<string, string>).Authorization).toBe('Token secret-key');
    expect(JSON.parse(init.body as string).ttl_seconds).toBeGreaterThan(0);
  });

  it('maps upstream failures to 502 without leaking details', async () => {
    const { res } = fakeRes();
    const fetchFn = async () => new Response('{"err_msg":"bad key secret-key"}', { status: 401 });
    await handleDeepgramToken(req('POST'), res, { env: { DEEPGRAM_API_KEY: 'secret-key' }, fetchFn: fetchFn as never });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('secret-key');
    expect(JSON.parse(res.body).error).toMatch(/Member/);
  });

  it('rejects other methods and rate-limits minting', async () => {
    const a = fakeRes();
    await handleDeepgramToken(req('DELETE'), a.res, { env: { DEEPGRAM_API_KEY: 'k' } });
    expect(a.res.statusCode).toBe(405);
    const fetchFn = async () => new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const r = fakeRes();
      await handleDeepgramToken(req('POST'), r.res, { env: { DEEPGRAM_API_KEY: 'k' }, fetchFn: fetchFn as never, now: () => 1000 });
      last = r.res.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('DEEPGRAM_API_BASE override', () => {
  beforeEach(() => resetDeepgramTokenRateLimit());

  it('defaults to api.deepgram.com and accepts absolute http(s) bases', () => {
    expect(resolveGrantUrl({})).toBe(DEEPGRAM_GRANT_URL);
    expect(resolveGrantUrl({ DEEPGRAM_API_BASE: ' ' })).toBe(DEEPGRAM_GRANT_URL);
    expect(resolveGrantUrl({ DEEPGRAM_API_BASE: 'http://127.0.0.1:8799' })).toBe('http://127.0.0.1:8799/v1/auth/grant');
    expect(resolveGrantUrl({ DEEPGRAM_API_BASE: 'https://proxy.example.test/dg/' })).toBe('https://proxy.example.test/dg/v1/auth/grant');
  });

  it('rejects relative URLs and other schemes', () => {
    for (const bad of ['api.deepgram.com', '/v1', 'ftp://x', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(resolveGrantUrl({ DEEPGRAM_API_BASE: bad }), bad).toBeUndefined();
    }
  });

  it('POST calls the overridden grant URL, and a bad override is a clear 503 that never calls fetch', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ access_token: 'mock-jwt', expires_in: 60 }), { status: 200 }));
    const ok = fakeRes();
    await handleDeepgramToken(req('POST'), ok.res, { env: { DEEPGRAM_API_KEY: 'test-key', DEEPGRAM_API_BASE: 'http://127.0.0.1:8799' }, fetchFn: fetchFn as never });
    expect(ok.res.statusCode).toBe(200);
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe('http://127.0.0.1:8799/v1/auth/grant');

    fetchFn.mockClear();
    const bad = fakeRes();
    await handleDeepgramToken(req('POST'), bad.res, { env: { DEEPGRAM_API_KEY: 'k', DEEPGRAM_API_BASE: 'nope' }, fetchFn: fetchFn as never });
    expect(bad.res.statusCode).toBe(503);
    expect(JSON.parse(bad.res.body).error).toMatch(/DEEPGRAM_API_BASE/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
