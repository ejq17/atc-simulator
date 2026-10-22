/**
 * Browser speech (Web Speech API) end to end in REAL Google Chrome.
 *
 * NETWORK / PRIVACY: Chrome implements SpeechRecognition by streaming the microphone audio to GOOGLE'S speech service. This
 * spec therefore needs internet access and sends the fixture audio (e2e/fixtures/*.wav: synthetic macOS `say` voice, no
 * personal data) to Google while the push-to-talk key is held. Nothing else leaves the machine. Chromium builds (Playwright's
 * default) have no such service, which is why this runs in the installed Chrome (`channel: 'chrome'`).
 *
 * If Google's service cannot be reached (network/service-not-allowed errors, or recognition never starts), then
 *   WEBSPEECH_REQUIRED=1  -> the test FAILS with the reason,
 *   otherwise             -> the test is SKIPPED and the reason is printed.
 * AUDIO FEED: without `start(track)` Chrome's recognizer ignores the fake-device flags and hears the machine's real microphone
 * (verified: "no-speech" every time). The provider's opt-in `audioSource: 'track'` (localStorage `kacy.webspeech.audioSource`)
 * hands the fake-microphone track to the real recognizer, so Google's service really transcribes the WAV.
 * LEAD-IN: the clips used here start with 3 s of silence. Google's streaming connection takes 1-3 s to open and audio spoken
 * before that is not transcribed (without lead-in the callsign was lost; see webSpeechProvider.ts). A person keying the radio
 * also pauses before speaking. Attempts are still allowed (see ATTEMPTS) because the service is not deterministic.
 * Headless first (`headless: true` with channel chrome is Chrome's new headless, the full browser). If recognition never
 * starts there, the spec relaunches ONCE in a headed window (it opens briefly and is closed). Force headed with
 * WEBSPEECH_HEADED=1. Run:  npx playwright test --project=chrome-webspeech
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { CLIPS, launchVoiceBrowser } from './fixtures/voiceBrowser';
import type { ClipName, VoiceBrowser } from './fixtures/voiceBrowser';
import { startScenario } from './helpers';

test.describe.configure({ mode: 'serial' });
test.beforeEach((_fixtures, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-webspeech', 'needs installed Google Chrome with network access');
});

const REQUIRED = process.env.WEBSPEECH_REQUIRED === '1';
const CHROME_PROFILE = path.resolve(import.meta.dirname, '../.cache/playwright-profile-chrome');
let vb: VoiceBrowser | null = null;
test.afterEach(async () => {
  await vb?.close().catch(() => undefined);
  vb = null;
});

type Outcome = { kind: 'heard'; text: string; ms: number } | { kind: 'service'; badge: string; status: string };

async function launch(clip: ClipName, headless: boolean) {
  await vb?.close().catch(() => undefined);
  vb = await launchVoiceBrowser(clip, { channel: 'chrome', headless, profileDir: CHROME_PROFILE });
  const errors: string[] = [];
  vb.page.on('pageerror', (e) => errors.push(String(e)));
  await vb.page.addInitScript(() => {
    localStorage.setItem('kacy.voice.settings', JSON.stringify({ providerId: 'webspeech', ttsEnabled: false, radioEffectsEnabled: false }));
    // Chrome's recognizer normally listens to the real system microphone, which the fake-device flags do not replace.
    // 'track' makes the provider open the (fake) microphone with getUserMedia and pass that track to start(track).
    localStorage.setItem('kacy.webspeech.audioSource', 'track');
  });
  await startScenario(vb.page);
  await vb.page.getByTestId('speed-4').click();
  await expect(vb.page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });
  return { page: vb.page, errors };
}

/** Hold Space for the clip, release, then wait for the transmission to complete (or a service-level failure). */
async function speak(page: Page, clip: ClipName): Promise<Outcome> {
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.down('Space');
  await expect(page.getByTestId('mic-badge')).toHaveText('TRANSMITTING');
  await page.waitForTimeout(CLIPS[clip].seconds * 1000 + 1000);
  await page.keyboard.up('Space');
  const releasedAt = Date.now();
  const deadline = releasedAt + 25_000;
  while (Date.now() < deadline) {
    const badge = ((await page.getByTestId('mic-badge').textContent()) ?? '').trim();
    const text = ((await page.getByTestId('partial').textContent()) ?? '').replace(/^—$/, '').trim();
    if (badge === 'ERROR' || badge === 'UNAVAILABLE' || badge === 'MIC BLOCKED') {
      return { kind: 'service', badge, status: ((await page.getByTestId('mic-status').textContent()) ?? '').trim() };
    }
    if (badge === 'READY' && text && Date.now() - releasedAt > 300) return { kind: 'heard', text, ms: Date.now() - releasedAt };
    await page.waitForTimeout(100);
  }
  const status = ((await page.getByTestId('mic-status').textContent()) ?? '').trim();
  return { kind: 'service', badge: 'TIMEOUT', status: `no transcript within 25 s (status: ${status})` };
}

function serviceDown(o: Extract<Outcome, { kind: 'service' }>): string {
  return `Google's speech service did not deliver a transcript in this Chrome: [${o.badge}] ${o.status}`;
}

/**
 * Google's service sometimes drops the first words of a synthetic call (measured: "Runway 13 cleared for takeoff" without the
 * callsign). A controller would simply repeat the call, so the spec allows up to 3 presses and records every attempt.
 */
const ATTEMPTS = 3;

async function runClip(clip: ClipName, want: RegExp, continuous: boolean) {
  const headedOnly = process.env.WEBSPEECH_HEADED === '1';
  let headless = !headedOnly;
  let { page, errors } = await launch(clip, headless);
  const attempts: string[] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let outcome = await speak(page, clip);
    if (outcome.kind === 'service' && headless) {
      console.log(`[webspeech] headless: ${serviceDown(outcome)}. Retrying once in a headed window.`);
      headless = false;
      ({ page, errors } = await launch(clip, false));
      outcome = await speak(page, clip);
    }
    if (outcome.kind === 'service') {
      const reason = serviceDown(outcome);
      if (REQUIRED) throw new Error(`WEBSPEECH_REQUIRED=1 but ${reason}`);
      test.skip(true, reason);
    }
    const heard = outcome as Extract<Outcome, { kind: 'heard' }>;
    attempts.push(`"${heard.text}" (${heard.ms} ms)`);
    console.log(`[webspeech] ${clip} attempt ${attempt} (${headless ? 'headless' : 'headed'} Chrome ${(await page.context().browser()?.version()) ?? ''}, continuous=${continuous}): heard "${heard.text}" -- ${heard.ms} ms from key release to transcript`);
    if (want.test(heard.text)) {
      test.info().annotations.push({ type: 'transcript', description: `${clip}: ${attempts.join(' -> ')}` });
      return { page, errors, heard };
    }
  }
  throw new Error(`${clip}: after ${ATTEMPTS} presses Google's service never returned a transcript matching ${want}: ${attempts.join(' -> ')}`);
}

test('Web Speech in Chrome: hold SPACE during the takeoff clip, readback, aircraft departs', async () => {
  test.setTimeout(240_000);
  const { page, errors } = await runClip('takeoffLead', /(723|seven two three).*cleared (for )?take ?off/i, true);
  const log = page.getByTestId('comms-log');
  await expect(log.getByTestId('log-atc').filter({ hasText: /cleared (for )?take ?off/i }).last()).toBeVisible();
  await expect(page.getByTestId('last-result')).toContainText('Issued: takeoff N723EJ');
  await expect(log.getByTestId('log-pilot').filter({ hasText: 'Runway one three, cleared for takeoff, Cessna seven two three echo juliet' })).toHaveCount(1);
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', /^(TAKEOFF_ROLL|INITIAL_CLIMB|DEPARTURE)$/, { timeout: 25_000 });
  expect(errors).toEqual([]);
});

test('Web Speech in Chrome: hold SPACE during the "hold position" clip', async () => {
  test.setTimeout(240_000);
  const { page, errors } = await runClip('holdLead', /(723|seven two three).*hold position/i, true);
  const log = page.getByTestId('comms-log');
  await expect(page.getByTestId('last-result')).toContainText('Issued: hold position N723EJ');
  await expect(log.getByTestId('log-pilot').filter({ hasText: 'Holding position, Cessna seven two three echo juliet' })).toHaveCount(1);
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT');
  expect(errors).toEqual([]);
});
