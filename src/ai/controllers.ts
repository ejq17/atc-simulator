/**
 * AI controllers: one rule-based agent per AI position. See README.md.
 *
 * Loop (once per sim second): every agent lists the transmissions it could make now (pure functions of the simulation state),
 * the best one is scheduled after a human reaction delay (default 2-6 s, never sooner than 3 s after the position's previous
 * transmission), re-evaluated when the delay is over (dropped if the situation changed), and then performed through
 * `engine.applyCommand(cmd, { position, source: 'ai', aiPosition: position })` so that every validation applies. Several
 * commands of one transmission share a `transmissionId`, which makes the engine log exactly ONE ATC event per transmission.
 */
import { gapPlans } from './gapActions';
import type { AiControllerOptions, AiControllers, AiTransmission } from './index';
import type { SimulationEngineExtras } from '../sim/engineExtras';
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
import { requestAgent } from './requests';
import { createSpecialAgent } from './special';
import { coordinationAgent } from './coordination';

export const DEFAULT_REACTION_DELAY_SEC: [number, number] = [2, 6];
/** Minimum spacing between two transmissions of the same position. */
export const MIN_TRANSMISSION_GAP_SEC = 3;
/**
 * A controller does not key over a pilot call that is queued (`anyTransmitting`, the pilot has not keyed yet: a request can wait 48 s for its reaction time and the
 * answer window of the controller's own call). A correction of a readback error has 23 s (the 20 s window starts 3 s after the controller's call) and is not
 * kept waiting for it longer than this: soak seed 8 moderate, an approach clearance without a readback was never corrected because an unrelated request
 * queued on the same frequency held Approach silent until the window had closed. DESIGN VALUE; a controller who keys at the same moment as a pilot is blocked
 * like two pilots (the engine's collision rule).
 */
export const CORRECTION_PATIENCE_SEC = 5;
/**
 * A controller whose transmission is due waits for a busy frequency this long (s), then keys up anyway: a pilot who repeats a call back to back (soak, KPGD seed 1: "nose to nose"
 * every 17 s for 2,000 s, each call as long as the gap) would keep the controller off the air for good, and every other aircraft on the frequency with it. DESIGN VALUE.
 */
export const BUSY_FREQUENCY_PATIENCE_SEC = 20;
const CORRECTION_PRIORITY = 95;
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
  /** When the plan was first scheduled (a correction stops waiting for queued pilot calls after `CORRECTION_PATIENCE_SEC`). */
  since?: number;
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
  const approachAgent = createApproachAgent((v) => !v.staffed.has('DEP'));
  const specialGnd = createSpecialAgent('GND');
  const specialTwr = createSpecialAgent('TWR');
  const specialApp = createSpecialAgent('APP');
  const towerAgent = createTowerAgent();
  const groundAgent = createGroundAgent(clearanceStore);
  const agents: Record<ControllerPositionId, Agent> = {
    CLNC: createClearanceAgent(clearanceStore),
    GND: (v) => [...groundAgent(v), ...specialGnd(v)],
    // Approach closed (nobody works APP): Tower sequences missed approaches and inbound IFR traffic itself, as Ground issues
    // IFR clearances when Delivery is closed. Otherwise an IFR go-around would wait forever for a frequency that nobody answers.
    // (an approved departure gap, ai/gapActions.ts: each position speaks to the aircraft on its own frequency)
    TWR: (v) => [...towerAgent(v), ...gapPlans(v), ...specialTwr(v), ...(v.staffed.has('APP') ? [] : [...approachAgent(v), ...specialApp(v)])],
    APP: (v) => [...approachAgent(v), ...gapPlans(v), ...specialApp(v)],
    DEP: createDepartureAgent(),
  };

  const runtimes: AgentRuntime[] = positions.map((position) => {
    const all = freqsOf(airport, position).map((f) => f.mhz);
    const usable = all.filter((m) => !playerMhz.some((p) => sameMhz(p, m)));
    const sharer = opts.playerPositions.find((pp) => freqsOf(airport, pp).some((f) => all.some((m) => sameMhz(f.mhz, m))));
    return {
      position,
      agent: (v) => [...correctionAgent(v), ...coordinationAgent(v), ...requestAgent(v), ...agents[position](v)],
      mem: newMemory(),
      usableMhz: usable,
      covered: usable.length === 0 && all.length > 0 ? `covered by the player's ${sharer ?? 'position'} (shared frequency)` : undefined,
      seq: 0,
    };
  });

  // Who works what decides which coordination rules apply (a person working both positions of a pair coordinates with himself).
  // An AI position that is covered by the player's shared frequency (KACY Approach/Departure) is the player's too.
  const coveredByPlayer = runtimes.filter((rt) => rt.covered).map((rt) => rt.position);
  (engine as SimulationEngineExtras).coordination?.setStaffing(
    [...opts.playerPositions, ...coveredByPlayer], opts.positions.filter((p) => !coveredByPlayer.includes(p)),
  );

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
    if (plan.coord) {
      // A landline call: made through the coordination channel; the message it logged is what the AI "says".
      const api = (engine as SimulationEngineExtras).coordination;
      const msg = api ? plan.coord.run(api) : undefined;
      const m = rt.mem;
      m.lastTxAt = t;
      m.lastSummary = plan.summary;
      m.lastSummaryAt = t;
      m.recent.set(plan.key, t);
      if (plan.once) m.done.add(plan.key);
      if (msg) {
        opts.onTransmission?.({
          position: rt.position, frequencyMhz: ac.frequencyMhz, text: msg.text, spokenText: msg.spoken || msg.text, callsign: ac.callsign, timeSec: t,
          voiceId: VOICE[rt.position], channel: 'landline', toPosition: plan.coord.to,
        });
      }
      return;
    }
    const spoken = plan.phrase.spoken;
    const norm = spoken.toLowerCase().replace(/[,.]/g, '').replace(/\s+/g, ' ').trim();
    // A pilot who asked to "say again" a long transmission hears it repeated slowly (no size mark), so it cannot be refused again.
    const slow = rt.mem.notes.has(`slow:${plan.key}`);
    const cmds = plan.cmds.map((c) => ({ ...c, rawText: spoken, normalizedText: norm, confidence: 1, issues: [] as string[], ...(plan.cmds.length > 1 && !slow ? { groupSize: plan.cmds.length } : {}) }));
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
      if (out.status === 'accepted') rt.mem.sent.set(`${cmds[i].callsign}:${cmds[i].kind}`, plan.cmds[i]);
      if (out.status !== 'accepted') {
        accepted = false;
        if (out.status === 'clarify' && cmds.length > 1) rt.mem.notes.set(`slow:${plan.key}`, t);
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
        rt.scheduled = { key: best.key, priority: best.priority, since: now, at: Math.max(now + reactionDelay(best), rt.mem.lastTxAt + MIN_TRANSMISSION_GAP_SEC), summary: best.summary };
        return;
      }
      if (now + 1e-9 < sch.at) return;
      if (anyTransmitting(v) && now - (sch.since ?? now) < BUSY_FREQUENCY_PATIENCE_SEC && !(sch.priority >= CORRECTION_PRIORITY && now - (sch.since ?? now) >= CORRECTION_PATIENCE_SEC)) {
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
      key: best.key, priority: best.priority, summary: best.summary, since: now,
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
