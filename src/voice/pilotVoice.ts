import type { RadioEffects } from './audio/radioEffects.ts';
import type { VoiceSettingsStore } from './settings.ts';
import { createTransmissionQueue } from './transmissionQueue.ts';
import type { TransmissionEvent, TransmissionQueue } from './transmissionQueue.ts';
import type { SpeechSynthesisProvider } from './tts/types.ts';

export interface PilotVoiceOptions {
  tts: SpeechSynthesisProvider;
  settings: VoiceSettingsStore;
  radio?: RadioEffects;
  monitoredFrequencyMhz?: number;
  onEvent?: (e: TransmissionEvent) => void;
}

/**
 * Convenience wiring: TransmissionQueue + TTS + radio clicks, honouring the
 * user's `ttsEnabled` / `radioEffectsEnabled` / `ttsVolume` / `ttsRate` settings.
 * Feed it `enqueue({text, voiceId, frequencyMhz})` for each engine pilot readback.
 */
export function createPilotVoice(options: PilotVoiceOptions): TransmissionQueue {
  const { tts, settings, radio } = options;
  const syncRadio = () => radio?.setEnabled(settings.get().radioEffectsEnabled);
  syncRadio();
  settings.subscribe(syncRadio);

  const queue = createTransmissionQueue({
    monitoredFrequencyMhz: options.monitoredFrequencyMhz,
    onEvent: options.onEvent,
    radio: radio ? { playPttOpen: () => radio.playPttOpen(), playPttClose: () => radio.playPttClose() } : undefined,
    speaker: {
      speak(item) {
        const s = settings.get();
        if (!s.ttsEnabled) return Promise.resolve();
        return tts.speak({ text: item.text, voiceId: item.voiceId, rate: s.ttsRate, volume: s.ttsVolume });
      },
      cancel: () => tts.cancel(),
    },
  });
  return queue;
}
