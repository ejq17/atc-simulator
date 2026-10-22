import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import { quietVoice } from './helpers';

/**
 * "The game runs clean": every airport x controller position starts a Free Play session with simulated weather, runs
 * three simulated minutes at 4x, cycles the Surface / Radar / Tower views and opens every drawer, and the browser
 * must not report a single console error or warning, uncaught page error, failed request or HTTP error response.
 *
 * Allow-list: only what is documented as expected, each entry with the reason. Keep it empty unless a message is
 * genuinely outside the app's control (a browser or driver quirk), never to hide an application defect.
 */
const ALLOWED: { pattern: RegExp; why: string }[] = [
  {
    // Printed by Chrome's own GL driver layer for the three.js Tower view when it runs on the software (SwiftShader)
    // rasteriser that headless Chromium uses; the app never calls readPixels. Not emitted on a GPU.
    pattern: /GL Driver Message .*GPU stall due to ReadPixels/,
    why: 'headless SwiftShader performance notice from the browser, not application code',
  },
  {
    // Closing the Charts drawer (Escape) while its PDF is still downloading cancels the fetch with an AbortController on
    // purpose (src/charts/pdfLoader.ts); Chromium reports the cancelled request as requestfailed.
    pattern: /^GET \S*\/api\/charts\/pdf\S* net::ERR_ABORTED$/,
    why: 'user-initiated cancel of a chart download',
  },
];

const AIRPORTS = ['KACY', 'KMHT'] as const;
const POSITIONS = [
  { value: 'CLNC', name: 'Clearance' },
  { value: 'GND', name: 'Ground' },
  { value: 'TWR', name: 'Tower' },
  { value: 'APP', name: 'Approach' },
  { value: 'ALL', name: 'all positions' },
] as const;

interface Finding { kind: string; text: string }

function watch(page: Page): Finding[] {
  const found: Finding[] = [];
  const keep = (kind: string, text: string) => {
    if (!ALLOWED.some((a) => a.pattern.test(text))) found.push({ kind, text });
  };
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' || m.type() === 'warning') keep(`console.${m.type()}`, `${m.text()} @ ${m.location().url}:${m.location().lineNumber}`);
  });
  page.on('pageerror', (e) => keep('pageerror', e.stack ?? String(e)));
  page.on('requestfailed', (r) => keep('requestfailed', `${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => {
    if (r.status() >= 400) keep('http', `${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return found;
}

async function startFreePlay(page: Page, icao: string, position: string) {
  await page.goto('/');
  await expect(page.getByTestId('setup-screen')).toBeVisible();
  await page.getByTestId('airport-select').selectOption(icao);
  await page.getByTestId('mode-free').click();
  await page.getByTestId('weather-select').selectOption('preset:clear');
  await page.getByTestId(`position-${position}`).click();
  await page.getByTestId('seed-input').fill('11');
  await page.getByTestId('start-session').click();
  await expect(page.getByTestId('sim-screen')).toBeVisible({ timeout: 30_000 });
}

async function simSeconds(page: Page): Promise<number> {
  const t = (await page.getByTestId('sim-time').textContent()) ?? '00:00:00';
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

for (const icao of AIRPORTS) {
  for (const pos of POSITIONS) {
    test(`${icao} as ${pos.name}: 3 sim minutes, every view and drawer, no console output`, async ({ page }) => {
      test.setTimeout(420_000); // 3 sim minutes is 45 s of wall time at 4x on an idle machine; CPU-starved CI or a busy laptop takes several times that
      await quietVoice(page);
      const found = watch(page);

      await startFreePlay(page, icao, pos.value);
      await page.getByTestId('speed-4').click();

      // Views: the Surface tab is shown first; visit Radar and Tower (when the layout places them as tabs) and come back.
      for (const view of ['radar', 'tower', 'surface']) {
        const tab = page.getByTestId(`tab-${view}`);
        if (await tab.count()) {
          await tab.first().click();
          await page.waitForTimeout(view === 'tower' ? 1500 : 400);
        }
      }

      // Every drawer, opened from the top bar and closed with Escape.
      for (const opener of ['open-charts', 'open-navaids', 'atis-button', 'runway-config', 'open-settings']) {
        await page.getByTestId(opener).first().click();
        await page.waitForTimeout(500);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
      }

      // Three simulated minutes at 4x is 45 s of wall time.
      await expect.poll(() => simSeconds(page), { timeout: 300_000, intervals: [1000] }).toBeGreaterThanOrEqual(180);

      // A final pass over the views after traffic has appeared.
      for (const view of ['radar', 'tower', 'surface']) {
        const tab = page.getByTestId(`tab-${view}`);
        if (await tab.count()) await tab.first().click();
        await page.waitForTimeout(300);
      }

      expect(found, found.map((f) => `${f.kind}: ${f.text}`).join('\n')).toEqual([]);
    });
  }
}
