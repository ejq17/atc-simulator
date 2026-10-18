import fs from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/**
 * onnxruntime-web bundles a 27 MB fallback `.wasm` that transformers.js never loads at
 * runtime (it points the runtime at the CDN first). Strip the bundled fallback URL so
 * `vite build` does not emit it. See src/voice/README.md "Build size".
 */
const noBundledOrtWasm = () => ({
  name: 'no-bundled-ort-wasm',
  enforce: 'pre' as const,
  apply: 'build' as const,
  transform(code: string, id: string) {
    if (!id.includes('/onnxruntime-web/')) return null
    const re = /new URL\(\s*["']ort-wasm-simd-threaded[\w.]*\.wasm["']\s*,\s*import\.meta\.url\s*\)\.href/g
    return re.test(code) ? { code: code.replace(re, 'undefined'), map: null } : null
  },
})

// GitHub Pages serves the site under /atc-simulator/. Override with VITE_BASE (e.g. a custom domain at "/").
const onPages = Boolean(process.env.GITHUB_PAGES)
const base = process.env.VITE_BASE ?? (onPages ? '/atc-simulator/' : '/')

/** Pages has no `index.html` fallback for unknown paths: copy it to `404.html` so deep links still open the app. */
const spaFallback404 = () => ({
  name: 'spa-404-fallback',
  apply: 'build' as const,
  closeBundle() {
    const dist = path.resolve(import.meta.dirname, 'dist')
    const index = path.join(dist, 'index.html')
    if (fs.existsSync(index)) fs.copyFileSync(index, path.join(dist, '404.html'))
  },
})

// https://vite.dev/config/
export default defineConfig({
  base,
  define: {
    // No backend on Pages: the app reads this to skip /api and the localhost backend.
    'import.meta.env.VITE_STATIC_HOSTING': JSON.stringify(process.env.VITE_STATIC_HOSTING ?? (onPages ? '1' : '')),
  },
  plugins: [react(), tailwindcss(), noBundledOrtWasm(), spaFallback404()],
  worker: { plugins: () => [noBundledOrtWasm()] },
  server: {
    proxy: {
      // Local backend (server/) handles AWC weather proxying and any cloud-provider auth.
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
})
