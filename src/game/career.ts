/**
 * Career progress persistence. Stored as JSON under localStorage key `kacy.career`; every access is guarded so the
 * module also works in Node (tests), private windows and when storage is full or blocked (progress then lives in memory).
 */
import type { SimulationState } from '../sim/types';
import type { CareerProgress, DebriefReport } from './index';
import { allObjectivesDone } from './objectives';

export const CAREER_STORAGE_KEY = 'kacy.career';
export const CAREER_STEPS = 12;

const memory: { value?: CareerProgress } = {};

function storage(): Storage | undefined {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s ?? undefined;
  } catch {
    return undefined;
  }
}

export function freshProgress(): CareerProgress {
  return { completedSteps: [], bestScores: {}, unlockedStep: 1 };
}

function sanitize(raw: unknown): CareerProgress {
  const p = freshProgress();
  if (!raw || typeof raw !== 'object') return p;
  const r = raw as Partial<CareerProgress>;
  if (Array.isArray(r.completedSteps)) {
    p.completedSteps = [...new Set(r.completedSteps.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= CAREER_STEPS))].sort((a, b) => a - b);
  }
  if (r.bestScores && typeof r.bestScores === 'object') {
    for (const [k, v] of Object.entries(r.bestScores)) if (typeof v === 'number' && Number.isFinite(v)) p.bestScores[k] = v;
  }
  const highest = p.completedSteps.length ? Math.max(...p.completedSteps) : 0;
  const stored = typeof r.unlockedStep === 'number' && Number.isInteger(r.unlockedStep) ? r.unlockedStep : 1;
  p.unlockedStep = Math.min(CAREER_STEPS, Math.max(1, stored, highest + 1));
  return p;
}

export function loadCareerProgress(): CareerProgress {
  const s = storage();
  if (s) {
    let text: string | null;
    try {
      text = s.getItem(CAREER_STORAGE_KEY);
    } catch {
      text = undefined as never; // storage blocked: use the in-memory copy below
    }
    if (text !== (undefined as never)) {
      try {
        return (memory.value = text ? sanitize(JSON.parse(text)) : freshProgress());
      } catch {
        return (memory.value = freshProgress()); // corrupt JSON: start over
      }
    }
  }
  return memory.value ? sanitize(memory.value) : freshProgress();
}

/** Career step (1..12) of a scenario id like "career-03-single-landing", else undefined. */
export function careerStepOf(scenarioId: string): number | undefined {
  const m = /^career-(\d{2})-/.exec(scenarioId);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= CAREER_STEPS ? n : undefined;
}

export function passed(grade: DebriefReport['grade']): boolean {
  return grade === 'A' || grade === 'B' || grade === 'C';
}

/** Record a finished session. Best score is kept for every scenario; a career step is completed (and the next one unlocked) when the debrief says completed with grade C or better. */
export function saveCareerResult(scenarioId: string, report: DebriefReport): CareerProgress {
  const p = loadCareerProgress();
  const score = Math.round(report.score.score);
  p.bestScores[scenarioId] = Math.max(p.bestScores[scenarioId] ?? 0, score);
  const step = careerStepOf(scenarioId);
  if (step !== undefined && report.completed && passed(report.grade)) {
    if (!p.completedSteps.includes(step)) p.completedSteps = [...p.completedSteps, step].sort((a, b) => a - b);
    p.unlockedStep = Math.min(CAREER_STEPS, Math.max(p.unlockedStep, step + 1));
  }
  memory.value = p;
  const s = storage();
  if (s) {
    try {
      s.setItem(CAREER_STORAGE_KEY, JSON.stringify(p));
    } catch {
      /* quota / blocked: memory copy remains */
    }
  }
  return p;
}

/** All objectives done (ignoring guard objectives alone), the scenario duration elapsed, or the engine flagged completion. */
export function isScenarioComplete(state: SimulationState): boolean {
  const sc = state.scenario;
  if (allObjectivesDone(state)) return true;
  if (sc.durationSec !== undefined && state.clock.timeSec >= sc.durationSec) return true;
  return sc.mode !== 'free_play' && state.score.scenarioCompleted;
}
