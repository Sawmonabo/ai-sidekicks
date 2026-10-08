// What each of a run's four controls and a row's `Delete run` may do in the run's current state,
// and the words each refuses in where it may not. Every control keeps its place whatever the
// state; one the state does not allow stands disabled with its reason beside it, rather than
// quietly not being there. These are the states the daemon's own refusals name, so a press the
// screen allows and the daemon still refuses shows the daemon's words instead.

import type { WorkflowRunStatus } from "@ai-sidekicks/contracts/workflow/run/status";
import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step/record";
import type {
  WorkflowRunReadResponse,
  WorkflowRunSummary,
} from "@ai-sidekicks/contracts/workflow/run/records";
import { GOING_RUN_STATUSES } from "@ai-sidekicks/contracts/workflow/run/status";

import { isLaterStep } from "./steps.js";

/** Whether a control may act now, or the sentence saying why not. */
export type RunControlAvailability =
  | { readonly kind: "allowed" }
  | { readonly kind: "refused"; readonly reason: string };

/** The three controls in a run's header. */
export type RunHeaderControl = "rerun" | "cancel" | "resume";

const ALLOWED: RunControlAvailability = { kind: "allowed" };

/** Whether a header control may act on this run. */
export function runHeaderControlAvailability(
  control: RunHeaderControl,
  run: WorkflowRunReadResponse,
): RunControlAvailability {
  switch (control) {
    case "rerun":
      // A new run of the pinned version can start beside any run, in any state.
      return ALLOWED;
    case "cancel":
      return cancelAvailability(run);
    case "resume":
      return resumeAvailability(run);
  }
}

/**
 * Whether `Retry from this step` may act on this step: only the latest execution of a node whose
 * step failed, on a run that is no longer going.
 */
export function retryAvailability(
  run: WorkflowRunReadResponse,
  step: WorkflowStep,
): RunControlAvailability {
  if (isGoing(run.status)) {
    return { kind: "refused", reason: "Retry · this run is still going" };
  }
  if (step.status !== "failed") {
    return { kind: "refused", reason: "Retry · this step did not fail" };
  }
  const isSuperseded = run.steps.some(
    (other) => other.nodeId === step.nodeId && isLaterStep(other, step),
  );
  return isSuperseded ? { kind: "refused", reason: "Retry · this step has a later run" } : ALLOWED;
}

/**
 * Whether a row's `Delete run` may act: a run still going, or a failed run parked on its failed
 * step, which carries no duration because it has not ended, is refused until it is canceled.
 */
export function deleteRunAvailability(run: WorkflowRunSummary): RunControlAvailability {
  const isParkedOnFailure = run.status === "failed" && run.durationMs === undefined;
  return isGoing(run.status) || isParkedOnFailure ? DELETE_REFUSED : ALLOWED;
}

/** Whether a run with this status is still going: new, running or waiting. */
export function isGoing(status: WorkflowRunStatus): boolean {
  return GOING_RUN_STATUSES.includes(status);
}

/**
 * Whether the run is parked, waiting to be resumed: a waiting run, or a failed run that has not
 * ended because it waits on its failed step.
 */
function isParked(run: WorkflowRunReadResponse): boolean {
  return run.status === "waiting" || (run.status === "failed" && run.finishedAt === undefined);
}

function cancelAvailability(run: WorkflowRunReadResponse): RunControlAvailability {
  return isGoing(run.status) || isParked(run) ? ALLOWED : CANCEL_REFUSED;
}

function resumeAvailability(run: WorkflowRunReadResponse): RunControlAvailability {
  return isParked(run) ? ALLOWED : RESUME_REFUSED;
}

/** Why `Cancel` cannot act on a run that has finished, canceled or not. */
const CANCEL_REFUSED: RunControlAvailability = {
  kind: "refused",
  reason: "Cancel · this run has already finished",
};

/** Why `Delete run` cannot act on a run a person can still resume or cancel. */
const DELETE_REFUSED: RunControlAvailability = { kind: "refused", reason: "Cancel it first." };

/** Why `Resume` cannot act on a run that is not parked, going or ended. */
const RESUME_REFUSED: RunControlAvailability = {
  kind: "refused",
  reason: "Resume · this run is not parked",
};
