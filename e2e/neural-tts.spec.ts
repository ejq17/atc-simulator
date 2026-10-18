/**
 * Neural pilot voice, end to end in real Chromium: the on-device Piper voice (libritts_r medium, 79 MB, WebAssembly device) is downloaded
 * from huggingface.co (the ONNX runtime comes from cdn.jsdelivr.net), a pilot readback is synthesised in a Web Worker and scheduled through
 * the radio audio graph. Nothing is mocked.
 *
 * Observability: the page keeps `window.__kacyNeuralTts = { events, getStats() }` and `window.__kacyNeuralSynth`. A `synth` event
 * carries the peak and RMS level of the synthesised speech (so a silent or empty result fails), a `play` event means the first
 * samples were scheduled on the AudioContext, and `getStats().fallbacks` must stay at zero (the browser voice never stepped in).
 * Headless Chromium cannot record its own output, so level and timing are measured on the synthesised samples and the Web Audio schedule.
 *
 * The device is pinned to WebAssembly (headless Chromium's WebGPU adapter is a software one and is far too slow); the latency budget is
 * 10 s here instead of the default 3 s to tolerate a busy CI machine.
 *
 * Run:  npm run build && E2E_PREVIEW=1 E2E_PORT=5181 npx playwright test --project=chromium neural-tts
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { sendCommand, TAKEOFF_CALL, TAKEOFF_READBACK } from './helpers';

interface NeuralEvent { type: string; text?: string; voice?: string; peak?: number; rms?: number; audioSec?: number; ms?: number; sinceRequestMs?: number; speechSec?: number; reason?: string }
interface Stats { synthesized: number; played: number; cacheHits: number; fallbacks: Record<string, number> }

const events = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __kacyNeuralTts?: { events: unknown[] } }).__kacyNeuralTts?.events ?? [])) as NeuralEvent[]);
const stats = (page: Page) => page.evaluate(() => (window as unknown as { __kacyNeuralTts?: { getStats(): unknown } }).__kacyNeuralTts?.getStats() as Stats);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('kacy.debug.tts', '1');
    localStorage.setItem('kacy.neural.budgetMs', '10000');
    localStorage.setItem('kacy.voice.settings', JSON.stringify({ providerId: 'none', ttsEnabled: true, radioEffectsEnabled: true, ttsEngine: 'browser', neuralDevice: 'wasm' }));
  });
  page.on('pageerror', (e) => { throw e; });
});

test('Settings: pick the local neural voice, prepare the model, then a takeoff readback is synthesised and played through the radio chain', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await expect(page.getByTestId('setup-screen')).toBeVisible();

  // The engine selector sits in the voice settings next to the speech-recognition selector.
  await expect(page.getByLabel('Recognition provider')).toBeVisible();
  const engine = page.getByTestId('tts-engine-select');
  await expect(engine).toHaveValue('browser');
  await expect(page.getByTestId('neural-voice')).toHaveCount(0);
  await engine.selectOption('neural');
  await expect(page.getByTestId('neural-voice')).toBeVisible();
  await expect(page.getByTestId('neural-webgpu')).toHaveText(/available/);
  await expect(page.getByTestId('neural-device-select')).toHaveValue('wasm');
  await expect(page.getByTestId('neural-resolved')).toContainText('Piper (libritts_r) on WebAssembly');

  // Persisted like the other voice settings.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kacy.voice.settings') ?? '{}').ttsEngine)).toBe('neural');

  const t0 = Date.now();
  await page.getByTestId('neural-warmup').click();
  await expect(page.getByTestId('neural-phase')).toHaveAttribute('data-phase', 'ready', { timeout: 180_000 });
  console.log(`[neural] model ready in ${Date.now() - t0} ms: ${await page.getByTestId('neural-message').textContent()}`);
  await expect(page.getByTestId('neural-message')).toContainText('Ready: Piper (libritts_r) on WebAssembly');
  await expect(page.getByTestId('neural-warmup')).toHaveText('Neural voice ready');

  // A session with the neural engine selected, started from this same page (a reload would drop the loaded model).
  await page.getByTestId('mode-career').click();
  await page.getByTestId('scenario-career-01-first-radio').click();
  await page.getByTestId('seed-input').fill('7');
  await page.getByTestId('start-session').click();
  await expect(page.getByTestId('sim-screen')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('speed-4').click();
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });
  await sendCommand(page, TAKEOFF_CALL);
  await expect(page.getByTestId('comms-log').getByTestId('log-pilot').filter({ hasText: TAKEOFF_READBACK })).toHaveCount(1);

  // The readback is synthesised (non-silent speech) and then scheduled for playback.
  await expect.poll(async () => (await events(page)).some((e) => e.type === 'play' && e.text === TAKEOFF_READBACK), { timeout: 120_000 }).toBe(true);
  const ev = await events(page);
  const synth = ev.filter((e) => e.type === 'synth');
  expect(synth.length).toBeGreaterThan(0);
  for (const s of synth) {
    expect(s.peak!).toBeGreaterThan(0.05);
    expect(s.rms!).toBeGreaterThan(0.005);
    expect(s.audioSec!).toBeGreaterThan(0.5);
  }
  const play = ev.find((e) => e.type === 'play')!;
  expect(play.speechSec!).toBeGreaterThan(0.5);
  console.log(`[neural] first audio ${play.sinceRequestMs} ms after the request (CPU, Piper); ${synth.length} pieces: ${synth.map((s) => `${s.ms} ms/${s.audioSec!.toFixed(1)} s`).join(', ')}`);

  // The whole call finishes (the "speaking" lamp goes off) and the browser voice never stepped in.
  await expect(page.getByTestId('pilot-audio')).toHaveAttribute('data-speaking', 'true', { timeout: 15_000 });
  await expect(page.getByTestId('pilot-audio')).toHaveAttribute('data-speaking', 'false', { timeout: 120_000 });
  const st = await stats(page);
  expect(st.played).toBe(1);
  expect(Object.values(st.fallbacks).reduce((a, b) => a + b, 0)).toBe(0);
  expect((await page.evaluate(() => (window as unknown as { __kacyTts?: { unlock?: { audioContext: string } } }).__kacyTts?.unlock?.audioContext))).not.toBe('unsupported');
});
