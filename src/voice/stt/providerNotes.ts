import type { SttProviderId } from './types.ts';

export interface SttProviderNote {
  id: SttProviderId;
  label: string;
  /** One-line description for the settings dropdown. */
  summary: string;
  /** Plain-language statement of where microphone audio is sent. */
  audioGoesTo: string;
  cost: string;
}

/**
 * Settings-screen copy for each recognition provider. The Web Speech entry
 * must keep saying that Chrome sends audio to Google: the implementation is
 * server-side in Chrome and we do not control it.
 */
export const STT_PROVIDER_NOTES: Record<SttProviderId, SttProviderNote> = {
  webspeech: {
    id: 'webspeech',
    label: 'Browser speech recognition (Web Speech API)',
    summary: 'Free, no setup. Works best in Chrome and Edge. General-purpose model, so callsigns and phonetics can be misheard.',
    audioGoesTo:
      'In Chrome and Edge, the browser streams your microphone audio to Google (Chrome) or Microsoft (Edge) servers for recognition while you hold the push-to-talk key. This simulator does not receive or store that audio. Safari uses Apple on-device or server recognition depending on settings.',
    cost: 'Free.',
  },
  deepgram: {
    id: 'deepgram',
    label: 'Deepgram (streaming, aviation vocabulary boosting)',
    summary: 'Higher accuracy for callsigns, phonetic letters and numbers. Needs a Deepgram API key on the local server.',
    audioGoesTo:
      'While you hold push-to-talk, your microphone audio is streamed directly from your browser to Deepgram (api.deepgram.com) over an encrypted WebSocket. Your API key never reaches the browser; the local server hands out a short-lived token. Deepgram bills per audio minute streamed.',
    cost: 'Pay as you go, billed by Deepgram per streamed minute (see src/voice/README.md).',
  },
  none: {
    id: 'none',
    label: 'Off (typed commands only)',
    summary: 'No microphone use. Type transmissions into the command box.',
    audioGoesTo: 'No audio is captured.',
    cost: 'Free.',
  },
};
