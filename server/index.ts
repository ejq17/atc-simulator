/**
 * Tiny local backend for the KACY ATC simulator (Node `http`, no framework).
 *
 *   GET /api/health
 *   GET /api/weather/metar?ids=KACY      -> AWC JSON array (cached 5 min)
 *   GET /api/weather/taf?ids=KACY        -> AWC JSON array (cached 30 min)
 *   GET|POST /api/voice/deepgram-token   -> ./voice/deepgramToken
 *   GET /api/charts/pdf?url=<aeronav>     -> ./charts/chartProxy
 *
 * Run with `npm run server` (tsx watch). Configuration: `.env` in the project
 * root (see `.env.example`), PORT (default 8787), HOST (default 127.0.0.1).
 * CORS: only the Vite dev origin http://localhost:5173 is allowed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from './env';
import { AwcError, createAwcClient, parseIds, type AwcClient } from './weather/awc';
import { handleDeepgramToken } from './voice/deepgramToken';
import { handleChartProxy } from './charts/chartProxy';

export const DEFAULT_PORT = 8787;
export const VITE_DEV_ORIGIN = 'http://localhost:5173';

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface AppOptions {
  awc?: AwcClient;
  deepgram?: Handler;
  corsOrigin?: string;
  /** Hostnames accepted in the Host header (DNS-rebinding guard). */
  allowedHosts?: string[];
}

const STARTED_AT = Date.now();

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

export function createAppServer(options: AppOptions = {}): Server {
  const awc = options.awc ?? createAwcClient();
  const deepgram: Handler = options.deepgram ?? ((req, res) => handleDeepgramToken(req, res));
  const corsOrigin = options.corsOrigin ?? VITE_DEV_ORIGIN;
  const allowedHosts = new Set(options.allowedHosts ?? ['localhost', '127.0.0.1', '[::1]']);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const hostName = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!allowedHosts.has(hostName)) {
      sendError(res, 403, 'FORBIDDEN_HOST', 'This backend only answers requests addressed to localhost.');
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/api/voice/deepgram-token') {
      await deepgram(req, res);
      return;
    }

    if (path === '/api/charts/pdf') {
      await handleChartProxy(req, res);
      return;
    }

    if (path === '/api/health') {
      if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      sendJson(res, 200, {
        ok: true,
        service: 'kacy-atc-sim-backend',
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        deepgramConfigured: Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
        upstreamRequests: awc.stats().upstreamRequests,
      });
      return;
    }

    if (path === '/api/weather/metar' || path === '/api/weather/taf') {
      if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      try {
        const ids = parseIds(url.searchParams.get('ids'));
        const result = path.endsWith('/metar') ? await awc.getMetar(ids) : await awc.getTaf(ids);
        sendJson(res, 200, result.data, {
          'X-Cache': result.cache,
          'X-Cache-Age': String(Math.round(result.ageMs / 1000)),
          'Cache-Control': 'public, max-age=60',
        });
      } catch (err) {
        if (err instanceof AwcError) {
          const headers: Record<string, string> = err.code === 'UPSTREAM_RATE_LIMITED' ? { 'Retry-After': '30' } : {};
          sendJson(res, err.httpStatus, { error: { code: err.code, message: err.message } }, headers);
        } else {
          sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected server error.');
        }
      }
      return;
    }

    sendError(res, 404, 'NOT_FOUND', `No route for ${method} ${path}`);
  }

  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      console.error('[server] unhandled error:', err);
      if (!res.headersSent) sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected server error.');
      else res.end();
    });
  });
}

function isMainModule(): boolean {
  if (process.env.VITEST) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const loaded = loadEnvFile(resolve(projectRoot, '.env'));
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || '127.0.0.1';
  const server = createAppServer();
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `[server] port ${port} is already in use (set PORT to change it).` : `[server] ${err.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`[server] KACY ATC backend listening on http://${host}:${port}`);
    console.log(`[server] CORS allows ${VITE_DEV_ORIGIN}; .env keys loaded: ${loaded.length ? loaded.join(', ') : '(none)'}`);
    console.log(`[server] Deepgram key ${process.env.DEEPGRAM_API_KEY?.trim() ? 'configured' : 'NOT configured (voice cloud STT disabled)'}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
