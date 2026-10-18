/**
 * Message protocol between the local Whisper provider (main thread) and whisperWorker.ts, plus the pieces both sides
 * share. Kept free of transformers.js imports so the main bundle never pulls the library in just to talk to the worker.
 */
import { SttError } from './types.ts';

export interface WhisperLoadRequest { type: 'load'; model: string; device: string; dtype: string | Record<string, string> }
export interface WhisperTranscribeRequest {
  type: 'transcribe';
  id: number;
  /** 16 kHz mono float samples; the buffer is transferred (the sender must not touch it afterwards). */
  audio: Float32Array;
  call: Record<string, unknown>;
}
export type WhisperWorkerRequest = WhisperLoadRequest | WhisperTranscribeRequest;

export type WhisperWorkerEvent =
  | { type: 'progress'; info: Record<string, unknown> }
  | { type: 'ready' }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id?: number; stage: 'import' | 'pipeline' | 'transcribe'; message: string };

export const isEnglishOnly = (model: string) => model.endsWith('.en');

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Translate a pipeline-construction failure into a user-facing SttError. */
export function mapPipelineError(cause: unknown, model: string): SttError {
  const text = errorText(cause);
  const offline = /failed to fetch|fetch failed|networkerror|network|load failed|could not locate|\b(?:401|403|404|5\d\d)\b|cors|huggingface/i.test(text);
  return new SttError(
    offline ? 'network' : 'unsupported',
    offline
      ? `Could not download the local speech model (${model}) from huggingface.co. Check your internet connection and try “Download / prepare local model” again. (${text})`
      : `The local speech model could not start in this browser (WebAssembly/WebGPU problem). (${text})`,
    { cause },
  );
}

export function importError(cause: unknown): SttError {
  return new SttError('network', 'Could not load the local speech engine code. Check your connection and reload the page.', { cause });
}
