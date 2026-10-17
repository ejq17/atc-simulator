// Captures docs/screenshots/*.png from the running dev server (npm run dev + npm run server).
// Usage: node e2e/shoot.mjs [setup|sim|radar|all]
import { chromium } from '@playwright/test';

const which = process.argv[2] ?? 'all';
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: 'http://localhost:5173', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => {
  localStorage.setItem('kacy.voice.settings', JSON.stringify({ providerId: 'none', ttsEnabled: false, radioEffectsEnabled: false }));
});
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('/');
await page.waitForSelector('[data-testid="setup-screen"]');
await page.waitForTimeout(1500);
if (which === 'setup' || which === 'all') await page.screenshot({ path: 'docs/screenshots/setup.png' });
if (which === 'setup') { await browser.close(); process.exit(0); }
await page.getByTestId('mode-career').click();
await page.getByTestId('scenario-career-01-first-radio').click();
await page.getByTestId('seed-input').fill('7');
await page.getByTestId('start-session').click();
await page.waitForSelector('[data-testid="sim-screen"]');
await page.getByTestId('speed-4').click();
await page.waitForTimeout(1200);
await page.getByTestId('command-input').fill('Cessna seven two three echo juliet, runway one three, cleared for takeoff');
await page.getByTestId('command-send').click();
await page.waitForTimeout(9000);
await page.getByTestId('strip-N723EJ').click();
await page.waitForTimeout(600);
await page.screenshot({ path: 'docs/screenshots/sim.png' });
await page.getByTestId('tab-radar').click();
await page.waitForTimeout(1500);
await page.screenshot({ path: 'docs/screenshots/radar.png' });
await browser.close();
