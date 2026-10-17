# Voice subsystem (`src/voice`)

Push-to-talk -> speech-to-text provider -> text for the command parser, plus
pilot text-to-speech with radio clicks. Browser APIs only; the one npm dependency is
`@huggingface/transformers`, loaded lazily and only by the on-device Whisper provider.

```
src/voice/
  stt/        types (provider interface, VoiceStatus), webSpeechProvider, deepgramProvider,
              localWhisperProvider (on-device Whisper), aviationPostProcess, pcmCapture (mic -> 16 kHz PCM),
              aviationVocab, providerNotes (STT_PROVIDER_NOTES)
  ptt.ts      createPushToTalk (hold/toggle, runtime key change, bindButton)
  voiceController.ts   PTT + provider orchestration, status events
  tts/        browserTts (speechSynthesis), voiceAssignment, prepareForTts
  audio/      radioEffects (WebAudio clicks + static)
  transmissionQueue.ts, pilotVoice.ts   one speaker at a time, stepped-on handling
  settings.ts (localStorage `kacy.voice.settings`, VOICE_PRIVACY_NOTES), transcriptLog.ts
server/voice/deepgramToken.ts   short-lived Deepgram token endpoint
```

## Setup

Browser speech works with no setup in Chrome/Edge (HTTPS or `localhost` is
required for microphone access).

Local Whisper (no cloud, no key): pick **Local Whisper (on-device, no cloud)** in Settings (also on the setup screen) and
press **Download / prepare local model** once. It downloads about 40 MB (see below) and then works offline.

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

// Engine pilot readback -> speech (only audible on the monitored frequency):
pilots.enqueue({ text: readback.spokenText, voiceId: aircraft.voiceId, frequencyMhz: aircraft.frequencyMhz });
pilots.setMonitoredFrequency(121.9);                // when the controller retunes
voice.simulateTransmission('Spirit one two three taxi runway one three'); // typed fallback
```

Call `radio.startStatic()` only if you want the faint static bed (it starts audio, so do it after a user gesture).

## Providers and what they cost

| Provider | Audio goes to | Cost |
|---|---|---|
| Browser (Web Speech) | **Chrome: Google servers; Edge: Microsoft.** Not processed on-device. | Free |
| Deepgram | Direct browser -> `api.deepgram.com` WebSocket | Nova-3 streaming, pay-as-you-go: **$0.0048 per minute** (about $0.29/hour); new accounts get $200 credit. Source: https://deepgram.com/pricing (checked 2026-10-16; prices change). |
| Local Whisper | **Nowhere.** Audio is buffered in memory in this tab, transcribed on your computer, then dropped. Only model files are downloaded (huggingface.co, once; ONNX runtime from cdn.jsdelivr.net). | Free. About 40 MB cached in the browser (`onnx-community/whisper-tiny.en`, q8). Uses your CPU; about 1.2 s to transcribe a 5 s call on an Apple-silicon laptop (WASM). |
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

`stt/localWhisperProvider.ts` runs Whisper in the browser with transformers.js (`@huggingface/transformers` 4.3.1, WASM;
`device: 'webgpu'` is available through the provider options but is not the default because it is not deterministic in
headless browsers).

* **Flow.** PTT down: `getUserMedia` + `pcmCapture` fill a 16 kHz mono buffer (nothing is partial-streamed). PTT up:
  `onPartial('Transcribing…')`, `pipeline('automatic-speech-recognition', model)` over the buffer, the text is cleaned by
  `aviationPostProcess.ts`, then `onPartial(text)` and `onFinal(text, { durationMs })` (no confidence: Whisper reports none).
  The controller waits up to `provider.finalTimeoutMs` (180 s, covers a first-ever download) instead of the 2.5 s streaming
  default and never submits the placeholder as a transmission.
* **Model.** `onnx-community/whisper-tiny.en` (quantised q8, English only). On the three fixture clips it heard the
  call correctly except for spelling drift (`Sessna`, `clear to land`, digits), all handled by the parser or the post-processor, so
  `whisper-base.en` was not needed. Pass `createLocalWhisperProvider({ model: 'onnx-community/whisper-base.en' })` for more accuracy
  (about 3x the download and decode time). Multilingual checkpoints get `language: 'en', task: 'transcribe'`; **English-only
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
* Browsers require a user gesture before audio plays and HTTPS (or localhost) for the microphone.
* Local Whisper: tiny.en is less accurate than Deepgram on callsigns and runs on the main thread (WASM), so the page can stutter
  for about a second while decoding; a Web Worker would fix that. The model and ONNX runtime need the network once, and the production
  build copies a 27 MB ONNX `.wasm` into `dist/assets` that is not used at runtime (the runtime is fetched from jsdelivr).
* The Deepgram temp-token subprotocol and the nova-3/nova-2 fallback were verified against documentation and fake sockets, not a live account.
* Real aviation frequencies are never used: all radio is simulated inside the app.
