// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Workflow run records: the run's own record, reading one run with its steps, and the method table of every method that reads, lists and keeps run records.

import type { ApprovalDecision } from "../../approval.js";
import type { WireInstant } from "../../internal/wire-scalars.js";
import type { EmptyPayload } from "../../method-descriptor.js";
import type { SessionId } from "../../session/id.js";
import type {
  WorkflowDefinitionId,
  WorkflowEdgeId,
  WorkflowVersionId,
} from "../definition/document.js";
import type { WorkflowStepError } from "../definition/item.js";
import type { WorkflowRunAttentionListResponse } from "./attention.js";
import type { WorkflowRunId } from "./id.js";
import type { WorkflowRunListRequest, WorkflowRunListResponse } from "./list.js";
import type { WorkflowNewRunHoldState, WorkflowNewRunHoldUpdateRequest } from "./new-run-hold.js";
import type {
  WorkflowRunDeleteRequest,
  WorkflowRunDeleteResponse,
  WorkflowRunKeepSet,
  WorkflowRunPurgePreviewResponse,
  WorkflowRunPurgeRequest,
  WorkflowRunPurgeResponse,
} from "./retention.js";
import type { WorkflowRunEpoch } from "./snapshot.js";
import type { WorkflowCost, WorkflowStep } from "./step/record.js";
import type { WorkflowRunMode, WorkflowStartedBy, WorkflowTriggerKind } from "./trigger.js";

/**
 * `Delete run` on a new, running or waiting run or a failed run parked on its failed step, or
 * on a chain's first run while a later run of its chain is one of those; nothing is deleted
 * (`Cancel it first.`).
 */
export const WORKFLOW_RUN_NOT_DELETABLE_CODE = "workflow.run.notDeletable" as const;

/**
 * The chain's question as its first run's page carries it: open, or answered with the decision and
 * the run count it was taken at, which its receipt reads (`Kept going at 100 runs`). It is
 * answered through `workflow.gate.resolve` naming no node: `approved` keeps the chain going,
 * `rejected` stops every run of it.
 */
export type WorkflowChainQuestion =
  | {
      state: "open";
    }
  | {
      state: "answered";
      /**
       * The answer.
       */
      decision: ApprovalDecision;
      /**
       * How many runs the chain had started when it was answered.
       */
      runCount: number;
      /**
       * When it was answered.
       */
      answeredAt: WireInstant;
    };
/**
 * The end snapshot a finished run's `Open in Review` compares with its start: pinned to the
 * execution whose two snapshots are compared, or missing with the daemon's words for why it could
 * not be taken, and `Open in Review` stays in place saying so.
 */
export type WorkflowRunReview =
  | {
      state: "pinned";
      /**
       * The execution whose start and end snapshots are compared.
       */
      epoch: WorkflowRunEpoch;
    }
  | {
      state: "missing";
      /**
       * Why the end snapshot could not be taken.
       */
      reason: string;
    };
/**
 * One workflow run as its row records it, told apart by its `status`: the session it lives in,
 * the version it pins, how and by whom it was started, its Keep mark, when it started and ended,
 * and, on a run that failed, was canceled or crashed, why. It carries its end exactly once it has
 * ended.
 */
export type WorkflowRun =
  | {
      status: "new";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * Never present: a going run has not ended.
       */
      finishedAt?: never;
      /**
       * Never present: only a run that failed, was canceled or crashed says why.
       */
      error?: never;
    }
  | {
      status: "running";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * Never present: a going run has not ended.
       */
      finishedAt?: never;
      /**
       * Never present: only a run that failed, was canceled or crashed says why.
       */
      error?: never;
    }
  | {
      status: "waiting";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * Never present: a going run has not ended.
       */
      finishedAt?: never;
      /**
       * Never present: only a run that failed, was canceled or crashed says why.
       */
      error?: never;
    }
  | {
      status: "succeeded";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * When it ended.
       */
      finishedAt: WireInstant;
      /**
       * Never present: a run that succeeded has nothing to say why.
       */
      error?: never;
    }
  | {
      status: "failed";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * When it ended; absent while it is parked on its failed step.
       */
      finishedAt?: WireInstant;
      /**
       * Why it failed: the run cap or the retry bound, where one failed it.
       */
      error?: WorkflowStepError;
    }
  | {
      status: "canceled";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * When it ended.
       */
      finishedAt: WireInstant;
      /**
       * Why it stopped, where one is kept.
       */
      error?: WorkflowStepError;
    }
  | {
      status: "crashed";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * When it ended.
       */
      finishedAt: WireInstant;
      /**
       * Why it stopped, where one is kept.
       */
      error?: WorkflowStepError;
    };
/**
 * The `workflow.run.read` result: the run's record with its header facts and every step, from
 * which the page draws its graph and its step panel. A waiting run carries the step that waits,
 * only a finished run whose checkout was captured carries a review, and the chain's question sits
 * only on the chain's first run.
 */
export type WorkflowRunReadResponse =
  | {
      status: "new";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * The first run of the run's chain; its own id on a first run.
       */
      chainRoot: WorkflowChainRoot;
      /**
       * True for a run in a project's repository, which records its checkout and
       * snapshot points so `Open in Review` opens its changes; false for a chat's run in
       * the chat's own folder and a `None` run.
       */
      executionContextCaptured: boolean;
      /**
       * The session a failed step was opened in to be fixed, linked for the life of the
       * run.
       */
      fixSessionId?: SessionId;
      /**
       * Every step, one per execution of one node, from which the page draws its graph
       * and its step panel.
       */
      steps: WorkflowStep[];
      /**
       * Summed from the steps' stored amounts; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Every edge items went through.
       */
      edgeItemCounts: WorkflowEdgeItemCount[];
      /**
       * On the chain's first run, the chain's question once one has been asked.
       */
      chainQuestion?: WorkflowChainQuestion;
      /**
       * The step it is on.
       */
      liveStep?: WorkflowLiveStep;
      /**
       * Never present: only a finished run is reviewed.
       */
      review?: never;
      /**
       * Never present: a going run has not ended.
       */
      finishedAt?: never;
      /**
       * Never present: only a run that failed, was canceled or crashed says why.
       */
      error?: never;
    }
  | {
      status: "running";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * The first run of the run's chain; its own id on a first run.
       */
      chainRoot: WorkflowChainRoot;
      /**
       * True for a run in a project's repository, which records its checkout and
       * snapshot points so `Open in Review` opens its changes; false for a chat's run in
       * the chat's own folder and a `None` run.
       */
      executionContextCaptured: boolean;
      /**
       * The session a failed step was opened in to be fixed, linked for the life of the
       * run.
       */
      fixSessionId?: SessionId;
      /**
       * Every step, one per execution of one node, from which the page draws its graph
       * and its step panel.
       */
      steps: WorkflowStep[];
      /**
       * Summed from the steps' stored amounts; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Every edge items went through.
       */
      edgeItemCounts: WorkflowEdgeItemCount[];
      /**
       * On the chain's first run, the chain's question once one has been asked.
       */
      chainQuestion?: WorkflowChainQuestion;
      /**
       * The step it is on.
       */
      liveStep?: WorkflowLiveStep;
      /**
       * Never present: only a finished run is reviewed.
       */
      review?: never;
      /**
       * Never present: a going run has not ended.
       */
      finishedAt?: never;
      /**
       * Never present: only a run that failed, was canceled or crashed says why.
       */
      error?: never;
    }
  | {
      status: "waiting";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * The first run of the run's chain; its own id on a first run.
       */
      chainRoot: WorkflowChainRoot;
      /**
       * True for a run in a project's repository, which records its checkout and
       * snapshot points so `Open in Review` opens its changes; false for a chat's run in
       * the chat's own folder and a `None` run.
       */
      executionContextCaptured: boolean;
      /**
       * The session a failed step was opened in to be fixed, linked for the life of the
       * run.
       */
      fixSessionId?: SessionId;
      /**
       * Every step, one per execution of one node, from which the page draws its graph
       * and its step panel.
       */
      steps: WorkflowStep[];
      /**
       * Summed from the steps' stored amounts; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Every edge items went through.
       */
      edgeItemCounts: WorkflowEdgeItemCount[];
      /**
       * On the chain's first run, the chain's question once one has been asked.
       */
      chainQuestion?: WorkflowChainQuestion;
      /**
       * The step it is on.
       */
      liveStep?: WorkflowLiveStep;
      /**
       * Never present: only a finished run is reviewed.
       */
      review?: never;
      /**
       * Never present: a going run has not ended.
       */
      finishedAt?: never;
      /**
       * Never present: only a run that failed, was canceled or crashed says why.
       */
      error?: never;
    }
  | {
      status: "succeeded";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * The first run of the run's chain; its own id on a first run.
       */
      chainRoot: WorkflowChainRoot;
      /**
       * True for a run in a project's repository, which records its checkout and
       * snapshot points so `Open in Review` opens its changes; false for a chat's run in
       * the chat's own folder and a `None` run.
       */
      executionContextCaptured: boolean;
      /**
       * The session a failed step was opened in to be fixed, linked for the life of the
       * run.
       */
      fixSessionId?: SessionId;
      /**
       * Every step, one per execution of one node, from which the page draws its graph
       * and its step panel.
       */
      steps: WorkflowStep[];
      /**
       * Summed from the steps' stored amounts; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Every edge items went through.
       */
      edgeItemCounts: WorkflowEdgeItemCount[];
      /**
       * On the chain's first run, the chain's question once one has been asked.
       */
      chainQuestion?: WorkflowChainQuestion;
      /**
       * Never present: only a going run has a live step.
       */
      liveStep?: never;
      /**
       * Where its checkout was captured, the snapshots `Open in Review` compares.
       */
      review?: WorkflowRunReview;
      /**
       * When it ended.
       */
      finishedAt: WireInstant;
      /**
       * Never present: a run that succeeded has nothing to say why.
       */
      error?: never;
    }
  | {
      status: "failed";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * The first run of the run's chain; its own id on a first run.
       */
      chainRoot: WorkflowChainRoot;
      /**
       * True for a run in a project's repository, which records its checkout and
       * snapshot points so `Open in Review` opens its changes; false for a chat's run in
       * the chat's own folder and a `None` run.
       */
      executionContextCaptured: boolean;
      /**
       * The session a failed step was opened in to be fixed, linked for the life of the
       * run.
       */
      fixSessionId?: SessionId;
      /**
       * Every step, one per execution of one node, from which the page draws its graph
       * and its step panel.
       */
      steps: WorkflowStep[];
      /**
       * Summed from the steps' stored amounts; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Every edge items went through.
       */
      edgeItemCounts: WorkflowEdgeItemCount[];
      /**
       * On the chain's first run, the chain's question once one has been asked.
       */
      chainQuestion?: WorkflowChainQuestion;
      /**
       * Never present: only a going run has a live step.
       */
      liveStep?: never;
      /**
       * Once it has ended with its checkout captured, the snapshots `Open in Review` compares.
       */
      review?: WorkflowRunReview;
      /**
       * When it ended; absent while it is parked on its failed step.
       */
      finishedAt?: WireInstant;
      /**
       * Why it failed: the run cap or the retry bound, where one failed it.
       */
      error?: WorkflowStepError;
    }
  | {
      status: "canceled";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * The first run of the run's chain; its own id on a first run.
       */
      chainRoot: WorkflowChainRoot;
      /**
       * True for a run in a project's repository, which records its checkout and
       * snapshot points so `Open in Review` opens its changes; false for a chat's run in
       * the chat's own folder and a `None` run.
       */
      executionContextCaptured: boolean;
      /**
       * The session a failed step was opened in to be fixed, linked for the life of the
       * run.
       */
      fixSessionId?: SessionId;
      /**
       * Every step, one per execution of one node, from which the page draws its graph
       * and its step panel.
       */
      steps: WorkflowStep[];
      /**
       * Summed from the steps' stored amounts; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Every edge items went through.
       */
      edgeItemCounts: WorkflowEdgeItemCount[];
      /**
       * On the chain's first run, the chain's question once one has been asked.
       */
      chainQuestion?: WorkflowChainQuestion;
      /**
       * Never present: only a going run has a live step.
       */
      liveStep?: never;
      /**
       * Where its checkout was captured, the snapshots `Open in Review` compares.
       */
      review?: WorkflowRunReview;
      /**
       * When it ended.
       */
      finishedAt: WireInstant;
      /**
       * Why it stopped, where one is kept.
       */
      error?: WorkflowStepError;
    }
  | {
      status: "crashed";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in: the chat that started it, the session the workflow owns
       * for a run nobody started from a chat, or a sub-workflow's parent's.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from; a run whose definition was deleted still reads.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The version it pins.
       */
      workflowVersionId: WorkflowVersionId;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * The Keep mark, which `Delete runs older than…` leaves.
       */
      keep: boolean;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * The first run of the run's chain; its own id on a first run.
       */
      chainRoot: WorkflowChainRoot;
      /**
       * True for a run in a project's repository, which records its checkout and
       * snapshot points so `Open in Review` opens its changes; false for a chat's run in
       * the chat's own folder and a `None` run.
       */
      executionContextCaptured: boolean;
      /**
       * The session a failed step was opened in to be fixed, linked for the life of the
       * run.
       */
      fixSessionId?: SessionId;
      /**
       * Every step, one per execution of one node, from which the page draws its graph
       * and its step panel.
       */
      steps: WorkflowStep[];
      /**
       * Summed from the steps' stored amounts; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Every edge items went through.
       */
      edgeItemCounts: WorkflowEdgeItemCount[];
      /**
       * On the chain's first run, the chain's question once one has been asked.
       */
      chainQuestion?: WorkflowChainQuestion;
      /**
       * Never present: only a going run has a live step.
       */
      liveStep?: never;
      /**
       * Where its checkout was captured, the snapshots `Open in Review` compares.
       */
      review?: WorkflowRunReview;
      /**
       * When it ended.
       */
      finishedAt: WireInstant;
      /**
       * Why it stopped, where one is kept.
       */
      error?: WorkflowStepError;
    };

/**
 * Where a going run is: the live step's place in the run, counted from 1 and never past `total`,
 * and its node's name.
 */
export interface WorkflowLiveStep {
  /**
   * The live step's place in the run.
   */
  index: number;
  /**
   * How many steps the run has.
   */
  total: number;
  /**
   * The live step's node's name.
   */
  nodeName: string;
}
/**
 * The first run of a run's chain: runs a run starts join its chain, and a first run names itself.
 * The header links the first run only when it is another run.
 */
export interface WorkflowChainRoot {
  /**
   * The first run.
   */
  runId: WorkflowRunId;
  /**
   * Its workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * Its workflow's name.
   */
  workflowName: string;
  /**
   * When it started.
   */
  startedAt: WireInstant;
  /**
   * How many runs the chain has started from it, the first run included, which the chain's
   * question and a held step's live line both read.
   */
  runCount: number;
}
/**
 * How many items went through one edge of the run's graph, summed over every pass.
 */
export interface WorkflowEdgeItemCount {
  /**
   * The edge.
   */
  edgeId: WorkflowEdgeId;
  /**
   * How many items went through it.
   */
  itemCount: number;
}
/**
 * The `workflow.run.read` input.
 */
export interface WorkflowRunReadRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
}

export {
  validateWorkflowChainQuestion,
  validateWorkflowChainRoot,
  validateWorkflowEdgeItemCount,
  validateWorkflowLiveStep,
  validateWorkflowRunReadResponse,
  validateWorkflowRunReview,
} from "../../checks/workflow/run/records.js";

/** The methods of {@link WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS}, each with its kind. */
export interface WorkflowRunRecordMethodDescriptors {
  readonly "workflow.run.read": {
    readonly method: "workflow.run.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "workflow.run.list": {
    readonly method: "workflow.run.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "workflow.run.delete": {
    readonly method: "workflow.run.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.run.purge.preview": {
    readonly method: "workflow.run.purge.preview";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "workflow.run.purge": {
    readonly method: "workflow.run.purge";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.run.keep.update": {
    readonly method: "workflow.run.keep.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.run.attention.list": {
    readonly method: "workflow.run.attention.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "workflow.newRunHold.update": {
    readonly method: "workflow.newRunHold.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS}. */
export interface WorkflowRunRecordMethodTypes {
  readonly "workflow.run.read": {
    readonly params: WorkflowRunReadRequest;
    readonly result: WorkflowRunReadResponse;
  };
  readonly "workflow.run.list": {
    readonly params: WorkflowRunListRequest;
    readonly result: WorkflowRunListResponse;
  };
  readonly "workflow.run.delete": {
    readonly params: WorkflowRunDeleteRequest;
    readonly result: WorkflowRunDeleteResponse;
  };
  readonly "workflow.run.purge.preview": {
    readonly params: WorkflowRunPurgeRequest;
    readonly result: WorkflowRunPurgePreviewResponse;
  };
  readonly "workflow.run.purge": {
    readonly params: WorkflowRunPurgeRequest;
    readonly result: WorkflowRunPurgeResponse;
  };
  readonly "workflow.run.keep.update": {
    readonly params: WorkflowRunKeepSet;
    readonly result: WorkflowRunKeepSet;
  };
  readonly "workflow.run.attention.list": {
    readonly params: EmptyPayload;
    readonly result: WorkflowRunAttentionListResponse;
  };
  readonly "workflow.newRunHold.update": {
    readonly params: WorkflowNewRunHoldUpdateRequest;
    readonly result: WorkflowNewRunHoldState;
  };
}
/**
 * The `workflow.*` methods that read, list and keep run records. `workflow.run.attention.list`
 * takes no members: the runs table's filters never narrow it.
 */
export const WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS: WorkflowRunRecordMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "workflow.run.read": /* @__PURE__ */ Object.freeze({
      method: "workflow.run.read",
      procedureType: "query",
      mutating: false,
    }),
    "workflow.run.list": /* @__PURE__ */ Object.freeze({
      method: "workflow.run.list",
      procedureType: "query",
      mutating: false,
    }),
    "workflow.run.delete": /* @__PURE__ */ Object.freeze({
      method: "workflow.run.delete",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.run.purge.preview": /* @__PURE__ */ Object.freeze({
      method: "workflow.run.purge.preview",
      procedureType: "query",
      mutating: false,
    }),
    "workflow.run.purge": /* @__PURE__ */ Object.freeze({
      method: "workflow.run.purge",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.run.keep.update": /* @__PURE__ */ Object.freeze({
      method: "workflow.run.keep.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.run.attention.list": /* @__PURE__ */ Object.freeze({
      method: "workflow.run.attention.list",
      procedureType: "query",
      mutating: false,
    }),
    "workflow.newRunHold.update": /* @__PURE__ */ Object.freeze({
      method: "workflow.newRunHold.update",
      procedureType: "mutation",
      mutating: true,
    }),
  });
