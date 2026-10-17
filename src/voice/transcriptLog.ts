import type { VoiceSettingsStore } from './settings.ts';

export interface TranscriptEntry {
  at: number;
  text: string;
  source: 'speech' | 'typed' | 'pilot' | 'ai';
  confidence?: number;
}

export const TRANSCRIPT_STORAGE_KEY = 'kacy.voice.transcripts';
const MAX_ENTRIES = 300;

export interface TranscriptLog {
  add(entry: Omit<TranscriptEntry, 'at'> & { at?: number }): void;
  entries(): readonly TranscriptEntry[];
  clear(): void;
}

/**
 * In-memory session log. Persists to localStorage only while
 * `settings.storeTranscripts` is true; turning it off erases stored copies.
 */
export function createTranscriptLog(settings: VoiceSettingsStore, storage?: Storage): TranscriptLog {
  let items: TranscriptEntry[] = [];
  const store = (): Storage | undefined => {
    if (storage) return storage;
    try {
      return typeof localStorage !== 'undefined' ? localStorage : undefined;
    } catch {
      return undefined;
    }
  };
  const persist = () => {
    try {
      const s = store();
      if (!s) return;
      if (settings.get().storeTranscripts) s.setItem(TRANSCRIPT_STORAGE_KEY, JSON.stringify(items));
      else s.removeItem(TRANSCRIPT_STORAGE_KEY);
    } catch { /* ignore */ }
  };
  settings.subscribe(persist);
  // Restore earlier sessions only when the user opted in.
  if (settings.get().storeTranscripts) {
    try {
      const raw = store()?.getItem(TRANSCRIPT_STORAGE_KEY);
      if (raw) items = (JSON.parse(raw) as TranscriptEntry[]).slice(-MAX_ENTRIES);
    } catch { /* ignore */ }
  } else {
    persist(); // make sure nothing stale is left behind
  }
  return {
    add(entry) {
      items.push({ ...entry, at: entry.at ?? Date.now() });
      if (items.length > MAX_ENTRIES) items = items.slice(-MAX_ENTRIES);
      persist();
    },
    entries: () => items,
    clear() {
      items = [];
      try { store()?.removeItem(TRANSCRIPT_STORAGE_KEY); } catch { /* ignore */ }
    },
  };
}
