/**
 * AI controllers: one rule-based agent per AI position. See README.md.
 *
 * Loop (once per sim second): every agent lists the transmissions it could make now (pure functions of the simulation state),
 * the best one is scheduled after a human reaction delay (default 2-6 s, never sooner than 3 s after the position's previous
 * transmission), re-evaluated when the delay is over (dropped if the situation changed), and then performed through
 * `engine.applyCommand(cmd, { position, source: 'ai', aiPosition: position })` so that every validation applies. Several
 * commands of one transmission share a `transmissionId`, which makes the engine log exactly ONE ATC event per transmission.
 */
import type { AiControllerOptions, AiControllers, AiTransmission } from './index';
import type { Aircraft, ControllerPositionId, SimulationState } from '../sim/types';
import { mulberry32 } from '../sim/rng';
import { facilityCallName, hearsFrequency } from '../radio/frequencies';
import { blocked, freqsOf, newMemory, pickBest } from './core';
import type { Agent, AgentMemory, AgentView, Plan } from './core';
import { createClearanceAgent } from './clnc';
import { createGroundAgent } from './ground';
import { createTowerAgent } from './tower';
import { createApproachAgent, createDepartureAgent } from './approach';
import { correctionAgent } from './corrections';

export const DEFAULT_REACTION_DELAY_SEC: [number, number] = [2, 6];
/** Minimum spacing between two transmissions of the same position. */
export const MIN_TRANSMISSION_GAP_SEC = 3;
/** After a refused command the same action is not tried again for this long (longer after repeated refusals). */
export const REJECT_BACKOFF_SEC = 10;

const POSITION_ORDER: ControllerPositionId[] = ['CLNC', 'GND', 'TWR', 'APP', 'DEP'];
const VOICE: Record<ControllerPositionId, string> = {
  CLNC: 'atc-clnc', GND: 'atc-gnd', TWR: 'atc-twr', APP: 'atc-app', DEP: 'atc-dep',
};

interface Scheduled {
  key: string;
  priority: number;
  at: number;
  summary: string;
}

interface AgentRuntime {
  position: ControllerPositionId;
  agent: Agent;
  mem: AgentMemory;
  /** Frequencies (MHz) the AI may use: those no human position also works. Empty = the position is covered by the player. */
  usableMhz: number[];
  covered?: string;
  scheduled?: Scheduled;
  seq: number;
}

export function createAiControllers(opts: AiControllerOptions): AiControllers {
  const { engine, airport } = opts;
  const delay = opts.reactionDelaySec ?? DEFAULT_REACTION_DELAY_SEC;
  const seed = opts.seed ?? engine.getState().seed;
  const rand = mulberry32((seed ^ 0x5a17c0de) >>> 0);
  const positions = POSITION_ORDER.filter((p) => opts.positions.includes(p));
  const staffed = new Set<ControllerPositionId>([...opts.positions, ...opts.playerPositions]);
  const aiSet = new Set<ControllerPositionId>(opts.positions);
  const playerMhz = opts.playerPositions.flatMap((p) => freqsOf(airport, p).map((f) => f.mhz));
  const sameMhz = (a: number, b: number) => Math.abs(a - b) < 0.0005;

  const clearanceStore = { rand, reserved: new Set<string>(), memo: new Map<string, string>() };
  const agents: Record<ControllerPositionId, Agent> = {
    CLNC: createClearanceAgent(clearanceStore),
    GND: createGroundAgent(clearanceStore),
    TWR: createTowerAgent(),
    APP: createApproachAgent((v) => !v.staffed.has('DEP')),
    DEP: createDepartureAgent(),
  };

  const runtimes: AgentRuntime[] = positions.map((position) => {
    const all = freqsOf(airport, position).map((f) => f.mhz);
    const usable = all.filter((m) => !playerMhz.some((p) => sameMhz(p, m)));
    const sharer = opts.playerPositions.find((pp) => freqsOf(airport, pp).some((f) => all.some((m) => sameMhz(f.mhz, m))));
    return {
      position,
      agent: (v) => [...correctionAgent(v), ...agents[position](v)],
      mem: newMemory(),
      usableMhz: usable,
      covered: usable.length === 0 && all.length > 0 ? `covered by the player's ${sharer ?? 'position'} (shared frequency)` : undefined,
      seq: 0,
    };
  });

  let lastSec = -1;
  let busy = false;
  let disposed = false;

  function viewFor(state: SimulationState, rt: AgentRuntime): AgentView {
    const now = state.clock.timeSec;
    const onFrequency = Object.values(state.aircraft).filter((ac) => rt.usableMhz.some((m) => hearsFrequency(ac, m)));
    for (const ac of onFrequency) if (!rt.mem.firstSeen.has(ac.id)) rt.mem.firstSeen.set(ac.id, now);
    const ids = new Set(onFrequency.map((a) => a.id));
    for (const id of rt.mem.firstSeen.keys()) if (!ids.has(id)) rt.mem.firstSeen.delete(id);
    return {
      state, airport, now, position: rt.position, staffed, aiPositions: aiSet, mem: rt.mem, onFrequency,
      settled: (ac) => now - (rt.mem.firstSeen.get(ac.id) ?? now),
      freqs: (p) => freqsOf(airport, p),
      facility: (ac) => facilityCallName(airport, ac.frequencyMhz, ac.frequencyId),
    };
  }

  function transmit(state: SimulationState, rt: AgentRuntime, plan: Plan): void {
    const t = state.clock.timeSec;
    const ac = Object.values(state.aircraft).find((a) => a.id === plan.aircraftId);
    if (!ac) return;
    const tid = `ai-${rt.position}-${++rt.seq}`;
    const spoken = plan.phrase.spoken;
    const norm = spoken.toLowerCase().replace(/[,.]/g, '').replace(/\s+/g, ' ').trim();
    const cmds = plan.cmds.map((c) => ({ ...c, rawText: spoken, normalizedText: norm, confidence: 1, issues: [] as string[] }));
    const tx: AiTransmission = {
      position: rt.position, frequencyMhz: ac.frequencyMhz, text: plan.phrase.text, spokenText: spoken,
      callsign: ac.callsign, timeSec: t, voiceId: VOICE[rt.position],
    };
    // The controller speaks first; the pilot's readback (logged and voiced inside applyCommand) follows.
    opts.onTransmission?.(tx);
    const o = { position: rt.position, source: 'ai' as const, aiPosition: rt.position, transmissionId: tid };
    let accepted = true;
    for (let i = 0; i < cmds.length; i++) {
      const out = engine.applyCommand(cmds[i], o);
      if (out.status !== 'accepted') {
        accepted = false;
        break;
      }
    }
    const m = rt.mem;
    m.lastTxAt = t;
    m.lastSummary = plan.summary;
    m.lastSummaryAt = t;
    if (accepted) {
      m.recent.set(plan.key, t);
      m.rejects.delete(plan.key);
      if (plan.once) m.done.add(plan.key);
    } else {
      const n = (m.rejects.get(plan.key) ?? 0) + 1;
      m.rejects.set(plan.key, n);
      m.backoff.set(plan.key, t + REJECT_BACKOFF_SEC * (n >= 3 ? 6 : 1));
    }
  }

  function anyTransmitting(v: AgentView): boolean {
    return v.onFrequency.some((a: Aircraft) => a.radioState === 'TRANSMITTING');
  }

  function reactionDelay(plan: Plan): number {
    return plan.priority >= 100 ? delay[0] : delay[0] + rand() * (delay[1] - delay[0]);
  }

  function step(state: SimulationState, rt: AgentRuntime): void {
    if (rt.covered) return;
    const v = viewFor(state, rt);
    const now = v.now;
    const plans = rt.agent(v).filter((p) => !blocked(rt.mem, p, now));
    const sch = rt.scheduled;
    if (sch) {
      const fresh = plans.find((p) => p.key === sch.key);
      const best = pickBest(plans);
      if (!fresh) {
        rt.scheduled = undefined; // the situation changed: forget it, decide again next second
        return;
      }
      if (best && best.key !== sch.key && best.priority >= sch.priority + 15) {
        rt.scheduled = { key: best.key, priority: best.priority, at: Math.max(now + reactionDelay(best), rt.mem.lastTxAt + MIN_TRANSMISSION_GAP_SEC), summary: best.summary };
        return;
      }
      if (now + 1e-9 < sch.at) return;
      if (anyTransmitting(v)) {
        sch.at = now + 1;
        return;
      }
      rt.scheduled = undefined;
      transmit(state, rt, fresh);
      return;
    }
    const best = pickBest(plans);
    if (!best) return;
    rt.scheduled = {
      key: best.key, priority: best.priority, summary: best.summary,
      at: Math.max(now + reactionDelay(best), rt.mem.lastTxAt + MIN_TRANSMISSION_GAP_SEC),
    };
  }

  return {
    update(state) {
      if (disposed || busy) return;
      const sec = Math.floor(state.clock.timeSec + 1e-9);
      if (sec === lastSec) return;
      lastSec = sec;
      busy = true; // engine.applyCommand notifies subscribers, which may call update() again
      try {
        for (const rt of runtimes) step(state, rt);
      } finally {
        busy = false;
      }
    },
    positions: () => [...opts.positions],
    status() {
      const state = engine.getState();
      const out: Record<string, string> = {};
      for (const rt of runtimes) {
        const label = `${rt.position} (AI)`;
        if (rt.covered) {
          out[rt.position] = `${label}: ${rt.covered}`;
          continue;
        }
        const n = Object.values(state.aircraft).filter((ac) => rt.usableMhz.some((m) => hearsFrequency(ac, m))).length;
        const count = `${n} aircraft`;
        const recent = rt.mem.lastSummary && state.clock.timeSec - rt.mem.lastSummaryAt < 120;
        const tail = rt.scheduled ? `, next: ${rt.scheduled.summary}` : recent ? `, last: ${rt.mem.lastSummary}` : n ? ', monitoring' : ', no traffic';
        out[rt.position] = `${label}: ${count}${tail}`;
      }
      return out;
    },
    dispose() {
      disposed = true;
      for (const rt of runtimes) rt.scheduled = undefined;
    },
  };
}
