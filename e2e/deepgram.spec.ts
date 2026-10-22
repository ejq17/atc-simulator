/**
 * Deepgram provider end to end against a PROTOCOL-FAITHFUL MOCK (e2e/mocks/deepgramMock.ts).
 *
 * WHAT THIS PROVES: the client side of the Deepgram path works with no API key: the real server/index.ts mints a token by
 * calling `/v1/auth/grant` (DEEPGRAM_API_BASE points it at the mock), the browser opens a WebSocket to /v1/listen with the
 * `token, <jwt>` subprotocol and the documented query parameters, streams real 16 kHz linear16 microphone audio (Chrome's
 * fake mic playing e2e/fixtures/takeoff-n723ej.wav), renders interim and final `Results`, and the aircraft obeys the final.
 *
 * WHAT IT DOES NOT PROVE: Deepgram's recognition accuracy. The mock does no speech recognition; it picks a transcript from a
 * fixed table using a crude loudness fingerprint of the audio. Accuracy on callsigns, numbers and phonetics still needs a
 * real key (see src/voice/README.md).
 *
 * Wiring: the Vite dev server proxies /api to a fixed port, so this spec starts its own keyed API server on a free port and
 * forwards the browser's /api/voice/deepgram-token calls to it with page.route (same handler, same code). The WebSocket base
 * is switched to the mock through localStorage `kacy.deepgram.wsBase` (honoured only for ws://127.0.0.1 / localhost).
 *
 * Run:  npx playwright test --project=chromium-deepgram-mock
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import net from 'node:net';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { startDeepgramMock } from './mocks/deepgramMock';
import type { DeepgramMock } from './mocks/deepgramMock';
import { CLIPS, launchVoiceBrowser } from './fixtures/voiceBrowser';
import type { VoiceBrowser } from './fixtures/voiceBrowser';
import { sendCommand, startScenario, TAKEOFF_READBACK } from './helpers';

test.describe.configure({ mode: 'serial' });
test.beforeEach((_fixtures, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-deepgram-mock', 'needs the fake-microphone browser and the Deepgram mock');
});

let mock: DeepgramMock;
let api: ChildProcess | null = null;
let apiBase = '';
let vb: VoiceBrowser | null = null;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

test.beforeAll(async () => {
  if (test.info().project.name !== 'chromium-deepgram-mock') return; // skipped in other projects: start nothing
  mock = await startDeepgramMock({ port: 0 });
  const port = await freePort();
  apiBase = `http://127.0.0.1:${port}`;
  api = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DEEPGRAM_API_KEY: 'test-key', DEEPGRAM_API_BASE: mock.httpBase },
    stdio: 'ignore',
  });
  await expect.poll(async () => {
    try { return (await fetch(`${apiBase}/api/health`)).ok; } catch { return false; }
  }, { timeout: 60_000, message: 'keyed API server did not start' }).toBe(true);
});

test.afterAll(async () => {
  api?.kill('SIGTERM');
  await mock?.close();
});

test.beforeEach(() => mock?.reset());
test.afterEach(async () => {
  await vb?.close().catch(() => undefined);
  vb = null;
});

async function open() {
  vb = await launchVoiceBrowser('takeoff');
  const page = vb.page;
  const errors: string[] = [];
  const tokenCalls: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Forward the app's token endpoint to the keyed server (it calls the mock's /v1/auth/grant).
  await page.route('**/api/voice/deepgram-token', async (route) => {
    tokenCalls.push(route.request().method());
    await route.fulfill({ response: await route.fetch({ url: `${apiBase}/api/voice/deepgram-token` }) });
  });
  await page.addInitScript(([wsBase]) => {
    localStorage.setItem('kacy.deepgram.wsBase', wsBase);
    localStorage.setItem('kacy.voice.settings', JSON.stringify({ providerId: 'deepgram', ttsEnabled: false, radioEffectsEnabled: false }));
  }, [mock.wsBase]);
  return { page, errors, tokenCalls };
}

async function holdSpace(page: Page, seconds: number, whileHeld?: () => Promise<void>) {
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.down('Space');
  await expect(page.getByTestId('mic-badge')).toHaveText('TRANSMITTING');
  if (whileHeld) await whileHeld();
  await page.waitForTimeout(seconds * 1000);
  await page.keyboard.up('Space');
}

test('Deepgram path: token grant, subprotocol upgrade, 16 kHz audio, interim + final transcript, aircraft departs', async () => {
  const { page, errors, tokenCalls } = await open();
  await startScenario(page);
  await page.getByTestId('speed-4').click();
  const strip = page.getByTestId('strip-N723EJ');
  await expect(strip.getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });
  await expect(page.getByTestId('mic-badge')).toHaveText('READY'); // GET /api/voice/deepgram-token said configured

  let interim = '';
  await holdSpace(page, CLIPS.takeoff.seconds + 1, async () => {
    // Interim Results arrive about a second into the audio and show live in the Radio panel while the key is held.
    await expect(page.getByTestId('partial')).toContainText(/cessna seven two three/i, { timeout: 8_000 });
    interim = (await page.getByTestId('partial').textContent()) ?? '';
  });
  const releasedAt = Date.now();
  await expect(page.getByTestId('partial')).toContainText(/cleared for takeoff/i, { timeout: 15_000 });
  const finalMs = Date.now() - releasedAt;
  const heard = (await page.getByTestId('partial').textContent())?.trim();
  console.log(`[deepgram-mock] interim="${interim.trim()}" final="${heard}" (${finalMs} ms from key release)`);

  const log = page.getByTestId('comms-log');
  await expect(log.getByTestId('log-atc').filter({ hasText: /cleared for takeoff/i })).toHaveCount(1);
  await expect(log.getByTestId('log-pilot').filter({ hasText: TAKEOFF_READBACK })).toHaveCount(1);
  await expect(page.getByTestId('last-result')).toContainText('Issued: takeoff N723EJ');
  await expect(strip.getByTestId('phase')).toHaveAttribute('data-phase', /^(TAKEOFF_ROLL|INITIAL_CLIMB|DEPARTURE)$/, { timeout: 25_000 });

  // ---- what the mock saw ----
  expect(tokenCalls).toContain('GET'); // availability check
  expect(tokenCalls).toContain('POST'); // token mint for the transmission
  expect(mock.stats.grants).toEqual([{ authorization: 'Token test-key', status: 200 }]); // real server -> mock grant, key never in the browser
  expect(mock.stats.upgrades).toHaveLength(1);
  const up = mock.stats.upgrades[0];
  expect(up.protocols[0]).toBe('token');
  expect(up.tokenValid).toBe(true);
  expect(up.accepted).toBe(true);
  expect(up.query).toMatchObject({ model: ['nova-3'], encoding: ['linear16'], sample_rate: ['16000'], channels: ['1'], interim_results: ['true'], endpointing: ['300'], smart_format: ['false'] });
  expect(up.query.keyterm.length).toBeGreaterThan(20);
  expect(up.query.keyterm).toContain('cleared for takeoff');

  const conn = mock.stats.connections[0];
  console.log(`[deepgram-mock] audio received: ${conn.audioBytes} bytes in ${conn.audioFrames} frames = ${conn.audioSeconds.toFixed(2)} s (${conn.speechSeconds} s of speech); mock sent ${conn.sentTypes.join(', ')}`);
  expect(conn.audioBytes).toBeGreaterThanOrEqual(112_000); // >= 3.5 s of 16 kHz 16-bit mono
  expect(conn.audioFrames).toBeGreaterThan(10);
  expect(conn.speechSeconds).toBeGreaterThanOrEqual(4.1);
  expect(conn.closeStreamReceived).toBe(true);
  expect(conn.sentTypes.filter((t) => t === 'Results(interim)').length).toBeGreaterThanOrEqual(1);
  expect(conn.sentTypes).toContain('Results(final)');
  expect(errors).toEqual([]);
});

test('Deepgram path: the mock rejects the token grant (401): clear error, typed input still works', async () => {
  const { page, errors } = await open();
  await startScenario(page);
  await page.getByTestId('speed-4').click();
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });
  await expect(page.getByTestId('mic-badge')).toHaveText('READY');
  await fetch(`${mock.httpBase}/__mock/config`, { method: 'POST', body: JSON.stringify({ grantStatus: 401 }) });

  await holdSpace(page, 1.5);
  await expect(page.getByTestId('mic-badge')).toHaveText('ERROR', { timeout: 15_000 });
  await expect(page.getByTestId('mic-status')).toContainText(/Deepgram rejected the API key/);
  expect(mock.stats.grants.at(-1)?.status).toBe(401);
  expect(mock.stats.upgrades).toHaveLength(0); // never got as far as a socket

  await sendCommand(page, 'Cessna seven two three echo juliet, hold position');
  await expect(page.getByTestId('comms-log').getByTestId('log-pilot').filter({ hasText: 'Holding position' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Deepgram path: the WebSocket upgrade is refused (401): clear error, typed input still works', async () => {
  const { page, errors } = await open();
  await startScenario(page);
  await page.getByTestId('speed-4').click();
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });
  await fetch(`${mock.httpBase}/__mock/config`, { method: 'POST', body: JSON.stringify({ rejectUpgrade: true }) });

  await holdSpace(page, 1.5);
  await expect(page.getByTestId('mic-badge')).toHaveText('ERROR', { timeout: 15_000 });
  await expect(page.getByTestId('mic-status')).toContainText(/Could not connect to Deepgram/);
  expect(mock.stats.upgrades.length).toBeGreaterThanOrEqual(1);
  expect(mock.stats.upgrades.every((u) => !u.accepted)).toBe(true);

  await sendCommand(page, 'Cessna seven two three echo juliet, hold position');
  await expect(page.getByTestId('comms-log').getByTestId('log-pilot').filter({ hasText: 'Holding position' })).toHaveCount(1);
  expect(errors).toEqual([]);
});
