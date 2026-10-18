import { describe, expect, it } from 'vitest';
import { abbreviatedCallsign, novemberCallsign, registrationOf, similarSounding } from './callsigns';

describe('callsign conventions (JO 7110.65 2-4-20, AIM 4-2-4)', () => {
  it('November + registration', () => {
    expect(novemberCallsign('N723EJ')).toBe('November seven two three echo juliet');
  });
  it('abbreviates a civil callsign to the prefix and the last three characters', () => {
    expect(abbreviatedCallsign('N723EJ', 'C172')).toBe('Cessna three echo juliet');
    expect(abbreviatedCallsign('N723EJ')).toBe('November three echo juliet');
    expect(abbreviatedCallsign('N1234Z', 'PA28')).toBe('Piper three four zulu');
  });
  it('never abbreviates air carriers or a registration too short to shorten', () => {
    expect(abbreviatedCallsign('NKS451', 'A320')).toBeUndefined();
    expect(abbreviatedCallsign('N1A', 'C172')).toBeUndefined();
    expect(registrationOf('NKS451')).toBeUndefined();
  });
  it('flags similar sounding callsigns', () => {
    expect(similarSounding('N723EJ', 'N455EJ')).toBe(true); // same trailing letters
    expect(similarSounding('N6132F', 'N1622F')).toBe(true); // AIM 4-2-4 example pair
    expect(similarSounding('N723EJ', 'N991KB')).toBe(false);
    expect(similarSounding('NKS451', 'NKS851')).toBe(true);
    expect(similarSounding('NKS451', 'AAL451')).toBe(false);
    expect(similarSounding('N723EJ', 'N723EJ')).toBe(false);
  });
});
