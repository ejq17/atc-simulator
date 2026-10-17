import { expect, test } from '@playwright/test';
import { litPixels, quietVoice, sendCommand, startScenario, TAKEOFF_CALL, TAKEOFF_READBACK } from './helpers';

test.beforeEach(async ({ page }) => {
  await quietVoice(page);
  page.on('pageerror', (e) => { throw e; });
});

test('setup loads, a scenario starts, the surface display renders and N723EJ is listed', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('KACY ATC Simulator');
  await expect(page.getByTestId('setup-screen')).toBeVisible();
  await expect(page.getByTestId('provenance-footer')).toContainText('FAA NASR 2026-10-01, d-TPP cycle 2610 (effective 2026-10-01 to 2026-10-29); taxiway geometry © OpenStreetMap contributors (ODbL)');
  await expect(page.getByTestId('start-session')).toBeEnabled();

  await startScenario(page);
  await expect(page.getByTestId('airport-title')).toHaveText('Atlantic City Intl (KACY)');
  await expect(page.getByTestId('strip-N723EJ')).toBeVisible();
  await expect(page.getByTestId('atis-letter')).toContainText('INFO');

  await page.waitForTimeout(500);
  const surface = await litPixels(page, 'surface-canvas');
  expect(surface.width).toBeGreaterThan(300);
  expect(surface.lit).toBeGreaterThan(2000); // runways, taxiway labels and the aircraft are drawn
  await expect(page.getByTestId('frequency')).toContainText('120.30');
});

test('a typed takeoff clearance gets the pilot readback and the aircraft departs', async ({ page }) => {
  await startScenario(page);
  await page.getByTestId('speed-4').click();
  const strip = page.getByTestId('strip-N723EJ');
  await expect(strip.getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });

  await sendCommand(page, TAKEOFF_CALL);

  const log = page.getByTestId('comms-log');
  await expect(log.getByTestId('log-atc').filter({ hasText: 'cleared for takeoff' })).toHaveCount(1);
  await expect(log.getByTestId('log-pilot').filter({ hasText: TAKEOFF_READBACK })).toHaveCount(1);
  await expect(page.getByTestId('last-result')).toContainText('Issued');

  // Within ~60 s of sim time (about 15 s of wall time at 4x) the aircraft is airborne.
  await expect(strip.getByTestId('phase')).toHaveAttribute('data-phase', /^(INITIAL_CLIMB|DEPARTURE)$/, { timeout: 40_000 });
  const t = await page.getByTestId('sim-time').textContent();
  expect(t).toMatch(/^00:0\d:\d\d$/);
});

test('an invalid clearance is rejected and the rejection shows in the log', async ({ page }) => {
  // Training lesson 2 parks N482KB on the ramp (Ground frequency); Tower + Ground lets us talk to it.
  await startScenario(page, { mode: 'training', scenario: 'train-02-taxi' });
  await expect(page.getByTestId('strip-N482KB')).toBeVisible();
  await expect(page.getByTestId('position-select')).toHaveValue('TWR+GND');

  await sendCommand(page, 'Cessna four eight two kilo bravo, runway one three, cleared for takeoff');

  await expect(page.getByTestId('last-result')).toContainText('Rejected');
  const rejected = page.getByTestId('comms-log').locator('[data-kind="COMMAND_REJECTED"]');
  await expect(rejected).toHaveCount(1);
  await expect(rejected).toContainText('REJECTED');
  await expect(page.getByTestId('strip-N482KB').getByTestId('phase')).toHaveAttribute('data-phase', /^(PARKED|READY)$/);
});

test('training mode shows the lesson prompt, feedback and the not-ATC-training disclaimer', async ({ page }) => {
  await startScenario(page, { mode: 'training', scenario: 'train-01-phraseology' });
  const banner = page.getByTestId('training-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Training 1/');
  await expect(page.getByTestId('training-disclaimer')).toContainText(/not .*(ATC )?training/i);
  // An off-script (but legal) clearance gets feedback instead of silently passing.
  await page.getByTestId('speed-4').click();
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });
  await sendCommand(page, TAKEOFF_CALL);
  await expect(banner).toContainText(/accepted|asks for|line up/i);
});

test('an unresolved callsign produces a clarification, not a clearance', async ({ page }) => {
  await startScenario(page);
  await sendCommand(page, 'runway one three, cleared for takeoff');
  await expect(page.getByTestId('last-result')).toContainText('Clarification');
  await expect(page.getByTestId('comms-log').locator('[data-kind="CLARIFICATION"]')).toHaveCount(1);
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', /HOLDING_SHORT|READY/);
});

test('switching to the radar renders a scope, and the keyboard shortcuts work', async ({ page }) => {
  await startScenario(page, { mode: 'free', scenario: 'free-play-mixed' });
  await page.getByTestId('speed-4').click();
  await page.waitForTimeout(1500);
  await page.getByTestId('tab-radar').click();
  await expect(page.getByTestId('radar-canvas')).toBeVisible();
  await page.waitForTimeout(500);
  const radar = await litPixels(page, 'radar-canvas');
  expect(radar.lit).toBeGreaterThan(1500); // rings, rose, runways, fixes
  await expect(page.getByRole('button', { name: '10 NM' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '20 NM' }).click();
  await expect(page.getByRole('button', { name: '20 NM' })).toHaveAttribute('aria-pressed', 'true');

  // 1 / 2 switch views; Enter focuses the command box; Esc deselects.
  await page.keyboard.press('1');
  await expect(page.getByTestId('surface-canvas')).toBeVisible();
  await page.keyboard.press('2');
  await expect(page.getByTestId('radar-canvas')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-input')).toBeFocused();
  await page.getByTestId('command-input').press('Escape');
  const first = page.locator('[data-testid^="strip-"]').first();
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  await expect(first).toHaveAttribute('aria-pressed', 'false');
});

test('the charts drawer lists the official FAA charts', async ({ page }) => {
  await startScenario(page);
  await page.getByTestId('open-charts').click();
  const drawer = page.getByTestId('charts-drawer');
  await expect(drawer).toBeVisible();
  const nav = drawer.getByRole('navigation', { name: 'KACY charts' });
  await expect(nav).toContainText('AIRPORT DIAGRAM', { ignoreCase: true });
  await expect(nav).toContainText('ILS Z OR LOC Z RWY 13', { ignoreCase: true });
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  await page.getByTestId('open-navaids').click();
  await expect(page.getByTestId('navaids-drawer')).toContainText('ACY');
  await page.keyboard.press('Escape');
});

test('ATIS drawer shows the simulated ATIS and labels it as such', async ({ page }) => {
  await startScenario(page);
  await page.getByTestId('atis-button').click();
  await expect(page.getByTestId('atis-simulated')).toContainText('SIMULATED');
  await expect(page.getByTestId('atis-text')).toContainText('Atlantic City Airport information');
  await expect(page.getByTestId('atis-listen')).toBeVisible();
});

test('ending the session shows the debrief and play again restarts', async ({ page }) => {
  await startScenario(page);
  await page.getByTestId('end-session').click();
  await expect(page.getByTestId('debrief-screen')).toBeVisible();
  await expect(page.getByTestId('grade')).toHaveText(/^[A-F]$/);
  await expect(page.getByTestId('score-card')).toBeVisible();
  await page.getByTestId('play-again').click();
  await expect(page.getByTestId('sim-screen')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('end-session').click();
  await page.getByTestId('back-to-setup').click();
  await expect(page.getByTestId('setup-screen')).toBeVisible();
});

test('live weather: falls back to a simulated preset with a visible notice when the backend is down', async ({ page }) => {
  await page.route('**/api/weather/**', (route) => route.abort());
  await page.route('http://localhost:8787/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByTestId('weather-select')).toHaveValue('live');
  await page.getByTestId('start-session').click(); // custom free play + live weather
  await expect(page.getByTestId('sim-screen')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('notices')).toContainText('Live weather unavailable');
  await expect(page.getByTestId('wind')).not.toHaveText('');
});

test('live weather: uses the live METAR when the backend can provide one (or says why not)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start-session').click();
  await expect(page.getByTestId('sim-screen')).toBeVisible({ timeout: 40_000 });
  const notice = page.getByTestId('notices');
  await page.getByTestId('atis-button').click();
  const source = await page.getByTestId('atis-drawer').textContent();
  // Either the real METAR was used, or the user was told it was not.
  if (/Live METAR/.test(source ?? '')) await expect(notice).toHaveCount(0);
  else await expect(notice).toContainText('Live weather unavailable');
});
