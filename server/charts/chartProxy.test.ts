import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createChartProxy, isAllowedChartUrl } from './chartProxy';

const OK = 'https://aeronav.faa.gov/d-tpp/2610/00669AD.PDF';

describe('isAllowedChartUrl', () => {
  it('accepts official d-TPP PDF URLs (upper and lower case extension)', () => {
    expect(isAllowedChartUrl(OK)).toBe(true);
    expect(isAllowedChartUrl('https://aeronav.faa.gov/d-tpp/2610/NE2LAHSO.PDF')).toBe(true);
    expect(isAllowedChartUrl('https://aeronav.faa.gov/d-tpp/2611/00669ILD31.pdf')).toBe(true);
    expect(isAllowedChartUrl('https://aeronav.faa.gov/d-tpp/2610/00669_x.pdf')).toBe(true);
  });

  it('rejects everything else', () => {
    const bad: unknown[] = [
      undefined, null, 42, '',
      'http://aeronav.faa.gov/d-tpp/2610/00669AD.PDF', // not https
      'https://aeronav.faa.gov.evil.com/d-tpp/2610/00669AD.PDF',
      'https://evil.com/aeronav.faa.gov/d-tpp/2610/00669AD.PDF',
      'https://user@aeronav.faa.gov/d-tpp/2610/00669AD.PDF',
      'https://aeronav.faa.gov:8443/d-tpp/2610/00669AD.PDF',
      'https://aeronav.faa.gov/d-tpp/261/00669AD.PDF', // 3-digit cycle
      'https://aeronav.faa.gov/d-tpp/26100/00669AD.PDF',
      'https://aeronav.faa.gov/d-tpp/2610/../2611/00669AD.PDF',
      'https://aeronav.faa.gov/d-tpp/2610/sub/00669AD.PDF',
      'https://aeronav.faa.gov/d-tpp/2610/00669AD.PDF?x=1',
      'https://aeronav.faa.gov/d-tpp/2610/00669AD.PDF#frag',
      'https://aeronav.faa.gov/d-tpp/2610/00669AD.PDF\n',
      'https://aeronav.faa.gov/d-tpp/2610/00669AD.html',
      'https://aeronav.faa.gov/d-tpp/2610/.PDF',
      'https://aeronav.faa.gov/d-tpp/2610/00669 AD.PDF',
      'https://aeronav.faa.gov/other/2610/00669AD.PDF',
      'https://aeronav.faa.gov/d-tpp/2610/xml_data/d-TPP_Metafile.xml',
      'file:///etc/passwd',
    ];
    for (const u of bad) expect(isAllowedChartUrl(u), String(u)).toBe(false);
  });
});

const PDF = Buffer.from('%PDF-1.7\n' + 'x'.repeat(200));
const pdfResponse = (body: Buffer = PDF, status = 200) =>
  new Response(new Uint8Array(body), { status, headers: { 'content-type': 'application/pdf' } });

function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v),
    end(b?: unknown) {
      res.body = b;
    },
  };
  return { res: res as unknown as ServerResponse & { body: unknown }, headers };
}
const fakeReq = (url: string, method = 'GET') => Object.assign(new EventEmitter(), { url, method }) as unknown as IncomingMessage;
const q = (u: string) => `/api/charts/pdf?url=${encodeURIComponent(u)}`;

describe('chart proxy handler', () => {
  it('streams a PDF with the right headers and caches it', async () => {
    const fetchImpl = vi.fn(async () => pdfResponse());
    const proxy = createChartProxy({ fetchImpl });
    const a = fakeRes();
    await proxy.handle(fakeReq(q(OK)), a.res);
    expect(a.res.statusCode).toBe(200);
    expect(a.headers['content-type']).toBe('application/pdf');
    expect(a.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(a.headers['x-cache']).toBe('MISS');
    expect(Buffer.isBuffer(a.res.body)).toBe(true);
    const b = fakeRes();
    await proxy.handle(fakeReq(q(OK)), b.res);
    expect(b.headers['x-cache']).toBe('HIT');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]).toEqual([OK, expect.objectContaining({ redirect: 'manual' })]);
  });

  it('rejects disallowed URLs with 400 and never calls upstream', async () => {
    const fetchImpl = vi.fn(async () => pdfResponse());
    const proxy = createChartProxy({ fetchImpl });
    for (const bad of ['https://example.com/a.pdf', 'http://aeronav.faa.gov/d-tpp/2610/00669AD.PDF']) {
      const r = fakeRes();
      await proxy.handle(fakeReq(q(bad)), r.res);
      expect(r.res.statusCode).toBe(400);
    }
    const none = fakeRes();
    await proxy.handle(fakeReq('/api/charts/pdf'), none.res);
    expect(none.res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('405 for POST, 204 for OPTIONS', async () => {
    const proxy = createChartProxy({ fetchImpl: vi.fn() });
    const p = fakeRes();
    await proxy.handle(fakeReq(q(OK), 'POST'), p.res);
    expect(p.res.statusCode).toBe(405);
    const o = fakeRes();
    await proxy.handle(fakeReq(q(OK), 'OPTIONS'), o.res);
    expect(o.res.statusCode).toBe(204);
  });

  it('maps upstream failures to 404/502 and rejects non-PDF bodies and redirects', async () => {
    const run = async (resp: () => Response | Promise<Response>) => {
      const proxy = createChartProxy({ fetchImpl: async () => resp() });
      const r = fakeRes();
      await proxy.handle(fakeReq(q(OK)), r.res);
      return r.res.statusCode;
    };
    expect(await run(() => new Response('nope', { status: 404 }))).toBe(404);
    expect(await run(() => new Response('x', { status: 500 }))).toBe(502);
    expect(await run(() => new Response('', { status: 302, headers: { location: 'https://evil.com/x.pdf' } }))).toBe(502);
    expect(await run(() => new Response('<html>not a pdf</html>', { status: 200 }))).toBe(502);
    expect(await run(() => { throw new Error('ECONNREFUSED'); })).toBe(502);
  });

  it('times out slow upstreams with 504', async () => {
    const proxy = createChartProxy({
      timeoutMs: 20,
      fetchImpl: (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    });
    const r = fakeRes();
    await proxy.handle(fakeReq(q(OK)), r.res);
    expect(r.res.statusCode).toBe(504);
  });

  it('coalesces concurrent requests and enforces the cache cap (LRU)', async () => {
    const fetchImpl = vi.fn(async () => pdfResponse());
    const proxy = createChartProxy({ fetchImpl, maxCacheBytes: PDF.length * 2 + 10 });
    const urls = [1, 2, 3].map((i) => `https://aeronav.faa.gov/d-tpp/2610/F${i}.PDF`);
    await Promise.all([proxy.getPdf(urls[0]), proxy.getPdf(urls[0])]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await proxy.getPdf(urls[1]);
    await proxy.getPdf(urls[2]); // evicts urls[0]
    expect(proxy.stats().entries).toBe(2);
    expect(proxy.stats().bytes).toBeLessThanOrEqual(PDF.length * 2 + 10);
    await proxy.getPdf(urls[0]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('expires entries after the TTL', async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => pdfResponse());
    const proxy = createChartProxy({ fetchImpl, now: () => t, ttlMs: 1000 });
    await proxy.getPdf(OK);
    t = 500;
    expect((await proxy.getPdf(OK)).cache).toBe('HIT');
    t = 2000;
    expect((await proxy.getPdf(OK)).cache).toBe('MISS');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
