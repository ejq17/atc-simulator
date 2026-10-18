/**
 * Which on-device Whisper checkpoint and execution device to use. Pure functions, no transformers.js import, so
 * settings, the provider, the worker and the settings form can all share them.
 *
 * Sizes are the files transformers.js actually downloads (checked against huggingface.co, onnx/ folder):
 *  - WASM (CPU): encoder_model_quantized (q8) + decoder_model_merged_quantized (q8)
 *  - WebGPU:     encoder_model (fp32) + decoder_model_merged_q4  (the combination the transformers.js Whisper WebGPU
 *                demos use; q8 on WebGPU is unreliable)
 */
export type WhisperModelChoice = 'auto' | 'tiny.en' | 'base.en' | 'small.en';
export type WhisperDeviceChoice = 'auto' | 'wasm' | 'webgpu';
export type WhisperModelSize = Exclude<WhisperModelChoice, 'auto'>;
export type WhisperDevice = Exclude<WhisperDeviceChoice, 'auto'>;

export const WHISPER_MODEL_CHOICES: readonly WhisperModelChoice[] = ['auto', 'tiny.en', 'base.en', 'small.en'];
export const WHISPER_DEVICE_CHOICES: readonly WhisperDeviceChoice[] = ['auto', 'wasm', 'webgpu'];

export interface WhisperModelInfo {
  size: WhisperModelSize;
  /** Hugging Face repository id. */
  hfId: string;
  /** Approximate one-time download in MB, per device. */
  mb: Record<WhisperDevice, number>;
  /** One-line accuracy/speed hint for the settings form. */
  hint: string;
}

export const WHISPER_MODELS: Readonly<Record<WhisperModelSize, WhisperModelInfo>> = {
  'tiny.en': { size: 'tiny.en', hfId: 'onnx-community/whisper-tiny.en', mb: { wasm: 40, webgpu: 120 }, hint: 'Fastest, least accurate. Often garbles callsigns and phonetics.' },
  'base.en': { size: 'base.en', hfId: 'onnx-community/whisper-base.en', mb: { wasm: 77, webgpu: 206 }, hint: 'Good balance on a CPU. Much better on callsigns and numbers than tiny.' },
  'small.en': { size: 'small.en', hfId: 'onnx-community/whisper-small.en', mb: { wasm: 250, webgpu: 586 }, hint: 'Most accurate. Best on a GPU; on a CPU it is several seconds per call.' },
};

export const DEFAULT_WHISPER_MODEL_SIZE: WhisperModelSize = 'base.en';

export function hasWebGpu(nav: unknown = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  return !!nav && typeof nav === 'object' && !!(nav as { gpu?: unknown }).gpu;
}

/** Session-wide memory of a WebGPU failure (load or first decode): later resolutions use WASM without retrying. */
let webGpuFailed = false;
export const isWebGpuMarkedFailed = () => webGpuFailed;
export function markWebGpuFailed(failed = true): void {
  webGpuFailed = failed;
}

/** The device the user asked for, with 'auto' resolved (WebGPU when the browser has it). Ignores the session fallback. */
export function requestedWhisperDevice(choice: WhisperDeviceChoice, gpu: boolean = hasWebGpu()): WhisperDevice {
  if (choice === 'wasm') return 'wasm';
  if (choice === 'webgpu') return gpu ? 'webgpu' : 'wasm';
  return gpu ? 'webgpu' : 'wasm';
}

/** 'auto' model: small.en on WebGPU (fast enough), base.en otherwise. */
export function resolveWhisperModelSize(choice: WhisperModelChoice, device: WhisperDevice): WhisperModelSize {
  if (choice !== 'auto') return choice;
  return device === 'webgpu' ? 'small.en' : DEFAULT_WHISPER_MODEL_SIZE;
}

/** dtype per device: q8 for WASM; fp32 encoder + q4 merged decoder for WebGPU. */
export function whisperDtype(device: WhisperDevice): string | Record<string, string> {
  return device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';
}

export interface ResolvedWhisper {
  size: WhisperModelSize;
  hfId: string;
  /** Device that will actually be used (after the session fallback). */
  device: WhisperDevice;
  /** Device the settings asked for (differs from `device` after a WebGPU fallback). */
  requestedDevice: WhisperDevice;
  mb: number;
  dtype: string | Record<string, string>;
}

export function resolveWhisper(
  modelChoice: WhisperModelChoice,
  deviceChoice: WhisperDeviceChoice,
  opts: { gpu?: boolean; webGpuFailed?: boolean } = {},
): ResolvedWhisper {
  const requestedDevice = requestedWhisperDevice(deviceChoice, opts.gpu);
  const size = resolveWhisperModelSize(modelChoice, requestedDevice);
  const device: WhisperDevice = requestedDevice === 'webgpu' && (opts.webGpuFailed ?? webGpuFailed) ? 'wasm' : requestedDevice;
  const info = WHISPER_MODELS[size];
  return { size, hfId: info.hfId, device, requestedDevice, mb: info.mb[device], dtype: whisperDtype(device) };
}

export const deviceLabel = (d: WhisperDevice) => (d === 'webgpu' ? 'WebGPU' : 'WebAssembly (CPU)');
