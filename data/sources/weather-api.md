# Aviation Weather Center (AWC) Data API - verification for KACY

Verified 2026-10-16 (responses stamped `date: Sat, 17 Oct 2026 01:48 GMT`, i.e. the evening of 2026-10-16 US Eastern) with `curl`.
Raw captures are in `raw/`: `awc_metar_KACY.json`, `awc_taf_KACY.json`, `awc_metar_headers.txt`, `awc_metar_HEAD.txt`, `awc_metar_HEAD_origin.txt`, `awc_options.txt`, `awc_api_docs.html`.

## Endpoints tested

| Request | HTTP | Content-Type |
|---|---|---|
| `GET https://aviationweather.gov/api/data/metar?ids=KACY&format=json` | 200 | `application/json; charset=utf-8` |
| `GET https://aviationweather.gov/api/data/taf?ids=KACY&format=json` | 200 | `application/json; charset=utf-8` |
| `GET .../metar?ids=KACY&format=json&hours=2` | 200 | returned a 4-element array (history works) |
| `GET .../metar?ids=KACY` (no format) | 200 | plain text raw METAR |

Both JSON endpoints return a top-level JSON **array** (one element per station/report). A valid request with no data returns HTTP 204 with an empty body (per the docs), so client code must handle 204 and empty arrays.

## METAR response shape (`/api/data/metar`, format=json)

Verbatim field names and the JSON types observed (one object per observation):

```
icaoId        string   "KACY"
receiptTime   string   ISO-8601 UTC "2026-10-17T00:58:10.429Z"
obsTime       integer  Unix epoch seconds (1792198440)
reportTime    string   ISO-8601 UTC, the nominal report hour "2026-10-17T01:00:00.000Z"
temp          number   degrees C (20.6)
dewp          number   degrees C (17.2)
wdir          integer  degrees true (290); may be the string "VRB" for variable winds (not observed here, UNVERIFIED)
wspd          integer  knots (17)
wgst          integer  knots (23); null/absent when no gust (absent-vs-null behaviour not verified)
visib         string   statute miles, "10+" observed (a string, not a number)
altim         number   altimeter in hectoPascals (1010.2), NOT inHg. Raw text says A2983 (= 29.83 inHg)
slp           integer  sea-level pressure hPa (1010)
qcField       integer  QC flags (4)
precip        number   precip (0.005)
metarType     string   "METAR" (or "SPECI")
rawOb         string   "METAR KACY 170054Z 29017G23KT 10SM FEW018 BKN038 OVC049 21/17 A2983 RMK AO2 RAB38E49 PRESRR SLP100 P0000 T02060172"
lat, lon      number   station position 39.452, -74.567 (differs from the NASR ARP 39.45758, -74.57716; it is the weather-station location)
elev          integer  18  (station elevation; units not stated in the response - presumably metres, NOT verified. NASR field elevation is 74.8 ft = 22.8 m)
name          string   "Atlantic City Intl, NJ, US"
cover         string   "OVC" (highest/ceiling-driving cover)
clouds        array    [{ "cover": "FEW", "base": 1800 }, { "cover": "BKN", "base": 3800 }, { "cover": "OVC", "base": 4900 }]   base = feet AGL
fltCat        string   "VFR" (flight category computed by AWC)
```

Sample (full) METAR object: `raw/awc_metar_KACY.json`.

## TAF response shape (`/api/data/taf`, format=json)

Top level (one object per TAF):

```
icaoId, dbPopTime (ISO string), bulletinTime (ISO string), issueTime (ISO string),
validTimeFrom (epoch s), validTimeTo (epoch s), rawTAF (string), mostRecent (int 1/0),
remarks (string, " AMD" observed), lat, lon, elev, prior (int), name, fcsts (array)
```

Each `fcsts[]` element:

```
timeFrom (epoch s), timeTo (epoch s), timeBec (null observed), fcstChange (null | "FM" observed; TEMPO/BECMG/PROB values not observed - UNVERIFIED),
probability (null observed), wdir (int), wspd (int), wgst (int|null), wshearHgt, wshearDir, wshearSpd (null observed),
visib (string, "6+" observed), altim (null observed), vertVis (null observed), wxString (string|null, e.g. "-SHRA", "VCSH"),
notDecoded (null observed), clouds [ { cover, base, type } ], icgTurb [], temp []
```

The first period has `fcstChange: null`; later periods had `"FM"`. Sample: `raw/awc_taf_KACY.json` (5 forecast periods, rawTAF `TAF KACY 170145Z 1702/1724 28012G18KT P6SM -SHRA BKN040 OVC080 FM170600 ...`).

## Rate and usage guidance (from https://aviationweather.gov/data/api/, fetched 2026-10-16, saved as raw/awc_api_docs.html)

Quoted from the page:
- "Please carefully consider requests to limit load on the system. Set a custom user agent to prevent automated filtering inadvertently blocking valid traffic."
- "Consider product update frequency. For example most METARs update once per hour..."
- "Wait between consecutive requests - maximum 100 requests per minute. Exceeding request limits will result in access being blocked."
- "All requests are rate limited to 100 requests per minute. Most endpoints return a maximum of 400 entries (please consider using cache files for larger requests)."
- "Cross-origin resource sharing is not permitted at this time."
- "Undocumented query parameter requests are restricted and will result in an error."
- Status 204 = valid request with no data; 400 invalid; 403 blocked/forbidden; 404; 429 too many requests; 500/502/504 temporary.
- The weather database holds up to the previous 30 days of data. Bulk "cache files" exist (e.g. `https://aviationweather.gov/data/cache/metars.cache.xml.gz` returned HTTP 200).
- Connect via HTTPS and not the `www.` subdomain.

Response caching observed: `cache-control: max-age=60`, `etag` present. METARs for KACY are normally hourly with SPECIs as needed; polling more often than about once a minute is pointless.

## CORS: NOT PRESENT

Checked three ways, none returned any `Access-Control-Allow-*` header:
1. `curl -sI` (HEAD) on the METAR URL: no `access-control-allow-origin`.
2. `curl -sI -H "Origin: http://localhost:3000"` (HEAD with Origin): none. Only `vary: Accept-Encoding` appeared on a GET with Origin.
3. `OPTIONS` preflight with `Origin` and `Access-Control-Request-Method: GET`: HTTP 200, `allow: GET, HEAD`, body `text/plain` 9 bytes, no `access-control-*` headers.

Headers that DO appear: `content-type`, `content-length`, `cache-control: max-age=60`, `etag`, `x-frame-options: SAMEORIGIN`, `content-security-policy: frame-ancestors 'self' *.weather.gov`, `strict-transport-security`.

**Consequence:** a browser page cannot `fetch()` the AWC API directly from another origin. The simulator must call AWC through its own backend/proxy (or a serverless function) and should cache for >= 60 s, send a descriptive custom User-Agent, and stay far below 100 req/min. The docs state CORS is not permitted "at this time" (could change; re-check).

## Not verified
- `wdir` variable-wind representation ("VRB"), absent-vs-null handling of `wgst`, and other `fcstChange` values (TEMPO, BECMG, PROB) - only one sample of each was fetched.
- Units of `elev` (assumed metres).
- Behaviour on 429 (not triggered, deliberately).
