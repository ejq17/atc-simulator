import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadKmht } from '../airport';
import { parkingPoolFor } from '../game/world';
import { isTurbojet } from '../game/ifr';
import { spokenAircraftType, spokenCallsign, spokenTrafficLabel } from '../radio/spoken';
import { abbreviatedCallsign } from '../radio/callsigns';
import { getPerformance, isBusinessJetType, srsCategory, wakeCallsignWord, wakeRecatCategory } from './performance';
import { wakeMinimumNm } from './wake';
import { describeTraffic } from './towerCommands';
import { spokenTypeForReport } from './airportOps';
import type { Aircraft } from './types';

/** Types added 2026-10-21 for KBOS / KPHL / EGLL (EUROCONTROL ACD, retrieved 2026-10-21; see data/sources/aircraft-performance.json _meta_kbos_kphl_egll). */
const NEW_TYPES = [
  'A319', 'A20N', 'A21N', 'A321', 'B737', 'B38M', 'B739', 'E190', 'CRJ7', 'B762', 'B763', 'A306', 'B772', 'B77W', 'B788', 'B789', 'A332', 'A333', 'A339', 'A359', 'A35K', 'A388',
  'B744', 'B748', 'MD11', 'DH8D', 'BE20', 'BE9L', 'PC12', 'C402', 'C56X', 'CL35', 'GLF5', 'GLEX',
];
const HEAVY = ['B762', 'B763', 'A306', 'B772', 'B77W', 'B788', 'B789', 'A332', 'A333', 'A339', 'A359', 'A35K', 'B744', 'B748', 'MD11'];
const FIELDS = [
  'category', 'wakeCategory', 'taxiSpeedKt', 'taxiTurnSpeedKt', 'accelKtPerSec', 'decelKtPerSec', 'rotateSpeedKt', 'climbSpeedKt', 'cruiseSpeedKt', 'approachSpeedKt', 'touchdownSpeedKt',
  'climbRateFpm', 'descentRateFpm', 'turnRateDegPerSec', 'groundTurnRateDegPerSec', 'minSpeedKt', 'maxSpeedKt', 'serviceCeilingFt', 'takeoffDistanceFt', 'landingDistanceFt', 'lengthM',
] as const;

describe('performance entries added for KBOS / KPHL / EGLL traffic', () => {
  const json = JSON.parse(readFileSync('data/sources/aircraft-performance.json', 'utf8')) as Record<string, Record<string, unknown>>;

  it('the TypeScript registry matches data/sources/aircraft-performance.json and every entry carries its sources', () => {
    for (const t of NEW_TYPES) {
      const p = getPerformance(t);
      expect(p.type, t).toBe(t);
      const j = json[t];
      expect(j, t).toBeDefined();
      for (const f of FIELDS) expect(j[f], `${t}.${f}`).toBe(p[f]);
      const src = j._sources as Record<string, { source: string }>;
      expect(src['ACD row read'].source, t).toContain(`ICAO=${t}`);
      expect(src['ACD row read'].source, t).toContain('2026-10-21');
      expect(src['RECAT (src/sim/performance.ts RECAT)'], t).toBeDefined();
    }
  });

  it('figures are plausible and self-consistent', () => {
    for (const t of NEW_TYPES) {
      const p = getPerformance(t);
      expect(p.approachSpeedKt, t).toBeGreaterThan(p.minSpeedKt);
      expect(p.touchdownSpeedKt, t).toBeLessThan(p.approachSpeedKt);
      expect(p.climbSpeedKt, t).toBeLessThanOrEqual(p.maxSpeedKt);
      expect(p.cruiseSpeedKt, t).toBeLessThanOrEqual(250);
      // the ground roll to rotation the sim flies (VR^2 / 2a) is within the stated take-off distance
      const rollFt = (p.rotateSpeedKt * 1.68781) ** 2 / (2 * p.accelKtPerSec * 1.68781);
      expect(rollFt, t).toBeLessThanOrEqual(p.takeoffDistanceFt * 0.9);
      expect(rollFt, t).toBeGreaterThan(p.takeoffDistanceFt * 0.65);
      expect(p.lengthM, t).toBeGreaterThan(10);
    }
  });

  it('engine type: turboprops, the piston twin and the jets', () => {
    for (const t of ['DH8D', 'BE20', 'BE9L', 'PC12', 'C208']) expect(getPerformance(t).propulsion, t).toBe('turboprop');
    expect(getPerformance('C402').propulsion).toBe('piston');
    for (const t of NEW_TYPES.filter((x) => !['DH8D', 'BE20', 'BE9L', 'PC12', 'C402'].includes(x))) expect(getPerformance(t).propulsion, t).toBe('turbofan');
    // the ROZZE-style "turbojet only" test: a large turboprop and the light twins are not turbojets
    expect(isTurbojet('DH8D')).toBe(false);
    expect(isTurbojet('C402')).toBe(false);
    expect(isTurbojet('PC12')).toBe(false);
    expect(isTurbojet('C208')).toBe(false);
    expect(isTurbojet('B772')).toBe(true);
    expect(isTurbojet('C56X')).toBe(true);
    expect(isTurbojet('A320')).toBe(true);
  });

  it('wake categories: ICAO category and FAA RECAT (JO 7110.126A TBL A-1)', () => {
    for (const t of HEAVY) {
      expect(getPerformance(t).wakeCategory, t).toBe('heavy');
      expect(getPerformance(t).category, t).toBe('heavy');
    }
    expect(getPerformance('A388').wakeCategory).toBe('super');
    expect(wakeRecatCategory('A388')).toBe('A');
    for (const t of ['B744', 'B748', 'B772', 'B77W', 'B788', 'B789', 'A332', 'A333', 'A359']) expect(wakeRecatCategory(t), t).toBe('B');
    for (const t of ['A306', 'B762', 'B763', 'MD11']) expect(wakeRecatCategory(t), t).toBe('C');
    expect(wakeRecatCategory('A339')).toBe('D');
    expect(wakeRecatCategory('B752')).toBe('E');
    for (const t of ['A319', 'A321', 'B737', 'B739', 'E190', 'DH8D', 'GLF5', 'GLEX']) expect(wakeRecatCategory(t), t).toBe('F');
    expect(wakeRecatCategory('CRJ7')).toBe('G');
    expect(wakeRecatCategory('C56X')).toBe('H');
    for (const t of ['C402', 'PC12', 'BE20', 'BE9L']) expect(wakeRecatCategory(t), t).toBe('I');
    // a heavy leader needs spacing behind it that a 737 does not (JO 7110.65 5-5-4: Category B leader, Category F follower: 5 NM directly behind, 5 NM on approach)
    expect(wakeMinimumNm(wakeRecatCategory('B772'), wakeRecatCategory('B738'), 'directly_behind')).toBe(5);
    expect(wakeMinimumNm(wakeRecatCategory('A388'), wakeRecatCategory('B738'), 'directly_behind')).toBe(7);
    expect(wakeMinimumNm(wakeRecatCategory('A388'), wakeRecatCategory('B772'), 'directly_behind')).toBe(5);
  });

  it('same-runway separation category (JO 7110.65 3-9-6 NOTE)', () => {
    expect(srsCategory('PC12')).toBe(1);
    for (const t of ['C402', 'BE20', 'BE9L']) expect(srsCategory(t), t).toBe(2);
    for (const t of ['A319', 'B772', 'A388', 'DH8D', 'C56X', 'GLEX']) expect(srsCategory(t), t).toBe(3);
  });

  it('the A359 distances are the Airbus chart reads, not the ACD data error (888 m)', () => {
    expect(getPerformance('A359').takeoffDistanceFt).toBeGreaterThan(8000);
    expect(getPerformance('A359').landingDistanceFt).toBeGreaterThan(6000);
  });
});

describe('"heavy" / "super" in the callsign (JO 7110.65 2-4-14, JO 7110.126A Appendix B)', () => {
  it('names exactly RECAT A (super) and B, C, D (heavy)', () => {
    expect(wakeCallsignWord('A388')).toBe('super');
    for (const t of HEAVY) expect(wakeCallsignWord(t), t).toBe('heavy');
    for (const t of ['B752', 'B738', 'A320', 'A21N', 'B38M', 'E190', 'CRJ7', 'DH8D', 'C56X', 'GLF5', 'C402', 'C172', 'H65', 'F16']) expect(wakeCallsignWord(t), t).toBeUndefined();
    // the radio word agrees with the ICAO wake category stored in the table
    for (const t of NEW_TYPES) {
      const w = getPerformance(t).wakeCategory;
      expect(wakeCallsignWord(t) === 'heavy', t).toBe(w === 'heavy');
      expect(wakeCallsignWord(t) === 'super', t).toBe(w === 'super');
    }
  });
  it('is appended to the spoken airline callsign of a heavy and left off everything else', () => {
    expect(spokenCallsign('BAW117', 'B772')).toBe('Speedbird one seventeen heavy');
    expect(spokenCallsign('UPS451', 'MD11')).toBe('U P S four fifty one heavy');
    expect(spokenCallsign('BAW1', 'A388')).toBe('Speedbird one super');
    expect(spokenCallsign('AAL100', 'B738')).toBe('American one hundred');
    expect(spokenCallsign('UPS451', 'B752')).toBe('U P S four fifty one');
    expect(spokenCallsign('FDX1011', 'B763')).toBe('FedEx ten eleven heavy');
    expect(spokenCallsign('UPS451')).toBe('U P S four fifty one'); // no type: nothing to say
    expect(spokenCallsign('N723EJ', 'C56X')).toBe('Citation seven two three echo juliet');
    expect(spokenCallsign('CGD61327', 'B788')).toBe('Coast Guard six one three two seven');
  });
  it('the type words used in calls and reports', () => {
    expect(spokenAircraftType('B77W')).toBe('Boeing 777');
    expect(spokenAircraftType('A388')).toBe('Airbus A380');
    expect(spokenAircraftType('BE20')).toBe('King Air');
    expect(spokenTypeForReport('B788')).toBe('a heavy Boeing seven eighty seven');
    expect(spokenTypeForReport('A388')).toBe('a super Airbus three eighty');
    expect(spokenTypeForReport('B744')).toBe('a heavy Boeing seven forty seven');
  });
  it('a business jet or King Air registration is spoken with its type word and abbreviated to it', () => {
    expect(spokenCallsign('N723EJ', 'BE20')).toBe('King Air seven two three echo juliet');
    expect(abbreviatedCallsign('N723EJ', 'BE20')).toBe('King Air three echo juliet');
    expect(spokenTrafficLabel({ callsign: 'N723EJ', spokenCallsign: 'King Air seven two three echo juliet' })).toBe('King Air');
    expect(spokenTrafficLabel({ callsign: 'N723EJ', spokenCallsign: 'Cessna seven two three echo juliet' })).toBe('Cessna');
    expect(spokenTrafficLabel({ callsign: 'BAW117', spokenCallsign: 'Speedbird one seventeen heavy' })).toBe('Speedbird one seventeen heavy');
  });
  it('traffic information names a heavy as such (JO 7110.65 2-4-20: "Heavy Boeing Seven Forty-Seven", "Super A-Three-Eighty")', () => {
    const ac = (type: string): Aircraft => ({ type, callsign: 'BAW1', spokenCallsign: 'Speedbird one', phase: 'FINAL', pos: { x: 0, y: 0 }, headingDeg: 0, assignedRunwayEnd: undefined } as unknown as Aircraft);
    const ctx = { state: { airport: { runways: [] } } } as never;
    expect(describeTraffic(ctx, ac('B744'), 5).spoken).toBe('Heavy Boeing seven forty seven, five mile final');
    expect(describeTraffic(ctx, ac('A388'), 3).spoken).toBe('Super Airbus three eighty, three mile final');
    expect(describeTraffic(ctx, ac('B738'), 3).spoken).toBe('Boeing seven thirty seven, three mile final');
  });
});

describe('parking of the added types', () => {
  const kmht = loadKmht();
  it('business jets use the FBO / GA ramp, heavies the gates', () => {
    for (const t of ['C56X', 'CL35', 'GLF5', 'GLEX']) {
      expect(isBusinessJetType(t)).toBe(true);
      expect(parkingPoolFor(kmht, t).every((p) => p.category === 'fbo' || p.category === 'ga'), t).toBe(true);
      expect(parkingPoolFor(kmht, t).length, t).toBeGreaterThan(0);
    }
    for (const t of ['B772', 'A388', 'DH8D', 'A21N']) expect(parkingPoolFor(kmht, t).every((p) => p.category === 'airline'), t).toBe(true);
    for (const t of ['C402', 'PC12', 'BE20', 'BE9L']) expect(parkingPoolFor(kmht, t).every((p) => p.category === 'ga' || p.category === 'fbo'), t).toBe(true);
  });
});
