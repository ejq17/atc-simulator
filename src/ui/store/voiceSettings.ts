import { useSyncExternalStore } from 'react';
import { getSharedVoiceSettingsStore } from '../../voice';
import type { VoiceSettings } from '../../voice';

/** One persisted voice-settings store for the whole app (localStorage `kacy.voice.settings`). */
export const voiceSettings = getSharedVoiceSettingsStore();

export function useVoiceSettings(): VoiceSettings {
  return useSyncExternalStore(
    (cb) => voiceSettings.subscribe(cb),
    () => voiceSettings.get(),
    () => voiceSettings.get(),
  );
}
