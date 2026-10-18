# Voice subsystem (`src/voice`)

Push-to-talk -> speech-to-text provider -> text for the command parser, plus
pilot text-to-speech with radio clicks. Browser APIs only; the npm dependencies are
`@huggingface/transformers` (on-device Whisper) and `kokoro-js` (on-device neural pilot voice), both loaded lazily inside Web Workers.

```
src/voice/
  stt/        types (provider interface, VoiceStatus), webSpeechProvider, deepgramProvider,
              localWhisperProvider (on-device Whisper), whisperWorker + whisperProtocol (decoding thread), aviationPostProcess, pcmCapture (mic -> 16 kHz PCM),
              aviationVocab, providerNotes (STT_PROVIDER_NOTES)
  ptt.ts      createPushToTalk (hold/toggle, runtime key change, bindButton)
  voiceController.ts   PTT + provider orchestration, status events
  tts/        browserTts (speechSynthesis), voiceAssignment, prepareForTts;
              neuralTts (Kokoro provider: queueing, pre-synthesis, fallback, latency budget), kokoroSynth + kokoroWorker (Kokoro, WebGPU) + piperWorker (Piper, WebAssembly) + kokoroProtocol (model in a Worker),
              radioVariation (per-callsign voice/rate/pitch/radio profile, distance quality), speechChunks, engineTts (engine selection, shared synthesiser)
  audio/      radioEffects (WebAudio clicks + static + the shared 300-3000 Hz chain), transmissionGraph (per-transmission graph for neural speech)
  audio/unlock.ts   unlockAudio() (call from a click) + the page-wide AudioContext
  transmissionQueue.ts, pilotVoice.ts   one speaker at a time, several audible frequencies, stepped-on handling, stuck-key watchdog
  tts/ttsDebug.ts   window.__kacyTts (what the app asked Chrome to say and what Chrome did)
  settings.ts (localStorage `kacy.voice.settings`, VOICE_PRIVACY_NOTES), transcriptLog.ts
server/voice/deepgramToken.ts   short-lived Deepgram token endpoint
```

## Setup

Browser speech works with no setup in Chrome/Edge (HTTPS or `localhost` is
required for microphone access).

Local Whisper (no cloud, no key): pick **Local Whisper (on-device, no cloud)** in Settings (also on the setup screen) and
press **Download / prepare local model** once. It downloads the chosen model once (40 to 250 MB on the CPU, see the table below) and then works offline.

Deepgram (optional, better with callsigns and phonetics):

1. Create a Deepgram API key with at least **Member** permission (needed for the token grant call).
2. Export it for the local server: `DEEPGRAM_API_KEY=... npm run server`. Never put it in the repo, in `VITE_*` variables, or in frontend code.
3. The server must route `/api/voice/deepgram-token` to `handleDeepgramToken(req, res)` from `server/voice/deepgramToken.ts`
   (Vite already proxies `/api` to `localhost:8787`). `GET` returns `{ configured }`; `POST` returns `{ access_token, expires_in }`.
   With the variable unset, POST answers `503` with a clear message and the UI shows the provider as unavailable.

### Wiring example

```ts
import {
  createBrowserTts, createPilotVoice, createRadioEffects, createTranscriptLog,
  createVoiceController, createVoiceSettingsStore,
} from '../voice';

const settings = createVoiceSettingsStore();
const radio = createRadioEffects({ enabled: settings.get().radioEffectsEnabled });
const pilots = createPilotVoice({ tts: createBrowserTts(), settings, radio, monitoredFrequencyMhz: 119.4 });
const log = createTranscriptLog(settings);

const voice = createVoiceController({
  providerId: settings.get().providerId,
  ptt: { key: settings.get().pttKey, mode: settings.get().pttMode },
  onTransmission(text, meta) {
    log.add({ text, source: meta.source, confidence: meta.confidence });
    // parse(text) -> engine.applyCommand(...)
  },
});
voice.onTransmittingChange((on) => pilots.setControllerTransmitting(on)); // controller steps on pilots
voice.onStatusChange((e) => setVoiceStatus(e));      // 'idle' | 'listening' | 'processing' | 'error' | ...
voice.onPartial((text) => setLivePartial(text));
settings.subscribe((s) => { voice.ptt?.setKey(s.pttKey); voice.ptt?.setMode(s.pttMode); void voice.setProvider(s.providerId); });
voice.ptt?.bindButton(onScreenButtonEl);            // mouse/touch button

// Engine pilot readback -> speech (only audible on a monitored frequency):
pilots.enqueue({ text: readback.spokenText, voiceId: aircraft.voiceId, frequencyMhz: aircraft.frequencyMhz, volume: 1, speaker: callsign });
pilots.setMonitoredFrequencies([120.3, 121.9]);     // all frequencies the controller works (or every one, quieter, with "Monitor all")
pilots.setMonitoredFrequency(121.9);                // single-frequency shorthand
voice.simulateTransmission('Spirit one two three taxi runway one three'); // typed fallback
```

Call `radio.startStatic()` only if you want the faint static bed (it starts audio, so do it after a user gesture).

## Pilot audibility (why pilots can be silent, and what prevents it)

`unlockAudio()` **must run inside a click** (the app calls it from `startSession`, i.e. the Start session / Play again click): it resumes the shared AudioContext (radio clicks use it;
`createRadioEffects` takes `getSharedAudioContext()` by default and no longer closes it on dispose), primes speech synthesis with a silent utterance (`volume 0`) and starts the voice
list loading. Without it Chrome refuses `speak()` ("not-allowed") and a suspended AudioContext makes no click.

| Cause of silence | Fix |
|---|---|
| No user gesture before audio | `unlockAudio()` in the Start click |
| `getVoices()` is empty until `voiceschanged` (measured in Chrome 155: 0 voices at first, 180 about a second later) | `createBrowserTts().whenVoicesReady()`; the first `speak()` waits up to `voicesTimeoutMs` (2 s) so each pilot gets its voice |
| Queue only played the *one* monitored frequency, so a player on Tower + Ground lost calls | `monitoredFrequenciesMhz` / `setMonitoredFrequencies([...])`; items carry `volume` (monitored-only traffic is quieter) and `speaker` |
| Controller PTT stuck "down" blocked pilots for ever | `maxControllerKeyMs` watchdog (30 s) releases it; the session also releases on recogniser idle/error; `maxSpeakMs` (60 s) abandons speech that never reports back |
| Paused speech queue, or the utterance object garbage-collected | `synth.resume()` before `speak`, in-flight utterances kept in a module-level set |
| Cancelled by re-renders | Speech belongs to the framework-free session, not to React; `cancel()` is called only for step-on, Pilot audio off, ATIS "Listen" and teardown |
| Muted without noticing | the UI has a separate **Pilot audio: on/off** switch with a live "speaking" lamp (`createPilotVoice({ onSpeaking })`) and says "no voices loaded" / "no speech support"; `Mic off` refers only to speech input |

Settings: `ttsEnabled` ("Pilot audio", default **on**; off = nothing is queued, no radio clicks, speech in progress is cut), `monitorAll` ("Monitor all frequencies", default off, then
`MONITOR_ALL_VOLUME` = 0.45 of the user's volume for frequencies the player does not work).

### Proof in real Chrome (`chrome-pilot-tts`)

`window.__kacyTts` (non-production builds, or localStorage `kacy.debug.tts=1`) records every utterance: `text` (what the engine's pilot said), `utterance` (after `prepareForTts`), voice, rate,
pitch, volume, `startedAtMs` (the utterance's `onstart`), `endedAtMs`, `outcome` (`end`, `error:<code>`, `cancelled`, `timeout`), plus `voices`, `started[]`, `ended[]`, `errors[]` and the
unlock result. `npx playwright test --project=chrome-pilot-tts` (installed Google Chrome, new headless, macOS system voices, no network) types a takeoff clearance and asserts that Chrome
started and finished the readback utterance with text equal to the readback, that `getVoices().length > 0`, that different aircraft get different voice profiles, that Pilot audio off silences
it, that AI Tower is silent by default and spoken at 45 % volume with Monitor all, and that the Settings "Play test call" speaks. Observed on the build machine (Chrome 155, macOS): 180 voices;
"Runway one three, cleared for takeoff, Cessna seven two three echo juliet" spoken by "Ralph" (rate 1.22, pitch 0.94) from `onstart` to `end` in about 3.7 s.

## Providers and what they cost

| Provider | Audio goes to | Cost |
|---|---|---|
| Browser (Web Speech) | **Chrome: Google servers; Edge: Microsoft.** Not processed on-device. | Free |
| Deepgram | Direct browser -> `api.deepgram.com` WebSocket | Nova-3 streaming, pay-as-you-go: **$0.0048 per minute** (about $0.29/hour); new accounts get $200 credit. Source: https://deepgram.com/pricing (checked 2026-10-16; prices change). |
| Local Whisper | **Nowhere.** Audio is buffered in memory in this tab, transcribed on your computer, then dropped. Only model files are downloaded (huggingface.co, once; ONNX runtime from cdn.jsdelivr.net). | Free. 40 to 250 MB cached in the browser (model table below; 120 to 590 MB for the WebGPU variants). Uses your GPU when the browser has WebGPU, else your CPU. |
| Off | Nothing captured | Free |

Only the seconds the PTT key is held are streamed, so a typical session costs a few cents.

Deepgram details: model `nova-3` (falls back to `nova-2` if the connection is refused), `language=en-US`,
`smart_format=false` (keep spoken numbers as words), `interim_results=true`, `endpointing=300`,
`encoding=linear16&sample_rate=16000`, aviation `keyterm`s (Nova-3) or boosted `keywords` (Nova-2).

Docs checked: [streaming reference](https://developers.deepgram.com/reference/speech-to-text/listen-streaming),
[token grant](https://developers.deepgram.com/reference/auth/tokens/grant) (30 s default TTL; we request 60 s, which only needs to cover the handshake),
[token auth](https://developers.deepgram.com/docs/token-based-authentication) (max TTL 3600 s),
[Sec-WebSocket-Protocol](https://developers.deepgram.com/docs/using-the-sec-websocket-protocol).
The docs show `['token', <API key>]` and do not say which subprotocol a temporary JWT uses in a browser; the provider tries
`['token', jwt]` first and automatically retries `['bearer', jwt]`, remembering whichever works. **Verify this once against a real
key** (it could not be exercised here).

## Local Whisper (`whisper-local`)

`stt/localWhisperProvider.ts` runs Whisper in the browser with transformers.js (`@huggingface/transformers` 4.3.1) on WebGPU
when the browser has it, otherwise on WebAssembly (CPU).

* **Model and device choice** (Settings > Speech input; `whisperModel` / `whisperDevice` in `kacy.voice.settings`, resolution in
  `stt/whisperModels.ts`). Both default to `auto`. The shared provider (`getLocalWhisperProvider()`) follows the settings store:
  changing either terminates the old worker, resets the status to "not prepared" and loads the new model on the next use.

  | Choice | Hugging Face id | CPU download (q8) | WebGPU download (fp32 encoder + q4 decoder) | Notes |
  |---|---|---|---|---|
  | `tiny.en` | `onnx-community/whisper-tiny.en` | 40 MB | 120 MB | fastest, least accurate (the old default) |
  | `base.en` | `onnx-community/whisper-base.en` | 77 MB | 206 MB | `auto` on a CPU; clearly better callsigns/numbers |
  | `small.en` | `onnx-community/whisper-small.en` | 250 MB | 586 MB | `auto` on WebGPU; most accurate |

  Device `auto` = `webgpu` when `navigator.gpu` exists, else `wasm`; the worker re-checks (`navigator.gpu` and `requestAdapter()`)
  and errors if it cannot get a GPU. Model `auto` = `small.en` on WebGPU, `base.en` otherwise. dtype: `q8` on WASM; on WebGPU
  `{ encoder_model: 'fp32', decoder_model_merged: 'q4' }` (the combination the transformers.js Whisper WebGPU demos use; q8 on
  WebGPU is unreliable). Moonshine is handled by the 4.3.1 ASR pipeline but is not offered (not evaluated on aviation phrases).
* **WebGPU fallback.** If loading on WebGPU fails (no adapter, shader/ORT error; a network failure is not treated as a GPU
  problem) or the first transcription throws, the provider switches to WebAssembly with the *same model*, logs once with
  `console.info`, shows it in the progress message ("...fell back to CPU") and remembers it for the page session
  (`markWebGpuFailed()`), so later presses do not retry the GPU. Reload the page to try WebGPU again.
* **Beam search.** `createLocalWhisperProvider({ numBeams: 3 })` passes `num_beams` to `generate()` (supported by 4.3.1 for
  Whisper). Off by default: it is slower, especially on WASM.
* **Measured** (Apple-silicon Mac, fake-mic fixture clips of 4 to 5 s, `e2e/voice.spec.ts`; key release to transcript, includes
  about 1 s of test polling): `base.en` on WASM about 3.0 s; `small.en` on WASM 9.0 to 10 s; `small.en` on WebGPU (Google Chrome)
  about 2.0 s. Run the spec with `E2E_WHISPER_MODEL=tiny.en|base.en|small.en|auto` and `E2E_WHISPER_DEVICE=wasm|webgpu|auto`
  (default `base.en`/`wasm`); `E2E_CHANNEL=chrome` uses installed Chrome, which has WebGPU, unlike headless Chromium.

* **Threading.** The transformers.js pipeline runs in a module Web Worker (`stt/whisperWorker.ts`, protocol in `stt/whisperProtocol.ts`):
  model start-up and decoding never block the UI thread. The page transfers (not copies) the Float32 PCM buffer and receives
  `progress` / `ready` / `result` / `error` messages; the provider's public interface is unchanged. If `Worker` is missing or the worker
  script cannot start, the provider falls back to decoding on the main thread and logs one notice
  (`provider.getEngine()` reports `'worker'` or `'main'`). Measured with a Long Tasks observer and a requestAnimationFrame gap probe in
  `e2e/voice.spec.ts` (Apple-silicon laptop, headless Chromium, 5 s call): main-thread decode = one 930-960 ms long task and a ~920-950 ms
  frame gap; worker = no long tasks and a 17 ms worst frame gap. Key release to transcript went from about 1.2 s to about 1.5 s
  (message passing plus the worker's own WASM threads); the UI stays live meanwhile.
  `dispose()` releases the idle audio graph but keeps the worker (and its loaded model) for the next session.
* **Flow.** PTT down: `getUserMedia` + `pcmCapture` fill a 16 kHz mono buffer (nothing is partial-streamed). PTT up:
  `onPartial('Transcribing…')`, `pipeline('automatic-speech-recognition', model)` over the buffer, the text is cleaned by
  `aviationPostProcess.ts`, then `onPartial(text)` and `onFinal(text, { durationMs })` (no confidence: Whisper reports none).
  The controller waits up to `provider.finalTimeoutMs` (180 s, covers a first-ever download) instead of the 2.5 s streaming
  default and never submits the placeholder as a transmission.
* **Accuracy.** `tiny.en` drifts on callsigns and phonetics ("hotel Fox drive Alpha" for "hotel Foxtrot Alpha"); `base.en` and
  `small.en` get the fixture clips right ("Cessna 723 Echo Juliet, runway 13, cleared for takeoff"). Tests can still pass an
  explicit `model` id (and `device`) to `createLocalWhisperProvider`, which overrides the settings. Multilingual checkpoints get `language: 'en', task: 'transcribe'`; **English-only
  checkpoints must not receive them** (transformers.js 4.3.1 throws).
* **Aviation prompt: not supported yet.** `prompt_ids` exists in the generation config type but `generate()` in 4.3.1 ignores it and the
  processor has no `get_prompt_ids()`. Vocabulary help therefore lives in `aviationPostProcess.ts` (Cessna spellings, silence
  hallucinations such as "Thank you.") and in the command parser's own lexicon (numbers, NATO words, `clear to land`).
* **Progress.** `provider.onProgress(listener)` (replays the current state), `provider.getProgress()`, and
  `provider.warmUp()` which downloads and initialises the model without opening the microphone. The Settings form shows this.
  `getLocalWhisperProvider()` returns the app-wide instance so the Settings button and the voice controller share one loaded model.
* **Failure modes** (all reported through `onError`/status, never thrown into the UI): no WebAssembly -> `unsupported`;
  model download or runtime fetch failed -> `network` (a failed load is not cached, so the next press retries); mic denied ->
  `not_allowed`; silence, a tap under 0.25 s, or a hallucinated "Thank you." -> `no_speech`.
* **Latency.** Building an AudioContext and compiling the capture worklet takes about half a second, and speech in that window is
  lost (measured: the first word of the call vanished). The provider therefore builds an idle `WarmAudio` graph (no microphone) in
  parallel with `getUserMedia` on the first press and reuses it afterwards; `prepare()` builds it when the provider is selected.
* **Network.** First use needs huggingface.co (model files) and cdn.jsdelivr.net (ONNX runtime `.wasm`, chosen by transformers.js
  by default). Both are cached by the browser, after which it runs offline.

## Local neural pilot voice (Kokoro-82M)

Browser `speechSynthesis` cannot be routed into WebAudio, so it can never sound like a radio. **Settings > Pilot voice engine > Local neural** replaces it with Kokoro-82M
(`kokoro-js` 1.2.1, Apache-2.0, ONNX, model `onnx-community/Kokoro-82M-v1.0-ONNX`) running in a module Web Worker. The text is turned into an `AudioBuffer`, and that buffer is played through
the radio chain. Free, no key, no server: it works on the static GitHub Pages build (model and voice-style files from huggingface.co, ONNX runtime from cdn.jsdelivr.net, both cached by the
browser; the text to speak never leaves the machine).

```
queue.enqueue(item)  ->  speaker.prepare(item)  ->  neuralTts.prepare(): plan (voice, speed, pieces) and synthesise ahead, results cached (single use, 6 entries)
queue pump           ->  speaker.speak(item, keyUp) -> neuralTts.speak(): wait <= latency budget for piece 1  --(late/failed/not ready)-->  keyUp(), browser TTS for this call
                                                     |
                  piece 1 -> keyUp() (PTT click) + buildTransmissionGraph(...).start() at the same instant; later pieces -> graph.append() as they arrive; graph.finish() -> squelch tail
   speech sources -> highpass -> lowpass -> drive -> soft clipper -> compressor -> fading flutter -> output -+-> RadioEffects.getInputNode()  (300-3000 Hz, waveshaper, compressor, master)
   noise source   -> highpass -> lowpass -> noise gain (carrier hiss, tail) --------------------------------^   (or ctx.destination when "Radio effects" is off)
```

* **Pieces.** `speechChunks.splitSpeech` cuts a call at punctuation: the first piece has at least 3 words ("Runway one three,"), later pieces at most 14. The model works one piece at a time, in order; the
  first piece starts playing while the rest is synthesised (the model is faster than speech on WebGPU), and the pieces are scheduled back to back. Near-silent lead-in/tail is trimmed (`trimSilence`).
* **Pre-synthesis.** `TransmissionSpeaker.prepare(item)` is called when a call enters the queue, so the next call is already synthesised (or in progress) while the current one plays. `speak()` reuses that result
  (cache key: voice, speed, text); an entry is removed when its playback starts, a cancelled call that never played stays cached for the stepped-on retry.
* **Fallback and budget.** The browser provider speaks the call when the model is not ready (it keeps loading in the background), the synthesiser fails, piece 1 is not ready within `latencyBudgetMs` (3000 ms from the `speak()` call),
  or there is no audio output. A later piece that fails or is late is spoken by the browser voice (the rest of the text only). Three consecutive failures or overruns switch the neural voice off for 60 s (`cooldownMs`). A WebGPU
  load failure or a WebGPU error while synthesising drops to WebAssembly for the rest of the page session (same pattern as Whisper). Debug: `localStorage kacy.neural.budgetMs` (200 to 600000), `kacy.neural.dtype`.
* **Device and model files** (Settings > Local neural voice; `neuralDevice` in `kacy.voice.settings`, default `auto` = WebGPU when `navigator.gpu` exists, else WebAssembly). Same worker protocol for both engines:

  | Device | Engine | Files | Download | Why |
  |---|---|---|---|---|
  | WebGPU | Kokoro-82M `fp32` (`kokoroWorker.ts`) | `onnx/model.onnx` | 326 MB | the only WebGPU variant that was both intelligible and fast, see the table below |
  | WebAssembly | Piper VITS, `en_US-libritts_r-medium` (`piperWorker.ts`) | `en_US-libritts_r-medium.onnx` + `.json` | 79 MB | faster than real time on one WASM thread, intelligible, under 100 MB; Kokoro q8 on WASM was 1.6 to 2.3x slower than real time |

  Piper runs on `onnxruntime-web/wasm` (pinned to the version transformers.js uses) and phonemises with the `phonemizer` package (espeak-ng en-us), the same phonemiser kokoro-js uses; the model is fetched with progress
  from `rhasspy/piper-voices` on huggingface.co and stored by us in the Cache API (`piper-voices`). Voice: libritts_r has 904 speakers; nine were picked (`PIPER_PILOT_SIDS`) and two for controllers by running a sample of every 25th speaker
  through Whisper (clean transcription of "Cessna 723 Echo Juliet") plus a crude pitch estimate for a male/female mix. The voice data is LibriTTS-R, **CC BY 4.0** (attribution in the README); the code is MIT (onnxruntime-web) and Apache-2.0 (phonemizer).
  The first WebGPU synthesis compiles shaders (5.7 s measured), so the Kokoro load ends with a throw-away synthesis ("Warming up the neural voice").
* **Model caching (verified).** Kokoro files go through transformers.js into the Cache API (`transformers-cache`, voice styles in `kokoro-voices`), Piper files into `piper-voices`. `scripts/neural-cache-check.mjs` opens installed
  Chrome with a persistent profile, prepares the model and lists every request to huggingface.co / jsDelivr: first run 10 responses incl. the 326 MB `model.onnx` (ready after 13.7 s, storage usage 326 MB); **second run: 2 responses, both
  the 4 MB ONNX runtime from jsDelivr (immutable, one-year HTTP cache), no model request, ready after 5.0 s**. Piper: first run fetches `en_US-libritts_r-medium.onnx` (usage 79 MB), second run only the runtime (ready after 2.6 s).
  The earlier `Cache.put` failure for the 326 MB file happened only in Playwright's ephemeral (incognito-style) context; with a persistent profile quota was 11 GB. `navigator.storage.persist()` is requested but Chrome answered `persisted=false`
  (headless, no engagement), so the files are best-effort storage: the browser may evict them under disk pressure, and private windows or blocked storage download again. A custom OPFS/IndexedDB cache was therefore not needed.
* **PTT click.** The transmission queue no longer clicks when it dequeues a call if the speaker `keysItself()` (the neural engine): it passes a `keyUp` callback and neuralTts calls it right before `graph.start()` (or before the browser fallback speaks),
  so the PTT-open click, the carrier hiss and the first piece begin at the same instant and a slow model does not leave a click followed by silence. A call stepped on before its first piece makes no click at all.
* **Discoverability.** On machines with WebGPU, while the engine is Browser and the notice was not dismissed, Settings and the setup screen show "Realistic radio voices available ... 326 MB" with **Enable and download** (switches the engine,
  starts the download) and **Not now**; `neuralNoticeDismissed` in `kacy.voice.settings` remembers either.
* **Pronunciation.** The sim's phraseology is US style ("niner", "three", "point", "zero"). The espeak-ng phonemes of every ICAO alphabet word, the digit words, "point", runway/taxiway/frequency/squawk/altimeter phrases, aircraft and airline names
  were read as IPA strings (`phonemize(text, 'en-us')`): all correct (e.g. juliet `dʒˌuːlɪˈɛt`, niner `nˈaɪnɚ`, zero `zˈiəɹoʊ`, three `θɹˈiː`, point `pˈɔɪnt`, sierra `siːˈɛɹə`, hotel `hoʊtˈɛl`, xray `ˈɛksɹˈeɪ`, "fife" `fˈaɪf` and "tree" `tɹˈiː`
  also fine if they ever appear) except three. `prepareForNeuralTts` respells them for the neural engines only: Quebec `kwᵻbˈɛk` ("kwi-BECK") -> "kuh beck" `kˈʌ bˈɛk`; ATIS `ˈæɾiz` ("AD-iz") -> "eightis" `ˈeɪɾiz`; TRACON `tɹˈækən` -> "traycon" `tɹˈeɪkən`.
  This was checked on phoneme strings, not by listening.

### Per-aircraft variation (`tts/radioVariation.ts`, deterministic from the callsign)

All of it is the audio layer's own seeded randomness (`hashString` of the callsign into `mulberry32`); nothing touches the simulation. The ranges are design choices, not measurements of real radios.

| Property | Airline crew (callsign not `N<digit>`) | GA pilot (`N<digit>...`) | AI controller (`speakerKind: 'controller'`, callsign = position) |
|---|---|---|---|
| Voice | one of 9 Kokoro voices (`PILOT_VOICES`) by hash | same pool | `am_michael` or `bm_george` by position hash (not in the pilot pool) |
| Speed (model `speed`) | 1.04 to 1.18 | 0.92 to 1.08 | 1.06, fixed |
| Pitch shift | within +-85 cents (about 5 %), applied as playback rate with the model speed corrected so the pace is unchanged | same | none |
| Band inside the shared 300-3000 Hz chain | high-pass 300 to 410 Hz, low-pass 2600 to 3000 Hz | high-pass 300 to 520 Hz, low-pass 2200 to 3000 Hz | 300 to 3000 Hz |
| Carrier noise (linear gain of white noise) | 0.003 to 0.007 | 0.003 to 0.011 | 0.0025 |
| Compression | threshold -26 to -20 dB, ratio 3 to 6 | same | -22 dB, 4:1 |
| Over-modulation | per call, chance 4 to 13 %, drive 1.1 to 1.35 then x1.45 | chance 4 to 22 %, drive 1.1 to 1.6 then x1.45 | never |
| Squelch tail | 60 to 110 ms | 60 to 160 ms | 70 ms |

**Distance** (`signalQuality`, `radioConditions`): the queue items carry `distanceNm` (aircraft position from the engine state, metres from the airport reference point). Quality is 1 within 10 nm and falls smoothly (smoothstep) to 0.08 at
40 nm and beyond: the high-pass rises towards 420 Hz, the low-pass drops towards 2300 Hz (about 415 and 2320 Hz at 40 nm), noise rises towards 0.026, level drops to about 65 %, and a fading flutter (gain dips of up to 30 %, 22 steps per second) appears. These floors keep the
words understandable; controllers are not degraded. An unknown distance counts as clear.

### Engine comparison and measurements (Apple-silicon Mac, installed Google Chrome with WebGPU; headless Chromium for the WebAssembly runs; machine shared with other work)

Measured through the real app with `kokoro-js` 1.2.1 (transformers.js 3.8.1 inside it). Whole-sentence times are for 73 to 109 characters (5.8 to 8.6 s of speech). "Intelligible" = a Whisper `base.en` transcription of the output
read "Runway 13, cleared for takeoff. Cessna 723 Echo Juliet." (spelled "SESNA" by the recogniser, as for the unprocessed model output).

| Engine | Download | Load (local network) | Whole sentence | Intelligible |
|---|---|---|---|---|
| Browser `speechSynthesis` | none | instant | n/a (system voices) | yes, but not radio-filterable |
| Kokoro, WebGPU `fp32` | 326 MB | 9 to 19 s (+ shader warm-up) | 1.4 to 2.4 s warm (5.7 s the very first call) | **yes** |
| Kokoro, WebGPU `fp16` | 163 MB | 6 s | 1.5 to 2.4 s | **no** (garbage: "1,3,3,3,3...") |
| Kokoro, WebGPU `q4f16` | 155 MB | 7 s | 1.7 to 3.2 s | **no** ("One day they'll sleep.") |
| Kokoro, WebGPU `q8` | 92 MB | 5 s | 16 to 31 s | not checked |
| Kokoro, WebAssembly `q8` | 92 MB | 3.4 to 5.6 s | 9 to 20 s (about 1.6 to 2.3 times slower than real time, single-threaded: GitHub Pages cannot send the cross-origin-isolation headers WASM threads need) | yes |
| **Piper libritts_r medium, WebAssembly** | 79 MB | 1.6 s session + download | 0.36 to 1.5 s for 1 to 4.6 s of speech, about 0.2 to 0.3 times real time | **yes** ("Cessna 723 Echo Juliet" heard correctly) |

Short pieces on WebGPU `fp32`: "Cleared for takeoff." (2.0 s of speech) 0.7 s, "Runway one three, cleared for takeoff," (3.1 s) 0.9 s: roughly 0.4 to 0.5 s fixed plus 0.25 s per second of speech, which is why calls are streamed in pieces.

**Time from enqueue to first audio** (`getStats().lastFirstAudioMs`, idle queue, WebGPU `fp32`, simulation running at 1x, readbacks 14 s apart, real app path): 529, 547, 476, 759 and 881 ms in the last run; an earlier run on a busier GPU gave 657, 1801 and 679 ms.
So the 1.5 s target held in 8 of 9 idle-queue measurements; the miss coincided with the GPU also drawing the canvases. When another transmission is still playing, the figure includes that wait, because the clock starts at enqueue. Kokoro stays the WebGPU engine; Piper replaced it on the non-WebGPU device.

**Radio-chain intelligibility check:** the unprocessed Kokoro sample was rendered through `buildTransmissionGraph` and the real `createRadioEffects` chain with an `OfflineAudioContext` for eight cases (dry, near GA, near GA over-modulated,
airline at 12 nm, GA at 30 nm, GA at 45 nm clean / over-modulated / rough profile) and transcribed with Whisper `base.en`: all eight gave the same words as the unprocessed sample ("Cessna" spelled "SESNA" in seven, "Cessna" in one). That says the processing is subtle
enough for a recogniser; nobody has listened to it on a headset yet, so levels and character are unverified by ear.

**Piper on the non-WebGPU device** (WebGPU not used by the engine; installed Chrome and headless Chromium, real app path, idle queue): first audio 173 to 603 ms over 10 readbacks (506, 603, 466, 173, 234 ms in Chrome; 364, 560, 514, 430, 584 ms in Chromium); the remaining pieces of a call were done within 0.5 to 1.8 s of the request, i.e. before the first piece finished playing. Standalone, single-threaded `onnxruntime-web`: 1.06 s of speech in 0.27 to 0.36 s, 3.9 s of speech in 0.86 to 1.19 s, 4.6 s in 0.8 to 1.5 s.

Automated test: `e2e/neural-tts.spec.ts` (project `chromium`): selects the engine, downloads the real Piper model on WebAssembly (latency budget 10 s there), starts a session, sends a takeoff clearance and asserts the readback was synthesised (peak > 0.05, RMS > 0.005, over 0.5 s) and scheduled
on the AudioContext, the speaking lamp went on and off, and no fallback occurred. `getStats()` and `window.__kacyNeuralTts.events` are the observation points.

## Automated microphone test

`npx playwright test --project=chromium-fake-mic` proves the whole chain without a person or a cloud key: Chrome's fake audio
device plays a WAV (macOS `say`, regenerate with `scripts/make-voice-fixtures.sh`) into `getUserMedia`; the spec holds SPACE, Whisper
transcribes, the real parser and engine act, and the aircraft departs. Details that cost time to find:

* The Chromium switches are `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`. The `...-media-capture` spellings do
  nothing (full Chrome then uses the real microphone, headless shell fails with `NotSupportedError`).
* `--use-file-for-fake-audio-capture=<wav>%noloop` is a launch argument, so there is one browser per clip:
  `e2e/fixtures/voiceBrowser.ts` uses `chromium.launchPersistentContext` on `.cache/playwright-profile/` (so the model stays cached
  between runs). The WAV must be 16-bit PCM; fixtures are rewritten with a plain 44-byte header.
* The clip restarts each time the page opens a new mic stream (each PTT press); hold the key for the clip length plus a second.
* Run against a stable server: concurrent edits to `src/` make Vite hot-reload and reset the running session.

### Web Speech in real Chrome (`chrome-webspeech`)

`npx playwright test --project=chrome-webspeech` drives the installed Google Chrome (`channel: 'chrome'`, new headless; the spec
retries once headed if recognition never starts, and `WEBSPEECH_HEADED=1` forces headed). **It sends the synthetic fixture audio to
Google's speech service, so it needs internet.** If Google is unreachable the test is skipped with the reason, or fails with
`WEBSPEECH_REQUIRED=1`. Findings (Chrome 155, observed, repeatable):

* **Chrome's recognizer ignores the fake-microphone flags** and listens to the machine's real microphone (every run ended `no-speech`).
  The provider's opt-in `audioSource: 'track'` (localStorage `kacy.webspeech.audioSource=track`) opens the microphone with
  `getUserMedia` and passes the track to `SpeechRecognition.start(track)`; that is how the WAV reaches Google. It is off by default.
* **`continuous=false` loses calls.** Chrome/Google ended or stalled at the first pause ("... echo juliet, runway ...": only
  "723 Echo" came back, no final). The provider now uses `continuous=true`.
* **Chrome's result list is not append-only.** In continuous mode it can replace the whole list by the last final chunk
  (`"cleared for takeoff"`) and drop the interim text before it, and several non-final segments are alive at once. The provider rebuilds the
  transcript from `event.results` on every event and `appendTranscript()` merges a collapsed final with the text it had (dropping words
  the final merely repeats). Before this fix the pilot would hear only "cleared for takeoff" or "Runway 13 cleared for takeoff" with no callsign.
* **Google needs 1-3 s to open its stream and does not transcribe audio spoken before that.** With the callsign spoken in the first two
  seconds it came back as "Runway 13 cleared for takeoff". Nothing in the page can buffer audio for Chrome's recognizer, so tell users to
  pause a moment after keying; the Chrome-test clips (`*-lead.wav`) start with 3 s of silence, and the spec allows 3 presses.
* The 6 s `start()` deadline was not the problem: `onstart` fires when capture begins (about 10 ms), the service connects afterwards.

### Deepgram path against a protocol mock (`chromium-deepgram-mock`)

`npx playwright test --project=chromium-deepgram-mock` runs `e2e/deepgram.spec.ts` against `e2e/mocks/deepgramMock.ts`, a Node
HTTP + hand-written RFC 6455 server (`e2e/mocks/wsFrames.ts`, unit-tested in `server/voice/wsFrames.test.ts`; the `ws` package is not
installed). The spec starts the real `server/index.ts` with `DEEPGRAM_API_KEY=test-key DEEPGRAM_API_BASE=<mock>`, so the real token
handler calls the mock's `/v1/auth/grant`. The browser opens `/v1/listen` with the `token, <jwt>` subprotocol, `model=nova-3`,
`encoding=linear16`, `sample_rate=16000`, `interim_results`, `endpointing=300` and the aviation `keyterm`s; the mock verifies the jwt it
minted, counts the PCM bytes, answers with Deepgram-format `Results` (interim about each second, final with `speech_final` on
`CloseStream`) and the aircraft obeys. A second and third test make the grant (401) and the upgrade (401) fail and check the error
message and that typed input still works.

> **This proves the client protocol and audio path only.** The mock does no speech recognition: it picks the transcript from a fixed
> table by counting how many 100 ms blocks of the audio are loud (4.5 s of speech = takeoff, 3.6 s = land, 3.2 s = hold position).
> Deepgram's accuracy on callsigns, numbers and phonetics still needs a real key.

Override points added for this: server env `DEEPGRAM_API_BASE` (absolute http(s) URL, default `https://api.deepgram.com`); browser
`VITE_DEEPGRAM_WS_BASE` (any ws(s) URL, default `wss://api.deepgram.com`) and a runtime localStorage `kacy.deepgram.wsBase` that is
only honoured for `ws://localhost` / `ws://127.0.0.1`, so a stray value can never send microphone audio to a remote host. The Deepgram
provider also uses the idle `WarmAudio` graph now, so the first word is not clipped there either.

### Real microphone and speakers (`chrome-real-mic`, opt-in)

`REAL_MIC=1 npx playwright test --project=chrome-real-mic` launches Google Chrome with the real microphone (`--use-fake-ui-for-media-stream`
only, no fake device), plays the lead-in clips through the laptop speakers while Space is held, and expects Local Whisper (then Web Speech,
default mode first, then `audioSource: 'track'`) to hear them and the aircraft to obey. It makes sound. Notes from building it:

* `afplay` plays to the system default output, which may be Bluetooth headphones, so the spec uses `scripts/play-on-device.swift`
  (AVAudioPlayer pinned to the built-in speakers) and `scripts/output-volume.swift` (CoreAudio volume of that one device, restored afterwards).
  Chrome's own `<audio>`/WebAudio output stalled (currentTime frozen) in this environment, so Chrome is not used to play.
* The default input may be the Bluetooth headset (opening it puts the headphones in call mode), so the spec pins the built-in microphone with
  localStorage `kacy.voice.inputDeviceId` (`stt/inputDevice.ts`, honoured by Whisper, Web Speech track mode and Deepgram).
* The Whisper provider records `getLastCapture()` (`{ambientRms, ambientDbfs, rms, peak}`; ambient = first 500 ms) and exposes the shared
  instance as `window.__kacyLocalWhisper` for the spec to print the room noise level.
* **Pre-flight:** the spec fails with a diagnosis, not a timeout, when the chosen microphone returns digital silence or the speakers cannot
  play. With the laptop lid closed (`ioreg` `AppleClamshellState = Yes`) macOS disables the built-in microphone and speakers. A denied
  microphone fails with the System Settings > Privacy & Security > Microphone step.

## Privacy

* No audio is ever recorded, saved or uploaded by this app. Mic audio is streamed live to the selected provider only while PTT is active.
* Transcript text stays in memory for the session. It is written to `localStorage` only if "Store transcripts" is on (default off); turning it off erases stored copies.
* Local Whisper never sends audio anywhere; only the model files are downloaded.
* The Deepgram key never reaches the browser; the server only issues short-lived tokens (rate limited to 30/minute).
* The UI should show `STT_PROVIDER_NOTES` and `VOICE_PRIVACY_NOTES` in settings; the Web Speech copy states that Chrome sends audio to Google.
* No analytics or third-party trackers.

## Limitations

* **Browser voices cannot be radio-filtered.** `speechSynthesis` output is not routable through WebAudio, so with the default **Browser voices** engine the 300-3000 Hz band-pass, distortion and compression apply only to the PTT open/close clicks and static. The **Local neural** engine routes the voices through `RadioEffects.getInputNode()`.
* **Local neural voice:** Kokoro on WebGPU needs a 326 MB download (Piper on the CPU 79 MB); both are best-effort cached by the browser (see above), private windows download again. Piper has one voice family (libritts_r) and fewer clearly distinct speakers than Kokoro. Voice quality, levels and pronunciation were checked by transcription, phoneme strings, levels and timings only, never by ear on a headset. fp16 and 4-bit WebGPU variants are unusable (garbage output), so the WebGPU download cannot shrink below 326 MB.
* Browser voices differ by OS/browser; with few voices pilots are told apart by rate/pitch only. Voice lists load asynchronously in Chrome.
* Web Speech: Chrome ends recognition on pauses, so the provider restarts it while the key is held; accuracy on callsigns and numbers is lower than Deepgram. Firefox has no Web Speech recognition; Safari support is partial.
* Browsers require a user gesture before audio plays (`unlockAudio()`, see above) and HTTPS (or localhost) for the microphone.
* Local Whisper is less accurate than Deepgram on callsigns (tiny.en worst, small.en best). The model and ONNX runtime need the network once.
  **Build size:** by default `vite build` emits onnxruntime-web's 27 MB `ort-wasm-simd-threaded.asyncify.wasm` into `dist/assets` even though
  it is never loaded (transformers.js points the runtime at jsdelivr before use). There is no documented switch for this; `optimizeDeps.exclude`
  and `assetsInclude` do not affect it. A verified fix (dist 29 MB -> 3.8 MB, e2e still green against that build) is a small Vite plugin that
  turns the bundled fallback URL into `undefined`; it must be registered for both the app and the worker build. It lives outside `src/voice`, so
  it is not applied; add this to `vite.config.ts` if the size matters:

  ```ts
  const noBundledOrtWasm = () => ({
    name: 'no-bundled-ort-wasm', enforce: 'pre' as const, apply: 'build' as const,
    transform(code: string, id: string) {
      if (!id.includes('/onnxruntime-web/')) return null;
      const re = /new URL\(\s*["']ort-wasm-simd-threaded[\w.]*\.wasm["']\s*,\s*import\.meta\.url\s*\)\.href/g;
      return re.test(code) ? { code: code.replace(re, 'undefined'), map: null } : null;
    },
  });
  // defineConfig({ plugins: [..., noBundledOrtWasm()], worker: { plugins: () => [noBundledOrtWasm()] } })
  ```
* The Deepgram temp-token subprotocol and the nova-3/nova-2 fallback were verified against documentation and fake sockets, not a live account.
* Real aviation frequencies are never used: all radio is simulated inside the app.

## Landline channel (coordination)

`QueuedTransmission.channel: 'radio' | 'landline'` (default radio). The session enqueues an AI controller's call to another position as `channel: 'landline'` (on the player's first frequency so it is always audible); the queue plays
`radio.playLandline()` (two short 440 + 480 Hz rings through the radio chain, no files) instead of the PTT-open click and plays no close click. The voice controller has a second hold-to-talk binding (`landline: { key }`,
`VoiceSettings.landlineKey`, default `KeyL`, `VoiceController.landlinePtt`); a transmission made with it has `TransmissionMeta.channel = 'landline'`, which the session routes to the landline parser. Tests: `landline.test.ts`.
