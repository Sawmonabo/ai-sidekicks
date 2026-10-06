// The one-line past-tense receipts a person's answer, or a wait on a person reaching its
// `Timeout`, leaves where its controls stood, read from the record the daemon keeps, so a receipt
// reads the same after a reload. There is no way back from one.

import type { WorkflowNodeKindId } from "@ai-sidekicks/contracts/workflow/definition/document";
import { WORKFLOW_STEP_TIMED_OUT_CODE } from "@ai-sidekicks/contracts/workflow/run/failures";
import {
  type WorkflowStep,
  type WorkflowStepResolution,
  type WorkflowStepResolutionKind,
} from "@ai-sidekicks/contracts/workflow/run/step/record";
import type { WorkflowChainQuestion } from "@ai-sidekicks/contracts/workflow/run/records";

import { formatCount, formatDayClock, formatDayClockAt } from "#renderer/lib/wire/figures.js";

const RESOLUTION_VERBS: Readonly<Record<WorkflowStepResolutionKind, string>> = {
  approved: "Approved",
  rejected: "Rejected",
  answered: "Answered",
  declined: "Declined",
};

/**
 * A step's receipt from the record of how it was answered: `Approved at 2:14 PM`, with the day in
 * front when it was not the day of `nowMs`.
 */
export function resolutionReceipt(resolution: WorkflowStepResolution, nowMs: number): string {
  return `${RESOLUTION_VERBS[resolution.kind]} at ${formatDayClock(resolution.at, nowMs)}`;
}

/**
 * The receipt for an answer this window just took, at the instant its own clock reads, for an
 * answer whose record carries none: `Answered at 2:14 PM`.
 */
export function receiptNow(kind: WorkflowStepResolutionKind, nowMs: number): string {
  return `${RESOLUTION_VERBS[kind]} at ${formatDayClockAt(nowMs, nowMs)}`;
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
 * The receipt a wait on a person leaves when its `Timeout` cut it: `Timed out at 6:00 AM`.
 * `undefined` for any other step, since a command or an agent step that ran out of time was
 * never waiting on anyone; `nodeKind` is the step's node's kind, once the version is read, and
 * `nowMs` the instant the day is counted from.
 */
export function timedOutReceipt(
  step: WorkflowStep,
  nodeKind: WorkflowNodeKindId | undefined,
  nowMs: number,
): string | undefined {
  const isPersonWait = nodeKind !== undefined && isPersonWaitKind(nodeKind);
  return isPersonWait &&
    step.error?.code === WORKFLOW_STEP_TIMED_OUT_CODE &&
    step.finishedAt !== undefined
    ? `Timed out at ${formatDayClock(step.finishedAt, nowMs)}`
    : undefined;
}

/** The chain question's receipt: `Kept going at 100 runs` or `Stopped at 100 runs`. */
export function chainReceipt(
  answered: Extract<WorkflowChainQuestion, { state: "answered" }>,
): string {
  const verb = answered.decision === "approved" ? "Kept going" : "Stopped";
  return `${verb} at ${formatCount(answered.runCount)} runs`;
}
