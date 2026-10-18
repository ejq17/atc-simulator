/**
 * Hosting mode. The GitHub Pages build (GITHUB_PAGES=1, or VITE_STATIC_HOSTING=1) has no local backend:
 * there is no /api, so Deepgram is unavailable (live weather still works: it falls back to the NWS API, which allows browser calls) and FAA charts come from files bundled at build time.
 * `vite.config.ts` turns GITHUB_PAGES into VITE_STATIC_HOSTING.
 */
export function isStaticHosting(): boolean {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const v = env?.VITE_STATIC_HOSTING;
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

/** Vite base URL with a trailing slash ("/" in dev, "/atc-simulator/" on Pages). */
export function baseUrl(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const b = env?.BASE_URL ?? '/';
    return b.endsWith('/') ? b : `${b}/`;
  } catch {
    return '/';
  }
}

export const LOCAL_BACKEND_NEEDED = 'needs the local backend (npm run server)';
