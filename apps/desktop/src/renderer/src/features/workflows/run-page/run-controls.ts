// The run controls' vocabulary: the two actions, what a dispatched act can have got to, and the
// one refusal the controls raise themselves. Eligibility is never computed here: a control is
// always offered and the daemon's answer lands on `WorkflowRunControlOutcome`. The refusal is
// raised before a call, not instead of one.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import type { WorkflowRunState } from "../runs/run-list-rows.js";

/**
 * The two run controls, and exactly two.
 *
 * Separately grantable, so enumerated rather than implied by the props. The union derives
 * from the tuple.
 */
export const WORKFLOW_RUN_CONTROL_ACTIONS = ["cancel", "resume"] as const;

/** One run control. Derived from the tuple, never restated. */
export type WorkflowRunControlAction = (typeof WORKFLOW_RUN_CONTROL_ACTIONS)[number];

/** The subsystem name every refusal raised in this file carries. */
export const WORKFLOW_RUN_CONTROL_ORIGIN = "workflow-run-control";

/**
 * The refusal the run controls raise on their own, with no daemon in the loop: a press that
 * duplicates one already outstanding.
 */
export type WorkflowRunControlRefusalCode = "act-already-in-flight";

/** What a served `workflow.runCancel` answers with. */
export interface WorkflowRunCancelReply {
  readonly workflowRunId: string;
  readonly state: Extract<WorkflowRunState, "canceled">;
  readonly canceledEventId: string;
  readonly alreadyCanceled: boolean;
}

/** What a served `workflow.runResume` answers with. */
export interface WorkflowRunResumeReply {
  readonly workflowRunId: string;
  readonly state: Extract<WorkflowRunState, "running" | "suspended">;
  readonly repinnedFromWorkflowVersionId?: string;
  readonly repinnedToWorkflowVersionId?: string;
}

/** Every run state either control's served reply can report, and no others. */
export type WorkflowRunControlRunState =
  | WorkflowRunCancelReply["state"]
  | WorkflowRunResumeReply["state"];

/**
 * Where one control's dispatched act has got to, for the run it was pressed on.
 *
 * `idle` is not success and `dispatching` is not a settlement. There is no optimistic arm: a
 * refused act leaves the run on screen as it was, with the reason beside the control.
 */
export type WorkflowRunControlOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "dispatching" }
  | {
      readonly kind: "settled";
      /** The run state the reply answered with, wire-verbatim and never paraphrased. */
      readonly runState: WorkflowRunControlRunState;
      /** What that state means for the person, in this console's own words. */
      readonly detail: string;
    }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/** The outcome a control stands at before anything has been pressed on this run. */
export const IDLE_RUN_CONTROL_OUTCOME: WorkflowRunControlOutcome = { kind: "idle" };

/**
 * The state a resume answers with when the run re-parks on its next dispatch.
 *
 * Annotated with the derived union, so a word this reply cannot answer with fails to compile.
 */
export const WORKFLOW_RUN_RE_PARKED_STATE: WorkflowRunControlRunState = "suspended";

/** What each action is called where a person reads a sentence about it. */
const ACTION_PROSE: Readonly<Record<WorkflowRunControlAction, string>> = {
  cancel: "Canceling a run",
  resume: "Resuming a run",
};

/**
 * One version a resume may re-pin onto, as the caller resolved it from the chain.
 *
 * @consumedBy the run header's pinned-version chip
 */
export interface WorkflowVersionChoice {
  /** Opaque and wire-verbatim. Passed through, never parsed. */
  readonly workflowVersionId: string;
  /** What a person reads instead of the id — the caller's, never derived here. */
  readonly label: string;
  /** True for the version the run is pinned to now. */
  readonly isCurrentPin: boolean;
}

/**
 * The re-pin a resume carries, when it carries one.
 *
 * A resume re-pins onto a version the person named or not at all. There is no "latest": a
 * server-resolved one would race the definition's edits and leave the audited pair unverifiable.
 */
export interface WorkflowVersionRepin {
  readonly targetWorkflowVersionId: string;
}

/** What a cancel control is: the call, and where the last press of it got to. */
export interface WorkflowCancelControl {
  /** `undefined` when the person gave no reason, which is a legal cancel. */
  readonly cancel: (reason: string | undefined) => void;
  readonly outcome: WorkflowRunControlOutcome;
}

/**
 * What a resume control's dispatcher composes: the call, and where the last press got to.
 *
 * Separate from the control below because the chain is a second read addressed by the version
 * in the run snapshot, whose round is this dispatcher's output. Joined where the control mounts.
 */
export interface WorkflowResumeDispatch {
  readonly resume: (repin: WorkflowVersionRepin | undefined) => void;
  readonly outcome: WorkflowRunControlOutcome;
}

/**
 * The refusal a second press earns while the first call is still outstanding.
 *
 * Refused, never queued (it would act on a run the first call has moved) or dropped (a button
 * that seems broken). It says "in flight", not "denied": no question went to a daemon.
 */
export function actAlreadyInFlightRefusal(action: WorkflowRunControlAction): Refusal {
  const code: WorkflowRunControlRefusalCode = "act-already-in-flight";
  return refuse(
    WORKFLOW_RUN_CONTROL_ORIGIN,
    code,
    `${ACTION_PROSE[action]} is already in flight for this run. Wait for the answer; a second press is not queued.`,
  );
}
