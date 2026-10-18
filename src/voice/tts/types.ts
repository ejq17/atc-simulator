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
  /** Who is speaking (a callsign, or a controller position such as "TWR"): seeds the neural voice and radio character. Browser TTS ignores it. */
  callsign?: string;
  speakerKind?: 'airline' | 'ga' | 'controller';
  /** Distance of the transmitting aircraft from the airport in nautical miles: weak, scratchy signal when far. Unknown = clear. */
  distanceNm?: number;
  /** Neural engine only: called once, right before the first sound (voice or fallback), so the PTT click lands with the carrier. */
  onKeyUp?: () => void;
  onStart?: () => void;
  onEnd?: () => void;
}

/** Swap browser TTS for a cloud provider later by implementing this interface. */
export interface SpeechSynthesisProvider {
  /** Resolves when speech ends or is cancelled. Never rejects for cancellation. */
  speak(req: SpeakRequest): Promise<void>;
  cancel(): void;
  listVoices(): VoiceInfo[];
  /** Optional: begin preparing a request that will be spoken soon (the neural engine synthesises it ahead of time). */
  prepare?(req: SpeakRequest): void;
  /** True when this provider calls `onKeyUp` itself (the transmission queue then does not play the PTT-open click at dequeue time). */
  keysOnStart?(): boolean;
}
