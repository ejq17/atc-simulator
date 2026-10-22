/** Vitest setup: loads every airport's data so the synchronous `getAirport` / `loadXxx()` calls in tests work unchanged. */
import { preloadAllAirports } from '../airport';

await preloadAllAirports();
