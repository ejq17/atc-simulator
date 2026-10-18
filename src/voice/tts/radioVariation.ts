/**
 * Per-aircraft voice and radio variation for the neural TTS, derived deterministically from the callsign (the audio layer's
 * own seeded randomness; nothing here touches the simulation).
 *
 * Everything is kept subtle on purpose: the words must stay intelligible on a headset. The ranges below are design choices,
 * not measurements of real radios.
 */
import { hashString } from './voiceAssignment.ts';

export type SpeakerKind = 'airline' | 'ga' | 'controller';

/** Per-aircraft radio character before distance is applied. */
export interface RadioProfile {
  /** Low cut of this transmitter inside the shared 300 to 3000 Hz chain. */
  highpassHz: number;
  /** High cut of this transmitter. */
  lowpassHz: number;
  /** Carrier noise level at full signal quality (linear gain of unit white noise). */
  noiseFloor: number;
  compThresholdDb: number;
  compRatio: number;
  /** Input drive into the soft clipper (1 = clean). */
  drive: number;
  /** Probability (0..1) that a given transmission is mildly over-modulated. */
  overmodChance: number;
  /** Squelch tail after release. */
  tailMs: number;
}

export interface NeuralVoiceProfile {
  kind: SpeakerKind;
  /** Kokoro voice id (WebGPU engine). */
  voice: string;
  /** Piper speaker id in libritts_r (WebAssembly engine). */
  piperSid: number;
  /** Speed multiplier handed to the model. */
  rate: number;
  /** Playback pitch shift in cents (applied with playbackRate, rate is compensated so tempo stays put). */
  pitchCents: number;
  radio: RadioProfile;
}

/** What the audio graph is built from: a profile with distance and over-modulation applied. */
export interface RadioConditions extends RadioProfile {
  /** 1 = clear, towards 0 = weak and scratchy. */
  quality: number;
  /** Level multiplier (weak signals are quieter). */
  gain: number;
  /** Depth of the fading flutter on the speech (0 = none). */
  flutterDepth: number;
  overmodulated: boolean;
}

/** Pilot voices, best Kokoro quality grades first (kokoro-js voice table). Mixed gender, US and UK English. */
export const PILOT_VOICES: readonly string[] = [
  'af_heart', 'am_fenrir', 'af_bella', 'am_puck', 'af_nicole', 'af_kore', 'bf_emma', 'af_sarah', 'bm_fable',
];

/** Controller voices, kept apart from the pilot pool. One stable voice per position. */
export const CONTROLLER_VOICES: readonly string[] = ['am_michael', 'bm_george'];

/**
 * Piper libritts_r speaker ids. 904 speakers exist; these were picked by a Whisper transcription of a sample from every 25th
 * speaker (clean, correctly transcribed "Cessna 723 Echo Juliet") with a crude pitch estimate to mix male and female voices.
 */
export const PIPER_PILOT_SIDS: readonly number[] = [125, 275, 325, 525, 700, 725, 825, 850, 50];
export const PIPER_CONTROLLER_SIDS: readonly number[] = [200, 800];

/** Speaking-speed ranges (model `speed`). Airline crews are brisker; GA pilots vary more and run a little slower. */
export const RATE_RANGE: Readonly<Record<SpeakerKind, readonly [number, number]>> = {
  airline: [1.04, 1.18],
  ga: [0.92, 1.08],
  controller: [1.06, 1.06],
};

/** Playback pitch shift range in cents (about plus or minus 5 %). */
export const PITCH_CENTS_RANGE = 85;

/** Full-signal distance, and the distance at which reception bottoms out (nautical miles). */
export const CLEAR_NM = 10;
export const WEAK_NM = 40;

/** Callsigns that start with N followed by a digit are US general-aviation registrations; the rest are airline-style. */
export function classifyCallsign(callsign: string): SpeakerKind {
  return /^N\d/i.test(callsign.trim()) ? 'ga' : 'airline';
}

/** Small deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function assignNeuralProfile(callsign: string, kind: SpeakerKind = classifyCallsign(callsign)): NeuralVoiceProfile {
  const key = callsign.trim().toUpperCase();
  const rnd = seededRandom(hashString(`radio:${kind}:${key}`));
  if (kind === 'controller') {
    // A controller's station is a good transmitter: clean bandwidth, little noise, no clipping.
    const voice = CONTROLLER_VOICES[hashString(key) % CONTROLLER_VOICES.length];
    const piperSid = PIPER_CONTROLLER_SIDS[hashString(key) % PIPER_CONTROLLER_SIDS.length];
    return {
      kind, voice, piperSid, rate: RATE_RANGE.controller[0], pitchCents: 0,
      radio: { highpassHz: 300, lowpassHz: 3000, noiseFloor: 0.0025, compThresholdDb: -22, compRatio: 4, drive: 1, overmodChance: 0, tailMs: 70 },
    };
  }
  const voice = PILOT_VOICES[hashString(`voice:${key}`) % PILOT_VOICES.length];
  const piperSid = PIPER_PILOT_SIDS[hashString(`voice:${key}`) % PIPER_PILOT_SIDS.length];
  const [r0, r1] = RATE_RANGE[kind];
  const rate = round(lerp(r0, r1, rnd()), 3);
  const pitchCents = Math.round((rnd() * 2 - 1) * PITCH_CENTS_RANGE);
  // Airline radios are well kept; GA radios are more varied (older sets, handhelds, headset mics).
  const spread = kind === 'ga' ? 1 : 0.5;
  const radio: RadioProfile = {
    highpassHz: Math.round(lerp(300, 300 + 220 * spread, rnd())),
    lowpassHz: Math.round(lerp(3000, 3000 - 800 * spread, rnd())),
    noiseFloor: round(lerp(0.003, 0.003 + 0.008 * spread, rnd()), 4),
    compThresholdDb: round(lerp(-26, -20, rnd()), 1),
    compRatio: round(lerp(3, 6, rnd()), 1),
    drive: round(lerp(1.1, 1.1 + 0.5 * spread, rnd()), 2),
    overmodChance: round(lerp(0.04, 0.04 + 0.18 * spread, rnd()), 3),
    tailMs: Math.round(lerp(60, 60 + 100 * spread, rnd())),
  };
  return { kind, voice, piperSid, rate, pitchCents, radio };
}

/** 1 within CLEAR_NM of the field, falling smoothly to 0.08 at WEAK_NM and beyond. Unknown distance counts as clear. */
export function signalQuality(distanceNm: number | undefined): number {
  if (distanceNm === undefined || !Number.isFinite(distanceNm)) return 1;
  const t = Math.min(1, Math.max(0, (distanceNm - CLEAR_NM) / (WEAK_NM - CLEAR_NM)));
  const s = t * t * (3 - 2 * t);
  return round(1 - 0.92 * s, 4);
}

/** Whether one specific transmission is mildly over-modulated: deterministic in callsign and text. */
export function isOvermodulated(callsign: string, text: string, chance: number): boolean {
  if (chance <= 0) return false;
  const r = seededRandom(hashString(`overmod:${callsign.trim().toUpperCase()}:${text}`))();
  return r < chance;
}

/**
 * Turn a profile into the numbers the audio graph uses for one transmission. Distance narrows the band, raises the noise,
 * lowers the level and adds fading flutter, but never past the floors below so speech stays understandable.
 */
export function radioConditions(profile: RadioProfile, o: { distanceNm?: number; overmodulated?: boolean } = {}): RadioConditions {
  const q = signalQuality(o.distanceNm);
  const weak = 1 - q;
  const over = o.overmodulated === true;
  return {
    ...profile,
    highpassHz: Math.round(lerp(profile.highpassHz, Math.max(profile.highpassHz, 420), weak)),
    lowpassHz: Math.round(lerp(profile.lowpassHz, Math.min(profile.lowpassHz, 2300), weak)),
    noiseFloor: round(lerp(profile.noiseFloor, 0.026, weak), 4),
    drive: over ? round(Math.max(profile.drive, 1) * 1.45, 2) : profile.drive,
    quality: q,
    gain: round(lerp(1, 0.62, weak), 3),
    flutterDepth: round(0.3 * weak * weak, 3),
    overmodulated: over,
  };
}

function round(n: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}
