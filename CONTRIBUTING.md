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
(FAA NASR and d-TPP for the five US airports, the UK AIP for EGLL, OpenStreetMap, AWC). To rebuild one:

```bash
npm run build:airport -- KACY      # also KMHT, KBOS, KPHL, KPGD and EGLL; same as npx tsx scripts/build-airport.ts <ICAO>
npm run build:airport -- EGLL      # built from the hand-transcribed UK AIP files, not from NASR
```

Per-airport settings live in `scripts/airports/<icao>.ts`. Do not type aeronautical values in from memory:
add them to the source JSON with a provenance note, then rebuild. See `data/sources/README.md`; a new airport follows `docs/ADDING-AN-AIRPORT.md`.
`npx tsx scripts/extract-nasr-airport.ts` produces the facility, frequency and navaid files for a US airport; EGLL has no machine-readable source, so its JSON files are transcribed by hand from the UK AIP (each field names its AIP section).

## Raw sources

`data/sources/raw/` (git-ignored, about 230 MB) holds the downloads the provenance records refer to: the NASR CSV zips and their unzipped
`x_<NAME>_CSV/` folders (the input of `scripts/extract-nasr-airport.ts`), the d-TPP 2610 metafile and PDFs, Overpass responses, the EGLL eAIP pages and
chart PDFs, the EUROCONTROL ACD pages and the other documents the realism notes cite. `npx tsx scripts/fetch-raw-sources.ts` re-creates it:

```bash
npx tsx scripts/fetch-raw-sources.ts                   # everything, into data/sources/raw
npx tsx scripts/fetch-raw-sources.ts --only nasr,dtpp  # groups: nasr | dtpp | osm | aip | docs
npx tsx scripts/fetch-raw-sources.ts --out /path/raw   # another directory;  --list prints the plan, --verbose every row
```

Each file is validated (PDF header, XML and JSON parse, zip test), compared with the size recorded in `data/sources/README.md` or the
`*-procedures.json` `pdf.bytes`, and reported as MATCH, MISMATCH, UNRECORDED (no size recorded), REFETCH, MISSING (HTTP 404 and similar, not retried) or
FAILED; the full table is written to `fetch-report.tsv` and the SHA-256 of every file to `fetch-manifest.json` in the output directory. Existing valid files are
kept, so a second run downloads nothing. Overpass pulls and the AWC / NWS weather samples are live data: they are labelled REFETCH and differ from the record by
design. The committed `*-taxiways.geojson` carry the original `osm_base_timestamp` and stay the record; never convert a re-fetched
`overpass_<slug>_raw.json` over them. The UK AIP is (c) NATS Limited and the EUROCONTROL ACD pages need copyright permission to redistribute: they are fetched for
local provenance only. Do not commit anything under `data/sources/raw/`. To check a re-fetched NASR cycle, run
`npx tsx scripts/extract-nasr-airport.ts BOS KBOS 2026-10-01 2026-10-21` (and the other airports) and compare the output with git.

## Charts

`npm run fetch-charts` downloads the FAA chart PDFs of the five US airports into `public/charts/` (git-ignored). Do not commit PDFs. EGLL's charts (UK AIP, copyright NATS Limited) are linked, never downloaded or bundled.

## Licensing

Code is MIT. FAA data is public domain. The UK AIP data of EGLL is transcribed by hand (charts are linked only, copyright NATS Limited). The OpenStreetMap-derived taxiway and apron layer is
(c) OpenStreetMap contributors under the ODbL 1.0; keep that attribution if you touch it.
