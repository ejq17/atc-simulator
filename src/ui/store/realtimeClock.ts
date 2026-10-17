/**
 * Wall-clock synchronisation of one engine (real-time mode). Framework-free; the session's frame loop calls `frame(nowMs)`.
 *
 * The engine itself is unchanged: it still advances in fixed `dtSec` steps via `advance(wallSec)`. What changes is how the
 * session decides `wallSec`. In sim-speed mode that is the frame delta (as before). In LIVE mode it is the *deficit* between
 * the real time elapsed since the clock was locked (`performance.now`) and the time already fed to the engine, so
 * frame-rate jitter, long frames and the old 0.25 s per-frame clamp can never accumulate drift: the engine has always been
 * advanced by exactly `now - lockedAt` (less the sub-step remainder, which is below one `dtSec` and does not accumulate).
 *
 * Modes (`status().mode`):
 *   live    speed 1, locked to the wall clock. The sim's UTC epoch is kept equal to the real UTC.
 *   sim     the user chose 2x/4x (the lock is released). Sim time runs at that multiple.
 *   paused  speed 0. The lock intent is kept: resuming at 1x re-locks.
 * `setSpeed(1)` (and resuming from a pause into 1x) re-locks: the anchor is re-based to now and the UTC epoch is moved so
 * that `epoch + timeSec` equals the real UTC again (aircraft are untouched; only the clock labels / sunrise maths shift).
 */
import type { SimulationEngine } from '../../sim/api';
import { setSimulationEpoch } from '../../sim/solar';

export type ClockMode = 'live' | 'sim' | 'paused';

export interface RealtimeClockOptions {
  engine: SimulationEngine;
  /** Monotonic ms clock (default `performance.now`). */
  now?: () => number;
  /** Real UTC ms (default `Date.now`). */
  wallUtcMs?: () => number;
  /** UTC ms of scenario time 0 at creation (default: real UTC now minus the engine's elapsed time). Tests pass a fixed date. */
  startUtcMs?: number;
  /** Real-time mode on. Off = the clock just forwards the frame delta times the speed (the pre-existing behaviour). */
  realTime: boolean;
  /** Most sim seconds fed per frame while catching up a deficit (default 10 = 100 ticks). */
  maxCatchUpSecPerFrame?: number;
  /** A deficit above this (a backgrounded tab, a debugger pause) is dropped instead of replayed (default 300 s). */
  resyncGapSec?: number;
  /** Called with the dropped gap (s) when the resync rule fires. */
  onResync?(gapSec: number): void;
}

export interface ClockStatus {
  mode: ClockMode;
  /** Sim speed multiplier currently set on the engine. */
  speed: number;
  realTime: boolean;
  /** Real seconds the engine is behind the wall clock right now (live mode only; 0 otherwise). Near 0 when healthy. */
  lagSec: number;
}

export interface RealtimeClock {
  /** Advance the engine for this animation frame (`t` = monotonic ms, same clock as `now`). */
  frame(t: number): void;
  /** 0 pauses; 1 locks to the wall clock (real-time mode); anything else releases the lock. */
  setSpeed(speed: number): void;
  status(): ClockStatus;
  /** Real UTC ms of scenario time 0 (the first segment; later re-locks add segments, see `utcAt`). */
  utcStartMs(): number;
  /** UTC ms of a past or present sim time. Re-locking (resume, 1x) moves the epoch, so each segment keeps its own. */
  utcAt(simSec: number): number;
}

export function createRealtimeClock(o: RealtimeClockOptions): RealtimeClock {
  const { engine } = o;
  const now = o.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const wallUtc = o.wallUtcMs ?? (() => Date.now());
  const maxCatchUp = o.maxCatchUpSecPerFrame ?? 10;
  const resyncGap = o.resyncGapSec ?? 300;

  let lockIntent = o.realTime; // false once the user picks 2x / 4x
  let anchorMs = now(); // monotonic time at which the lock was (re)established
  let fedSec = 0; // sim seconds fed to the engine since the anchor
  let lastFrame = anchorMs;
  let epoch = o.startUtcMs ?? wallUtc() - engine.getState().clock.timeSec * 1000;
  setSimulationEpoch(engine.getState(), epoch);
  /** Epoch segments: from `fromSec` on, UTC = epoch + sec * 1000. */
  const segments: { fromSec: number; epoch: number }[] = [{ fromSec: engine.getState().clock.timeSec, epoch }];

  const speed = () => engine.getState().clock.speed;
  const locked = () => lockIntent && speed() === 1;

  const relock = (t: number) => {
    anchorMs = t;
    fedSec = 0;
    const sec = engine.getState().clock.timeSec;
    epoch = wallUtc() - sec * 1000;
    setSimulationEpoch(engine.getState(), epoch);
    segments.push({ fromSec: sec, epoch });
  };

  return {
    frame(t) {
      const delta = Math.max(0, (t - lastFrame) / 1000);
      lastFrame = t;
      if (!locked()) {
        // Pre-existing behaviour: wall delta, clamped so a stalled tab does not fast-forward; the engine multiplies by its speed.
        engine.advance(Math.min(0.25, delta));
        return;
      }
      const deficit = (t - anchorMs) / 1000 - fedSec;
      if (deficit > resyncGap) {
        o.onResync?.(deficit);
        relock(t);
        return;
      }
      if (deficit <= 0) return;
      const feed = Math.min(deficit, maxCatchUp);
      engine.advance(feed); // speed is 1 here, so the engine consumes exactly `feed` sim seconds
      fedSec += feed;
    },
    setSpeed(next) {
      const before = speed();
      engine.setSpeed(next);
      const t = now();
      if (next === 1 && o.realTime) {
        lockIntent = true;
        // Re-lock whenever the lock was not running (resume from a pause, or coming back from 2x/4x). A no-op 1x click keeps the anchor.
        if (before !== 1) relock(t);
      } else if (next > 1) {
        lockIntent = false;
      }
      lastFrame = t;
    },
    status() {
      const sp = speed();
      const mode: ClockMode = sp <= 0 ? 'paused' : locked() ? 'live' : 'sim';
      const lagSec = mode === 'live' ? Math.max(0, (now() - anchorMs) / 1000 - fedSec) : 0;
      return { mode, speed: sp, realTime: o.realTime, lagSec };
    },
    utcStartMs: () => segments[0].epoch,
    utcAt(simSec) {
      for (let i = segments.length - 1; i >= 0; i--) if (simSec >= segments[i].fromSec || i === 0) return segments[i].epoch + simSec * 1000;
      return epoch + simSec * 1000;
    },
  };
}
