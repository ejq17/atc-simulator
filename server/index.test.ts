import type { AddressInfo } from 'node:net';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAppServer, VITE_DEV_ORIGIN } from './index';
import { createAwcClient } from './weather/awc';

const KACY = { icaoId: 'KACY', rawOb: 'METAR KACY 170054Z 29017G23KT 10SM FEW018 BKN038 OVC049 21/17 A2983', fltCat: 'VFR' };
const TAF = { icaoId: 'KACY', rawTAF: 'TAF KACY 170145Z 1702/1724 28012G18KT P6SM -SHRA BKN040' };

const upstream = vi.fn(async (url: string) => {
  if (url.includes('/metar?')) return new Response(JSON.stringify(url.includes('KZZZ') ? [] : [KACY]), { status: 200 });
  if (url.includes('/taf?')) return new Response(JSON.stringify([TAF]), { status: 200 });
  return new Response('', { status: 404 });
});
const deepgram = vi.fn((_req: unknown, res: import('node:http').ServerResponse) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end('{"configured":false}');
});

const llm = vi.fn((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ routed: req.method }));
});

let server: Server;
let port: number;

beforeAll(async () => {
  server = createAppServer({ awc: createAwcClient({ fetch: upstream }), deepgram, llm });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

interface Resp { status: number; headers: IncomingHttpHeaders; body: string; json: () => any }
function call(method: string, path: string, headers: Record<string, string> = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('server routes', () => {
  it('GET /api/health', async () => {
    const r = await call('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, service: 'kacy-atc-sim-backend' });
    expect(r.headers['content-type']).toContain('application/json');
  });

  it('GET /api/health reports the phrase interpreter state without any key', async () => {
    const r = (await call('GET', '/api/health')).json();
    expect(typeof r.llmConfigured).toBe('boolean');
    expect(typeof r.llmModel).toBe('string');
    expect(JSON.stringify(r)).not.toMatch(/sk-ant/);
  });

  it('routes /api/llm/parse to the injected llm handler (any method) and allows POST in preflight', async () => {
    const a = await call('POST', '/api/llm/parse');
    expect(a.status).toBe(200);
    expect(a.json()).toEqual({ routed: 'POST' });
    const o = await call('OPTIONS', '/api/llm/parse', { Origin: VITE_DEV_ORIGIN });
    expect(o.status).toBe(204);
    expect(o.headers['access-control-allow-methods']).toContain('POST');
  });

  it('GET /api/weather/metar returns the AWC array, caches, and sets X-Cache', async () => {
    upstream.mockClear();
    const a = await call('GET', '/api/weather/metar?ids=KACY');
    expect(a.status).toBe(200);
    expect(a.json()).toEqual([KACY]);
    expect(a.headers['x-cache']).toBe('MISS');
    const b = await call('GET', '/api/weather/metar?ids=KACY');
    expect(b.headers['x-cache']).toBe('HIT');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][0]).toBe('https://aviationweather.gov/api/data/metar?ids=KACY&format=json');
  });

  it('concurrent requests share one upstream call', async () => {
    upstream.mockClear();
    const rs = await Promise.all(Array.from({ length: 10 }, () => call('GET', '/api/weather/taf?ids=KACY')));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(rs[0].json()).toEqual([TAF]);
  });

  it('GET /api/weather/taf', async () => {
    const r = await call('GET', '/api/weather/taf?ids=KACY');
    expect(r.status).toBe(200);
    expect(r.json()[0].rawTAF).toContain('TAF KACY');
  });

  it('unknown station returns an empty array (200)', async () => {
    const r = await call('GET', '/api/weather/metar?ids=KZZZ');
    expect(r.status).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it.each([
    '/api/weather/metar',
    '/api/weather/metar?ids=',
    '/api/weather/metar?ids=kacy',
    '/api/weather/metar?ids=KAC',
    '/api/weather/metar?ids=KACY%3Bls',
    '/api/weather/taf?ids=' + 'K'.repeat(41),
  ])('400 JSON error for invalid ids: %s', async (path) => {
    const r = await call('GET', path);
    expect(r.status).toBe(400);
    expect(r.json().error.code).toBe('INVALID_IDS');
    expect(typeof r.json().error.message).toBe('string');
  });

  it('upstream failure -> 502 JSON error', async () => {
    const bad = createAppServer({ awc: createAwcClient({ fetch: async () => new Response('', { status: 500 }) }) });
    await new Promise<void>((r) => bad.listen(0, '127.0.0.1', r));
    const p = (bad.address() as AddressInfo).port;
    const res = await new Promise<Resp>((resolve) => {
      request({ host: '127.0.0.1', port: p, path: '/api/weather/metar?ids=KACY' }, (rs) => {
        let body = '';
        rs.on('data', (c) => (body += c));
        rs.on('end', () => resolve({ status: rs.statusCode!, headers: rs.headers, body, json: () => JSON.parse(body) }));
      }).end();
    });
    expect(res.status).toBe(502);
    expect(res.json().error.code).toBe('UPSTREAM_ERROR');
    await new Promise((r) => bad.close(r));
  });

  it('delegates /api/voice/deepgram-token to the voice handler', async () => {
    deepgram.mockClear();
    const r = await call('GET', '/api/voice/deepgram-token');
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ configured: false });
    expect(deepgram).toHaveBeenCalledTimes(1);
    const p = await call('POST', '/api/voice/deepgram-token');
    expect(p.status).toBe(200);
    expect(deepgram).toHaveBeenCalledTimes(2);
  });

  it('404 JSON for unknown routes', async () => {
    const r = await call('GET', '/api/nope');
    expect(r.status).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
    expect((await call('GET', '/')).status).toBe(404);
  });

  it('405 for POST on weather routes', async () => {
    const r = await call('POST', '/api/weather/metar?ids=KACY');
    expect(r.status).toBe(405);
    expect(r.json().error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('rejects foreign Host headers (DNS rebinding guard)', async () => {
    const r = await call('GET', '/api/health', { Host: 'evil.example.com' });
    expect(r.status).toBe(403);
  });
});

describe('CORS', () => {
  it('allows only the Vite dev origin on every kind of response', async () => {
    expect(VITE_DEV_ORIGIN).toBe('http://localhost:5173');
    for (const path of ['/api/health', '/api/weather/metar?ids=KACY', '/api/weather/metar?ids=bad', '/nope']) {
      const r = await call('GET', path, { Origin: 'http://localhost:5173' });
      expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(r.headers['vary']).toContain('Origin');
    }
  });

  it('never reflects another origin or uses a wildcard', async () => {
    const r = await call('GET', '/api/health', { Origin: 'https://evil.example.com' });
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(r.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('answers preflight', async () => {
    const r = await call('OPTIONS', '/api/voice/deepgram-token', {
      Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST',
    });
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(r.headers['access-control-allow-methods']).toContain('POST');
  });
});
