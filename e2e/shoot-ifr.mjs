// IFR review screenshots into docs/screenshots/: approach.png (arrival on the ILS 13 fixes, radar 20 NM),
// strips.png (free play with IFR flows and All positions, Strips tab) and setup-ifr.png (controller positions).
// Needs `npm run dev` + `npm run server` running. Usage: node e2e/shoot-ifr.mjs [approach|strips|setup|all]
import { chromium } from '@playwright/test';

const which = process.argv[2] ?? 'all';
const want = (n) => which === 'all' || which === n;
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: process.env.BASE_URL ?? 'http://localhost:5173', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => {
  localStorage.setItem('kacy.voice.settings', JSON.stringify({ providerId: 'none', ttsEnabled: false, radioEffectsEnabled: false }));
});
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const send = async (text) => {
  await page.getByTestId('command-input').fill(text);
  await page.getByTestId('command-send').click();
};

if (want('setup')) {
  await page.goto('/');
  await page.getByTestId('mode-training').click();
  await page.getByTestId('scenario-train-09-approach').click();
  await page.getByTestId('seed-input').fill('7');
  await page.waitForTimeout(600);
  await page.getByTestId('position-needs').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'docs/screenshots/setup-ifr.png' });
}

if (want('approach')) {
  // IFR free play on All positions, landing 13: the arrival checks in over CARYL (ILS 13 IF) on its filed route.
  await page.goto('/');
  await page.getByTestId('weather-select').selectOption('preset:clear');
  await page.getByTestId('ifr-flows').check();
  await page.getByLabel('Landing runway').selectOption('13');
  await page.getByLabel('Departing runway').selectOption('13');
  await page.getByTestId('seed-input').fill('11');
  await page.getByTestId('start-session').click();
  await page.waitForSelector('[data-testid="sim-screen"]');
  const request = page.locator('[data-testid="request-badge"][data-kind="APPROACH"]').first();
  await request.waitFor({ timeout: 20_000 });
  const strip = page.locator('[data-testid^="strip-"]', { has: page.locator('[data-kind="APPROACH"]') }).first();
  const callsign = ((await strip.getAttribute('data-testid')) ?? '').replace('strip-', '');
  await strip.click();
  await send(`${callsign}, radar contact`);
  await send(`${callsign}, cleared ILS runway one three approach`);
  await page.getByTestId('tab-radar').click();
  await page.getByRole('button', { name: '20 NM' }).click();
  await page.getByTestId('speed-4').click();
  await page.waitForTimeout(7000);
  await page.screenshot({ path: 'docs/screenshots/approach.png' });
}

if (want('strips')) {
  await page.goto('/');
  await page.getByTestId('weather-select').selectOption('preset:clear');
  await page.getByTestId('ifr-flows').check();
  await page.getByLabel('Landing runway').selectOption('13');
  await page.getByLabel('Departing runway').selectOption('13');
  await page.getByTestId('seed-input').fill('1');
  await page.getByTestId('start-session').click();
  await page.waitForSelector('[data-testid="sim-screen"]');
  await page.getByTestId('speed-4').click();
  await page.waitForTimeout(9000);
  await page.getByTestId('tab-strips').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'docs/screenshots/strips.png' });
}
await browser.close();
