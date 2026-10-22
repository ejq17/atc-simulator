/** Error for a synchronous airport read before its data chunk was loaded (see `preloadAirport` in ./index.ts). */
export function notPreloadedError(icao: string): Error {
  return new Error(`${icao} airport data is not loaded yet: await preloadAirport('${icao}') before calling getAirport/load${icao[0]}${icao.slice(1).toLowerCase()}`);
}
