import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Chrome's fake microphone streams ONE wav file per browser launch (the flag is a launch argument), so
 * e2e/voice.spec.ts launches a fresh persistent browser per clip with the same flags (see e2e/fixtures/voiceBrowser.ts).
 * This project-level list is the default (the takeoff clip) and documents the flags.
 */
export const FAKE_MIC_DEFAULT_WAV = path.resolve(import.meta.dirname, 'e2e/fixtures/takeoff-n723ej.wav');


/**
 * E2E runs against the real dev server and the real local backend (live weather + chart proxy).
 * Both servers are started here and reused when already running.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // One retry absorbs a Vite full-page reload when another agent edits src/ while the suite runs.
  retries: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    {
      name: 'chromium-fake-mic',
      testMatch: 'voice.spec.ts',
      timeout: 300_000, // first run downloads the ~40 MB Whisper model
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            `--use-file-for-fake-audio-capture=${FAKE_MIC_DEFAULT_WAV}%noloop`,
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
    {
      // Installed Google Chrome (has the Web Speech service). Sends the synthetic fixture audio to Google: see e2e/webspeech.spec.ts.
      name: 'chrome-webspeech',
      testMatch: 'webspeech.spec.ts',
      timeout: 240_000,
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 }, permissions: ['microphone'] },
    },
    {
      // OPT-IN (REAL_MIC=1): real microphone + real speakers, no fake device. See e2e/realmic.spec.ts.
      name: 'chrome-real-mic',
      testMatch: 'realmic.spec.ts',
      timeout: 300_000,
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 }, permissions: ['microphone'] },
    },
    {
      name: 'chromium-deepgram-mock',
      testMatch: 'deepgram.spec.ts',
      timeout: 120_000,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npm run server',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
