/**
 * Pilots are audible: end to end in REAL Google Chrome (`channel: 'chrome'`, Chrome's new headless).
 *
 * The browser's speech synthesis cannot be recorded, so the test observes what the page asked Chrome to say and what Chrome did,
 * through the debug object the voice layer keeps in non-production builds (and in production when localStorage `kacy.debug.tts` is
 * "1", which this spec sets): `window.__kacyTts` = { voices, started: [texts], ended: [texts], errors, spoken: [{ text, utterance,
 * voiceName, rate, pitch, volume, startedAtMs, endedAtMs, outcome }] }. `started` entries are utterance `onstart` events, i.e. Chrome
 * really began rendering speech; `outcome: 'end'` means it spoke to the end. It makes no sound it cannot make: no microphone, no
 * network speech service (macOS system voices).
 *
 * Run:  npx playwright test --project=chrome-pilot-tts
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { sendCommand, startScenario, TAKEOFF_CALL, TAKEOFF_READBACK } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('kacy.debug.tts', '1');
    // Typed commands (no microphone); pilot audio is left at its DEFAULT, which is what this spec proves.
    localStorage.setItem('kacy.voice.settings', JSON.stringify({ providerId: 'none' }));
  });
  page.on('pageerror', (e) => { throw e; });
});

interface Spoken { text: string; utterance: string; voiceId: string; voiceName: string | null; rate: number; pitch: number; volume: number; startedAtMs?: number; endedAtMs?: number; outcome?: string }
interface Tts { supported: boolean; voices: number; voiceNames: string[]; started: string[]; ended: string[]; errors: { text: string; error: string }[]; spoken: Spoken[]; unlock?: { audioContext: string; ttsPrimed: boolean; voices: number } }

const tts = (page: Page): Promise<Tts> => page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __kacyTts: unknown }).__kacyTts)) as never);

test('a takeoff clearance gets a spoken pilot readback in Chrome (default settings)', async ({ page }, testInfo) => {
  await startScenario(page);
  // The Start click unlocked audio (AudioContext resumed, speech primed) before the first pilot call.
  const afterStart = await tts(page);
  expect(afterStart.unlock?.ttsPrimed).toBe(true);
  expect(afterStart.supported).toBe(true);
  await expect(page.getByTestId('pilot-audio')).toHaveAttribute('data-audio', 'on');

  await page.getByTestId('speed-4').click();
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });
  const before = (await tts(page)).started.length;

  await sendCommand(page, TAKEOFF_CALL);
  await expect(page.getByTestId('comms-log').getByTestId('log-pilot').filter({ hasText: TAKEOFF_READBACK })).toHaveCount(1);

  // Chrome starts speaking the readback.
  await expect.poll(async () => (await tts(page)).started, { timeout: 45_000 }).toContain(TAKEOFF_READBACK);
  // ... the "speaking" lamp in the Radio panel follows the utterance ...
  // (sampled right after onstart; the sentence lasts several seconds)
  await expect(page.getByTestId('pilot-audio')).toHaveAttribute('data-speaking', /true|false/);
  // ... and finishes the sentence, not cancelled by anything the UI did meanwhile (React re-renders at 10 Hz).
  await expect.poll(async () => (await tts(page)).ended, { timeout: 30_000 }).toContain(TAKEOFF_READBACK);

  const t = await tts(page);
  expect(t.voices).toBeGreaterThan(0);
  expect(t.started.length).toBeGreaterThan(before);
  const u = t.spoken.find((s) => s.text === TAKEOFF_READBACK)!;
  expect(u.utterance).toBe(TAKEOFF_READBACK);
  expect(u.outcome).toBe('end');
  expect(u.voiceName).toBeTruthy();
  expect(u.volume).toBe(1);
  const durationMs = (u.endedAtMs ?? 0) - (u.startedAtMs ?? 0);
  expect(durationMs).toBeGreaterThan(1500); // a real sentence takes seconds to speak
  expect(t.errors.filter((e) => e.text === TAKEOFF_READBACK)).toEqual([]);

  const live = await page.evaluate(() => ({ voices: speechSynthesis.getVoices().length, speaking: speechSynthesis.speaking }));
  expect(live.voices).toBeGreaterThan(0);
  testInfo.annotations.push({ type: 'observed', description: `${t.voices} voices; "${u.text}" spoken by ${u.voiceName} (rate ${u.rate.toFixed(2)}, pitch ${u.pitch.toFixed(2)}) for ${durationMs} ms; all utterances started: ${JSON.stringify(t.started)}` });
  console.log('OBSERVED', JSON.stringify({ voices: t.voices, readback: u, started: t.started, errors: t.errors, unlock: t.unlock }));
});

test('different aircraft get different voices', async ({ page }, testInfo) => {
  await startScenario(page, { mode: 'free', scenario: 'free-play-busy-departures' });
  await page.getByTestId('position-select').selectOption('TWR+GND');
  await page.getByTestId('speed-4').click();
  // The ramp is full of aircraft asking to taxi: wait until two different pilots have been spoken.
  await expect.poll(async () => new Set((await tts(page)).spoken.filter((s) => s.startedAtMs).map((s) => s.voiceId)).size, { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
  const t = await tts(page);
  const profiles = new Set(t.spoken.map((s) => `${s.voiceName}|${s.rate}|${s.pitch}`));
  expect(profiles.size).toBeGreaterThanOrEqual(2);
  expect(new Set(t.spoken.map((s) => s.voiceId)).size).toBeGreaterThanOrEqual(2);
  testInfo.annotations.push({ type: 'observed', description: JSON.stringify(t.spoken.map((s) => ({ text: s.text, voice: s.voiceName, rate: s.rate, pitch: s.pitch }))) });
});

test('Pilot audio off: the readback is shown but not spoken; the switch turns it back on', async ({ page }) => {
  await startScenario(page);
  await page.getByTestId('speed-4').click();
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });
  await expect.poll(async () => (await tts(page)).ended.length, { timeout: 30_000 }).toBeGreaterThan(0); // the "ready for departure" call
  const sw = page.getByTestId('pilot-audio');
  await sw.click();
  await expect(sw).toHaveAttribute('data-audio', 'off');
  await expect(sw).toHaveText(/Pilot audio: off/);
  const startedBefore = (await tts(page)).started.length;

  await sendCommand(page, TAKEOFF_CALL);
  await expect(page.getByTestId('comms-log').getByTestId('log-pilot').filter({ hasText: TAKEOFF_READBACK })).toHaveCount(1);
  await page.waitForTimeout(2500);
  expect((await tts(page)).started.length).toBe(startedBefore);
  await expect(page.getByTestId('speaking')).toHaveText('muted');

  await sw.click();
  await expect(sw).toHaveAttribute('data-audio', 'on');
});

test('the mic indicator says "Mic off" (speech input) and does not mention pilot audio', async ({ page }) => {
  await startScenario(page);
  await expect(page.getByTestId('mic-badge')).toHaveText('MIC OFF');
  await expect(page.getByTestId('pilot-audio')).toHaveText(/Pilot audio: on/);
});

test('the settings "Play test call" button speaks through Chrome and reports the voices', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('setup-screen')).toBeVisible();
  await expect(page.getByTestId('pilot-voice-test')).toContainText(/\d+ voices available/, { timeout: 10_000 });
  await page.getByTestId('play-test-call').click();
  await expect.poll(async () => (await tts(page)).ended, { timeout: 30_000 }).toContainEqual(expect.stringContaining('ready for departure'));
  const t = await tts(page);
  expect(t.errors).toEqual([]);
  expect(t.spoken.at(-1)!.outcome).toBe('end');
});

test.describe('AI controllers are audible only when you monitor their frequency', () => {
  test.setTimeout(300_000);

  test('Ground only: AI Tower is silent by default, and spoken at lower volume with "Monitor all"', async ({ page }, testInfo) => {
    await startScenario(page, { mode: 'free', scenario: 'free-play-busy-arrivals', seed: '21' });
    await page.getByTestId('position-select').selectOption('GND');
    await page.getByTestId('speed-4').click();
    const log = page.getByTestId('comms-log');
    const aiLines = log.locator('[data-testid="log-atc"][data-ai="TWR"]');
    // The AI Tower talks on 120.3; I work 121.9 only: nothing of it reaches the speaker.
    await expect(aiLines.first()).toBeVisible({ timeout: 120_000 });
    const firstAi = (await aiLines.first().locator('span').last().innerText()).trim();
    await page.waitForTimeout(1500);
    let t = await tts(page);
    expect(t.started.some((x) => /cleared to land|continue approach|runway one three/i.test(x) && /Cessna|Spirit|American|Delta|United|JetBlue|air|N\d/i.test(x) && !/Atlantic City Tower,/.test(x))).toBe(false);
    const quietCount = t.started.length;

    // Monitor all frequencies: the next AI call is spoken, quieter than my own frequency would be.
    await page.getByTestId('monitor-all').check();
    const seen = await aiLines.count();
    await expect(aiLines).toHaveCount(seen + 1, { timeout: 120_000 });
    await expect.poll(async () => (await tts(page)).started.length, { timeout: 30_000 }).toBeGreaterThan(quietCount);
    t = await tts(page);
    const ai = t.spoken.filter((s) => s.voiceId.startsWith('atc-'));
    expect(ai.length).toBeGreaterThan(0);
    expect(ai[0].volume).toBeCloseTo(0.45, 2);
    expect(ai[0].outcome === 'end' || ai[0].startedAtMs !== undefined).toBe(true);
    testInfo.annotations.push({ type: 'observed', description: `first AI line "${firstAi}" was silent; with Monitor all: ${JSON.stringify(ai.map((s) => ({ text: s.text, voice: s.voiceName, volume: s.volume })))}` });
  });
});
