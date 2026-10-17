import type { PttMode } from './ptt.ts';
import type { SttProviderId } from './stt/types.ts';

export const VOICE_SETTINGS_KEY = 'kacy.voice.settings';

/** Volume multiplier for traffic heard only because "Monitor all frequencies" is on (frequencies the player does not work). */
export const MONITOR_ALL_VOLUME = 0.45;

export interface VoiceSettings {
  providerId: SttProviderId;
  pttKey: string;
  pttMode: PttMode;
  /** "Pilot audio": speak pilot (and monitored AI controller) transmissions. */
  ttsEnabled: boolean;
  /** Hear every frequency in the session, including AI-worked positions the player does not work (at reduced volume). Default: own frequencies only. */
  monitorAll: boolean;
  radioEffectsEnabled: boolean;
  /** 0..1 */
  ttsVolume: number;
  /** Multiplier on each pilot's base rate, 0.5..2 */
  ttsRate: number;
  /** When false (default) nothing is persisted beyond the in-memory session log. */
  storeTranscripts: boolean;
}

export const DEFAULT_VOICE_SETTINGS: Readonly<VoiceSettings> = Object.freeze({
  providerId: 'webspeech',
  pttKey: 'Space',
  pttMode: 'hold',
  ttsEnabled: true,
  monitorAll: false,
  radioEffectsEnabled: true,
  ttsVolume: 1,
  ttsRate: 1,
  storeTranscripts: false,
});

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** Coerce arbitrary stored JSON into a valid settings object. */
export function sanitizeVoiceSettings(raw: unknown): VoiceSettings {
  const d = DEFAULT_VOICE_SETTINGS;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const provider: SttProviderId =
    r.providerId === 'webspeech' || r.providerId === 'deepgram' || r.providerId === 'whisper-local' || r.providerId === 'none' ? r.providerId : d.providerId;
  return {
    providerId: provider,
    pttKey: typeof r.pttKey === 'string' && r.pttKey.length > 0 && r.pttKey.length <= 32 ? r.pttKey : d.pttKey,
    pttMode: r.pttMode === 'toggle' || r.pttMode === 'hold' ? r.pttMode : d.pttMode,
    ttsEnabled: typeof r.ttsEnabled === 'boolean' ? r.ttsEnabled : d.ttsEnabled,
    monitorAll: typeof r.monitorAll === 'boolean' ? r.monitorAll : d.monitorAll,
    radioEffectsEnabled: typeof r.radioEffectsEnabled === 'boolean' ? r.radioEffectsEnabled : d.radioEffectsEnabled,
    ttsVolume: clamp(r.ttsVolume, 0, 1, d.ttsVolume),
    ttsRate: clamp(r.ttsRate, 0.5, 2, d.ttsRate),
    storeTranscripts: typeof r.storeTranscripts === 'boolean' ? r.storeTranscripts : d.storeTranscripts,
  };
}

function getStorage(storage?: Storage): Storage | undefined {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined; // access can throw in private/blocked contexts
  }
}

export function loadVoiceSettings(storage?: Storage): VoiceSettings {
  try {
    const raw = getStorage(storage)?.getItem(VOICE_SETTINGS_KEY);
    return sanitizeVoiceSettings(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

export function saveVoiceSettings(settings: VoiceSettings, storage?: Storage): void {
  try {
    getStorage(storage)?.setItem(VOICE_SETTINGS_KEY, JSON.stringify(sanitizeVoiceSettings(settings)));
  } catch {
    /* quota or blocked storage: settings stay in memory only */
  }
}

export interface VoiceSettingsStore {
  get(): VoiceSettings;
  update(patch: Partial<VoiceSettings>): VoiceSettings;
  reset(): VoiceSettings;
  subscribe(listener: (s: VoiceSettings) => void): () => void;
}

export function createVoiceSettingsStore(storage?: Storage): VoiceSettingsStore {
  let current = loadVoiceSettings(storage);
  const listeners = new Set<(s: VoiceSettings) => void>();
  const commit = (next: VoiceSettings) => {
    current = next;
    saveVoiceSettings(current, storage);
    listeners.forEach((l) => l(current));
    return current;
  };
  return {
    get: () => current,
    update: (patch) => commit(sanitizeVoiceSettings({ ...current, ...patch })),
    reset: () => commit({ ...DEFAULT_VOICE_SETTINGS }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Settings-screen privacy copy: what audio goes where, per provider. */
export const VOICE_PRIVACY_NOTES = {
  headline: 'Your voice is only captured while you hold the push-to-talk key. Recordings are never saved.',
  recordings:
    'This simulator never records, stores or uploads audio files. Microphone audio is streamed live to the recognition provider you pick and discarded; only the resulting text is used.',
  providers: {
    webspeech:
      'Browser speech recognition: Chrome sends your microphone audio to Google servers for recognition (Edge sends it to Microsoft). The simulator itself never sees or keeps that audio. Use Deepgram or typed commands if that is not acceptable to you.',
    deepgram:
      'Deepgram: audio streams from your browser straight to Deepgram (api.deepgram.com) over an encrypted connection while you hold the key. Deepgram processes it under your own account and its terms; the simulator server only hands out short-lived tokens and never receives the audio.',
    'whisper-local':
      'Local Whisper: the speech model runs inside this browser tab on your computer. Your voice is never uploaded or sent anywhere, not even to the simulator server. The only downloads are the model files (about 40 MB, once, from huggingface.co) and the WebAssembly runtime (from cdn.jsdelivr.net); no audio is part of either request. After that it works offline.',
    none: 'Off: the microphone is never opened. Type your transmissions.',
  },
  transcripts:
    'Transcript text is kept in memory for the current session so you can review it in the debrief. It is only saved to this browser (localStorage) if you turn on "Store transcripts", and you can clear it at any time.',
  analytics: 'There is no analytics or third-party tracking in the voice system.',
} as const;
