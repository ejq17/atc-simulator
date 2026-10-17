import type { ParsedCommand } from '../sim/types';
import type { ParseContext } from './context';

export interface Validation { issues: string[]; unknownIds: number; conflicts: number }

const stripRwy = (s: string) => s.toUpperCase().replace(/^RWY/, '');

/**
 * Cross-check identifiers against the airport context. The engine owns real
 * validation; this only surfaces unknown ids as issues so the UI can say why.
 * May fill `frequencyId` when a spoken frequency matches a known one.
 */
export function validateFields(f: Partial<ParsedCommand>, ctx: ParseContext): Validation {
  const v: Validation = { issues: [], unknownIds: 0, conflicts: 0 };
  const unknown = (msg: string) => { v.issues.push(msg); v.unknownIds++; };

  if (ctx.taxiways) {
    const known = new Set(ctx.taxiways.map((x) => x.toUpperCase()));
    const spoken = [...(f.route ?? []), ...(f.holdShort ?? []).filter((h) => !h.startsWith('RWY'))];
    for (const id of new Set(spoken)) if (!known.has(id)) unknown(`unknown taxiway ${id}`);
  }
  if (ctx.runwayEnds) {
    const known = new Set(ctx.runwayEnds.map(stripRwy));
    const spoken = new Set<string>();
    if (f.runwayEnd) spoken.add(f.runwayEnd);
    for (const h of f.holdShort ?? []) if (h.startsWith('RWY')) spoken.add(stripRwy(h));
    if (f.destination?.startsWith('RWY')) spoken.add(stripRwy(f.destination));
    for (const end of spoken) if (!known.has(end)) unknown(`unknown runway ${end}`);
  }
  if (ctx.frequencies) {
    if (f.frequencyMhz !== undefined) {
      const hit = ctx.frequencies.find((q) => Math.abs(q.mhz - (f.frequencyMhz as number)) < 0.005);
      if (!hit) unknown(`frequency ${f.frequencyMhz} is not a known frequency`);
      else if (!f.frequencyId) f.frequencyId = hit.id;
      else if (hit.id !== f.frequencyId) {
        v.issues.push(`frequency ${f.frequencyMhz} is ${hit.id}, not ${f.frequencyId}`);
        v.conflicts++;
      }
    } else if (f.frequencyId && !ctx.frequencies.some((q) => q.id === f.frequencyId)) {
      unknown(`no known ${f.frequencyId} frequency`);
    }
  }
  return v;
}
