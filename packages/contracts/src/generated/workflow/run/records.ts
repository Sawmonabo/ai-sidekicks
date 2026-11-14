// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Workflow run records: the run's own record, reading one run with its steps, and the method table of every method that reads, lists and keeps run records.

import {
  type CompiledSchemaCheck,
  type SchemaCheck,
  deepEqual,
  ucs2length,
} from "../../../schema-check.js";
import { type ApprovalDecision, validateApprovalDecision } from "../../approval.js";
import { type WireInstant, validateWireInstant } from "../../internal/wire-scalars.js";
import { type EmptyPayload, validateEmptyPayload } from "../../method-descriptor.js";
import { type SessionId, validateSessionId } from "../../session/id.js";
import {
  type WorkflowDefinitionId,
  type WorkflowEdgeId,
  type WorkflowVersionId,
  validateWorkflowDefinitionId,
  validateWorkflowEdgeId,
  validateWorkflowVersionId,
} from "../definition/document.js";
import { type WorkflowStepError, validateWorkflowStepError } from "../definition/item.js";
import {
  type WorkflowRunAttentionListResponse,
  validateWorkflowRunAttentionListResponse,
} from "./attention.js";
import { type WorkflowRunId, validateWorkflowRunId } from "./id.js";
import {
  type WorkflowRunListRequest,
  type WorkflowRunListResponse,
  validateWorkflowRunListRequest,
  validateWorkflowRunListResponse,
} from "./list.js";
import {
  type WorkflowNewRunHoldState,
  type WorkflowNewRunHoldUpdateRequest,
  validateWorkflowNewRunHoldState,
  validateWorkflowNewRunHoldUpdateRequest,
} from "./new-run-hold.js";
import {
  type WorkflowRunDeleteRequest,
  type WorkflowRunDeleteResponse,
  type WorkflowRunKeepSet,
  type WorkflowRunPurgePreviewResponse,
  type WorkflowRunPurgeRequest,
  type WorkflowRunPurgeResponse,
  validateWorkflowRunDeleteRequest,
  validateWorkflowRunDeleteResponse,
  validateWorkflowRunKeepSet,
  validateWorkflowRunPurgePreviewResponse,
  validateWorkflowRunPurgeRequest,
  validateWorkflowRunPurgeResponse,
} from "./retention.js";
import { type WorkflowRunEpoch, validateWorkflowRunEpoch } from "./snapshot.js";
import {
  type WorkflowCost,
  type WorkflowStep,
  validateWorkflowCost,
  validateWorkflowStep,
} from "./step/record.js";
import {
  type WorkflowRunMode,
  type WorkflowStartedBy,
  type WorkflowTriggerKind,
  validateWorkflowRunMode,
  validateWorkflowStartedBy,
  validateWorkflowTriggerKind,
} from "./trigger.js";

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

// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link WorkflowLiveStep}. */
// prettier-ignore
export const validateWorkflowLiveStep: CompiledSchemaCheck<WorkflowLiveStep> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowLiveStep {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowLiveStep.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.index === undefined) && (missing0 = "index")) || ((data.total === undefined) && (missing0 = "total"))) || ((data.nodeName === undefined) && (missing0 = "nodeName"))){validateWorkflowLiveStep.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "index") || (key0 === "total")) || (key0 === "nodeName"))){validateWorkflowLiveStep.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.index !== undefined){let data0: any = data.index;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateWorkflowLiveStep.errors = [{instancePath:instancePath+"/index",schemaPath:"#/properties/index/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){const vSchema0: any = data && data.total;if(vSchema0 !== undefined && ((!((typeof vSchema0 == "number") && (isFinite(vSchema0)))) || (data0 > vSchema0 || isNaN(data0)))){validateWorkflowLiveStep.errors = [{instancePath:instancePath+"/index",schemaPath:"#/properties/index/maximum",keyword:"maximum",params:{comparison: "<=", limit: vSchema0}}];return false;}else {if(data0 < 1 || isNaN(data0)){validateWorkflowLiveStep.errors = [{instancePath:instancePath+"/index",schemaPath:"#/properties/index/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.total !== undefined){let data1: any = data.total;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowLiveStep.errors = [{instancePath:instancePath+"/total",schemaPath:"#/properties/total/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowLiveStep.errors = [{instancePath:instancePath+"/total",schemaPath:"#/properties/total/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateWorkflowLiveStep.errors = [{instancePath:instancePath+"/total",schemaPath:"#/properties/total/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeName !== undefined){let data2: any = data.nodeName;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) < 1){validateWorkflowLiveStep.errors = [{instancePath:instancePath+"/nodeName",schemaPath:"#/properties/nodeName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowLiveStep.errors = [{instancePath:instancePath+"/nodeName",schemaPath:"#/properties/nodeName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowLiveStep.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowLiveStep.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowLiveStep.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowChainRoot}. */
// prettier-ignore
export const validateWorkflowChainRoot: CompiledSchemaCheck<WorkflowChainRoot> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowChainRoot {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowChainRoot.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.runId === undefined) && (missing0 = "runId")) || ((data.definitionId === undefined) && (missing0 = "definitionId"))) || ((data.workflowName === undefined) && (missing0 = "workflowName"))) || ((data.startedAt === undefined) && (missing0 = "startedAt"))) || ((data.runCount === undefined) && (missing0 = "runCount"))){validateWorkflowChainRoot.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "runId") || (key0 === "definitionId")) || (key0 === "workflowName")) || (key0 === "startedAt")) || (key0 === "runCount"))){validateWorkflowChainRoot.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.runId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.definitionId !== undefined){const _errs3: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.workflowName !== undefined){let data2: any = data.workflowName;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) < 1){validateWorkflowChainRoot.errors = [{instancePath:instancePath+"/workflowName",schemaPath:"#/properties/workflowName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowChainRoot.errors = [{instancePath:instancePath+"/workflowName",schemaPath:"#/properties/workflowName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.startedAt !== undefined){const _errs6: any = errors;if(!(validateWireInstant.call(this, data.startedAt, {instancePath:instancePath+"/startedAt",parentData:data,parentDataProperty:"startedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.runCount !== undefined){let data4: any = data.runCount;const _errs7: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateWorkflowChainRoot.errors = [{instancePath:instancePath+"/runCount",schemaPath:"#/properties/runCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateWorkflowChainRoot.errors = [{instancePath:instancePath+"/runCount",schemaPath:"#/properties/runCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 1 || isNaN(data4)){validateWorkflowChainRoot.errors = [{instancePath:instancePath+"/runCount",schemaPath:"#/properties/runCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}}else {validateWorkflowChainRoot.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowChainRoot.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowChainRoot.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowChainQuestion}. */
// prettier-ignore
export const validateWorkflowChainQuestion: CompiledSchemaCheck<WorkflowChainQuestion> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowChainQuestion {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowChainQuestion.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "open"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.state === undefined) && (missing0 = "state")){validateWorkflowChainQuestion.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(key0 === "state")){validateWorkflowChainQuestion.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.state !== undefined){let data0: any = data.state;if(typeof data0 !== "string"){validateWorkflowChainQuestion.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("open" !== data0){validateWorkflowChainQuestion.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "open"}}];return false;}}}}}else {validateWorkflowChainQuestion.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "answered"){const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.state === undefined) && (missing1 = "state")) || ((data.decision === undefined) && (missing1 = "decision"))) || ((data.runCount === undefined) && (missing1 = "runCount"))) || ((data.answeredAt === undefined) && (missing1 = "answeredAt"))){validateWorkflowChainQuestion.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data){if(!((((key1 === "state") || (key1 === "decision")) || (key1 === "runCount")) || (key1 === "answeredAt"))){validateWorkflowChainQuestion.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data.state !== undefined){let data1: any = data.state;const _errs10: any = errors;if(typeof data1 !== "string"){validateWorkflowChainQuestion.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("answered" !== data1){validateWorkflowChainQuestion.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "answered"}}];return false;}var valid4: any = _errs10 === errors;}else {var valid4: any = true;}if(valid4){if(data.decision !== undefined){const _errs12: any = errors;if(!(validateApprovalDecision.call(this, data.decision, {instancePath:instancePath+"/decision",parentData:data,parentDataProperty:"decision",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalDecision.errors : vErrors.concat(validateApprovalDecision.errors);errors = vErrors.length;}var valid4: any = _errs12 === errors;}else {var valid4: any = true;}if(valid4){if(data.runCount !== undefined){let data3: any = data.runCount;const _errs13: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateWorkflowChainQuestion.errors = [{instancePath:instancePath+"/runCount",schemaPath:"#/oneOf/1/properties/runCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateWorkflowChainQuestion.errors = [{instancePath:instancePath+"/runCount",schemaPath:"#/oneOf/1/properties/runCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validateWorkflowChainQuestion.errors = [{instancePath:instancePath+"/runCount",schemaPath:"#/oneOf/1/properties/runCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}if(valid4){if(data.answeredAt !== undefined){const _errs15: any = errors;if(!(validateWireInstant.call(this, data.answeredAt, {instancePath:instancePath+"/answeredAt",parentData:data,parentDataProperty:"answeredAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}}}}}}}else {validateWorkflowChainQuestion.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs7 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateWorkflowChainQuestion.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validateWorkflowChainQuestion.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateWorkflowChainQuestion.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateWorkflowChainQuestion.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowChainQuestion.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowChainQuestion.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowEdgeItemCount}. */
// prettier-ignore
export const validateWorkflowEdgeItemCount: CompiledSchemaCheck<WorkflowEdgeItemCount> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowEdgeItemCount {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowEdgeItemCount.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.edgeId === undefined) && (missing0 = "edgeId")) || ((data.itemCount === undefined) && (missing0 = "itemCount"))){validateWorkflowEdgeItemCount.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "edgeId") || (key0 === "itemCount"))){validateWorkflowEdgeItemCount.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.edgeId !== undefined){const _errs2: any = errors;if(!(validateWorkflowEdgeId.call(this, data.edgeId, {instancePath:instancePath+"/edgeId",parentData:data,parentDataProperty:"edgeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowEdgeId.errors : vErrors.concat(validateWorkflowEdgeId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.itemCount !== undefined){let data1: any = data.itemCount;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowEdgeItemCount.errors = [{instancePath:instancePath+"/itemCount",schemaPath:"#/properties/itemCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowEdgeItemCount.errors = [{instancePath:instancePath+"/itemCount",schemaPath:"#/properties/itemCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateWorkflowEdgeItemCount.errors = [{instancePath:instancePath+"/itemCount",schemaPath:"#/properties/itemCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowEdgeItemCount.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowEdgeItemCount.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowEdgeItemCount.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunReview}. */
// prettier-ignore
export const validateWorkflowRunReview: CompiledSchemaCheck<WorkflowRunReview> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunReview {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunReview.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "pinned"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.state === undefined) && (missing0 = "state")) || ((data.epoch === undefined) && (missing0 = "epoch"))){validateWorkflowRunReview.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "state") || (key0 === "epoch"))){validateWorkflowRunReview.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.state !== undefined){let data0: any = data.state;const _errs5: any = errors;if(typeof data0 !== "string"){validateWorkflowRunReview.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("pinned" !== data0){validateWorkflowRunReview.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "pinned"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.epoch !== undefined){const _errs7: any = errors;if(!(validateWorkflowRunEpoch.call(this, data.epoch, {instancePath:instancePath+"/epoch",parentData:data,parentDataProperty:"epoch",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunEpoch.errors : vErrors.concat(validateWorkflowRunEpoch.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validateWorkflowRunReview.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "missing"){const _errs8: any = errors;if(errors === _errs8){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.state === undefined) && (missing1 = "state")) || ((data.reason === undefined) && (missing1 = "reason"))){validateWorkflowRunReview.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs10: any = errors;for(const key1 in data){if(!((key1 === "state") || (key1 === "reason"))){validateWorkflowRunReview.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs10 === errors){if(data.state !== undefined){let data2: any = data.state;const _errs11: any = errors;if(typeof data2 !== "string"){validateWorkflowRunReview.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("missing" !== data2){validateWorkflowRunReview.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "missing"}}];return false;}var valid4: any = _errs11 === errors;}else {var valid4: any = true;}if(valid4){if(data.reason !== undefined){let data3: any = data.reason;const _errs13: any = errors;if(errors === _errs13){if(typeof data3 === "string"){if(func1(data3) < 1){validateWorkflowRunReview.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowRunReview.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}}}}}else {validateWorkflowRunReview.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs8 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateWorkflowRunReview.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validateWorkflowRunReview.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateWorkflowRunReview.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateWorkflowRunReview.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunReview.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunReview.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunReadRequest}. */
// prettier-ignore
export const validateWorkflowRunReadRequest: CompiledSchemaCheck<WorkflowRunReadRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunReadRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workflowRunId === undefined) && (missing0 = "workflowRunId")){validateWorkflowRunReadRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "workflowRunId")){validateWorkflowRunReadRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}}}}}else {validateWorkflowRunReadRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunReadRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunReadRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1551: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"status":{"type":"string","const":"new"},"workflowRunId":{"$ref":"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId","description":"The run."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session it lives in: the chat that started it, the session the workflow owns\nfor a run nobody started from a chat, or a sub-workflow's parent's."},"definitionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId","description":"The workflow it came from; a run whose definition was deleted still reads."},"workflowVersionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId","description":"The version it pins."},"mode":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowRunMode","description":"How it was started."},"triggerKind":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowTriggerKind","description":"The kind of trigger node that started it."},"startedBy":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowStartedBy","description":"Who or what started it."},"keep":{"type":"boolean","description":"The Keep mark, which `Delete runs older than…` leaves."},"startedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it started."},"chainRoot":{"$ref":"#/$defs/WorkflowChainRoot","description":"The first run of the run's chain; its own id on a first run."},"executionContextCaptured":{"type":"boolean","description":"True for a run in a project's repository, which records its checkout and\nsnapshot points so `Open in Review` opens its changes; false for a chat's run in\nthe chat's own folder and a `None` run."},"fixSessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session a failed step was opened in to be fixed, linked for the life of the\nrun."},"steps":{"type":"array","items":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowStep"},"description":"Every step, one per execution of one node, from which the page draws its graph\nand its step panel."},"cost":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowCost","description":"Summed from the steps' stored amounts; absent where no provider was billed."},"edgeItemCounts":{"type":"array","items":{"$ref":"#/$defs/WorkflowEdgeItemCount"},"description":"Every edge items went through."},"chainQuestion":{"$ref":"#/$defs/WorkflowChainQuestion","description":"On the chain's first run, the chain's question once one has been asked."},"liveStep":{"$ref":"#/$defs/WorkflowLiveStep","description":"The step it is on."},"review":{"not":{},"tsType":"never","description":"Never present: only a finished run is reviewed."},"finishedAt":{"not":{},"tsType":"never","description":"Never present: a going run has not ended."},"error":{"not":{},"tsType":"never","description":"Never present: only a run that failed, was canceled or crashed says why."}},"required":["status","workflowRunId","sessionId","definitionId","workflowVersionId","mode","triggerKind","startedBy","keep","startedAt","chainRoot","executionContextCaptured","steps","edgeItemCounts"],"description":"Started, with no step run yet."},{"type":"object","additionalProperties":false,"properties":{"status":{"type":"string","const":"running"},"workflowRunId":{"$ref":"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId","description":"The run."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session it lives in: the chat that started it, the session the workflow owns\nfor a run nobody started from a chat, or a sub-workflow's parent's."},"definitionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId","description":"The workflow it came from; a run whose definition was deleted still reads."},"workflowVersionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId","description":"The version it pins."},"mode":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowRunMode","description":"How it was started."},"triggerKind":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowTriggerKind","description":"The kind of trigger node that started it."},"startedBy":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowStartedBy","description":"Who or what started it."},"keep":{"type":"boolean","description":"The Keep mark, which `Delete runs older than…` leaves."},"startedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it started."},"chainRoot":{"$ref":"#/$defs/WorkflowChainRoot","description":"The first run of the run's chain; its own id on a first run."},"executionContextCaptured":{"type":"boolean","description":"True for a run in a project's repository, which records its checkout and\nsnapshot points so `Open in Review` opens its changes; false for a chat's run in\nthe chat's own folder and a `None` run."},"fixSessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session a failed step was opened in to be fixed, linked for the life of the\nrun."},"steps":{"type":"array","items":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowStep"},"description":"Every step, one per execution of one node, from which the page draws its graph\nand its step panel."},"cost":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowCost","description":"Summed from the steps' stored amounts; absent where no provider was billed."},"edgeItemCounts":{"type":"array","items":{"$ref":"#/$defs/WorkflowEdgeItemCount"},"description":"Every edge items went through."},"chainQuestion":{"$ref":"#/$defs/WorkflowChainQuestion","description":"On the chain's first run, the chain's question once one has been asked."},"liveStep":{"$ref":"#/$defs/WorkflowLiveStep","description":"The step it is on."},"review":{"not":{},"tsType":"never","description":"Never present: only a finished run is reviewed."},"finishedAt":{"not":{},"tsType":"never","description":"Never present: a going run has not ended."},"error":{"not":{},"tsType":"never","description":"Never present: only a run that failed, was canceled or crashed says why."}},"required":["status","workflowRunId","sessionId","definitionId","workflowVersionId","mode","triggerKind","startedBy","keep","startedAt","chainRoot","executionContextCaptured","steps","edgeItemCounts"],"description":"A step is running."},{"type":"object","additionalProperties":false,"properties":{"status":{"type":"string","const":"waiting"},"workflowRunId":{"$ref":"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId","description":"The run."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session it lives in: the chat that started it, the session the workflow owns\nfor a run nobody started from a chat, or a sub-workflow's parent's."},"definitionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId","description":"The workflow it came from; a run whose definition was deleted still reads."},"workflowVersionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId","description":"The version it pins."},"mode":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowRunMode","description":"How it was started."},"triggerKind":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowTriggerKind","description":"The kind of trigger node that started it."},"startedBy":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowStartedBy","description":"Who or what started it."},"keep":{"type":"boolean","description":"The Keep mark, which `Delete runs older than…` leaves."},"startedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it started."},"chainRoot":{"$ref":"#/$defs/WorkflowChainRoot","description":"The first run of the run's chain; its own id on a first run."},"executionContextCaptured":{"type":"boolean","description":"True for a run in a project's repository, which records its checkout and\nsnapshot points so `Open in Review` opens its changes; false for a chat's run in\nthe chat's own folder and a `None` run."},"fixSessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session a failed step was opened in to be fixed, linked for the life of the\nrun."},"steps":{"type":"array","items":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowStep"},"description":"Every step, one per execution of one node, from which the page draws its graph\nand its step panel."},"cost":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowCost","description":"Summed from the steps' stored amounts; absent where no provider was billed."},"edgeItemCounts":{"type":"array","items":{"$ref":"#/$defs/WorkflowEdgeItemCount"},"description":"Every edge items went through."},"chainQuestion":{"$ref":"#/$defs/WorkflowChainQuestion","description":"On the chain's first run, the chain's question once one has been asked."},"liveStep":{"$ref":"#/$defs/WorkflowLiveStep","description":"The step it is on."},"review":{"not":{},"tsType":"never","description":"Never present: only a finished run is reviewed."},"finishedAt":{"not":{},"tsType":"never","description":"Never present: a going run has not ended."},"error":{"not":{},"tsType":"never","description":"Never present: only a run that failed, was canceled or crashed says why."}},"required":["status","workflowRunId","sessionId","definitionId","workflowVersionId","mode","triggerKind","startedBy","keep","startedAt","chainRoot","executionContextCaptured","steps","edgeItemCounts"],"description":"Held by a person, a chain's question or a spent provider account."},{"type":"object","additionalProperties":false,"properties":{"status":{"type":"string","const":"succeeded"},"workflowRunId":{"$ref":"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId","description":"The run."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session it lives in: the chat that started it, the session the workflow owns\nfor a run nobody started from a chat, or a sub-workflow's parent's."},"definitionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId","description":"The workflow it came from; a run whose definition was deleted still reads."},"workflowVersionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId","description":"The version it pins."},"mode":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowRunMode","description":"How it was started."},"triggerKind":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowTriggerKind","description":"The kind of trigger node that started it."},"startedBy":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowStartedBy","description":"Who or what started it."},"keep":{"type":"boolean","description":"The Keep mark, which `Delete runs older than…` leaves."},"startedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it started."},"chainRoot":{"$ref":"#/$defs/WorkflowChainRoot","description":"The first run of the run's chain; its own id on a first run."},"executionContextCaptured":{"type":"boolean","description":"True for a run in a project's repository, which records its checkout and\nsnapshot points so `Open in Review` opens its changes; false for a chat's run in\nthe chat's own folder and a `None` run."},"fixSessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session a failed step was opened in to be fixed, linked for the life of the\nrun."},"steps":{"type":"array","items":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowStep"},"description":"Every step, one per execution of one node, from which the page draws its graph\nand its step panel."},"cost":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowCost","description":"Summed from the steps' stored amounts; absent where no provider was billed."},"edgeItemCounts":{"type":"array","items":{"$ref":"#/$defs/WorkflowEdgeItemCount"},"description":"Every edge items went through."},"chainQuestion":{"$ref":"#/$defs/WorkflowChainQuestion","description":"On the chain's first run, the chain's question once one has been asked."},"liveStep":{"not":{},"tsType":"never","description":"Never present: only a going run has a live step."},"review":{"$ref":"#/$defs/WorkflowRunReview","description":"Where its checkout was captured, the snapshots `Open in Review` compares."},"finishedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it ended."},"error":{"not":{},"tsType":"never","description":"Never present: a run that succeeded has nothing to say why."}},"required":["status","workflowRunId","sessionId","definitionId","workflowVersionId","mode","triggerKind","startedBy","keep","startedAt","chainRoot","executionContextCaptured","steps","edgeItemCounts","finishedAt"],"description":"Ended with every step done."},{"type":"object","additionalProperties":false,"properties":{"status":{"type":"string","const":"failed"},"workflowRunId":{"$ref":"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId","description":"The run."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session it lives in: the chat that started it, the session the workflow owns\nfor a run nobody started from a chat, or a sub-workflow's parent's."},"definitionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId","description":"The workflow it came from; a run whose definition was deleted still reads."},"workflowVersionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId","description":"The version it pins."},"mode":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowRunMode","description":"How it was started."},"triggerKind":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowTriggerKind","description":"The kind of trigger node that started it."},"startedBy":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowStartedBy","description":"Who or what started it."},"keep":{"type":"boolean","description":"The Keep mark, which `Delete runs older than…` leaves."},"startedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it started."},"chainRoot":{"$ref":"#/$defs/WorkflowChainRoot","description":"The first run of the run's chain; its own id on a first run."},"executionContextCaptured":{"type":"boolean","description":"True for a run in a project's repository, which records its checkout and\nsnapshot points so `Open in Review` opens its changes; false for a chat's run in\nthe chat's own folder and a `None` run."},"fixSessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session a failed step was opened in to be fixed, linked for the life of the\nrun."},"steps":{"type":"array","items":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowStep"},"description":"Every step, one per execution of one node, from which the page draws its graph\nand its step panel."},"cost":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowCost","description":"Summed from the steps' stored amounts; absent where no provider was billed."},"edgeItemCounts":{"type":"array","items":{"$ref":"#/$defs/WorkflowEdgeItemCount"},"description":"Every edge items went through."},"chainQuestion":{"$ref":"#/$defs/WorkflowChainQuestion","description":"On the chain's first run, the chain's question once one has been asked."},"liveStep":{"not":{},"tsType":"never","description":"Never present: only a going run has a live step."},"review":{"$ref":"#/$defs/WorkflowRunReview","description":"Once it has ended with its checkout captured, the snapshots `Open in Review` compares."},"finishedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it ended; absent while it is parked on its failed step."},"error":{"$ref":"sidekicks-contracts:workflow/definition/item#/$defs/WorkflowStepError","description":"Why it failed: the run cap or the retry bound, where one failed it."}},"required":["status","workflowRunId","sessionId","definitionId","workflowVersionId","mode","triggerKind","startedBy","keep","startedAt","chainRoot","executionContextCaptured","steps","edgeItemCounts"],"description":"Failed, ended or parked on its failed step."},{"type":"object","additionalProperties":false,"properties":{"status":{"type":"string","const":"canceled"},"workflowRunId":{"$ref":"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId","description":"The run."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session it lives in: the chat that started it, the session the workflow owns\nfor a run nobody started from a chat, or a sub-workflow's parent's."},"definitionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId","description":"The workflow it came from; a run whose definition was deleted still reads."},"workflowVersionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId","description":"The version it pins."},"mode":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowRunMode","description":"How it was started."},"triggerKind":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowTriggerKind","description":"The kind of trigger node that started it."},"startedBy":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowStartedBy","description":"Who or what started it."},"keep":{"type":"boolean","description":"The Keep mark, which `Delete runs older than…` leaves."},"startedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it started."},"chainRoot":{"$ref":"#/$defs/WorkflowChainRoot","description":"The first run of the run's chain; its own id on a first run."},"executionContextCaptured":{"type":"boolean","description":"True for a run in a project's repository, which records its checkout and\nsnapshot points so `Open in Review` opens its changes; false for a chat's run in\nthe chat's own folder and a `None` run."},"fixSessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session a failed step was opened in to be fixed, linked for the life of the\nrun."},"steps":{"type":"array","items":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowStep"},"description":"Every step, one per execution of one node, from which the page draws its graph\nand its step panel."},"cost":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowCost","description":"Summed from the steps' stored amounts; absent where no provider was billed."},"edgeItemCounts":{"type":"array","items":{"$ref":"#/$defs/WorkflowEdgeItemCount"},"description":"Every edge items went through."},"chainQuestion":{"$ref":"#/$defs/WorkflowChainQuestion","description":"On the chain's first run, the chain's question once one has been asked."},"liveStep":{"not":{},"tsType":"never","description":"Never present: only a going run has a live step."},"review":{"$ref":"#/$defs/WorkflowRunReview","description":"Where its checkout was captured, the snapshots `Open in Review` compares."},"finishedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it ended."},"error":{"$ref":"sidekicks-contracts:workflow/definition/item#/$defs/WorkflowStepError","description":"Why it stopped, where one is kept."}},"required":["status","workflowRunId","sessionId","definitionId","workflowVersionId","mode","triggerKind","startedBy","keep","startedAt","chainRoot","executionContextCaptured","steps","edgeItemCounts","finishedAt"],"description":"Ended by a cancel."},{"type":"object","additionalProperties":false,"properties":{"status":{"type":"string","const":"crashed"},"workflowRunId":{"$ref":"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId","description":"The run."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session it lives in: the chat that started it, the session the workflow owns\nfor a run nobody started from a chat, or a sub-workflow's parent's."},"definitionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId","description":"The workflow it came from; a run whose definition was deleted still reads."},"workflowVersionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId","description":"The version it pins."},"mode":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowRunMode","description":"How it was started."},"triggerKind":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowTriggerKind","description":"The kind of trigger node that started it."},"startedBy":{"$ref":"sidekicks-contracts:workflow/run/trigger#/$defs/WorkflowStartedBy","description":"Who or what started it."},"keep":{"type":"boolean","description":"The Keep mark, which `Delete runs older than…` leaves."},"startedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it started."},"chainRoot":{"$ref":"#/$defs/WorkflowChainRoot","description":"The first run of the run's chain; its own id on a first run."},"executionContextCaptured":{"type":"boolean","description":"True for a run in a project's repository, which records its checkout and\nsnapshot points so `Open in Review` opens its changes; false for a chat's run in\nthe chat's own folder and a `None` run."},"fixSessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session a failed step was opened in to be fixed, linked for the life of the\nrun."},"steps":{"type":"array","items":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowStep"},"description":"Every step, one per execution of one node, from which the page draws its graph\nand its step panel."},"cost":{"$ref":"sidekicks-contracts:workflow/run/step/record#/$defs/WorkflowCost","description":"Summed from the steps' stored amounts; absent where no provider was billed."},"edgeItemCounts":{"type":"array","items":{"$ref":"#/$defs/WorkflowEdgeItemCount"},"description":"Every edge items went through."},"chainQuestion":{"$ref":"#/$defs/WorkflowChainQuestion","description":"On the chain's first run, the chain's question once one has been asked."},"liveStep":{"not":{},"tsType":"never","description":"Never present: only a going run has a live step."},"review":{"$ref":"#/$defs/WorkflowRunReview","description":"Where its checkout was captured, the snapshots `Open in Review` compares."},"finishedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it ended."},"error":{"$ref":"sidekicks-contracts:workflow/definition/item#/$defs/WorkflowStepError","description":"Why it stopped, where one is kept."}},"required":["status","workflowRunId","sessionId","definitionId","workflowVersionId","mode","triggerKind","startedBy","keep","startedAt","chainRoot","executionContextCaptured","steps","edgeItemCounts","finishedAt"],"description":"Ended because the daemon stopped while it ran."}],"description":"The `workflow.run.read` result: the run's record with its header facts and every step, from\nwhich the page draws its graph and its step panel. A waiting run carries the step that waits,\nonly a finished run whose checkout was captured carries a review, and the chain's question sits\nonly on the chain's first run.","allOf":[{"if":{"type":"object","properties":{"status":{"const":"waiting"}},"required":["status"]},"then":{"type":"object","properties":{"steps":{"type":"array","contains":{"type":"object","properties":{"status":{"const":"waiting"}},"required":["status"]}}}}},{"if":{"type":"object","required":["review"],"properties":{"review":true}},"then":{"type":"object","properties":{"executionContextCaptured":{"const":true},"finishedAt":true},"required":["finishedAt"]}},{"if":{"type":"object","required":["chainQuestion"],"properties":{"chainQuestion":true}},"then":{"type":"object","properties":{"chainRoot":{"type":"object","properties":{"runId":{"const":{"$data":"2/workflowRunId"}}}}}}}],"discriminator":{"propertyName":"status"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const func0 = deepEqual;
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link WorkflowRunReadResponse}. */
// prettier-ignore
export const validateWorkflowRunReadResponse: CompiledSchemaCheck<WorkflowRunReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs2: any = errors;const _errs3: any = errors;let valid1: any = true;const _errs4: any = errors;if(errors === _errs4){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.status === undefined) && (missing0 = "status")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.status !== undefined){if("waiting" !== data.status){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}else {const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs4 === errors;errors = _errs3;if(vErrors !== null){if(_errs3){vErrors.length = _errs3;}else {vErrors = null;}}if(_valid0){const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){if(data.steps !== undefined){let data1: any = data.steps;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data1)){const _errs11: any = errors;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs12: any = errors;if(errors === _errs12){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if((data2.status === undefined) && (missing1 = "status")){const err3: any = {instancePath:instancePath+"/steps/" + i0,schemaPath:"#/allOf/0/then/properties/steps/contains/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(data2.status !== undefined){if("waiting" !== data2.status){const err4: any = {instancePath:instancePath+"/steps/" + i0+"/status",schemaPath:"#/allOf/0/then/properties/steps/contains/properties/status/const",keyword:"const",params:{allowedValue: "waiting"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}}}else {const err5: any = {instancePath:instancePath+"/steps/" + i0,schemaPath:"#/allOf/0/then/properties/steps/contains/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid4: any = _errs12 === errors;if(valid4){break;}}if(!valid4){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/steps",schemaPath:"#/allOf/0/then/properties/steps/contains",keyword:"contains",params:{minContains: 1}}];return false;}else {errors = _errs11;if(vErrors !== null){if(_errs11){vErrors.length = _errs11;}else {vErrors = null;}}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/steps",schemaPath:"#/allOf/0/then/properties/steps/type",keyword:"type",params:{type: "array"}}];return false;}}}}else {validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/allOf/0/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid0: any = _errs7 === errors;valid1 = _valid0;if(valid1){var props0: any = {};props0.steps = true;props0.status = true;}}if(!valid1){const err6: any = {instancePath,schemaPath:"#/allOf/0/if",keyword:"if",params:{failingKeyword: "then"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;validateWorkflowRunReadResponse.errors = vErrors;return false;}var valid0: any = _errs2 === errors;if(valid0){const _errs15: any = errors;const _errs16: any = errors;let valid6: any = true;const _errs17: any = errors;if(errors === _errs17){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.review === undefined) && (missing2 = "review")){const err7: any = {};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}else {const err8: any = {};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}var _valid1: any = _errs17 === errors;errors = _errs16;if(vErrors !== null){if(_errs16){vErrors.length = _errs16;}else {vErrors = null;}}if(_valid1){const _errs19: any = errors;if(errors === _errs19){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((data.finishedAt === undefined) && (missing3 = "finishedAt")){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/allOf/1/then/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {if(data.executionContextCaptured !== undefined){if(true !== data.executionContextCaptured){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/executionContextCaptured",schemaPath:"#/allOf/1/then/properties/executionContextCaptured/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}else {validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/allOf/1/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid1: any = _errs19 === errors;valid6 = _valid1;if(valid6){var props1: any = {};props1.executionContextCaptured = true;props1.finishedAt = true;props1.review = true;}}if(!valid6){const err9: any = {instancePath,schemaPath:"#/allOf/1/if",keyword:"if",params:{failingKeyword: "then"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;validateWorkflowRunReadResponse.errors = vErrors;return false;}var valid0: any = _errs15 === errors;if(valid0){if(props0 !== true && props1 !== undefined){if(props1 === true){props0 = true;}else {props0 = props0 || {};Object.assign(props0, props1);}}const _errs22: any = errors;const _errs23: any = errors;let valid8: any = true;const _errs24: any = errors;if(errors === _errs24){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((data.chainQuestion === undefined) && (missing4 = "chainQuestion")){const err10: any = {};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}else {const err11: any = {};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}var _valid2: any = _errs24 === errors;errors = _errs23;if(vErrors !== null){if(_errs23){vErrors.length = _errs23;}else {vErrors = null;}}if(_valid2){const _errs26: any = errors;if(errors === _errs26){if(data && typeof data == "object" && !Array.isArray(data)){if(data.chainRoot !== undefined){let data5: any = data.chainRoot;const _errs28: any = errors;if(errors === _errs28){if(data5 && typeof data5 == "object" && !Array.isArray(data5)){if(data5.runId !== undefined){const vSchema0: any = data && data.workflowRunId;if(vSchema0 !== undefined && (!func0(data5.runId, vSchema0))){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/chainRoot/runId",schemaPath:"#/allOf/2/then/properties/chainRoot/properties/runId/const",keyword:"const",params:{allowedValue: vSchema0}}];return false;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/chainRoot",schemaPath:"#/allOf/2/then/properties/chainRoot/type",keyword:"type",params:{type: "object"}}];return false;}}}}else {validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/allOf/2/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid2: any = _errs26 === errors;valid8 = _valid2;if(valid8){var props2: any = {};props2.chainRoot = true;props2.chainQuestion = true;}}if(!valid8){const err12: any = {instancePath,schemaPath:"#/allOf/2/if",keyword:"if",params:{failingKeyword: "then"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;validateWorkflowRunReadResponse.errors = vErrors;return false;}var valid0: any = _errs22 === errors;if(valid0){if(props0 !== true && props2 !== undefined){if(props2 === true){props0 = true;}else {props0 = props0 || {};Object.assign(props0, props2);}}}}}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid11: any = false;const tag0: any = data.status;if(typeof tag0 == "string"){if(tag0 === "new"){const _errs31: any = errors;if(errors === _errs31){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if(((((((((((((((data.status === undefined) && (missing5 = "status")) || ((data.workflowRunId === undefined) && (missing5 = "workflowRunId"))) || ((data.sessionId === undefined) && (missing5 = "sessionId"))) || ((data.definitionId === undefined) && (missing5 = "definitionId"))) || ((data.workflowVersionId === undefined) && (missing5 = "workflowVersionId"))) || ((data.mode === undefined) && (missing5 = "mode"))) || ((data.triggerKind === undefined) && (missing5 = "triggerKind"))) || ((data.startedBy === undefined) && (missing5 = "startedBy"))) || ((data.keep === undefined) && (missing5 = "keep"))) || ((data.startedAt === undefined) && (missing5 = "startedAt"))) || ((data.chainRoot === undefined) && (missing5 = "chainRoot"))) || ((data.executionContextCaptured === undefined) && (missing5 = "executionContextCaptured"))) || ((data.steps === undefined) && (missing5 = "steps"))) || ((data.edgeItemCounts === undefined) && (missing5 = "edgeItemCounts"))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs33: any = errors;for(const key0 in data){if(!(func2.call(schema1551.oneOf[0].properties, key0))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs33 === errors){if(data.status !== undefined){let data7: any = data.status;const _errs34: any = errors;if(typeof data7 !== "string"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/0/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if("new" !== data7){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/0/properties/status/const",keyword:"const",params:{allowedValue: "new"}}];return false;}var valid13: any = _errs34 === errors;}else {var valid13: any = true;}if(valid13){if(data.workflowRunId !== undefined){const _errs36: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid13: any = _errs36 === errors;}else {var valid13: any = true;}if(valid13){if(data.sessionId !== undefined){const _errs37: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid13: any = _errs37 === errors;}else {var valid13: any = true;}if(valid13){if(data.definitionId !== undefined){const _errs38: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid13: any = _errs38 === errors;}else {var valid13: any = true;}if(valid13){if(data.workflowVersionId !== undefined){const _errs39: any = errors;if(!(validateWorkflowVersionId.call(this, data.workflowVersionId, {instancePath:instancePath+"/workflowVersionId",parentData:data,parentDataProperty:"workflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid13: any = _errs39 === errors;}else {var valid13: any = true;}if(valid13){if(data.mode !== undefined){const _errs40: any = errors;if(!(validateWorkflowRunMode.call(this, data.mode, {instancePath:instancePath+"/mode",parentData:data,parentDataProperty:"mode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunMode.errors : vErrors.concat(validateWorkflowRunMode.errors);errors = vErrors.length;}var valid13: any = _errs40 === errors;}else {var valid13: any = true;}if(valid13){if(data.triggerKind !== undefined){const _errs41: any = errors;if(!(validateWorkflowTriggerKind.call(this, data.triggerKind, {instancePath:instancePath+"/triggerKind",parentData:data,parentDataProperty:"triggerKind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowTriggerKind.errors : vErrors.concat(validateWorkflowTriggerKind.errors);errors = vErrors.length;}var valid13: any = _errs41 === errors;}else {var valid13: any = true;}if(valid13){if(data.startedBy !== undefined){const _errs42: any = errors;if(!(validateWorkflowStartedBy.call(this, data.startedBy, {instancePath:instancePath+"/startedBy",parentData:data,parentDataProperty:"startedBy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStartedBy.errors : vErrors.concat(validateWorkflowStartedBy.errors);errors = vErrors.length;}var valid13: any = _errs42 === errors;}else {var valid13: any = true;}if(valid13){if(data.keep !== undefined){const _errs43: any = errors;if(typeof data.keep !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/keep",schemaPath:"#/oneOf/0/properties/keep/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid13: any = _errs43 === errors;}else {var valid13: any = true;}if(valid13){if(data.startedAt !== undefined){const _errs45: any = errors;if(!(validateWireInstant.call(this, data.startedAt, {instancePath:instancePath+"/startedAt",parentData:data,parentDataProperty:"startedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid13: any = _errs45 === errors;}else {var valid13: any = true;}if(valid13){if(data.chainRoot !== undefined){const _errs46: any = errors;if(!(validateWorkflowChainRoot.call(this, data.chainRoot, {instancePath:instancePath+"/chainRoot",parentData:data,parentDataProperty:"chainRoot",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainRoot.errors : vErrors.concat(validateWorkflowChainRoot.errors);errors = vErrors.length;}var valid13: any = _errs46 === errors;}else {var valid13: any = true;}if(valid13){if(data.executionContextCaptured !== undefined){const _errs47: any = errors;if(typeof data.executionContextCaptured !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/executionContextCaptured",schemaPath:"#/oneOf/0/properties/executionContextCaptured/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid13: any = _errs47 === errors;}else {var valid13: any = true;}if(valid13){if(data.fixSessionId !== undefined){const _errs49: any = errors;if(!(validateSessionId.call(this, data.fixSessionId, {instancePath:instancePath+"/fixSessionId",parentData:data,parentDataProperty:"fixSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid13: any = _errs49 === errors;}else {var valid13: any = true;}if(valid13){if(data.steps !== undefined){let data20: any = data.steps;const _errs50: any = errors;if(errors === _errs50){if(Array.isArray(data20)){var valid14: any = true;const len1: any = data20.length;for(let i1=0; i1<len1; i1++){const _errs52: any = errors;if(!(validateWorkflowStep.call(this, data20[i1], {instancePath:instancePath+"/steps/" + i1,parentData:data20,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStep.errors : vErrors.concat(validateWorkflowStep.errors);errors = vErrors.length;}var valid14: any = _errs52 === errors;if(!valid14){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/steps",schemaPath:"#/oneOf/0/properties/steps/type",keyword:"type",params:{type: "array"}}];return false;}}var valid13: any = _errs50 === errors;}else {var valid13: any = true;}if(valid13){if(data.cost !== undefined){const _errs53: any = errors;if(!(validateWorkflowCost.call(this, data.cost, {instancePath:instancePath+"/cost",parentData:data,parentDataProperty:"cost",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowCost.errors : vErrors.concat(validateWorkflowCost.errors);errors = vErrors.length;}var valid13: any = _errs53 === errors;}else {var valid13: any = true;}if(valid13){if(data.edgeItemCounts !== undefined){let data23: any = data.edgeItemCounts;const _errs54: any = errors;if(errors === _errs54){if(Array.isArray(data23)){var valid15: any = true;const len2: any = data23.length;for(let i2=0; i2<len2; i2++){const _errs56: any = errors;if(!(validateWorkflowEdgeItemCount.call(this, data23[i2], {instancePath:instancePath+"/edgeItemCounts/" + i2,parentData:data23,parentDataProperty:i2,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowEdgeItemCount.errors : vErrors.concat(validateWorkflowEdgeItemCount.errors);errors = vErrors.length;}var valid15: any = _errs56 === errors;if(!valid15){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/edgeItemCounts",schemaPath:"#/oneOf/0/properties/edgeItemCounts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid13: any = _errs54 === errors;}else {var valid13: any = true;}if(valid13){if(data.chainQuestion !== undefined){const _errs57: any = errors;if(!(validateWorkflowChainQuestion.call(this, data.chainQuestion, {instancePath:instancePath+"/chainQuestion",parentData:data,parentDataProperty:"chainQuestion",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainQuestion.errors : vErrors.concat(validateWorkflowChainQuestion.errors);errors = vErrors.length;}var valid13: any = _errs57 === errors;}else {var valid13: any = true;}if(valid13){if(data.liveStep !== undefined){const _errs58: any = errors;if(!(validateWorkflowLiveStep.call(this, data.liveStep, {instancePath:instancePath+"/liveStep",parentData:data,parentDataProperty:"liveStep",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowLiveStep.errors : vErrors.concat(validateWorkflowLiveStep.errors);errors = vErrors.length;}var valid13: any = _errs58 === errors;}else {var valid13: any = true;}if(valid13){if(data.review !== undefined){const _errs59: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/review",schemaPath:"#/oneOf/0/properties/review/not",keyword:"not",params:{}}];return false;var valid13: any = _errs59 === errors;}else {var valid13: any = true;}if(valid13){if(data.finishedAt !== undefined){const _errs62: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/finishedAt",schemaPath:"#/oneOf/0/properties/finishedAt/not",keyword:"not",params:{}}];return false;var valid13: any = _errs62 === errors;}else {var valid13: any = true;}if(valid13){if(data.error !== undefined){const _errs65: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/error",schemaPath:"#/oneOf/0/properties/error/not",keyword:"not",params:{}}];return false;var valid13: any = _errs65 === errors;}else {var valid13: any = true;}}}}}}}}}}}}}}}}}}}}}}}}else {validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid12: any = _errs31 === errors;if(props0 !== true){props0 = true;}valid11 = valid12;}else if(tag0 === "running"){const _errs68: any = errors;if(errors === _errs68){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if(((((((((((((((data.status === undefined) && (missing6 = "status")) || ((data.workflowRunId === undefined) && (missing6 = "workflowRunId"))) || ((data.sessionId === undefined) && (missing6 = "sessionId"))) || ((data.definitionId === undefined) && (missing6 = "definitionId"))) || ((data.workflowVersionId === undefined) && (missing6 = "workflowVersionId"))) || ((data.mode === undefined) && (missing6 = "mode"))) || ((data.triggerKind === undefined) && (missing6 = "triggerKind"))) || ((data.startedBy === undefined) && (missing6 = "startedBy"))) || ((data.keep === undefined) && (missing6 = "keep"))) || ((data.startedAt === undefined) && (missing6 = "startedAt"))) || ((data.chainRoot === undefined) && (missing6 = "chainRoot"))) || ((data.executionContextCaptured === undefined) && (missing6 = "executionContextCaptured"))) || ((data.steps === undefined) && (missing6 = "steps"))) || ((data.edgeItemCounts === undefined) && (missing6 = "edgeItemCounts"))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs70: any = errors;for(const key1 in data){if(!(func2.call(schema1551.oneOf[1].properties, key1))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs70 === errors){if(data.status !== undefined){let data30: any = data.status;const _errs71: any = errors;if(typeof data30 !== "string"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/1/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if("running" !== data30){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/1/properties/status/const",keyword:"const",params:{allowedValue: "running"}}];return false;}var valid17: any = _errs71 === errors;}else {var valid17: any = true;}if(valid17){if(data.workflowRunId !== undefined){const _errs73: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid17: any = _errs73 === errors;}else {var valid17: any = true;}if(valid17){if(data.sessionId !== undefined){const _errs74: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid17: any = _errs74 === errors;}else {var valid17: any = true;}if(valid17){if(data.definitionId !== undefined){const _errs75: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid17: any = _errs75 === errors;}else {var valid17: any = true;}if(valid17){if(data.workflowVersionId !== undefined){const _errs76: any = errors;if(!(validateWorkflowVersionId.call(this, data.workflowVersionId, {instancePath:instancePath+"/workflowVersionId",parentData:data,parentDataProperty:"workflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid17: any = _errs76 === errors;}else {var valid17: any = true;}if(valid17){if(data.mode !== undefined){const _errs77: any = errors;if(!(validateWorkflowRunMode.call(this, data.mode, {instancePath:instancePath+"/mode",parentData:data,parentDataProperty:"mode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunMode.errors : vErrors.concat(validateWorkflowRunMode.errors);errors = vErrors.length;}var valid17: any = _errs77 === errors;}else {var valid17: any = true;}if(valid17){if(data.triggerKind !== undefined){const _errs78: any = errors;if(!(validateWorkflowTriggerKind.call(this, data.triggerKind, {instancePath:instancePath+"/triggerKind",parentData:data,parentDataProperty:"triggerKind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowTriggerKind.errors : vErrors.concat(validateWorkflowTriggerKind.errors);errors = vErrors.length;}var valid17: any = _errs78 === errors;}else {var valid17: any = true;}if(valid17){if(data.startedBy !== undefined){const _errs79: any = errors;if(!(validateWorkflowStartedBy.call(this, data.startedBy, {instancePath:instancePath+"/startedBy",parentData:data,parentDataProperty:"startedBy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStartedBy.errors : vErrors.concat(validateWorkflowStartedBy.errors);errors = vErrors.length;}var valid17: any = _errs79 === errors;}else {var valid17: any = true;}if(valid17){if(data.keep !== undefined){const _errs80: any = errors;if(typeof data.keep !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/keep",schemaPath:"#/oneOf/1/properties/keep/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid17: any = _errs80 === errors;}else {var valid17: any = true;}if(valid17){if(data.startedAt !== undefined){const _errs82: any = errors;if(!(validateWireInstant.call(this, data.startedAt, {instancePath:instancePath+"/startedAt",parentData:data,parentDataProperty:"startedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid17: any = _errs82 === errors;}else {var valid17: any = true;}if(valid17){if(data.chainRoot !== undefined){const _errs83: any = errors;if(!(validateWorkflowChainRoot.call(this, data.chainRoot, {instancePath:instancePath+"/chainRoot",parentData:data,parentDataProperty:"chainRoot",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainRoot.errors : vErrors.concat(validateWorkflowChainRoot.errors);errors = vErrors.length;}var valid17: any = _errs83 === errors;}else {var valid17: any = true;}if(valid17){if(data.executionContextCaptured !== undefined){const _errs84: any = errors;if(typeof data.executionContextCaptured !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/executionContextCaptured",schemaPath:"#/oneOf/1/properties/executionContextCaptured/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid17: any = _errs84 === errors;}else {var valid17: any = true;}if(valid17){if(data.fixSessionId !== undefined){const _errs86: any = errors;if(!(validateSessionId.call(this, data.fixSessionId, {instancePath:instancePath+"/fixSessionId",parentData:data,parentDataProperty:"fixSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid17: any = _errs86 === errors;}else {var valid17: any = true;}if(valid17){if(data.steps !== undefined){let data43: any = data.steps;const _errs87: any = errors;if(errors === _errs87){if(Array.isArray(data43)){var valid18: any = true;const len3: any = data43.length;for(let i3=0; i3<len3; i3++){const _errs89: any = errors;if(!(validateWorkflowStep.call(this, data43[i3], {instancePath:instancePath+"/steps/" + i3,parentData:data43,parentDataProperty:i3,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStep.errors : vErrors.concat(validateWorkflowStep.errors);errors = vErrors.length;}var valid18: any = _errs89 === errors;if(!valid18){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/steps",schemaPath:"#/oneOf/1/properties/steps/type",keyword:"type",params:{type: "array"}}];return false;}}var valid17: any = _errs87 === errors;}else {var valid17: any = true;}if(valid17){if(data.cost !== undefined){const _errs90: any = errors;if(!(validateWorkflowCost.call(this, data.cost, {instancePath:instancePath+"/cost",parentData:data,parentDataProperty:"cost",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowCost.errors : vErrors.concat(validateWorkflowCost.errors);errors = vErrors.length;}var valid17: any = _errs90 === errors;}else {var valid17: any = true;}if(valid17){if(data.edgeItemCounts !== undefined){let data46: any = data.edgeItemCounts;const _errs91: any = errors;if(errors === _errs91){if(Array.isArray(data46)){var valid19: any = true;const len4: any = data46.length;for(let i4=0; i4<len4; i4++){const _errs93: any = errors;if(!(validateWorkflowEdgeItemCount.call(this, data46[i4], {instancePath:instancePath+"/edgeItemCounts/" + i4,parentData:data46,parentDataProperty:i4,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowEdgeItemCount.errors : vErrors.concat(validateWorkflowEdgeItemCount.errors);errors = vErrors.length;}var valid19: any = _errs93 === errors;if(!valid19){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/edgeItemCounts",schemaPath:"#/oneOf/1/properties/edgeItemCounts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid17: any = _errs91 === errors;}else {var valid17: any = true;}if(valid17){if(data.chainQuestion !== undefined){const _errs94: any = errors;if(!(validateWorkflowChainQuestion.call(this, data.chainQuestion, {instancePath:instancePath+"/chainQuestion",parentData:data,parentDataProperty:"chainQuestion",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainQuestion.errors : vErrors.concat(validateWorkflowChainQuestion.errors);errors = vErrors.length;}var valid17: any = _errs94 === errors;}else {var valid17: any = true;}if(valid17){if(data.liveStep !== undefined){const _errs95: any = errors;if(!(validateWorkflowLiveStep.call(this, data.liveStep, {instancePath:instancePath+"/liveStep",parentData:data,parentDataProperty:"liveStep",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowLiveStep.errors : vErrors.concat(validateWorkflowLiveStep.errors);errors = vErrors.length;}var valid17: any = _errs95 === errors;}else {var valid17: any = true;}if(valid17){if(data.review !== undefined){const _errs96: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/review",schemaPath:"#/oneOf/1/properties/review/not",keyword:"not",params:{}}];return false;var valid17: any = _errs96 === errors;}else {var valid17: any = true;}if(valid17){if(data.finishedAt !== undefined){const _errs99: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/finishedAt",schemaPath:"#/oneOf/1/properties/finishedAt/not",keyword:"not",params:{}}];return false;var valid17: any = _errs99 === errors;}else {var valid17: any = true;}if(valid17){if(data.error !== undefined){const _errs102: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/error",schemaPath:"#/oneOf/1/properties/error/not",keyword:"not",params:{}}];return false;var valid17: any = _errs102 === errors;}else {var valid17: any = true;}}}}}}}}}}}}}}}}}}}}}}}}else {validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid16: any = _errs68 === errors;if(props0 !== true){props0 = true;}valid11 = valid16;}else if(tag0 === "waiting"){const _errs105: any = errors;if(errors === _errs105){if(data && typeof data == "object" && !Array.isArray(data)){let missing7: any;if(((((((((((((((data.status === undefined) && (missing7 = "status")) || ((data.workflowRunId === undefined) && (missing7 = "workflowRunId"))) || ((data.sessionId === undefined) && (missing7 = "sessionId"))) || ((data.definitionId === undefined) && (missing7 = "definitionId"))) || ((data.workflowVersionId === undefined) && (missing7 = "workflowVersionId"))) || ((data.mode === undefined) && (missing7 = "mode"))) || ((data.triggerKind === undefined) && (missing7 = "triggerKind"))) || ((data.startedBy === undefined) && (missing7 = "startedBy"))) || ((data.keep === undefined) && (missing7 = "keep"))) || ((data.startedAt === undefined) && (missing7 = "startedAt"))) || ((data.chainRoot === undefined) && (missing7 = "chainRoot"))) || ((data.executionContextCaptured === undefined) && (missing7 = "executionContextCaptured"))) || ((data.steps === undefined) && (missing7 = "steps"))) || ((data.edgeItemCounts === undefined) && (missing7 = "edgeItemCounts"))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing7}}];return false;}else {const _errs107: any = errors;for(const key2 in data){if(!(func2.call(schema1551.oneOf[2].properties, key2))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs107 === errors){if(data.status !== undefined){let data53: any = data.status;const _errs108: any = errors;if(typeof data53 !== "string"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/2/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if("waiting" !== data53){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/2/properties/status/const",keyword:"const",params:{allowedValue: "waiting"}}];return false;}var valid21: any = _errs108 === errors;}else {var valid21: any = true;}if(valid21){if(data.workflowRunId !== undefined){const _errs110: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid21: any = _errs110 === errors;}else {var valid21: any = true;}if(valid21){if(data.sessionId !== undefined){const _errs111: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid21: any = _errs111 === errors;}else {var valid21: any = true;}if(valid21){if(data.definitionId !== undefined){const _errs112: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid21: any = _errs112 === errors;}else {var valid21: any = true;}if(valid21){if(data.workflowVersionId !== undefined){const _errs113: any = errors;if(!(validateWorkflowVersionId.call(this, data.workflowVersionId, {instancePath:instancePath+"/workflowVersionId",parentData:data,parentDataProperty:"workflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid21: any = _errs113 === errors;}else {var valid21: any = true;}if(valid21){if(data.mode !== undefined){const _errs114: any = errors;if(!(validateWorkflowRunMode.call(this, data.mode, {instancePath:instancePath+"/mode",parentData:data,parentDataProperty:"mode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunMode.errors : vErrors.concat(validateWorkflowRunMode.errors);errors = vErrors.length;}var valid21: any = _errs114 === errors;}else {var valid21: any = true;}if(valid21){if(data.triggerKind !== undefined){const _errs115: any = errors;if(!(validateWorkflowTriggerKind.call(this, data.triggerKind, {instancePath:instancePath+"/triggerKind",parentData:data,parentDataProperty:"triggerKind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowTriggerKind.errors : vErrors.concat(validateWorkflowTriggerKind.errors);errors = vErrors.length;}var valid21: any = _errs115 === errors;}else {var valid21: any = true;}if(valid21){if(data.startedBy !== undefined){const _errs116: any = errors;if(!(validateWorkflowStartedBy.call(this, data.startedBy, {instancePath:instancePath+"/startedBy",parentData:data,parentDataProperty:"startedBy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStartedBy.errors : vErrors.concat(validateWorkflowStartedBy.errors);errors = vErrors.length;}var valid21: any = _errs116 === errors;}else {var valid21: any = true;}if(valid21){if(data.keep !== undefined){const _errs117: any = errors;if(typeof data.keep !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/keep",schemaPath:"#/oneOf/2/properties/keep/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid21: any = _errs117 === errors;}else {var valid21: any = true;}if(valid21){if(data.startedAt !== undefined){const _errs119: any = errors;if(!(validateWireInstant.call(this, data.startedAt, {instancePath:instancePath+"/startedAt",parentData:data,parentDataProperty:"startedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid21: any = _errs119 === errors;}else {var valid21: any = true;}if(valid21){if(data.chainRoot !== undefined){const _errs120: any = errors;if(!(validateWorkflowChainRoot.call(this, data.chainRoot, {instancePath:instancePath+"/chainRoot",parentData:data,parentDataProperty:"chainRoot",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainRoot.errors : vErrors.concat(validateWorkflowChainRoot.errors);errors = vErrors.length;}var valid21: any = _errs120 === errors;}else {var valid21: any = true;}if(valid21){if(data.executionContextCaptured !== undefined){const _errs121: any = errors;if(typeof data.executionContextCaptured !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/executionContextCaptured",schemaPath:"#/oneOf/2/properties/executionContextCaptured/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid21: any = _errs121 === errors;}else {var valid21: any = true;}if(valid21){if(data.fixSessionId !== undefined){const _errs123: any = errors;if(!(validateSessionId.call(this, data.fixSessionId, {instancePath:instancePath+"/fixSessionId",parentData:data,parentDataProperty:"fixSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid21: any = _errs123 === errors;}else {var valid21: any = true;}if(valid21){if(data.steps !== undefined){let data66: any = data.steps;const _errs124: any = errors;if(errors === _errs124){if(Array.isArray(data66)){var valid22: any = true;const len5: any = data66.length;for(let i5=0; i5<len5; i5++){const _errs126: any = errors;if(!(validateWorkflowStep.call(this, data66[i5], {instancePath:instancePath+"/steps/" + i5,parentData:data66,parentDataProperty:i5,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStep.errors : vErrors.concat(validateWorkflowStep.errors);errors = vErrors.length;}var valid22: any = _errs126 === errors;if(!valid22){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/steps",schemaPath:"#/oneOf/2/properties/steps/type",keyword:"type",params:{type: "array"}}];return false;}}var valid21: any = _errs124 === errors;}else {var valid21: any = true;}if(valid21){if(data.cost !== undefined){const _errs127: any = errors;if(!(validateWorkflowCost.call(this, data.cost, {instancePath:instancePath+"/cost",parentData:data,parentDataProperty:"cost",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowCost.errors : vErrors.concat(validateWorkflowCost.errors);errors = vErrors.length;}var valid21: any = _errs127 === errors;}else {var valid21: any = true;}if(valid21){if(data.edgeItemCounts !== undefined){let data69: any = data.edgeItemCounts;const _errs128: any = errors;if(errors === _errs128){if(Array.isArray(data69)){var valid23: any = true;const len6: any = data69.length;for(let i6=0; i6<len6; i6++){const _errs130: any = errors;if(!(validateWorkflowEdgeItemCount.call(this, data69[i6], {instancePath:instancePath+"/edgeItemCounts/" + i6,parentData:data69,parentDataProperty:i6,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowEdgeItemCount.errors : vErrors.concat(validateWorkflowEdgeItemCount.errors);errors = vErrors.length;}var valid23: any = _errs130 === errors;if(!valid23){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/edgeItemCounts",schemaPath:"#/oneOf/2/properties/edgeItemCounts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid21: any = _errs128 === errors;}else {var valid21: any = true;}if(valid21){if(data.chainQuestion !== undefined){const _errs131: any = errors;if(!(validateWorkflowChainQuestion.call(this, data.chainQuestion, {instancePath:instancePath+"/chainQuestion",parentData:data,parentDataProperty:"chainQuestion",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainQuestion.errors : vErrors.concat(validateWorkflowChainQuestion.errors);errors = vErrors.length;}var valid21: any = _errs131 === errors;}else {var valid21: any = true;}if(valid21){if(data.liveStep !== undefined){const _errs132: any = errors;if(!(validateWorkflowLiveStep.call(this, data.liveStep, {instancePath:instancePath+"/liveStep",parentData:data,parentDataProperty:"liveStep",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowLiveStep.errors : vErrors.concat(validateWorkflowLiveStep.errors);errors = vErrors.length;}var valid21: any = _errs132 === errors;}else {var valid21: any = true;}if(valid21){if(data.review !== undefined){const _errs133: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/review",schemaPath:"#/oneOf/2/properties/review/not",keyword:"not",params:{}}];return false;var valid21: any = _errs133 === errors;}else {var valid21: any = true;}if(valid21){if(data.finishedAt !== undefined){const _errs136: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/finishedAt",schemaPath:"#/oneOf/2/properties/finishedAt/not",keyword:"not",params:{}}];return false;var valid21: any = _errs136 === errors;}else {var valid21: any = true;}if(valid21){if(data.error !== undefined){const _errs139: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/error",schemaPath:"#/oneOf/2/properties/error/not",keyword:"not",params:{}}];return false;var valid21: any = _errs139 === errors;}else {var valid21: any = true;}}}}}}}}}}}}}}}}}}}}}}}}else {validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid20: any = _errs105 === errors;if(props0 !== true){props0 = true;}valid11 = valid20;}else if(tag0 === "succeeded"){const _errs142: any = errors;if(errors === _errs142){if(data && typeof data == "object" && !Array.isArray(data)){let missing8: any;if((((((((((((((((data.status === undefined) && (missing8 = "status")) || ((data.workflowRunId === undefined) && (missing8 = "workflowRunId"))) || ((data.sessionId === undefined) && (missing8 = "sessionId"))) || ((data.definitionId === undefined) && (missing8 = "definitionId"))) || ((data.workflowVersionId === undefined) && (missing8 = "workflowVersionId"))) || ((data.mode === undefined) && (missing8 = "mode"))) || ((data.triggerKind === undefined) && (missing8 = "triggerKind"))) || ((data.startedBy === undefined) && (missing8 = "startedBy"))) || ((data.keep === undefined) && (missing8 = "keep"))) || ((data.startedAt === undefined) && (missing8 = "startedAt"))) || ((data.chainRoot === undefined) && (missing8 = "chainRoot"))) || ((data.executionContextCaptured === undefined) && (missing8 = "executionContextCaptured"))) || ((data.steps === undefined) && (missing8 = "steps"))) || ((data.edgeItemCounts === undefined) && (missing8 = "edgeItemCounts"))) || ((data.finishedAt === undefined) && (missing8 = "finishedAt"))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing8}}];return false;}else {const _errs144: any = errors;for(const key3 in data){if(!(func2.call(schema1551.oneOf[3].properties, key3))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs144 === errors){if(data.status !== undefined){let data76: any = data.status;const _errs145: any = errors;if(typeof data76 !== "string"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/3/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if("succeeded" !== data76){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/3/properties/status/const",keyword:"const",params:{allowedValue: "succeeded"}}];return false;}var valid25: any = _errs145 === errors;}else {var valid25: any = true;}if(valid25){if(data.workflowRunId !== undefined){const _errs147: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid25: any = _errs147 === errors;}else {var valid25: any = true;}if(valid25){if(data.sessionId !== undefined){const _errs148: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid25: any = _errs148 === errors;}else {var valid25: any = true;}if(valid25){if(data.definitionId !== undefined){const _errs149: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid25: any = _errs149 === errors;}else {var valid25: any = true;}if(valid25){if(data.workflowVersionId !== undefined){const _errs150: any = errors;if(!(validateWorkflowVersionId.call(this, data.workflowVersionId, {instancePath:instancePath+"/workflowVersionId",parentData:data,parentDataProperty:"workflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid25: any = _errs150 === errors;}else {var valid25: any = true;}if(valid25){if(data.mode !== undefined){const _errs151: any = errors;if(!(validateWorkflowRunMode.call(this, data.mode, {instancePath:instancePath+"/mode",parentData:data,parentDataProperty:"mode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunMode.errors : vErrors.concat(validateWorkflowRunMode.errors);errors = vErrors.length;}var valid25: any = _errs151 === errors;}else {var valid25: any = true;}if(valid25){if(data.triggerKind !== undefined){const _errs152: any = errors;if(!(validateWorkflowTriggerKind.call(this, data.triggerKind, {instancePath:instancePath+"/triggerKind",parentData:data,parentDataProperty:"triggerKind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowTriggerKind.errors : vErrors.concat(validateWorkflowTriggerKind.errors);errors = vErrors.length;}var valid25: any = _errs152 === errors;}else {var valid25: any = true;}if(valid25){if(data.startedBy !== undefined){const _errs153: any = errors;if(!(validateWorkflowStartedBy.call(this, data.startedBy, {instancePath:instancePath+"/startedBy",parentData:data,parentDataProperty:"startedBy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStartedBy.errors : vErrors.concat(validateWorkflowStartedBy.errors);errors = vErrors.length;}var valid25: any = _errs153 === errors;}else {var valid25: any = true;}if(valid25){if(data.keep !== undefined){const _errs154: any = errors;if(typeof data.keep !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/keep",schemaPath:"#/oneOf/3/properties/keep/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid25: any = _errs154 === errors;}else {var valid25: any = true;}if(valid25){if(data.startedAt !== undefined){const _errs156: any = errors;if(!(validateWireInstant.call(this, data.startedAt, {instancePath:instancePath+"/startedAt",parentData:data,parentDataProperty:"startedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid25: any = _errs156 === errors;}else {var valid25: any = true;}if(valid25){if(data.chainRoot !== undefined){const _errs157: any = errors;if(!(validateWorkflowChainRoot.call(this, data.chainRoot, {instancePath:instancePath+"/chainRoot",parentData:data,parentDataProperty:"chainRoot",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainRoot.errors : vErrors.concat(validateWorkflowChainRoot.errors);errors = vErrors.length;}var valid25: any = _errs157 === errors;}else {var valid25: any = true;}if(valid25){if(data.executionContextCaptured !== undefined){const _errs158: any = errors;if(typeof data.executionContextCaptured !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/executionContextCaptured",schemaPath:"#/oneOf/3/properties/executionContextCaptured/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid25: any = _errs158 === errors;}else {var valid25: any = true;}if(valid25){if(data.fixSessionId !== undefined){const _errs160: any = errors;if(!(validateSessionId.call(this, data.fixSessionId, {instancePath:instancePath+"/fixSessionId",parentData:data,parentDataProperty:"fixSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid25: any = _errs160 === errors;}else {var valid25: any = true;}if(valid25){if(data.steps !== undefined){let data89: any = data.steps;const _errs161: any = errors;if(errors === _errs161){if(Array.isArray(data89)){var valid26: any = true;const len7: any = data89.length;for(let i7=0; i7<len7; i7++){const _errs163: any = errors;if(!(validateWorkflowStep.call(this, data89[i7], {instancePath:instancePath+"/steps/" + i7,parentData:data89,parentDataProperty:i7,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStep.errors : vErrors.concat(validateWorkflowStep.errors);errors = vErrors.length;}var valid26: any = _errs163 === errors;if(!valid26){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/steps",schemaPath:"#/oneOf/3/properties/steps/type",keyword:"type",params:{type: "array"}}];return false;}}var valid25: any = _errs161 === errors;}else {var valid25: any = true;}if(valid25){if(data.cost !== undefined){const _errs164: any = errors;if(!(validateWorkflowCost.call(this, data.cost, {instancePath:instancePath+"/cost",parentData:data,parentDataProperty:"cost",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowCost.errors : vErrors.concat(validateWorkflowCost.errors);errors = vErrors.length;}var valid25: any = _errs164 === errors;}else {var valid25: any = true;}if(valid25){if(data.edgeItemCounts !== undefined){let data92: any = data.edgeItemCounts;const _errs165: any = errors;if(errors === _errs165){if(Array.isArray(data92)){var valid27: any = true;const len8: any = data92.length;for(let i8=0; i8<len8; i8++){const _errs167: any = errors;if(!(validateWorkflowEdgeItemCount.call(this, data92[i8], {instancePath:instancePath+"/edgeItemCounts/" + i8,parentData:data92,parentDataProperty:i8,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowEdgeItemCount.errors : vErrors.concat(validateWorkflowEdgeItemCount.errors);errors = vErrors.length;}var valid27: any = _errs167 === errors;if(!valid27){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/edgeItemCounts",schemaPath:"#/oneOf/3/properties/edgeItemCounts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid25: any = _errs165 === errors;}else {var valid25: any = true;}if(valid25){if(data.chainQuestion !== undefined){const _errs168: any = errors;if(!(validateWorkflowChainQuestion.call(this, data.chainQuestion, {instancePath:instancePath+"/chainQuestion",parentData:data,parentDataProperty:"chainQuestion",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainQuestion.errors : vErrors.concat(validateWorkflowChainQuestion.errors);errors = vErrors.length;}var valid25: any = _errs168 === errors;}else {var valid25: any = true;}if(valid25){if(data.liveStep !== undefined){const _errs169: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/liveStep",schemaPath:"#/oneOf/3/properties/liveStep/not",keyword:"not",params:{}}];return false;var valid25: any = _errs169 === errors;}else {var valid25: any = true;}if(valid25){if(data.review !== undefined){const _errs172: any = errors;if(!(validateWorkflowRunReview.call(this, data.review, {instancePath:instancePath+"/review",parentData:data,parentDataProperty:"review",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunReview.errors : vErrors.concat(validateWorkflowRunReview.errors);errors = vErrors.length;}var valid25: any = _errs172 === errors;}else {var valid25: any = true;}if(valid25){if(data.finishedAt !== undefined){const _errs173: any = errors;if(!(validateWireInstant.call(this, data.finishedAt, {instancePath:instancePath+"/finishedAt",parentData:data,parentDataProperty:"finishedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid25: any = _errs173 === errors;}else {var valid25: any = true;}if(valid25){if(data.error !== undefined){const _errs174: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/error",schemaPath:"#/oneOf/3/properties/error/not",keyword:"not",params:{}}];return false;var valid25: any = _errs174 === errors;}else {var valid25: any = true;}}}}}}}}}}}}}}}}}}}}}}}}else {validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid24: any = _errs142 === errors;if(props0 !== true){props0 = true;}valid11 = valid24;}else if(tag0 === "failed"){const _errs177: any = errors;if(errors === _errs177){if(data && typeof data == "object" && !Array.isArray(data)){let missing9: any;if(((((((((((((((data.status === undefined) && (missing9 = "status")) || ((data.workflowRunId === undefined) && (missing9 = "workflowRunId"))) || ((data.sessionId === undefined) && (missing9 = "sessionId"))) || ((data.definitionId === undefined) && (missing9 = "definitionId"))) || ((data.workflowVersionId === undefined) && (missing9 = "workflowVersionId"))) || ((data.mode === undefined) && (missing9 = "mode"))) || ((data.triggerKind === undefined) && (missing9 = "triggerKind"))) || ((data.startedBy === undefined) && (missing9 = "startedBy"))) || ((data.keep === undefined) && (missing9 = "keep"))) || ((data.startedAt === undefined) && (missing9 = "startedAt"))) || ((data.chainRoot === undefined) && (missing9 = "chainRoot"))) || ((data.executionContextCaptured === undefined) && (missing9 = "executionContextCaptured"))) || ((data.steps === undefined) && (missing9 = "steps"))) || ((data.edgeItemCounts === undefined) && (missing9 = "edgeItemCounts"))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing9}}];return false;}else {const _errs179: any = errors;for(const key4 in data){if(!(func2.call(schema1551.oneOf[4].properties, key4))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs179 === errors){if(data.status !== undefined){let data99: any = data.status;const _errs180: any = errors;if(typeof data99 !== "string"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/4/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data99){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/4/properties/status/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}var valid29: any = _errs180 === errors;}else {var valid29: any = true;}if(valid29){if(data.workflowRunId !== undefined){const _errs182: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid29: any = _errs182 === errors;}else {var valid29: any = true;}if(valid29){if(data.sessionId !== undefined){const _errs183: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid29: any = _errs183 === errors;}else {var valid29: any = true;}if(valid29){if(data.definitionId !== undefined){const _errs184: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid29: any = _errs184 === errors;}else {var valid29: any = true;}if(valid29){if(data.workflowVersionId !== undefined){const _errs185: any = errors;if(!(validateWorkflowVersionId.call(this, data.workflowVersionId, {instancePath:instancePath+"/workflowVersionId",parentData:data,parentDataProperty:"workflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid29: any = _errs185 === errors;}else {var valid29: any = true;}if(valid29){if(data.mode !== undefined){const _errs186: any = errors;if(!(validateWorkflowRunMode.call(this, data.mode, {instancePath:instancePath+"/mode",parentData:data,parentDataProperty:"mode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunMode.errors : vErrors.concat(validateWorkflowRunMode.errors);errors = vErrors.length;}var valid29: any = _errs186 === errors;}else {var valid29: any = true;}if(valid29){if(data.triggerKind !== undefined){const _errs187: any = errors;if(!(validateWorkflowTriggerKind.call(this, data.triggerKind, {instancePath:instancePath+"/triggerKind",parentData:data,parentDataProperty:"triggerKind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowTriggerKind.errors : vErrors.concat(validateWorkflowTriggerKind.errors);errors = vErrors.length;}var valid29: any = _errs187 === errors;}else {var valid29: any = true;}if(valid29){if(data.startedBy !== undefined){const _errs188: any = errors;if(!(validateWorkflowStartedBy.call(this, data.startedBy, {instancePath:instancePath+"/startedBy",parentData:data,parentDataProperty:"startedBy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStartedBy.errors : vErrors.concat(validateWorkflowStartedBy.errors);errors = vErrors.length;}var valid29: any = _errs188 === errors;}else {var valid29: any = true;}if(valid29){if(data.keep !== undefined){const _errs189: any = errors;if(typeof data.keep !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/keep",schemaPath:"#/oneOf/4/properties/keep/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid29: any = _errs189 === errors;}else {var valid29: any = true;}if(valid29){if(data.startedAt !== undefined){const _errs191: any = errors;if(!(validateWireInstant.call(this, data.startedAt, {instancePath:instancePath+"/startedAt",parentData:data,parentDataProperty:"startedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid29: any = _errs191 === errors;}else {var valid29: any = true;}if(valid29){if(data.chainRoot !== undefined){const _errs192: any = errors;if(!(validateWorkflowChainRoot.call(this, data.chainRoot, {instancePath:instancePath+"/chainRoot",parentData:data,parentDataProperty:"chainRoot",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainRoot.errors : vErrors.concat(validateWorkflowChainRoot.errors);errors = vErrors.length;}var valid29: any = _errs192 === errors;}else {var valid29: any = true;}if(valid29){if(data.executionContextCaptured !== undefined){const _errs193: any = errors;if(typeof data.executionContextCaptured !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/executionContextCaptured",schemaPath:"#/oneOf/4/properties/executionContextCaptured/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid29: any = _errs193 === errors;}else {var valid29: any = true;}if(valid29){if(data.fixSessionId !== undefined){const _errs195: any = errors;if(!(validateSessionId.call(this, data.fixSessionId, {instancePath:instancePath+"/fixSessionId",parentData:data,parentDataProperty:"fixSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid29: any = _errs195 === errors;}else {var valid29: any = true;}if(valid29){if(data.steps !== undefined){let data112: any = data.steps;const _errs196: any = errors;if(errors === _errs196){if(Array.isArray(data112)){var valid30: any = true;const len9: any = data112.length;for(let i9=0; i9<len9; i9++){const _errs198: any = errors;if(!(validateWorkflowStep.call(this, data112[i9], {instancePath:instancePath+"/steps/" + i9,parentData:data112,parentDataProperty:i9,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStep.errors : vErrors.concat(validateWorkflowStep.errors);errors = vErrors.length;}var valid30: any = _errs198 === errors;if(!valid30){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/steps",schemaPath:"#/oneOf/4/properties/steps/type",keyword:"type",params:{type: "array"}}];return false;}}var valid29: any = _errs196 === errors;}else {var valid29: any = true;}if(valid29){if(data.cost !== undefined){const _errs199: any = errors;if(!(validateWorkflowCost.call(this, data.cost, {instancePath:instancePath+"/cost",parentData:data,parentDataProperty:"cost",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowCost.errors : vErrors.concat(validateWorkflowCost.errors);errors = vErrors.length;}var valid29: any = _errs199 === errors;}else {var valid29: any = true;}if(valid29){if(data.edgeItemCounts !== undefined){let data115: any = data.edgeItemCounts;const _errs200: any = errors;if(errors === _errs200){if(Array.isArray(data115)){var valid31: any = true;const len10: any = data115.length;for(let i10=0; i10<len10; i10++){const _errs202: any = errors;if(!(validateWorkflowEdgeItemCount.call(this, data115[i10], {instancePath:instancePath+"/edgeItemCounts/" + i10,parentData:data115,parentDataProperty:i10,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowEdgeItemCount.errors : vErrors.concat(validateWorkflowEdgeItemCount.errors);errors = vErrors.length;}var valid31: any = _errs202 === errors;if(!valid31){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/edgeItemCounts",schemaPath:"#/oneOf/4/properties/edgeItemCounts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid29: any = _errs200 === errors;}else {var valid29: any = true;}if(valid29){if(data.chainQuestion !== undefined){const _errs203: any = errors;if(!(validateWorkflowChainQuestion.call(this, data.chainQuestion, {instancePath:instancePath+"/chainQuestion",parentData:data,parentDataProperty:"chainQuestion",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainQuestion.errors : vErrors.concat(validateWorkflowChainQuestion.errors);errors = vErrors.length;}var valid29: any = _errs203 === errors;}else {var valid29: any = true;}if(valid29){if(data.liveStep !== undefined){const _errs204: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/liveStep",schemaPath:"#/oneOf/4/properties/liveStep/not",keyword:"not",params:{}}];return false;var valid29: any = _errs204 === errors;}else {var valid29: any = true;}if(valid29){if(data.review !== undefined){const _errs207: any = errors;if(!(validateWorkflowRunReview.call(this, data.review, {instancePath:instancePath+"/review",parentData:data,parentDataProperty:"review",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunReview.errors : vErrors.concat(validateWorkflowRunReview.errors);errors = vErrors.length;}var valid29: any = _errs207 === errors;}else {var valid29: any = true;}if(valid29){if(data.finishedAt !== undefined){const _errs208: any = errors;if(!(validateWireInstant.call(this, data.finishedAt, {instancePath:instancePath+"/finishedAt",parentData:data,parentDataProperty:"finishedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid29: any = _errs208 === errors;}else {var valid29: any = true;}if(valid29){if(data.error !== undefined){const _errs209: any = errors;if(!(validateWorkflowStepError.call(this, data.error, {instancePath:instancePath+"/error",parentData:data,parentDataProperty:"error",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStepError.errors : vErrors.concat(validateWorkflowStepError.errors);errors = vErrors.length;}var valid29: any = _errs209 === errors;}else {var valid29: any = true;}}}}}}}}}}}}}}}}}}}}}}}}else {validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}var valid28: any = _errs177 === errors;if(props0 !== true){props0 = true;}valid11 = valid28;}else if(tag0 === "canceled"){const _errs210: any = errors;if(errors === _errs210){if(data && typeof data == "object" && !Array.isArray(data)){let missing10: any;if((((((((((((((((data.status === undefined) && (missing10 = "status")) || ((data.workflowRunId === undefined) && (missing10 = "workflowRunId"))) || ((data.sessionId === undefined) && (missing10 = "sessionId"))) || ((data.definitionId === undefined) && (missing10 = "definitionId"))) || ((data.workflowVersionId === undefined) && (missing10 = "workflowVersionId"))) || ((data.mode === undefined) && (missing10 = "mode"))) || ((data.triggerKind === undefined) && (missing10 = "triggerKind"))) || ((data.startedBy === undefined) && (missing10 = "startedBy"))) || ((data.keep === undefined) && (missing10 = "keep"))) || ((data.startedAt === undefined) && (missing10 = "startedAt"))) || ((data.chainRoot === undefined) && (missing10 = "chainRoot"))) || ((data.executionContextCaptured === undefined) && (missing10 = "executionContextCaptured"))) || ((data.steps === undefined) && (missing10 = "steps"))) || ((data.edgeItemCounts === undefined) && (missing10 = "edgeItemCounts"))) || ((data.finishedAt === undefined) && (missing10 = "finishedAt"))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing10}}];return false;}else {const _errs212: any = errors;for(const key5 in data){if(!(func2.call(schema1551.oneOf[5].properties, key5))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs212 === errors){if(data.status !== undefined){let data122: any = data.status;const _errs213: any = errors;if(typeof data122 !== "string"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/5/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if("canceled" !== data122){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/5/properties/status/const",keyword:"const",params:{allowedValue: "canceled"}}];return false;}var valid33: any = _errs213 === errors;}else {var valid33: any = true;}if(valid33){if(data.workflowRunId !== undefined){const _errs215: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid33: any = _errs215 === errors;}else {var valid33: any = true;}if(valid33){if(data.sessionId !== undefined){const _errs216: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid33: any = _errs216 === errors;}else {var valid33: any = true;}if(valid33){if(data.definitionId !== undefined){const _errs217: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid33: any = _errs217 === errors;}else {var valid33: any = true;}if(valid33){if(data.workflowVersionId !== undefined){const _errs218: any = errors;if(!(validateWorkflowVersionId.call(this, data.workflowVersionId, {instancePath:instancePath+"/workflowVersionId",parentData:data,parentDataProperty:"workflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid33: any = _errs218 === errors;}else {var valid33: any = true;}if(valid33){if(data.mode !== undefined){const _errs219: any = errors;if(!(validateWorkflowRunMode.call(this, data.mode, {instancePath:instancePath+"/mode",parentData:data,parentDataProperty:"mode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunMode.errors : vErrors.concat(validateWorkflowRunMode.errors);errors = vErrors.length;}var valid33: any = _errs219 === errors;}else {var valid33: any = true;}if(valid33){if(data.triggerKind !== undefined){const _errs220: any = errors;if(!(validateWorkflowTriggerKind.call(this, data.triggerKind, {instancePath:instancePath+"/triggerKind",parentData:data,parentDataProperty:"triggerKind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowTriggerKind.errors : vErrors.concat(validateWorkflowTriggerKind.errors);errors = vErrors.length;}var valid33: any = _errs220 === errors;}else {var valid33: any = true;}if(valid33){if(data.startedBy !== undefined){const _errs221: any = errors;if(!(validateWorkflowStartedBy.call(this, data.startedBy, {instancePath:instancePath+"/startedBy",parentData:data,parentDataProperty:"startedBy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStartedBy.errors : vErrors.concat(validateWorkflowStartedBy.errors);errors = vErrors.length;}var valid33: any = _errs221 === errors;}else {var valid33: any = true;}if(valid33){if(data.keep !== undefined){const _errs222: any = errors;if(typeof data.keep !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/keep",schemaPath:"#/oneOf/5/properties/keep/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid33: any = _errs222 === errors;}else {var valid33: any = true;}if(valid33){if(data.startedAt !== undefined){const _errs224: any = errors;if(!(validateWireInstant.call(this, data.startedAt, {instancePath:instancePath+"/startedAt",parentData:data,parentDataProperty:"startedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid33: any = _errs224 === errors;}else {var valid33: any = true;}if(valid33){if(data.chainRoot !== undefined){const _errs225: any = errors;if(!(validateWorkflowChainRoot.call(this, data.chainRoot, {instancePath:instancePath+"/chainRoot",parentData:data,parentDataProperty:"chainRoot",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainRoot.errors : vErrors.concat(validateWorkflowChainRoot.errors);errors = vErrors.length;}var valid33: any = _errs225 === errors;}else {var valid33: any = true;}if(valid33){if(data.executionContextCaptured !== undefined){const _errs226: any = errors;if(typeof data.executionContextCaptured !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/executionContextCaptured",schemaPath:"#/oneOf/5/properties/executionContextCaptured/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid33: any = _errs226 === errors;}else {var valid33: any = true;}if(valid33){if(data.fixSessionId !== undefined){const _errs228: any = errors;if(!(validateSessionId.call(this, data.fixSessionId, {instancePath:instancePath+"/fixSessionId",parentData:data,parentDataProperty:"fixSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid33: any = _errs228 === errors;}else {var valid33: any = true;}if(valid33){if(data.steps !== undefined){let data135: any = data.steps;const _errs229: any = errors;if(errors === _errs229){if(Array.isArray(data135)){var valid34: any = true;const len11: any = data135.length;for(let i11=0; i11<len11; i11++){const _errs231: any = errors;if(!(validateWorkflowStep.call(this, data135[i11], {instancePath:instancePath+"/steps/" + i11,parentData:data135,parentDataProperty:i11,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStep.errors : vErrors.concat(validateWorkflowStep.errors);errors = vErrors.length;}var valid34: any = _errs231 === errors;if(!valid34){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/steps",schemaPath:"#/oneOf/5/properties/steps/type",keyword:"type",params:{type: "array"}}];return false;}}var valid33: any = _errs229 === errors;}else {var valid33: any = true;}if(valid33){if(data.cost !== undefined){const _errs232: any = errors;if(!(validateWorkflowCost.call(this, data.cost, {instancePath:instancePath+"/cost",parentData:data,parentDataProperty:"cost",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowCost.errors : vErrors.concat(validateWorkflowCost.errors);errors = vErrors.length;}var valid33: any = _errs232 === errors;}else {var valid33: any = true;}if(valid33){if(data.edgeItemCounts !== undefined){let data138: any = data.edgeItemCounts;const _errs233: any = errors;if(errors === _errs233){if(Array.isArray(data138)){var valid35: any = true;const len12: any = data138.length;for(let i12=0; i12<len12; i12++){const _errs235: any = errors;if(!(validateWorkflowEdgeItemCount.call(this, data138[i12], {instancePath:instancePath+"/edgeItemCounts/" + i12,parentData:data138,parentDataProperty:i12,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowEdgeItemCount.errors : vErrors.concat(validateWorkflowEdgeItemCount.errors);errors = vErrors.length;}var valid35: any = _errs235 === errors;if(!valid35){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/edgeItemCounts",schemaPath:"#/oneOf/5/properties/edgeItemCounts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid33: any = _errs233 === errors;}else {var valid33: any = true;}if(valid33){if(data.chainQuestion !== undefined){const _errs236: any = errors;if(!(validateWorkflowChainQuestion.call(this, data.chainQuestion, {instancePath:instancePath+"/chainQuestion",parentData:data,parentDataProperty:"chainQuestion",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainQuestion.errors : vErrors.concat(validateWorkflowChainQuestion.errors);errors = vErrors.length;}var valid33: any = _errs236 === errors;}else {var valid33: any = true;}if(valid33){if(data.liveStep !== undefined){const _errs237: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/liveStep",schemaPath:"#/oneOf/5/properties/liveStep/not",keyword:"not",params:{}}];return false;var valid33: any = _errs237 === errors;}else {var valid33: any = true;}if(valid33){if(data.review !== undefined){const _errs240: any = errors;if(!(validateWorkflowRunReview.call(this, data.review, {instancePath:instancePath+"/review",parentData:data,parentDataProperty:"review",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunReview.errors : vErrors.concat(validateWorkflowRunReview.errors);errors = vErrors.length;}var valid33: any = _errs240 === errors;}else {var valid33: any = true;}if(valid33){if(data.finishedAt !== undefined){const _errs241: any = errors;if(!(validateWireInstant.call(this, data.finishedAt, {instancePath:instancePath+"/finishedAt",parentData:data,parentDataProperty:"finishedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid33: any = _errs241 === errors;}else {var valid33: any = true;}if(valid33){if(data.error !== undefined){const _errs242: any = errors;if(!(validateWorkflowStepError.call(this, data.error, {instancePath:instancePath+"/error",parentData:data,parentDataProperty:"error",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStepError.errors : vErrors.concat(validateWorkflowStepError.errors);errors = vErrors.length;}var valid33: any = _errs242 === errors;}else {var valid33: any = true;}}}}}}}}}}}}}}}}}}}}}}}}else {validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"}}];return false;}}var valid32: any = _errs210 === errors;if(props0 !== true){props0 = true;}valid11 = valid32;}else if(tag0 === "crashed"){const _errs243: any = errors;if(errors === _errs243){if(data && typeof data == "object" && !Array.isArray(data)){let missing11: any;if((((((((((((((((data.status === undefined) && (missing11 = "status")) || ((data.workflowRunId === undefined) && (missing11 = "workflowRunId"))) || ((data.sessionId === undefined) && (missing11 = "sessionId"))) || ((data.definitionId === undefined) && (missing11 = "definitionId"))) || ((data.workflowVersionId === undefined) && (missing11 = "workflowVersionId"))) || ((data.mode === undefined) && (missing11 = "mode"))) || ((data.triggerKind === undefined) && (missing11 = "triggerKind"))) || ((data.startedBy === undefined) && (missing11 = "startedBy"))) || ((data.keep === undefined) && (missing11 = "keep"))) || ((data.startedAt === undefined) && (missing11 = "startedAt"))) || ((data.chainRoot === undefined) && (missing11 = "chainRoot"))) || ((data.executionContextCaptured === undefined) && (missing11 = "executionContextCaptured"))) || ((data.steps === undefined) && (missing11 = "steps"))) || ((data.edgeItemCounts === undefined) && (missing11 = "edgeItemCounts"))) || ((data.finishedAt === undefined) && (missing11 = "finishedAt"))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing11}}];return false;}else {const _errs245: any = errors;for(const key6 in data){if(!(func2.call(schema1551.oneOf[6].properties, key6))){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs245 === errors){if(data.status !== undefined){let data145: any = data.status;const _errs246: any = errors;if(typeof data145 !== "string"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/6/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if("crashed" !== data145){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/6/properties/status/const",keyword:"const",params:{allowedValue: "crashed"}}];return false;}var valid37: any = _errs246 === errors;}else {var valid37: any = true;}if(valid37){if(data.workflowRunId !== undefined){const _errs248: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid37: any = _errs248 === errors;}else {var valid37: any = true;}if(valid37){if(data.sessionId !== undefined){const _errs249: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid37: any = _errs249 === errors;}else {var valid37: any = true;}if(valid37){if(data.definitionId !== undefined){const _errs250: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid37: any = _errs250 === errors;}else {var valid37: any = true;}if(valid37){if(data.workflowVersionId !== undefined){const _errs251: any = errors;if(!(validateWorkflowVersionId.call(this, data.workflowVersionId, {instancePath:instancePath+"/workflowVersionId",parentData:data,parentDataProperty:"workflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid37: any = _errs251 === errors;}else {var valid37: any = true;}if(valid37){if(data.mode !== undefined){const _errs252: any = errors;if(!(validateWorkflowRunMode.call(this, data.mode, {instancePath:instancePath+"/mode",parentData:data,parentDataProperty:"mode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunMode.errors : vErrors.concat(validateWorkflowRunMode.errors);errors = vErrors.length;}var valid37: any = _errs252 === errors;}else {var valid37: any = true;}if(valid37){if(data.triggerKind !== undefined){const _errs253: any = errors;if(!(validateWorkflowTriggerKind.call(this, data.triggerKind, {instancePath:instancePath+"/triggerKind",parentData:data,parentDataProperty:"triggerKind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowTriggerKind.errors : vErrors.concat(validateWorkflowTriggerKind.errors);errors = vErrors.length;}var valid37: any = _errs253 === errors;}else {var valid37: any = true;}if(valid37){if(data.startedBy !== undefined){const _errs254: any = errors;if(!(validateWorkflowStartedBy.call(this, data.startedBy, {instancePath:instancePath+"/startedBy",parentData:data,parentDataProperty:"startedBy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStartedBy.errors : vErrors.concat(validateWorkflowStartedBy.errors);errors = vErrors.length;}var valid37: any = _errs254 === errors;}else {var valid37: any = true;}if(valid37){if(data.keep !== undefined){const _errs255: any = errors;if(typeof data.keep !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/keep",schemaPath:"#/oneOf/6/properties/keep/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid37: any = _errs255 === errors;}else {var valid37: any = true;}if(valid37){if(data.startedAt !== undefined){const _errs257: any = errors;if(!(validateWireInstant.call(this, data.startedAt, {instancePath:instancePath+"/startedAt",parentData:data,parentDataProperty:"startedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid37: any = _errs257 === errors;}else {var valid37: any = true;}if(valid37){if(data.chainRoot !== undefined){const _errs258: any = errors;if(!(validateWorkflowChainRoot.call(this, data.chainRoot, {instancePath:instancePath+"/chainRoot",parentData:data,parentDataProperty:"chainRoot",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainRoot.errors : vErrors.concat(validateWorkflowChainRoot.errors);errors = vErrors.length;}var valid37: any = _errs258 === errors;}else {var valid37: any = true;}if(valid37){if(data.executionContextCaptured !== undefined){const _errs259: any = errors;if(typeof data.executionContextCaptured !== "boolean"){validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/executionContextCaptured",schemaPath:"#/oneOf/6/properties/executionContextCaptured/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid37: any = _errs259 === errors;}else {var valid37: any = true;}if(valid37){if(data.fixSessionId !== undefined){const _errs261: any = errors;if(!(validateSessionId.call(this, data.fixSessionId, {instancePath:instancePath+"/fixSessionId",parentData:data,parentDataProperty:"fixSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid37: any = _errs261 === errors;}else {var valid37: any = true;}if(valid37){if(data.steps !== undefined){let data158: any = data.steps;const _errs262: any = errors;if(errors === _errs262){if(Array.isArray(data158)){var valid38: any = true;const len13: any = data158.length;for(let i13=0; i13<len13; i13++){const _errs264: any = errors;if(!(validateWorkflowStep.call(this, data158[i13], {instancePath:instancePath+"/steps/" + i13,parentData:data158,parentDataProperty:i13,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStep.errors : vErrors.concat(validateWorkflowStep.errors);errors = vErrors.length;}var valid38: any = _errs264 === errors;if(!valid38){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/steps",schemaPath:"#/oneOf/6/properties/steps/type",keyword:"type",params:{type: "array"}}];return false;}}var valid37: any = _errs262 === errors;}else {var valid37: any = true;}if(valid37){if(data.cost !== undefined){const _errs265: any = errors;if(!(validateWorkflowCost.call(this, data.cost, {instancePath:instancePath+"/cost",parentData:data,parentDataProperty:"cost",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowCost.errors : vErrors.concat(validateWorkflowCost.errors);errors = vErrors.length;}var valid37: any = _errs265 === errors;}else {var valid37: any = true;}if(valid37){if(data.edgeItemCounts !== undefined){let data161: any = data.edgeItemCounts;const _errs266: any = errors;if(errors === _errs266){if(Array.isArray(data161)){var valid39: any = true;const len14: any = data161.length;for(let i14=0; i14<len14; i14++){const _errs268: any = errors;if(!(validateWorkflowEdgeItemCount.call(this, data161[i14], {instancePath:instancePath+"/edgeItemCounts/" + i14,parentData:data161,parentDataProperty:i14,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowEdgeItemCount.errors : vErrors.concat(validateWorkflowEdgeItemCount.errors);errors = vErrors.length;}var valid39: any = _errs268 === errors;if(!valid39){break;}}}else {validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/edgeItemCounts",schemaPath:"#/oneOf/6/properties/edgeItemCounts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid37: any = _errs266 === errors;}else {var valid37: any = true;}if(valid37){if(data.chainQuestion !== undefined){const _errs269: any = errors;if(!(validateWorkflowChainQuestion.call(this, data.chainQuestion, {instancePath:instancePath+"/chainQuestion",parentData:data,parentDataProperty:"chainQuestion",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowChainQuestion.errors : vErrors.concat(validateWorkflowChainQuestion.errors);errors = vErrors.length;}var valid37: any = _errs269 === errors;}else {var valid37: any = true;}if(valid37){if(data.liveStep !== undefined){const _errs270: any = errors;validateWorkflowRunReadResponse.errors = [{instancePath:instancePath+"/liveStep",schemaPath:"#/oneOf/6/properties/liveStep/not",keyword:"not",params:{}}];return false;var valid37: any = _errs270 === errors;}else {var valid37: any = true;}if(valid37){if(data.review !== undefined){const _errs273: any = errors;if(!(validateWorkflowRunReview.call(this, data.review, {instancePath:instancePath+"/review",parentData:data,parentDataProperty:"review",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunReview.errors : vErrors.concat(validateWorkflowRunReview.errors);errors = vErrors.length;}var valid37: any = _errs273 === errors;}else {var valid37: any = true;}if(valid37){if(data.finishedAt !== undefined){const _errs274: any = errors;if(!(validateWireInstant.call(this, data.finishedAt, {instancePath:instancePath+"/finishedAt",parentData:data,parentDataProperty:"finishedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid37: any = _errs274 === errors;}else {var valid37: any = true;}if(valid37){if(data.error !== undefined){const _errs275: any = errors;if(!(validateWorkflowStepError.call(this, data.error, {instancePath:instancePath+"/error",parentData:data,parentDataProperty:"error",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStepError.errors : vErrors.concat(validateWorkflowStepError.errors);errors = vErrors.length;}var valid37: any = _errs275 === errors;}else {var valid37: any = true;}}}}}}}}}}}}}}}}}}}}}}}}else {validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"}}];return false;}}var valid36: any = _errs243 === errors;if(props0 !== true){props0 = true;}valid11 = valid36;}else {validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "status", tagValue: tag0}}];return false;}}else {validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "status", tagValue: tag0}}];return false;}if(valid11){if(props0 !== true){for(const key7 in data){if(!props0 || !props0[key7]){validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key7}}];return false;break;}}}}}else {validateWorkflowRunReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS}, each with its checks. */
export interface WorkflowRunRecordMethodDescriptors {
  readonly "workflow.run.read": {
    readonly method: "workflow.run.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowRunReadRequest>;
    readonly responseCheck: SchemaCheck<WorkflowRunReadResponse>;
  };
  readonly "workflow.run.list": {
    readonly method: "workflow.run.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowRunListRequest>;
    readonly responseCheck: SchemaCheck<WorkflowRunListResponse>;
  };
  readonly "workflow.run.delete": {
    readonly method: "workflow.run.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowRunDeleteRequest>;
    readonly responseCheck: SchemaCheck<WorkflowRunDeleteResponse>;
  };
  readonly "workflow.run.purge.preview": {
    readonly method: "workflow.run.purge.preview";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowRunPurgeRequest>;
    readonly responseCheck: SchemaCheck<WorkflowRunPurgePreviewResponse>;
  };
  readonly "workflow.run.purge": {
    readonly method: "workflow.run.purge";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowRunPurgeRequest>;
    readonly responseCheck: SchemaCheck<WorkflowRunPurgeResponse>;
  };
  readonly "workflow.run.keep.update": {
    readonly method: "workflow.run.keep.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowRunKeepSet>;
    readonly responseCheck: SchemaCheck<WorkflowRunKeepSet>;
  };
  readonly "workflow.run.attention.list": {
    readonly method: "workflow.run.attention.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<WorkflowRunAttentionListResponse>;
  };
  readonly "workflow.newRunHold.update": {
    readonly method: "workflow.newRunHold.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowNewRunHoldUpdateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowNewRunHoldState>;
  };
}
/**
 * The `workflow.*` methods that read, list and keep run records. `workflow.run.attention.list`
 * takes no members: the runs table's filters never narrow it.
 */
export const WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS: WorkflowRunRecordMethodDescriptors =
  Object.freeze({
    "workflow.run.read": Object.freeze({
      method: "workflow.run.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateWorkflowRunReadRequest,
      responseCheck: validateWorkflowRunReadResponse,
    }),
    "workflow.run.list": Object.freeze({
      method: "workflow.run.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateWorkflowRunListRequest,
      responseCheck: validateWorkflowRunListResponse,
    }),
    "workflow.run.delete": Object.freeze({
      method: "workflow.run.delete",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowRunDeleteRequest,
      responseCheck: validateWorkflowRunDeleteResponse,
    }),
    "workflow.run.purge.preview": Object.freeze({
      method: "workflow.run.purge.preview",
      procedureType: "query",
      mutating: false,
      requestCheck: validateWorkflowRunPurgeRequest,
      responseCheck: validateWorkflowRunPurgePreviewResponse,
    }),
    "workflow.run.purge": Object.freeze({
      method: "workflow.run.purge",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowRunPurgeRequest,
      responseCheck: validateWorkflowRunPurgeResponse,
    }),
    "workflow.run.keep.update": Object.freeze({
      method: "workflow.run.keep.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowRunKeepSet,
      responseCheck: validateWorkflowRunKeepSet,
    }),
    "workflow.run.attention.list": Object.freeze({
      method: "workflow.run.attention.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateWorkflowRunAttentionListResponse,
    }),
    "workflow.newRunHold.update": Object.freeze({
      method: "workflow.newRunHold.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowNewRunHoldUpdateRequest,
      responseCheck: validateWorkflowNewRunHoldState,
    }),
  });
