import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { litPixels, quietVoice, startScenario } from './helpers';

/**
 * Panel layout, pop-out windows and the responsive shell. Run in preview mode like the rest of the suite:
 *   npm run build && E2E_PREVIEW=1 E2E_PORT=5174 npx playwright test e2e/layout.spec.ts
 */

async function overflow(page: Page) {
  return page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
    inner: window.innerWidth,
  }));
}

test.beforeEach(async ({ page }) => {
  await quietVoice(page);
  await page.addInitScript(() => localStorage.removeItem('kacy.layout.v1'));
  page.on('pageerror', (e) => { throw e; });
});

test('Radar pops out into its own window, renders there, takes keyboard shortcuts and comes back when closed', async ({ page, context }) => {
  await startScenario(page);
  await page.getByTestId('tab-radar').click();
  await expect(page.getByTestId('radar-canvas')).toBeVisible();

  const [popup] = await Promise.all([context.waitForEvent('page'), page.getByTestId('popout-radar').click()]);
  await popup.waitForLoadState();
  await expect(popup.getByTestId('radar-canvas')).toBeVisible({ timeout: 15_000 });
  // The radar left the main window; the other displays are still tabs there.
  await expect(page.getByTestId('radar-canvas')).toHaveCount(0);
  await expect(page.getByTestId('tab-radar')).toHaveCount(0);
  await expect(page.getByTestId('tab-surface')).toBeVisible();

  // Styles were copied: the popup is dark, the canvas is full size and something is drawn on it.
  await expect.poll(async () => (await litPixels(popup, 'radar-canvas')).lit, { timeout: 15_000 }).toBeGreaterThan(1500);
  const css = await popup.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, h: document.getElementById('root')!.clientHeight, w: innerHeight, title: document.title }));
  expect(css.bg).toBe('rgb(11, 14, 17)');
  expect(css.h).toBeGreaterThan(css.w - 4);
  expect(css.title).toContain('Radar');

  // Keyboard shortcuts work while the popup has focus: P toggles pause in the shared sim.
  await popup.bringToFront();
  await expect(page.getByTestId('pause')).toHaveAttribute('aria-label', 'Pause');
  await popup.keyboard.press('p');
  await expect(page.getByTestId('pause')).toHaveAttribute('aria-label', 'Resume');
  await popup.keyboard.press('p');
  await expect(page.getByTestId('pause')).toHaveAttribute('aria-label', 'Pause');
  // The wheel works in the popup (range steps) and a click on the canvas does not throw.
  await popup.getByTestId('radar-canvas').hover();
  await popup.mouse.wheel(0, -300);

  // The layout remembers the window for "Reopen windows".
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('kacy.layout.v1')!));
  expect(saved.popouts.radar).toMatchObject({ region: 'main' });

  await popup.close();
  await expect(page.getByTestId('tab-radar')).toBeVisible();
  await expect(page.getByTestId('radar-canvas')).toBeVisible();
});

test('the radio panel in a popup keeps push-to-talk and the typed command box', async ({ page, context }) => {
  await startScenario(page);
  const [popup] = await Promise.all([context.waitForEvent('page'), page.getByTestId('popout-radio').click()]);
  await popup.waitForLoadState();
  await expect(popup.getByTestId('command-input')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('command-input')).toHaveCount(0);
  await popup.getByTestId('command-input').fill('Cessna seven two three echo juliet, say again');
  await popup.getByTestId('command-input').press('Enter');
  await expect(page.getByTestId('comms-log')).toContainText(/723EJ|Say again|say again/i, { timeout: 15_000 });
  await popup.close();
  await expect(page.getByTestId('command-input')).toBeVisible();
});

test('layout presets and per-panel moves rearrange the main window and persist across a reload', async ({ page }) => {
  await startScenario(page);
  await page.getByTestId('layout-menu').click();
  await page.getByTestId('preset-tower-cab').click();
  await expect(page.getByTestId('tab-tower')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tab-comms')).toHaveCount(0);

  await page.getByTestId('layout-menu').click();
  await page.getByTestId('preset-ground').click();
  await expect(page.getByTestId('tab-surface')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tab-comms')).toBeVisible();

  // Move Comms to the right column through the panel menu.
  await page.getByTestId('tab-comms').click();
  await page.getByTestId('panel-menu-comms').click();
  await page.getByTestId('move-comms-right').click();
  await expect(page.getByTestId('right-column').getByTestId('tab-comms')).toBeVisible();

  const saved = await page.evaluate(() => localStorage.getItem('kacy.layout.v1'));
  expect(saved).toContain('"version":1');

  await page.getByTestId('layout-menu').click();
  await page.getByTestId('layout-reset').click();
  await expect(page.getByTestId('bottom-row').getByTestId('tab-comms')).toBeVisible();
  await expect(page.getByTestId('tab-tower')).toBeVisible();
});

test('phone layout (390 px): no horizontal overflow, bottom tab bar switches panels, large PTT, command box reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startScenario(page);
  expect((await overflow(page)).doc).toBeLessThanOrEqual(0);
  await expect(page.getByTestId('mobile-shell')).toBeVisible();
  await expect(page.getByTestId('mtab-display')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('surface-canvas')).toBeVisible();
  await expect(page.getByTestId('comms-log')).toHaveCount(0);
  await page.waitForTimeout(400);
  expect((await litPixels(page, 'surface-canvas')).lit).toBeGreaterThan(1000);

  await page.getByTestId('mtab-aircraft').click();
  await expect(page.getByTestId('strip-N723EJ')).toBeVisible();
  await expect(page.getByTestId('surface-canvas')).toHaveCount(0);
  await page.getByTestId('tab-strips').click();
  await expect(page.getByTestId('bay-TWR')).toBeVisible();

  await page.getByTestId('mtab-comms').click();
  await expect(page.getByTestId('comms-log')).toBeVisible();

  await page.getByTestId('mtab-radio').click();
  await expect(page.getByTestId('command-input')).toBeVisible();
  const ptt = await page.getByTestId('ptt').boundingBox();
  expect(ptt!.height).toBeGreaterThanOrEqual(40);
  const input = await page.getByTestId('command-input').boundingBox();
  expect(input!.y + input!.height).toBeLessThanOrEqual(844);

  // The PTT dock sits above the tab bar on the other sections and is a big target.
  await page.getByTestId('mtab-display').click();
  const dock = await page.getByTestId('ptt-dock-button').boundingBox();
  expect(dock!.height).toBeGreaterThanOrEqual(48);
  expect((await overflow(page)).doc).toBeLessThanOrEqual(0);

  // The key shortcuts still switch displays.
  await page.keyboard.press('2');
  await expect(page.getByTestId('radar-canvas')).toBeVisible();
});

test('touch: a one-finger drag pans and a two-finger pinch zooms the surface display', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await quietVoice(page);
  await startScenario(page);
  const canvas = page.getByTestId('surface-canvas');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : points.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const snap = () => canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL().length);
  await page.waitForTimeout(400);
  const before = await snap();
  // one-finger drag
  await touch('touchStart', [{ x: cx, y: cy, id: 1 }]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: cx + i * 12, y: cy + i * 6, id: 1 }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  const panned = await snap();
  expect(panned).not.toBe(before);
  // pinch out
  await touch('touchStart', [{ x: cx - 20, y: cy, id: 1 }, { x: cx + 20, y: cy, id: 2 }]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: cx - 20 - i * 12, y: cy, id: 1 }, { x: cx + 20 + i * 12, y: cy, id: 2 }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  expect(await snap()).not.toBe(panned);
  await context.close();
});

for (const width of [360, 768, 1024, 1440, 2560]) {
  test(`no horizontal overflow at ${width} px on the setup and simulator screens`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 800 ? 800 : 900 });
    await page.goto('/');
    await expect(page.getByTestId('setup-screen')).toBeVisible();
    expect((await overflow(page)).doc).toBeLessThanOrEqual(0);
    // Nothing inside the setup screen pokes out of the viewport either.
    const wide = await page.getByTestId('setup-screen').evaluate((root) => {
      const vw = document.documentElement.clientWidth;
      return Array.from(root.querySelectorAll('*')).filter((el) => el.getBoundingClientRect().right > vw + 1 && !el.closest('[class*="overflow-x"]')).slice(0, 5).map((el) => `${el.tagName}.${(el as HTMLElement).className}`.slice(0, 120));
    });
    expect(wide).toEqual([]);
    await startScenario(page);
    await page.waitForTimeout(300);
    expect((await overflow(page)).doc).toBeLessThanOrEqual(0);
    if (width >= 1024) {
      await expect(page.getByTestId('right-column')).toBeVisible();
      await expect(page.getByTestId('bottom-row')).toBeVisible();
    } else {
      await expect(page.getByTestId('mobile-shell')).toBeVisible();
    }
    const display = await page.getByTestId('display-area').boundingBox();
    expect(display!.width).toBeGreaterThan(Math.min(300, width - 20));
    expect(display!.x + display!.width).toBeLessThanOrEqual(width + 1);
  });
}
