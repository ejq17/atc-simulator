export interface VoiceInfo {
  /** Stable identifier (SpeechSynthesisVoice.voiceURI). */
  id: string;
  name: string;
  lang: string;
  localService: boolean;
  isDefault: boolean;
}

export interface SpeakRequest {
  text: string;
  /** Aircraft voice id (e.g. "v3"); mapped deterministically to a voice + rate/pitch. */
  voiceId: string;
  /** Extra rate multiplier on top of the pilot's own rate (user setting). */
  rate?: number;
  pitch?: number;
  /** 0..1 */
  volume?: number;
  onStart?: () => void;
  onEnd?: () => void;
}

/** Swap browser TTS for a cloud provider later by implementing this interface. */
export interface SpeechSynthesisProvider {
  /** Resolves when speech ends or is cancelled. Never rejects for cancellation. */
  speak(req: SpeakRequest): Promise<void>;
  cancel(): void;
  listVoices(): VoiceInfo[];
}
