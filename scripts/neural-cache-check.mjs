/**
 * Proves the neural voice model is read from browser storage on the second visit.
 *
 *   npm run build && npx vite preview --port 5181 --strictPort &
 *   node scripts/neural-cache-check.mjs <profile-dir> [webgpu|wasm]      (run it twice with the same, empty-at-first profile dir)
 *
 * It opens installed Google Chrome with a persistent profile, selects the neural engine, prepares the model, and prints every
 * request that went to huggingface.co / cdn.jsdelivr.net (with byte sizes) plus the Cache API contents and storage usage.
 * First run: the model files are fetched. Second run: only the small ONNX runtime files from jsDelivr appear (HTTP cache, immutable),
 * and the model comes from the Cache API (`transformers-cache` for Kokoro, `piper-voices` for Piper).
 */
import { chromium } from '@playwright/test';

const [profile, device = 'webgpu'] = process.argv.slice(2);
if (!profile) throw new Error('usage: node scripts/neural-cache-check.mjs <profile-dir> [webgpu|wasm]');
const ctx = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chrome', baseURL: 'http://localhost:5181' });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const seen = [];
page.on('response', (r) => {
  const u = r.url();
  if (/huggingface\.co|cdn\.jsdelivr\.net|cdn-lfs|xethub/.test(u)) seen.push(`${r.status()} ${r.headers()['content-length'] ?? '?'} bytes ${u.slice(0, 100)}`);
});
await page.addInitScript((d) => localStorage.setItem('kacy.voice.settings', JSON.stringify({ providerId: 'none', ttsEngine: 'neural', neuralDevice: d })), device);
const t0 = Date.now();
await page.goto('/');
await page.getByTestId('neural-warmup').click();
await page.waitForFunction(() => ['ready', 'error'].includes(window.__kacyNeuralSynth?.getProgress().phase), null, { timeout: 600000 });
console.log(`ready after ${Date.now() - t0} ms: ${await page.evaluate(() => window.__kacyNeuralSynth.getProgress().message)}`);
console.log(`${seen.length} network responses:\n  ${seen.join('\n  ')}`);
console.log(JSON.stringify(await page.evaluate(async () => {
  const out = {};
  for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => r.url.split('/').pop());
  const e = await navigator.storage.estimate();
  out.storage = `usage ${Math.round((e.usage ?? 0) / 1e6)} MB of ${Math.round((e.quota ?? 0) / 1e6)} MB; persisted=${await navigator.storage.persisted()}`;
  return out;
}), null, 1));
await ctx.close();
