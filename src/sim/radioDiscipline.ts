/**
 * What a pilot call does between "the pilot wants to speak" and "the voice layer plays it":
 *
 *  - response delay: a readback / answer comes `responseDelaySec` after the controller finishes (airline crews quick, GA slower,
 *    students slowest; seeded per aircraft and per call);
 *  - blocked transmissions: with `realism.radioDiscipline` every call is held `blockWindowSec` after keying. Two pilots who key up on
 *    one frequency inside that window never heard each other: both calls are garbled (RADIO_BLOCKED event, `blocked` transmission to the
 *    voice layer, which plays a squeal) and each pilot retries after a different seeded delay. A pilot who keys up while another call
 *    is audibly in progress waits for it to end;
 *  - callsign style: "November" opening, "student pilot", "with you", abbreviated callsign (see `styleCall`).
 *
 * The decision is made here, deterministically (only seeds derived from the aircraft seed); the voice layer only renders it.
 * Without realism (`radioDiscipline` false and no delay) a call is spoken immediately, exactly as before.
 */
import type { Aircraft, SimEvent } from './types';
import { emitEvent, getRuntime } from './context';
import type { SimContext } from './context';
import { seeded01 } from './rng';
import { abbreviatedCallsign, novemberCallsign, registrationOf, similarSounding } from '../radio/callsigns';

export interface ScheduledSpeech {
  id: number;
  aircraftId: string;
  text: string;
  data?: Record<string, unknown>;
  frequencyMhz: number;
  keyedAtSec: number;
  emitAtSec: number;
  attempt: number;
  /** An answer to the controller (readback...), not a call the pilot started himself. */
  answer: boolean;
}

/** Longest a pilot retries after being blocked before he simply gets through (the window then never blocks him again). */
export const MAX_BLOCK_RETRIES = 2;
/** Length of the squeal / heterodyne the voice layer plays for a blocked transmission. */
export const BLOCKED_SQUEAL_SEC = 1.4;
const WAIT_GAP_SEC = 0.3;
/**
 * Seeded reaction time (0..this) before a pilot-initiated call is keyed: 40 % the aircraft's own habit (a slow or a quick pilot), 60 % per call,
 * so aircraft on the same leg or with the same trigger do not report at the same instant. DESIGN VALUE.
 */
const KEYUP_SPREAD_SEC = 12;
/** Seeded spread of the moment a waiting pilot keys up after the call (and the calls reserved before his) ends. */
const WAIT_SPREAD_SEC = 0.6;

/** Rough speaking time of a transmission (seconds). */
export function speechDurationSec(text: string): number {
  return 1 + text.split(/\s+/).length * 0.38;
}

export type PilotClass = 'airline' | 'ga' | 'student';
export function pilotClass(ac: Aircraft): PilotClass {
  if (ac.student) return 'student';
  return registrationOf(ac.callsign) ? 'ga' : 'airline';
}

/** Seconds from the end of the controller's call to the pilot keying up: base speed per aircraft (60 %) plus a per-call share (40 %). */
export function responseDelaySec(ctx: SimContext, ac: Aircraft): number {
  const r = ctx.pilotBehaviour.realism.responseDelaySec[pilotClass(ac)];
  if (r[1] <= 0) return 0;
  const rt = getRuntime(ctx, ac);
  const base = seeded01(ac.seed, 'resp-base');
  const jitter = seeded01(ac.seed, `resp:${rt.cmdSeq}`);
  return r[0] + (r[1] - r[0]) * (0.6 * base + 0.4 * jitter);
}

const freqKey = (mhz: number) => mhz.toFixed(3);

/** A call queued to go on the air from `keyedAt + window` until its end: later pilots who key up after `from` hear that and wait for it. */
export function reserveChannel(ctx: SimContext, key: string, keyedAt: number, window: number, durationSec: number): void {
  const cur = ctx.frequencyReserved.get(key);
  const from = cur && cur.end > keyedAt ? Math.min(cur.from, keyedAt + window) : keyedAt + window;
  ctx.frequencyReserved.set(key, { from, end: Math.max(cur?.end ?? 0, keyedAt + window + durationSec) });
}
/** End of the queued calls a pilot keying up at `at` can know about (0 when none has started yet). */
function reservedEnd(ctx: SimContext, key: string, at: number): number {
  const r = ctx.frequencyReserved.get(key);
  return r && at >= r.from ? r.end : 0;
}

/**
 * A repeat interval with the aircraft's own seeded spread of +-25 % (per aircraft and per repetition): periodic calls (pushback re-ask, "say intentions", the
 * request for the numbers) of two aircraft started together must not stay in step. Unchanged at level off. `floorSec`: the interval never goes below it
 * (the 90 s of JO 7110.65 3-9-4 NOTE for line up and wait is the controller's limit, so that pilot only waits longer).
 */
export function jitteredInterval(ctx: SimContext, ac: Aircraft, label: string, baseSec: number, count = 0, floorSec = 0): number {
  if (ctx.pilotBehaviour.realism.level === 'off') return baseSec;
  return Math.max(floorSec, baseSec * (0.75 + 0.5 * seeded01(ac.seed, `${label}:${count}`)));
}

const replaceAll = (text: string, from: string, to: string) => (from && from !== to ? text.split(from).join(to) : text);

/** Is another aircraft on this aircraft's frequency a similar-sounding callsign (never abbreviate then, AIM 4-2-4). */
function hasSimilarOnFrequency(ctx: SimContext, ac: Aircraft): boolean {
  return Object.values(ctx.state.aircraft).some((o) => o.id !== ac.id && Math.abs(o.frequencyMhz - ac.frequencyMhz) < 0.0005 && similarSounding(ac.callsign, o.callsign));
}

/**
 * The words of a pilot call as spoken: builders write the aircraft's full `spokenCallsign`; the call is then adapted to the pilot.
 * Initial contact = first pilot-initiated call on a frequency (not an answer to the controller).
 */
export function styleCall(ctx: SimContext, ac: Aircraft, text: string, data: Record<string, unknown> | undefined, initial: boolean): string {
  const R = ctx.pilotBehaviour.realism;
  if (R.level === 'off') return text;
  const rt = getRuntime(ctx, ac);
  const full = ac.spokenCallsign;
  const ga = pilotClass(ac) !== 'airline';
  // GA pilots who open with "November" keep to it until the controller abbreviates (the seeded habit of this pilot)
  const november = ga && !!registrationOf(ac.callsign) && seeded01(ac.seed, 'november') < R.novemberInitialRate;
  const abbreviated = !initial && R.abbreviateAfterController && rt.abbreviationOk && ga && !hasSimilarOnFrequency(ctx, ac) ? abbreviatedCallsign(ac.callsign, ac.type) : undefined;
  let out = november ? replaceAll(text, full, novemberCallsign(ac.callsign)) : text;
  const cs = november ? novemberCallsign(ac.callsign) : full;
  if (abbreviated) {
    out = replaceAll(out, cs, november ? (abbreviatedCallsign(ac.callsign) ?? abbreviated) : abbreviated);
  } else if (initial) {
    if (ac.student) out = out.replace(cs, `${cs}, student pilot`); // AIM 4-2-4: "student pilot" on the initial call to each facility
    else if (!ga && (data?.checkIn || data?.request === 'APPROACH')) {
      const r = seeded01(ac.seed, `style:${rt.callSeq++}`);
      if (r < R.withYouRate) out = out.replace(cs, `${cs}, with you`); // non-standard but common
      else if (r < R.withYouRate + R.withBravoRate) out = out.replace(/, (?:with )?information (\w+)/i, ', with $1'); // non-standard shorthand for "with information"
    }
  }
  return out;
}

const RESPONSE_FLAGS = ['readback', 'rejection', 'clarify', 'correction', 'repeated'] as const;

/** A blocked call that carries the pilot's request: the controller has not heard it, so the request is not shown until the retry is on the air. */
export function markBlockedRequest(ac: Aircraft, m: Pick<ScheduledSpeech, 'answer' | 'data'>): void {
  if (!m.answer && (m.data?.request || m.data?.pilotRequest) && ac.pendingRequest) ac.pendingRequest.unheard = true;
}

/** The pilot's own call went out: a request held back by a block is heard now. */
export function markRequestHeard(ac: Aircraft, data?: Record<string, unknown>): void {
  if (ac.pendingRequest?.unheard && (data?.request || data?.pilotRequest)) ac.pendingRequest.unheard = false;
}

/** Speak now: log the TRANSMISSION event, update the radio state, notify the voice layer. */
export function speakNow(ctx: SimContext, ac: Aircraft, text: string, data?: Record<string, unknown>, frequencyMhz = ac.frequencyMhz): SimEvent {
  const rt = getRuntime(ctx, ac);
  const key = freqKey(frequencyMhz);
  const isAnswer = RESPONSE_FLAGS.some((f) => data?.[f]);
  const initial = !isAnswer && !rt.contacted.has(key);
  rt.contacted.add(key);
  if (!isAnswer) markRequestHeard(ac, data);
  if (ctx.pilotBehaviour.realism.level !== 'off') ac.flags.inContact = true;
  const spoken = styleCall(ctx, ac, text, data, initial);
  const ev = emitEvent(ctx, {
    kind: 'TRANSMISSION', aircraftId: ac.id, callsign: ac.callsign, text: spoken, severity: 'info', frequencyMhz, speaker: 'PILOT',
    data: initial ? { ...data, initialContact: true } : data,
  });
  if (!data?.clarify) rt.lastPilotText = spoken;
  const dur = speechDurationSec(spoken);
  rt.radioFreeAtSec = ctx.state.clock.timeSec + dur;
  ac.radioState = 'TRANSMITTING';
  ctx.frequencyUse.set(key, ctx.state.clock.timeSec + dur);
  // The 20 s in which a faulty readback must be corrected start when the controller has HEARD it, not when the instruction was given.
  if (typeof data?.clearanceId === 'string') {
    const owner = data.wrongCallsign ? Object.values(ctx.state.aircraft).find((x) => x.callsign === data.intendedCallsign) : ac;
    const err = owner ? getRuntime(ctx, owner).readbackError : undefined;
    if (err && err.clearanceId === data.clearanceId) err.sinceSec = ctx.state.clock.timeSec + dur;
  }
  ctx.onPilotTransmission?.({ aircraftId: ac.id, callsign: ac.callsign, text: spoken, frequencyMhz, voiceId: ac.voiceId, event: ev });
  return ev;
}

/**
 * One readback per transmission. A controller transmission that gives several instructions (ground: "turn left on Bravo, continue to Charlie,
 * hold short of runway four", "turn right at Charlie, contact Ground point niner"; air: "climb and maintain three thousand, turn left heading two seven zero", "cleared ILS approach, contact Tower"; IFR clearance with a frequency change) is answered by ONE pilot readback: the commands of the
 * transmission are executed one by one (each with its own effect and its own readback text, errors included) and their readback fragments are
 * joined here, the callsign said once at the end. The group is spoken when the last command of the transmission has been applied, or on the next
 * engine tick, or when a command of another transmission arrives, whichever is first.
 * Basis (AIM 4-4-7 b names altitude, vector and runway assignments as elements to read back; 2-4-3): JO 7110.65 3-7-2 NOTE ("Progressive instructions may include step-by-step directions and/or directional turns") and AIM 4-3-18 (progressive
 * taxi) say that such instructions exist and that taxi, hold-short and crossing instructions are read back (2-4-3; the hold-short part is the
 * one pilots are required to include). Neither text says how many radio calls the readback is made of: that one transmission is answered by one
 * call, the callsign said once at the end, is a DESIGN CHOICE (a real pilot does not key up three times for one instruction). The pilot's own
 * request for the next step ("at Lima, request next progressive taxi instructions") is a separate call and is unchanged.
 */
export function addReadbackFragment(ctx: SimContext, ac: Aircraft, tid: string, text: string, clearanceId: string, delaySec: number): void {
  const g = ctx.readbackGroup;
  if (g && (g.tid !== tid || g.aircraftId !== ac.id)) flushReadbackGroup(ctx);
  if (!ctx.readbackGroup) ctx.readbackGroup = { tid, aircraftId: ac.id, parts: [], delaySec };
  ctx.readbackGroup.parts.push({ text, clearanceId });
}

/** Speak the joined readback of the pending group (nothing when there is none). */
export function flushReadbackGroup(ctx: SimContext): void {
  const g = ctx.readbackGroup;
  if (!g) return;
  ctx.readbackGroup = undefined;
  const ac = ctx.state.aircraft[g.aircraftId];
  if (!ac || g.parts.length === 0) return;
  const cs = ac.spokenCallsign;
  const tail = new RegExp(`,?\\s*${cs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  const bodies = g.parts.map((p) => p.text.replace(tail, '').trim());
  const joined = bodies.map((b, i) => (i === 0 ? b : b.charAt(0).toLowerCase() + b.slice(1))).join(', ');
  // a readback error still waiting for the controller to hear it starts its 20 s window when this call ends (speakNow)
  const pending = getRuntime(ctx, ac).readbackError;
  const clearanceId = pending && g.parts.some((p) => p.clearanceId === pending.clearanceId) ? pending.clearanceId : g.parts[0].clearanceId;
  pilotSay(ctx, ac, `${joined}, ${cs}`, { readback: true, clearanceId, clearanceIds: g.parts.map((p) => p.clearanceId) }, g.delaySec);
}

/**
 * A pilot "speaks". Immediate without realism; otherwise queued (`delaySec` response time, then the key-up window in which a second
 * call on the frequency blocks it).
 */
export function pilotSay(ctx: SimContext, ac: Aircraft, text: string, data?: Record<string, unknown>, delaySec = 0): SimEvent {
  if (ctx.dryRun) return { id: 'ev-dry', timeSec: ctx.state.clock.timeSec, kind: 'TRANSMISSION', text, severity: 'info', speaker: 'PILOT' };
  const R = ctx.pilotBehaviour.realism;
  if (!R.radioDiscipline && delaySec <= 0) return speakNow(ctx, ac, text, data);
  const now = ctx.state.clock.timeSec;
  const rt = getRuntime(ctx, ac);
  // A call the pilot starts himself (not an answer to the controller, not a go-around) is keyed after a short seeded reaction time: pilots
  // do not key up on the same tick, so two aircraft with the same trigger (spawned together, same distance) do not collide by construction.
  if (delaySec <= 0 && !RESPONSE_FLAGS.some((f) => data?.[f])) {
    const u = 0.4 * seeded01(ac.seed, 'keyup-base') + 0.6 * seeded01(ac.seed, `keyup:${rt.callSeq++}`);
    delaySec = (data?.goAround ? 3 * u : (data?.pilotRequest ? 4 : 1) * KEYUP_SPREAD_SEC * u);
  }
  // one transmitter per aircraft: a second call waits until the first (queued or on the air) is finished
  let keyedAtSec = Math.max(now + Math.max(0, delaySec), rt.radioFreeAtSec > now ? rt.radioFreeAtSec + WAIT_GAP_SEC : 0);
  if (R.radioDiscipline) {
    const key = freqKey(ac.frequencyMhz);
    const onAir = ctx.frequencyUse.get(key) ?? 0;
    if (RESPONSE_FLAGS.some((f) => data?.[f])) {
      // An answer comes after the controller's transmission (and any call on the air), at the pilot's own response time; two aircraft
      // answering one call at the same moment do collide.
      keyedAtSec = Math.max(keyedAtSec, onAir + WAIT_GAP_SEC);
      reserveChannel(ctx, key, keyedAtSec, R.blockWindowSec, speechDurationSec(text));
    } else {
      // Listen before transmitting: a pilot who finds the channel busy (a call on the air, or waiting pilots ahead of him) keys up after them.
      const taken = Math.max(onAir, reservedEnd(ctx, key, keyedAtSec));
      if (taken > keyedAtSec) {
        keyedAtSec = taken + WAIT_GAP_SEC + seeded01(ac.seed, `listen:${rt.callSeq++}`) * WAIT_SPREAD_SEC;
      }
      // Stagger: a call of his own is not keyed within `blockWindowSec` + `STAGGER_MARGIN_SEC` of a call already queued on the frequency (pilots
      // who report from the same trigger take slightly different moments); an answer to the controller keeps its own time.
      keyedAtSec = staggered(ctx, ac, ac.frequencyMhz, keyedAtSec, R.blockWindowSec, `stagger:${rt.callSeq++}`);
      reserveChannel(ctx, key, keyedAtSec, R.blockWindowSec, speechDurationSec(text));
    }
  }
  const entry: ScheduledSpeech = {
    id: ++ctx.speechSeq, aircraftId: ac.id, text, data, frequencyMhz: ac.frequencyMhz, keyedAtSec,
    emitAtSec: keyedAtSec + (R.radioDiscipline ? R.blockWindowSec : 0), attempt: 0, answer: RESPONSE_FLAGS.some((f) => data?.[f]),
  };
  ctx.scheduledSpeech.push(entry);
  ac.radioState = 'TRANSMITTING';
  rt.radioFreeAtSec = Math.max(rt.radioFreeAtSec, entry.emitAtSec + speechDurationSec(text));
  return { id: 'ev-queued', timeSec: now, kind: 'TRANSMISSION', text, severity: 'info', speaker: 'PILOT', aircraftId: ac.id, callsign: ac.callsign };
}

/** Called once per tick before the pilots act: emits the calls that are due, blocks colliding ones, defers calls over a busy channel. */
export function flushScheduledSpeech(ctx: SimContext): void {
  if (ctx.scheduledSpeech.length === 0) return;
  const R = ctx.pilotBehaviour.realism;
  const now = ctx.state.clock.timeSec;
  if (R.radioDiscipline) deferForAnswerWindows(ctx);
  for (let guard = 0; guard < 200; guard++) {
    const due = ctx.scheduledSpeech.filter((e) => e.emitAtSec <= now + 1e-9).sort((a, b) => a.keyedAtSec - b.keyedAtSec || a.id - b.id);
    const e = due[0];
    if (!e) return;
    const ac = ctx.state.aircraft[e.aircraftId];
    if (!ac) {
      ctx.scheduledSpeech = ctx.scheduledSpeech.filter((x) => x !== e);
      continue;
    }
    if (R.radioDiscipline) {
      // A pilot who keys up while the controller has just called someone waits for that answer.
      const aw = ctx.answerWindow.get(freqKey(e.frequencyMhz));
      if (!e.answer && aw && e.keyedAtSec >= aw.from - 1e-9 && e.keyedAtSec < aw.end) {
        e.keyedAtSec = aw.end + WAIT_GAP_SEC + seeded01(ac.seed, `answerwait:${e.id}`) * WAIT_SPREAD_SEC;
        e.emitAtSec = e.keyedAtSec + R.blockWindowSec;
        reserveChannel(ctx, freqKey(e.frequencyMhz), e.keyedAtSec, R.blockWindowSec, speechDurationSec(e.text));
        continue;
      }
      const group = ctx.scheduledSpeech.filter((x) => Math.abs(x.frequencyMhz - e.frequencyMhz) < 0.0005 && x.keyedAtSec >= e.keyedAtSec - 1e-9
        && x.keyedAtSec < e.keyedAtSec + R.blockWindowSec - 1e-9 && x.attempt < MAX_BLOCK_RETRIES && ctx.state.aircraft[x.aircraftId]);
      if (group.length >= 2 && e.attempt < MAX_BLOCK_RETRIES) {
        blockGroup(ctx, group);
        continue;
      }
      const key = freqKey(e.frequencyMhz);
      const busyUntil = ctx.frequencyUse.get(key);
      if (busyUntil !== undefined && busyUntil > now + 1e-9) {
        // The channel is occupied and the pilot hears it: he waits for the end of the call. Pilots who wait queue behind each other (each
        // reserves the time after the previous waiter), so only calls keyed together from a free channel collide.
        const free = Math.max(busyUntil, ctx.frequencyReserved.get(key)?.end ?? 0);
        e.keyedAtSec = staggered(ctx, ac, e.frequencyMhz, free + WAIT_GAP_SEC + seeded01(ac.seed, `wait:${e.id}`) * WAIT_SPREAD_SEC, R.blockWindowSec, `waitstagger:${e.id}`);
        e.emitAtSec = e.keyedAtSec + R.blockWindowSec;
        const done = e.emitAtSec + speechDurationSec(e.text);
        reserveChannel(ctx, key, e.keyedAtSec, R.blockWindowSec, speechDurationSec(e.text));
        getRuntime(ctx, ac).radioFreeAtSec = Math.max(getRuntime(ctx, ac).radioFreeAtSec, done);
        continue;
      }
    }
    ctx.scheduledSpeech = ctx.scheduledSpeech.filter((x) => x !== e);
    speakNow(ctx, ac, e.text, e.data, e.frequencyMhz);
  }
}

/**
 * A pilot who has queued a call of his own and finds that the controller has just called someone waits for that answer (as the pilot of a call
 * queued afterwards does in `pilotSay`). This runs for every queued call before any is emitted: an answer that is due earlier must not be
 * blocked by a call that would have waited for it.
 */
function deferForAnswerWindows(ctx: SimContext): void {
  for (const e of ctx.scheduledSpeech) {
    if (e.answer) continue;
    const aw = ctx.answerWindow.get(freqKey(e.frequencyMhz));
    const ac = ctx.state.aircraft[e.aircraftId];
    if (!aw || !ac || e.keyedAtSec < aw.from - 1e-9 || e.keyedAtSec >= aw.end) continue;
    const R = ctx.pilotBehaviour.realism;
    e.keyedAtSec = staggered(ctx, ac, e.frequencyMhz, aw.end + WAIT_GAP_SEC + seeded01(ac.seed, `answerwait:${e.id}`) * WAIT_SPREAD_SEC, R.blockWindowSec, `answerstagger:${e.id}`);
    e.emitAtSec = e.keyedAtSec + R.blockWindowSec;
    reserveChannel(ctx, freqKey(e.frequencyMhz), e.keyedAtSec, R.blockWindowSec, speechDurationSec(e.text));
  }
}

/** Extra clearance beyond the block window between the key-up moments of two self-started calls. DESIGN VALUE. */
const STAGGER_MARGIN_SEC = 0.3;
function staggered(ctx: SimContext, ac: Aircraft, freqMhz: number, t0: number, windowSec: number, label: string): number {
  let t = t0;
  for (let pass = 0; pass < 20; pass++) {
    const clash = ctx.scheduledSpeech.find((x) => x.aircraftId !== ac.id && Math.abs(x.frequencyMhz - freqMhz) < 0.0005 && Math.abs(x.keyedAtSec - t) < windowSec + STAGGER_MARGIN_SEC);
    if (!clash) break;
    t = clash.keyedAtSec + windowSec + STAGGER_MARGIN_SEC + seeded01(ac.seed, `${label}:${pass}`) * WAIT_SPREAD_SEC;
  }
  return t;
}

/**
 * A pilot who was blocked has heard the squeal and knows the channel is crowded: he lets the calls already queued go first and picks a moment that
 * is not within `windowSec` + `RETRY_CLEARANCE_SEC` of another queued call on the frequency. DESIGN VALUE (the hold-off after a block).
 */
const RETRY_CLEARANCE_SEC = 0.5;
function clearOfQueued(ctx: SimContext, freqMhz: number, t0: number, windowSec: number): number {
  let t = t0;
  for (let pass = 0; pass < 20; pass++) {
    const clash = ctx.scheduledSpeech.find((x) => Math.abs(x.frequencyMhz - freqMhz) < 0.0005 && x.keyedAtSec < t + windowSec + RETRY_CLEARANCE_SEC && x.keyedAtSec + windowSec + RETRY_CLEARANCE_SEC > t);
    if (!clash) break;
    t = clash.keyedAtSec + windowSec + speechDurationSec(clash.text) + WAIT_GAP_SEC;
  }
  return t;
}

/** Garble every call in the group and schedule the retries. */
function blockGroup(ctx: SimContext, group: ScheduledSpeech[]): void {
  const R = ctx.pilotBehaviour.realism;
  const now = ctx.state.clock.timeSec;
  const members = [...group].sort((a, b) => a.keyedAtSec - b.keyedAtSec || a.id - b.id);
  const acs = members.map((m) => ctx.state.aircraft[m.aircraftId]);
  ctx.scheduledSpeech = ctx.scheduledSpeech.filter((x) => !group.includes(x));
  const freq = members[0].frequencyMhz;
  const callsigns = acs.map((a) => a.callsign);
  const delays = members.map((m, i) => R.blockRetryMinSec + seeded01(acs[i].seed, `retry:${m.attempt}:${m.id}`) * R.blockRetrySpreadSec);
  const order = delays.map((d, i) => [d, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const retryAt: number[] = Array.from({ length: members.length }, () => 0);
  const rkey = freqKey(freq);
  let prev = -Infinity;
  for (const [d, i] of order) {
    // each pilot retries after the others who are already queued on the channel (he listens first)
    const t = clearOfQueued(ctx, freq, Math.max(now + d, prev + R.blockWindowSec + 0.4, (ctx.frequencyReserved.get(rkey)?.end ?? 0) + WAIT_GAP_SEC), R.blockWindowSec);
    retryAt[i] = t;
    prev = t;
    reserveChannel(ctx, rkey, t, R.blockWindowSec, speechDurationSec(members[i].text));
  }
  ctx.frequencyUse.set(freqKey(freq), now + BLOCKED_SQUEAL_SEC);
  const ev = emitEvent(ctx, {
    kind: 'RADIO_BLOCKED', aircraftId: acs[0].id, callsign: acs[0].callsign, severity: 'info', speaker: 'SYSTEM', frequencyMhz: freq,
    text: `[blocked] ${callsigns.join(' and ')} transmitted at the same time on ${freq.toFixed(3)}; they will try again`,
    data: {
      callsigns, aircraftIds: acs.map((a) => a.id), retryAtSec: retryAt.map((t) => Math.round(t * 10) / 10),
      /** per call: an answer to the controller (readback...) or a call the pilot started himself */
      answers: members.map((m) => RESPONSE_FLAGS.some((f) => m.data?.[f])),
      texts: members.map((m) => m.text),
      keyedAtSec: members.map((m) => Math.round(m.keyedAtSec * 10) / 10),
    },
  });
  ctx.onPilotTransmission?.({ aircraftId: acs[0].id, callsign: acs[0].callsign, text: '[blocked]', frequencyMhz: freq, voiceId: acs[0].voiceId, event: ev, blocked: true });
  members.forEach((m, i) => {
    const rt = getRuntime(ctx, acs[i]);
    // A blocked request was never heard: the badge stays off until the retry is on the air (`speakNow` clears this).
    markBlockedRequest(acs[i], m);
    const next: ScheduledSpeech = { ...m, id: ++ctx.speechSeq, keyedAtSec: retryAt[i], emitAtSec: retryAt[i] + R.blockWindowSec, attempt: m.attempt + 1 };
    ctx.scheduledSpeech.push(next);
    acs[i].radioState = 'TRANSMITTING';
    rt.radioFreeAtSec = Math.max(rt.radioFreeAtSec, next.emitAtSec + speechDurationSec(m.text));
  });
}

