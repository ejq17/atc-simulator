import { SttError } from './types.ts';

/** Map a getUserMedia rejection to an SttError with a message safe to show users. */
export function mapMediaError(err: unknown): SttError {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new SttError('not_allowed', 'Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.', { cause: err });
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
    return new SttError('no_microphone', 'No working microphone was found, or it is in use by another app.', { cause: err });
  }
  return new SttError('unknown', 'Could not open the microphone.', { cause: err });
}
