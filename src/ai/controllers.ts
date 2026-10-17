import type { AiControllerOptions, AiControllers } from './index';
/** Placeholder until the AI builder lands; keeps the UI compiling. */
export function createAiControllers(opts: AiControllerOptions): AiControllers {
  return { update: () => {}, positions: () => opts.positions, status: () => ({}), dispose: () => {} };
}
