#!/usr/bin/env bash
# Regenerates the spoken-ATC WAV fixtures used by e2e/voice.spec.ts (macOS only: `say` + `afconvert`).
# Chrome's --use-file-for-fake-audio-capture needs 16-bit PCM WAV; we write 16 kHz mono.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=e2e/fixtures
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

make() { # name, text
  say -v Samantha -o "$TMP/$1.aiff" "$2"
  afconvert -f WAVE -d LEI16@16000 -c 1 "$TMP/$1.aiff" "$TMP/$1.raw.wav"
  # afconvert pads the header with a FLLR chunk. Rewrite as a canonical 44-byte-header PCM WAV, the safest input
  # for Chrome's fake audio capture WAV parser.
  python3 -I - "$TMP/$1.raw.wav" "$OUT/$1.wav" <<'PY'
import sys, wave
with wave.open(sys.argv[1], 'rb') as src, wave.open(sys.argv[2], 'wb') as dst:
    dst.setparams(src.getparams())
    dst.writeframes(src.readframes(src.getnframes()))
PY
  echo "wrote $OUT/$1.wav ($(stat -f%z "$OUT/$1.wav") bytes): $2"
}

make takeoff-n723ej "Cessna seven two three echo juliet, runway one three, cleared for takeoff"
make hold-position-n723ej "Cessna seven two three echo juliet, hold position"
make land-nks451 "Spirit four fifty one, runway one three, cleared to land"

# Variants with 3 s of leading silence for the Web Speech (Google) test: the service needs 1-3 s to open its streaming
# connection and does not transcribe audio spoken before that (see src/voice/stt/webSpeechProvider.ts).
lead() { # name
  python3 -I - "$OUT/$1.wav" "$OUT/$1-lead.wav" <<'PY'
import sys, wave
with wave.open(sys.argv[1], 'rb') as src, wave.open(sys.argv[2], 'wb') as dst:
    dst.setparams(src.getparams())
    dst.writeframes(b'\x00\x00' * (src.getframerate() * 3))
    dst.writeframes(src.readframes(src.getnframes()))
PY
  echo "wrote $OUT/$1-lead.wav"
}
lead takeoff-n723ej
lead hold-position-n723ej
