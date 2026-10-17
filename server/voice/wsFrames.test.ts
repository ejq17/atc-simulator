// Tests the e2e mock's RFC 6455 codec here because vitest only collects src/ and server/.
import { describe, expect, it } from 'vitest';
import { acceptKey, encodeClose, encodeFrame, FrameParser, MessageAssembler, OP } from '../../e2e/mocks/wsFrames.ts';

const MASK = Buffer.from([0x12, 0x34, 0x56, 0x78]);

describe('websocket frame codec', () => {
  it('computes Sec-WebSocket-Accept exactly as RFC 6455 section 1.3 shows', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('round-trips masked client frames at the 7-bit, 16-bit and 64-bit length boundaries', () => {
    for (const n of [0, 5, 125, 126, 300, 65535, 65536, 70000]) {
      const payload = Buffer.alloc(n, 0xab);
      const [f] = new FrameParser().push(encodeFrame(OP.binary, payload, { mask: MASK }));
      expect(f.opcode, `len ${n}`).toBe(OP.binary);
      expect(f.fin).toBe(true);
      expect(f.payload.equals(payload)).toBe(true);
    }
  });

  it('server frames are unmasked and use the shortest length form', () => {
    expect(encodeFrame(OP.text, 'hi').equals(Buffer.from([0x81, 2, 0x68, 0x69]))).toBe(true);
    expect(encodeFrame(OP.text, Buffer.alloc(126))[1]).toBe(126);
    expect(encodeFrame(OP.binary, Buffer.alloc(65536))[1]).toBe(127);
  });

  it('reassembles frames split across arbitrary TCP chunk boundaries', () => {
    const wire = Buffer.concat([
      encodeFrame(OP.text, '{"type":"CloseStream"}', { mask: MASK }),
      encodeFrame(OP.binary, Buffer.alloc(200, 7), { mask: MASK }),
    ]);
    const parser = new FrameParser();
    const frames = [];
    for (let i = 0; i < wire.length; i += 3) frames.push(...parser.push(wire.subarray(i, i + 3)));
    expect(frames.map((f) => f.opcode)).toEqual([OP.text, OP.binary]);
    expect(frames[0].payload.toString()).toBe('{"type":"CloseStream"}');
    expect(frames[1].payload.length).toBe(200);
  });

  it('joins fragmented messages and lets control frames interleave', () => {
    const asm = new MessageAssembler();
    const parser = new FrameParser();
    const wire = Buffer.concat([
      encodeFrame(OP.text, 'hel', { fin: false, mask: MASK }),
      encodeFrame(OP.ping, 'p', { mask: MASK }),
      encodeFrame(OP.continuation, 'lo', { mask: MASK }),
    ]);
    const msgs = parser.push(wire).map((f) => asm.push(f)).filter((m) => m !== null);
    expect(msgs.map((m) => m!.kind)).toEqual(['ping', 'text']);
    expect(msgs[1]!.data.toString()).toBe('hello');
  });

  it('decodes a close frame with code and reason', () => {
    const [f] = new FrameParser().push(encodeClose(1008, 'bad token'));
    expect(f.opcode).toBe(OP.close);
    expect(f.payload.readUInt16BE(0)).toBe(1008);
    expect(f.payload.subarray(2).toString()).toBe('bad token');
  });

  it('rejects a continuation frame that has nothing to continue', () => {
    expect(() => new MessageAssembler().push({ fin: true, opcode: OP.continuation, payload: Buffer.alloc(1) })).toThrow();
  });
});
