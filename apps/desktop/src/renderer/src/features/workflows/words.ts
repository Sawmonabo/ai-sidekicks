// The words the workflows screens put on wire values: a run's status, a step's state, what a
// wait is on, how a run was started and who started it, and the labels its codes register. No
// wire spelling reaches the screen; each closed set is keyed by its contract's own union, so a
// value the contract adds fails to compile here until it has words.

import { PROVIDER_LABELS } from "@ai-sidekicks/contracts/provider/name";
import type {
  WorkflowRunStatus,
  WorkflowStepStatus,
  WorkflowWaitCause,
} from "@ai-sidekicks/contracts/workflow/run/status";
import type { WorkflowSpentAccount } from "@ai-sidekicks/contracts/workflow/run/step/record";
import type {
  WorkflowStartedBy,
  WorkflowTriggerKind,
} from "@ai-sidekicks/contracts/workflow/run/trigger";
import {
  WORKFLOW_SANDBOX_UNAVAILABLE_CODE,
  WORKFLOW_STEP_THREAD_FAILED_CODE,
  WORKFLOW_STEP_TIMED_OUT_CODE,
} from "@ai-sidekicks/contracts/workflow/run/failures";

import { formatCount } from "#renderer/lib/wire/figures.js";

/** A run's status as its chip reads it. */
export const RUN_STATUS_WORDS: Readonly<Record<WorkflowRunStatus, string>> = {
  new: "New",
  running: "Running",
  waiting: "Waiting",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
  crashed: "Crashed",
};

/** A step's state as its node's ring and the step panel read it. */
export const STEP_STATUS_WORDS: Readonly<Record<WorkflowStepStatus, string>> = {
  pending: "Idle",
  running: "Running",
  waiting: "Waiting",
  "waiting-memory": "Waiting for memory",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
  canceled: "Canceled",
};

/** What a waiting run or step waits on, as the header, the live line and a node's ring read it. */
export const WAIT_CAUSE_WORDS: Readonly<Record<WorkflowWaitCause, string>> = {
  approval: "your approval",
  form: "your answer",
  reply: "your reply",
  account: "the account that is spent",
  chain: "you",
};

/**
 * The trigger that started a run, as the runs table's trigger column, its filter and the header
 * read it.
 */
export const TRIGGER_KIND_WORDS: Readonly<Record<WorkflowTriggerKind, string>> = {
  "trigger.manual": "Manual",
  "trigger.schedule": "Schedule",
  "trigger.file-watch": "File watch",
  "trigger.webhook": "Webhook",
  "trigger.session-event": "Session event",
  "trigger.chat": "Chat",
  "trigger.sub-workflow": "Sub-workflow",
  "trigger.error": "Error",
};

/** Who or what started a run, keyed by the started-by kind, as the screen words it. */
const STARTED_BY_WORDS: Readonly<Record<WorkflowStartedBy["kind"], string>> = {
  user: "the user",
  schedule: "a schedule",
  chat: "chat",
  agent: "a sidekick",
  webhook: "a webhook",
  fileEvent: "a file event",
  parentWorkflow: "a parent workflow",
};

/**
 * The workflow codes that register their own label with the shared code-to-words mapper; every
 * other workflow code reads as its own words.
 */
export const WORKFLOW_CODE_LABELS: Readonly<Record<string, string>> = {
  [WORKFLOW_STEP_TIMED_OUT_CODE]: "Step timed out",
  [WORKFLOW_SANDBOX_UNAVAILABLE_CODE]: "Sandbox unavailable",
  [WORKFLOW_STEP_THREAD_FAILED_CODE]: "Step thread failed",
};

/**
 * A spent account by its provider's name and its label, as the run header and the attention
 * section name it after `the`: `Claude Code account sam@example.com · Max`.
 */
export function spentAccountWords(account: WorkflowSpentAccount): string {
  return `${PROVIDER_LABELS[account.provider]} account ${account.label}`;
}

/** Who or what started a run, in the words its row and its header read. */
export function startedByWords(startedBy: WorkflowStartedBy): string {
  return STARTED_BY_WORDS[startedBy.kind];
}

/** A count of items with its noun: `1 item`, `12 items`. */
export function itemCountWords(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "item" : "items"}`;
}

/** A count of runs with its noun: `1 run`, `4 runs`. */
export function runCountWords(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "run" : "runs"}`;
}
