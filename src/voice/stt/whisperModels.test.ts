import { afterEach, describe, expect, it } from 'vitest';
import { hasWebGpu, markWebGpuFailed, resolveWhisper, WHISPER_MODELS } from './whisperModels.ts';

afterEach(() => markWebGpuFailed(false));

describe('hasWebGpu', () => {
  it('detects navigator.gpu', () => {
    expect(hasWebGpu({ gpu: {} })).toBe(true);
    expect(hasWebGpu({})).toBe(false);
    expect(hasWebGpu(undefined)).toBe(false);
  });
});

describe('resolveWhisper', () => {
  it('auto with WebGPU = small.en on the GPU (fp32 encoder, q4 decoder)', () => {
    const r = resolveWhisper('auto', 'auto', { gpu: true });
    expect(r).toMatchObject({ size: 'small.en', hfId: 'onnx-community/whisper-small.en', device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } });
  });

  it('auto without WebGPU = base.en on WebAssembly (q8)', () => {
    const r = resolveWhisper('auto', 'auto', { gpu: false });
    expect(r).toMatchObject({ size: 'base.en', hfId: 'onnx-community/whisper-base.en', device: 'wasm', dtype: 'q8', mb: 77 });
  });

  it('honours explicit choices; tiny.en stays selectable; webgpu without a GPU degrades to wasm', () => {
    expect(resolveWhisper('tiny.en', 'auto', { gpu: true })).toMatchObject({ size: 'tiny.en', device: 'webgpu' });
    expect(resolveWhisper('auto', 'wasm', { gpu: true })).toMatchObject({ size: 'base.en', device: 'wasm' });
    expect(resolveWhisper('small.en', 'wasm', { gpu: true })).toMatchObject({ size: 'small.en', device: 'wasm', mb: 250 });
    expect(resolveWhisper('base.en', 'webgpu', { gpu: false })).toMatchObject({ device: 'wasm' });
  });

  it('after a WebGPU failure keeps the same model but runs on wasm', () => {
    const r = resolveWhisper('auto', 'auto', { gpu: true, webGpuFailed: true });
    expect(r).toMatchObject({ size: 'small.en', device: 'wasm', requestedDevice: 'webgpu', dtype: 'q8' });
    markWebGpuFailed();
    expect(resolveWhisper('auto', 'auto', { gpu: true }).device).toBe('wasm');
  });

  it('lists sizes of 40 / 77 / 250 MB on the CPU', () => {
    expect([WHISPER_MODELS['tiny.en'].mb.wasm, WHISPER_MODELS['base.en'].mb.wasm, WHISPER_MODELS['small.en'].mb.wasm]).toEqual([40, 77, 250]);
  });
});
