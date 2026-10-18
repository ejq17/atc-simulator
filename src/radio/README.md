# src/radio - pilot phraseology

* `readback.ts`: pilot readbacks (`buildReadback`: callsign LAST, JO 7110.65 2-4-3) and pilot-initiated calls (callsign FIRST, AIM 4-2-3). Seeded errors:
  runway / heading digit, taxiway and hold-short omission (ground task) and, with `ReadbackEnv.realism` (rates + a deterministic `rand(label)`), altitude, frequency,
  squawk (also inside an IFR clearance) and pattern mix-ups. `ReadbackError.kind` lists every kind; `callsign` and `no_readback` come from the command executor.
  Rates: `src/sim/pilotBehaviour.ts` (design values).
* `callsigns.ts`: callsign conventions. `novemberCallsign`, `abbreviatedCallsign` (type word + last three characters, AIM 4-2-4: "ATC specialists may initiate
  abbreviated call signs of other aircraft by using the prefix and the last three digits/letters of the aircraft identification after communications are established.
  The pilot may use the abbreviated call sign in subsequent contacts"; never for air carriers), `similarSounding` (design heuristic: N-numbers with the same last two
  characters or one edit apart; airline numbers with the same last two digits or one edit apart).
* `spoken.ts`: numbers, phonetics, `spokenCallsign` (group form for airlines, type word for GA). `frequencies.ts`: facility names and who hears what.
* The words a pilot actually says are adapted at speaking time (`src/sim/radioDiscipline.ts styleCall`): builders always write the full `spokenCallsign`.
