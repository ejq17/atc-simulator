import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Typed-command mode, no TTS, no microphone: the e2e suite never touches audio. */
export async function quietVoice(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('kacy.voice.settings', JSON.stringify({ providerId: 'none', ttsEnabled: false, radioEffectsEnabled: false }));
  });
}

export type Mode = 'free' | 'career' | 'training';

/**
 * Setup screen -> sim screen. Defaults to career step 1 ("First radio transmission"): N723EJ holding short of
 * runway 13, the milestone scenario from the brief. A fixed seed keeps pilot readbacks deterministic.
 */
export async function startScenario(page: Page, opts: { mode?: Mode; scenario?: string; seed?: string } = {}) {
  const { mode = 'career', scenario = 'career-01-first-radio', seed = '7' } = opts;
  await page.goto('/');
  await expect(page.getByTestId('setup-screen')).toBeVisible();
  await page.getByTestId(`mode-${mode}`).click();
  await page.getByTestId(`scenario-${scenario}`).click();
  await page.getByTestId('seed-input').fill(seed);
  await page.getByTestId('start-session').click();
  await expect(page.getByTestId('sim-screen')).toBeVisible({ timeout: 30_000 });
}

/** Number of canvas pixels that are clearly not background (proves something was drawn). */
export async function litPixels(page: Page, testId: string): Promise<{ width: number; height: number; lit: number }> {
  return page.getByTestId(testId).evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { width, height } = c;
    const d = ctx.getImageData(0, 0, width, height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 70 || d[i + 1] > 70 || d[i + 2] > 70) lit++;
    return { width, height, lit };
  });
}

export const TAKEOFF_CALL = 'Cessna seven two three echo juliet, runway one three, cleared for takeoff';
export const TAKEOFF_READBACK = 'Runway one three, cleared for takeoff, Cessna seven two three echo juliet';

export async function sendCommand(page: Page, text: string) {
  const input = page.getByTestId('command-input');
  await input.fill(text);
  await input.press('Enter');
}
