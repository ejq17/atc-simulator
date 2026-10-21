/**
 * Browser side of the phrase interpreter route: `POST /api/llm/parse` on the local backend (contract.ts).
 * No SDK and no key here; the backend holds the key. Vite proxies `/api` in dev; `VITE_API_BASE` overrides it.
 */
import { isStaticHosting } from '../../hosting';
import { LLM_PARSE_PATH, LLM_PARSE_TIMEOUT_MS } from './contract';
import type { LlmParseErrorCode, LlmParseRequest, LlmParseResponse } from './contract';

export type LlmFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type LlmClientErrorCode = LlmParseErrorCode | 'NETWORK' | 'TIMEOUT' | 'BAD_RESPONSE' | (string & {});

export class LlmParseError extends Error {
  readonly code: LlmClientErrorCode;
  readonly status?: number;
  constructor(code: LlmClientErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'LlmParseError';
    this.code = code;
    this.status = status;
  }
}

export interface LlmParser {
  parse(req: LlmParseRequest): Promise<LlmParseResponse>;
}

export interface LlmParserOptions {
  fetch?: LlmFetch;
  /** Prefix of the backend routes, no trailing slash. Default: `VITE_API_BASE` or '' (same origin, Vite proxy). */
  apiBase?: string;
  timeoutMs?: number;
}

function defaultApiBase(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    if (env?.VITE_API_BASE) return env.VITE_API_BASE.replace(/\/$/, '');
  } catch { /* not in a Vite context */ }
  return '';
}

const defaultFetch: LlmFetch = (input, init) => fetch(input, init);

export function createLlmParser(options: LlmParserOptions = {}): LlmParser {
  const doFetch = options.fetch ?? defaultFetch;
  const base = (options.apiBase ?? defaultApiBase()).replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? LLM_PARSE_TIMEOUT_MS;
  return {
    async parse(req) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        let res: Response;
        try {
          res = await doFetch(`${base}${LLM_PARSE_PATH}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(req),
            signal: controller.signal,
          });
        } catch (err) {
          if (timedOut) throw new LlmParseError('TIMEOUT', `The phrase interpreter did not answer within ${Math.round(timeoutMs / 1000)} s.`);
          throw new LlmParseError('NETWORK', `Local backend not reachable (${err instanceof Error ? err.message : String(err)}).`);
        }
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          if (timedOut) throw new LlmParseError('TIMEOUT', `The phrase interpreter did not answer within ${Math.round(timeoutMs / 1000)} s.`);
          if (res.ok) throw new LlmParseError('BAD_RESPONSE', 'The phrase interpreter returned something that is not JSON.', res.status);
          body = undefined;
        }
        if (!res.ok) {
          const e = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
          throw new LlmParseError(e?.code ?? `HTTP_${res.status}`, e?.message ?? `Phrase interpreter request failed (HTTP ${res.status}).`, res.status);
        }
        const r = body as Partial<LlmParseResponse> | undefined;
        if (!r || !Array.isArray(r.commands)) throw new LlmParseError('BAD_RESPONSE', 'The phrase interpreter returned an unexpected shape.', res.status);
        return r as LlmParseResponse;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface LlmAvailability {
  available: boolean;
  model?: string;
  detail: string;
}

/** Settings form: is the phrase interpreter usable (local backend up, key configured)? Reads `/api/health`. */
export async function checkLlmAvailability(fetchImpl?: LlmFetch, apiBase?: string): Promise<LlmAvailability> {
  if (isStaticHosting()) {
    return { available: false, detail: 'The phrase interpreter needs the local backend (npm run server). It is not available on this hosted site; the rule grammar is used alone.' };
  }
  const doFetch = fetchImpl ?? defaultFetch;
  const base = (apiBase ?? defaultApiBase()).replace(/\/$/, '');
  try {
    const res = await doFetch(`${base}/api/health`, { headers: { Accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as { llmConfigured?: boolean; llmModel?: string };
    if (res.ok && body.llmConfigured) {
      return { available: true, model: body.llmModel, detail: `Phrase interpreter ready${body.llmModel ? ` (model ${body.llmModel})` : ''}.` };
    }
    return { available: false, detail: 'The phrase interpreter needs the local backend (npm run server) started with ANTHROPIC_API_KEY set.' };
  } catch {
    return { available: false, detail: 'Local backend not reachable (run `npm run server` with ANTHROPIC_API_KEY set).' };
  }
}
