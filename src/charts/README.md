# src/charts - FAA chart viewer and navaid reference

Official FAA d-TPP charts for KACY (cycle 2610, effective 2026-10-01 to 2026-10-29) and a verified navaid/fix reference table. Nothing here is invented: the chart list is built from `data/sources/kacy-procedures.json`, the navaid tables from `data/sources/kacy-navaids.json` (see `data/sources/README.md` for provenance). Reference only, not for navigation.

## Mounting

```tsx
import { ChartViewer, NavaidPanel } from './charts';

<div className="h-full"><ChartViewer /></div>            // needs a parent with a height
<NavaidPanel className="h-full" />                        // scrolls internally
```

`ChartViewer` props: `initialChartId` (d-TPP stem, e.g. `"00669ILD31"`), `onChartChange(chart)`, `proxyBase` (default `/api/charts/pdf`). The component is self-contained (chart list + header + toolbar + canvas); give it at least ~900x500 px. pdf.js is loaded lazily on first chart open.

## Backend requirement

`server/charts/chartProxy.ts` exports `handleChartProxy(req, res)`. Mount it in `server/index.ts`:

```ts
import { handleChartProxy } from './charts/chartProxy';
// inside route(), after the Host/OPTIONS handling:
if (path === '/api/charts/pdf') { await handleChartProxy(req, res); return; }
```

Vite already forwards `/api` to `localhost:8787`. The handler only fetches URLs matching `https://aeronav.faa.gov/d-tpp/<4 digits>/<[A-Za-z0-9_]+>.pdf|PDF` (anything else is 400), never follows redirects, requires a `%PDF-` body, caps size at 25 MB, caches in memory (LRU, 50 MB, 12 h) and sets `Access-Control-Allow-Origin: http://localhost:5173`.

## CORS finding

`aeronav.faa.gov` returns HTTP 200 for GET/HEAD/OPTIONS but sends no `Access-Control-Allow-Origin` header, so a browser cannot fetch the PDFs with `fetch`/XHR from another origin. Links (`<a href>`) work. The viewer therefore tries the proxy first and the direct URL second; in a normal browser the direct attempt is expected to fail, and the error panel then says the backend must be running and offers the official PDF link.

## Files

| File | Role |
|---|---|
| `chartIndex.ts` | `listCharts()`, `listChartGroups()`, `getChart()`, `CYCLE`, `isCycleCurrent()` |
| `pdfLoader.ts` | proxy-then-direct fetch, lazy pdf.js + worker setup, `destroyDoc` |
| `viewMath.ts` | zoom limits (25-400%), fit math, canvas pixel cap |
| `ChartViewer.tsx` | list, header, toolbar, canvas; wheel zoom at cursor, drag pan, fit width/page, page nav, Night (CSS invert), keyboard |
| `navaidData.ts`, `NavaidPanel.tsx` | VORTAC, ILS, nearby VORs, approach fixes with roles, provenance footers |

Keyboard: Up/Down/Home/End in the chart list; `+ - 0 w [ ]` / PageUp/PageDown in the viewer.

## Behaviour notes

- Renders at `devicePixelRatio` into an offscreen canvas, then copies (no blank flash); bitmap area capped at 16 MP.
- Renders are cancelled on zoom/page/chart change; the previous document's loading task is destroyed on chart switch and unmount.
- Charts are public-domain FAA products; RNP AR and high-altitude (USAF) charts are labelled as such.
- The "Night" toggle is a display filter on the canvas; it does not alter the chart.

## Tests

`npm test -- src/charts server/charts` (pdf.js is mocked; the proxy test mocks upstream `fetch`).

## Known limitations

- pdf.js standard-font/CMap data are not configured; FAA plates embed their fonts so this is not an issue today, but a PDF with non-embedded fonts would fall back to substitutes.
- No text search/selection layer; no offline chart storage.
- The NE-2 takeoff/alternate minimums PDFs are booklet pages covering many airports; the KACY entry must be found by the user.
- Charts are tied to cycle 2610; when `CYCLE` expires the header shows a warning, and the data files must be regenerated for the next cycle.
