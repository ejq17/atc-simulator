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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), noBundledOrtWasm()],
  worker: { plugins: () => [noBundledOrtWasm()] },
  server: {
    proxy: {
      // Local backend (server/) handles AWC weather proxying and any cloud-provider auth.
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
})
