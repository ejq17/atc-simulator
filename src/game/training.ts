/**
 * Training controller: walks the player through `scenario.training.steps`.
 *
 * A step is completed when
 *   - `onCommand` reports an *accepted* outcome whose kind equals `expectCommand` (and whose callsign equals the step's
 *     `callsign`, when the step names one), or
 *   - a state predicate passes: the step's `check` (objective-check string, see objectives.ts), or the equivalent
 *     accepted command is already in the event log (`cmd:KIND:CALLSIGN`), which makes the controller robust if the
 *     UI forgets to forward an outcome.
 * Rejected / clarify outcomes of the expected kind or for the step's aircraft set the step to `error` and put the
 * step's explanation (the why) into `lastFeedback`.
 *
 * Steps without `expectCommand` are "wait" steps and complete only through their `check`.
 */
import type { Scenario, SimulationState } from '../sim/types';
import type { TrainingController, TrainingStepState } from './index';
import { evaluateCheck } from './objectives';
import { TRAINING_DISCLAIMER } from './references';
import type { TrainingStepSpec } from './types';

type Outcome = Parameters<TrainingController['onCommand']>[0];

function describeStep(spec: TrainingStepSpec): { prompt: string; explanation: string } {
  const prompt = spec.example ? `${spec.prompt} Example: "${spec.example}"` : spec.prompt;
  const mistakes = spec.mistakes?.length ? `\nCommon mistakes:\n${spec.mistakes.map((m) => `- ${m}`).join('\n')}` : '';
  return { prompt, explanation: `${spec.explanation}${mistakes}` };
}

export function createTrainingController(scenario: Scenario): TrainingController | null {
  const steps = ((scenario as { training?: { steps: TrainingStepSpec[] } }).training?.steps ?? []) as TrainingStepSpec[];
  if (!steps.length) return null;

  let index = 0;
  let status: TrainingStepState['status'] = 'active';
  let lastFeedback: string | undefined;

  const stateFor = (i: number): TrainingStepState => {
    if (i >= steps.length) {
      return {
        index: steps.length, total: steps.length, id: 'complete', status: 'done',
        prompt: 'Training complete. Review the debrief, then try the next lesson or a career step.',
        explanation: `You finished every step of this lesson. ${TRAINING_DISCLAIMER}`,
        lastFeedback,
      };
    }
    const spec = steps[i];
    const d = describeStep(spec);
    return {
      index: i, total: steps.length, id: spec.id, prompt: d.prompt, explanation: d.explanation, reference: spec.reference,
      status: i < index ? 'done' : i === index ? status : 'pending', lastFeedback: i === index ? lastFeedback : undefined,
    };
  };

  const advance = (feedback: string): void => {
    index++;
    status = 'active';
    lastFeedback = feedback;
  };

  const sameCallsign = (spec: TrainingStepSpec, cs: string | null | undefined): boolean =>
    !spec.callsign || (!!cs && cs.toUpperCase() === spec.callsign.toUpperCase());

  const stepSatisfied = (spec: TrainingStepSpec, state: SimulationState): boolean => {
    if (spec.check && evaluateCheck(state, spec.check)) return true;
    if (spec.expectCommand && spec.callsign && evaluateCheck(state, `cmd:${spec.expectCommand}:${spec.callsign}`)) return true;
    return false;
  };

  return {
    update(state) {
      // A later step's condition may already hold (the player was ahead of the script); skip through them.
      while (index < steps.length && stepSatisfied(steps[index], state)) {
        advance(`Done: ${steps[index].id.replace(/-/g, ' ')}.`);
      }
      return stateFor(index);
    },

    onCommand(outcome: Outcome) {
      if (index >= steps.length) return;
      const spec = steps[index];
      if (outcome.reason?.startsWith('Duplicate command ignored')) return;
      const kindMatches = !!spec.expectCommand && outcome.kind === spec.expectCommand;
      const csMatches = sameCallsign(spec, outcome.callsign) && !!spec.callsign && !!outcome.callsign;

      if (outcome.status === 'accepted') {
        if (kindMatches && sameCallsign(spec, outcome.callsign)) {
          advance(`Correct. ${spec.explanation}`);
        } else {
          // Accepted but not what the step is about: guidance, not an error.
          status = 'active';
          lastFeedback = kindMatches
            ? `That went to the wrong aircraft. This step is about ${spec.callsign}.`
            : `That instruction was accepted, but this step asks for something else: ${spec.prompt}`;
        }
        return;
      }

      if (kindMatches || csMatches) {
        const why = outcome.status === 'clarify'
          ? `The pilot could not act on that${outcome.reason ? `: ${outcome.reason}` : ''}. Say the callsign, the instruction and the runway clearly.`
          : `Not accepted${outcome.reason ? `: ${outcome.reason}` : ''}.`;
        status = 'error';
        const mistakes = spec.mistakes?.length ? ` Common mistakes: ${spec.mistakes.join(' ')}` : '';
        lastFeedback = `${why} Why it matters: ${spec.explanation}${mistakes}${spec.reference ? ` (${spec.reference})` : ''}`;
      } else {
        lastFeedback = `Not accepted${outcome.reason ? `: ${outcome.reason}` : ''}.`;
      }
    },

    current: () => stateFor(index),
    isComplete: () => index >= steps.length,
  };
}
