# Voice subsystem (`src/voice`)

Push-to-talk -> speech-to-text provider -> text for the command parser, plus
pilot text-to-speech with radio clicks. Browser APIs only; the one npm dependency is
`@huggingface/transformers`, loaded lazily and only by the on-device Whisper provider.

```
src/voice/
  stt/        types (provider interface, VoiceStatus), webSpeechProvider, deepgramProvider,
              localWhisperProvider (on-device Whisper), whisperWorker + whisperProtocol (decoding thread), aviationPostProcess, pcmCapture (mic -> 16 kHz PCM),
              aviationVocab, providerNotes (STT_PROVIDER_NOTES)
  ptt.ts      createPushToTalk (hold/toggle, runtime key change, bindButton)
  voiceController.ts   PTT + provider orchestration, status events
  tts/        browserTts (speechSynthesis), voiceAssignment, prepareForTts
  audio/      radioEffects (WebAudio clicks + static)
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

* **Pilot voice cannot be radio-filtered.** `speechSynthesis` output is not routable through WebAudio, so the 300-3000 Hz band-pass, distortion and compression apply only to the PTT open/close clicks and static. `RadioEffects.getInputNode()` exposes the chain for a future cloud TTS.
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
