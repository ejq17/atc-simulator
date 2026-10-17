# Voice subsystem (`src/voice`)

Push-to-talk -> speech-to-text provider -> text for the command parser, plus
pilot text-to-speech with radio clicks. Browser APIs only, no npm dependencies.

```
src/voice/
  stt/        types (provider interface, VoiceStatus), webSpeechProvider, deepgramProvider,
              pcmCapture (mic -> 16 kHz PCM), aviationVocab, providerNotes (STT_PROVIDER_NOTES)
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

## Privacy

* No audio is ever recorded, saved or uploaded by this app. Mic audio is streamed live to the selected provider only while PTT is active.
* Transcript text stays in memory for the session. It is written to `localStorage` only if "Store transcripts" is on (default off); turning it off erases stored copies.
* The Deepgram key never reaches the browser; the server only issues short-lived tokens (rate limited to 30/minute).
* The UI should show `STT_PROVIDER_NOTES` and `VOICE_PRIVACY_NOTES` in settings; the Web Speech copy states that Chrome sends audio to Google.
* No analytics or third-party trackers.

## Limitations

* **Pilot voice cannot be radio-filtered.** `speechSynthesis` output is not routable through WebAudio, so the 300-3000 Hz band-pass, distortion and compression apply only to the PTT open/close clicks and static. `RadioEffects.getInputNode()` exposes the chain for a future cloud TTS.
* Browser voices differ by OS/browser; with few voices pilots are told apart by rate/pitch only. Voice lists load asynchronously in Chrome.
* Web Speech: Chrome ends recognition on pauses, so the provider restarts it while the key is held; accuracy on callsigns and numbers is lower than Deepgram. Firefox has no Web Speech recognition; Safari support is partial.
* Browsers require a user gesture before audio plays and HTTPS (or localhost) for the microphone.
* The Deepgram temp-token subprotocol and the nova-3/nova-2 fallback were verified against documentation and fake sockets, not a live account.
* Real aviation frequencies are never used: all radio is simulated inside the app.
