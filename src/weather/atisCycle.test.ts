import { describe, expect, it } from 'vitest';
import { atisSlot, hourlyAtisAdvance, initialAtisLetter } from './atisCycle';

const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 17, h, m, s);

describe('ATIS hourly cycle', () => {
  it('advances at HH:55Z, not at the top of the hour', () => {
    expect(atisSlot(at(12, 54, 59))).toBe(atisSlot(at(12, 0)));
    expect(atisSlot(at(12, 55))).toBe(atisSlot(at(12, 0)) + 1);
    expect(atisSlot(at(13, 0))).toBe(atisSlot(at(12, 55)));
  });

  it('gives the same initial letter for the whole slot and a new one each hour', () => {
    expect(initialAtisLetter(at(12, 10))).toBe(initialAtisLetter(at(12, 54)));
    expect(initialAtisLetter(at(12, 56))).toBe(String.fromCharCode(initialAtisLetter(at(12, 10)).charCodeAt(0) + 1));
    expect(initialAtisLetter(at(0, 10))).toBe('A');
    expect(initialAtisLetter(at(23, 56))).toBe('A'); // wraps with the day's 24 slots
  });

  it('hourlyAtisAdvance reports a new letter once per slot', () => {
    const slot = atisSlot(at(12, 30));
    expect(hourlyAtisAdvance(slot, at(12, 54, 59), 'F')).toBeUndefined();
    expect(hourlyAtisAdvance(slot, at(12, 55), 'F')).toEqual({ slot: slot + 1, letter: 'G' });
    expect(hourlyAtisAdvance(slot + 1, at(13, 20), 'G')).toBeUndefined();
    expect(hourlyAtisAdvance(atisSlot(at(12, 30)), at(14, 56), 'Z')?.letter).toBe('A'); // Z wraps to A
  });
});
