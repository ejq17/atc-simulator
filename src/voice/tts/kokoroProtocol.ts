/**
 * Message protocol between the neural TTS synthesiser (main thread) and kokoroWorker.ts. Kept free of kokoro-js imports so
 * the main bundle never pulls the library in just to talk to the worker.
 */

export type KokoroDevice = 'wasm' | 'webgpu';
export type KokoroDtype = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';

export interface KokoroLoadRequest { type: 'load'; model: string; device: KokoroDevice; dtype: KokoroDtype }
export interface KokoroGenerateRequest { type: 'generate'; id: number; text: string; voice: string; speed: number }
export type KokoroWorkerRequest = KokoroLoadRequest | KokoroGenerateRequest;

export type KokoroWorkerEvent =
  | { type: 'progress'; info: Record<string, unknown> }
  | { type: 'ready'; device: KokoroDevice; dtype: KokoroDtype }
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number; genMs: number }
  | { type: 'error'; id?: number; stage: 'import' | 'load' | 'generate'; message: string };

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export type NeuralEngineId = 'kokoro' | 'piper';

/** Piper voice used on the WebAssembly device: en_US libritts_r medium (904 speakers, 79 MB, dataset licence CC BY 4.0). */
export const PIPER_MODEL_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/libritts_r/medium/en_US-libritts_r-medium.onnx';
export const PIPER_CONFIG_URL = `${PIPER_MODEL_URL}.json`;
