import { describe, expect, it, vi } from 'vitest';
import type { RadioEffects } from '../audio/radioEffects.ts';
import { createEngineTts, radioOutputFor } from './engineTts.ts';
import type { NeuralTts } from './neuralTts.ts';
import type { SpeechSynthesisProvider } from './types.ts';

function provider() {
  return { speak: vi.fn(() => Promise.resolve()), cancel: vi.fn(), listVoices: () => [] } satisfies SpeechSynthesisProvider;
}
function neural() {
  return { speak: vi.fn(() => Promise.resolve()), cancel: vi.fn(), listVoices: () => [], prepare: vi.fn(), getStats: vi.fn(), reset: vi.fn() };
}

describe('engine selection', () => {
  it('speaks with the engine chosen at call time and cancels both', async () => {
    let engine: 'browser' | 'neural' = 'browser';
    const browser = provider();
    const n = neural();
    const tts = createEngineTts({ browser, neural: n as unknown as NeuralTts, getEngine: () => engine });
    await tts.speak({ text: 'a', voiceId: 'v1' });
    expect(browser.speak).toHaveBeenCalledTimes(1);
    expect(n.speak).not.toHaveBeenCalled();
    engine = 'neural';
    await tts.speak({ text: 'b', voiceId: 'v1' });
    expect(n.speak).toHaveBeenCalledTimes(1);
    tts.prepare?.({ text: 'c', voiceId: 'v1' });
    expect(n.prepare).toHaveBeenCalledTimes(1);
    engine = 'browser';
    tts.prepare?.({ text: 'd', voiceId: 'v1' });
    expect(n.prepare).toHaveBeenCalledTimes(1);
    tts.cancel();
    expect(browser.cancel).toHaveBeenCalled();
    expect(n.cancel).toHaveBeenCalled();
  });
});

describe('radio output routing', () => {
  const ctx = { destination: { id: 'speakers' } } as unknown as AudioContext;
  const input = { id: 'radio-in' } as unknown as AudioNode;
  const radio = (enabled: boolean, hasCtx = true): RadioEffects => ({
    isEnabled: () => enabled,
    getInputNode: () => (hasCtx ? input : null),
    getContext: () => (hasCtx ? ctx : null),
  }) as unknown as RadioEffects;

  it('plays into the radio chain when radio effects are on', () => {
    const out = radioOutputFor(radio(true))();
    expect(out?.destination).toBe(input);
    expect(out?.ctx).toBe(ctx);
  });

  it('plays straight to the speakers when radio effects are off', () => {
    const out = radioOutputFor(radio(false))();
    expect(out?.destination).toBe(ctx.destination);
  });

  it('reports no output when there is no audio context at all', () => {
    expect(radioOutputFor(radio(true, false))()).toBeNull();
  });
});
