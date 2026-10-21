import { describe, expect, it, vi } from 'vitest';

import { CTX } from '../testkit';
import { checkLlmAvailability, createLlmParser, LlmParseError } from './client';
import type { LlmFetch } from './client';
import type { LlmParseResponse } from './contract';

const hosting = vi.hoisted(() => ({ isStatic: false }));
vi.mock('../../hosting', () => ({ isStaticHosting: () => hosting.isStatic }));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const REQ = { text: 'hello', context: CTX };
const OK: LlmParseResponse = { commands: [{ kind: 'GO_AROUND', callsign: 'N723EJ' }], model: 'm', latencyMs: 12 };

describe('createLlmParser', () => {
  it('POSTs the request as JSON to /api/llm/parse and returns the response', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetch: LlmFetch = async (url, init) => { seen = { url, init }; return json(200, OK); };
    const r = await createLlmParser({ fetch, apiBase: '' }).parse(REQ);
    expect(r).toEqual(OK);
    expect(seen?.url).toBe('/api/llm/parse');
    expect(seen?.init?.method).toBe('POST');
    expect(JSON.parse(seen?.init?.body as string).text).toBe('hello');
  });
  it('honours apiBase', async () => {
    let url = '';
    await createLlmParser({ fetch: async (u) => { url = u; return json(200, OK); }, apiBase: 'http://localhost:8787/' }).parse(REQ);
    expect(url).toBe('http://localhost:8787/api/llm/parse');
  });
  it('maps the error envelope to a typed error with the server code', async () => {
    const fetch: LlmFetch = async () => json(503, { error: { code: 'LLM_NOT_CONFIGURED', message: 'no key' } });
    const err = await createLlmParser({ fetch, apiBase: '' }).parse(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmParseError);
    expect(err).toMatchObject({ code: 'LLM_NOT_CONFIGURED', status: 503, message: 'no key' });
  });
  it('falls back to an HTTP code when the error body is not an envelope', async () => {
    const fetch: LlmFetch = async () => new Response('<html>', { status: 502 });
    await expect(createLlmParser({ fetch, apiBase: '' }).parse(REQ)).rejects.toMatchObject({ code: 'HTTP_502' });
  });
  it('reports NETWORK when fetch rejects', async () => {
    const fetch: LlmFetch = async () => { throw new TypeError('Failed to fetch'); };
    await expect(createLlmParser({ fetch, apiBase: '' }).parse(REQ)).rejects.toMatchObject({ code: 'NETWORK' });
  });
  it('reports BAD_RESPONSE for a 200 without commands', async () => {
    const fetch: LlmFetch = async () => json(200, { nope: true });
    await expect(createLlmParser({ fetch, apiBase: '' }).parse(REQ)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
  it('aborts and reports TIMEOUT when the server is too slow', async () => {
    const fetch: LlmFetch = (_u, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    });
    await expect(createLlmParser({ fetch, apiBase: '', timeoutMs: 20 }).parse(REQ)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('checkLlmAvailability', () => {
  it('is unavailable on the static hosted site without calling the network', async () => {
    hosting.isStatic = true;
    let called = false;
    const a = await checkLlmAvailability(async () => { called = true; return json(200, {}); }, '');
    expect(called).toBe(false);
    expect(a.available).toBe(false);
    expect(a.detail).toMatch(/hosted site/);
    hosting.isStatic = false;
  });
  it('is available with the model name when the backend reports a configured key', async () => {
    const a = await checkLlmAvailability(async () => json(200, { ok: true, llmConfigured: true, llmModel: 'claude-x' }), '');
    expect(a).toMatchObject({ available: true, model: 'claude-x' });
    expect(a.detail).toContain('claude-x');
  });
  it('explains what is missing when no key is configured', async () => {
    const a = await checkLlmAvailability(async () => json(200, { ok: true, llmConfigured: false }), '');
    expect(a.available).toBe(false);
    expect(a.detail).toMatch(/npm run server.*ANTHROPIC_API_KEY/);
  });
  it('is unavailable when the backend is unreachable', async () => {
    const a = await checkLlmAvailability(async () => { throw new Error('down'); }, '');
    expect(a).toMatchObject({ available: false });
    expect(a.detail).toMatch(/not reachable/);
  });
});
