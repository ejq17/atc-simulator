/**
 * Runway-runway crossing detection for the generic airport build.
 *
 * A crossing is a graph node that lies on two or more runway centrelines (planar.ts pins one shared node where two centrelines
 * intersect). An airport may have none (parallel runways only), one (KACY, KMHT) or many (KBOS).
 */

export interface RunwayCrossing {
  /** The graph node index. */
  node: number;
  /** Runways meeting at the node, in the order of `runwayOrder`. */
  runwayIds: string[];
}

/** Every node that belongs to at least two runways, ordered by the first runway in `runwayOrder`, then by node index. */
export function findRunwayCrossings(runwayNodes: Map<string, Set<number>>, runwayOrder: readonly string[]): RunwayCrossing[] {
  const byNode = new Map<number, string[]>();
  for (const rid of runwayOrder) for (const n of runwayNodes.get(rid) ?? []) byNode.set(n, [...(byNode.get(n) ?? []), rid]);
  return [...byNode.entries()]
    .filter(([, rids]) => rids.length >= 2)
    .map(([node, runwayIds]) => ({ node, runwayIds }))
    .sort((p, q) => runwayOrder.indexOf(p.runwayIds[0]) - runwayOrder.indexOf(q.runwayIds[0]) || p.node - q.node);
}

/** Node id of a generated crossing: "RWX-" + the runway ids joined by "x" with "/" written "-": 4L/22R x 9/27 -> "RWX-4L-22Rx9-27". */
export function crossingNodeId(runwayIds: readonly string[]): string {
  return `RWX-${runwayIds.map((r) => r.replace('/', '-')).join('x')}`;
}

/** Display name of a generated crossing: "Runway 4L/22R x 9/27 intersection". */
export function crossingName(runwayIds: readonly string[]): string {
  return `Runway ${runwayIds.join(' x ')} intersection`;
}
