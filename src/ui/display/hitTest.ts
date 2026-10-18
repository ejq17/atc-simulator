import { isVehicleType } from '../../sim/performance';
import type { Frame } from './frame';
import { nearestWithin } from './labels';
import { worldToScreen } from './viewTransform';
import type { View } from './viewTransform';

export interface AircraftScreen { id: string; x: number; y: number }

/** Screen positions of every aircraft at the interpolated pose (also the hit-test list). */
export function aircraftScreenPositions(frame: Frame, v: View, includeVehicles = true): AircraftScreen[] {
  return Object.values(frame.state.aircraft).filter((ac) => includeVehicles || !isVehicleType(ac.type)).map((ac) => {
    const p = frame.pose(ac);
    const s = worldToScreen(v, { x: p.x, y: p.y });
    return { id: ac.id, x: s.x, y: s.y };
  });
}

/** Aircraft id under a click, or undefined. The radar passes `includeVehicles = false`: airport vehicles are not radar targets. */
export function hitTestAircraft(frame: Frame, v: View, sx: number, sy: number, radiusPx = 16, includeVehicles = true): string | undefined {
  return nearestWithin(aircraftScreenPositions(frame, v, includeVehicles), sx, sy, radiusPx);
}
