# Contributing

Thanks for looking. This is a hobby simulator; issues and pull requests are welcome.

## Not for real-world use

This is entertainment and learning software. It is not ATC training, not certified, and must never be used
for real-world operations, flight planning or navigation. Do not contribute changes that present it otherwise.

## Setup

Node 22 or newer.

```bash
npm install
npm run server   # optional local backend on :8787 (live weather, chart proxy, Deepgram token)
npm run dev      # Vite on http://localhost:5173
```

Copy `.env.example` to `.env` only if you want Deepgram speech recognition; never commit a real key.

## Checks

```bash
npm run typecheck
npm test                 # vitest (engine, parser, airport data, weather, charts, voice, UI)
npm run lint
npm run build
npm run test:e2e         # Playwright, needs browsers; see playwright.config.ts (E2E_PREVIEW=1 runs against a build)
```

Please keep typecheck and the unit tests green. The Pages workflow runs them on every push to `main`;
`ci.yml` runs them on pull requests.

## Airport data

Airport datasets are generated, not hand-edited. Source extracts with provenance live in `data/sources/`
(FAA NASR and d-TPP, OpenStreetMap, AWC). To rebuild one:

```bash
npm run build:airport -- KMHT      # or KACY; same as npx tsx scripts/build-airport.ts <ICAO>
```

Per-airport settings live in `scripts/airports/<icao>.ts`. Do not type aeronautical values in from memory:
add them to the source JSON with a provenance note, then rebuild. See `data/sources/README.md`.

## Charts

`npm run fetch-charts` downloads the FAA chart PDFs into `public/charts/` (git-ignored). Do not commit PDFs.

## Licensing

Code is MIT. FAA data is public domain. The OpenStreetMap-derived taxiway and apron layer is
(c) OpenStreetMap contributors under the ODbL 1.0; keep that attribution if you touch it.
