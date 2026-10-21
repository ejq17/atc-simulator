/**
 * POST /api/llm/parse - the phrase interpreter (contract: src/commands/llm/contract.ts).
 *
 * Asks Claude to turn a transmission the rule grammar could not read into structured commands. Only the transmission text
 * and the aircraft / airport lists are sent to the API; nothing is stored. The API key stays in the backend environment.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { LLM_PARSE_TIMEOUT_MS, type LlmParseRequest, type LlmParseResponse, type LlmParseErrorCode } from '../../src/commands/llm/contract';
import { LLM_RESPONSE_SCHEMA, SYSTEM_PROMPT, parseWireResponse, toLlmCommand, type WireResponse } from './prompt';

export const DEFAULT_LLM_MODEL = 'claude-opus-5-5';
export const DEFAULT_LLM_EFFORT = 'low';
export const MAX_TEXT_CHARS = 400;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LIST = 200;

type Env = Record<string, string | undefined>;
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The part of the SDK client the route uses, so tests can inject a fake. */
export interface LlmClient {
  messages: { parse: (params: any, options?: any) => PromiseLike<any> };
}

export interface LlmParseDeps {
  /** Anthropic client or a `{ messages: { parse } }` fake. Default: built from ANTHROPIC_API_KEY on first use. */
  client?: LlmClient;
  model?: string;
  effort?: string;
  /** Millisecond clock (latency). */
  now?: () => number;
  env?: Env;
  log?: (line: string) => void;
}

export const isLlmConfigured = (env: Env = process.env): boolean => Boolean(env.ANTHROPIC_API_KEY?.trim());
export const llmModelName = (env: Env = process.env): string => env.ATC_LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;

function sendError(res: ServerResponse, status: number, code: LlmParseErrorCode, message: string, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify({ error: { code, message } }));
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_LIST) : []);

/** Validate the body; returns the request or an error message. Lists are sanitised to the fields the prompt uses. */
export function validateRequest(body: unknown): LlmParseRequest | string {
  if (!isObj(body)) return 'Body must be a JSON object.';
  const { text, context, grammar } = body;
  if (typeof text !== 'string' || text.trim() === '') return '`text` must be a non-empty string.';
  if (text.length > MAX_TEXT_CHARS) return `\`text\` is longer than ${MAX_TEXT_CHARS} characters.`;
  if (!isObj(context) || !Array.isArray(context.aircraft)) return '`context.aircraft` must be an array.';
  const aircraft = context.aircraft.slice(0, MAX_LIST).map((a) => {
    if (!isObj(a) || typeof a.callsign !== 'string' || !a.callsign) return null;
    return {
      callsign: a.callsign,
      spokenCallsign: typeof a.spokenCallsign === 'string' ? a.spokenCallsign : '',
      type: typeof a.type === 'string' ? a.type : '',
    };
  });
  if (aircraft.some((a) => a === null)) return 'Every `context.aircraft` entry needs a `callsign` string.';
  const out: LlmParseRequest = { text, context: { aircraft: aircraft as { callsign: string; spokenCallsign: string; type: string }[] } };
  out.context.taxiways = strList(context.taxiways);
  out.context.runwayEnds = strList(context.runwayEnds);
  out.context.frequencies = (Array.isArray(context.frequencies) ? context.frequencies : [])
    .filter((f): f is { id: string; mhz: number } => isObj(f) && typeof f.id === 'string' && typeof f.mhz === 'number').slice(0, MAX_LIST)
    .map((f) => ({ id: f.id, mhz: f.mhz }));
  out.context.fixes = (Array.isArray(context.fixes) ? context.fixes : [])
    .filter((f): f is { id: string; name?: string; spoken?: string } => isObj(f) && typeof f.id === 'string').slice(0, MAX_LIST)
    .map((f) => ({ id: f.id, ...(typeof f.name === 'string' ? { name: f.name } : {}), ...(typeof f.spoken === 'string' ? { spoken: f.spoken } : {}) }));
  out.context.arrivals = (Array.isArray(context.arrivals) ? context.arrivals : [])
    .filter((a): a is { ident: string; spokenName: string; transitions: unknown } => isObj(a) && typeof a.ident === 'string' && typeof a.spokenName === 'string')
    .slice(0, MAX_LIST).map((a) => ({ ident: a.ident, spokenName: a.spokenName, transitions: strList(a.transitions) }));
  if (isObj(grammar) && Array.isArray(grammar.commands)) {
    out.grammar = {
      commands: grammar.commands.filter(isObj).slice(0, 20).map((c) => ({
        kind: String(c.kind) as never,
        callsign: typeof c.callsign === 'string' ? c.callsign : null,
        confidence: typeof c.confidence === 'number' ? c.confidence : 0,
        issues: strList(c.issues),
      })),
    };
  }
  return out;
}

/** The per-request user message: context lists, the grammar's guess, then the transmission. */
export function buildUserMessage(req: LlmParseRequest): string {
  const c = req.context;
  const lines: string[] = ['AIRCRAFT (callsign | spokenCallsign | type):'];
  if (c.aircraft.length === 0) lines.push('(none)');
  for (const a of c.aircraft) lines.push(`${a.callsign} | ${a.spokenCallsign} | ${a.type}`);
  lines.push('', `RUNWAY ENDS: ${c.runwayEnds?.join(', ') || '(not given)'}`);
  lines.push(`TAXIWAYS: ${c.taxiways?.join(', ') || '(not given)'}`);
  lines.push(`FREQUENCIES: ${c.frequencies?.map((f) => `${f.id} ${f.mhz}`).join(', ') || '(not given)'}`);
  lines.push(`FIXES: ${c.fixes?.map((f) => `${f.id}${f.name ? ` (${f.name})` : ''}${f.spoken ? ` [${f.spoken}]` : ''}`).join(', ') || '(not given)'}`);
  lines.push(`ARRIVALS: ${c.arrivals?.map((a) => `${a.ident} (${a.spokenName}; transitions ${a.transitions.join(', ') || 'none'})`).join('; ') || '(not given)'}`);
  lines.push('', 'GRAMMAR GUESS:');
  if (req.grammar && req.grammar.commands.length > 0) {
    for (const g of req.grammar.commands) lines.push(`${g.kind} callsign=${g.callsign ?? 'null'} confidence=${g.confidence.toFixed(2)}${g.issues.length ? ` issues=${g.issues.join('; ')}` : ''}`);
  } else lines.push('(the grammar found nothing)');
  lines.push('', `TRANSMISSION: ${JSON.stringify(req.text)}`);
  return lines.join('\n');
}

export function createLlmParseHandler(deps: LlmParseDeps = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  let lazyClient: LlmClient | undefined;

  const getClient = (): LlmClient | null => {
    if (deps.client) return deps.client;
    if (!isLlmConfigured(env)) return null;
    lazyClient ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY!.trim(), timeout: LLM_PARSE_TIMEOUT_MS, maxRetries: 1 }) as unknown as LlmClient;
    return lazyClient;
  };

  return async (req, res) => {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST.', { Allow: 'POST' });

    const client = getClient();
    if (!client) return sendError(res, 503, 'LLM_NOT_CONFIGURED', 'Set ANTHROPIC_API_KEY in .env to enable the phrase interpreter.');

    const raw = await readBody(req);
    if (raw === null) return sendError(res, 400, 'INVALID_BODY', 'Request body is too large.');
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return sendError(res, 400, 'INVALID_BODY', 'Body must be valid JSON.'); }
    const parsedReq = validateRequest(json);
    if (typeof parsedReq === 'string') return sendError(res, 400, 'INVALID_BODY', parsedReq);

    const model = deps.model ?? llmModelName(env);
    const requestedEffort = deps.effort ?? env.ATC_LLM_EFFORT?.trim() ?? DEFAULT_LLM_EFFORT;
    const effort = (EFFORTS.includes(requestedEffort) ? requestedEffort : DEFAULT_LLM_EFFORT) as Effort;
    const started = now();

    let message: any;
    try {
      message = await client.messages.parse({
        model,
        max_tokens: 1024,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildUserMessage(parsedReq) }],
        output_config: {
          effort,
          format: { type: 'json_schema', schema: LLM_RESPONSE_SCHEMA, parse: parseWireResponse },
        },
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        const retry = err.headers?.get?.('retry-after') ?? '30';
        return sendError(res, 429, 'UPSTREAM_RATE_LIMITED', 'The language model is rate limited; try again shortly.', { 'Retry-After': retry });
      }
      if (err instanceof Anthropic.APIConnectionTimeoutError) return sendError(res, 504, 'UPSTREAM_TIMEOUT', 'The language model did not answer in time.');
      if (err instanceof Anthropic.APIError) {
        log(`[llm] upstream error status=${String(err.status)} type=${String(err.type)}`);
        return sendError(res, 502, 'UPSTREAM_ERROR', 'The language model request failed.');
      }
      if (err instanceof Anthropic.AnthropicError) return sendError(res, 502, 'LLM_REFUSED', 'The model returned no usable structured output.');
      throw err;
    }

    const latencyMs = Math.max(0, Math.round(now() - started));
    const parsed = message?.parsed_output as WireResponse | null | undefined;
    if (!parsed || message?.stop_reason === 'refusal') return sendError(res, 502, 'LLM_REFUSED', 'The model declined or returned no structured output.');

    const u = message.usage ?? {};
    const usage: NonNullable<LlmParseResponse['usage']> = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
    if (typeof u.cache_read_input_tokens === 'number') usage.cacheReadInputTokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === 'number') usage.cacheCreationInputTokens = u.cache_creation_input_tokens;

    const body: LlmParseResponse = {
      commands: parsed.commands.map(toLlmCommand),
      ...(parsed.note ? { note: parsed.note } : {}),
      model,
      latencyMs,
      usage,
    };
    log(`[llm] model=${model} latencyMs=${latencyMs} in=${usage.inputTokens} out=${usage.outputTokens} cacheRead=${usage.cacheReadInputTokens ?? 0} commands=${body.commands.length}`);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };
}
