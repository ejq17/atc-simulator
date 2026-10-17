/**
 * Protocol-faithful MOCK of the two Deepgram endpoints the app talks to. It exists to prove, in automation and with no
 * API key, that the CLIENT side works: token grant -> WebSocket upgrade with the `token` subprotocol -> 16 kHz linear16
 * audio frames -> `Results` JSON (interim then final) -> `CloseStream`.
 *
 * !! THIS MOCK DOES NOT DO SPEECH RECOGNITION. !!  Deepgram's accuracy on callsigns, numbers and phonetics is NOT
 * exercised here and still needs a real key. The transcript it returns is picked from a fixed table by a crude
 * fingerprint of the audio it received: the number of 100 ms blocks whose peak is above 1 % of full scale ("speech
 * seconds"; see transcriptForSpeechSeconds). With the three fixtures in e2e/fixtures that is 4.5 s (takeoff), 3.6 s (land),
 * 3.2 s (hold position).
 *
 * Endpoints (Deepgram streaming reference https://developers.deepgram.com/reference/speech-to-text/listen-streaming,
 * token grant https://developers.deepgram.com/reference/auth/tokens/grant):
 *   POST /v1/auth/grant   `Authorization: Token <apiKey>`, body {ttl_seconds} -> {access_token, expires_in}
 *   GET  /v1/listen       WebSocket upgrade, `Sec-WebSocket-Protocol: token, <jwt>` (or `bearer, <jwt>`); the jwt must be one
 *                         this mock minted; query: model, encoding=linear16, sample_rate=16000, channels, interim_results,
 *                         endpointing, smart_format, punctuate, keyterm (nova-3) / keywords (nova-2).
 * Server -> client: `Results` messages (interim after ~1 s of audio, then final with speech_final=true on CloseStream or after
 * `idleFinalizeMs` without audio), then `Metadata`, then a normal close. Client -> server: binary PCM, `CloseStream`, `KeepAlive`.
 * Test control (not part of Deepgram): GET /__mock/stats, POST /__mock/config.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { acceptKey, encodeClose, encodeFrame, FrameParser, MessageAssembler, OP } from './wsFrames.ts';

export const TAKEOFF_TEXT = 'cessna seven two three echo juliet runway one three cleared for takeoff';
export const LAND_TEXT = 'spirit four fifty one runway one three cleared to land';
export const HOLD_TEXT = 'cessna seven two three echo juliet hold position';

/** Fixed fingerprint table. NOT speech recognition. */
export function transcriptForSpeechSeconds(speechSeconds: number): string {
  if (speechSeconds >= 4.1) return TAKEOFF_TEXT;
  if (speechSeconds >= 3.4) return LAND_TEXT;
  if (speechSeconds >= 2.5) return HOLD_TEXT;
  return '';
}

/** Seconds of 100 ms blocks (1600 samples) whose peak amplitude exceeds 1 % of full scale. */
export function speechSecondsOf(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  let blocks = 0;
  for (let i = 0; i + 1600 <= samples; i += 1600) {
    let peak = 0;
    for (let j = i; j < i + 1600; j++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(j * 2)));
    if (peak > 328) blocks++;
  }
  return blocks / 10;
}

export interface UpgradeRecord {
  path: string;
  protocols: string[];
  token: string | undefined;
  tokenValid: boolean;
  accepted: boolean;
  query: Record<string, string[]>;
}

export interface ConnectionRecord extends UpgradeRecord {
  audioBytes: number;
  audioFrames: number;
  audioSeconds: number;
  speechSeconds: number;
  closeStreamReceived: boolean;
  sentTypes: string[];
  transcript: string;
}

export interface MockStats {
  grants: Array<{ authorization: string | undefined; status: number }>;
  upgrades: UpgradeRecord[];
  connections: ConnectionRecord[];
}

export interface MockConfig {
  /** Force the grant endpoint to answer this HTTP status (e.g. 401). 0 = behave normally. */
  grantStatus: number;
  /** Reject WebSocket upgrades with 401 even for valid tokens. */
  rejectUpgrade: boolean;
}

export interface DeepgramMockOptions {
  port?: number;
  host?: string;
  /** The API key the grant endpoint accepts. */
  apiKey?: string;
  /** Finalise when no audio arrives for this long (the "client stops sending" case). */
  idleFinalizeMs?: number;
}

export interface DeepgramMock {
  readonly port: number;
  /** http base for DEEPGRAM_API_BASE. */
  readonly httpBase: string;
  /** ws base for the browser (`kacy.deepgram.wsBase` / VITE_DEEPGRAM_WS_BASE). */
  readonly wsBase: string;
  readonly stats: MockStats;
  readonly config: MockConfig;
  reset(): void;
  close(): Promise<void>;
}

function resultsMessage(text: string, opts: { final: boolean; speechFinal: boolean; start: number; duration: number }): string {
  const words = text ? text.split(' ').map((w, i, a) => ({ word: w, start: opts.start + (opts.duration * i) / a.length, end: opts.start + (opts.duration * (i + 1)) / a.length, confidence: 0.98 })) : [];
  return JSON.stringify({
    type: 'Results',
    channel_index: [0, 1],
    duration: opts.duration,
    start: opts.start,
    is_final: opts.final,
    speech_final: opts.speechFinal,
    channel: { alternatives: [{ transcript: text, confidence: text ? 0.98 : 0, words }] },
    metadata: { request_id: 'mock-request', model_info: { name: 'mock', version: '0', arch: 'mock' }, model_uuid: 'mock' },
    from_finalize: false,
  });
}

export async function startDeepgramMock(options: DeepgramMockOptions = {}): Promise<DeepgramMock> {
  const apiKey = options.apiKey ?? 'test-key';
  const idleFinalizeMs = options.idleFinalizeMs ?? 1500;
  const host = options.host ?? '127.0.0.1';
  const minted = new Set<string>();
  const stats: MockStats = { grants: [], upgrades: [], connections: [] };
  const config: MockConfig = { grantStatus: 0, rejectUpgrade: false };
  const sockets = new Set<Socket>();

  const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  });

  const http: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/v1/auth/grant' && req.method === 'POST') {
      await readBody(req);
      const auth = req.headers.authorization;
      let status = config.grantStatus || (auth === `Token ${apiKey}` ? 200 : 401);
      if (status === 200) {
        const jwt = `mock.${randomBytes(12).toString('hex')}.sig`;
        minted.add(jwt);
        stats.grants.push({ authorization: auth, status });
        json(200, { access_token: jwt, expires_in: 60 });
        return;
      }
      stats.grants.push({ authorization: auth, status });
      json(status, { err_code: 'INVALID_AUTH', err_msg: 'Mock: invalid credentials.', request_id: 'mock-request' });
      return;
    }
    if (url.pathname === '/__mock/stats') return json(200, stats);
    if (url.pathname === '/__mock/config' && req.method === 'POST') {
      Object.assign(config, JSON.parse((await readBody(req)) || '{}'));
      return json(200, config);
    }
    json(404, { err_code: 'NOT_FOUND', err_msg: `Mock has no route for ${req.method} ${url.pathname}` });
  });

  http.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const url = new URL(req.url ?? '/', 'http://mock');
    const query: Record<string, string[]> = {};
    url.searchParams.forEach((v, k) => (query[k] ??= []).push(v));
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    const scheme = protocols[0];
    const token = protocols[1];
    const tokenValid = (scheme === 'token' || scheme === 'bearer') && token !== undefined && minted.has(token);
    const paramsOk = query.encoding?.[0] === 'linear16' && query.sample_rate?.[0] === '16000' && Boolean(query.model?.[0]);
    const key = req.headers['sec-websocket-key'];
    const record: UpgradeRecord = { path: url.pathname, protocols, token, tokenValid, accepted: false, query };
    stats.upgrades.push(record);

    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    if (url.pathname !== '/v1/listen' || typeof key !== 'string') return refuse(404, 'Not Found');
    if (config.rejectUpgrade || !tokenValid) return refuse(401, 'Unauthorized');
    if (!paramsOk) return refuse(400, 'Bad Request');

    record.accepted = true;
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\nSec-WebSocket-Protocol: ${scheme}\r\n\r\n`,
    );

    const conn: ConnectionRecord = { ...record, audioBytes: 0, audioFrames: 0, audioSeconds: 0, speechSeconds: 0, closeStreamReceived: false, sentTypes: [], transcript: '' };
    stats.connections.push(conn);
    const parser = new FrameParser();
    const assembler = new MessageAssembler();
    const wantInterim = query.interim_results?.[0] !== 'false';
    let speech = 0;
    let carry = Buffer.alloc(0);
    let interimsSent = 0;
    let finalised = false;
    let idle: ReturnType<typeof setTimeout> | undefined;

    const send = (frame: Buffer, type: string) => {
      if (!socket.destroyed) {
        socket.write(frame);
        conn.sentTypes.push(type);
      }
    };
    const finalise = () => {
      if (finalised) return;
      finalised = true;
      clearTimeout(idle);
      conn.speechSeconds = speech;
      const text = transcriptForSpeechSeconds(speech);
      conn.transcript = text;
      send(encodeFrame(OP.text, resultsMessage(text, { final: true, speechFinal: true, start: 0, duration: conn.audioSeconds })), 'Results(final)');
      send(encodeFrame(OP.text, JSON.stringify({ type: 'Metadata', request_id: 'mock-request', duration: conn.audioSeconds, channels: 1 })), 'Metadata');
      send(encodeClose(1000, 'finished'), 'close');
      socket.end();
    };
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(finalise, idleFinalizeMs);
    };

    const onAudio = (data: Buffer) => {
      conn.audioBytes += data.length;
      conn.audioFrames++;
      conn.audioSeconds = conn.audioBytes / 2 / 16000;
      carry = Buffer.concat([carry, data]);
      const whole = carry.length - (carry.length % 3200); // 1600 samples
      if (whole > 0) {
        speech += speechSecondsOf(carry.subarray(0, whole));
        carry = carry.subarray(whole);
      }
      // One canned interim per second of audio (a prefix common to the takeoff and hold fixtures; the mock cannot know
      // the real words before the audio ends). Real Deepgram interims grow as recognition firms up.
      while (wantInterim && !finalised && conn.audioSeconds >= interimsSent + 1) {
        interimsSent++;
        const partial = interimsSent === 1 ? 'cessna seven two three' : 'cessna seven two three echo juliet';
        send(encodeFrame(OP.text, resultsMessage(partial, { final: false, speechFinal: false, start: 0, duration: conn.audioSeconds })), 'Results(interim)');
      }
      armIdle();
    };

    const onMessage = (kind: string, data: Buffer) => {
      if (kind === 'binary') onAudio(data);
      else if (kind === 'text') {
        let type = '';
        try { type = (JSON.parse(data.toString('utf8')) as { type?: string }).type ?? ''; } catch { /* ignore */ }
        if (type === 'CloseStream') {
          conn.closeStreamReceived = true;
          finalise();
        }
      } else if (kind === 'ping') send(encodeFrame(OP.pong, data), 'pong');
      else if (kind === 'close') {
        if (!finalised) {
          finalised = true;
          clearTimeout(idle);
          send(encodeClose(1000), 'close');
        }
        socket.end();
      }
    };
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const f of parser.push(chunk)) {
          const m = assembler.push(f);
          if (m) onMessage(m.kind, m.data);
        }
      } catch {
        socket.destroy();
      }
    });
    socket.on('close', () => clearTimeout(idle));
  });
  http.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, host, () => resolve());
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    httpBase: `http://${host}:${port}`,
    wsBase: `ws://${host}:${port}`,
    stats,
    config,
    reset() {
      stats.grants.length = 0;
      stats.upgrades.length = 0;
      stats.connections.length = 0;
      minted.clear();
      config.grantStatus = 0;
      config.rejectUpgrade = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        sockets.forEach((s) => s.destroy());
        http.close(() => resolve());
      }),
  };
}
