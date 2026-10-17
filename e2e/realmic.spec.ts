/**
 * REAL HARDWARE proof: Google Chrome opens the machine's actual microphone (no fake-device flag), the test clip is played
 * ACOUSTICALLY through the laptop speakers while PTT is held, and the simulator must hear it and obey.
 *
 * OPT-IN: runs only with REAL_MIC=1 (`REAL_MIC=1 npx playwright test --project=chrome-real-mic`). It makes sound: the clip plays
 * (synthetic macOS voice, about 8 s) at a moderate speaker volume (0.6, restored afterwards).
 *
 * How the audio is routed (and why it is not plain `afplay`): the Mac's DEFAULT output/input may be Bluetooth headphones, and `afplay`
 * plays to the default output, so a headset would never reach the laptop microphone, and opening the headset microphone puts the
 * headphones in low-quality call mode. So the spec
 *   - picks the built-in microphone by deviceId (localStorage `kacy.voice.inputDeviceId`, honoured by the voice providers), and
 *   - plays the clip with scripts/play-on-device.swift (AVAudioPlayer pinned to the built-in speakers, spawned from the test), after
 *     setting only THAT device's volume with scripts/output-volume.swift (CoreAudio) and restoring it afterwards, so the system
 *     default output and its volume are untouched. (Chrome's own HTMLMediaElement/WebAudio output stalled in this environment.)
 *
 * PRE-FLIGHT (fails with a diagnosis instead of a confusing timeout): the chosen microphone must deliver non-zero samples and the
 * speakers must start playing. Both fail with the lid CLOSED (`ioreg` AppleClamshellState = Yes): macOS then disables the built-in
 * microphone (digital silence) and speakers. Open the lid, or use an external microphone/speakers and pass REAL_MIC_SPEAKERS.
 *
 * PRIVACY: Local Whisper never sends audio anywhere. The third test uses Chrome's Web Speech, which streams the captured audio
 * to Google (needs internet); it only ever hears the synthetic clip. A denied microphone fails with the System Settings step.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchRealMicBrowser } from './fixtures/voiceBrowser';
import type { VoiceBrowser } from './fixtures/voiceBrowser';
import { startScenario, TAKEOFF_READBACK } from './helpers';

test.describe.configure({ mode: 'serial' });
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-real-mic' || process.env.REAL_MIC !== '1', 'opt-in: set REAL_MIC=1 (plays audio through the speakers)');
});

const ROOT = path.resolve(import.meta.dirname, '..');
const HELPER = path.join(ROOT, '.cache/output-volume');
const PLAYER = path.join(ROOT, '.cache/play-on-device');
const SPEAKERS = 'MacBook Air Speakers'; // CoreAudio name match; override with REAL_MIC_SPEAKERS
const SPEAKER_NAME = process.env.REAL_MIC_SPEAKERS ?? SPEAKERS;
const TARGET_VOLUME = 0.6;
const LOCAL_LABEL = 'Local Whisper (on-device, no cloud)';

let vb: VoiceBrowser | null = null;
let saved: { volume: string; muted: string } | null = null;

function helper(...args: string[]): string {
  return execFileSync(HELPER, args, { encoding: 'utf8' }).trim();
}

test.beforeAll(() => {
  if (process.env.REAL_MIC !== '1' || test.info().project.name !== 'chrome-real-mic') return;
  if (process.platform !== 'darwin') throw new Error('realmic.spec.ts uses macOS CoreAudio to set the speaker volume.');
  for (const [bin, src] of [[HELPER, 'output-volume'], [PLAYER, 'play-on-device']]) {
    if (!existsSync(bin)) execFileSync('swiftc', ['-O', path.join(ROOT, `scripts/${src}.swift`), '-o', bin], { stdio: 'inherit' });
  }
  const [vol, muted] = helper('get', SPEAKER_NAME).split(' muted=');
  saved = { volume: vol, muted };
  console.log(`[realmic] "${SPEAKER_NAME}" volume before: ${vol} (muted=${muted}); will use ${TARGET_VOLUME} while playing and restore afterwards`);
});

const restoreVolume = () => {
  if (saved) helper('restore', SPEAKER_NAME, saved.volume, saved.muted);
};
test.afterAll(restoreVolume);
test.afterEach(async () => {
  restoreVolume();
  await vb?.close().catch(() => undefined);
  vb = null;
});

interface Devices { micId: string; micLabel: string; speakerId: string; speakerLabel: string }

/** Grants/verifies the microphone and finds the built-in microphone and speakers. Fails clearly if macOS denies Chrome. */
async function findDevices(page: Page): Promise<Devices> {
  const r = await page.evaluate(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      return { error: `${(e as Error).name}: ${(e as Error).message}` };
    }
    const devs = (await navigator.mediaDevices.enumerateDevices()).map((d) => ({ kind: d.kind, label: d.label, id: d.deviceId }));
    return { devs };
  });
  if ('error' in r) {
    throw new Error(
      `Chrome could not open the microphone (${r.error}). On macOS open System Settings > Privacy & Security > Microphone and switch ON "Google Chrome" ` +
        '(then quit Chrome completely and rerun). If it is already on, check that another app is not holding the microphone.',
    );
  }
  const mic = r.devs.find((d) => d.kind === 'audioinput' && /built-in/i.test(d.label));
  const speaker = r.devs.find((d) => d.kind === 'audiooutput' && /built-in/i.test(d.label));
  if (!mic || !speaker) throw new Error(`No built-in microphone/speakers found. Devices: ${JSON.stringify(r.devs.map((d) => `${d.kind}:${d.label}`))}`);
  return { micId: mic.id, micLabel: mic.label, speakerId: speaker.id, speakerLabel: speaker.label };
}

const clamshellClosed = (): boolean => {
  try {
    return /AppleClamshellState"\s*=\s*Yes/.test(execFileSync('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
};
const lidHint = () => (clamshellClosed() ? ' The laptop lid is CLOSED (AppleClamshellState = Yes): macOS disables the built-in microphone and speakers. Open the lid and rerun.' : '');

/** Play a WAV on the built-in speakers (native player pinned to that device). Fails fast if playback cannot start. */
function playClip(file: string): Promise<{ done: Promise<void> }> {
  const child = execFile(PLAYER, [SPEAKER_NAME, path.join(ROOT, 'e2e/fixtures', file)]);
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Could not play the clip on "${SPEAKER_NAME}": ${stderr.trim() || `exit ${code}`}.${lidHint()}`))));
  });
  done.catch(() => undefined); // surfaced through the race below or by awaiting `done`
  return Promise.race([done.then(() => ({ done })), new Promise<{ done: Promise<void> }>((resolve) => setTimeout(() => resolve({ done }), 500))]);
}

/** The chosen microphone must deliver real samples: digital silence means it is disabled or blocked. */
async function assertMicAlive(page: Page, micId: string, label: string) {
  const peak = await page.evaluate(async (id) => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    ctx.createMediaStreamSource(s).connect(an);
    const buf = new Float32Array(2048);
    let peak = 0;
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 200));
      an.getFloatTimeDomainData(buf);
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
    }
    s.getTracks().forEach((t) => t.stop());
    await ctx.close();
    return peak;
  }, micId);
  if (peak === 0) {
    throw new Error(
      `The microphone "${label}" delivers digital silence (every sample is exactly 0), so nothing played to it can be heard.${lidHint()} ` +
        'Otherwise check System Settings > Privacy & Security > Microphone for the app that launched this test (terminal/VS Code) and for Google Chrome, and that the input is not muted.',
    );
  }
  console.log(`[realmic] microphone "${label}" is alive (peak ${peak.toFixed(5)} over 1 s)`);
}

async function open(providerId: string, extra: Record<string, string> = {}) {
  vb = await launchRealMicBrowser();
  const page = vb.page;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  const dev = await findDevices(page);
  await assertMicAlive(page, dev.micId, dev.micLabel);
  await page.evaluate(([id, pid, rest]) => {
    localStorage.setItem('kacy.voice.inputDeviceId', id);
    localStorage.setItem('kacy.voice.settings', JSON.stringify({ providerId: pid, ttsEnabled: false, radioEffectsEnabled: false }));
    for (const [k, v] of Object.entries(JSON.parse(rest) as Record<string, string>)) localStorage.setItem(k, v);
  }, [dev.micId, providerId, JSON.stringify(extra)] as const);
  await page.reload();
  return { page, errors, dev };
}

async function prepareWhisper(page: Page) {
  await expect(page.getByTestId('setup-screen')).toBeVisible();
  await expect(page.getByLabel('Recognition provider')).toHaveValue('whisper-local');
  const warm = page.getByTestId('whisper-warmup');
  if (await warm.isEnabled()) await warm.click();
  await expect(page.getByTestId('whisper-phase')).toHaveAttribute('data-phase', 'ready', { timeout: 120_000 });
}

/** Hold Space, play the clip through the speakers, release, and wait for the transcript. */
async function speakAcoustically(page: Page, _dev: Devices, file: string, want: RegExp) {
  helper('set', SPEAKER_NAME, String(TARGET_VOLUME));
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.down('Space');
  await expect(page.getByTestId('mic-badge')).toHaveText('TRANSMITTING');
  await page.waitForTimeout(400);
  const played = await playClip(file);
  await played.done;
  await page.waitForTimeout(600);
  await page.keyboard.up('Space');
  restoreVolume();
  const releasedAt = Date.now();
  const deadline = releasedAt + 90_000;
  for (;;) {
    const badge = ((await page.getByTestId('mic-badge').textContent()) ?? '').trim();
    const text = ((await page.getByTestId('partial').textContent()) ?? '').replace(/^—$/, '').trim();
    if (badge === 'READY' && text && text !== 'Transcribing…' && Date.now() - releasedAt > 300) return { text, ms: Date.now() - releasedAt, ok: want.test(text), badge };
    if (badge === 'ERROR' || badge === 'UNAVAILABLE' || badge === 'MIC BLOCKED') {
      return { text, ms: Date.now() - releasedAt, ok: false, badge, status: ((await page.getByTestId('mic-status').textContent()) ?? '').trim() };
    }
    if (Date.now() > deadline) return { text, ms: Date.now() - releasedAt, ok: false, badge: 'TIMEOUT' };
    await page.waitForTimeout(100);
  }
}

async function noiseReport(page: Page, label: string) {
  const st = await page.evaluate(() => (window as unknown as { __kacyLocalWhisper?: { getLastCapture(): unknown } }).__kacyLocalWhisper?.getLastCapture() ?? null) as
    { seconds: number; ambientRms: number; ambientDbfs: number; rms: number; peak: number } | null;
  console.log(`[realmic] ${label}: ambient noise (first 500 ms) RMS ${st?.ambientRms.toFixed(5)} = ${st?.ambientDbfs} dBFS; whole capture ${st?.seconds.toFixed(1)} s, RMS ${st?.rms.toFixed(4)}, peak ${st?.peak.toFixed(3)}`);
  return st;
}

async function startHoldingShort(page: Page) {
  await startScenario(page);
  await page.getByTestId('speed-4').click();
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });
}

test('real microphone + speakers, Local Whisper: takeoff clearance is heard, read back, and the aircraft departs', async () => {
  const { page, errors, dev } = await open('whisper-local');
  console.log(`[realmic] microphone: ${dev.micLabel}; speakers: ${dev.speakerLabel}; speaker volume while playing: ${TARGET_VOLUME}`);
  await prepareWhisper(page);
  await startHoldingShort(page);

  const r = await speakAcoustically(page, dev, 'takeoff-n723ej-lead.wav', /(723|seven two three).*cleared (for )?take ?off/i);
  console.log(`[realmic] whisper takeoff: heard "${r.text}" (${r.ms} ms after release)`);
  const st = await noiseReport(page, 'takeoff');
  expect(st?.ambientDbfs ?? 0).toBeLessThan(-20); // the first 500 ms are the room, not the clip
  expect(r.ok, `heard "${r.text}" (${r.badge})`).toBe(true);

  const log = page.getByTestId('comms-log');
  await expect(page.getByTestId('last-result')).toContainText('Issued: takeoff N723EJ');
  await expect(log.getByTestId('log-pilot').filter({ hasText: TAKEOFF_READBACK })).toHaveCount(1);
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', /^(TAKEOFF_ROLL|INITIAL_CLIMB|DEPARTURE)$/, { timeout: 25_000 });
  expect(errors).toEqual([]);
});

test('real microphone + speakers, Local Whisper: "hold position"', async () => {
  const { page, errors, dev } = await open('whisper-local');
  await prepareWhisper(page);
  await startHoldingShort(page);

  const r = await speakAcoustically(page, dev, 'hold-position-n723ej-lead.wav', /(723|seven two three).*hold position/i);
  console.log(`[realmic] whisper hold: heard "${r.text}" (${r.ms} ms after release)`);
  await noiseReport(page, 'hold');
  expect(r.ok, `heard "${r.text}" (${r.badge})`).toBe(true);
  await expect(page.getByTestId('last-result')).toContainText('Issued: hold position N723EJ');
  await expect(page.getByTestId('comms-log').getByTestId('log-pilot').filter({ hasText: 'Holding position, Cessna seven two three echo juliet' })).toHaveCount(1);
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT');
  expect(errors).toEqual([]);
});

test('real microphone + speakers, Web Speech (Google): default mode first, then track mode', async () => {
  test.setTimeout(420_000);
  const modes: Array<{ name: string; extra: Record<string, string> }> = [
    { name: 'default (Chrome opens the system default microphone itself)', extra: {} },
    { name: "track (getUserMedia on the built-in microphone, passed to start(track))", extra: { 'kacy.webspeech.audioSource': 'track' } },
  ];
  const results: string[] = [];
  let worked: string | null = null;
  for (const mode of modes) {
    await vb?.close().catch(() => undefined);
    const { page, dev } = await open('webspeech', mode.extra);
    await startHoldingShort(page);
    const r = await speakAcoustically(page, dev, 'takeoff-n723ej-lead.wav', /(723|seven two three).*cleared (for )?take ?off/i);
    const summary = `${mode.name}: ${r.ok ? 'WORKED' : 'did not work'}; heard "${r.text}" [${r.badge}${'status' in r && r.status ? ': ' + r.status : ''}] (${r.ms} ms after release)`;
    console.log(`[realmic] web speech ${summary}`);
    results.push(summary);
    if (r.ok) {
      worked = mode.name;
      await expect(page.getByTestId('last-result')).toContainText('Issued: takeoff N723EJ');
      await expect(page.getByTestId('comms-log').getByTestId('log-pilot').filter({ hasText: TAKEOFF_READBACK })).toHaveCount(1);
      await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', /^(TAKEOFF_ROLL|INITIAL_CLIMB|DEPARTURE)$/, { timeout: 25_000 });
      break;
    }
  }
  test.info().annotations.push({ type: 'web speech modes', description: results.join(' | ') });
  if (!worked && /could not be reached|network|service/i.test(results.join(' ')) && process.env.WEBSPEECH_REQUIRED !== '1') {
    test.skip(true, `Google's speech service was unreachable: ${results.join(' | ')}`);
  }
  expect(worked, `Web Speech never worked: ${results.join(' | ')}`).not.toBeNull();
});
