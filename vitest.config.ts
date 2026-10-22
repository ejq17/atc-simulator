import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts'],
    // Several tests run minutes of simulated time on the real KACY dataset; under full parallel load they exceed the 5 s default.
    testTimeout: 30000,
    // Airport data loads lazily in the app; tests keep the synchronous getAirport() API by preloading everything first.
    setupFiles: ['src/test/preloadAirports.ts'],
  },
})
