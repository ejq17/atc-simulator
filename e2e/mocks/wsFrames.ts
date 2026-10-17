/**
 * Minimal RFC 6455 framing: just enough for the Deepgram protocol mock (text, binary, close, ping/pong; masked client
 * frames; 7/16/64-bit lengths; fragmented messages). Pure Buffer code with no I/O, so it is unit-tested on its own
 * (wsFrames.test.ts).
 */
import { createHash } from 'node:crypto';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** Value of the `Sec-WebSocket-Accept` header for a client's `Sec-WebSocket-Key`. */
export function acceptKey(clientKey: string): string {
  return createHash('sha1').update(clientKey + WS_GUID).digest('base64');
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Encode one frame. Servers send unmasked frames; pass `mask` to build client-style frames (tests). */
export function encodeFrame(opcode: number, payload: Buffer | string, opts: { fin?: boolean; mask?: Buffer } = {}): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const fin = opts.fin ?? true;
  const maskBit = opts.mask ? 0x80 : 0;
  let header: Buffer;
  if (body.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, maskBit | body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = maskBit | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  if (!opts.mask) return Buffer.concat([header, body]);
  if (opts.mask.length !== 4) throw new Error('mask must be 4 bytes');
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ opts.mask[i % 4];
  return Buffer.concat([header, opts.mask, masked]);
}

export function encodeClose(code = 1000, reason = ''): Buffer {
  const r = Buffer.from(reason, 'utf8');
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  return encodeFrame(OP.close, p);
}

/** Incremental parser: feed raw socket chunks, get complete frames (payload already unmasked). */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Frame[] = [];
    for (;;) {
      const f = this.next();
      if (!f) break;
      out.push(f);
    }
    return out;
  }

  private next(): Frame | null {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('frame too large');
      len = Number(big);
      off = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return null;
    const mask = masked ? b.subarray(off, off + 4) : null;
    const raw = b.subarray(off + maskLen, off + maskLen + len);
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = mask ? raw[i] ^ mask[i % 4] : raw[i];
    this.buf = b.subarray(off + maskLen + len);
    return { fin, opcode, payload };
  }
}

export interface Message {
  kind: 'text' | 'binary' | 'close' | 'ping' | 'pong';
  data: Buffer;
}

/** Joins fragmented data frames into whole messages; control frames pass straight through. */
export class MessageAssembler {
  private parts: Buffer[] = [];
  private kind: 'text' | 'binary' | null = null;

  push(frame: Frame): Message | null {
    switch (frame.opcode) {
      case OP.close: return { kind: 'close', data: frame.payload };
      case OP.ping: return { kind: 'ping', data: frame.payload };
      case OP.pong: return { kind: 'pong', data: frame.payload };
      case OP.text:
      case OP.binary:
        this.kind = frame.opcode === OP.text ? 'text' : 'binary';
        this.parts = [frame.payload];
        break;
      case OP.continuation:
        if (!this.kind) throw new Error('continuation frame without a start frame');
        this.parts.push(frame.payload);
        break;
      default:
        throw new Error(`unsupported opcode ${frame.opcode}`);
    }
    if (!frame.fin) return null;
    const msg: Message = { kind: this.kind!, data: Buffer.concat(this.parts) };
    this.parts = [];
    this.kind = null;
    return msg;
  }
}
