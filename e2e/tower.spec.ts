import { expect, test } from '@playwright/test';
import { quietVoice, startScenario } from './helpers';

/**
 * Tower tab (3D view, three.js). Needs WebGL: Playwright's headless Chromium falls back to SwiftShader (software GL), and the flags
 * below make that explicit and stable on machines with no GPU (CI, containers). If a platform still has no WebGL the app shows
 * the `tower-error` message instead of a canvas, which this test reports as a failure on purpose.
 */
test.use({ launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

test('Tower tab renders a live WebGL scene, keys 3/1 switch views, no console errors', async ({ page }) => {
  const errors: string[] = [];
  // Network noise from the optional local weather proxy (live METAR fetch; CORS when the dev server is not on 5173) is not the tower's.
  const noise = /8787|Failed to load resource|CORS/;
  page.on('console', (m) => { if (m.type() === 'error' && !noise.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await quietVoice(page);
  await startScenario(page);

  await page.getByTestId('tab-tower').click();
  const canvas = page.getByTestId('tower-canvas');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('tower-error')).toHaveCount(0);

  // A WebGL2 context is attached to the canvas and not lost.
  const gl = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('webgl2');
    return { ok: !!ctx, lost: ctx ? ctx.isContextLost() : true, w: c.width, h: c.height };
  });
  expect(gl.ok).toBe(true);
  expect(gl.lost).toBe(false);
  expect(gl.w).toBeGreaterThan(200);

  // Frames are being drawn with real geometry (ground, runways, taxiways, buildings, lights, aircraft...).
  await expect.poll(async () => Number(await canvas.getAttribute('data-draw-calls') ?? 0), { timeout: 30_000 }).toBeGreaterThan(8);
  const f1 = Number(await canvas.getAttribute('data-frames'));
  await expect.poll(async () => Number(await canvas.getAttribute('data-frames'))).toBeGreaterThan(f1);

  // The compass strip is drawn and the controls exist; the tower site is reported.
  await expect(page.getByTestId('tower-site')).toContainText('eye 30 m AGL');
  await page.getByTestId('tower-binoculars').click();
  await expect(page.getByTestId('tower-binoculars')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('tower-binoculars').click();
  await page.getByTestId('tower-rwy-13').click();
  await page.keyboard.press(']');
  await canvas.hover();
  await page.mouse.wheel(0, -300);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 10, { steps: 6 });
  await page.mouse.up();

  // Pause keeps rendering (the camera still works); resizing the window keeps the canvas matched to its box.
  await page.keyboard.press('p');
  await page.setViewportSize({ width: 1100, height: 760 });
  await expect.poll(async () => (await canvas.evaluate((el) => (el as HTMLCanvasElement).clientWidth))).toBeLessThan(1100);

  // Leaving the tab releases the view; coming back builds a new scene; no errors throughout.
  await page.keyboard.press('1');
  await expect(page.getByTestId('surface-canvas')).toBeVisible();
  await expect(canvas).toHaveCount(0);
  await page.keyboard.press('3');
  await expect(page.getByTestId('tower-canvas')).toBeVisible();
  await expect.poll(async () => Number(await page.getByTestId('tower-canvas').getAttribute('data-draw-calls') ?? 0), { timeout: 30_000 }).toBeGreaterThan(8);

  expect(errors).toEqual([]);
});
