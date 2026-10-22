/**
 * Voice end-to-end: proves the microphone path works and that an aircraft can be controlled by speech alone,
 * with no cloud key. Chrome's fake audio device plays a pre-recorded WAV (e2e/fixtures/*.wav, made by
 * scripts/make-voice-fixtures.sh with macOS `say`) into getUserMedia; the on-device Whisper model
 * (provider 'whisper-local') transcribes it; the real parser + engine act on the transcript.
 *
 * Run:  npx playwright test --project=chromium-fake-mic
 * The first run downloads the model (base.en: ~77 MB; E2E_WHISPER_MODEL=small.en|tiny.en to change it) from huggingface.co (and the ONNX runtime from jsdelivr) into the
 * persistent profile at .cache/playwright-profile; later runs reuse it.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { CLIPS, launchVoiceBrowser } from './fixtures/voiceBrowser';
import type { ClipName, VoiceBrowser } from './fixtures/voiceBrowser';
import { startScenario, TAKEOFF_READBACK } from './helpers';

test.describe.configure({ mode: 'serial' });
test.beforeEach(({ browserName: _browserName }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-fake-mic', 'needs the fake-microphone browser launch args');
});

const LOCAL_LABEL = 'Local Whisper (on-device, no cloud)';
let vb: VoiceBrowser | null = null;
test.afterEach(async () => {
  await vb?.close().catch(() => undefined);
  vb = null;
});

/**
 * Which Whisper checkpoint the spec runs: E2E_WHISPER_MODEL = tiny.en | base.en (default) | small.en. Headless Chromium has
 * no WebGPU, so the device is pinned to WebAssembly (the CPU path) to keep timings comparable.
 */
const WHISPER_MODEL = process.env.E2E_WHISPER_MODEL ?? 'base.en';
const WHISPER_DEVICE = process.env.E2E_WHISPER_DEVICE ?? 'wasm';

/** Seed voice settings (TTS and radio effects off, the Whisper model/device above); the provider is set when given. */
async function seedSettings(page: Page, providerId?: string) {
  await page.addInitScript(([pid, model, device]) => {
    const key = 'kacy.voice.settings';
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>; } catch { /* start clean */ }
    const base = pid ? { providerId: pid } : {};
    localStorage.setItem(key, JSON.stringify({ ...existing, ...base, ttsEnabled: false, radioEffectsEnabled: false, whisperModel: model, whisperDevice: device }));
  }, [providerId, WHISPER_MODEL, WHISPER_DEVICE] as const);
}

/**
 * Main-thread responsiveness probe: records Long Tasks (>50 ms) and the gaps between animation frames, so a test can
 * report how long Whisper blocks the UI. Results are read with `probe(page, fromMs)`.
 */
async function installPerfProbe(page: Page) {
  await page.addInitScript(() => {
    const perf = { long: [] as Array<[number, number]>, gaps: [] as Array<[number, number]>, last: 0 };
    (window as unknown as { __perf: typeof perf }).__perf = perf;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) perf.long.push([e.startTime, e.duration]);
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* Long Tasks API unavailable */ }
    const tick = (t: number) => {
      if (perf.last) perf.gaps.push([t, t - perf.last]);
      perf.last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

interface MainThreadStats { longestTaskMs: number; longTasks: number; maxFrameGapMs: number }
const nowInPage = (page: Page) => page.evaluate(() => performance.now());
async function probe(page: Page, fromMs: number): Promise<MainThreadStats> {
  return page.evaluate((from) => {
    const p = (window as unknown as { __perf: { long: Array<[number, number]>; gaps: Array<[number, number]> } }).__perf;
    const long = p.long.filter(([t]) => t >= from);
    const gaps = p.gaps.filter(([t]) => t >= from);
    return {
      longestTaskMs: Math.round(Math.max(0, ...long.map(([, d]) => d))),
      longTasks: long.length,
      maxFrameGapMs: Math.round(Math.max(0, ...gaps.map(([, g]) => g))),
    };
  }, fromMs);
}

async function open(clip: ClipName, providerId?: string) {
  vb = await launchVoiceBrowser(clip);
  const errors: string[] = [];
  vb.page.on('pageerror', (e) => errors.push(String(e)));
  if (process.env.VOICE_DEBUG) {
    vb.page.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 200)));
    vb.page.on('framenavigated', (f) => console.log('[nav]', f.url()));
  }
  await seedSettings(vb.page, providerId);
  await installPerfProbe(vb.page);
  return { page: vb.page, errors };
}

/** Hold the PTT key while the fake mic plays the clip, then release; returns wall ms from release to the final text. */
let decodeStats: { hold: MainThreadStats; decode: MainThreadStats } | null = null;
async function speak(page: Page, clip: ClipName, expectInPartial: RegExp) {
  await page.locator('body').click({ position: { x: 2, y: 2 } }); // make sure no input has focus
  await page.keyboard.down('Space');
  const downAt = await nowInPage(page);
  await expect(page.getByTestId('mic-badge')).toHaveText('TRANSMITTING');
  await page.waitForTimeout(CLIPS[clip].seconds * 1000 + 1000); // %noloop: silence after the clip, so over-holding is safe
  await page.keyboard.up('Space');
  const releasedAt = Date.now();
  const upAt = await nowInPage(page);
  await expect(page.getByTestId('mic-badge')).toHaveText('TRANSCRIBING');
  await expect(page.getByTestId('partial')).toHaveText(/\S/);
  await expect(page.getByTestId('partial')).toHaveText(expectInPartial, { timeout: 120_000 });
  const transcribeMs = Date.now() - releasedAt;
  const capture = await page.evaluate(() => (window as unknown as { __kacyLocalWhisper?: { getLastCapture(): unknown } }).__kacyLocalWhisper?.getLastCapture());
  console.log(`[voice] capture stats ${JSON.stringify(capture)}`);
  const holdStats = await probe(page, downAt);
  const decode = await probe(page, upAt);
  decodeStats = { hold: holdStats, decode };
  console.log(`[voice] main thread, key down..transcript: ${JSON.stringify(holdStats)}; key up..transcript (decode): ${JSON.stringify(decode)}`);
  const heard = (await page.getByTestId('partial').textContent())?.trim() ?? '';
  test.info().annotations.push({ type: 'transcript', description: `${clip}: "${heard}" (${transcribeMs} ms after key release)` });
  console.log(`[voice] ${clip}: heard "${heard}" -- ${transcribeMs} ms from key release to transcript`);
  return { heard, transcribeMs };
}

test('Settings: select Local Whisper and download/prepare the on-device model', async () => {
  test.setTimeout(240_000);
  const { page, errors } = await open('takeoff');
  await page.goto('/');
  await expect(page.getByTestId('setup-screen')).toBeVisible();

  await page.getByLabel('Recognition provider').selectOption({ label: LOCAL_LABEL });
  const panel = page.getByTestId('whisper-model');
  await expect(panel).toBeVisible();
  await expect(page.getByText('Your microphone audio stays in this browser tab')).toBeVisible();

  await expect(page.getByTestId('whisper-model-select')).toHaveValue(WHISPER_MODEL);
  await expect(page.getByTestId('whisper-device-select')).toHaveValue(WHISPER_DEVICE);
  if (WHISPER_MODEL !== 'auto') await expect(page.getByTestId('whisper-resolved')).toContainText(`Whisper ${WHISPER_MODEL}`);
  const t0 = Date.now();
  const warm = page.getByTestId('whisper-warmup');
  if (await warm.isEnabled()) await warm.click();
  await expect(page.getByTestId('whisper-phase')).toHaveAttribute('data-phase', 'ready', { timeout: 120_000 });
  const ms = Date.now() - t0;
  console.log(`[voice] model ready in ${ms} ms: ${await page.getByTestId('whisper-message').textContent()}`);
  await expect(page.getByTestId('whisper-warmup')).toHaveText('Local model ready');
  await expect(page.getByTestId('whisper-message')).toContainText(WHISPER_MODEL === 'auto' ? 'Ready: Whisper' : `Ready: Whisper ${WHISPER_MODEL} on ${WHISPER_DEVICE === 'webgpu' ? 'WebGPU' : 'WebAssembly'}`);
  expect(errors).toEqual([]);
});

test('hold SPACE while the fake mic says the takeoff clearance: transcript, readback, aircraft departs', async () => {
  const { page, errors } = await open('takeoff', 'whisper-local');
  await startScenario(page);
  await page.getByTestId('speed-4').click();
  const strip = page.getByTestId('strip-N723EJ');
  await expect(strip.getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });
  await expect(page.getByTestId('mic-badge')).toHaveText('READY');

  const { heard } = await speak(page, 'takeoff', /cleared for takeoff/i);
  // Decoding runs in a Web Worker: the UI thread must stay responsive while Whisper works (running it on the main
  // thread measured a ~930 ms long task / frame gap here).
  expect(decodeStats!.decode.longestTaskMs).toBeLessThan(250);
  expect(decodeStats!.decode.maxFrameGapMs).toBeLessThan(250);
  expect(heard).toMatch(/723/);

  const log = page.getByTestId('comms-log');
  await expect(log.getByTestId('log-atc').filter({ hasText: /cleared for takeoff/i })).toHaveCount(1);
  await expect(log.getByTestId('log-pilot').filter({ hasText: TAKEOFF_READBACK })).toHaveCount(1);
  await expect(page.getByTestId('last-result')).toContainText('Issued');
  console.log('[voice] takeoff last-result:', await page.getByTestId('last-result').textContent());

  // 60 s of sim time at 4x = 15 s of wall time.
  await expect(strip.getByTestId('phase')).toHaveAttribute('data-phase', /^(TAKEOFF_ROLL|INITIAL_CLIMB|DEPARTURE)$/, { timeout: 25_000 });
  expect(errors).toEqual([]);
});

test('hold SPACE while the fake mic says "hold position": same pipeline, second phrase', async () => {
  const { page, errors } = await open('hold', 'whisper-local');
  await startScenario(page);
  await page.getByTestId('speed-4').click();
  const strip = page.getByTestId('strip-N723EJ');
  await expect(strip.getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });

  await speak(page, 'hold', /hold position/i);

  const log = page.getByTestId('comms-log');
  await expect(log.getByTestId('log-atc').filter({ hasText: /hold position/i })).toHaveCount(1);
  console.log('[voice] comms log after "hold position":', JSON.stringify((await log.innerText()).split('\n').filter(Boolean)), 'last-result:', await page.getByTestId('last-result').textContent());
  // The engine accepts "hold position" (a legal instruction for an aircraft holding short) and the pilot reads it back.
  await expect(log.getByTestId('log-pilot').filter({ hasText: 'Holding position, Cessna seven two three echo juliet' })).toHaveCount(1);
  await expect(page.getByTestId('last-result')).toContainText('Issued: hold position N723EJ');
  // Holding short stays holding short.
  await expect(strip.getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT');
  expect(errors).toEqual([]);
});

test('a clearance for an aircraft that is not on frequency is transcribed but not acted on', async () => {
  const { page, errors } = await open('land', 'whisper-local');
  await startScenario(page);
  await page.getByTestId('speed-4').click();
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });

  await speak(page, 'land', /(spirit|451).*(clear|land)/i);

  await expect(page.getByTestId('last-result')).toContainText(/Clarification|Rejected/);
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT');
  expect(errors).toEqual([]);
});

test('Web Speech provider degrades gracefully in headless Chromium (no crash, clear status, typed input still works)', async () => {
  const { page, errors } = await open('takeoff', 'webspeech');
  await startScenario(page);
  await page.getByTestId('speed-4').click();
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });

  const badge = page.getByTestId('mic-badge');
  // Either the engine is missing ("UNAVAILABLE") or present and ready; both are acceptable, a crash is not.
  await expect(badge).toHaveText(/^(READY|UNAVAILABLE|ERROR|MIC BLOCKED)$/);

  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.down('Space');
  await page.waitForTimeout(1500);
  await page.keyboard.up('Space');
  // Settles in a defined state: no stuck TRANSMITTING/TRANSCRIBING, an explanatory status line, app still alive.
  await expect(badge).toHaveText(/^(READY|UNAVAILABLE|ERROR|MIC BLOCKED)$/, { timeout: 15_000 });
  const status = (await page.getByTestId('mic-status').textContent())?.trim() ?? '';
  expect(status.length).toBeGreaterThan(0);
  console.log(`[voice] webspeech in headless chromium: badge=${await badge.textContent()} status="${status}"`);
  await expect(page.getByTestId('sim-screen')).toBeVisible();

  const input = page.getByTestId('command-input');
  await input.fill('Cessna seven two three echo juliet, hold position');
  await input.press('Enter');
  await expect(page.getByTestId('comms-log').getByTestId('log-atc').filter({ hasText: /hold position/i })).toHaveCount(1);
  expect(errors).toEqual([]);
});
