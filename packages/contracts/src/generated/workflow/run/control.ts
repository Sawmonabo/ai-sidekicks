// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The acts on a workflow run: starting one, canceling and resuming it, retrying from a step, running one node from the builder and posting a finished run's results into a session, with their refusals and their method table.

import { type SchemaCheck, deepEqual, ucs2length, wireByteLength } from "../../../schema-check.js";
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

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate2469(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowCancelReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2469.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(wireByteLength(data, this && this.attachments) > 8192){validate2469.errors = [{instancePath,schemaPath:"#/maxJsonBytes",keyword:"maxJsonBytes",params:{}}];return false;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 8190){validate2469.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 8190}}];return false;}else {if(func1(data) < 1){validate2469.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2469.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate2469.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2469.errors = null as any[] | null;
// prettier-ignore
validate2469.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2470(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowCodePackagesNotLockedDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2470.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.nodeIds === undefined) && (missing0 = "nodeIds")){validate2470.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "nodeIds")){validate2470.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.nodeIds !== undefined){let data0: any = data.nodeIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validate2470.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) < 1){validate2470.errors = [{instancePath:instancePath+"/nodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2470.errors = [{instancePath:instancePath+"/nodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validate2470.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate2470.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2470.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2470.errors = null as any[] | null;
// prettier-ignore
validate2470.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4807: any = {"description":"What a node run covers: the node alone (`Run this node`), or the node and its ancestors\n(`Run from here`).","type":"string","enum":["node","fromHere"]};
// prettier-ignore
const pattern222 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate729(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate729.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.artifactId === undefined) && (missing0 = "artifactId")) || ((data.mimeType === undefined) && (missing0 = "mimeType"))) || ((data.fileName === undefined) && (missing0 = "fileName"))) || ((data.size === undefined) && (missing0 = "size"))){validate729.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "artifactId") || (key0 === "mimeType")) || (key0 === "fileName")) || (key0 === "size"))){validate729.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.artifactId !== undefined){let data0: any = data.artifactId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate729.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate729.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.mimeType !== undefined){let data1: any = data.mimeType;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){validate729.errors = [{instancePath:instancePath+"/mimeType",schemaPath:"#/properties/mimeType/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate729.errors = [{instancePath:instancePath+"/mimeType",schemaPath:"#/properties/mimeType/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.fileName !== undefined){let data2: any = data.fileName;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 4096){validate729.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validate729.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate729.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.size !== undefined){let data3: any = data.size;const _errs10: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate729.errors = [{instancePath:instancePath+"/size",schemaPath:"#/properties/size/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate729.errors = [{instancePath:instancePath+"/size",schemaPath:"#/properties/size/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate729.errors = [{instancePath:instancePath+"/size",schemaPath:"#/properties/size/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}else {validate729.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate729.errors = vErrors;return errors === 0;}
// prettier-ignore
validate729.errors = null as any[] | null;
// prettier-ignore
validate729.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate731(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate731.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.item === undefined) && (missing0 = "item")){const err0: any = {instancePath,schemaPath:"#/$defs/WorkflowPairedItem/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "item") || (key0 === "input"))){const err1: any = {instancePath,schemaPath:"#/$defs/WorkflowPairedItem/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs4 === errors){if(data.item !== undefined){let data0: any = data.item;const _errs5: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){const err2: any = {instancePath:instancePath+"/item",schemaPath:"#/$defs/WorkflowPairedItem/properties/item/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(errors === _errs5){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){const err3: any = {instancePath:instancePath+"/item",schemaPath:"#/$defs/WorkflowPairedItem/properties/item/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(data0 < 0 || isNaN(data0)){const err4: any = {instancePath:instancePath+"/item",schemaPath:"#/$defs/WorkflowPairedItem/properties/item/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}}}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.input !== undefined){let data1: any = data.input;const _errs7: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){const err5: any = {instancePath:instancePath+"/input",schemaPath:"#/$defs/WorkflowPairedItem/properties/input/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}if(errors === _errs7){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){const err6: any = {instancePath:instancePath+"/input",schemaPath:"#/$defs/WorkflowPairedItem/properties/input/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {if(data1 < 0 || isNaN(data1)){const err7: any = {instancePath:instancePath+"/input",schemaPath:"#/$defs/WorkflowPairedItem/properties/input/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {const err8: any = {instancePath,schemaPath:"#/$defs/WorkflowPairedItem/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data)){var valid3: any = true;const len0: any = data.length;for(let i0=0; i0<len0; i0++){let data2: any = data[i0];const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if((data2.item === undefined) && (missing1 = "item")){const err9: any = {instancePath:instancePath+"/" + i0,schemaPath:"#/$defs/WorkflowPairedItem/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}else {const _errs14: any = errors;for(const key1 in data2){if(!((key1 === "item") || (key1 === "input"))){const err10: any = {instancePath:instancePath+"/" + i0,schemaPath:"#/$defs/WorkflowPairedItem/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;break;}}if(_errs14 === errors){if(data2.item !== undefined){let data3: any = data2.item;const _errs15: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){const err11: any = {instancePath:instancePath+"/" + i0+"/item",schemaPath:"#/$defs/WorkflowPairedItem/properties/item/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}if(errors === _errs15){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){const err12: any = {instancePath:instancePath+"/" + i0+"/item",schemaPath:"#/$defs/WorkflowPairedItem/properties/item/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}else {if(data3 < 0 || isNaN(data3)){const err13: any = {instancePath:instancePath+"/" + i0+"/item",schemaPath:"#/$defs/WorkflowPairedItem/properties/item/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}}}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data2.input !== undefined){let data4: any = data2.input;const _errs17: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){const err14: any = {instancePath:instancePath+"/" + i0+"/input",schemaPath:"#/$defs/WorkflowPairedItem/properties/input/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}if(errors === _errs17){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){const err15: any = {instancePath:instancePath+"/" + i0+"/input",schemaPath:"#/$defs/WorkflowPairedItem/properties/input/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}else {if(data4 < 0 || isNaN(data4)){const err16: any = {instancePath:instancePath+"/" + i0+"/input",schemaPath:"#/$defs/WorkflowPairedItem/properties/input/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}}}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}}}}}else {const err17: any = {instancePath:instancePath+"/" + i0,schemaPath:"#/$defs/WorkflowPairedItem/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}}var valid3: any = _errs11 === errors;if(!valid3){break;}}}else {const err18: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}}var _valid0: any = _errs9 === errors;valid0 = valid0 || _valid0;if(_valid0){var items0: any = true;}if(!valid0){const err19: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;validate731.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate731.errors = vErrors;evaluated0.props = props0;evaluated0.items = items0;return errors === 0;}
// prettier-ignore
validate731.errors = null as any[] | null;
// prettier-ignore
validate731.evaluated = {"dynamicProps":true,"dynamicItems":true} as any;
// prettier-ignore
function validate734(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate734.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.message === undefined) && (missing0 = "message")){validate734.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "message") || (key0 === "nodeId")) || (key0 === "itemIndex")) || (key0 === "code")) || (key0 === "details"))){validate734.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.message !== undefined){let data0: any = data.message;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validate734.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate734.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){let data1: any = data.nodeId;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) < 1){validate734.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate734.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.itemIndex !== undefined){let data2: any = data.itemIndex;const _errs8: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate734.errors = [{instancePath:instancePath+"/itemIndex",schemaPath:"#/properties/itemIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate734.errors = [{instancePath:instancePath+"/itemIndex",schemaPath:"#/properties/itemIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate734.errors = [{instancePath:instancePath+"/itemIndex",schemaPath:"#/properties/itemIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.code !== undefined){const _errs10: any = errors;validate734.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/not",keyword:"not",params:{}}];return false;var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.details !== undefined){const _errs13: any = errors;validate734.errors = [{instancePath:instancePath+"/details",schemaPath:"#/properties/details/not",keyword:"not",params:{}}];return false;var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}}}else {validate734.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate734.errors = vErrors;return errors === 0;}
// prettier-ignore
validate734.errors = null as any[] | null;
// prettier-ignore
validate734.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern898 = new RegExp("^workflow(\\.[a-z][a-zA-Z0-9]*){1,3}$", "u");
// prettier-ignore
function validate736(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate736.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.message === undefined) && (missing0 = "message")) || ((data.code === undefined) && (missing0 = "code"))){validate736.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "message") || (key0 === "nodeId")) || (key0 === "itemIndex")) || (key0 === "code")) || (key0 === "details"))){validate736.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.message !== undefined){let data0: any = data.message;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validate736.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate736.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){let data1: any = data.nodeId;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) < 1){validate736.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate736.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.itemIndex !== undefined){let data2: any = data.itemIndex;const _errs8: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate736.errors = [{instancePath:instancePath+"/itemIndex",schemaPath:"#/properties/itemIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate736.errors = [{instancePath:instancePath+"/itemIndex",schemaPath:"#/properties/itemIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate736.errors = [{instancePath:instancePath+"/itemIndex",schemaPath:"#/properties/itemIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.code !== undefined){let data3: any = data.code;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data3 === "string"){if(!pattern898.test(data3)){validate736.errors = [{instancePath:instancePath+"/code",schemaPath:"#/$defs/WorkflowStepErrorCode/pattern",keyword:"pattern",params:{pattern: "^workflow(\\.[a-z][a-zA-Z0-9]*){1,3}$"}}];return false;}}else {validate736.errors = [{instancePath:instancePath+"/code",schemaPath:"#/$defs/WorkflowStepErrorCode/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.details !== undefined){let data4: any = data.details;const _errs13: any = errors;if(errors === _errs13){if(data4 && typeof data4 == "object" && !Array.isArray(data4)){for(const key1 in data4){const _errs15: any = errors;const _errs16: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/details",schemaPath:"#/properties/details/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid4: any = _errs16 === errors;if(valid4){const _errs18: any = errors;const _errs19: any = errors;const _errs20: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid5: any = _errs20 === errors;if(valid5){const err2: any = {instancePath:instancePath+"/details",schemaPath:"#/properties/details/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs19;if(vErrors !== null){if(_errs19){vErrors.length = _errs19;}else {vErrors = null;}}}var valid4: any = _errs18 === errors;}var valid3: any = _errs15 === errors;if(!valid3){const err3: any = {instancePath:instancePath+"/details",schemaPath:"#/properties/details/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate736.errors = vErrors;return false;break;}}if(valid3){for(const key2 in data4){const _errs22: any = errors;var valid6: any = _errs22 === errors;if(!valid6){break;}}}}else {validate736.errors = [{instancePath:instancePath+"/details",schemaPath:"#/properties/details/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}}}else {validate736.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate736.errors = vErrors;return errors === 0;}
// prettier-ignore
validate736.errors = null as any[] | null;
// prettier-ignore
validate736.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1398: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"reason":{"type":"string","const":"modelUnavailable"},"definitionId":{"anyOf":[{"$ref":"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId"},{"type":"null"}],"description":"The definition."},"providerName":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider."},"modelId":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The model, or `null` for none bound."}},"required":["reason","definitionId","providerName","modelId"],"description":"The pinned model its provider no longer offers, or, with a `null` model, a driver\nthe definition binds no model for."},{"type":"object","additionalProperties":false,"properties":{"reason":{"type":"string","const":"effortUnsupported"},"definitionId":{"anyOf":[{"$ref":"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId"},{"type":"null"}],"description":"The definition."},"effort":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The stored effort."},"effortLevels":{"type":"array","items":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128},"description":"The model's efforts."}},"required":["reason","definitionId","effort","effortLevels"],"description":"The stored effort and the efforts the model publishes."},{"type":"object","additionalProperties":false,"properties":{"reason":{"type":"string","const":"accountUnavailable"},"definitionId":{"anyOf":[{"$ref":"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId"},{"type":"null"}],"description":"The definition."},"providerAccountId":{"$ref":"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId","description":"The account."}},"required":["reason","definitionId","providerAccountId"],"description":"The pinned account this machine no longer holds."},{"type":"object","additionalProperties":false,"properties":{"reason":{"type":"string","const":"allowlistUnrealizable"},"definitionId":{"anyOf":[{"$ref":"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId"},{"type":"null"}],"description":"The definition."},"toolNames":{"type":"array","items":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128},"minItems":1,"description":"The missing tools, at least one."},"supportedToolNames":{"type":"array","items":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128},"description":"The driver's tools."}},"required":["reason","definitionId","toolNames","supportedToolNames"],"description":"The allowlisted tools that have left the catalog, and the tools the driver has."},{"type":"object","additionalProperties":false,"properties":{"reason":{"type":"string","const":"providerUnsupported"},"definitionId":{"anyOf":[{"$ref":"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId"},{"type":"null"}],"description":"The definition."},"unsupportedProviderName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The provider as the definition's file names it, which may be no provider id."}},"required":["reason","definitionId","unsupportedProviderName"],"description":"The provider the definition binds, which no registered driver answers."}],"description":"Why a step's agent could not resolve: the resolution refusal's own details, its\n`definitionId` `null` for a step running the General agent, which runs no definition.","discriminator":{"propertyName":"reason"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate739(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate739.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.reason;if(typeof tag0 == "string"){if(tag0 === "modelUnavailable"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.reason === undefined) && (missing0 = "reason")) || ((data.definitionId === undefined) && (missing0 = "definitionId"))) || ((data.providerName === undefined) && (missing0 = "providerName"))) || ((data.modelId === undefined) && (missing0 = "modelId"))){validate739.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((key0 === "reason") || (key0 === "definitionId")) || (key0 === "providerName")) || (key0 === "modelId"))){validate739.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.reason !== undefined){let data0: any = data.reason;const _errs5: any = errors;if(typeof data0 !== "string"){validate739.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("modelUnavailable" !== data0){validate739.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/properties/reason/const",keyword:"const",params:{allowedValue: "modelUnavailable"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.definitionId !== undefined){let data1: any = data.definitionId;const _errs7: any = errors;const _errs8: any = errors;let valid3: any = false;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data1 === "string"){if(!pattern4.test(data1)){const err0: any = {instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}else {const err1: any = {instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}var _valid0: any = _errs9 === errors;valid3 = valid3 || _valid0;const _errs13: any = errors;if(data1 !== null){const err2: any = {instancePath:instancePath+"/definitionId",schemaPath:"#/oneOf/0/properties/definitionId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid0: any = _errs13 === errors;valid3 = valid3 || _valid0;if(!valid3){const err3: any = {instancePath:instancePath+"/definitionId",schemaPath:"#/oneOf/0/properties/definitionId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate739.errors = vErrors;return false;}else {errors = _errs8;if(vErrors !== null){if(_errs8){vErrors.length = _errs8;}else {vErrors = null;}}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.providerName !== undefined){let data2: any = data.providerName;const _errs15: any = errors;const _errs16: any = errors;if(errors === _errs16){if(typeof data2 === "string"){if(!pattern16.test(data2)){validate739.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate739.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}if(valid2){if(data.modelId !== undefined){let data3: any = data.modelId;const _errs19: any = errors;if((typeof data3 !== "string") && (data3 !== null)){validate739.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/oneOf/0/properties/modelId/type",keyword:"type",params:{type: schema1398.oneOf[0].properties.modelId.type}}];return false;}if(errors === _errs19){if(typeof data3 === "string"){if(func1(data3) > 128){validate739.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/oneOf/0/properties/modelId/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data3) < 1){validate739.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/oneOf/0/properties/modelId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate739.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/oneOf/0/properties/modelId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid2: any = _errs19 === errors;}else {var valid2: any = true;}}}}}}}else {validate739.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "effortUnsupported"){const _errs21: any = errors;if(errors === _errs21){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.reason === undefined) && (missing1 = "reason")) || ((data.definitionId === undefined) && (missing1 = "definitionId"))) || ((data.effort === undefined) && (missing1 = "effort"))) || ((data.effortLevels === undefined) && (missing1 = "effortLevels"))){validate739.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs23: any = errors;for(const key1 in data){if(!((((key1 === "reason") || (key1 === "definitionId")) || (key1 === "effort")) || (key1 === "effortLevels"))){validate739.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs23 === errors){if(data.reason !== undefined){let data4: any = data.reason;const _errs24: any = errors;if(typeof data4 !== "string"){validate739.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("effortUnsupported" !== data4){validate739.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/const",keyword:"const",params:{allowedValue: "effortUnsupported"}}];return false;}var valid7: any = _errs24 === errors;}else {var valid7: any = true;}if(valid7){if(data.definitionId !== undefined){let data5: any = data.definitionId;const _errs26: any = errors;const _errs27: any = errors;let valid8: any = false;const _errs28: any = errors;const _errs29: any = errors;if(errors === _errs29){if(typeof data5 === "string"){if(!pattern4.test(data5)){const err4: any = {instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}else {const err5: any = {instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var _valid1: any = _errs28 === errors;valid8 = valid8 || _valid1;const _errs32: any = errors;if(data5 !== null){const err6: any = {instancePath:instancePath+"/definitionId",schemaPath:"#/oneOf/1/properties/definitionId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}var _valid1: any = _errs32 === errors;valid8 = valid8 || _valid1;if(!valid8){const err7: any = {instancePath:instancePath+"/definitionId",schemaPath:"#/oneOf/1/properties/definitionId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;validate739.errors = vErrors;return false;}else {errors = _errs27;if(vErrors !== null){if(_errs27){vErrors.length = _errs27;}else {vErrors = null;}}}var valid7: any = _errs26 === errors;}else {var valid7: any = true;}if(valid7){if(data.effort !== undefined){let data6: any = data.effort;const _errs34: any = errors;if(errors === _errs34){if(typeof data6 === "string"){if(func1(data6) > 128){validate739.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/oneOf/1/properties/effort/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data6) < 1){validate739.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/oneOf/1/properties/effort/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data6)){validate739.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/oneOf/1/properties/effort/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate739.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/oneOf/1/properties/effort/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs34 === errors;}else {var valid7: any = true;}if(valid7){if(data.effortLevels !== undefined){let data7: any = data.effortLevels;const _errs36: any = errors;if(errors === _errs36){if(Array.isArray(data7)){var valid10: any = true;const len0: any = data7.length;for(let i0=0; i0<len0; i0++){let data8: any = data7[i0];const _errs38: any = errors;if(errors === _errs38){if(typeof data8 === "string"){if(func1(data8) > 128){validate739.errors = [{instancePath:instancePath+"/effortLevels/" + i0,schemaPath:"#/oneOf/1/properties/effortLevels/items/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data8) < 1){validate739.errors = [{instancePath:instancePath+"/effortLevels/" + i0,schemaPath:"#/oneOf/1/properties/effortLevels/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data8)){validate739.errors = [{instancePath:instancePath+"/effortLevels/" + i0,schemaPath:"#/oneOf/1/properties/effortLevels/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate739.errors = [{instancePath:instancePath+"/effortLevels/" + i0,schemaPath:"#/oneOf/1/properties/effortLevels/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs38 === errors;if(!valid10){break;}}}else {validate739.errors = [{instancePath:instancePath+"/effortLevels",schemaPath:"#/oneOf/1/properties/effortLevels/type",keyword:"type",params:{type: "array"}}];return false;}}var valid7: any = _errs36 === errors;}else {var valid7: any = true;}}}}}}}else {validate739.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs21 === errors;if(props0 !== true){props0 = true;}valid0 = valid6;}else if(tag0 === "accountUnavailable"){const _errs40: any = errors;if(errors === _errs40){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.reason === undefined) && (missing2 = "reason")) || ((data.definitionId === undefined) && (missing2 = "definitionId"))) || ((data.providerAccountId === undefined) && (missing2 = "providerAccountId"))){validate739.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs42: any = errors;for(const key2 in data){if(!(((key2 === "reason") || (key2 === "definitionId")) || (key2 === "providerAccountId"))){validate739.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs42 === errors){if(data.reason !== undefined){let data9: any = data.reason;const _errs43: any = errors;if(typeof data9 !== "string"){validate739.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("accountUnavailable" !== data9){validate739.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/const",keyword:"const",params:{allowedValue: "accountUnavailable"}}];return false;}var valid12: any = _errs43 === errors;}else {var valid12: any = true;}if(valid12){if(data.definitionId !== undefined){let data10: any = data.definitionId;const _errs45: any = errors;const _errs46: any = errors;let valid13: any = false;const _errs47: any = errors;const _errs48: any = errors;if(errors === _errs48){if(typeof data10 === "string"){if(!pattern4.test(data10)){const err8: any = {instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}else {const err9: any = {instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}var _valid2: any = _errs47 === errors;valid13 = valid13 || _valid2;const _errs51: any = errors;if(data10 !== null){const err10: any = {instancePath:instancePath+"/definitionId",schemaPath:"#/oneOf/2/properties/definitionId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}var _valid2: any = _errs51 === errors;valid13 = valid13 || _valid2;if(!valid13){const err11: any = {instancePath:instancePath+"/definitionId",schemaPath:"#/oneOf/2/properties/definitionId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;validate739.errors = vErrors;return false;}else {errors = _errs46;if(vErrors !== null){if(_errs46){vErrors.length = _errs46;}else {vErrors = null;}}}var valid12: any = _errs45 === errors;}else {var valid12: any = true;}if(valid12){if(data.providerAccountId !== undefined){let data11: any = data.providerAccountId;const _errs53: any = errors;const _errs54: any = errors;if(errors === _errs54){if(typeof data11 === "string"){if(func1(data11) > 256){validate739.errors = [{instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data11) < 1){validate739.errors = [{instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate739.errors = [{instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs53 === errors;}else {var valid12: any = true;}}}}}}else {validate739.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid11: any = _errs40 === errors;if(props0 !== true){props0 = true;}valid0 = valid11;}else if(tag0 === "allowlistUnrealizable"){const _errs57: any = errors;if(errors === _errs57){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((data.reason === undefined) && (missing3 = "reason")) || ((data.definitionId === undefined) && (missing3 = "definitionId"))) || ((data.toolNames === undefined) && (missing3 = "toolNames"))) || ((data.supportedToolNames === undefined) && (missing3 = "supportedToolNames"))){validate739.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs59: any = errors;for(const key3 in data){if(!((((key3 === "reason") || (key3 === "definitionId")) || (key3 === "toolNames")) || (key3 === "supportedToolNames"))){validate739.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs59 === errors){if(data.reason !== undefined){let data12: any = data.reason;const _errs60: any = errors;if(typeof data12 !== "string"){validate739.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("allowlistUnrealizable" !== data12){validate739.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/const",keyword:"const",params:{allowedValue: "allowlistUnrealizable"}}];return false;}var valid17: any = _errs60 === errors;}else {var valid17: any = true;}if(valid17){if(data.definitionId !== undefined){let data13: any = data.definitionId;const _errs62: any = errors;const _errs63: any = errors;let valid18: any = false;const _errs64: any = errors;const _errs65: any = errors;if(errors === _errs65){if(typeof data13 === "string"){if(!pattern4.test(data13)){const err12: any = {instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}else {const err13: any = {instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}var _valid3: any = _errs64 === errors;valid18 = valid18 || _valid3;const _errs68: any = errors;if(data13 !== null){const err14: any = {instancePath:instancePath+"/definitionId",schemaPath:"#/oneOf/3/properties/definitionId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}var _valid3: any = _errs68 === errors;valid18 = valid18 || _valid3;if(!valid18){const err15: any = {instancePath:instancePath+"/definitionId",schemaPath:"#/oneOf/3/properties/definitionId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;validate739.errors = vErrors;return false;}else {errors = _errs63;if(vErrors !== null){if(_errs63){vErrors.length = _errs63;}else {vErrors = null;}}}var valid17: any = _errs62 === errors;}else {var valid17: any = true;}if(valid17){if(data.toolNames !== undefined){let data14: any = data.toolNames;const _errs70: any = errors;if(errors === _errs70){if(Array.isArray(data14)){if(data14.length < 1){validate739.errors = [{instancePath:instancePath+"/toolNames",schemaPath:"#/oneOf/3/properties/toolNames/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid20: any = true;const len1: any = data14.length;for(let i1=0; i1<len1; i1++){let data15: any = data14[i1];const _errs72: any = errors;if(errors === _errs72){if(typeof data15 === "string"){if(func1(data15) > 128){validate739.errors = [{instancePath:instancePath+"/toolNames/" + i1,schemaPath:"#/oneOf/3/properties/toolNames/items/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data15) < 1){validate739.errors = [{instancePath:instancePath+"/toolNames/" + i1,schemaPath:"#/oneOf/3/properties/toolNames/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data15)){validate739.errors = [{instancePath:instancePath+"/toolNames/" + i1,schemaPath:"#/oneOf/3/properties/toolNames/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate739.errors = [{instancePath:instancePath+"/toolNames/" + i1,schemaPath:"#/oneOf/3/properties/toolNames/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid20: any = _errs72 === errors;if(!valid20){break;}}}}else {validate739.errors = [{instancePath:instancePath+"/toolNames",schemaPath:"#/oneOf/3/properties/toolNames/type",keyword:"type",params:{type: "array"}}];return false;}}var valid17: any = _errs70 === errors;}else {var valid17: any = true;}if(valid17){if(data.supportedToolNames !== undefined){let data16: any = data.supportedToolNames;const _errs74: any = errors;if(errors === _errs74){if(Array.isArray(data16)){var valid21: any = true;const len2: any = data16.length;for(let i2=0; i2<len2; i2++){let data17: any = data16[i2];const _errs76: any = errors;if(errors === _errs76){if(typeof data17 === "string"){if(func1(data17) > 128){validate739.errors = [{instancePath:instancePath+"/supportedToolNames/" + i2,schemaPath:"#/oneOf/3/properties/supportedToolNames/items/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data17) < 1){validate739.errors = [{instancePath:instancePath+"/supportedToolNames/" + i2,schemaPath:"#/oneOf/3/properties/supportedToolNames/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data17)){validate739.errors = [{instancePath:instancePath+"/supportedToolNames/" + i2,schemaPath:"#/oneOf/3/properties/supportedToolNames/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate739.errors = [{instancePath:instancePath+"/supportedToolNames/" + i2,schemaPath:"#/oneOf/3/properties/supportedToolNames/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid21: any = _errs76 === errors;if(!valid21){break;}}}else {validate739.errors = [{instancePath:instancePath+"/supportedToolNames",schemaPath:"#/oneOf/3/properties/supportedToolNames/type",keyword:"type",params:{type: "array"}}];return false;}}var valid17: any = _errs74 === errors;}else {var valid17: any = true;}}}}}}}else {validate739.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid16: any = _errs57 === errors;if(props0 !== true){props0 = true;}valid0 = valid16;}else if(tag0 === "providerUnsupported"){const _errs78: any = errors;if(errors === _errs78){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((((data.reason === undefined) && (missing4 = "reason")) || ((data.definitionId === undefined) && (missing4 = "definitionId"))) || ((data.unsupportedProviderName === undefined) && (missing4 = "unsupportedProviderName"))){validate739.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs80: any = errors;for(const key4 in data){if(!(((key4 === "reason") || (key4 === "definitionId")) || (key4 === "unsupportedProviderName"))){validate739.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs80 === errors){if(data.reason !== undefined){let data18: any = data.reason;const _errs81: any = errors;if(typeof data18 !== "string"){validate739.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/4/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("providerUnsupported" !== data18){validate739.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/4/properties/reason/const",keyword:"const",params:{allowedValue: "providerUnsupported"}}];return false;}var valid23: any = _errs81 === errors;}else {var valid23: any = true;}if(valid23){if(data.definitionId !== undefined){let data19: any = data.definitionId;const _errs83: any = errors;const _errs84: any = errors;let valid24: any = false;const _errs85: any = errors;const _errs86: any = errors;if(errors === _errs86){if(typeof data19 === "string"){if(!pattern4.test(data19)){const err16: any = {instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}else {const err17: any = {instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}}var _valid4: any = _errs85 === errors;valid24 = valid24 || _valid4;const _errs89: any = errors;if(data19 !== null){const err18: any = {instancePath:instancePath+"/definitionId",schemaPath:"#/oneOf/4/properties/definitionId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}var _valid4: any = _errs89 === errors;valid24 = valid24 || _valid4;if(!valid24){const err19: any = {instancePath:instancePath+"/definitionId",schemaPath:"#/oneOf/4/properties/definitionId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;validate739.errors = vErrors;return false;}else {errors = _errs84;if(vErrors !== null){if(_errs84){vErrors.length = _errs84;}else {vErrors = null;}}}var valid23: any = _errs83 === errors;}else {var valid23: any = true;}if(valid23){if(data.unsupportedProviderName !== undefined){let data20: any = data.unsupportedProviderName;const _errs91: any = errors;if(errors === _errs91){if(typeof data20 === "string"){if(func1(data20) > 128){validate739.errors = [{instancePath:instancePath+"/unsupportedProviderName",schemaPath:"#/oneOf/4/properties/unsupportedProviderName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data20) < 1){validate739.errors = [{instancePath:instancePath+"/unsupportedProviderName",schemaPath:"#/oneOf/4/properties/unsupportedProviderName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data20)){validate739.errors = [{instancePath:instancePath+"/unsupportedProviderName",schemaPath:"#/oneOf/4/properties/unsupportedProviderName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate739.errors = [{instancePath:instancePath+"/unsupportedProviderName",schemaPath:"#/oneOf/4/properties/unsupportedProviderName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid23: any = _errs91 === errors;}else {var valid23: any = true;}}}}}}else {validate739.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}var valid22: any = _errs78 === errors;if(props0 !== true){props0 = true;}valid0 = valid22;}else {validate739.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "reason", tagValue: tag0}}];return false;}}else {validate739.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "reason", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key5 in data){if(!props0 || !props0[key5]){validate739.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key5}}];return false;break;}}}}}else {validate739.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate739.errors = vErrors;return errors === 0;}
// prettier-ignore
validate739.errors = null as any[] | null;
// prettier-ignore
validate739.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate738(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate738.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.message === undefined) && (missing0 = "message")) || ((data.code === undefined) && (missing0 = "code"))) || ((data.details === undefined) && (missing0 = "details"))){validate738.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "message") || (key0 === "nodeId")) || (key0 === "itemIndex")) || (key0 === "code")) || (key0 === "details"))){validate738.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.message !== undefined){let data0: any = data.message;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validate738.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate738.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){let data1: any = data.nodeId;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) < 1){validate738.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate738.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.itemIndex !== undefined){let data2: any = data.itemIndex;const _errs8: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate738.errors = [{instancePath:instancePath+"/itemIndex",schemaPath:"#/properties/itemIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate738.errors = [{instancePath:instancePath+"/itemIndex",schemaPath:"#/properties/itemIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate738.errors = [{instancePath:instancePath+"/itemIndex",schemaPath:"#/properties/itemIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.code !== undefined){let data3: any = data.code;const _errs10: any = errors;if(typeof data3 !== "string"){validate738.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/type",keyword:"type",params:{type: "string"}}];return false;}if("agent.definition.resolutionRefused" !== data3){validate738.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/const",keyword:"const",params:{allowedValue: "agent.definition.resolutionRefused"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.details !== undefined){const _errs12: any = errors;if(!(validate739.call(this, data.details, {instancePath:instancePath+"/details",parentData:data,parentDataProperty:"details",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate739.errors : vErrors.concat(validate739.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}}else {validate738.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate738.errors = vErrors;return errors === 0;}
// prettier-ignore
validate738.errors = null as any[] | null;
// prettier-ignore
validate738.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate733(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate733.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validate734.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate734.errors : vErrors.concat(validate734.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs2: any = errors;if(!(validate736.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate736.errors : vErrors.concat(validate736.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs3: any = errors;if(!(validate738.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate738.errors : vErrors.concat(validate738.errors);errors = vErrors.length;}var _valid0: any = _errs3 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validate733.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate733.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate733.errors = null as any[] | null;
// prettier-ignore
validate733.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
function validate2363(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2363.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.json === undefined) && (missing0 = "json")){validate2363.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "json") || (key0 === "binary")) || (key0 === "pairedItem")) || (key0 === "error"))){validate2363.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.json !== undefined){const _errs2: any = errors;var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.binary !== undefined){let data1: any = data.binary;const _errs4: any = errors;if(errors === _errs4){if(data1 && typeof data1 == "object" && !Array.isArray(data1)){for(const key1 in data1){const _errs6: any = errors;const _errs7: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/binary",schemaPath:"#/properties/binary/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs7 === errors;if(valid2){const _errs9: any = errors;const _errs10: any = errors;const _errs11: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid3: any = _errs11 === errors;if(valid3){const err2: any = {instancePath:instancePath+"/binary",schemaPath:"#/properties/binary/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs10;if(vErrors !== null){if(_errs10){vErrors.length = _errs10;}else {vErrors = null;}}}var valid2: any = _errs9 === errors;}var valid1: any = _errs6 === errors;if(!valid1){const err3: any = {instancePath:instancePath+"/binary",schemaPath:"#/properties/binary/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate2363.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data1){const _errs13: any = errors;if(!(validate729.call(this, data1[key2], {instancePath:instancePath+"/binary/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),parentData:data1,parentDataProperty:key2,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate729.errors : vErrors.concat(validate729.errors);errors = vErrors.length;}var valid4: any = _errs13 === errors;if(!valid4){break;}}}}else {validate2363.errors = [{instancePath:instancePath+"/binary",schemaPath:"#/properties/binary/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.pairedItem !== undefined){const _errs14: any = errors;if(!(validate731.call(this, data.pairedItem, {instancePath:instancePath+"/pairedItem",parentData:data,parentDataProperty:"pairedItem",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate731.errors : vErrors.concat(validate731.errors);errors = vErrors.length;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.error !== undefined){const _errs15: any = errors;if(!(validate733.call(this, data.error, {instancePath:instancePath+"/error",parentData:data,parentDataProperty:"error",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate733.errors : vErrors.concat(validate733.errors);errors = vErrors.length;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}}}}}}}else {validate2363.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2363.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2363.errors = null as any[] | null;
// prettier-ignore
validate2363.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2471(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeExecuteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2471.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey")) || ((data.workflowVersionId === undefined) && (missing0 = "workflowVersionId"))) || ((data.nodeId === undefined) && (missing0 = "nodeId"))) || ((data.scope === undefined) && (missing0 = "scope"))){validate2471.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "clientIdempotencyKey") || (key0 === "workflowVersionId")) || (key0 === "sessionId")) || (key0 === "projectId")) || (key0 === "nodeId")) || (key0 === "scope")) || (key0 === "dirtyNodeIds")) || (key0 === "input"))){validate2471.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.clientIdempotencyKey !== undefined){let data0: any = data.clientIdempotencyKey;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(!pattern222.test(data0)){validate2471.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate2471.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.workflowVersionId !== undefined){let data1: any = data.workflowVersionId;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2471.errors = [{instancePath:instancePath+"/workflowVersionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2471.errors = [{instancePath:instancePath+"/workflowVersionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){let data2: any = data.sessionId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate2471.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2471.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.projectId !== undefined){let data3: any = data.projectId;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate2471.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2471.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){let data4: any = data.nodeId;const _errs16: any = errors;const _errs17: any = errors;if(errors === _errs17){if(typeof data4 === "string"){if(func1(data4) < 1){validate2471.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2471.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.scope !== undefined){let data5: any = data.scope;const _errs20: any = errors;if(typeof data5 !== "string"){validate2471.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/$defs/WorkflowNodeExecuteScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data5 === "node") || (data5 === "fromHere"))){validate2471.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/$defs/WorkflowNodeExecuteScope/enum",keyword:"enum",params:{allowedValues: schema4807.enum}}];return false;}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.dirtyNodeIds !== undefined){let data6: any = data.dirtyNodeIds;const _errs23: any = errors;if(errors === _errs23){if(Array.isArray(data6)){var valid6: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){let data7: any = data6[i0];const _errs25: any = errors;const _errs26: any = errors;if(errors === _errs26){if(typeof data7 === "string"){if(func1(data7) < 1){validate2471.errors = [{instancePath:instancePath+"/dirtyNodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2471.errors = [{instancePath:instancePath+"/dirtyNodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs25 === errors;if(!valid6){break;}}}else {validate2471.errors = [{instancePath:instancePath+"/dirtyNodeIds",schemaPath:"#/properties/dirtyNodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs23 === errors;}else {var valid0: any = true;}if(valid0){if(data.input !== undefined){let data8: any = data.input;const _errs29: any = errors;if(errors === _errs29){if(Array.isArray(data8)){var valid8: any = true;const len1: any = data8.length;for(let i1=0; i1<len1; i1++){const _errs31: any = errors;if(!(validate2363.call(this, data8[i1], {instancePath:instancePath+"/input/" + i1,parentData:data8,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2363.errors : vErrors.concat(validate2363.errors);errors = vErrors.length;}var valid8: any = _errs31 === errors;if(!valid8){break;}}}else {validate2471.errors = [{instancePath:instancePath+"/input",schemaPath:"#/properties/input/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs29 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validate2471.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2471.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2471.errors = null as any[] | null;
// prettier-ignore
validate2471.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2473(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeExecuteResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2473.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.executedNodeIds === undefined) && (missing0 = "executedNodeIds"))) || ((data.reusedNodeIds === undefined) && (missing0 = "reusedNodeIds"))){validate2473.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "workflowRunId") || (key0 === "executedNodeIds")) || (key0 === "reusedNodeIds"))){validate2473.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2473.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2473.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.executedNodeIds !== undefined){let data1: any = data.executedNodeIds;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(func1(data2) < 1){validate2473.errors = [{instancePath:instancePath+"/executedNodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2473.errors = [{instancePath:instancePath+"/executedNodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;if(!valid2){break;}}}else {validate2473.errors = [{instancePath:instancePath+"/executedNodeIds",schemaPath:"#/properties/executedNodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.reusedNodeIds !== undefined){let data3: any = data.reusedNodeIds;const _errs12: any = errors;if(errors === _errs12){if(Array.isArray(data3)){var valid4: any = true;const len1: any = data3.length;for(let i1=0; i1<len1; i1++){let data4: any = data3[i1];const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data4 === "string"){if(func1(data4) < 1){validate2473.errors = [{instancePath:instancePath+"/reusedNodeIds/" + i1,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2473.errors = [{instancePath:instancePath+"/reusedNodeIds/" + i1,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs14 === errors;if(!valid4){break;}}}else {validate2473.errors = [{instancePath:instancePath+"/reusedNodeIds",schemaPath:"#/properties/reusedNodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}else {validate2473.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2473.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2473.errors = null as any[] | null;
// prettier-ignore
validate2473.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2474(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowResultsPostRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2474.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))){validate2474.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "sessionId"))){validate2474.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2474.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2474.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2474.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2474.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2474.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2474.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2474.errors = null as any[] | null;
// prettier-ignore
validate2474.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2475(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowResultsPostResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2475.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.posted === undefined) && (missing0 = "posted"))){validate2475.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "posted"))){validate2475.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2475.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2475.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.posted !== undefined){let data1: any = data.posted;const _errs6: any = errors;if(typeof data1 !== "boolean"){validate2475.errors = [{instancePath:instancePath+"/posted",schemaPath:"#/properties/posted/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data1){validate2475.errors = [{instancePath:instancePath+"/posted",schemaPath:"#/properties/posted/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2475.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2475.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2475.errors = null as any[] | null;
// prettier-ignore
validate2475.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2476(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunCancelRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2476.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workflowRunId === undefined) && (missing0 = "workflowRunId")){validate2476.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "reason"))){validate2476.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2476.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2476.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data1: any = data.reason;const _errs6: any = errors;const _errs7: any = errors;if(wireByteLength(data1, this && this.attachments) > 8192){validate2476.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/WorkflowCancelReason/maxJsonBytes",keyword:"maxJsonBytes",params:{}}];return false;}if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 8190){validate2476.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/WorkflowCancelReason/maxLength",keyword:"maxLength",params:{limit: 8190}}];return false;}else {if(func1(data1) < 1){validate2476.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/WorkflowCancelReason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2476.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/WorkflowCancelReason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2476.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2476.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2476.errors = null as any[] | null;
// prettier-ignore
validate2476.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4821: any = {"type":"object","additionalProperties":false,"properties":{"workflowRunId":{"$ref":"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId","description":"The run."},"status":{"description":"`canceled`.","type":"string","enum":["canceled"]},"canceledEventId":{"type":"string","minLength":1,"description":"The `workflow.run.canceled` event the cancel wrote."},"alreadyCanceled":{"type":"boolean","description":"Whether the run was already canceled."}},"required":["workflowRunId","status","canceledEventId","alreadyCanceled"],"description":"The `workflow.run.cancel` result. Cancel is offered on a new, running or waiting run, and on a\nfailed run parked on its failed step; `alreadyCanceled` is true when the run was already\ncanceled and this call returned the first cancel's saved result, `canceledEventId` naming the\noriginal event and no second one written."};
// prettier-ignore
function validate2477(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunCancelResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2477.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.status === undefined) && (missing0 = "status"))) || ((data.canceledEventId === undefined) && (missing0 = "canceledEventId"))) || ((data.alreadyCanceled === undefined) && (missing0 = "alreadyCanceled"))){validate2477.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "workflowRunId") || (key0 === "status")) || (key0 === "canceledEventId")) || (key0 === "alreadyCanceled"))){validate2477.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2477.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2477.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){let data1: any = data.status;const _errs6: any = errors;if(typeof data1 !== "string"){validate2477.errors = [{instancePath:instancePath+"/status",schemaPath:"#/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data1 === "canceled")){validate2477.errors = [{instancePath:instancePath+"/status",schemaPath:"#/properties/status/enum",keyword:"enum",params:{allowedValues: schema4821.properties.status.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.canceledEventId !== undefined){let data2: any = data.canceledEventId;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) < 1){validate2477.errors = [{instancePath:instancePath+"/canceledEventId",schemaPath:"#/properties/canceledEventId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2477.errors = [{instancePath:instancePath+"/canceledEventId",schemaPath:"#/properties/canceledEventId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.alreadyCanceled !== undefined){const _errs10: any = errors;if(typeof data.alreadyCanceled !== "boolean"){validate2477.errors = [{instancePath:instancePath+"/alreadyCanceled",schemaPath:"#/properties/alreadyCanceled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}else {validate2477.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2477.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2477.errors = null as any[] | null;
// prettier-ignore
validate2477.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2478(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunHandleUndeclaredDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2478.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.nodeIds === undefined) && (missing0 = "nodeIds")) || ((data.handles === undefined) && (missing0 = "handles"))){validate2478.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "nodeIds") || (key0 === "handles"))){validate2478.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.nodeIds !== undefined){let data0: any = data.nodeIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validate2478.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) < 1){validate2478.errors = [{instancePath:instancePath+"/nodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2478.errors = [{instancePath:instancePath+"/nodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validate2478.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.handles !== undefined){let data2: any = data.handles;const _errs8: any = errors;if(errors === _errs8){if(Array.isArray(data2)){if(data2.length < 1){validate2478.errors = [{instancePath:instancePath+"/handles",schemaPath:"#/properties/handles/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid3: any = true;const len1: any = data2.length;for(let i1=0; i1<len1; i1++){let data3: any = data2[i1];const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) < 1){validate2478.errors = [{instancePath:instancePath+"/handles/" + i1,schemaPath:"#/properties/handles/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2478.errors = [{instancePath:instancePath+"/handles/" + i1,schemaPath:"#/properties/handles/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs10 === errors;if(!valid3){break;}}}}else {validate2478.errors = [{instancePath:instancePath+"/handles",schemaPath:"#/properties/handles/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}else {validate2478.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2478.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2478.errors = null as any[] | null;
// prettier-ignore
validate2478.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2479(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunIdempotencyConflictDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2479.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workflowRunId === undefined) && (missing0 = "workflowRunId")){validate2479.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sourceWorkflowRunId") || (key0 === "workflowRunId"))){validate2479.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sourceWorkflowRunId !== undefined){let data0: any = data.sourceWorkflowRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2479.errors = [{instancePath:instancePath+"/sourceWorkflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2479.errors = [{instancePath:instancePath+"/sourceWorkflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.workflowRunId !== undefined){let data1: any = data.workflowRunId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2479.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2479.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2479.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2479.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2479.errors = null as any[] | null;
// prettier-ignore
validate2479.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2480(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunInputRequiredDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2480.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.inputNames === undefined) && (missing0 = "inputNames")){validate2480.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "inputNames")){validate2480.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.inputNames !== undefined){let data0: any = data.inputNames;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validate2480.errors = [{instancePath:instancePath+"/inputNames",schemaPath:"#/properties/inputNames/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validate2480.errors = [{instancePath:instancePath+"/inputNames/" + i0,schemaPath:"#/properties/inputNames/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2480.errors = [{instancePath:instancePath+"/inputNames/" + i0,schemaPath:"#/properties/inputNames/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validate2480.errors = [{instancePath:instancePath+"/inputNames",schemaPath:"#/properties/inputNames/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate2480.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2480.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2480.errors = null as any[] | null;
// prettier-ignore
validate2480.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2481(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunNodeKindUnavailableDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2481.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.nodeIds === undefined) && (missing0 = "nodeIds")){validate2481.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "nodeIds")){validate2481.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.nodeIds !== undefined){let data0: any = data.nodeIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validate2481.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) < 1){validate2481.errors = [{instancePath:instancePath+"/nodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2481.errors = [{instancePath:instancePath+"/nodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validate2481.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate2481.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2481.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2481.errors = null as any[] | null;
// prettier-ignore
validate2481.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2482(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunProviderRequiredDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2482.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.nodeIds === undefined) && (missing0 = "nodeIds")){validate2482.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "nodeIds")){validate2482.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.nodeIds !== undefined){let data0: any = data.nodeIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validate2482.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) < 1){validate2482.errors = [{instancePath:instancePath+"/nodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2482.errors = [{instancePath:instancePath+"/nodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validate2482.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate2482.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2482.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2482.errors = null as any[] | null;
// prettier-ignore
validate2482.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2483(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunRepositoryRequiredDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2483.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.nodeIds === undefined) && (missing0 = "nodeIds")){validate2483.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "nodeIds")){validate2483.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.nodeIds !== undefined){let data0: any = data.nodeIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validate2483.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) < 1){validate2483.errors = [{instancePath:instancePath+"/nodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2483.errors = [{instancePath:instancePath+"/nodeIds/" + i0,schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validate2483.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate2483.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2483.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2483.errors = null as any[] | null;
// prettier-ignore
validate2483.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2484(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunRerunRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2484.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validate2484.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "clientIdempotencyKey"))){validate2484.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2484.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2484.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data1: any = data.clientIdempotencyKey;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(!pattern222.test(data1)){validate2484.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate2484.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2484.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2484.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2484.errors = null as any[] | null;
// prettier-ignore
validate2484.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2486(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2486.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.targetWorkflowVersionId === undefined) && (missing0 = "targetWorkflowVersionId")){validate2486.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "targetWorkflowVersionId")){validate2486.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.targetWorkflowVersionId !== undefined){let data0: any = data.targetWorkflowVersionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2486.errors = [{instancePath:instancePath+"/targetWorkflowVersionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2486.errors = [{instancePath:instancePath+"/targetWorkflowVersionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2486.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2486.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2486.errors = null as any[] | null;
// prettier-ignore
validate2486.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2485(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunResumeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2485.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workflowRunId === undefined) && (missing0 = "workflowRunId")){validate2485.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "versionRepin"))){validate2485.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2485.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2485.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.versionRepin !== undefined){const _errs6: any = errors;if(!(validate2486.call(this, data.versionRepin, {instancePath:instancePath+"/versionRepin",parentData:data,parentDataProperty:"versionRepin",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2486.errors : vErrors.concat(validate2486.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2485.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2485.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2485.errors = null as any[] | null;
// prettier-ignore
validate2485.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4843: any = {"description":"The status a resume answers with: running, or waiting again where it reached a provider account\nstill out of quota, which is a legal outcome and not a refusal.","type":"string","enum":["running","waiting"]};
// prettier-ignore
function validate2488(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunResumeResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2488.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.status === undefined) && (missing0 = "status"))){validate2488.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "workflowRunId") || (key0 === "status")) || (key0 === "repinnedFromWorkflowVersionId")) || (key0 === "repinnedToWorkflowVersionId"))){validate2488.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2488.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2488.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){let data1: any = data.status;const _errs6: any = errors;if(typeof data1 !== "string"){validate2488.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/WorkflowRunResumeStatus/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data1 === "running") || (data1 === "waiting"))){validate2488.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/WorkflowRunResumeStatus/enum",keyword:"enum",params:{allowedValues: schema4843.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.repinnedFromWorkflowVersionId !== undefined){let data2: any = data.repinnedFromWorkflowVersionId;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate2488.errors = [{instancePath:instancePath+"/repinnedFromWorkflowVersionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2488.errors = [{instancePath:instancePath+"/repinnedFromWorkflowVersionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.repinnedToWorkflowVersionId !== undefined){let data3: any = data.repinnedToWorkflowVersionId;const _errs13: any = errors;const _errs14: any = errors;if(errors === _errs14){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate2488.errors = [{instancePath:instancePath+"/repinnedToWorkflowVersionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2488.errors = [{instancePath:instancePath+"/repinnedToWorkflowVersionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.repinnedFromWorkflowVersionId !== undefined && ((data.repinnedToWorkflowVersionId === undefined) && (missing1 = "repinnedToWorkflowVersionId"))){validate2488.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "repinnedFromWorkflowVersionId",
    missingProperty: missing1,
    depsCount: 1,
    deps: "repinnedToWorkflowVersionId"}}];return false;}else {if(data.repinnedToWorkflowVersionId !== undefined && ((data.repinnedFromWorkflowVersionId === undefined) && (missing1 = "repinnedFromWorkflowVersionId"))){validate2488.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "repinnedToWorkflowVersionId",
    missingProperty: missing1,
    depsCount: 1,
    deps: "repinnedFromWorkflowVersionId"}}];return false;}}}}}}}}}else {validate2488.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2488.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2488.errors = null as any[] | null;
// prettier-ignore
validate2488.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2489(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunRetryRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2489.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.fromNodeId === undefined) && (missing0 = "fromNodeId"))) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validate2489.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "workflowRunId") || (key0 === "fromNodeId")) || (key0 === "clientIdempotencyKey"))){validate2489.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2489.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2489.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.fromNodeId !== undefined){let data1: any = data.fromNodeId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) < 1){validate2489.errors = [{instancePath:instancePath+"/fromNodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2489.errors = [{instancePath:instancePath+"/fromNodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data2: any = data.clientIdempotencyKey;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(!pattern222.test(data2)){validate2489.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate2489.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate2489.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2489.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2489.errors = null as any[] | null;
// prettier-ignore
validate2489.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4852: any = {"description":"The status a new run can answer with: admitted but not yet dispatched, or already running.","type":"string","enum":["new","running"]};
// prettier-ignore
const func0 = deepEqual;
// prettier-ignore
function validate2490(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunRetryResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2490.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.sourceWorkflowRunId === undefined) && (missing0 = "sourceWorkflowRunId"))) || ((data.status === undefined) && (missing0 = "status"))){validate2490.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "workflowRunId") || (key0 === "sourceWorkflowRunId")) || (key0 === "status"))){validate2490.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;if(typeof data0 !== "string"){validate2490.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"#/properties/workflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2490.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2490.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs3 === errors;if(valid1){const _errs7: any = errors;const _errs8: any = errors;const vSchema0: any = data && data.sourceWorkflowRunId;if(vSchema0 !== undefined && (!func0(data0, vSchema0))){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs8 === errors;if(valid2){validate2490.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"#/properties/workflowRunId/not",keyword:"not",params:{}}];return false;}else {errors = _errs7;if(vErrors !== null){if(_errs7){vErrors.length = _errs7;}else {vErrors = null;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourceWorkflowRunId !== undefined){let data1: any = data.sourceWorkflowRunId;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2490.errors = [{instancePath:instancePath+"/sourceWorkflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2490.errors = [{instancePath:instancePath+"/sourceWorkflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){let data2: any = data.status;const _errs13: any = errors;if(typeof data2 !== "string"){validate2490.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/WorkflowRunStartStatus/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data2 === "new") || (data2 === "running"))){validate2490.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/WorkflowRunStartStatus/enum",keyword:"enum",params:{allowedValues: schema4852.enum}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}else {validate2490.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2490.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2490.errors = null as any[] | null;
// prettier-ignore
validate2490.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4857: any = {"description":"The start modes a caller may ask for; `retry` and `subWorkflow` come from their own methods.","type":"string","enum":["manual","trigger","webhook","chat","agent"]};
// prettier-ignore
function validate2491(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2491.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey")) || ((data.workflowVersionId === undefined) && (missing0 = "workflowVersionId"))){validate2491.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "clientIdempotencyKey") || (key0 === "workflowVersionId")) || (key0 === "sessionId")) || (key0 === "projectId")) || (key0 === "input")) || (key0 === "mode"))){validate2491.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.clientIdempotencyKey !== undefined){let data0: any = data.clientIdempotencyKey;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(!pattern222.test(data0)){validate2491.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate2491.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.workflowVersionId !== undefined){let data1: any = data.workflowVersionId;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2491.errors = [{instancePath:instancePath+"/workflowVersionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2491.errors = [{instancePath:instancePath+"/workflowVersionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){let data2: any = data.sessionId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate2491.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2491.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.projectId !== undefined){let data3: any = data.projectId;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate2491.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2491.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.input !== undefined){let data4: any = data.input;const _errs16: any = errors;if(errors === _errs16){if(Array.isArray(data4)){var valid4: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs18: any = errors;if(!(validate2363.call(this, data4[i0], {instancePath:instancePath+"/input/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2363.errors : vErrors.concat(validate2363.errors);errors = vErrors.length;}var valid4: any = _errs18 === errors;if(!valid4){break;}}}else {validate2491.errors = [{instancePath:instancePath+"/input",schemaPath:"#/properties/input/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.mode !== undefined){let data6: any = data.mode;const _errs19: any = errors;if(typeof data6 !== "string"){validate2491.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/$defs/WorkflowRequestableRunMode/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data6 === "manual") || (data6 === "trigger")) || (data6 === "webhook")) || (data6 === "chat")) || (data6 === "agent"))){validate2491.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/$defs/WorkflowRequestableRunMode/enum",keyword:"enum",params:{allowedValues: schema4857.enum}}];return false;}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate2491.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2491.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2491.errors = null as any[] | null;
// prettier-ignore
validate2491.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2493(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunStartResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2493.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.status === undefined) && (missing0 = "status"))){validate2493.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "workflowRunId") || (key0 === "sessionId")) || (key0 === "status"))){validate2493.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2493.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2493.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2493.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2493.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){let data2: any = data.status;const _errs10: any = errors;if(typeof data2 !== "string"){validate2493.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/WorkflowRunStartStatus/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data2 === "new") || (data2 === "running"))){validate2493.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/WorkflowRunStartStatus/enum",keyword:"enum",params:{allowedValues: schema4852.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate2493.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2493.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2493.errors = null as any[] | null;
// prettier-ignore
validate2493.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4863: any = {"description":"Why `workflow.run.stillRunning` refused a retry; its one cause is a source run still going.","type":"string","enum":["sourceRunning"]};
// prettier-ignore
function validate2494(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunStillRunningDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2494.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.reason === undefined) && (missing0 = "reason")){validate2494.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "reason")){validate2494.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reason !== undefined){let data0: any = data.reason;if(typeof data0 !== "string"){validate2494.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/WorkflowRunStillRunningReason/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "sourceRunning")){validate2494.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/WorkflowRunStillRunningReason/enum",keyword:"enum",params:{allowedValues: schema4863.enum}}];return false;}}}}}else {validate2494.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2494.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2494.errors = null as any[] | null;
// prettier-ignore
validate2494.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowCancelReason}. */
export const validateWorkflowCancelReason: SchemaCheck<WorkflowCancelReason> = validate2469;
/** Checks that a value is a {@link WorkflowCodePackagesNotLockedDetails}. */
export const validateWorkflowCodePackagesNotLockedDetails: SchemaCheck<WorkflowCodePackagesNotLockedDetails> =
  validate2470;
/** Checks that a value is a {@link WorkflowNodeExecuteRequest}. */
export const validateWorkflowNodeExecuteRequest: SchemaCheck<WorkflowNodeExecuteRequest> =
  validate2471;
/** Checks that a value is a {@link WorkflowNodeExecuteResponse}. */
export const validateWorkflowNodeExecuteResponse: SchemaCheck<WorkflowNodeExecuteResponse> =
  validate2473;
/** Checks that a value is a {@link WorkflowResultsPostRequest}. */
export const validateWorkflowResultsPostRequest: SchemaCheck<WorkflowResultsPostRequest> =
  validate2474;
/** Checks that a value is a {@link WorkflowResultsPostResponse}. */
export const validateWorkflowResultsPostResponse: SchemaCheck<WorkflowResultsPostResponse> =
  validate2475;
/** Checks that a value is a {@link WorkflowRunCancelRequest}. */
export const validateWorkflowRunCancelRequest: SchemaCheck<WorkflowRunCancelRequest> = validate2476;
/** Checks that a value is a {@link WorkflowRunCancelResponse}. */
export const validateWorkflowRunCancelResponse: SchemaCheck<WorkflowRunCancelResponse> =
  validate2477;
/** Checks that a value is a {@link WorkflowRunHandleUndeclaredDetails}. */
export const validateWorkflowRunHandleUndeclaredDetails: SchemaCheck<WorkflowRunHandleUndeclaredDetails> =
  validate2478;
/** Checks that a value is a {@link WorkflowRunIdempotencyConflictDetails}. */
export const validateWorkflowRunIdempotencyConflictDetails: SchemaCheck<WorkflowRunIdempotencyConflictDetails> =
  validate2479;
/** Checks that a value is a {@link WorkflowRunInputRequiredDetails}. */
export const validateWorkflowRunInputRequiredDetails: SchemaCheck<WorkflowRunInputRequiredDetails> =
  validate2480;
/** Checks that a value is a {@link WorkflowRunNodeKindUnavailableDetails}. */
export const validateWorkflowRunNodeKindUnavailableDetails: SchemaCheck<WorkflowRunNodeKindUnavailableDetails> =
  validate2481;
/** Checks that a value is a {@link WorkflowRunProviderRequiredDetails}. */
export const validateWorkflowRunProviderRequiredDetails: SchemaCheck<WorkflowRunProviderRequiredDetails> =
  validate2482;
/** Checks that a value is a {@link WorkflowRunRepositoryRequiredDetails}. */
export const validateWorkflowRunRepositoryRequiredDetails: SchemaCheck<WorkflowRunRepositoryRequiredDetails> =
  validate2483;
/** Checks that a value is a {@link WorkflowRunRerunRequest}. */
export const validateWorkflowRunRerunRequest: SchemaCheck<WorkflowRunRerunRequest> = validate2484;
/** Checks that a value is a {@link WorkflowRunResumeRequest}. */
export const validateWorkflowRunResumeRequest: SchemaCheck<WorkflowRunResumeRequest> = validate2485;
/** Checks that a value is a {@link WorkflowRunResumeResponse}. */
export const validateWorkflowRunResumeResponse: SchemaCheck<WorkflowRunResumeResponse> =
  validate2488;
/** Checks that a value is a {@link WorkflowRunRetryRequest}. */
export const validateWorkflowRunRetryRequest: SchemaCheck<WorkflowRunRetryRequest> = validate2489;
/** Checks that a value is a {@link WorkflowRunRetryResponse}. */
export const validateWorkflowRunRetryResponse: SchemaCheck<WorkflowRunRetryResponse> = validate2490;
/** Checks that a value is a {@link WorkflowRunStartRequest}. */
export const validateWorkflowRunStartRequest: SchemaCheck<WorkflowRunStartRequest> = validate2491;
/** Checks that a value is a {@link WorkflowRunStartResponse}. */
export const validateWorkflowRunStartResponse: SchemaCheck<WorkflowRunStartResponse> = validate2493;
/** Checks that a value is a {@link WorkflowRunStillRunningDetails}. */
export const validateWorkflowRunStillRunningDetails: SchemaCheck<WorkflowRunStillRunningDetails> =
  validate2494;

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
  Object.freeze({
    "workflow.run.start": Object.freeze({
      method: "workflow.run.start",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowRunStartRequest,
      responseCheck: validateWorkflowRunStartResponse,
    }),
    "workflow.run.cancel": Object.freeze({
      method: "workflow.run.cancel",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowRunCancelRequest,
      responseCheck: validateWorkflowRunCancelResponse,
    }),
    "workflow.run.resume": Object.freeze({
      method: "workflow.run.resume",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowRunResumeRequest,
      responseCheck: validateWorkflowRunResumeResponse,
    }),
    "workflow.run.retry": Object.freeze({
      method: "workflow.run.retry",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowRunRetryRequest,
      responseCheck: validateWorkflowRunRetryResponse,
    }),
    "workflow.run.rerun": Object.freeze({
      method: "workflow.run.rerun",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowRunRerunRequest,
      responseCheck: validateWorkflowRunStartResponse,
    }),
    "workflow.node.execute": Object.freeze({
      method: "workflow.node.execute",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowNodeExecuteRequest,
      responseCheck: validateWorkflowNodeExecuteResponse,
    }),
    "workflow.results.post": Object.freeze({
      method: "workflow.results.post",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowResultsPostRequest,
      responseCheck: validateWorkflowResultsPostResponse,
    }),
  });
