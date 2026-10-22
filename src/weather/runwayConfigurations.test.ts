import { describe, expect, it } from 'vitest';
import type { Weather } from '../sim/types';
import { createMultiRunwayAirport } from '../sim/__fixtures__/multiRunwayAirport';
import { recommendedRunways, runwayChangeForWind } from '../ui/store/runwayConfig';
import { recommendConfig } from '../game/scenarios/freeplay';
import { configurationChangeForWind, inWindSector, selectRunwayConfiguration } from './runwayConfigurations';

const ap = createMultiRunwayAirport();
const wx = (dir: number | 'VRB', kt: number): Weather => ({
  source: 'simulated', windDirDeg: dir, windSpeedKt: kt, visibilitySm: 10, clouds: [{ cover: 'SKC', baseFtAgl: 0 }],
  temperatureC: 15, dewpointC: 5, altimeterInHg: 29.92, phenomena: [], flightCategory: 'VFR',
});
const pick = (w: Weather, closed: string[] = []) => selectRunwayConfiguration(ap.runwayConfigurations, w, ap, { closedEnds: closed })?.config.id;

describe('published runway configuration selection (fixture airport, variation 0)', () => {
  it('uses the configuration most nearly aligned with the wind', () => {
    expect(pick(wx(270, 12))).toBe('W-SEG');
    expect(pick(wx(90, 12))).toBe('E-SEG');
    expect(pick(wx(360, 15))).toBe('N-ALL');
    expect(pick(wx(300, 10))).toBe('W-SEG');
  });
  it('prefers the first listed configuration on a headwind tie (W-SEG before W-DUAL) and in calm wind', () => {
    expect(pick(wx(270, 20))).toBe('W-SEG');
    expect(pick(wx(180, 3))).toBe('W-SEG');
    expect(pick(wx('VRB', 12))).toBe('W-SEG');
  });
  it('never selects a configuration using a closed runway end', () => {
    expect(pick(wx(270, 12), ['27R'])).toBe('N-ALL'); // W-SEG and W-DUAL use 27R; N-ALL (no headwind) beats E-SEG (12 kt tailwind)
    expect(pick(wx(270, 12), ['27L'])).toBe('N-ALL'); // W-SEG and W-DUAL depart 27L
    expect(pick(wx(270, 12), ['35'])).toBe('W-SEG');
  });
  it('returns the landing and departing lists through the UI and free-play helpers', () => {
    const r = recommendedRunways(wx(270, 12), ap);
    expect(r.landing).toEqual(['27R']);
    expect(r.departing).toEqual(['27L']);
    const f = recommendConfig(ap, wx(90, 12), false);
    expect(f).toEqual({ landing: ['9L'], departing: ['9R'] });
  });
  it('proposes a change only when the configuration in use lost its headwind', () => {
    const cur = { landing: ['27R'], departing: ['27L'] };
    expect(runwayChangeForWind(wx(260, 10), cur, ap)).toBeUndefined();
    expect(runwayChangeForWind(wx(90, 12), cur, ap)?.landing).toEqual(['9L']);
    expect(configurationChangeForWind(ap.runwayConfigurations, wx(270, 3), cur, ap)).toBeUndefined();
  });
  it('honours a published wind sector as a tie-break and a tailwind limit', () => {
    const [a, b] = [ap.runwayConfigurations![0], ap.runwayConfigurations![2]];
    const sectorB = { ...b, windFromDeg: 250, windToDeg: 290 };
    expect(selectRunwayConfiguration([a, sectorB], wx(270, 12), ap)?.config.id).toBe(sectorB.id);
    const limited = { ...ap.runwayConfigurations![1], maxTailwindKt: 5 };
    expect(selectRunwayConfiguration([limited, a], wx(270, 12), ap)?.config.id).toBe('W-SEG');
    expect(inWindSector(10, 350, 20)).toBe(true);
    expect(inWindSector(100, 350, 20)).toBe(false);
  });
  it('returns undefined when the airport has no configurations or all use a closed end', () => {
    expect(selectRunwayConfiguration(undefined, wx(270, 12), ap)).toBeUndefined();
    expect(pick(wx(270, 12), ['27R', '9R', '35'])).toBeUndefined();
  });
});
