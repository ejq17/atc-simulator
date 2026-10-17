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
/** Same port override as playwright.config.ts (E2E_PORT), so these persistent browsers can run against a build too. */
const DEFAULT_BASE_URL = `http://localhost:${process.env.E2E_PORT ?? 5173}`;

export const FIXTURE_DIR = path.resolve(import.meta.dirname);
export const PROFILE_DIR = path.resolve(import.meta.dirname, '../../.cache/playwright-profile');

export const CLIPS = {
  takeoff: { file: 'takeoff-n723ej.wav', seconds: 5.1, says: 'Cessna seven two three echo juliet, runway one three, cleared for takeoff' },
  hold: { file: 'hold-position-n723ej.wav', seconds: 3.6, says: 'Cessna seven two three echo juliet, hold position' },
  takeoffLead: { file: 'takeoff-n723ej-lead.wav', seconds: 8.1, says: 'three seconds of silence, then the takeoff clearance' },
  holdLead: { file: 'hold-position-n723ej-lead.wav', seconds: 6.6, says: 'three seconds of silence, then hold position' },
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

export interface LaunchOptions {
  baseURL?: string;
  /** 'chrome' = the installed Google Chrome (needed for the Web Speech service); default is Playwright's Chromium. */
  channel?: 'chrome' | 'chromium';
  /** Default true. A headed window opens briefly when false. */
  headless?: boolean;
  /** Separate profiles keep Chrome and Chromium from sharing (incompatible) user-data-dirs. */
  profileDir?: string;
}

export async function launchVoiceBrowser(clip: ClipName, opts: LaunchOptions = {}): Promise<VoiceBrowser> {
  const { baseURL = DEFAULT_BASE_URL, channel, headless = true, profileDir = PROFILE_DIR } = opts;
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    channel,
    baseURL,
    viewport: { width: 1440, height: 900 },
    permissions: ['microphone'],
    args: fakeMicArgs(path.join(FIXTURE_DIR, CLIPS[clip].file)),
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page, close: () => context.close() };
}

/**
 * Google Chrome with the REAL microphone: only the permission prompt is auto-granted (`--use-fake-ui-for-media-stream`); there is
 * deliberately no `--use-fake-device-for-media-stream`, so getUserMedia opens actual hardware. Opt-in project `chrome-real-mic`
 * (REAL_MIC=1). macOS must have granted the microphone to Google Chrome (System Settings > Privacy & Security > Microphone).
 */
export const REAL_MIC_PROFILE_DIR = path.resolve(import.meta.dirname, '../../.cache/playwright-profile-chrome-real');

export async function launchRealMicBrowser(baseURL = DEFAULT_BASE_URL, headless = true): Promise<VoiceBrowser> {
  const context = await chromium.launchPersistentContext(REAL_MIC_PROFILE_DIR, {
    headless,
    channel: 'chrome',
    baseURL,
    viewport: { width: 1440, height: 900 },
    permissions: ['microphone'],
    // Playwright adds --mute-audio to headless browsers; the real-speaker test needs actual output.
    ignoreDefaultArgs: ['--mute-audio'],
    args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page, close: () => context.close() };
}
