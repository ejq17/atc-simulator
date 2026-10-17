import type { Aircraft, SimulationState } from '../../sim/types';
import type { Pose } from './renderBuffer';

/** Everything a renderer needs for one frame. Renderers never mutate it. */
export interface Frame {
  state: SimulationState;
  nowMs: number;
  /** Interpolated pose of an aircraft at `nowMs`. */
  pose: (ac: Aircraft) => Pose;
  selectedId?: string;
}
