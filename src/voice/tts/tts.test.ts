import { describe, expect, it } from 'vitest';
import { prepareForTts } from './prepareForTts.ts';
import { assignVoice, eligibleVoices, VARIANTS } from './voiceAssignment.ts';
import type { VoiceInfo } from './types.ts';

const voice = (name: string, lang = 'en-US', local = true): VoiceInfo => ({
  id: `uri:${name}`,
  name,
  lang,
  localService: local,
  isDefault: false,
});

const VOICES = [
  voice('Samantha'), voice('Alex'), voice('Daniel', 'en-GB'), voice('Karen', 'en-AU'),
  voice('Google US English', 'en-US', false), voice('Google UK English Male', 'en-GB', false),
  voice('Albert'), voice('Zarvox'), voice('Thomas', 'fr-FR'),
];

describe('voice assignment', () => {
  it('is deterministic regardless of enumeration order', () => {
    const a = assignVoice('v3', VOICES);
    const b = assignVoice('v3', [...VOICES].reverse());
    expect(a).toEqual(b);
    expect(assignVoice('v3', VOICES)).toEqual(a);
  });

  it('gives distinct voice+rate+pitch combos for the first N ids', () => {
    const pool = eligibleVoices(VOICES);
    const n = pool.length * VARIANTS.length;
    const combos = new Set<string>();
    for (let i = 0; i < n; i++) {
      const p = assignVoice(`v${i}`, VOICES);
      combos.add(`${p.voice?.id}|${p.rate}|${p.pitch}`);
    }
    expect(combos.size).toBe(n);
  });

  it('prefers en-US/en-GB and drops novelty and non-English voices', () => {
    const pool = eligibleVoices(VOICES).map((v) => v.name);
    expect(pool).not.toContain('Albert');
    expect(pool).not.toContain('Zarvox');
    expect(pool).not.toContain('Thomas');
    expect(pool).not.toContain('Karen');
    expect(pool[0]).toBe('Alex');
  });

  it('adjacent ids get different voices when several exist', () => {
    const ids = ['v0', 'v1', 'v2', 'v3', 'v4'].map((id) => assignVoice(id, VOICES).voice?.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('falls back to rate/pitch variation with one voice', () => {
    const one = [voice('Only')];
    const p0 = assignVoice('v0', one);
    const p1 = assignVoice('v1', one);
    expect(p0.voice?.name).toBe('Only');
    expect(p1.voice?.name).toBe('Only');
    expect([p0.rate, p0.pitch]).not.toEqual([p1.rate, p1.pitch]);
  });

  it('works with no voices at all and hashes arbitrary ids', () => {
    const p = assignVoice('pilot-7', []);
    expect(p.voice).toBeNull();
    expect(p).toEqual(assignVoice('pilot-7', []));
    expect(assignVoice('abc', VOICES)).toEqual(assignVoice('abc', VOICES));
  });

  it('keeps rate and pitch in a clear range', () => {
    for (const v of VARIANTS) {
      expect(v.rate).toBeGreaterThanOrEqual(0.85);
      expect(v.rate).toBeLessThanOrEqual(1.25);
      expect(v.pitch).toBeGreaterThanOrEqual(0.8);
      expect(v.pitch).toBeLessThanOrEqual(1.25);
    }
  });
});

describe('prepareForTts', () => {
  it('spells acronyms letter by letter', () => {
    expect(prepareForTts('Cleared ILS approach')).toBe('Cleared I L S approach');
    expect(prepareForTts('VFR to the north')).toBe('V F R to the north');
    expect(prepareForTts('Information ATIS Alpha')).toBe('Information A T I S Alpha');
  });

  it('turns runway numbers into words, using niner', () => {
    expect(prepareForTts('Runway 13 cleared for takeoff')).toBe('Runway one three cleared for takeoff');
    expect(prepareForTts('runway 09')).toBe('runway zero niner');
    expect(prepareForTts('Runway 31 right')).toBe('Runway three one right');
    expect(prepareForTts('line up runway 4')).toBe('line up runway four');
  });

  it('expands runway side suffixes', () => {
    expect(prepareForTts('runway 27L')).toBe('runway two seven left');
    expect(prepareForTts('Runway 9R, hold short')).toBe('Runway niner right, hold short');
  });

  it('handles frequencies, headings and abbreviations', () => {
    expect(prepareForTts('contact tower 119.4')).toBe('contact tower one one niner point four');
    expect(prepareForTts('fly heading 090')).toBe('fly heading zero niner zero');
    expect(prepareForTts('RWY 13 via TWY A')).toBe('runway one three via taxiway A');
  });

  it('leaves already-spoken text untouched', () => {
    const spoken = 'Spirit one two three, runway one three, cleared for takeoff, wind two niner zero at one zero';
    expect(prepareForTts(spoken)).toBe(spoken);
  });
});
