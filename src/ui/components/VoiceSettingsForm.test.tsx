// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VoiceSettingsForm } from './VoiceSettingsForm';
import { voiceSettings } from '../store/voiceSettings';

describe('neural voice notice', () => {
  beforeEach(() => {
    localStorage.clear();
    voiceSettings.reset();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('is hidden without WebGPU', () => {
    render(<VoiceSettingsForm />);
    expect(screen.queryByTestId('neural-notice')).toBeNull();
  });

  it('shows once on WebGPU machines and stays dismissed after "Not now"', () => {
    vi.stubGlobal('navigator', { ...navigator, gpu: {} });
    render(<VoiceSettingsForm />);
    expect(screen.getByTestId('neural-notice')).toHaveTextContent('326 MB');
    fireEvent.click(screen.getByTestId('neural-notice-dismiss'));
    expect(screen.queryByTestId('neural-notice')).toBeNull();
    expect(voiceSettings.get().neuralNoticeDismissed).toBe(true);
    expect(voiceSettings.get().ttsEngine).toBe('browser');
    cleanup();
    render(<VoiceSettingsForm />);
    expect(screen.queryByTestId('neural-notice')).toBeNull();
  });

  it('Enable switches the engine to neural, remembers the choice and starts loading', () => {
    vi.stubGlobal('navigator', { ...navigator, gpu: {} });
    render(<VoiceSettingsForm />);
    fireEvent.click(screen.getByTestId('neural-notice-enable'));
    expect(voiceSettings.get()).toMatchObject({ ttsEngine: 'neural', neuralNoticeDismissed: true });
    expect(screen.queryByTestId('neural-notice')).toBeNull();
    expect(screen.getByTestId('neural-voice')).toBeInTheDocument();
  });
});
