// The words the workflows screens put on wire values: a run's status, a step's state, what a
// wait is on, how a run was started and who started it, and an error code. No wire spelling
// reaches the screen; each closed set is keyed by its contract's own union, so a value the
// contract adds fails to compile here until it has words.

import type {
  WorkflowRunStatus,
  WorkflowStartedBy,
  WorkflowStepStatus,
  WorkflowTriggerKind,
  WorkflowWaitCause,
} from "@ai-sidekicks/contracts/workflow-run";
import {
  WORKFLOW_SANDBOX_UNAVAILABLE_CODE,
  WORKFLOW_STEP_THREAD_FAILED_CODE,
  WORKFLOW_STEP_TIMED_OUT_CODE,
} from "@ai-sidekicks/contracts/workflow-run";

import { formatCount } from "@renderer/lib/wire-figures.js";

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

/** What a waiting run or step is waiting on, as the attention line and the live line read it. */
export const WAIT_CAUSE_WORDS: Readonly<Record<WorkflowWaitCause, string>> = {
  approval: "your approval",
  form: "your answer to a form",
  reply: "your reply",
  account: "a spent account",
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

/** What a spent-account park reads while no resume instant is armed, never a made-up time. */
export const AWAITING_RESUME_WORDS = "Awaiting resume — no instant is armed.";

/** Who or what started a run, keyed by the started-by kind. */
const STARTED_BY_WORDS: Readonly<Record<WorkflowStartedBy["kind"], string>> = {
  user: "You",
  schedule: "A schedule",
  chat: "Chat",
  agent: "A sidekick",
  webhook: "A webhook",
  fileEvent: "A file event",
  parentWorkflow: "A parent workflow",
};

/** Codes that register their own label; every other code falls back to its words. */
const REGISTERED_CODE_WORDS: Readonly<Record<string, string>> = {
  [WORKFLOW_STEP_TIMED_OUT_CODE]: "Step timed out",
  [WORKFLOW_SANDBOX_UNAVAILABLE_CODE]: "Sandbox unavailable",
  [WORKFLOW_STEP_THREAD_FAILED_CODE]: "Step thread failed",
};

/** A code root whose screen word differs from its wire spelling. */
const ROOT_WORDS: Readonly<Record<string, string>> = { agent: "Sidekick" };

/** Who or what started a run, in the words its row and its header read. */
export function startedByWords(startedBy: WorkflowStartedBy): string {
  return STARTED_BY_WORDS[startedBy.kind];
}

/**
 * An error or refusal code as words in sentence case: a registered label where the code has one,
 * otherwise its own words with the root's screen word, so `workflow.start_denied` reads
 * `Workflow start denied` and `agent.resolution_refused` reads `Sidekick resolution refused`.
 */
export function codeWords(code: string): string {
  const registered = REGISTERED_CODE_WORDS[code];
  if (registered !== undefined) {
    return registered;
  }
  const [root = "", ...rest] = code.split(".");
  const words = [ROOT_WORDS[root] ?? root, ...rest]
    .join(" ")
    .replaceAll("_", " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A count of items with its noun: `1 item`, `12 items`. */
export function itemCountWords(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "item" : "items"}`;
}

/** A count of runs with its noun: `1 run`, `4 runs`. */
export function runCountWords(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "run" : "runs"}`;
}
