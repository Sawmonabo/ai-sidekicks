// What a run's steps say beyond their own fields: which execution came last, which pass of its
// node a step belongs to, and whether a wait needs a person. The header, the step panel, the
// status chip and the graph all ask, so each rule is written once here.

import type {
  WorkflowStepStatus,
  WorkflowWaitCause,
} from "@ai-sidekicks/contracts/workflow/run/status";
import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step";

/** One of a node's step records, and the pass of the node it belongs to. */
export interface NodePass {
  readonly step: WorkflowStep;
  /** One-based: a loop's third pass is `3`, whatever attempts that pass took. */
  readonly pass: number;
}

/**
 * Whether a wait needs a person to answer it, which is what turns it amber. A spent account
 * resumes by itself, so it is the one cause that needs nobody.
 */
export function isPersonWaitCause(cause: WorkflowWaitCause | undefined): boolean {
  return cause !== undefined && cause !== "account";
}

/** Whether `step` ran after `current` by execution order; anything is later than nothing. */
export function isLaterStep(step: WorkflowStep, current: WorkflowStep | undefined): boolean {
  return current === undefined || step.executionIndex > current.executionIndex;
}

/** The latest execution of any node in this state, by execution order. */
export function latestStepWith(
  steps: readonly WorkflowStep[],
  status: WorkflowStepStatus,
): WorkflowStep | undefined {
  let latest: WorkflowStep | undefined;
  for (const step of steps) {
    if (step.status === status && isLaterStep(step, latest)) {
      latest = step;
    }
  }
  return latest;
}

/**
 * A node's step records in execution order, each with its pass. A first attempt opens a pass and
 * a retry stays in the pass it retried, so `run 3` names the loop's third pass and `attempt 2`
 * the retry within it.
 */
export function nodePasses(steps: readonly WorkflowStep[], nodeId: string): readonly NodePass[] {
  const records = steps
    .filter((step) => step.nodeId === nodeId)
    .sort((left, right) => left.executionIndex - right.executionIndex);
  let pass = 0;
  return records.map((step) => {
    if (step.attempt === 1 || pass === 0) {
      pass += 1;
    }
    return { step, pass };
  });
}
