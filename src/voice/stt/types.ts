/**
 * Speech-to-text provider abstraction.
 *
 * Everything outside src/voice/stt talks only to these types, so the
 * transcription engine can be swapped (Web Speech, Deepgram, a future local
 * Whisper) without touching the controller, parser or UI.
 */

export type SttProviderId = 'webspeech' | 'deepgram' | 'whisper-local' | 'none';

export interface SttFinalMeta {
  /** 0..1 when the engine reports it. */
  confidence?: number;
  /** Wall-clock length of the capture, in milliseconds. */
  durationMs: number;
}

export interface SttStartOptions {
  /** Called with the best running transcript (interim). */
  onPartial(text: string): void;
  /** Called once per capture, after stop(), with the full transcript. */
  onFinal(text: string, meta: SttFinalMeta): void;
  /** Called on any failure. `SttError.code` classifies it when available. */
  onError(err: Error): void;
}

export interface SpeechRecognitionProvider {
  readonly id: SttProviderId;
  readonly label: string;
  isAvailable(): Promise<boolean>;
  /** Begin capturing. Resolves once the microphone is live. */
  start(opts: SttStartOptions): Promise<void>;
  /** Stop capturing; the provider then delivers onFinal (or onError). */
  stop(): Promise<void>;
  /**
   * How long the controller waits for the final transcript after PTT release (ms). Batch providers that
   * transcribe on stop() (local Whisper) need far longer than the 2.5 s streaming default.
   */
  readonly finalTimeoutMs?: number;
  /**
   * Optional: get ready for the next start() (build audio graphs, open sockets). Called when the provider is selected.
   * Must NOT open the microphone or download anything large; failures are ignored.
   */
  prepare?(): Promise<void>;
  /** Optional: release anything prepare()/start() kept alive. Called when the voice controller is disposed. */
  dispose?(): Promise<void>;
  /**
   * A fixed progress string this provider sends through onPartial ("Transcribing...") that is NOT part of the
   * transcript. The controller shows it but never submits it as a transmission.
   */
  readonly placeholderPartial?: string;
}

/** What the UI should show for the push-to-talk / voice subsystem. */
export type VoiceStatus =
  | 'unsupported'
  | 'permission_denied'
  | 'idle'
  | 'listening'
  | 'processing'
  | 'error';

export type SttErrorCode =
  | 'not_allowed' // mic permission denied
  | 'no_microphone' // no capture device / device busy
  | 'no_speech' // nothing intelligible was heard
  | 'network' // recognition service unreachable
  | 'unsupported' // API missing in this browser
  | 'unavailable' // provider not configured (e.g. no Deepgram key on server)
  | 'unknown';

/** Error with a machine-readable code and a message safe to show users. */
export class SttError extends Error {
  readonly code: SttErrorCode;
  constructor(code: SttErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SttError';
    this.code = code;
  }
}

export function sttErrorCode(err: unknown): SttErrorCode {
  return err instanceof SttError ? err.code : 'unknown';
}
