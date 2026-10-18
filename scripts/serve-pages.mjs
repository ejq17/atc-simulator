// Serves dist/ under /atc-simulator/ like GitHub Pages does (404.html for unknown paths).
//   GITHUB_PAGES=1 npm run build && node scripts/serve-pages.mjs [port]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const base = process.env.PAGES_BASE ?? '/atc-simulator/';
const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.png': 'image/png' };

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let file = null;
    if (url.pathname.startsWith(base)) {
      const rel = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html';
      const p = path.join(dist, rel.endsWith('/') ? `${rel}index.html` : rel);
      if (p.startsWith(dist) && fs.existsSync(p) && fs.statSync(p).isFile()) file = p;
    }
    const status = file ? 200 : 404;
    const out = file ?? path.join(dist, '404.html');
    res.writeHead(status, { 'Content-Type': types[path.extname(out).toLowerCase()] ?? 'application/octet-stream' });
    fs.createReadStream(out).pipe(res);
  })
  .listen(port, () => console.log(`Serving dist at http://localhost:${port}${base}`));
