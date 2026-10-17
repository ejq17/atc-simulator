import { describe, expect, it } from 'vitest';
import { randomWeather, WEATHER_PRESET_IDS, WEATHER_PRESETS, getPresetWeather } from './presets';
import { computeFlightCategory } from './metar';
import { recommendRunways } from './runwaySelection';

describe('weather presets (goal.md section 11 examples)', () => {
  it('provides exactly the seven goal.md examples', () => {
    expect([...WEATHER_PRESET_IDS].sort()).toEqual(
      ['clear', 'imc', 'light-crosswinds', 'low-visibility', 'rain', 'strong-winds', 'thunderstorms'].sort(),
    );
  });

  it.each(WEATHER_PRESET_IDS)('%s is a complete simulated Weather', (id) => {
    const w = WEATHER_PRESETS[id].weather;
    expect(w.source).toBe('simulated');
    expect(typeof w.windSpeedKt).toBe('number');
    expect(w.visibilitySm).toBeGreaterThan(0);
    expect(Array.isArray(w.clouds)).toBe(true);
    expect(Array.isArray(w.phenomena)).toBe(true);
    expect(w.altimeterInHg).toBeGreaterThan(28.5);
    expect(w.altimeterInHg).toBeLessThan(31);
    expect(w.dewpointC).toBeLessThanOrEqual(w.temperatureC);
    expect(w.flightCategory).toBe(computeFlightCategory(w.visibilitySm, w.clouds));
    if (w.windGustKt !== undefined) expect(w.windGustKt).toBeGreaterThan(w.windSpeedKt);
  });

  it('has the intended character', () => {
    expect(WEATHER_PRESETS.clear.weather.flightCategory).toBe('VFR');
    expect(WEATHER_PRESETS.clear.weather.windDirDeg).toBeGreaterThanOrEqual(170);
    expect(WEATHER_PRESETS.clear.weather.windDirDeg).toBeLessThanOrEqual(230); // sea breeze
    expect(WEATHER_PRESETS['strong-winds'].weather.windGustKt).toBeGreaterThanOrEqual(30);
    expect(WEATHER_PRESETS['low-visibility'].weather.visibilitySm).toBeLessThan(1);
    expect(WEATHER_PRESETS['low-visibility'].weather.flightCategory).toBe('LIFR');
    expect(WEATHER_PRESETS.rain.weather.phenomena).toContain('RA');
    expect(WEATHER_PRESETS.thunderstorms.weather.phenomena.some((p) => p.includes('TS'))).toBe(true);
    expect(['IFR', 'LIFR']).toContain(WEATHER_PRESETS.imc.weather.flightCategory);
  });

  it('light crosswinds really produce a moderate crosswind on both KACY runways', () => {
    const ends = [
      { id: '4', magneticHeadingDeg: 38 }, { id: '22', magneticHeadingDeg: 218 },
      { id: '13', magneticHeadingDeg: 128 }, { id: '31', magneticHeadingDeg: 308 },
    ];
    const r = recommendRunways(WEATHER_PRESETS['light-crosswinds'].weather, ends, { variationDeg: -10 });
    expect(r.ranking[0].crosswindKt).toBeGreaterThan(5);
    expect(r.ranking[0].crosswindKt).toBeLessThan(13);
  });

  it('getPresetWeather returns an independent copy', () => {
    const a = getPresetWeather('clear');
    a.windSpeedKt = 99;
    a.clouds.push({ cover: 'OVC', baseFtAgl: 100 });
    expect(WEATHER_PRESETS.clear.weather.windSpeedKt).not.toBe(99);
    expect(WEATHER_PRESETS.clear.weather.clouds).toHaveLength(1);
  });
});

describe('randomWeather', () => {
  it('is deterministic per seed', () => {
    expect(randomWeather(42)).toEqual(randomWeather(42));
    expect(randomWeather(1)).not.toEqual(randomWeather(2));
  });

  it('always yields sane, simulated, self-consistent weather', () => {
    const cats = new Set<string>();
    for (let seed = 0; seed < 500; seed++) {
      const w = randomWeather(seed);
      expect(w.source).toBe('simulated');
      expect(w.windSpeedKt).toBeGreaterThanOrEqual(0);
      if (w.windDirDeg !== 'VRB' && w.windSpeedKt > 0) {
        expect(w.windDirDeg).toBeGreaterThanOrEqual(1);
        expect(w.windDirDeg).toBeLessThanOrEqual(360);
      }
      if (w.windGustKt !== undefined) expect(w.windGustKt).toBeGreaterThan(w.windSpeedKt);
      expect(w.dewpointC).toBeLessThanOrEqual(w.temperatureC);
      expect(w.altimeterInHg).toBeGreaterThan(29);
      expect(w.altimeterInHg).toBeLessThan(30.4);
      expect(w.flightCategory).toBe(computeFlightCategory(w.visibilitySm, w.clouds));
      cats.add(w.flightCategory);
    }
    expect(cats.size).toBeGreaterThanOrEqual(3);
  });

  it('does not mutate preset definitions', () => {
    const before = JSON.stringify(WEATHER_PRESETS);
    for (let i = 0; i < 50; i++) randomWeather(i);
    expect(JSON.stringify(WEATHER_PRESETS)).toBe(before);
  });
});
