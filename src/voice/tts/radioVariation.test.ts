import { describe, expect, it } from 'vitest';
import {
  CLEAR_NM, CONTROLLER_VOICES, PILOT_VOICES, PIPER_CONTROLLER_SIDS, PIPER_PILOT_SIDS, PITCH_CENTS_RANGE, RATE_RANGE, WEAK_NM,
  assignNeuralProfile, classifyCallsign, isOvermodulated, radioConditions, signalQuality,
} from './radioVariation.ts';

const CALLSIGNS = ['N723EJ', 'N4421P', 'NKS451', 'AAL1204', 'DAL88', 'N90XY', 'UAL312', 'JBU905', 'N5RT', 'FDX22', 'N182SP', 'SWA1'];

describe('callsign classification', () => {
  it('treats N-numbers as general aviation and everything else as airline traffic', () => {
    expect(classifyCallsign('N723EJ')).toBe('ga');
    expect(classifyCallsign('n4421p')).toBe('ga');
    expect(classifyCallsign('NKS451')).toBe('airline');
    expect(classifyCallsign('AAL1204')).toBe('airline');
  });
});

describe('neural voice assignment', () => {
  it('is deterministic for a callsign', () => {
    for (const c of CALLSIGNS) expect(assignNeuralProfile(c)).toEqual(assignNeuralProfile(c));
    expect(assignNeuralProfile(' n723ej ')).toEqual(assignNeuralProfile('N723EJ'));
  });

  it('keeps voice, rate and pitch inside the documented ranges', () => {
    for (const c of CALLSIGNS) {
      const p = assignNeuralProfile(c);
      const [lo, hi] = RATE_RANGE[p.kind];
      expect(PILOT_VOICES).toContain(p.voice);
      expect(PIPER_PILOT_SIDS).toContain(p.piperSid);
      expect(p.rate).toBeGreaterThanOrEqual(lo);
      expect(p.rate).toBeLessThanOrEqual(hi);
      expect(Math.abs(p.pitchCents)).toBeLessThanOrEqual(PITCH_CENTS_RANGE);
      expect(p.radio.highpassHz).toBeGreaterThanOrEqual(300);
      expect(p.radio.lowpassHz).toBeLessThanOrEqual(3000);
      expect(p.radio.lowpassHz).toBeGreaterThanOrEqual(2200);
      expect(p.radio.drive).toBeLessThanOrEqual(1.6);
      expect(p.radio.overmodChance).toBeLessThanOrEqual(0.25);
    }
  });

  it('gives airline crews a brisker pace than GA pilots on average, with non-overlapping-at-the-edges ranges', () => {
    const mean = (kind: 'airline' | 'ga') => {
      const rates = Array.from({ length: 60 }, (_, i) => assignNeuralProfile(`${kind === 'ga' ? 'N' : 'XYZ'}${100 + i}`, kind).rate);
      return rates.reduce((a, b) => a + b, 0) / rates.length;
    };
    expect(mean('airline')).toBeGreaterThan(mean('ga'));
    expect(RATE_RANGE.airline[0]).toBeGreaterThan(RATE_RANGE.ga[0]);
  });

  it('spreads aircraft over several voices', () => {
    const voices = new Set(Array.from({ length: 80 }, (_, i) => assignNeuralProfile(`N${200 + i}AB`).voice));
    expect(voices.size).toBeGreaterThanOrEqual(6);
  });

  it('gives controllers one stable, clean profile per position from the controller voices', () => {
    const tower = assignNeuralProfile('TWR', 'controller');
    expect(assignNeuralProfile('TWR', 'controller')).toEqual(tower);
    expect(CONTROLLER_VOICES).toContain(tower.voice);
    expect(PIPER_CONTROLLER_SIDS).toContain(tower.piperSid);
    expect(PIPER_PILOT_SIDS).not.toContain(tower.piperSid);
    expect(PILOT_VOICES).not.toContain(tower.voice);
    expect(tower.pitchCents).toBe(0);
    expect(tower.radio.overmodChance).toBe(0);
    expect(tower.radio.drive).toBe(1);
    expect(tower.radio.lowpassHz).toBe(3000);
  });
});

describe('signal quality by distance', () => {
  it('is clear near the field, weak beyond about 30 nm, and never increases with distance', () => {
    expect(signalQuality(undefined)).toBe(1);
    expect(signalQuality(0)).toBe(1);
    expect(signalQuality(CLEAR_NM)).toBe(1);
    expect(signalQuality(30)).toBeLessThan(0.4);
    expect(signalQuality(WEAK_NM)).toBeLessThan(0.1);
    expect(signalQuality(200)).toBe(signalQuality(WEAK_NM));
    let prev = 1;
    for (let d = 0; d <= 60; d += 1) {
      const q = signalQuality(d);
      expect(q).toBeLessThanOrEqual(prev);
      prev = q;
    }
  });

  it('degrades the radio conditions with distance but keeps speech intelligible', () => {
    const profile = assignNeuralProfile('N723EJ').radio;
    const near = radioConditions(profile, { distanceNm: 2 });
    const far = radioConditions(profile, { distanceNm: 45 });
    expect(near.quality).toBe(1);
    expect(near.flutterDepth).toBe(0);
    expect(far.noiseFloor).toBeGreaterThan(near.noiseFloor * 2);
    expect(far.lowpassHz).toBeLessThan(near.lowpassHz + 1);
    expect(far.highpassHz).toBeGreaterThanOrEqual(near.highpassHz);
    expect(far.gain).toBeLessThan(near.gain);
    expect(far.flutterDepth).toBeGreaterThan(0);
    // Floors: the band never closes below about 420 to 2300 Hz, noise stays under a fixed ceiling, level above 60 %.
    expect(far.lowpassHz).toBeLessThanOrEqual(2400);
    expect(far.lowpassHz - far.highpassHz).toBeGreaterThan(1500);
    expect(far.noiseFloor).toBeLessThanOrEqual(0.026);
    expect(far.gain).toBeGreaterThanOrEqual(0.6);
    expect(far.flutterDepth).toBeLessThanOrEqual(0.3);
  });
});

describe('over-modulation', () => {
  it('is deterministic per call and follows the chance', () => {
    expect(isOvermodulated('N723EJ', 'hello', 0)).toBe(false);
    expect(isOvermodulated('N723EJ', 'hello', 1)).toBe(true);
    const a = isOvermodulated('N723EJ', 'cleared for takeoff', 0.2);
    expect(isOvermodulated('N723EJ', 'cleared for takeoff', 0.2)).toBe(a);
    let hits = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) if (isOvermodulated('N723EJ', `call ${i}`, 0.2)) hits++;
    expect(hits / n).toBeGreaterThan(0.15);
    expect(hits / n).toBeLessThan(0.25);
  });

  it('raises the drive only when the call is over-modulated, and only mildly', () => {
    const profile = assignNeuralProfile('N723EJ').radio;
    const clean = radioConditions(profile, { overmodulated: false });
    const hot = radioConditions(profile, { overmodulated: true });
    expect(clean.drive).toBe(profile.drive);
    expect(hot.drive).toBeGreaterThan(clean.drive);
    expect(hot.drive).toBeLessThanOrEqual(2.4);
    expect(hot.overmodulated).toBe(true);
  });
});
