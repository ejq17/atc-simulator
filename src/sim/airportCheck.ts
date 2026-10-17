/**
 * Data-contract checker: tells an airport loader whether an `Airport` provides everything the engine
 * relies on (departure holds with runway entries, exits for landing aircraft, parking, frequencies).
 */
import type { Airport } from './types';
import { neighborIds } from './pathfinding';
import { normalizeRunwayEndId } from './runways';

export interface AirportCheck {
  errors: string[];
  warnings: string[];
}

export function checkAirportForSim(airport: Airport): AirportCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const g = airport.taxiwayGraph;
  const nodes = Object.values(g.nodes);

  if (!airport.runways.length) errors.push('No runways');
  for (const rw of airport.runways) {
    if (rw.polygon.length < 3) errors.push(`Runway ${rw.id} has no polygon (needed for occupancy)`);
    for (const end of rw.ends) {
      const holds = nodes.filter(
        (n) => n.kind === 'holding_position' && n.runwayId === rw.id && (!n.protectsRunwayEnd || normalizeRunwayEndId(n.protectsRunwayEnd) === normalizeRunwayEndId(end.id)),
      );
      if (!holds.length) errors.push(`Runway end ${end.id}: no holding_position node (runwayId=${rw.id}) to depart from`);
      else if (!holds.some((h) => neighborIds(g, h.id).some((i) => g.nodes[i].kind === 'runway' && g.nodes[i].runwayId === rw.id))) {
        warnings.push(`Runway end ${end.id}: no holding position is adjacent to a runway-kind node; line-up falls back to the nearest runway node within 200 m`);
      }
    }
    const exits = nodes.filter(
      (n) => n.kind === 'runway' && n.runwayId === rw.id && neighborIds(g, n.id).some((i) => g.nodes[i].kind === 'holding_position' && g.nodes[i].runwayId === rw.id),
    );
    if (exits.length < 2) warnings.push(`Runway ${rw.id}: fewer than 2 exit nodes (runway node adjacent to a holding position)`);
  }
  for (const e of g.edges) {
    if (!g.nodes[e.from] || !g.nodes[e.to]) errors.push(`Edge ${e.id} references a missing node`);
  }
  if (!airport.parking.length) errors.push('No parking positions (arrivals cannot be taxied to parking)');
  for (const p of airport.parking) if (!g.nodes[p.nodeId]) errors.push(`Parking ${p.id}: node ${p.nodeId} not in graph`);
  for (const pos of ['GND', 'TWR'] as const) {
    if (!airport.frequencies.some((f) => f.position === pos)) warnings.push(`No ${pos} frequency`);
  }
  return { errors, warnings };
}
