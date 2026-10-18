import type { RadioEffects } from './audio/radioEffects.ts';
import type { VoiceSettingsStore } from './settings.ts';
import { createTransmissionQueue } from './transmissionQueue.ts';
import type { QueuedTransmission, TransmissionEvent, TransmissionQueue } from './transmissionQueue.ts';
import type { SpeechSynthesisProvider } from './tts/types.ts';

export interface PilotVoiceOptions {
  tts: SpeechSynthesisProvider;
  settings: VoiceSettingsStore;
  radio?: RadioEffects;
  monitoredFrequencyMhz?: number;
  /** All frequencies that are audible at once; wins over `monitoredFrequencyMhz`. */
  monitoredFrequenciesMhz?: number[];
  onEvent?: (e: TransmissionEvent) => void;
  /** Fires when the browser really starts / stops speaking a call (utterance `start` / `end`), for the "speaking" lamp. */
  onSpeaking?: (speaking: boolean, item: QueuedTransmission) => void;
}

/**
 * Convenience wiring: TransmissionQueue + TTS + radio clicks, honouring the
 * user's `ttsEnabled` / `radioEffectsEnabled` / `ttsVolume` / `ttsRate` settings.
 * Feed it `enqueue({text, voiceId, frequencyMhz})` for each engine pilot readback.
 *
 * With "Pilot audio" off (`ttsEnabled` false) nothing is queued, no radio clicks are made, and anything already speaking is cut.
 */
export function createPilotVoice(options: PilotVoiceOptions): TransmissionQueue {
  const { tts, settings, radio } = options;
  const syncRadio = () => radio?.setEnabled(settings.get().radioEffectsEnabled);
  syncRadio();

  const requestFor = (item: QueuedTransmission) => {
    const s = settings.get();
    return {
      text: item.text,
      voiceId: item.voiceId,
      rate: s.ttsRate,
      volume: Math.min(1, Math.max(0, s.ttsVolume * (item.volume ?? 1))),
      callsign: item.callsign ?? item.speaker ?? item.voiceId,
      speakerKind: item.speakerKind,
      distanceNm: item.distanceNm,
    };
  };

  const queue = createTransmissionQueue({
    monitoredFrequencyMhz: options.monitoredFrequencyMhz,
    monitoredFrequenciesMhz: options.monitoredFrequenciesMhz,
    onEvent: options.onEvent,
    radio: radio ? { playPttOpen: () => radio.playPttOpen(), playPttClose: () => radio.playPttClose() } : undefined,
    speaker: {
      keysItself: () => tts.keysOnStart?.() ?? false,
      speak(item, keyUp) {
        if (!settings.get().ttsEnabled) return Promise.resolve();
        return tts.speak({
          ...requestFor(item),
          onKeyUp: keyUp,
          onStart: () => options.onSpeaking?.(true, item),
          onEnd: () => options.onSpeaking?.(false, item),
        });
      },
      cancel: () => tts.cancel(),
      prepare: (item) => {
        if (settings.get().ttsEnabled) tts.prepare?.(requestFor(item));
      },
    },
  });
  const unsubscribe = settings.subscribe((s) => {
    syncRadio();
    if (!s.ttsEnabled) queue.clear();
  });
  return {
    ...queue,
    enqueue(item) {
      if (!settings.get().ttsEnabled) {
        options.onEvent?.({ type: 'dropped', item, reason: 'audio_off' });
        return false;
      }
      return queue.enqueue(item);
    },
    dispose() {
      unsubscribe();
      queue.dispose();
    },
  };
}
