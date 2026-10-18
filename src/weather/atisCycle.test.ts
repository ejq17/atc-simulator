import { describe, expect, it } from 'vitest';
import { atisSlot, hourlyAtisAdvance, hourlySlotApplies, initialAtisLetter } from './atisCycle';
import { atisNeedsUpdate, generateAtis } from './atis';
import { isNewObservation } from './observation';
import { getPresetWeather } from './presets';

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

describe('ATIS cadence (JO 7110.65 2-9-2): one new letter per new official observation', () => {
  const wx = (observedAt?: string) => ({ ...getPresetWeather('clear'), source: 'live' as const, ...(observedAt ? { observedAt, rawMetar: `KACY ${observedAt}` } : {}) });
  const atis = (w: ReturnType<typeof wx>) => generateAtis({
    airportName: 'Atlantic City', icao: 'KACY', weather: w, variationDeg: -10, activeRunways: { departing: ['13'], landing: ['13'] }, letter: 'A', timeUtc: new Date(at(12, 55)), elevationFt: 75,
  });

  it('the day has 24 hourly slots and the letters follow them: slot n has letter n mod 24 (A..X), the 25th letter is never used by the clock', () => {
    const letters = new Set<string>();
    for (let h = 0; h < 24; h++) letters.add(initialAtisLetter(at(h, 10)));
    expect(letters.size).toBe(24);
    expect([...letters].sort().join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWX');
  });
  it('the slot applies to simulated weather only; live weather is driven by its observations', () => {
    expect(hourlySlotApplies({ source: 'simulated' })).toBe(true);
    expect(hourlySlotApplies({ source: 'live' })).toBe(false);
  });
  it('a live hourly METAR is a new observation even with identical values; the same one again, and a 5-minute observation, are not', () => {
    const a = atis(wx('2026-10-17T11:54:00.000Z'));
    expect(atisNeedsUpdate(a, wx('2026-10-17T12:54:00.000Z'))).toBe(true);
    expect(atisNeedsUpdate(a, wx('2026-10-17T11:54:00.000Z'))).toBe(false);
    expect(atisNeedsUpdate(a, wx('2026-10-17T12:35:00.000Z'))).toBe(false);
    expect(isNewObservation(a.weather, wx('2026-10-17T12:54:00.000Z'))).toBe(true);
  });
  it('a SPECI is official weather too', () => {
    const a = atis(wx('2026-10-17T11:54:00.000Z'));
    const speci = { ...wx('2026-10-17T12:20:00.000Z'), rawMetar: 'SPECI KACY 171220Z 35008KT 10SM CLR 09/07 A3010' };
    expect(atisNeedsUpdate(a, speci)).toBe(true);
  });
});
