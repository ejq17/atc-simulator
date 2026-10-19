/**
 * Head-on traffic on a shared lane.
 *
 * Two taxiing aircraft whose remaining routes cover the same taxiway edges in OPPOSITE directions will meet nose to nose. The engine finds this
 * early and acts before they are within a margin:
 *
 *  - Neither has entered the shared stretch: the one that would reach it second (the one not already moving, then the one farther from its end of
 *    the stretch, then the higher id) stops short of its end of the stretch and waits until the other has left it ("the other is held at the previous
 *    intersection until the lane is clear"). The stop distance leaves room for the other aircraft to clear the junction.
 *  - One is already on the stretch: the other waits short of it, whatever the speeds.
 *  - Both are on the stretch ("meet"): both brake so that they stand `headOnMarginM` apart, the pilot of the one that must give way (`mustGiveWay`) calls
 *    "nose to nose with <callsign> on <taxiway>, request instructions" (plain wording, not FAA phraseology) and AI Ground resolves it (ai/headOn.ts).
 *
 * Look-ahead, margin and the give-way order are DESIGN VALUES: JO 7110.65 3-7-2 makes the controller responsible for taxi instructions that keep
 * aircraft apart, but gives no distances, and the airport data has no pavement widths (a lane is taken to hold one aircraft).
 */
import type { Aircraft, SimulationState, TaxiEdge, TaxiwayGraph, Vec2 } from './types';
import type { SimContext } from './context';
import { perfOf } from './context';
import { dist } from './geo';

/** Only conflicts whose shared stretch starts within this distance (m) ahead of both aircraft are acted on. DESIGN VALUE (about 15 s of taxi at 13 m/s each). */
export const HEAD_ON_LOOKAHEAD_M = 200;
/**
 * After a head-on is resolved the aircraft that was not moved aside waits (up to this many seconds) until the other is two margins away, so it does not
 * drive up to a counterpart that is only just pulling off the lane. DESIGN VALUE.
 */
export const HEAD_ON_LINGER_SEC = 40;
/** Extra clearance (m) beyond the two half lengths when an aircraft waits short of the stretch. DESIGN VALUE. */
export const HEAD_ON_WAIT_EXTRA_M = 20;

/** Distance (m) between the noses of two aircraft that meet on a lane and stop: the follow-distance margin of `groundMovement.findLeader`. */
export function headOnMarginM(a: Aircraft, b: Aircraft): number {
  return 1.5 * Math.max(perfOf(a).lengthM * (a.formation?.size ?? 1), perfOf(b).lengthM * (b.formation?.size ?? 1)) + 20;
}

export interface HeadOn {
  other: Aircraft;
  /** 'meet': both on the stretch (brake to the margin); 'wait': this aircraft holds short of the stretch. */
  role: 'meet' | 'wait';
  /** Distance (m) between the two aircraft along the lane. */
  gapM: number;
  marginM: number;
  /** wait: the distance (m) ahead at which this aircraft stops. */
  stopDistM: number;
  /** Taxiway of the first shared edge. */
  taxiway: string;
  /** The shared nodes, in this aircraft's direction. */
  laneNodeIds: string[];
}

export interface Path { ids: string[]; cum: number[] }

export function pathOf(graph: TaxiwayGraph, ac: Aircraft): Path | undefined {
  const r = ac.route;
  if (!r || r.progressIndex >= r.nodeIds.length) return undefined;
  const i0 = Math.max(0, r.progressIndex - 1);
  let ids = r.nodeIds.slice(i0);
  // A route that starts at the node ahead of an aircraft standing on an edge (a new instruction while stopped mid-lane): the edge it stands on, from the node behind.
  let behindFirst: string | undefined;
  if (r.progressIndex === 0 && ids.length) {
    const n0 = graph.nodes[ids[0]];
    if (n0 && dist(ac.pos, n0.pos) > 1) {
      for (const nb of neighbours(graph, n0.id)) {
        const b = graph.nodes[nb];
        if (b && b.kind !== 'runway' && distToSegment(ac.pos, b.pos, n0.pos) < 4 && dist(ac.pos, b.pos) > 1) { behindFirst = nb; break; }
      }
    }
  }
  if (behindFirst) ids = [behindFirst, ...ids];
  const behind = r.progressIndex >= 1 || !!behindFirst;
  const cum: number[] = [];
  let run = 0;
  for (let k = 0; k < ids.length; k++) {
    const n = graph.nodes[ids[k]];
    if (!n) return undefined;
    if (k === 0) {
      cum.push(behind ? -dist(ac.pos, n.pos) : dist(ac.pos, n.pos));
      run = cum[0];
      continue;
    }
    if (k === 1 && behind) run = dist(ac.pos, n.pos);
    else run += dist(graph.nodes[ids[k - 1]].pos, n.pos);
    cum.push(run);
  }
  return { ids, cum };
}

const adjCache = new WeakMap<TaxiwayGraph, Map<string, string[]>>();
function neighbours(graph: TaxiwayGraph, id: string): string[] {
  let m = adjCache.get(graph);
  if (!m) {
    m = new Map();
    for (const e of graph.edges) {
      (m.get(e.from) ?? m.set(e.from, []).get(e.from)!).push(e.to);
      (m.get(e.to) ?? m.set(e.to, []).get(e.to)!).push(e.from);
    }
    adjCache.set(graph, m);
  }
  return m.get(id) ?? [];
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

const edgeCache = new WeakMap<TaxiwayGraph, Map<string, TaxiEdge>>();
function edgeBetween(graph: TaxiwayGraph, a: string, b: string): TaxiEdge | undefined {
  let m = edgeCache.get(graph);
  if (!m) {
    m = new Map();
    for (const e of graph.edges) { m.set(`${e.from}>${e.to}`, e); if (!m.has(`${e.to}>${e.from}`)) m.set(`${e.to}>${e.from}`, e); }
    edgeCache.set(graph, m);
  }
  return m.get(`${a}>${b}`);
}

/** The taxiway of the shared edge nearest to `p` (the edge the aircraft stands on or is about to enter). */
function nearestLaneTaxiway(graph: TaxiwayGraph, lane: string[], p: Vec2): string {
  let best = '';
  let bestD = Infinity;
  for (let i = 0; i + 1 < lane.length; i++) {
    const a = graph.nodes[lane[i]].pos;
    const b = graph.nodes[lane[i + 1]].pos;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < bestD) { bestD = d; best = edgeBetween(graph, lane[i], lane[i + 1])?.taxiway ?? ''; }
  }
  return best;
}

function movingOnLane(o: Aircraft): boolean {
  return o.onGround && !!o.route && o.phase !== 'PARKED' && o.phase !== 'ARRIVED' && o.phase !== 'PUSHBACK' && o.phase !== 'TAKEOFF_ROLL' && o.phase !== 'ROLLOUT';
}

/**
 * `p` lies on the path within the lane width and at most `STANDS_AHEAD_M` ahead of the aircraft the path belongs to, stand lead-in included: the aircraft that
 * owns the path is held up behind whatever stands there (the taxi spacing of `groundMovement.findLeader`).
 */
const STANDS_AHEAD_M = 100;
function standsAheadOnPath(graph: TaxiwayGraph, path: Path, p: Vec2): boolean {
  for (let i = 0; i + 1 < path.ids.length; i++) {
    const a = graph.nodes[path.ids[i]];
    const b = graph.nodes[path.ids[i + 1]];
    if (!a || !b) continue;
    const dx = b.pos.x - a.pos.x;
    const dy = b.pos.y - a.pos.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.pos.x) * dx + (p.y - a.pos.y) * dy) / len2)) : 0;
    if (Math.hypot(p.x - (a.pos.x + dx * t), p.y - (a.pos.y + dy * t)) > 12) continue;
    const ahead = path.cum[i] + t * Math.sqrt(len2);
    if (ahead > 0 && ahead <= STANDS_AHEAD_M) return true;
  }
  return false;
}

/** The first shared stretch of `ac`'s route against `o`'s that the two traverse in opposite directions, with where each aircraft stands relative to it. */
export function findHeadOn(ctx: SimContext, ac: Aircraft): HeadOn | undefined {
  return findHeadOnIn(ctx.state, ac);
}

/** `findHeadOn` on a bare state (AI Ground evaluates the same conflict the engine acts on). */
export function findHeadOnIn(state: SimulationState, ac: Aircraft): HeadOn | undefined {
  if (!movingOnLane(ac)) return undefined;
  const graph = state.airport.taxiwayGraph;
  let mine: Path | undefined;
  let best: HeadOn | undefined;
  for (const o of Object.values(state.aircraft)) {
    if (o === ac || !movingOnLane(o)) continue;
    if (dist(ac.pos, o.pos) > 2 * HEAD_ON_LOOKAHEAD_M + 100) continue;
    mine ??= pathOf(graph, ac);
    if (!mine) return undefined;
    const theirs = pathOf(graph, o);
    if (!theirs) continue;
    const tEdge = new Map<string, number>();
    for (let j = 0; j + 1 < theirs.ids.length; j++) tEdge.set(`${theirs.ids[j]}>${theirs.ids[j + 1]}`, j);
    // runs of my edges that appear reversed and consecutive in theirs
    let k = 0;
    while (k + 1 < mine.ids.length) {
      const j0 = tEdge.get(`${mine.ids[k + 1]}>${mine.ids[k]}`);
      const usable = (kk: number) => {
        const a = graph.nodes[mine!.ids[kk]];
        const b = graph.nodes[mine!.ids[kk + 1]];
        return !!a && !!b && a.kind !== 'runway' && b.kind !== 'runway' && mine!.cum[kk + 1] > 0.5;
      };
      if (j0 === undefined || !usable(k)) { k++; continue; }
      let kEnd = k;
      let jEnd = j0;
      while (kEnd + 2 < mine.ids.length && jEnd - 1 >= 0 && tEdge.get(`${mine.ids[kEnd + 2]}>${mine.ids[kEnd + 1]}`) === jEnd - 1 && usable(kEnd + 1)) { kEnd++; jEnd--; }
      const sA = mine.cum[k];
      const sC = mine.cum[kEnd + 1];
      const tC = theirs.cum[jEnd]; // the node where they enter the stretch (my end of it)
      const tA = theirs.cum[j0 + 1];
      if (tA <= 0.5) { k = kEnd + 1; continue; } // they have left it already
      if (sA > HEAD_ON_LOOKAHEAD_M || tC > HEAD_ON_LOOKAHEAD_M) { k = kEnd + 1; continue; }
      const inMe = sA <= 0.5;
      const inThem = tC <= 0.5;
      const gap = sC + tC;
      const margin = headOnMarginM(ac, o);
      const lane = mine.ids.slice(k, kEnd + 2);
      const taxiway = nearestLaneTaxiway(graph, lane, ac.pos);
      const holdBack = (perfOf(ac).lengthM + perfOf(o).lengthM) / 2 + HEAD_ON_WAIT_EXTRA_M;
      let hit: HeadOn | undefined;
      if (inMe && inThem) hit = { other: o, role: 'meet', gapM: gap, marginM: margin, stopDistM: 0, taxiway, laneNodeIds: lane };
      else if (inMe) hit = undefined; // I am on it and go on; the other waits (its own evaluation)
      else if (o.groundSpeedKt < 1 && standsAheadOnPath(graph, theirs, ac.pos)) hit = undefined; // the other is stopped BEHIND me on its own way (its leader is me): it cannot go first, I do
      else if (inThem || yieldsToOther(ac, o, sA, tC)) hit = { other: o, role: 'wait', gapM: gap, marginM: margin, stopDistM: Math.max(0, sA - holdBack), taxiway, laneNodeIds: lane };
      if (hit && (!best || hit.gapM < best.gapM)) best = hit;
      k = kEnd + 1;
    }
  }
  return best;
}

/** Neither aircraft has entered the stretch: does `ac` wait? The moving one goes first, then the one nearer its end of the stretch, then the lower id. */
function yieldsToOther(ac: Aircraft, o: Aircraft, myDist: number, theirDist: number): boolean {
  const am = ac.groundSpeedKt >= 1;
  const om = o.groundSpeedKt >= 1;
  if (am !== om) return !am;
  if (Math.abs(myDist - theirDist) > 1) return myDist > theirDist;
  return ac.id > o.id;
}

/**
 * Which of two aircraft that stand nose to nose must give way (its pilot calls): an arrival taxiing in or a vehicle gives way to a departure taxiing
 * out, otherwise the shorter aircraft, otherwise the higher id. DESIGN VALUE (no FAA order ranks taxiing aircraft; this keeps the choice deterministic).
 */
export function mustGiveWay(a: Aircraft, b: Aircraft): Aircraft {
  if (a.isDeparture !== b.isDeparture) return a.isDeparture ? b : a;
  const la = perfOf(a).lengthM;
  const lb = perfOf(b).lengthM;
  if (la !== lb) return la < lb ? a : b;
  return a.id > b.id ? a : b;
}

export type { Vec2 };

export interface LaneRun {
  /** First and last edge (index of its first node) of the run in `mineIds`. */
  k0: number;
  kEnd: number;
  /** The same run in `theirs`: the edge index of `mineIds[k0]` reversed, and of the last. */
  j0: number;
  jEnd: number;
}

/** The runs of consecutive edges of the node list `mineIds` that `theirs` traverses in the opposite direction (non-runway edges only). */
export function reversedRuns(graph: TaxiwayGraph, mineIds: readonly string[], theirs: Path): LaneRun[] {
  const tEdge = new Map<string, number>();
  for (let j = 0; j + 1 < theirs.ids.length; j++) tEdge.set(`${theirs.ids[j]}>${theirs.ids[j + 1]}`, j);
  const ok = (kk: number) => {
    const a = graph.nodes[mineIds[kk]];
    const b = graph.nodes[mineIds[kk + 1]];
    return !!a && !!b && a.kind !== 'runway' && b.kind !== 'runway';
  };
  const out: LaneRun[] = [];
  let k = 0;
  while (k + 1 < mineIds.length) {
    const j0 = tEdge.get(`${mineIds[k + 1]}>${mineIds[k]}`);
    if (j0 === undefined || !ok(k)) { k++; continue; }
    let kEnd = k;
    let jEnd = j0;
    while (kEnd + 2 < mineIds.length && jEnd - 1 >= 0 && tEdge.get(`${mineIds[kEnd + 2]}>${mineIds[kEnd + 1]}`) === jEnd - 1 && ok(kEnd + 1)) { kEnd++; jEnd--; }
    out.push({ k0: k, kEnd, j0, jEnd });
    k = kEnd + 1;
  }
  return out;
}
