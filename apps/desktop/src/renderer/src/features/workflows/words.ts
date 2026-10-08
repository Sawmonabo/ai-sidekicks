// The words the workflows screens put on wire values: a run's status, a step's state, what a
// wait is on, how a run was started and who started it, and a node's kind. No wire spelling
// reaches the screen. Each closed set is keyed by its contract's own union, so a value the
// contract adds fails to compile here until it has words; a node's kind is an open set, named
// by the catalog's names and read as its key's words when the catalog has no name for it.

import { PROVIDER_LABELS } from "@ai-sidekicks/contracts/provider/name";
import type { WorkflowNodeKindId } from "@ai-sidekicks/contracts/workflow/definition/document";
import { WORKFLOW_NODE_KIND_NAMES } from "@ai-sidekicks/contracts/workflow/kind";
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

import { codeWords } from "#renderer/lib/code-words.js";
import { readFrozenRecord } from "#renderer/lib/frozen-record.js";
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
  approval: "an approval",
  form: "an answer",
  reply: "a reply",
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
 * A spent account by its provider's name and its label, as the run header and the attention
 * section name it after `the`: `Claude Code account sam@example.com · Max`.
 */
export function spentAccountWords(account: WorkflowSpentAccount): string {
  return `${PROVIDER_LABELS[account.provider]} account ${account.label}`;
}

/**
 * A node's kind as its box reads it: the catalog's name for it, `files.read` reading `Read files`,
 * and a kind the catalog has no name for as its key's words.
 */
export function nodeKindWords(kind: WorkflowNodeKindId): string {
  return readFrozenRecord(WORKFLOW_NODE_KIND_NAMES, kind) ?? codeWords(kind);
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
