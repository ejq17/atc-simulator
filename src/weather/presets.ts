/**
 * Simulated weather presets for Atlantic City (KACY) and a seeded random picker.
 *
 * Winds are TRUE (like a METAR). KACY runway pairs are 4/22 (magnetic 038/218)
 * and 13/31 (magnetic 128/308); variation is 10 W, so true headings are
 * ~028/208 and ~118/298. A southerly sea breeze (true ~190-210) is therefore
 * close to a direct headwind for 22 and a light crosswind for 13/31.
 */
import type { Weather } from '../sim/types';
import { computeFlightCategory } from './metar';

export type WeatherPresetId =
  | 'clear'
  | 'light-crosswinds'
  | 'strong-winds'
  | 'low-visibility'
  | 'rain'
  | 'thunderstorms'
  | 'imc';

export interface WeatherPreset {
  id: WeatherPresetId;
  label: string;
  description: string;
  weather: Weather;
}

type WeatherInit = Omit<Weather, 'source' | 'flightCategory'>;

/** Build a simulated Weather and derive its flight category. */
export function makeSimulatedWeather(init: WeatherInit): Weather {
  return {
    ...init,
    source: 'simulated',
    flightCategory: computeFlightCategory(init.visibilitySm, init.clouds),
  };
}

const PRESET_DEFS: { id: WeatherPresetId; label: string; description: string; init: WeatherInit }[] = [
  {
    id: 'clear',
    label: 'Clear',
    description: 'Sea-breeze southerly 10 kt, clear skies, unlimited visibility.',
    init: {
      windDirDeg: 200, windSpeedKt: 10, visibilitySm: 10,
      clouds: [{ cover: 'CLR', baseFtAgl: 0 }],
      temperatureC: 24, dewpointC: 14, altimeterInHg: 30.05, phenomena: [],
    },
  },
  {
    id: 'light-crosswinds',
    label: 'Light crosswinds',
    description: 'North-northwest 12 kt gusting 18, 40-50 degrees off both runways (crosswind 8-12 kt).',
    init: {
      windDirDeg: 340, windSpeedKt: 12, windGustKt: 18, visibilitySm: 10,
      clouds: [{ cover: 'FEW', baseFtAgl: 4500 }, { cover: 'SCT', baseFtAgl: 8000 }],
      temperatureC: 17, dewpointC: 6, altimeterInHg: 29.96, phenomena: [],
    },
  },
  {
    id: 'strong-winds',
    label: 'Strong winds',
    description: 'Northwest 24 kt gusting 36 behind a front; VFR but rough.',
    init: {
      windDirDeg: 310, windSpeedKt: 24, windGustKt: 36, visibilitySm: 10,
      clouds: [{ cover: 'SCT', baseFtAgl: 5000 }],
      temperatureC: 8, dewpointC: -3, altimeterInHg: 29.78, phenomena: [],
    },
  },
  {
    id: 'low-visibility',
    label: 'Low visibility',
    description: 'Dense fog, vertical visibility 200 ft, calm wind (LIFR).',
    init: {
      windDirDeg: 190, windSpeedKt: 3, visibilitySm: 0.25,
      clouds: [{ cover: 'VV', baseFtAgl: 200 }],
      temperatureC: 11, dewpointC: 11, altimeterInHg: 30.12, phenomena: ['FG'],
    },
  },
  {
    id: 'rain',
    label: 'Rain',
    description: 'Steady moderate rain, easterly 12 kt, ceiling 2,000 ft (MVFR).',
    init: {
      windDirDeg: 80, windSpeedKt: 12, visibilitySm: 4,
      clouds: [{ cover: 'SCT', baseFtAgl: 1200 }, { cover: 'BKN', baseFtAgl: 2000 }, { cover: 'OVC', baseFtAgl: 3500 }],
      temperatureC: 14, dewpointC: 13, altimeterInHg: 29.84, phenomena: ['RA'],
    },
  },
  {
    id: 'thunderstorms',
    label: 'Thunderstorms',
    description: 'Thunderstorm with heavy rain, southwest 14 kt gusting 28.',
    init: {
      windDirDeg: 230, windSpeedKt: 14, windGustKt: 28, visibilitySm: 2,
      clouds: [{ cover: 'SCT', baseFtAgl: 2500 }, { cover: 'BKN', baseFtAgl: 4000 }, { cover: 'OVC', baseFtAgl: 9000 }],
      temperatureC: 27, dewpointC: 23, altimeterInHg: 29.82, phenomena: ['+TSRA'],
    },
  },
  {
    id: 'imc',
    label: 'IMC',
    description: 'Low overcast 600 ft, visibility 2 SM in mist (IFR); ILS conditions.',
    init: {
      windDirDeg: 70, windSpeedKt: 8, visibilitySm: 2,
      clouds: [{ cover: 'BKN', baseFtAgl: 600 }, { cover: 'OVC', baseFtAgl: 1100 }],
      temperatureC: 9, dewpointC: 8, altimeterInHg: 29.74, phenomena: ['BR'],
    },
  },
];

export const WEATHER_PRESET_IDS: readonly WeatherPresetId[] = PRESET_DEFS.map((d) => d.id);

export const WEATHER_PRESETS: Record<WeatherPresetId, WeatherPreset> = Object.fromEntries(
  PRESET_DEFS.map((d) => [d.id, { id: d.id, label: d.label, description: d.description, weather: makeSimulatedWeather(d.init) }]),
) as Record<WeatherPresetId, WeatherPreset>;

/** Fresh deep copy of a preset's weather (safe to mutate). */
export function getPresetWeather(id: WeatherPresetId): Weather {
  return structuredClone(WEATHER_PRESETS[id].weather);
}

/** Tiny seeded PRNG (mulberry32); deliberately duplicated, not imported from src/sim. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Relative likelihood of each preset in `randomWeather` (clear days dominate). */
const RANDOM_WEIGHTS: Record<WeatherPresetId, number> = {
  clear: 30, 'light-crosswinds': 22, 'strong-winds': 10, 'low-visibility': 6,
  rain: 14, thunderstorms: 8, imc: 10,
};

/**
 * Deterministic random weather: pick a preset by weight then jitter wind,
 * temperature and pressure. Same seed => identical result.
 */
export function randomWeather(seed: number): Weather {
  const rnd = mulberry32(seed);
  const total = Object.values(RANDOM_WEIGHTS).reduce((a, b) => a + b, 0);
  let pick = rnd() * total;
  let id: WeatherPresetId = 'clear';
  for (const key of WEATHER_PRESET_IDS) {
    pick -= RANDOM_WEIGHTS[key];
    if (pick < 0) { id = key; break; }
  }
  const base = getPresetWeather(id);
  const dir = base.windDirDeg === 'VRB' ? 0 : base.windDirDeg;
  const newDir = (((dir + Math.round((rnd() - 0.5) * 6) * 10) % 360) + 360) % 360 || 360;
  const speed = Math.max(0, base.windSpeedKt + Math.round((rnd() - 0.5) * 6));
  const gust = base.windGustKt !== undefined ? speed + Math.max(4, base.windGustKt - base.windSpeedKt + Math.round((rnd() - 0.5) * 4)) : undefined;
  const temperatureC = base.temperatureC + Math.round((rnd() - 0.5) * 6);
  const spread = Math.max(0, base.temperatureC - base.dewpointC + Math.round((rnd() - 0.5) * 2));
  const w = makeSimulatedWeather({
    windDirDeg: speed === 0 ? 0 : newDir,
    windSpeedKt: speed,
    ...(gust !== undefined ? { windGustKt: gust } : {}),
    visibilitySm: base.visibilitySm,
    clouds: base.clouds,
    temperatureC,
    dewpointC: temperatureC - spread,
    altimeterInHg: Math.round((base.altimeterInHg + (rnd() - 0.5) * 0.12) * 100) / 100,
    phenomena: base.phenomena,
  });
  return w;
}
