/**
 * Downloads every FAA d-TPP chart PDF the in-app chart viewer references into
 * public/charts/<ICAO>/<file>.pdf so the static site (GitHub Pages) can serve them same-origin.
 *
 *   npx tsx scripts/fetch-charts.ts            (or: npm run fetch-charts)
 *   npx tsx scripts/fetch-charts.ts KACY       (one airport)
 *
 * FAA d-TPP charts are US government works (public domain). aeronav.faa.gov sends no CORS header,
 * so a browser page cannot fetch them directly; bundling them at build time is the static-hosting answer.
 *
 * Idempotent: existing, valid PDFs are skipped. Downloads are validated (%PDF header, size matches
 * Content-Length), written to a temp file and renamed, and retried with backoff. public/charts/ is git-ignored.
 * The file name is the d-TPP name exactly as in the chart index (e.g. 00669AD.PDF): it must match
 * bundledChartUrl() in src/charts/pdfLoader.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCharts } from '../src/charts/chartIndex.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(root, 'public', 'charts');
const AIRPORTS = ['KACY', 'KMHT', 'KBOS', 'KPGD', 'KPHL'];
const RETRIES = 4;
const CONCURRENCY = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isValidPdf(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(5);
    fs.readSync(fd, head, 0, 5, 0);
    fs.closeSync(fd);
    return head.toString('latin1') === '%PDF-' && fs.statSync(file).size > 1000;
  } catch {
    return false;
  }
}

async function download(url: string, dest: string): Promise<number> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'atc-simulator-chart-fetch/1.0 (+https://github.com/ejq17/atc-simulator)' }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const expected = Number(res.headers.get('content-length') ?? 0);
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('response is not a PDF');
      if (expected && buf.length !== expected) throw new Error(`truncated (${buf.length} of ${expected} bytes)`);
      const tmp = `${dest}.part`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      return buf.length;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

async function main() {
  const wanted = process.argv.slice(2).map((a) => a.toUpperCase());
  const airports = wanted.length ? wanted : AIRPORTS;
  const jobs: Array<{ icao: string; url: string; dest: string; name: string }> = [];
  for (const icao of airports) {
    const dir = path.join(outRoot, icao);
    fs.mkdirSync(dir, { recursive: true });
    const seen = new Set<string>();
    for (const c of listCharts(icao)) {
      if (seen.has(c.pdfName)) continue;
      seen.add(c.pdfName);
      jobs.push({ icao, url: c.pdfUrl, dest: path.join(dir, c.pdfName), name: `${icao}/${c.pdfName}` });
    }
  }

  let downloaded = 0;
  let skipped = 0;
  const failures: string[] = [];
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      if (isValidPdf(job.dest)) {
        skipped++;
        continue;
      }
      try {
        const n = await download(job.url, job.dest);
        downloaded++;
        console.log(`  fetched ${job.name} (${(n / 1024).toFixed(0)} KB)`);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  let total = 0;
  for (const j of jobs) if (fs.existsSync(j.dest)) total += fs.statSync(j.dest).size;
  console.log(`charts: ${jobs.length} listed, ${downloaded} downloaded, ${skipped} already present, ${failures.length} failed; ${(total / 1024 / 1024).toFixed(1)} MB in public/charts/`);
  if (failures.length) {
    for (const f of failures) console.error(`  FAILED ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
