import { describe, expect, it } from 'vitest';
import { splitSpeech, trimSilence } from './speechChunks.ts';

describe('splitSpeech', () => {
  it('keeps short calls whole', () => {
    expect(splitSpeech('Cleared for takeoff.')).toEqual(['Cleared for takeoff.']);
    expect(splitSpeech('')).toEqual([]);
  });

  it('starts with a short first piece ending at punctuation so audio can begin early', () => {
    const chunks = splitSpeech('Runway one three, cleared for takeoff, Cessna seven two three echo juliet');
    expect(chunks[0]).toBe('Runway one three,');
    expect(chunks.join(' ')).toBe('Runway one three, cleared for takeoff, Cessna seven two three echo juliet');
  });

  it('never drops or reorders words', () => {
    const text = 'Spirit four five one, taxi to runway one three via alpha, hold short of runway four, contact ground point niner when ready. Good day.';
    const chunks = splitSpeech(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toBe(text);
  });

  it('caps later pieces at maxWords and folds a tiny tail into the previous piece', () => {
    const long = 'alpha bravo charlie, delta echo foxtrot, golf hotel india juliet kilo, lima mike november oscar papa, quebec romeo sierra tango uniform, victor whiskey';
    const chunks = splitSpeech(long, { maxWords: 8 });
    for (const c of chunks.slice(1)) expect(c.split(' ').length).toBeLessThanOrEqual(9);
    expect(chunks.join(' ')).toBe(long);
    const tail = splitSpeech('one two three, four five six, seven eight nine, ten.', { maxWords: 6 });
    expect(tail[tail.length - 1].split(' ').length).toBeGreaterThanOrEqual(3);
  });
});

describe('trimSilence', () => {
  it('cuts lead-in and tail but keeps a little room', () => {
    const sr = 1000;
    const x = new Float32Array(1000);
    for (let i = 300; i < 700; i++) x[i] = 0.3;
    const t = trimSilence(x, sr, 25);
    expect(t.length).toBe(400 + 50);
    expect(t[25]).toBeCloseTo(0.3);
  });

  it('returns a short stub for pure silence and leaves speech-only buffers intact', () => {
    expect(trimSilence(new Float32Array(1000), 1000, 25).length).toBe(25);
    const loud = new Float32Array(100).fill(0.5);
    expect(trimSilence(loud, 1000).length).toBe(100);
  });
});
