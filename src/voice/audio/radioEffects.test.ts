import { describe, expect, it } from 'vitest';
import { createRadioEffects } from './radioEffects.ts';

describe('radio effects', () => {
  it('is a safe no-op without WebAudio', () => {
    const fx = createRadioEffects({ contextFactory: () => null });
    expect(fx.isSupported()).toBe(false);
    expect(() => {
      fx.playPttOpen();
      fx.playPttClose();
      fx.startStatic();
      fx.stopStatic();
      fx.setMasterVolume(0.3);
      fx.setEnabled(false);
      fx.dispose();
    }).not.toThrow();
    expect(fx.getInputNode()).toBeNull();
  });

  it('does not create an audio context while disabled', () => {
    let created = 0;
    const fx = createRadioEffects({ enabled: false, contextFactory: () => (created++, null) });
    fx.playPttOpen();
    fx.startStatic();
    expect(created).toBe(0);
    expect(fx.isEnabled()).toBe(false);
  });
});
