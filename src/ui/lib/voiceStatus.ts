import type { VoiceStatus, SttProviderId } from '../../voice';

export interface VoiceStatusView {
  /** Short badge text. */
  badge: string;
  /** Sentence for the radio panel. */
  text: string;
  tone: 'ok' | 'live' | 'warn' | 'bad' | 'off';
}

/** Human-readable mic/voice status for the radio panel. */
export function describeVoiceStatus(status: VoiceStatus, providerId: SttProviderId, message?: string, pttKeyLabel = 'SPACE'): VoiceStatusView {
  if (providerId === 'none') {
    return { badge: 'VOICE OFF', text: 'Speech input is off. Type your transmissions below.', tone: 'off' };
  }
  switch (status) {
    case 'unsupported':
      return { badge: 'UNAVAILABLE', text: `${message ?? 'Speech recognition is not available in this browser.'} Use the typed command box, or pick another provider in Settings.`, tone: 'bad' };
    case 'permission_denied':
      return { badge: 'MIC BLOCKED', text: 'Microphone permission was denied. Allow microphone access for this site in the browser address bar, then try again. Typed commands still work.', tone: 'bad' };
    case 'listening':
      return { badge: 'TRANSMITTING', text: 'Listening: release the key to send.', tone: 'live' };
    case 'processing':
      return { badge: 'TRANSCRIBING', text: 'Transcribing your transmission…', tone: 'warn' };
    case 'error':
      return { badge: 'ERROR', text: message ? `Voice input error: ${message}` : 'Voice input failed. Try again or type the transmission.', tone: 'bad' };
    case 'idle':
    default:
      return { badge: 'READY', text: message ? message : `Microphone ready: hold ${pttKeyLabel} to transmit.`, tone: 'ok' };
  }
}

/** Friendly label for a KeyboardEvent.code / key. */
export function keyLabel(key: string): string {
  if (key === 'Space') return 'SPACE';
  if (key.startsWith('Key')) return key.slice(3);
  if (key.startsWith('Digit')) return key.slice(5);
  return key.toUpperCase();
}
