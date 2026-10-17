import { describe, expect, it } from 'vitest';
import { INPUT_DEVICE_STORAGE_KEY, preferredInputDeviceId, withPreferredInput } from './inputDevice.ts';

const store = (v: string | null) => ({ getItem: (k: string) => (k === INPUT_DEVICE_STORAGE_KEY ? v : null) });

describe('preferred input device', () => {
  it('is unset by default and leaves constraints alone', () => {
    expect(preferredInputDeviceId(store(null))).toBeUndefined();
    expect(withPreferredInput({ channelCount: 1 }, store(null))).toEqual({ channelCount: 1 });
    expect(withPreferredInput(true, store(''))).toEqual({});
  });
  it('pins the chosen microphone with an exact deviceId', () => {
    expect(withPreferredInput({ echoCancellation: false }, store('abc123'))).toEqual({ echoCancellation: false, deviceId: { exact: 'abc123' } });
  });
  it('ignores absurd values and throwing storage', () => {
    expect(preferredInputDeviceId(store('x'.repeat(300)))).toBeUndefined();
    expect(preferredInputDeviceId({ getItem: () => { throw new Error('blocked'); } })).toBeUndefined();
  });
});
