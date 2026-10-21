# Local backend (`server/`)

Optional for local use only: the static GitHub Pages build does not have it (see the README, "Deploying"), so Deepgram and live weather
are unavailable there, and charts come from files bundled by `npm run fetch-charts`.

Tiny Node `http` server (no framework, no npm dependencies) used for two things only:
proxying/caching Aviation Weather Center (AWC) data, and the Deepgram token endpoint.
Secrets stay here; the browser never sees them.

```
npm run server        # tsx watch server/index.ts  -> http://127.0.0.1:8787
```

Configuration comes from `.env` in the project root (see `.env.example`; loaded by
`server/env.ts`, existing environment variables win) and the environment:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `HOST` | `127.0.0.1` | bind address (loopback only by default) |
| `DEEPGRAM_API_KEY` | unset | used by `server/voice/deepgramToken.ts` |
| `ANTHROPIC_API_KEY` | unset | enables the phrase interpreter (`server/llm/`); without it the route answers `503 LLM_NOT_CONFIGURED` |
| `ATC_LLM_MODEL` | `claude-opus-5-5` | model of the phrase interpreter (`claude-haiku-5-5` is faster and cheaper) |
| `ATC_LLM_EFFORT` | `low` | `output_config.effort` of the interpreter (`low`, `medium`, `high`, `xhigh`, `max`) |

## Routes

| Route | Description |
|---|---|
| `GET /api/health` | `{ ok, service, uptimeSec, deepgramConfigured, llmConfigured, llmModel, upstreamRequests }` |
| `GET /api/weather/metar?ids=KACY` | AWC METAR JSON array, cached 5 min |
| `GET /api/weather/taf?ids=KACY` | AWC TAF JSON array, cached 30 min |
| `GET\|POST /api/voice/deepgram-token` | delegated to `handleDeepgramToken` in `./voice/deepgramToken` |
| `POST /api/llm/parse` | phrase interpreter, `server/llm/parseRoute.ts`; contract in `src/commands/llm/contract.ts` |
| anything else | `404` JSON |

Errors are always JSON: `{ "error": { "code": "...", "message": "..." } }`.
Codes: `INVALID_IDS` 400, `METHOD_NOT_ALLOWED` 405, `NOT_FOUND` 404, `FORBIDDEN_HOST` 403,
`UPSTREAM_TIMEOUT` 504, `UPSTREAM_RATE_LIMITED` 429, `UPSTREAM_ERROR` / `UPSTREAM_BAD_RESPONSE` /
`UPSTREAM_UNREACHABLE` 502, `INTERNAL_ERROR` 500.
Weather responses carry `X-Cache: HIT|MISS|COALESCED|STALE` and `X-Cache-Age` (seconds).
`ids` must match `^[A-Z0-9,]{4,40}$` (upper case, max 10 stations).

## Phrase interpreter (`server/llm/`)

`POST /api/llm/parse` takes `{ text, context, grammar? }` (`LlmParseRequest`) and answers `{ commands, note?, model, latencyMs, usage? }`.
It asks Claude (`client.messages.parse` with a JSON-schema `output_config.format`) to map a transmission the rule grammar could not
read onto the same `kind`s and fields as `src/commands`. Errors: `INVALID_BODY` 400, `METHOD_NOT_ALLOWED` 405, `LLM_NOT_CONFIGURED` 503,
`UPSTREAM_RATE_LIMITED` 429 (with `Retry-After`), `UPSTREAM_TIMEOUT` 504, `UPSTREAM_ERROR` / `LLM_REFUSED` 502.

* What is sent to the Anthropic API: the transmission text (at most 400 characters), the aircraft list (callsign, spoken callsign, type),
  the runway ends, taxiways, frequencies, fixes and STAR arrivals of the airport, and the rule parser's guess (kinds, callsigns, issues).
  Nothing else: no player data, no audio, no session state. Transmissions are not stored or logged by the backend; one console line per
  call records model, latency and token counts only. The API key never leaves the backend.
* The system prompt (the instruction catalogue) is a constant sent with `cache_control: ephemeral`, so repeated calls read it from the
  prompt cache. `server/llm/prompt.ts` holds it and the response schema; `prompt.test.ts` keeps the `kind` list in sync with `CommandKind`
  and the table in `src/commands/README.md`.
* The response schema is flat with sentinels ("" / -1 / false / []) rather than nullable fields, because structured outputs allow at most
  16 union-typed and 24 optional parameters; the route strips the sentinels and regroups `traffic`, `info`, `ifr` and `hold`.
* The browser still resolves the callsign and validates identifiers before anything executes.

## Behaviour of the AWC client (`server/weather/awc.ts`)

* Upstream: `https://aviationweather.gov/api/data/{metar|taf}?ids=...&format=json`.
* In-memory cache per station and product (METAR 5 min, TAF 30 min). Concurrent requests for the same
  station share one in-flight upstream call, so at most one upstream request per station per TTL.
  Multi-station requests only fetch the stations that are neither fresh nor in flight.
* 10 s upstream timeout (`AbortController`), `User-Agent: kacy-atc-sim/0.1 (...)`
  (AWC asks for a custom UA so automated filtering does not block valid traffic).
* Empty results (HTTP 204 / unknown station) are cached as `[]`.
* If upstream fails and a copy younger than 2 h exists it is served (`X-Cache: STALE`).
  After a failure with nothing to serve, the station fails fast for 15 s instead of hammering AWC.
* AWC limits: 100 requests/minute, max 400 entries per query. Our worst case is far below that
  (about 1 request / 5 min for METAR, 1 / 30 min for TAF).
* The module takes an injectable `fetch` and clock (`createAwcClient({ fetch, now })`) for unit tests.

## CORS and security

* `Access-Control-Allow-Origin: http://localhost:5173` (Vite dev origin) on every response,
  never `*`, never reflected. `http://127.0.0.1:5173` is a different origin and is not allowed.
  Preflight (`OPTIONS`) allows `GET, POST, OPTIONS` and `Content-Type`.
* Binds to loopback and rejects requests whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]`
  (DNS-rebinding guard).
* The client (`src/weather/liveWeather.ts`) calls `http://localhost:8787` directly (override with
  `VITE_API_BASE`); a Vite proxy is not required because CORS is enabled for the dev origin.

## Observed AWC upstream shape (checked 2026-10-17)

AWC documentation: <https://aviationweather.gov/data/api/>. Key points from it: 100 requests/minute
limit, most endpoints return at most 400 entries, set a custom User-Agent, **cross-origin resource
sharing is not permitted**, status 204 for valid requests with no data, 400/403/404/429/5xx errors.
Verified with `curl -si -H 'Origin: http://localhost:5173' ...`: the response (200) has no
`Access-Control-Allow-*` headers, and an `OPTIONS` preflight returns `allow: GET, HEAD` with no CORS headers,
so a browser cannot call AWC directly. Hence this proxy.

`GET /api/data/metar?ids=KACY&format=json` returns an array. Observed fields of each element:

`icaoId`, `receiptTime` (ISO), `obsTime` (epoch seconds), `reportTime` (ISO), `temp` (C, decimal),
`dewp` (C, decimal), `wdir` (number, or the string `"VRB"`), `wspd` (kt), `wgst` (kt or null),
`visib` (string such as `"10+"`, or a number), `altim` (hPa, e.g. 1010.2), `slp`, `qcField`,
`precip`, `metarType` (`METAR`/`SPECI`), `rawOb` (full raw METAR text), `lat`, `lon`, `elev` (metres),
`name`, `cover` (highest/overall cover), `clouds` (`[{cover, base}]`, `base` in feet AGL, empty array for CLR),
`fltCat` (`VFR|MVFR|IFR|LIFR`).

Example (fetched 2026-10-17 01:51 UTC):
`rawOb: "METAR KACY 170054Z 29017G23KT 10SM FEW018 BKN038 OVC049 21/17 A2983 RMK AO2 RAB38E49 PRESRR SLP100 P0000 T02060172"`.

`GET /api/data/taf?ids=KACY&format=json`: `icaoId`, `dbPopTime`, `bulletinTime`, `issueTime`,
`validTimeFrom`, `validTimeTo` (epoch s), `rawTAF`, `mostRecent`, `remarks`, `lat`, `lon`, `elev`, `prior`,
`name`, and `fcsts[]` with `timeFrom`, `timeTo`, `timeBec`, `fcstChange`, `probability`, `wdir`, `wspd`,
`wgst`, `wshearHgt`, `wshearDir`, `wshearSpd`, `visib`, `altim`, `vertVis`, `wxString`, `notDecoded`,
`clouds[{cover, base, type}]`, `icgTurb`, `temp`.

The client parses `rawOb` with `src/weather/metar.ts` rather than the decoded fields, because the raw text
is the single source of truth and keeps `rawMetar` for display.

## Tests

`npm test -- server` runs: AWC client (mocked `fetch`, fake timers: TTL, coalescing, timeout, stale/backoff),
`.env` parser, and the HTTP routes against an ephemeral port with the upstream mocked.
Nothing in the tests touches the network.
