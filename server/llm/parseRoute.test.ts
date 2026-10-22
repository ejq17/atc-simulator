import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createLlmParseHandler, isLlmConfigured, validateRequest } from './parseRoute';
import { LLM_RESPONSE_SCHEMA, SYSTEM_PROMPT } from './prompt';

const aircraft = [
  { callsign: 'NKS451', spokenCallsign: 'Spirit four fifty one', type: 'A320' },
  { callsign: 'N6004T', spokenCallsign: 'Cessna six zero zero four tango', type: 'C172' },
];
const goodBody = { text: 'cessna cross runway one three behind the spirit', context: { aircraft, runwayEnds: ['13', '31'], taxiways: ['A', 'B'] } };

function mkReq(method: string, body?: unknown): IncomingMessage {
  const r = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]) as unknown as IncomingMessage;
  r.method = method;
  return r;
}
function mkRes() {
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    statusCode: 0, body: '', writableEnded: false,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
    end(b: string) { res.body = b; res.writableEnded = true; },
  });
  return { res: res as unknown as ServerResponse & { body: string }, headers, json: () => JSON.parse(res.body) };
}

const wire = (kind: string, callsign: string, ...fields: [string, string][]) => ({ kind, callsign, fields: fields.map(([name, value]) => ({ name, value })) });
const okMessage = (commands: unknown[], note: string | null = null, extra: Record<string, unknown> = {}) => ({
  parsed_output: { commands, note }, stop_reason: 'end_turn',
  usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }, ...extra,
});
const withClient = (parse: (p: any) => unknown, extra: Record<string, unknown> = {}) =>
  createLlmParseHandler({ client: { messages: { parse: async (p: any) => parse(p) } }, env: {}, log: () => {}, ...extra });

async function run(handler: ReturnType<typeof createLlmParseHandler>, method: string, body?: unknown) {
  const out = mkRes();
  await handler(mkReq(method, body), out.res);
  return { status: out.res.statusCode, headers: out.headers, json: out.json };
}

describe('validateRequest', () => {
  it('accepts a good body and rejects bad ones', () => {
    expect(typeof validateRequest(goodBody)).toBe('object');
    for (const bad of [null, [], { text: '', context: { aircraft: [] } }, { text: '   ', context: { aircraft: [] } }, { text: 5, context: { aircraft: [] } },
      { text: 'x'.repeat(401), context: { aircraft: [] } }, { text: 'hi' }, { text: 'hi', context: {} }, { text: 'hi', context: { aircraft: 'x' } },
      { text: 'hi', context: { aircraft: [{ type: 'C172' }] } }]) {
      expect(typeof validateRequest(bad)).toBe('string');
    }
    expect(typeof validateRequest({ text: 'x'.repeat(400), context: { aircraft: [] } })).toBe('object');
  });
});

describe('createLlmParseHandler', () => {
  it('aborts the upstream request when the browser disconnects, and writes nothing', async () => {
    let signal: AbortSignal | undefined;
    const handler = createLlmParseHandler({
      client: {
        messages: {
          parse: (_p: unknown, opts?: { signal?: AbortSignal }) => new Promise((_, reject) => {
            signal = opts?.signal;
            signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
          }),
        },
      },
      env: {}, log: () => { throw new Error('an aborted request must not be logged as an upstream failure'); },
    });
    const out = mkRes();
    const done = handler(mkReq('POST', goodBody), out.res);
    await new Promise((r) => setTimeout(r, 10));
    expect(signal?.aborted).toBe(false);
    out.res.emit('close');
    await done;
    expect(signal?.aborted).toBe(true);
    expect(out.res.body).toBe('');
  });

  it('does not abort a request whose response was already sent', async () => {
    let signal: AbortSignal | undefined;
    const out = mkRes();
    const handler = createLlmParseHandler({ client: { messages: { parse: async (_p: unknown, opts?: { signal?: AbortSignal }) => { signal = opts?.signal; return okMessage([]); } } }, env: {}, log: () => {} });
    await handler(mkReq('POST', goodBody), out.res);
    out.res.emit('close'); // normal end of the connection after the response
    expect(signal?.aborted).toBe(false);
    expect(out.res.statusCode).toBe(200);
  });

  it('405 for other methods', async () => {
    const r = await run(withClient(() => okMessage([])), 'GET');
    expect(r.status).toBe(405);
    expect(r.json().error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('503 without a key and no client; isLlmConfigured follows the key', async () => {
    const r = await run(createLlmParseHandler({ env: {}, log: () => {} }), 'POST', goodBody);
    expect(r.status).toBe(503);
    expect(r.json().error.code).toBe('LLM_NOT_CONFIGURED');
    expect(isLlmConfigured({})).toBe(false);
    expect(isLlmConfigured({ ANTHROPIC_API_KEY: '  ' })).toBe(false);
    expect(isLlmConfigured({ ANTHROPIC_API_KEY: 'k' })).toBe(true);
  });

  it('400 INVALID_BODY for bad JSON and bad shapes', async () => {
    const h = withClient(() => okMessage([]));
    for (const body of ['{nope', { text: '', context: { aircraft: [] } }, { text: 'x'.repeat(401), context: { aircraft: [] } }, { text: 'hi', context: {} }]) {
      const r = await run(h, 'POST', body);
      expect(r.status).toBe(400);
      expect(r.json().error.code).toBe('INVALID_BODY');
    }
  });

  it('sends the documented request shape to the client', async () => {
    const parse = vi.fn(() => okMessage([]));
    await run(withClient(parse, { model: 'claude-haiku-5-5', effort: 'medium' }), 'POST', {
      ...goodBody,
      grammar: { commands: [{ kind: 'CROSS_RUNWAY', callsign: null, confidence: 0.3, issues: ['callsign not recognised'] }] },
    });
    const p = parse.mock.calls[0] as unknown as [any];
    const params = p[0];
    expect(params.model).toBe('claude-haiku-5-5');
    expect(params.max_tokens).toBe(4096);
    expect(params.thinking).toBeUndefined();
    expect(params.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    expect(params.output_config.effort).toBe('medium');
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.output_config.format.schema).toBe(LLM_RESPONSE_SCHEMA);
    expect(typeof params.output_config.format.parse).toBe('function');
    expect(params.messages).toHaveLength(1);
    const text: string = params.messages[0].content;
    expect(params.messages[0].role).toBe('user');
    for (const s of ['NKS451', 'Spirit four fifty one', 'N6004T', 'C172', '13, 31', 'TAXIWAYS: A, B', 'CROSS_RUNWAY', 'TRANSMISSION: "cessna cross runway one three behind the spirit"']) {
      expect(text).toContain(s);
    }
    expect(text.indexOf('GRAMMAR GUESS')).toBeLessThan(text.indexOf('TRANSMISSION'));
  });

  it('defaults to claude-opus-5-5 at low effort and honours env', async () => {
    const parse = vi.fn(() => okMessage([]));
    await run(withClient(parse), 'POST', goodBody);
    expect((parse.mock.calls[0] as unknown as [any])[0]).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low' } });
    const parse2 = vi.fn(() => okMessage([]));
    await run(withClient(parse2, { env: { ATC_LLM_MODEL: 'claude-haiku-5-5', ATC_LLM_EFFORT: 'high' } }), 'POST', goodBody);
    expect((parse2.mock.calls[0] as unknown as [any])[0]).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'high' } });
  });

  it('maps the parsed output to LlmParseResponse and strips sentinels', async () => {
    const times = [1000, 1234];
    const lines: string[] = [];
    const h = withClient(() => okMessage([
      wire('CROSS_RUNWAY', 'N6004T', ['crossRunwayId', '13/31'], ['runwayEnd', '13'], ['behindCallsign', 'NKS451'], ['route', '']),
      wire('HEADING', 'NKS451', ['headingDeg', '270'], ['turnDirection', 'left'], ['traffic.position', 'final'], ['traffic.distanceNm', '2'], ['bogus', 'x']),
      wire('HOLD_AT_FIX', '', ['hold.fix', 'CARYL'], ['hold.asPublished', 'true'], ['holdShort', 'A, C']),
    ], 'one line'), { now: () => times.shift() ?? 0, log: (l: string) => lines.push(l) });
    const r = await run(h, 'POST', goodBody);
    expect(r.status).toBe(200);
    const body = r.json();
    expect(body.commands[0]).toEqual({ kind: 'CROSS_RUNWAY', callsign: 'N6004T', crossRunwayId: '13/31', runwayEnd: '13', behindCallsign: 'NKS451' });
    expect(body.commands[1]).toEqual({ kind: 'HEADING', callsign: 'NKS451', headingDeg: 270, turnDirection: 'left', traffic: { desc: '', position: 'final', distanceNm: 2 } });
    expect(body.commands[2]).toEqual({ kind: 'HOLD_AT_FIX', callsign: null, holdShort: ['A', 'C'], hold: { fix: 'CARYL', turns: 'right', asPublished: true } });
    expect(JSON.stringify(body.commands).replace('"callsign":null', '')).not.toContain('null'); // only callsign may be null
    expect(body).toMatchObject({ note: 'one line', model: 'claude-opus-5-5', latencyMs: 234 });
    expect(body.usage).toEqual({ inputTokens: 120, outputTokens: 40, cacheReadInputTokens: 900, cacheCreationInputTokens: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/model=claude-opus-5-5 latencyMs=234 in=120 out=40 cacheRead=900 commands=3/);
  });

  it('sends thinking disabled only for Haiku models with ATC_LLM_THINKING=off', async () => {
    const send = async (model: string, thinking?: string) => {
      const parse = vi.fn(() => okMessage([]));
      await run(withClient(parse, { model, thinking }), 'POST', goodBody);
      return (parse.mock.calls[0] as unknown as [any])[0];
    };
    expect((await send('claude-haiku-5-5', 'off')).thinking).toEqual({ type: 'disabled' });
    expect((await send('claude-opus-5-5', 'off')).thinking).toBeUndefined();
    expect((await send('claude-haiku-5-5')).thinking).toBeUndefined();
  });

  it('returns an empty command list with a note and omits an absent note', async () => {
    const a = await run(withClient(() => okMessage([], 'readback')), 'POST', goodBody);
    expect(a.json()).toMatchObject({ commands: [], note: 'readback' });
    const b = await run(withClient(() => okMessage([])), 'POST', goodBody);
    expect('note' in b.json()).toBe(false);
  });

  describe('error mapping', () => {
    const failing = (err: unknown) => withClient(() => { throw err; });
    it('429 with Retry-After', async () => {
      const r = await run(failing(new Anthropic.RateLimitError(429, {}, 'slow down', new Headers({ 'retry-after': '7' }))), 'POST', goodBody);
      expect(r.status).toBe(429);
      expect(r.headers['retry-after']).toBe('7');
      expect(r.json().error.code).toBe('UPSTREAM_RATE_LIMITED');
    });
    it('504 on timeout', async () => {
      const r = await run(failing(new Anthropic.APIConnectionTimeoutError()), 'POST', goodBody);
      expect(r.status).toBe(504);
      expect(r.json().error.code).toBe('UPSTREAM_TIMEOUT');
    });
    it('502 on other API errors without leaking the message', async () => {
      const r = await run(failing(new Anthropic.APIError(500, {}, 'secret detail', new Headers())), 'POST', goodBody);
      expect(r.status).toBe(502);
      expect(r.json().error.code).toBe('UPSTREAM_ERROR');
      expect(JSON.stringify(r.json())).not.toContain('secret detail');
    });
    it('502 LLM_REFUSED for null output, refusal and unparseable output', async () => {
      for (const h of [
        withClient(() => ({ parsed_output: null, stop_reason: 'end_turn', usage: {} })),
        withClient(() => okMessage([], null, { stop_reason: 'refusal' })),
        failing(new Anthropic.AnthropicError('Failed to parse structured output')),
      ]) {
        const r = await run(h, 'POST', goodBody);
        expect(r.status).toBe(502);
        expect(r.json().error.code).toBe('LLM_REFUSED');
      }
    });
  });
});
