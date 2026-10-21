// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VOICE_SETTINGS,
  VOICE_PRIVACY_NOTES,
  VOICE_SETTINGS_KEY,
  createVoiceSettingsStore,
  loadVoiceSettings,
  sanitizeVoiceSettings,
} from './settings.ts';
import { TRANSCRIPT_STORAGE_KEY, createTranscriptLog } from './transcriptLog.ts';

describe('voice settings', () => {
  beforeEach(() => localStorage.clear());

  it('has privacy-preserving defaults', () => {
    expect(DEFAULT_VOICE_SETTINGS.storeTranscripts).toBe(false);
    expect(DEFAULT_VOICE_SETTINGS.pttKey).toBe('Space');
    expect(DEFAULT_VOICE_SETTINGS.providerId).toBe('webspeech');
    expect(loadVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  it('phrase interpreter setting: on by default, survives old stored settings without it, rejects non-booleans', () => {
    expect(DEFAULT_VOICE_SETTINGS.interpreterEnabled).toBe(true);
    localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify({ providerId: 'deepgram', pttKey: 'KeyT' }));
    expect(loadVoiceSettings()).toMatchObject({ providerId: 'deepgram', pttKey: 'KeyT', interpreterEnabled: true });
    expect(sanitizeVoiceSettings({ interpreterEnabled: false }).interpreterEnabled).toBe(false);
    expect(sanitizeVoiceSettings({ interpreterEnabled: 'no' }).interpreterEnabled).toBe(true);
    const store = createVoiceSettingsStore();
    store.update({ interpreterEnabled: false });
    expect(loadVoiceSettings().interpreterEnabled).toBe(false);
    expect(VOICE_PRIVACY_NOTES.interpreter).toMatch(/sent through the local backend/);
  });

  it('accepts the local Whisper provider id and still rejects unknown ones', () => {
    expect(sanitizeVoiceSettings({ providerId: 'whisper-local' }).providerId).toBe('whisper-local');
    expect(sanitizeVoiceSettings({ providerId: 'whisper-cloud' }).providerId).toBe(DEFAULT_VOICE_SETTINGS.providerId);
    expect(VOICE_PRIVACY_NOTES.providers['whisper-local']).toMatch(/never uploaded/);
  });

  it('defaults the pilot voice engine to the browser, persists the neural choice, and rejects unknown values', () => {
    expect(DEFAULT_VOICE_SETTINGS.ttsEngine).toBe('browser');
    expect(DEFAULT_VOICE_SETTINGS.neuralDevice).toBe('auto');
    expect(sanitizeVoiceSettings({ ttsEngine: 'neural', neuralDevice: 'webgpu' })).toMatchObject({ ttsEngine: 'neural', neuralDevice: 'webgpu' });
    expect(sanitizeVoiceSettings({ ttsEngine: 'cloud', neuralDevice: 'tpu' })).toMatchObject({ ttsEngine: 'browser', neuralDevice: 'auto' });
    const store = createVoiceSettingsStore();
    store.update({ ttsEngine: 'neural' });
    expect(loadVoiceSettings().ttsEngine).toBe('neural');
  });

  it('defaults the Whisper model and device to auto and rejects unknown values', () => {
    expect(DEFAULT_VOICE_SETTINGS.whisperModel).toBe('auto');
    expect(DEFAULT_VOICE_SETTINGS.whisperDevice).toBe('auto');
    expect(sanitizeVoiceSettings({ whisperModel: 'small.en', whisperDevice: 'webgpu' })).toMatchObject({ whisperModel: 'small.en', whisperDevice: 'webgpu' });
    expect(sanitizeVoiceSettings({ whisperModel: 'tiny.en', whisperDevice: 'wasm' })).toMatchObject({ whisperModel: 'tiny.en', whisperDevice: 'wasm' });
    expect(sanitizeVoiceSettings({ whisperModel: 'large-v3', whisperDevice: 'cuda' })).toMatchObject({ whisperModel: 'auto', whisperDevice: 'auto' });
    expect(sanitizeVoiceSettings({ whisperModel: 7, whisperDevice: null })).toMatchObject({ whisperModel: 'auto', whisperDevice: 'auto' });
  });

  it('persists updates under kacy.voice.settings and reloads them', () => {
    const store = createVoiceSettingsStore();
    store.update({ providerId: 'deepgram', pttKey: 'F2', pttMode: 'toggle', ttsVolume: 0.4 });
    const raw = JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY)!);
    expect(raw).toMatchObject({ providerId: 'deepgram', pttKey: 'F2', pttMode: 'toggle', ttsVolume: 0.4 });
    expect(createVoiceSettingsStore().get()).toMatchObject({ providerId: 'deepgram', pttKey: 'F2' });
  });

  it('notifies subscribers and supports reset', () => {
    const store = createVoiceSettingsStore();
    const seen: string[] = [];
    const off = store.subscribe((s) => seen.push(s.pttKey));
    store.update({ pttKey: 'KeyV' });
    off();
    store.update({ pttKey: 'KeyB' });
    expect(seen).toEqual(['KeyV']);
    expect(store.reset()).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  it('sanitizes corrupt or out-of-range stored values', () => {
    localStorage.setItem(VOICE_SETTINGS_KEY, '{not json');
    expect(loadVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
    const s = sanitizeVoiceSettings({ providerId: 'evil', pttMode: 'x', ttsVolume: 9, ttsRate: -1, pttKey: '', ttsEnabled: 'yes' });
    expect(s.providerId).toBe('webspeech');
    expect(s.pttMode).toBe('hold');
    expect(s.ttsVolume).toBe(1);
    expect(s.ttsRate).toBe(0.5);
    expect(s.pttKey).toBe('Space');
    expect(s.ttsEnabled).toBe(true);
  });

  it('documents privacy for every provider', () => {
    expect(VOICE_PRIVACY_NOTES.providers.webspeech).toMatch(/Google/);
    expect(VOICE_PRIVACY_NOTES.recordings).toMatch(/never/i);
  });
});

describe('transcript log', () => {
  beforeEach(() => localStorage.clear());

  it('keeps transcripts in memory only by default', () => {
    const settings = createVoiceSettingsStore();
    const log = createTranscriptLog(settings);
    log.add({ text: 'Spirit 123 taxi', source: 'speech' });
    expect(log.entries()).toHaveLength(1);
    expect(localStorage.getItem(TRANSCRIPT_STORAGE_KEY)).toBeNull();
  });

  it('persists only when storeTranscripts is on, and erases when turned off', () => {
    const settings = createVoiceSettingsStore();
    const log = createTranscriptLog(settings);
    settings.update({ storeTranscripts: true });
    log.add({ text: 'hold short', source: 'speech' });
    expect(JSON.parse(localStorage.getItem(TRANSCRIPT_STORAGE_KEY)!)).toHaveLength(1);
    settings.update({ storeTranscripts: false });
    expect(localStorage.getItem(TRANSCRIPT_STORAGE_KEY)).toBeNull();
    expect(log.entries()).toHaveLength(1); // session log survives in memory
  });

  it('clear() wipes memory and storage', () => {
    const settings = createVoiceSettingsStore();
    settings.update({ storeTranscripts: true });
    const log = createTranscriptLog(settings);
    log.add({ text: 'x', source: 'typed' });
    log.clear();
    expect(log.entries()).toHaveLength(0);
    expect(localStorage.getItem(TRANSCRIPT_STORAGE_KEY)).toBeNull();
  });
});
