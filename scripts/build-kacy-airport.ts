/**
 * KACY build entry point, kept so `npx tsx scripts/build-kacy-airport.ts` still works.
 * The build itself is generic: scripts/build-airport.ts <ICAO>.
 */
process.argv[2] = 'KACY';
await import('./build-airport.ts');
