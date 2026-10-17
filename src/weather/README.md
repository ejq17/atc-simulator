# Weather and ATIS (`src/weather/`)

Pure TypeScript, no DOM dependency (except `liveWeather.ts`, which uses `fetch`). Produces and consumes the
`Weather` and `Atis` contracts from `src/sim/types.ts`.

| File | Purpose |
|---|---|
| `metar.ts` | `parseMetar(raw)` -> `Weather`; `parseMetarDetailed(raw)` (adds station, time group, AUTO/COR, variable wind sector, remarks, missing/unparsed groups); `computeFlightCategory`, `ceilingFt`, `windMagnetic`, `KACY_MAGNETIC_VARIATION_DEG` (-10) |
| `presets.ts` | `WEATHER_PRESETS` (clear, light-crosswinds, strong-winds, low-visibility, rain, thunderstorms, imc), `getPresetWeather(id)`, `randomWeather(seed)` (inline mulberry32) |
| `runwaySelection.ts` | `headwindComponent`, `crosswindComponent`, `crosswindSigned`, `recommendRunways` |
| `atis.ts` | `generateAtis`, `nextAtisLetter`, `atisNeedsUpdate` / `atisUpdateReasons`, spoken-number helpers |
| `liveWeather.ts` | `fetchLiveMetar(icao)` through the local backend, typed `LiveWeatherError` |

## Conventions

* **Wind direction in `Weather` is TRUE** (METAR winds are true). Tower/ATIS/pilots use MAGNETIC:
  `windMagnetic(weather, variationDeg)` where variation is east-positive (KACY = 10 W = `-10`, so magnetic =
  true + 10). Runway headings passed to `recommendRunways` are magnetic (KACY 4/22/13/31 = 038/218/128/308);
  the function converts the stored true wind itself (default variation `-10`).
* Visibility is statute miles: `P6SM` -> 6, `M1/4SM` -> 0.25, `1 1/2SM` -> 1.5, metric `9999` -> 10.
* `phenomena` keeps intensity/proximity prefixes: `-RA`, `+TSRA`, `VCTS`, `BR`.
* `clouds` for SKC/CLR/NCD/NSC is one entry `{cover:'SKC'|'CLR', baseFtAgl:0}` (base is meaningless).
  Ceiling = lowest BKN/OVC/VV; `ceilingFt(clouds)` returns `undefined` when none.
* Flight category: LIFR if ceiling < 500 or vis < 1; IFR if < 1000 or < 3; MVFR if <= 3000 or <= 5
  (vis 3-5); else VFR. The worse of ceiling and visibility wins.
* Missing METAR groups get defaults (vis 10 SM, temp 15 C, dewpoint = temp or 10 C, altimeter 29.92, wind
  calm) and are listed in `parseMetarDetailed(...).missing`. Remarks (after `RMK`) are never interpreted;
  `rawMetar` keeps the full string.
* `observedAt` is only set if you pass `{ referenceDate }` (METAR carries day/time only); `fetchLiveMetar`
  sets it from AWC `obsTime`.

## ATIS

```ts
const atis = generateAtis({
  airportName: 'Atlantic City', icao: 'KACY', weather, variationDeg: -10,
  activeRunways: { landing: ['31'], departing: ['31'] },
  letter: 'B', timeUtc: new Date(), elevationFt: 75,
  approachesInUse: ['ILS runway 31 approach'], // optional; default VFR -> visual, else ILS
  notams: ['Taxiway B closed'],                // optional
});
```

Sample (live KACY METAR fetched 2026-10-17, runway 31):

```
text:       Atlantic City Airport information Bravo, 0100 Zulu. Wind 300 at 17, gusts 23. Visibility 10.
            Sky condition few clouds at 1800, ceiling 3800 broken, overcast 4900. Temperature 21, dew point 17.
            Altimeter 29.83. Visual approach runway 31 in use. NOTAMs: Taxiway B closed.
            Read back all runway hold short instructions. Advise on initial contact you have information Bravo.
spokenText: ... Wind three zero zero at one seven, gusts two three. Visibility one zero. ... Altimeter two niner
            eight three. ... Notices to air missions: Taxiway B closed. ...
```

Content and order follow 7110.65 2-9-3 and AIM 4-1-13 (see `docs/PHRASEOLOGY-AUDIT.md`): the approach in use names the landing
runway, a departure runway is added only when it differs ("Departing runway 4."), and the hold-short readback statement is
included unless `holdShortReadback: false`.

The result extends `Atis` (`letter`, `text`, `issuedAtSec`, `activeRunways`, `simulated: true`) with
`spokenText`, `phonetic`, `timeZulu`, `simulatedLabel` (**"SIMULATED – not the real KACY ATIS"**, UI must show it),
and a `weather` snapshot used by `atisNeedsUpdate`. The text uses the phonetic word ("information Bravo");
`letter` stays "B". The disclaimer is a separate field, not spoken in `spokenText`. Wind direction is rounded to
tens and converted to magnetic. `issuedAtSec` is the sim clock value you pass (`issuedAtSec`, default 0).
Cloud heights are AGL, so `elevationFt` is only echoed back as `fieldElevationFt`.

`nextAtisLetter('Z') === 'A'`. `atisNeedsUpdate(prevAtis, nextWeather, nextRunways?)` is true when: wind direction
changes >= 30 degrees (ignored while both calm; variable<->steady counts), wind speed or gusts change >= 5 kt,
altimeter changes >= 0.02 inHg, visibility or ceiling crosses a category boundary (LIFR/IFR/MVFR/VFR bands each),
a thunderstorm appears/disappears (addition beyond the brief), or the runway set changes.

## Live weather

`fetchLiveMetar('KACY')` calls `http://localhost:8787/api/weather/metar?ids=KACY` (override with `VITE_API_BASE`).
AWC has no CORS support, so it is never called from the browser. Failures throw `LiveWeatherError` with
`code` in `BACKEND_UNREACHABLE | BACKEND_ERROR | NO_DATA | BAD_RESPONSE | TIMEOUT`; the unreachable/timeout
messages tell the user to run `npm run server`. Live data is an input to the simulation, not a claim about real
airport operations.

## Tests

`npm test -- src/weather`: about 50 METARs (18 real ones fetched from AWC on 2026-10-17, KACY included, plus hand-built edge cases),
category thresholds, wind maths, runway recommendation, presets/random weather, ATIS text and spoken rendering,
`atisNeedsUpdate`, and the live client with a mocked `fetch`.
