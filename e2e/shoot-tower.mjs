// Captures docs/screenshots/tower*.png from a running dev server. Usage: BASE_URL=http://localhost:5190 node e2e/shoot-tower.mjs [outPrefix]
// Uses Playwright's bundled Chromium with software GL (SwiftShader) so it needs no GPU.
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'docs/screenshots/tower';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ baseURL: process.env.BASE_URL ?? 'http://localhost:5173', viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  localStorage.setItem('kacy.voice.settings', JSON.stringify({ providerId: 'none', ttsEnabled: false, radioEffectsEnabled: false }));
});
const page = await ctx.newPage();
if (process.env.TIME) await page.clock.setFixedTime(new Date(process.env.TIME)); // e.g. TIME=2026-10-17T03:00:00Z for a night view
page.on('console', (m) => console.log(`[console.${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('/');
await page.waitForSelector('[data-testid="setup-screen"]');
await page.getByTestId('mode-career').click();
await page.getByTestId('scenario-career-01-first-radio').click();
await page.getByTestId('seed-input').fill('7');
await page.getByTestId('start-session').click();
await page.waitForSelector('[data-testid="sim-screen"]');
await page.getByTestId('speed-4').click();
await page.getByTestId('command-input').fill('Cessna seven two three echo juliet, runway one three, cleared for takeoff');
await page.getByTestId('command-send').click();
await page.waitForTimeout(6000);
await page.getByTestId('tab-tower').click();
await page.waitForTimeout(3000);
console.log('error box:', await page.getByTestId('tower-error').count());
await page.screenshot({ path: `${out}-1.png` });
await page.getByTestId('tower-rwy-13').click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}-2.png` });
await page.getByTestId('strip-N723EJ').click().catch(() => {});
await page.getByTestId('tower-follow').click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}-3.png` });
await browser.close();
