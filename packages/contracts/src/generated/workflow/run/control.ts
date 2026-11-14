// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The acts on a workflow run: starting one, canceling and resuming it, retrying from a step, running one node from the builder and posting a finished run's results into a session, with their refusals and their method table.

import type { SchemaCheck } from "../../../schema-check.js";
import {
  validateWorkflowNodeExecuteRequest,
  validateWorkflowNodeExecuteResponse,
  validateWorkflowResultsPostRequest,
  validateWorkflowResultsPostResponse,
  validateWorkflowRunCancelRequest,
  validateWorkflowRunCancelResponse,
  validateWorkflowRunRerunRequest,
  validateWorkflowRunResumeRequest,
  validateWorkflowRunResumeResponse,
  validateWorkflowRunRetryRequest,
  validateWorkflowRunRetryResponse,
  validateWorkflowRunStartRequest,
  validateWorkflowRunStartResponse,
} from "../../checks/workflow/run/control.js";
import type { ProjectId } from "../../project.js";
import type { SessionId } from "../../session/id.js";
import type { WorkflowNodeId, WorkflowVersionId } from "../definition/document.js";
import type { WorkflowItem } from "../definition/item.js";
import type { WorkflowRunId } from "./id.js";

/**
 * The most bytes a cancellation reason may take, counted as UTF-8 bytes of its JSON encoding
 * (quotes and escapes included), so the same sentence is not refused sooner in one script than
 * in another.
 */
export const WORKFLOW_CANCEL_REASON_BYTE_CAP = 8192 as const;

/** What a node run covers. */
export const WORKFLOW_NODE_EXECUTE_SCOPES = ["node", "fromHere"] as const;

/** Every reason `workflow.run.stillRunning` gives: its one value, the source run still going. */
export const WORKFLOW_RUN_STILL_RUNNING_REASONS = ["sourceRunning"] as const;

/** A start the policy check denied, or whose principal could not be resolved. */
export const WORKFLOW_RUN_START_DENIED_CODE = "workflow.run.startDenied" as const;

/**
 * A start in a project session that names a project: the run works in that session's
 * repository, so it names no other. Nothing runs.
 */
export const WORKFLOW_RUN_PROJECT_ON_PROJECT_SESSION_CODE =
  "workflow.run.projectOnProjectSession" as const;

/**
 * A start or a node run that works in no project's repository, of a version holding a Git,
 * Read a repo diff or Run tests step. Nothing runs.
 */
export const WORKFLOW_RUN_REPOSITORY_REQUIRED_CODE = "workflow.run.repositoryRequired" as const;

/**
 * A start or a node run of a workflow that names no provider, of a version holding a step
 * that runs in a provider's sandbox: Run a command, or a full-tier Code step. Nothing runs.
 */
export const WORKFLOW_RUN_PROVIDER_REQUIRED_CODE = "workflow.run.providerRequired" as const;

/**
 * A start of a version holding nodes whose kind the daemon does not list at the version each
 * records. Nothing runs.
 */
export const WORKFLOW_RUN_NODE_KIND_UNAVAILABLE_CODE = "workflow.run.nodeKindUnavailable" as const;

/**
 * A start of a version with edges naming main handles their nodes' kinds do not declare.
 * Nothing runs.
 */
export const WORKFLOW_RUN_HANDLE_UNDECLARED_CODE = "workflow.run.handleUndeclared" as const;

/**
 * A start that leaves a required input of the workflow unfilled, or gives an input a value
 * that does not fit it. Nothing runs.
 */
export const WORKFLOW_RUN_INPUT_REQUIRED_CODE = "workflow.run.inputRequired" as const;

/**
 * A start of a version whose Code steps' packages are not locked; a later save that locks them
 * makes the version runnable. Nothing runs.
 */
export const WORKFLOW_CODE_PACKAGES_NOT_LOCKED_CODE = "workflow.code.packagesNotLocked" as const;

/**
 * A cancel on a run that has ended. A failed run waiting on Resume has not ended and is
 * canceled; a run already canceled is not refused, the cancel returns the first's outcome.
 */
export const WORKFLOW_RUN_NOT_CANCELABLE_CODE = "workflow.run.notCancelable" as const;

/** A resume on a run that is not waiting: there is no wait to lift. */
export const WORKFLOW_RUN_RESUME_NOT_PARKED_CODE = "workflow.run.resumeNotParked" as const;

/** A version re-pin on a run that is not waiting; a going run is never re-pinned. */
export const WORKFLOW_RUN_REPAIR_NOT_PARKED_CODE = "workflow.run.repairNotParked" as const;

/** A version re-pin while one of the run's steps is still in flight. */
export const WORKFLOW_RUN_REPAIR_ATTEMPT_IN_FLIGHT_CODE =
  "workflow.run.repairAttemptInFlight" as const;

/** A version re-pin whose target cannot account for the steps the run already finished. */
export const WORKFLOW_RUN_REPAIR_VERSION_UNACCOUNTABLE_CODE =
  "workflow.run.repairVersionUnaccountable" as const;

/**
 * A run or step move its status does not allow: retrying from a step that did not fail,
 * posting the results of an unfinished run, or opening a fix session on a step that did not
 * fail.
 */
export const WORKFLOW_INVALID_TRANSITION_CODE = "workflow.invalidTransition" as const;

/** A retry from a step refused while its source run is still going. */
export const WORKFLOW_RUN_STILL_RUNNING_CODE = "workflow.run.stillRunning" as const;

/**
 * A cancellation's reason as the person typed it: non-empty, and at most 8192 bytes as JSON.
 */
export type WorkflowCancelReason = string;
/**
 * The start modes a caller may ask for; `retry` and `subWorkflow` come from their own methods.
 */
export type WorkflowRequestableRunMode = "manual" | "trigger" | "webhook" | "chat" | "agent";
/**
 * The status a new run can answer with: admitted but not yet dispatched, or already running.
 */
export type WorkflowRunStartStatus = "new" | "running";
/**
 * The status a resume answers with: running, or waiting again where it reached a provider account
 * still out of quota, which is a legal outcome and not a refusal.
 */
export type WorkflowRunResumeStatus = "running" | "waiting";
/**
 * What a node run covers: the node alone (`Run this node`), or the node and its ancestors
 * (`Run from here`).
 */
export type WorkflowNodeExecuteScope = "node" | "fromHere";
/**
 * Why `workflow.run.stillRunning` refused a retry; its one cause is a source run still going.
 */
export type WorkflowRunStillRunningReason = "sourceRunning";

/**
 * The `workflow.run.start` input: the caller's key, the version to run, the session it is started
 * in, the repository it works in, the items it starts on and how the start was made.
 */
export interface WorkflowRunStartRequest {
  /**
   * The caller's key, kept in the command receipts: a resend under it after a reconnect answers
   * the first start's run, never a second; the same key with a differing payload is refused.
   */
  clientIdempotencyKey: string;
  /**
   * The version, taken verbatim from a definition or version read.
   */
  workflowVersionId: WorkflowVersionId;
  /**
   * The session the start was made in; absent, the run lives in the workflow's own session.
   */
  sessionId?: SessionId;
  /**
   * The project whose folder the run works in. A project session's run works in that session's
   * repository and names none; absent on a chat's run, it works in the chat's folder, and
   * absent on a start in no session, in its own empty folder.
   */
  projectId?: ProjectId;
  /**
   * The items the run starts on, where the workflow declares inputs: the one item's `json`
   * object holds the filled values by input name.
   */
  input?: WorkflowItem[];
  /**
   * How the start was made.
   */
  mode?: WorkflowRequestableRunMode;
}
/**
 * The `workflow.run.start` result, which `workflow.run.rerun` also answers with: the new run, the
 * session it lives in, and its status.
 */
export interface WorkflowRunStartResponse {
  /**
   * The new run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The session it lives in.
   */
  sessionId: SessionId;
  /**
   * Its status.
   */
  status: WorkflowRunStartStatus;
}
/**
 * The `workflow.run.cancel` input. `reason` is recorded on the run and carried on its canceled
 * event; it never reaches a step's output or anything an agent reads.
 */
export interface WorkflowRunCancelRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The person's reason.
   */
  reason?: WorkflowCancelReason;
}
/**
 * The `workflow.run.cancel` result. Cancel is offered on a new, running or waiting run, and on a
 * failed run parked on its failed step; `alreadyCanceled` is true when the run was already
 * canceled and this call returned the first cancel's saved result, `canceledEventId` naming the
 * original event and no second one written.
 */
export interface WorkflowRunCancelResponse {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * `canceled`.
   */
  status: "canceled";
  /**
   * The `workflow.run.canceled` event the cancel wrote.
   */
  canceledEventId: string;
  /**
   * Whether the run was already canceled.
   */
  alreadyCanceled: boolean;
}
/**
 * The version a resume moves its run to, named rather than asked for as the latest, so the
 * recorded from-and-to pair is the one the person saw.
 */
export interface WorkflowRunResumeVersionRepin {
  /**
   * The version the run joins.
   */
  targetWorkflowVersionId: WorkflowVersionId;
}
/**
 * The `workflow.run.resume` input. An ordinary resume omits `versionRepin` and continues on the
 * run's pinned version; only an explicit `versionRepin` moves the run.
 */
export interface WorkflowRunResumeRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The re-pin asked for.
   */
  versionRepin?: WorkflowRunResumeVersionRepin;
}
/**
 * The `workflow.run.resume` result. The two repinned ids are present only on an accepted re-pin,
 * and then both.
 */
export interface WorkflowRunResumeResponse {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * Its status.
   */
  status: WorkflowRunResumeStatus;
  /**
   * The version the run left, on an accepted re-pin.
   */
  repinnedFromWorkflowVersionId?: WorkflowVersionId;
  /**
   * The version the run joined, on an accepted re-pin.
   */
  repinnedToWorkflowVersionId?: WorkflowVersionId;
}
/**
 * The `workflow.run.retry` input: re-run from a named step, which runs again with its descendants
 * while the source run's data stays pinned upstream.
 */
export interface WorkflowRunRetryRequest {
  /**
   * The source run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The step to re-run from.
   */
  fromNodeId: WorkflowNodeId;
  /**
   * The caller's key, kept in the command receipts: a resend under it after a reconnect answers
   * the first retry's run, never a second; the same key with a differing payload is refused.
   */
  clientIdempotencyKey: string;
}
/**
 * The `workflow.run.retry` result: a new run in `retry` mode; the source run stays readable. The
 * new run is never its own source.
 */
export interface WorkflowRunRetryResponse {
  /**
   * The new run; never the source.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The source run.
   */
  sourceWorkflowRunId: WorkflowRunId;
  /**
   * The new run's status.
   */
  status: WorkflowRunStartStatus;
}
/**
 * The `workflow.run.rerun` input: start a new run of the named run's own pinned version, with the
 * input and mode that run was started with, in the session it lives in. The daemon reads all
 * three from the source run.
 */
export interface WorkflowRunRerunRequest {
  /**
   * The run to re-run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The caller's key, kept in the command receipts: a resend under it after a reconnect answers
   * the first re-run's run, never a second; the same key with a differing payload is refused.
   */
  clientIdempotencyKey: string;
}
/**
 * The `workflow.node.execute` input: `Run this node` or `Run from here` on a saved version, never
 * unsaved bytes. `projectId` is the project the builder's `Repository` panel names for a node run
 * on a `chat` or `subWorkflow` trigger, absent for `None` and on every other trigger;
 * `dirtyNodeIds` is the builder's hint, and the daemon decides what it runs and reuses.
 */
export interface WorkflowNodeExecuteRequest {
  /**
   * The caller's key, kept in the command receipts: a resend under it after a reconnect answers
   * the first node run's run, never a second; the same key with a differing payload is refused.
   */
  clientIdempotencyKey: string;
  /**
   * The saved version.
   */
  workflowVersionId: WorkflowVersionId;
  /**
   * The session the node run is started in; absent, it lives in the workflow's own session.
   */
  sessionId?: SessionId;
  /**
   * The project it works in, on a `chat` or `subWorkflow` trigger.
   */
  projectId?: ProjectId;
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * What the run covers.
   */
  scope: WorkflowNodeExecuteScope;
  /**
   * The nodes the builder believes are dirty.
   */
  dirtyNodeIds?: WorkflowNodeId[];
  /**
   * The items the trigger starts on, as the node run's panel gave them; absent, the trigger's
   * earlier data is reused.
   */
  input?: WorkflowItem[];
}
/**
 * The `workflow.node.execute` result: the nodes the daemon ran, in order, and those it reused.
 */
export interface WorkflowNodeExecuteResponse {
  /**
   * The run the node run made.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The nodes executed, in execution order.
   */
  executedNodeIds: WorkflowNodeId[];
  /**
   * The nodes whose step data was reused.
   */
  reusedNodeIds: WorkflowNodeId[];
}
/**
 * The `workflow.results.post` input: pull a finished run's results into the session the
 * `/workflow results` verb was typed in, which the daemon checks is the caller's own.
 */
export interface WorkflowResultsPostRequest {
  /**
   * The finished run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The session that asks.
   */
  sessionId: SessionId;
}
/**
 * The `workflow.results.post` result.
 */
export interface WorkflowResultsPostResponse {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * Always `true`.
   */
  posted: true;
}
/**
 * The repository refusal's details: the nodes that need a repository.
 */
export interface WorkflowRunRepositoryRequiredDetails {
  /**
   * The nodes, at least one.
   *
   * @minItems 1
   */
  nodeIds: [WorkflowNodeId, ...WorkflowNodeId[]];
}
/**
 * The provider refusal's details: the steps that run in a provider's sandbox.
 */
export interface WorkflowRunProviderRequiredDetails {
  /**
   * The nodes, at least one.
   *
   * @minItems 1
   */
  nodeIds: [WorkflowNodeId, ...WorkflowNodeId[]];
}
/**
 * The unavailable-kind refusal's details: the nodes whose kind the daemon does not list at the
 * version each records.
 */
export interface WorkflowRunNodeKindUnavailableDetails {
  /**
   * The nodes, at least one.
   *
   * @minItems 1
   */
  nodeIds: [WorkflowNodeId, ...WorkflowNodeId[]];
}
/**
 * The undeclared-handle refusal's details: each edge end naming a main handle its node's kind
 * does not declare, as a node and its handle at one index of the two lists.
 */
export interface WorkflowRunHandleUndeclaredDetails {
  /**
   * The node of each end, at least one.
   *
   * @minItems 1
   */
  nodeIds: [WorkflowNodeId, ...WorkflowNodeId[]];
  /**
   * The handle of each end as its edge names it, at the same index as its node.
   *
   * @minItems 1
   */
  handles: [string, ...string[]];
}
/**
 * The missing-input refusal's details: the inputs the start left unfilled or filled with a value
 * that does not fit, by name.
 */
export interface WorkflowRunInputRequiredDetails {
  /**
   * The inputs, at least one.
   *
   * @minItems 1
   */
  inputNames: [string, ...string[]];
}
/**
 * The unlocked-packages refusal's details: the Code nodes whose packages are not locked.
 */
export interface WorkflowCodePackagesNotLockedDetails {
  /**
   * The nodes, at least one.
   *
   * @minItems 1
   */
  nodeIds: [WorkflowNodeId, ...WorkflowNodeId[]];
}
/**
 * The details of `workflow.run.stillRunning`.
 */
export interface WorkflowRunStillRunningDetails {
  /**
   * Why.
   */
  reason: WorkflowRunStillRunningReason;
}
/**
 * The details a `workflow.run.idempotencyConflict` refusal carries: what the key first answered.
 */
export interface WorkflowRunIdempotencyConflictDetails {
  /**
   * The run the first request under the key named: a retry's or re-run's source run; absent
   * for a start or a node run, which names none.
   */
  sourceWorkflowRunId?: WorkflowRunId;
  /**
   * The run the first request under the key made.
   */
  workflowRunId: WorkflowRunId;
}

export {
  validateWorkflowCancelReason,
  validateWorkflowCodePackagesNotLockedDetails,
  validateWorkflowNodeExecuteRequest,
  validateWorkflowNodeExecuteResponse,
  validateWorkflowNodeExecuteScope,
  validateWorkflowRequestableRunMode,
  validateWorkflowResultsPostRequest,
  validateWorkflowResultsPostResponse,
  validateWorkflowRunCancelRequest,
  validateWorkflowRunCancelResponse,
  validateWorkflowRunHandleUndeclaredDetails,
  validateWorkflowRunIdempotencyConflictDetails,
  validateWorkflowRunInputRequiredDetails,
  validateWorkflowRunNodeKindUnavailableDetails,
  validateWorkflowRunProviderRequiredDetails,
  validateWorkflowRunRepositoryRequiredDetails,
  validateWorkflowRunRerunRequest,
  validateWorkflowRunResumeRequest,
  validateWorkflowRunResumeResponse,
  validateWorkflowRunResumeStatus,
  validateWorkflowRunResumeVersionRepin,
  validateWorkflowRunRetryRequest,
  validateWorkflowRunRetryResponse,
  validateWorkflowRunStartRequest,
  validateWorkflowRunStartResponse,
  validateWorkflowRunStartStatus,
  validateWorkflowRunStillRunningDetails,
  validateWorkflowRunStillRunningReason,
} from "../../checks/workflow/run/control.js";

/** The methods of {@link WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS}, each with its checks. */
export interface WorkflowRunControlMethodDescriptors {
  readonly "workflow.run.start": {
    readonly method: "workflow.run.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowRunStartRequest>;
    readonly responseCheck: SchemaCheck<WorkflowRunStartResponse>;
  };
  readonly "workflow.run.cancel": {
    readonly method: "workflow.run.cancel";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowRunCancelRequest>;
    readonly responseCheck: SchemaCheck<WorkflowRunCancelResponse>;
  };
  readonly "workflow.run.resume": {
    readonly method: "workflow.run.resume";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowRunResumeRequest>;
    readonly responseCheck: SchemaCheck<WorkflowRunResumeResponse>;
  };
  readonly "workflow.run.retry": {
    readonly method: "workflow.run.retry";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowRunRetryRequest>;
    readonly responseCheck: SchemaCheck<WorkflowRunRetryResponse>;
  };
  readonly "workflow.run.rerun": {
    readonly method: "workflow.run.rerun";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowRunRerunRequest>;
    readonly responseCheck: SchemaCheck<WorkflowRunStartResponse>;
  };
  readonly "workflow.node.execute": {
    readonly method: "workflow.node.execute";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowNodeExecuteRequest>;
    readonly responseCheck: SchemaCheck<WorkflowNodeExecuteResponse>;
  };
  readonly "workflow.results.post": {
    readonly method: "workflow.results.post";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowResultsPostRequest>;
    readonly responseCheck: SchemaCheck<WorkflowResultsPostResponse>;
  };
}
/** The `workflow.*` methods that act on a run. */
export const WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS: WorkflowRunControlMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "workflow.run.start": /* @__PURE__ */ Object.freeze({
      method: "workflow.run.start",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowRunStartRequest,
      responseCheck: validateWorkflowRunStartResponse,
    }),
    "workflow.run.cancel": /* @__PURE__ */ Object.freeze({
      method: "workflow.run.cancel",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowRunCancelRequest,
      responseCheck: validateWorkflowRunCancelResponse,
    }),
    "workflow.run.resume": /* @__PURE__ */ Object.freeze({
      method: "workflow.run.resume",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowRunResumeRequest,
      responseCheck: validateWorkflowRunResumeResponse,
    }),
    "workflow.run.retry": /* @__PURE__ */ Object.freeze({
      method: "workflow.run.retry",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowRunRetryRequest,
      responseCheck: validateWorkflowRunRetryResponse,
    }),
    "workflow.run.rerun": /* @__PURE__ */ Object.freeze({
      method: "workflow.run.rerun",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowRunRerunRequest,
      responseCheck: validateWorkflowRunStartResponse,
    }),
    "workflow.node.execute": /* @__PURE__ */ Object.freeze({
      method: "workflow.node.execute",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowNodeExecuteRequest,
      responseCheck: validateWorkflowNodeExecuteResponse,
    }),
    "workflow.results.post": /* @__PURE__ */ Object.freeze({
      method: "workflow.results.post",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowResultsPostRequest,
      responseCheck: validateWorkflowResultsPostResponse,
    }),
  });
