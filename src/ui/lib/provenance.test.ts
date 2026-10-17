import { describe, expect, it } from 'vitest';
import { loadKacy } from '../../airport';
import { summariseProvenance } from './provenance';

describe('provenance footer', () => {
  it('is derived from the airport data (cycle and dates are not hard-coded)', () => {
    const p = summariseProvenance(loadKacy());
    expect(p.footer).toBe('FAA NASR 2026-10-01, d-TPP cycle 2610 (effective 2026-10-01 to 2026-10-29); taxiway geometry © OpenStreetMap contributors (ODbL)');
    const other = summariseProvenance({
      provenance: [
        { source: 'FAA NASR 28-day subscription (cycle 2026-11-26)', retrievedOn: '2026-11-27', effectiveFrom: '2026-11-26' },
        { source: 'FAA d-TPP cycle 2613', retrievedOn: '2026-11-27', effectiveFrom: '2026-11-26', effectiveTo: '2026-12-24' },
      ],
    });
    expect(other.footer).toBe('FAA NASR 2026-11-26, d-TPP cycle 2613 (effective 2026-11-26 to 2026-12-24)');
  });
});
