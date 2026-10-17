import type { SpeechRecognitionProvider } from './types.ts';
import { SttError } from './types.ts';

/** Placeholder used when speech input is off: only typed commands work. */
export function createNoneProvider(): SpeechRecognitionProvider {
  return {
    id: 'none',
    label: 'Off (typed commands only)',
    async isAvailable() {
      return false;
    },
    async start() {
      throw new SttError('unavailable', 'Speech input is turned off. Type your transmission instead.');
    },
    async stop() {},
  };
}
