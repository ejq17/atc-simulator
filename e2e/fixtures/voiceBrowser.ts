import path from 'node:path';
import { chromium } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

/**
 * Pattern that works in Playwright 1.64 for "one fake-microphone clip per browser".
 *
 * `--use-file-for-fake-audio-capture=<wav>%noloop` is a Chromium LAUNCH argument, and Playwright's `browser.newContext()`
 * cannot change launch args, so a per-clip context is not enough. Instead each test launches its own browser with
 * `chromium.launchPersistentContext(userDataDir, { args })`. The user-data-dir is shared (tests run serially,
 * workers: 1), so the Whisper model files stay in the profile's Cache API after the first download and later
 * launches start with a warm model. `%noloop` makes the device go silent after the clip instead of repeating it.
 * The device switches are `--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream`. The `...-media-capture`
 * spellings are NOT Chromium switches: they are silently ignored, so getUserMedia either hits the REAL microphone (full
 * Chrome) or fails with NotSupportedError (headless shell).
 * Chrome restarts the file from its first sample every time the page opens a new microphone stream (each PTT press).
 */
export const FIXTURE_DIR = path.resolve(import.meta.dirname);
export const PROFILE_DIR = path.resolve(import.meta.dirname, '../../.cache/playwright-profile');

export const CLIPS = {
  takeoff: { file: 'takeoff-n723ej.wav', seconds: 5.1, says: 'Cessna seven two three echo juliet, runway one three, cleared for takeoff' },
  hold: { file: 'hold-position-n723ej.wav', seconds: 3.6, says: 'Cessna seven two three echo juliet, hold position' },
  land: { file: 'land-nks451.wav', seconds: 4.0, says: 'Spirit four fifty one, runway one three, cleared to land' },
} as const;
export type ClipName = keyof typeof CLIPS;

export function fakeMicArgs(wavPath: string): string[] {
  return [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${wavPath}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
  ];
}

export interface VoiceBrowser {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export async function launchVoiceBrowser(clip: ClipName, baseURL = 'http://localhost:5173'): Promise<VoiceBrowser> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    baseURL,
    viewport: { width: 1440, height: 900 },
    permissions: ['microphone'],
    args: fakeMicArgs(path.join(FIXTURE_DIR, CLIPS[clip].file)),
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page, close: () => context.close() };
}
