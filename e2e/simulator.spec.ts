import { expect, test } from '@playwright/test';
import { litPixels, quietVoice, sendCommand, startScenario, TAKEOFF_CALL, TAKEOFF_READBACK } from './helpers';

test.beforeEach(async ({ page }) => {
  await quietVoice(page);
  page.on('pageerror', (e) => { throw e; });
});

test('setup loads, a scenario starts, the surface display renders and N723EJ is listed', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/ATC Simulator/);
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
  // Training lesson 2 parks N482KB on the ramp (Ground frequency). The lesson is about Ground, so Ground is the default position (AI works Tower).
  await startScenario(page, { mode: 'training', scenario: 'train-02-taxi' });
  await expect(page.getByTestId('strip-N482KB')).toBeVisible();
  await expect(page.getByTestId('position-select')).toHaveValue('GND');

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

test('live weather: falls back to a simulated preset with a visible notice when both the backend and the NWS API are down', async ({ page }) => {
  await page.route('**/api/weather/**', (route) => route.abort());
  await page.route('http://localhost:8787/**', (route) => route.abort());
  await page.route('https://api.weather.gov/**', (route) => route.abort()); // the browser-side fallback source
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

// ------------------------------------------------------------------------------------------------------------------
// IFR positions: Approach, Clearance Delivery, strips and the radar procedure display
// ------------------------------------------------------------------------------------------------------------------

test('IFR free play with All positions: the arrival checks in on Approach and the ILS clearance is read back', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('setup-screen')).toBeVisible();
  await page.getByTestId('weather-select').selectOption('preset:clear');
  await page.getByTestId('ifr-flows').check();
  // IFR flows adopt the full position set; arrivals are routed to the ILS 13 fixes when 13 is the landing runway.
  await expect(page.getByTestId('position-ALL')).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Landing runway').selectOption('13');
  await page.getByLabel('Departing runway').selectOption('13');
  await page.getByTestId('seed-input').fill('11');
  await page.getByTestId('start-session').click();
  await expect(page.getByTestId('sim-screen')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('position-select')).toHaveValue('ALL');
  // Every active frequency is listed (APP and DEP share 124.6).
  for (const f of ['120.300', '121.900', '127.850', '124.600']) await expect(page.getByTestId(`freq-${f}`)).toBeVisible();

  const request = page.locator('[data-testid="request-badge"][data-kind="APPROACH"]').first();
  await expect(request).toBeVisible({ timeout: 20_000 });
  await expect(request).toHaveText('REQ APPROACH');
  const strip = page.locator('[data-testid^="strip-"]', { has: page.locator('[data-kind="APPROACH"]') }).first();
  const callsign = ((await strip.getAttribute('data-testid')) ?? '').replace('strip-', '');
  expect(callsign).toMatch(/^[A-Z0-9]+$/);
  await strip.click();
  await expect(page.getByTestId('detail-callsign')).toHaveText(callsign);
  await expect(page.getByTestId('detail-rules')).toHaveText('IFR');
  await expect(page.getByTestId('detail-squawk')).toHaveText(/^[0-7]{4}$/);
  await expect(page.getByTestId('detail-route')).toContainText('CARYL');

  const log = page.getByTestId('comms-log');
  await expect(log.getByTestId('log-pilot').filter({ hasText: 'Approach' })).toHaveCount(1);
  // The call came in on Approach: its frequency is lit.
  await expect(page.getByTestId('freq-124.600')).toHaveAttribute('data-last', 'true');

  await sendCommand(page, `${callsign}, cleared ILS runway one three approach`);
  await expect(page.getByTestId('last-result')).toContainText('Issued');
  await expect(log.getByTestId('log-pilot').filter({ hasText: /Cleared ILS runway one three approach/ })).toHaveCount(1);
  await expect(page.getByTestId('detail-approach')).toContainText('Cleared ILS 13 approach');
  await expect(page.getByTestId('detail-nav')).toContainText('Approach ILS 13');

  // Radar contact is informational: logged as ATC only, the pilot says nothing.
  const pilotLines = await log.getByTestId('log-pilot').count();
  await sendCommand(page, `${callsign}, radar contact`);
  await expect(log.getByTestId('log-atc').filter({ hasText: 'radar contact' })).toHaveCount(1);
  await expect(page.getByTestId('detail-radar')).toHaveText('IDENTIFIED');
  await page.waitForTimeout(400);
  expect(await log.getByTestId('log-pilot').count()).toBe(pilotLines);
});

test('Clearance Delivery: the IFR clearance is read back with the departure and squawk; later calls on another frequency are "not on frequency"', async ({ page }) => {
  await startScenario(page, { mode: 'training', scenario: 'train-08-ifr-clearance' });
  await expect(page.getByTestId('position-select')).toHaveValue('CLNC');
  await expect(page.getByTestId('freq-127.850')).toBeVisible();
  await page.getByTestId('speed-4').click();
  const request = page.getByTestId('strip-NKS451').getByTestId('request-badge');
  await expect(request).toHaveText('REQ IFR CLNC', { timeout: 30_000 });

  await sendCommand(page, 'Spirit four fifty one, cleared to Philadelphia airport via the Atlantic City Three departure, radar vectors, maintain two thousand, expect one zero thousand one zero minutes after departure, departure frequency one two four point six, squawk four two one five');
  await expect(page.getByTestId('last-result')).toContainText('Issued');
  const readback = page.getByTestId('comms-log').getByTestId('log-pilot').filter({ hasText: 'Atlantic City Three departure' });
  await expect(readback).toHaveCount(1);
  await expect(readback).toContainText(/squawk/i);
  await expect(readback).toContainText('Philadelphia');

  await page.getByTestId('strip-NKS451').click();
  const clearance = page.getByTestId('detail-ifr-clearance');
  await expect(clearance).toContainText('KPHL');
  await expect(clearance).toContainText('ATLANTIC CITY THREE');
  await expect(clearance).toContainText('4215');
  await expect(page.getByTestId('detail-squawk')).toHaveText('4215');

  // After the readback the pilot tunes Ground by itself: the player works Clearance Delivery only.
  await expect(page.getByTestId('strip-NKS451')).toContainText('GND', { timeout: 30_000 });
  await sendCommand(page, 'Spirit four fifty one, hold position');
  await expect(page.getByTestId('last-result')).toContainText('Not on frequency');
  await expect(page.getByTestId('last-result')).toHaveAttribute('data-off-frequency', 'true');
});

test('the Strips tab is a strip board with a bay per position, and the radar offers 60 NM and All fixes', async ({ page }) => {
  await startScenario(page, { mode: 'training', scenario: 'train-08-ifr-clearance' });
  await page.getByTestId('tab-strips').click();
  const bay = page.getByTestId('bay-CLNC');
  await expect(bay).toBeVisible();
  await expect(bay).toHaveAttribute('data-owner', 'player');
  await expect(bay).toContainText('127.85');
  const strip = bay.getByTestId('fps-NKS451');
  await expect(strip.getByTestId('strip-rules')).toHaveText('IFR');
  await expect(strip.getByTestId('strip-route-od')).toHaveText('KACY→KPHL');
  await expect(strip.getByTestId('strip-type')).toHaveText('A320/L');
  await page.getByTestId('fps-NKS451').click();
  await page.getByTestId('tab-list').click();
  await expect(page.getByTestId('strip-NKS451')).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('tab-radar').click();
  await page.getByRole('button', { name: '60 NM' }).click();
  await expect(page.getByRole('button', { name: '60 NM' })).toHaveAttribute('aria-pressed', 'true');
  const allFixes = page.getByTestId('radar-all-fixes');
  await expect(allFixes).toHaveAttribute('aria-pressed', 'false');
  await allFixes.click();
  await expect(allFixes).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(400);
  expect((await litPixels(page, 'radar-canvas')).lit).toBeGreaterThan(1500);
});

// ------------------------------------------------------------------------------------------------------------------
// Flight strips: marks from accepted clearances, notes, strike / drop, resequencing
// ------------------------------------------------------------------------------------------------------------------

test('strips record the clearances the engine accepts, with times; notes persist; S strikes and X drops', async ({ page }) => {
  await startScenario(page);
  await page.getByTestId('speed-4').click();
  await expect(page.getByTestId('strip-N723EJ').getByTestId('phase')).toHaveAttribute('data-phase', 'HOLDING_SHORT', { timeout: 20_000 });
  await page.getByTestId('tab-strips').click();
  const strip = page.getByTestId('bay-TWR').getByTestId('fps-N723EJ');
  await expect(strip).toBeVisible();
  await expect(strip.getByTestId('strip-printed')).toHaveText(/^\d{4}Z$/);
  await expect(strip.getByTestId('strip-mark')).toHaveCount(0);

  // A refused clearance writes nothing.
  await sendCommand(page, 'runway one three, cleared for takeoff'); // no callsign -> clarification
  await expect(strip.getByTestId('strip-mark')).toHaveCount(0);

  // Notes are typed on the strip and survive re-renders and the handoff to another bay.
  await strip.getByTestId('strip-notes-N723EJ').fill('departing VFR, left turn out');
  await sendCommand(page, 'Cessna seven two three echo juliet, runway one three, line up and wait');
  await expect(strip.getByTestId('strip-mark').first()).toHaveText('LUAW');
  await sendCommand(page, TAKEOFF_CALL);
  await expect(strip.getByTestId('strip-mark').nth(1)).toHaveText('CTO 13');
  await expect(strip.getByTestId('strip-mark').filter({ hasText: /^T\/O \d{4}Z$/ })).toHaveCount(1, { timeout: 40_000 });
  await expect(strip.getByTestId('strip-notes-N723EJ')).toHaveValue('departing VFR, left turn out');

  // Keyboard: click selects, S strikes (strike-through, handled), X drops a struck strip.
  await strip.getByTestId('strip-callsign').click();
  await expect(strip).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('x');
  await expect(page.getByTestId('strip-hint')).toContainText('Strike the strip');
  await expect(strip).toBeVisible();
  await page.keyboard.press('s');
  await expect(strip).toHaveAttribute('data-struck', 'true');
  await expect(strip.getByTestId('strip-callsign')).toHaveClass(/line-through/);
  await page.keyboard.press('x');
  await expect(strip).toHaveCount(0);
});

test('strips can be resequenced inside a bay by dragging, and the legend explains the marking', async ({ page }) => {
  await startScenario(page, { mode: 'free', scenario: 'free-play-busy-departures' });
  await page.getByTestId('position-select').selectOption('TWR+GND');
  await page.getByTestId('tab-strips').click();
  const bay = page.getByTestId('bay-GND');
  await expect(bay.locator('[data-testid^="fps-"]').nth(1)).toBeVisible({ timeout: 20_000 });
  const order = async () => bay.locator('[data-testid^="fps-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('fps-', '')));
  const before = await order();
  expect(before.length).toBeGreaterThanOrEqual(2);
  // Pick the last strip and drag its grip onto the top half of the first one.
  const last = before[before.length - 1];
  await page.getByTestId(`strip-grip-${last}`).dragTo(bay.getByTestId(`fps-${before[0]}`), { targetPosition: { x: 80, y: 4 } });
  await expect.poll(order).toEqual([last, ...before.slice(0, -1)]);

  // Alt+ArrowDown on a focused strip moves it one place later (keyboard equivalent).
  await bay.getByTestId(`fps-${last}`).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(order).toEqual([before[0], last, ...before.slice(1, -1)]);

  const legend = page.getByTestId('strip-legend');
  await legend.getByRole('button', { name: /Strip marking/ }).click();
  await expect(legend).toHaveAttribute('data-open', 'true');
  await expect(legend).toContainText('C 13');
  await expect(legend).toContainText('LUAW');
  await expect(legend).toContainText('T/O 1203Z');
  await expect(legend).toContainText('L 1210Z');
  await expect(legend).toContainText('X 13/31');
  await expect(legend).toContainText('H/S 13');
  await expect(legend).toContainText('LAHSO 13');
});

// ------------------------------------------------------------------------------------------------------------------
// Single-position play: the player works one position, AI controllers work the rest
// ------------------------------------------------------------------------------------------------------------------

test('setup: "I work" defaults to the position a lesson is about and says explicitly what AI works', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('mode-training').click();
  await page.getByTestId('scenario-train-02-taxi').click();
  await expect(page.getByTestId('position-GND')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('ai-works')).toContainText('AI works');
  await expect(page.getByTestId('ai-works')).toContainText('Tower');
  await expect(page.getByTestId('ai-toggle')).toBeChecked();
  // Override: working both leaves nothing for AI.
  await page.getByTestId('position-TWR+GND').click();
  await expect(page.getByTestId('ai-works')).toContainText('nothing');
  // Free play defaults to Tower; Ground is AI.
  await page.getByTestId('mode-free').click();
  await page.getByTestId('scenario-__custom__').click();
  await expect(page.getByTestId('position-TWR')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('ai-works')).toContainText('Ground');
  // Switching AI off says the positions are unstaffed.
  await page.getByTestId('ai-toggle').uncheck();
  await expect(page.getByTestId('ai-works')).toContainText('Unstaffed');
});

test.describe('Ground only, AI Tower', () => {
  test.setTimeout(300_000);

  test('an inbound arrival is printed in the AI Tower bay, the AI clears it and hands it off, and the strip moves to my Ground bay with its notes', async ({ page }) => {
    await startScenario(page, { mode: 'free', scenario: 'free-play-busy-arrivals', seed: '21' });
    await page.getByTestId('position-select').selectOption('GND');
    await expect(page.getByTestId('ai-works')).toHaveText(/AI works:\s*Tower/); // in the Other positions (AI) panel
    await expect(page.getByTestId('freq-121.900')).toBeVisible();
    await expect(page.getByTestId('freq-120.300')).toHaveCount(0); // Tower is not mine: not a workable frequency
    const ai = page.getByTestId('ai-positions');
    await expect(ai).toContainText('Other positions (AI)');
    await expect(ai.getByTestId('ai-TWR')).toContainText('TWR·AI');
    await expect(ai.getByTestId('ai-TWR')).toContainText('120.3');
    await page.getByTestId('speed-4').click();
    await page.getByTestId('tab-strips').click();

    const twr = page.getByTestId('bay-TWR');
    const gnd = page.getByTestId('bay-GND');
    await expect(twr).toHaveAttribute('data-owner', 'ai');
    await expect(gnd).toHaveAttribute('data-owner', 'player');
    await expect(page.getByTestId('bay-title-TWR')).toHaveText('TWR·AI');

    // The first airliner on final is with AI Tower.
    const strip = twr.locator('[data-testid^="fps-"]', { has: page.locator('[data-testid="strip-callsign"]') }).first();
    await expect(strip).toBeVisible({ timeout: 30_000 });
    const callsign = ((await strip.getAttribute('data-testid')) ?? '').replace('fps-', '');
    expect(callsign).toMatch(/^[A-Z0-9]+$/);

    // I cannot instruct it: the transmit pipeline explains why, and nothing reaches the engine.
    await sendCommand(page, `${callsign}, runway one three, cleared to land`);
    await expect(page.getByTestId('last-result')).toContainText(`${callsign} is with AI Tower on 120.3; wait for the handoff.`);
    await expect(page.getByTestId('last-result')).toHaveAttribute('data-ai-blocked', 'true');

    // A note typed now is still there after the handoff.
    await strip.getByTestId(`strip-notes-${callsign}`).fill('wake: watch spacing');

    // The AI clears it to land (tagged TWR·AI in the log), the aircraft lands and the AI hands it to Ground.
    const log = page.getByTestId('comms-log');
    await expect(log.locator('[data-testid="log-atc"][data-ai="TWR"]').filter({ hasText: /cleared to land/i }).first()).toBeVisible({ timeout: 120_000 });
    await expect(log.locator('[data-ai="TWR"] [data-testid="log-tag"]').first()).toHaveText('TWR·AI');
    await expect(twr.getByTestId(`fps-${callsign}`).getByTestId('strip-mark').filter({ hasText: /^CTL 13|^CTL 31|^CTL 22|^CTL 4$/ })).toHaveCount(1);

    const moved = gnd.getByTestId(`fps-${callsign}`);
    await expect(moved).toBeVisible({ timeout: 240_000 });
    await expect(moved).toHaveAttribute('data-entry', 'move');
    await expect(twr.getByTestId(`fps-${callsign}`)).toHaveCount(0);
    await expect(moved.getByTestId(`strip-notes-${callsign}`)).toHaveValue('wake: watch spacing');
    await expect(moved.getByTestId('strip-mark').filter({ hasText: /^L \d{4}Z$/ })).toHaveCount(1);
    // Now it is on my frequency and I can work it.
    await moved.getByTestId('strip-callsign').click();
    await sendCommand(page, `${callsign}, hold position`);
    await expect(page.getByTestId('last-result')).not.toHaveAttribute('data-ai-blocked', 'true');
  });
});
