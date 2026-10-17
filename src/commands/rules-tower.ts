import { applyRunway, cmdHit, makeDraft, type Draft, type Rule } from './draft';
import { runwayAfter } from './entities';
import { seq, type Toks } from './match';

function withRunway(d: Draft, t: Toks, at: number): number {
  const r = runwayAfter(t, at);
  if (!r) return at;
  if (r.ok) applyRunway(d, r.ref); else { d.issues.push(r.reason); d.unknownIds++; }
  return r.next;
}

/** "cleared for takeoff [runway N]" (STT: "take off", "clear for") */
export const ruleTakeoff: Rule = (t, i) => {
  const j = seq(t, i, 'cleared|clear for|to? the? immediate|immediately? takeoff');
  if (j < 0) return null;
  const d = makeDraft('TAKEOFF');
  return cmdHit(withRunway(d, t, j), d);
};

const LAND_FORMS: readonly { pattern: string; destination?: string }[] = [
  { pattern: 'land' },
  { pattern: 'option', destination: 'option' },
  { pattern: 'touch and go', destination: 'touch_and_go' },
  { pattern: 'touch go', destination: 'touch_and_go' },
  { pattern: 'stop and go', destination: 'stop_and_go' },
  { pattern: 'a? low approach', destination: 'low_approach' },
];

/** "cleared to land", "cleared for the option", touch-and-go, low approach */
export const ruleLand: Rule = (t, i) => {
  for (const form of LAND_FORMS) {
    const j = seq(t, i, `cleared|clear for|to? the? ${form.pattern}`);
    if (j < 0) continue;
    const d = makeDraft('LAND', form.destination ? { destination: form.destination } : {});
    return cmdHit(withRunway(d, t, j), d);
  }
  return null;
};

export const ruleGoAround: Rule = (t, i) => {
  const j = seq(t, i, 'go around');
  return j < 0 ? null : cmdHit(j, makeDraft('GO_AROUND'));
};

/** "continue [approach] [expect late landing clearance]" */
export const ruleContinue: Rule = (t, i) => {
  let j = seq(t, i, 'continue approach? straight? in?');
  if (j < 0) return null;
  if (seq(t, i, 'continue taxi') >= 0) return null;
  const e = seq(t, j, 'expect late|early? landing clearance');
  if (e >= 0) j = e;
  return cmdHit(j, makeDraft('CONTINUE_APPROACH'));
};

/** "pushback [and start] approved" */
export const rulePushback: Rule = (t, i) => {
  const j = seq(t, i, 'pushback|push and? start? approved?');
  return j < 0 ? null : cmdHit(j, makeDraft('PUSHBACK'));
};
