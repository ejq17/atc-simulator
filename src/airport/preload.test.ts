import { describe, expect, it, vi } from 'vitest';

// This file resets the module registry so the airport modules start with an empty cache (the global setup file preloads them).
describe('lazy airport loading', () => {
  it('throws a clear error naming preloadAirport before the data is loaded, then resolves and caches', async () => {
    vi.resetModules();
    const mod = await import('./index');
    expect(() => mod.getAirport('KMHT')).toThrow(/preloadAirport/);
    expect(() => mod.airportOrDefault('KACY')).toThrow(/KACY.*preloadAirport/);
    const a = await mod.preloadAirport('KMHT');
    expect(a.icao).toBe('KMHT');
    expect(mod.getAirport('KMHT')).toBe(a);
    expect(mod.getAirport('MHT')).toBe(a);
    expect(await mod.preloadAirport('kmht')).toBe(a);
    // Other airports stay unloaded.
    expect(() => mod.getAirport('KBOS')).toThrow(/preloadAirport/);
  });

  it('rejects an unknown airport and keeps listAirports unchanged', async () => {
    vi.resetModules();
    const mod = await import('./index');
    await expect(mod.preloadAirport('ZZZZ')).rejects.toThrow(/Unknown airport/);
    expect(mod.listAirports()).toEqual(['KACY', 'KMHT', 'KBOS', 'KPHL', 'KPGD', 'EGLL']);
    await mod.preloadAllAirports();
    for (const icao of mod.listAirports()) expect(mod.getAirport(icao)?.icao).toBe(icao);
  });

  it('registry display names match the airport data', async () => {
    vi.resetModules();
    const mod = await import('./index');
    await mod.preloadAllAirports();
    for (const { icao, name } of mod.listAirportOptions()) {
      expect(name).toBe(mod.getAirport(icao)!.name);
      expect(mod.isAirportLoaded(icao)).toBe(true);
    }
    expect(mod.isAirportLoaded('ZZZZ')).toBe(false);
  });
});
