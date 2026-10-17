import type { VoiceInfo } from './types.ts';

export interface VoiceProfile {
  voice: VoiceInfo | null;
  rate: number;
  pitch: number;
}

/** Stable 32-bit FNV-1a hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** macOS novelty voices and other voices that are unsuitable for radio chatter. */
const UNSUITABLE = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|superstar|trinoids|whisper|wobble|zarvox|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley)\b/i;

/** (rate, pitch) variants cycled once the voices are exhausted. Pitch stays within a clear range. */
export const VARIANTS: ReadonlyArray<{ rate: number; pitch: number }> = [
  { rate: 1.0, pitch: 1.0 },
  { rate: 1.1, pitch: 0.88 },
  { rate: 0.94, pitch: 1.12 },
  { rate: 1.16, pitch: 1.0 },
  { rate: 0.9, pitch: 0.84 },
  { rate: 1.05, pitch: 1.2 },
  { rate: 1.22, pitch: 0.94 },
  { rate: 0.98, pitch: 0.92 },
];

/** Voices usable for pilots, best first: en-US, en-GB, other English; local before network. */
export function eligibleVoices(voices: readonly VoiceInfo[]): VoiceInfo[] {
  const rank = (v: VoiceInfo): number => {
    const lang = v.lang.replace('_', '-').toLowerCase();
    let r = lang === 'en-us' ? 0 : lang === 'en-gb' ? 1 : lang.startsWith('en') ? 2 : 9;
    if (!v.localService) r += 0.5;
    return r;
  };
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en') && !UNSUITABLE.test(v.name));
  const pool = english.length ? english : [...voices];
  // Prefer en-US/en-GB; add other English only if too few to be distinct.
  const preferred = pool.filter((v) => rank(v) < 2);
  const chosen = preferred.length >= 3 ? preferred : pool;
  // Sort by rank then name then id so ordering never depends on browser enumeration order.
  return [...chosen].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Deterministically map an aircraft voiceId to a voice + rate/pitch.
 * Ids of the form "v<N>" map sequentially so v0..v(n*variants-1) are all distinct;
 * any other string is hashed.
 */
export function assignVoice(voiceId: string, voices: readonly VoiceInfo[]): VoiceProfile {
  const pool = eligibleVoices(voices);
  const m = /^v(\d+)$/i.exec(voiceId.trim());
  const index = m ? parseInt(m[1], 10) : hashString(voiceId);
  if (pool.length === 0) {
    const variant = VARIANTS[index % VARIANTS.length];
    return { voice: null, rate: variant.rate, pitch: variant.pitch };
  }
  const voice = pool[index % pool.length];
  const variant = VARIANTS[Math.floor(index / pool.length) % VARIANTS.length];
  return { voice, rate: variant.rate, pitch: variant.pitch };
}
