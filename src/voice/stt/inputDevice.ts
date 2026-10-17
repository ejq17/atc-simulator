/**
 * Optional microphone choice. By default getUserMedia opens the system default input, which may be a Bluetooth headset
 * whose microphone drops the headphones into low-quality call mode. localStorage `kacy.voice.inputDeviceId` (a
 * `MediaDeviceInfo.deviceId` from enumerateDevices) pins a specific microphone. Used by e2e/realmic.spec.ts to pick the
 * laptop's built-in microphone; there is no settings UI for it yet.
 */
export const INPUT_DEVICE_STORAGE_KEY = 'kacy.voice.inputDeviceId';

export function preferredInputDeviceId(storage?: Pick<Storage, 'getItem'>): string | undefined {
  try {
    const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
    const id = s?.getItem(INPUT_DEVICE_STORAGE_KEY)?.trim();
    return id && id.length <= 256 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Audio constraints with the pinned microphone (if any) added. Falls back to the plain constraints when none is set. */
export function withPreferredInput(audio: MediaTrackConstraints | true = {}, storage?: Pick<Storage, 'getItem'>): MediaTrackConstraints {
  const base = audio === true ? {} : audio;
  const id = preferredInputDeviceId(storage);
  return id ? { ...base, deviceId: { exact: id } } : base;
}
