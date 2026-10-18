import { expect, test } from '@playwright/test';
import { quietVoice, startScenario } from './helpers';

/**
 * Landline panel: a call typed in the panel reaches the AI Tower, which answers; the log and the status follow.
 *   npm run build && E2E_PREVIEW=1 E2E_PORT=5185 npx playwright test --project=chromium e2e/landline.spec.ts
 */
test.beforeEach(async ({ page }) => {
  await quietVoice(page);
  await page.addInitScript(() => localStorage.removeItem('kacy.layout.v1'));
  page.on('pageerror', (e) => { throw e; });
});

test('Ground asks AI Tower on the landline, the answer shows in the panel (Training 10)', async ({ page }) => {
  await startScenario(page, { mode: 'training', scenario: 'train-10-coordination' });
  await page.getByTestId('tab-landline').click();
  await expect(page.getByTestId('landline-panel')).toBeVisible();
  await expect(page.getByTestId('landline-incoming-list')).toContainText('Nothing waiting');

  await page.getByTestId('landline-input').fill('Tower, Ground, cross runway one three at alpha with Cessna six zero delta x-ray');
  await page.getByTestId('landline-send').click();
  await expect(page.getByTestId('landline-note')).toContainText('Asked Tower');
  await expect(page.getByTestId('landline-out').first()).toBeVisible();

  // the AI Tower reacts within a few simulated seconds; speed the clock up
  await page.getByTestId('speed-4').click().catch(() => undefined);
  await expect(page.getByTestId('landline-out').first()).toHaveAttribute('data-status', /approved|standby/, { timeout: 40_000 });
  const kinds = await page.getByTestId('landline-msg').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
  expect(kinds[0]).toBe('CROSS_REQUEST');
  expect(kinds.length).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('landline-log')).toContainText('Ground, Tower');
});

test('a call from a position the player does not work is refused with the reason', async ({ page }) => {
  await startScenario(page, { mode: 'training', scenario: 'train-10-coordination' });
  await page.getByTestId('tab-landline').click();
  await page.getByTestId('landline-input').fill('Ground, Tower, cross approved');
  await page.getByTestId('landline-send').click();
  await expect(page.getByTestId('landline-note')).toContainText('do not work Tower');
});
