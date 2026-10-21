/**
 * Contract between the browser and the local backend's phrase interpreter (`POST /api/llm/parse`, server/llm/).
 *
 * The rule grammar in src/commands is the fast path and runs on every transmission. When it is unsure (no command, an
 * UNKNOWN command, or low confidence) the UI may send the same transmission plus the parse context to the backend, which
 * asks a language model for the structured commands. The backend answers with `ParsedCommand`-shaped objects; the
 * browser still resolves the callsign against the active list and validates identifiers before the engine executes
 * anything, so an invented callsign or runway is rejected the same way a misheard one is.
 *
 * Only the local backend (`npm run server`) has this route; the static GitHub Pages build does not.
 */
import type { ParseContext } from '../context';
import type { ParsedCommand } from '../../sim/types';

/** The parse context, serialised. Same shape as `ParseContext` (src/commands/context.ts); every field is plain data. */
export type LlmParseContext = ParseContext;

export interface LlmParseRequest {
  /** The transmission as heard or typed, verbatim. */
  text: string;
  context: LlmParseContext;
  /**
   * What the rule grammar made of it, so the model can confirm or correct rather than start from nothing.
   * Omitted when the grammar found nothing.
   */
  grammar?: { commands: Pick<ParsedCommand, 'kind' | 'callsign' | 'confidence' | 'issues'>[] };
}

/**
 * One instruction as the model understood it. The fields mirror `ParsedCommand`; `confidence`, `rawText`,
 * `normalizedText`, `issues` and `interpretedBy` are filled in by the browser, not the model.
 */
export type LlmCommand = Omit<ParsedCommand, 'confidence' | 'rawText' | 'normalizedText' | 'issues' | 'interpretedBy' | 'callsignCandidates' | 'callsignAbbreviated' | 'groupSize' | 'toNodeId'> & {
  /** The callsign exactly as the model matched it from `context.aircraft` (null when no aircraft was addressed). */
  callsign: string | null;
};

export interface LlmParseResponse {
  commands: LlmCommand[];
  /** Model's one-line note when it could not map the transmission (e.g. "no instruction, sounded like a readback"). */
  note?: string;
  model: string;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number };
}

/** Error body of the route, same envelope as the other routes (`{ error: { code, message } }`). */
export type LlmParseErrorCode =
  | 'LLM_NOT_CONFIGURED'   // 503: no ANTHROPIC_API_KEY in .env
  | 'INVALID_BODY'         // 400
  | 'METHOD_NOT_ALLOWED'   // 405
  | 'UPSTREAM_TIMEOUT'     // 504
  | 'UPSTREAM_RATE_LIMITED'// 429
  | 'UPSTREAM_ERROR'       // 502
  | 'LLM_REFUSED';         // 502: the model declined or returned no structured output

export const LLM_PARSE_PATH = '/api/llm/parse';
/** Hard cap on how long the browser waits for the interpreter before giving up on the fallback. */
export const LLM_PARSE_TIMEOUT_MS = 8000;
