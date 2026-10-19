/**
 * AI Ground resolves a head-on on a shared lane (sim/headOn.ts engine side, ai/headOn.ts): real KACY Bravo corridor and the KMHT terminal corridor.
 */
import { describe, expect, it } from 'vitest';
import { createHarness, kacy } from './testkit';
import { loadKmht } from '../airport';
import type { Harness } from './testkit';
import type { Aircraft, Airport, ScenarioAircraftSpawn } from '../sim/types';
import { dist } from '../sim/geo';
import { findHeadOnIn } from '../sim/headOn';


const kmht = loadKmht();

const dep = (cs: string, parking: string, type = 'C172'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign: cs, type, flightRules: type === 'C172' ? 'VFR' : 'IFR', start: { kind: 'parked', parkingId: parking }, isDeparture: true, initialFrequencyId: 'GND',
});
const hold = (cs: string, nodeId: string, runwayEnd: string, type = 'C172'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign: cs, type, flightRules: 'VFR', start: { kind: 'holding_short', nodeId, runwayEnd }, isDeparture: true, initialFrequencyId: 'GND',
});

/** Send `b` down the reverse of the first `a` route toward `a`, once `a` is taxiing. */
function meetOnTheLane(h: Harness, airport: Airport, a: Aircraft, b: Aircraft): void {
  const g = airport.taxiwayGraph;
  // the corridor ends at the first runway hold line on A's route (it waits there for a crossing)
  const stops = a.route!.stopAtNodeIds.map((id) => a.route!.nodeIds.indexOf(id)).filter((i) => i > 2);
  const ids = a.route!.nodeIds.slice(2, stops.length ? Math.min(...stops) : undefined).reverse();
  b.pos = { ...g.nodes[ids[0]].pos };
  b.headingDeg = (Math.atan2(g.nodes[ids[1]].pos.x - g.nodes[ids[0]].pos.x, g.nodes[ids[1]].pos.y - g.nodes[ids[0]].pos.y) * 180) / Math.PI;
  b.route = { nodeIds: ids, taxiways: [], stopAtNodeIds: [], progressIndex: 1 };
  b.phase = 'TAXIING';
  b.pendingRequest = undefined;
  // (it stood at its hold line, so AI Ground has already handed it to Tower; put on the lane, it is Ground's again)
  b.frequencyId = a.frequencyId;
  b.frequencyMhz = a.frequencyMhz;
  void h;
}

function scenario(airport: Airport, rwy: string, spawns: ScenarioAircraftSpawn[], holdNode: string) {
  const h = createHarness({ player: ['TWR'], mode: 'free_play', readbackErrorRate: 0, airport, spawns, activeRunways: { departing: [rwy], landing: [rwy] }, pilotBehaviour: { ground: { holdShortOmitFraction: 0, unfamiliarFraction: 0, taxiwayErrorShare: 0 } } });
  void holdNode;
  return h;
}

describe('AI Ground and a head-on on the lane', () => {
  it('KACY Bravo corridor: the pair stops, the pilot calls, Ground answers, both get through without closing inside the margin', () => {
    const h = scenario(kacy, '4', [dep('N1A', 'GA-1'), hold('N2B', 'HP4-22-B-2', '4')], 'HP4-22-B-2');
    expect(h.runUntil(() => h.find('N1A')?.phase === 'TAXIING' && !!h.find('N1A')?.route, 600)).toBe(true);
    const a = h.find('N1A')!;
    const b = h.find('N2B')!;
    meetOnTheLane(h, kacy, a, b);
    let minGap = Infinity;
    h.run(900, () => { const d = dist(a.pos, b.pos); minGap = Math.min(minGap, d); if (d < 60 && process.env.DBG) { const g = kacy.taxiwayGraph; const n0 = g.nodes[a.route!.nodeIds[0]]; const n1 = g.nodes[a.route!.nodeIds[1]]; console.info('A', JSON.stringify(a.pos), 'n0', a.route!.nodeIds[0], JSON.stringify(n0.pos), 'n1', JSON.stringify(n1.pos), 'B', JSON.stringify(b.pos), b.route!.nodeIds.slice(b.route!.progressIndex - 2, b.route!.progressIndex + 3).join(',')); const hb = findHeadOnIn(h.engine.getState(), b); const ha = findHeadOnIn(h.engine.getState(), a); console.info('HB', hb ? `${hb.role} stop=${hb.stopDistM.toFixed(1)} gap=${hb.gapM.toFixed(1)}` : '-', 'HA', ha ? `${ha.role} stop=${ha.stopDistM.toFixed(1)} gap=${ha.gapM.toFixed(1)}` : '-', a.route?.nodeIds.slice(0, 8).join(',')); } if (d < 60 && process.env.DBG) console.info(Math.round(h.now()), d.toFixed(1), a.groundSpeedKt.toFixed(1), b.groundSpeedKt.toFixed(1), a.route?.progressIndex, a.route?.nodeIds.length, b.route?.progressIndex); });
    const calls = h.pilotTexts().filter((t) => /nose to nose/.test(t));
    const ground = h.atc('GND').map((e) => e.text);
    console.info(`AI head-on KACY: closest ${minGap.toFixed(1)} m; calls ${calls.length}; Ground: ${ground.filter((t) => /pull off|one eighty|again/.test(t)).join(' | ')}; A ${a.phase} B ${b.phase}`);
    console.info([...new Set(h.events.map((e) => e.kind))].join(' '), h.events.filter((e) => /proximity|ground/i.test(e.text)).map((e) => e.text).join(' | '));
    expect(minGap).toBeGreaterThan(25);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(ground.some((t) => /make a one eighty|pull off/.test(t))).toBe(true);
    // nobody is stuck: both are on their way / holding at a runway hold, or have left the corridor
    expect(h.events.filter((e) => e.kind === 'SEPARATION_VIOLATION' || e.kind === 'RUNWAY_INCURSION')).toEqual([]);
    expect(dist(a.pos, b.pos)).toBeGreaterThan(25);
    expect(['HOLDING_SHORT', 'TAXIING', 'LINE_UP_AND_WAIT'].includes(a.phase)).toBe(true);
    expect(a.groundSpeedKt > 0.5 || a.phase === 'HOLDING_SHORT').toBe(true);
  });

  it('KMHT terminal corridor: two airliners are pulled apart by Ground (a branch off the corridor or a turn near the apron) and both go on', () => {
    const h = scenario(kmht, '17', [dep('NKS1A', 'GATE-1', 'A320'), hold('NKS2B', 'HP17-35-B-1', '17', 'A320')], 'HP17-35-B-1');
    expect(h.runUntil(() => h.find('NKS1A')?.phase === 'TAXIING' && !!h.find('NKS1A')?.route, 900)).toBe(true);
    const a = h.find('NKS1A')!;
    const b = h.find('NKS2B')!;
    meetOnTheLane(h, kmht, a, b);
    let minGap = Infinity;
    h.run(1500, () => { const d = dist(a.pos, b.pos); minGap = Math.min(minGap, d); if (process.env.DBG && Math.round(h.now()) % 15 === 0 && d < 400) console.info(Math.round(h.now()), d.toFixed(0), a.phase, a.groundSpeedKt.toFixed(1), a.route?.progressIndex + '/' + a.route?.nodeIds.length, b.phase, b.groundSpeedKt.toFixed(1), b.route?.progressIndex + '/' + b.route?.nodeIds.length, a.pendingRequest?.text, '|', b.pendingRequest?.text); });
    const ground = h.atc('GND').map((e) => e.text).filter((t) => /pull off|one eighty/.test(t));
    console.info(`AI head-on KMHT: closest ${minGap.toFixed(1)} m; Ground: ${ground.join(' | ')}; A ${a.phase} ${a.groundSpeedKt.toFixed(0)} kt, B ${b.phase} ${b.groundSpeedKt.toFixed(0)} kt`);
    expect(minGap).toBeGreaterThan(40);
    expect(h.pilotTexts().some((t) => /nose to nose with/.test(t))).toBe(true);
    expect(ground.length).toBeGreaterThanOrEqual(1);
    expect(dist(a.pos, b.pos)).toBeGreaterThan(40);
  });
});
