// The one-line past-tense receipts a person's answer, or a wait on a person reaching its
// `Timeout`, leaves where its controls stood, read from the record the daemon keeps, so a receipt
// reads the same after a reload. There is no way back from one.

import type { WorkflowNodeKindId } from "@ai-sidekicks/contracts/workflow/definition/document";
import { WORKFLOW_STEP_TIMED_OUT_CODE } from "@ai-sidekicks/contracts/workflow/run/failures";
import type {
  WorkflowStep,
  WorkflowStepResolution,
  WorkflowStepResolutionKind,
} from "@ai-sidekicks/contracts/workflow/run/step/record";
import type { WorkflowChainQuestion } from "@ai-sidekicks/contracts/workflow/run/records";

import type { FigureSentencePart } from "#renderer/lib/figure-sentence.js";
import { formatCount } from "#renderer/lib/wire/figures.js";

const RESOLUTION_VERBS: Readonly<Record<WorkflowStepResolutionKind, string>> = {
  approved: "Approved",
  rejected: "Rejected",
  answered: "Answered",
  declined: "Declined",
};

/** A step's receipt: its words and the instant they end on, drawn `Approved at 2:14 PM`. */
export interface StepReceipt {
  readonly words: string;
  /** The instant, as a stamp the day clock reads. */
  readonly at: string;
}

/** A step's receipt from the record of how it was answered: `Approved at` and when. */
export function resolutionReceipt(resolution: WorkflowStepResolution): StepReceipt {
  return { words: `${RESOLUTION_VERBS[resolution.kind]} at`, at: resolution.at };
}

/** The node kinds whose step waits on a person: an approval, a form and a chat reply. */
const PERSON_WAIT_KINDS: ReadonlySet<WorkflowNodeKindId> = new Set([
  "human.approval",
  "human.form",
  "human.wait-for-chat-reply",
]);

/** Whether a step of this node kind waits on a person, so its `Timeout` ends a wait. */
export function isPersonWaitKind(kind: WorkflowNodeKindId): boolean {
  return PERSON_WAIT_KINDS.has(kind);
}

/**
 * The receipt a wait on a person leaves when its `Timeout` cut it: `Timed out at` and when.
 * `undefined` for any other step, since a command or an agent step that ran out of time was
 * never waiting on anyone; `nodeKind` is the step's node's kind, once the version is read.
 */
export function timedOutReceipt(
  step: WorkflowStep,
  nodeKind: WorkflowNodeKindId | undefined,
): StepReceipt | undefined {
  const isPersonWait = nodeKind !== undefined && isPersonWaitKind(nodeKind);
  return isPersonWait &&
    step.error?.code === WORKFLOW_STEP_TIMED_OUT_CODE &&
    step.finishedAt !== undefined
    ? { words: "Timed out at", at: step.finishedAt }
    : undefined;
}

/**
 * The chain question's receipt: `Kept going at 100 runs` or `Stopped at 100 runs`, the daemon's
 * count as a wire figure.
 */
export function chainReceipt(
  answered: Extract<WorkflowChainQuestion, { state: "answered" }>,
): readonly FigureSentencePart[] {
  const verb = answered.decision === "approved" ? "Kept going" : "Stopped";
  return [`${verb} at `, { wire: formatCount(answered.runCount) }, " runs"];
}
