/**
 * Deepgram temporary-token endpoint for Node's `http` module.
 *
 *   GET  /api/voice/deepgram-token  -> { configured: boolean }   (no token minted)
 *   POST /api/voice/deepgram-token  -> { access_token, expires_in }
 *
 * The permanent key lives only in the server environment (DEEPGRAM_API_KEY).
 * It calls Deepgram's token grant endpoint to mint a short-lived JWT:
 *   POST https://api.deepgram.com/v1/auth/grant   Authorization: Token <key>
 *   body { ttl_seconds }   (default TTL 30 s, max 3600 s)
 * Docs: https://developers.deepgram.com/reference/auth/tokens/grant
 *       https://developers.deepgram.com/docs/token-based-authentication
 *
 * The key must have at least Member permissions to call /auth/grant.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const DEEPGRAM_API_BASE = 'https://api.deepgram.com';
export const DEEPGRAM_GRANT_URL = `${DEEPGRAM_API_BASE}/v1/auth/grant`;

/**
 * Upstream base URL. `DEEPGRAM_API_BASE` (optional) points the grant call elsewhere, e.g. the protocol mock used by
 * e2e/deepgram.spec.ts. Returns undefined when the override is not an absolute http(s) URL.
 */
export function resolveGrantUrl(env: Record<string, string | undefined>): string | undefined {
  const raw = env.DEEPGRAM_API_BASE?.trim();
  if (!raw) return DEEPGRAM_GRANT_URL;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}/v1/auth/grant`;
  } catch {
    return undefined;
  }
}
/** The token only needs to be valid while the WebSocket handshake happens. */
export const TOKEN_TTL_SECONDS = 60;

const RATE_LIMIT_PER_MINUTE = 30;

export interface DeepgramTokenDeps {
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  now?: () => number;
}

const recentGrants: number[] = [];

/** Test helper. */
export function resetDeepgramTokenRateLimit(): void {
  recentGrants.length = 0;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

export async function handleDeepgramToken(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DeepgramTokenDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const apiKey = env.DEEPGRAM_API_KEY?.trim();
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'GET') {
    sendJson(res, 200, { configured: Boolean(apiKey) });
    return;
  }
  if (method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  if (!apiKey) {
    sendJson(res, 503, {
      error: 'Deepgram is not configured on the server. Set the DEEPGRAM_API_KEY environment variable and restart the server, or use the browser speech provider.',
    });
    return;
  }

  const grantUrl = resolveGrantUrl(env);
  if (!grantUrl) {
    sendJson(res, 503, { error: 'DEEPGRAM_API_BASE must be an absolute http:// or https:// URL (or unset to use https://api.deepgram.com).' });
    return;
  }

  const t = now();
  while (recentGrants.length && t - recentGrants[0] > 60_000) recentGrants.shift();
  if (recentGrants.length >= RATE_LIMIT_PER_MINUTE) {
    sendJson(res, 429, { error: 'Too many voice token requests. Wait a moment and try again.' });
    return;
  }
  recentGrants.push(t);

  let upstream: Response;
  try {
    upstream = await doFetch(grantUrl, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
    });
  } catch {
    sendJson(res, 502, { error: 'Could not reach Deepgram to create a temporary token.' });
    return;
  }

  if (!upstream.ok) {
    // Never echo upstream bodies verbatim: keep the message generic and key-free.
    const hint =
      upstream.status === 401 || upstream.status === 403
        ? 'Deepgram rejected the API key (it needs at least Member permissions).'
        : `Deepgram returned HTTP ${upstream.status} when creating a temporary token.`;
    sendJson(res, 502, { error: hint });
    return;
  }

  let data: { access_token?: string; expires_in?: number };
  try {
    data = (await upstream.json()) as typeof data;
  } catch {
    sendJson(res, 502, { error: 'Deepgram returned an unreadable response.' });
    return;
  }
  if (!data.access_token) {
    sendJson(res, 502, { error: 'Deepgram did not return a token.' });
    return;
  }
  sendJson(res, 200, { access_token: data.access_token, expires_in: data.expires_in ?? TOKEN_TTL_SECONDS });
}
