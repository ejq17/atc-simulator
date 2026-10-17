import { describe, expect, it } from 'vitest';
import { parseTransmission } from '../../commands/index.ts';
import { CTX } from '../../commands/testkit.ts';
import { postProcessTranscript } from './aviationPostProcess.ts';

describe('postProcessTranscript', () => {
  it('trims and collapses whitespace but leaves normal ATC text alone', () => {
    expect(postProcessTranscript('  Spirit 451,  runway 13, clear to land. ')).toBe('Spirit 451, runway 13, clear to land.');
  });

  it('repairs Whisper misspellings of Cessna (observed: "Sessna", "SESNA")', () => {
    expect(postProcessTranscript(' Sessna 723 Echo Juliet runway 1 3 cleared for takeoff')).toBe('Cessna 723 Echo Juliet runway 1 3 cleared for takeoff');
    expect(postProcessTranscript(' SESNA 723 Echo Juliet, runway 13, cleared for takeoff.')).toBe('Cessna 723 Echo Juliet, runway 13, cleared for takeoff.');
    expect(postProcessTranscript('sesna 723 echo juliet hold position')).toBe('Cessna 723 echo juliet hold position');
  });

  it('does not touch a correct Cessna or unrelated words', () => {
    expect(postProcessTranscript('Cessna 723 Echo Juliet, hold position.')).toBe('Cessna 723 Echo Juliet, hold position.');
    expect(postProcessTranscript('Sessions are not callsigns')).toBe('Sessions are not callsigns');
  });

  it('turns silence markers and silence hallucinations into an empty transcript', () => {
    for (const noise of ['[BLANK_AUDIO]', ' (silence) ', 'Thank you.', 'you', '[Music] ♪', '...', '']) {
      expect(postProcessTranscript(noise), JSON.stringify(noise)).toBe('');
    }
  });

  it('strips an inline marker next to real words but keeps "thank you" inside a transmission', () => {
    expect(postProcessTranscript('[BLANK_AUDIO] runway 13 cleared for takeoff')).toBe('runway 13 cleared for takeoff');
    expect(postProcessTranscript('Cessna 723EJ contact departure, thank you')).toBe('Cessna 723EJ contact departure, thank you');
  });

  it('produces text the real command parser resolves with no unrecognised words (observed whisper-tiny.en output)', () => {
    const t = parseTransmission(postProcessTranscript(' Sessna 723 Echo Juliet runway 1 3 cleared for takeoff'), CTX);
    expect(t.commands[0]).toMatchObject({ kind: 'TAKEOFF', callsign: 'N723EJ' });
    expect(t.commands[0].issues).toEqual([]);
    const h = parseTransmission(postProcessTranscript(' Sessna 723 Echo Juliet Hold position'), CTX);
    expect(h.commands[0]).toMatchObject({ kind: 'HOLD_POSITION', callsign: 'N723EJ' });
    expect(h.commands[0].issues).toEqual([]);
    const l = parseTransmission(postProcessTranscript(' Spirit 451, runway 13, clear to land.'), CTX);
    expect(l.commands[0]).toMatchObject({ kind: 'LAND', callsign: 'NKS451' });
  });
});
