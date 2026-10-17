import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Local backend (server/) handles AWC weather proxying and any cloud-provider auth.
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
})
