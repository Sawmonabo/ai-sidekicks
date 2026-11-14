// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The acts on a workflow run: starting one, canceling and resuming it, retrying from a step, running one node from the builder and posting a finished run's results into a session, with their refusals and their method table.

import {
  type CompiledSchemaCheck,
  type SchemaCheck,
  deepEqual,
  ucs2length,
  wireByteLength,
} from "../../../schema-check.js";
import { type ProjectId, validateProjectId } from "../../project.js";
import { type SessionId, validateSessionId } from "../../session/id.js";
import {
  type WorkflowNodeId,
  type WorkflowVersionId,
  validateWorkflowNodeId,
  validateWorkflowVersionId,
} from "../definition/document.js";
import { type WorkflowItem, validateWorkflowItem } from "../definition/item.js";
import { type WorkflowRunId, validateWorkflowRunId } from "./id.js";

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
/** Checks that a value is a {@link WorkflowCancelReason}. */
// prettier-ignore
export const validateWorkflowCancelReason: CompiledSchemaCheck<WorkflowCancelReason> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowCancelReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowCancelReason.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(wireByteLength(data, this && this.attachments) > 8192){validateWorkflowCancelReason.errors = [{instancePath,schemaPath:"#/maxJsonBytes",keyword:"maxJsonBytes",params:{}}];return false;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 8190){validateWorkflowCancelReason.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 8190}}];return false;}else {if(func1(data) < 1){validateWorkflowCancelReason.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateWorkflowCancelReason.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowCancelReason.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowCancelReason.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1535: any = {"description":"The start modes a caller may ask for; `retry` and `subWorkflow` come from their own methods.","type":"string","enum":["manual","trigger","webhook","chat","agent"]};
/** Checks that a value is a {@link WorkflowRequestableRunMode}. */
// prettier-ignore
export const validateWorkflowRequestableRunMode: CompiledSchemaCheck<WorkflowRequestableRunMode> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRequestableRunMode {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRequestableRunMode.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowRequestableRunMode.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data === "manual") || (data === "trigger")) || (data === "webhook")) || (data === "chat")) || (data === "agent"))){validateWorkflowRequestableRunMode.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1535.enum}}];return false;}validateWorkflowRequestableRunMode.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRequestableRunMode.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern88 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
/** Checks that a value is a {@link WorkflowRunStartRequest}. */
// prettier-ignore
export const validateWorkflowRunStartRequest: CompiledSchemaCheck<WorkflowRunStartRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunStartRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey")) || ((data.workflowVersionId === undefined) && (missing0 = "workflowVersionId"))){validateWorkflowRunStartRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "clientIdempotencyKey") || (key0 === "workflowVersionId")) || (key0 === "sessionId")) || (key0 === "projectId")) || (key0 === "input")) || (key0 === "mode"))){validateWorkflowRunStartRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.clientIdempotencyKey !== undefined){let data0: any = data.clientIdempotencyKey;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(!pattern88.test(data0)){validateWorkflowRunStartRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateWorkflowRunStartRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.workflowVersionId !== undefined){const _errs4: any = errors;if(!(validateWorkflowVersionId.call(this, data.workflowVersionId, {instancePath:instancePath+"/workflowVersionId",parentData:data,parentDataProperty:"workflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){const _errs5: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.projectId !== undefined){const _errs6: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.input !== undefined){let data4: any = data.input;const _errs7: any = errors;if(errors === _errs7){if(Array.isArray(data4)){var valid1: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs9: any = errors;if(!(validateWorkflowItem.call(this, data4[i0], {instancePath:instancePath+"/input/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowItem.errors : vErrors.concat(validateWorkflowItem.errors);errors = vErrors.length;}var valid1: any = _errs9 === errors;if(!valid1){break;}}}else {validateWorkflowRunStartRequest.errors = [{instancePath:instancePath+"/input",schemaPath:"#/properties/input/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.mode !== undefined){const _errs10: any = errors;if(!(validateWorkflowRequestableRunMode.call(this, data.mode, {instancePath:instancePath+"/mode",parentData:data,parentDataProperty:"mode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRequestableRunMode.errors : vErrors.concat(validateWorkflowRequestableRunMode.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateWorkflowRunStartRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunStartRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunStartRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1533: any = {"description":"The status a new run can answer with: admitted but not yet dispatched, or already running.","type":"string","enum":["new","running"]};
/** Checks that a value is a {@link WorkflowRunStartStatus}. */
// prettier-ignore
export const validateWorkflowRunStartStatus: CompiledSchemaCheck<WorkflowRunStartStatus> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunStartStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunStartStatus.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowRunStartStatus.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "new") || (data === "running"))){validateWorkflowRunStartStatus.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1533.enum}}];return false;}validateWorkflowRunStartStatus.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunStartStatus.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunStartResponse}. */
// prettier-ignore
export const validateWorkflowRunStartResponse: CompiledSchemaCheck<WorkflowRunStartResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunStartResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunStartResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.status === undefined) && (missing0 = "status"))){validateWorkflowRunStartResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "workflowRunId") || (key0 === "sessionId")) || (key0 === "status"))){validateWorkflowRunStartResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){const _errs3: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){const _errs4: any = errors;if(!(validateWorkflowRunStartStatus.call(this, data.status, {instancePath:instancePath+"/status",parentData:data,parentDataProperty:"status",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunStartStatus.errors : vErrors.concat(validateWorkflowRunStartStatus.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowRunStartResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunStartResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunStartResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunCancelRequest}. */
// prettier-ignore
export const validateWorkflowRunCancelRequest: CompiledSchemaCheck<WorkflowRunCancelRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunCancelRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunCancelRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workflowRunId === undefined) && (missing0 = "workflowRunId")){validateWorkflowRunCancelRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "reason"))){validateWorkflowRunCancelRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){const _errs3: any = errors;if(!(validateWorkflowCancelReason.call(this, data.reason, {instancePath:instancePath+"/reason",parentData:data,parentDataProperty:"reason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowCancelReason.errors : vErrors.concat(validateWorkflowCancelReason.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowRunCancelRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunCancelRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunCancelRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1519: any = {"type":"object","additionalProperties":false,"properties":{"workflowRunId":{"$ref":"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId","description":"The run."},"status":{"description":"`canceled`.","type":"string","enum":["canceled"]},"canceledEventId":{"type":"string","minLength":1,"description":"The `workflow.run.canceled` event the cancel wrote."},"alreadyCanceled":{"type":"boolean","description":"Whether the run was already canceled."}},"required":["workflowRunId","status","canceledEventId","alreadyCanceled"],"description":"The `workflow.run.cancel` result. Cancel is offered on a new, running or waiting run, and on a\nfailed run parked on its failed step; `alreadyCanceled` is true when the run was already\ncanceled and this call returned the first cancel's saved result, `canceledEventId` naming the\noriginal event and no second one written."};
/** Checks that a value is a {@link WorkflowRunCancelResponse}. */
// prettier-ignore
export const validateWorkflowRunCancelResponse: CompiledSchemaCheck<WorkflowRunCancelResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunCancelResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunCancelResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.status === undefined) && (missing0 = "status"))) || ((data.canceledEventId === undefined) && (missing0 = "canceledEventId"))) || ((data.alreadyCanceled === undefined) && (missing0 = "alreadyCanceled"))){validateWorkflowRunCancelResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "workflowRunId") || (key0 === "status")) || (key0 === "canceledEventId")) || (key0 === "alreadyCanceled"))){validateWorkflowRunCancelResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){let data1: any = data.status;const _errs3: any = errors;if(typeof data1 !== "string"){validateWorkflowRunCancelResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data1 === "canceled")){validateWorkflowRunCancelResponse.errors = [{instancePath:instancePath+"/status",schemaPath:"#/properties/status/enum",keyword:"enum",params:{allowedValues: schema1519.properties.status.enum}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.canceledEventId !== undefined){let data2: any = data.canceledEventId;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) < 1){validateWorkflowRunCancelResponse.errors = [{instancePath:instancePath+"/canceledEventId",schemaPath:"#/properties/canceledEventId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowRunCancelResponse.errors = [{instancePath:instancePath+"/canceledEventId",schemaPath:"#/properties/canceledEventId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.alreadyCanceled !== undefined){const _errs7: any = errors;if(typeof data.alreadyCanceled !== "boolean"){validateWorkflowRunCancelResponse.errors = [{instancePath:instancePath+"/alreadyCanceled",schemaPath:"#/properties/alreadyCanceled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}else {validateWorkflowRunCancelResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunCancelResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunCancelResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunResumeVersionRepin}. */
// prettier-ignore
export const validateWorkflowRunResumeVersionRepin: CompiledSchemaCheck<WorkflowRunResumeVersionRepin> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunResumeVersionRepin {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunResumeVersionRepin.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.targetWorkflowVersionId === undefined) && (missing0 = "targetWorkflowVersionId")){validateWorkflowRunResumeVersionRepin.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "targetWorkflowVersionId")){validateWorkflowRunResumeVersionRepin.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.targetWorkflowVersionId !== undefined){if(!(validateWorkflowVersionId.call(this, data.targetWorkflowVersionId, {instancePath:instancePath+"/targetWorkflowVersionId",parentData:data,parentDataProperty:"targetWorkflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}}}}}else {validateWorkflowRunResumeVersionRepin.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunResumeVersionRepin.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunResumeVersionRepin.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunResumeRequest}. */
// prettier-ignore
export const validateWorkflowRunResumeRequest: CompiledSchemaCheck<WorkflowRunResumeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunResumeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunResumeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workflowRunId === undefined) && (missing0 = "workflowRunId")){validateWorkflowRunResumeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "versionRepin"))){validateWorkflowRunResumeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.versionRepin !== undefined){const _errs3: any = errors;if(!(validateWorkflowRunResumeVersionRepin.call(this, data.versionRepin, {instancePath:instancePath+"/versionRepin",parentData:data,parentDataProperty:"versionRepin",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunResumeVersionRepin.errors : vErrors.concat(validateWorkflowRunResumeVersionRepin.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowRunResumeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunResumeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunResumeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1530: any = {"description":"The status a resume answers with: running, or waiting again where it reached a provider account\nstill out of quota, which is a legal outcome and not a refusal.","type":"string","enum":["running","waiting"]};
/** Checks that a value is a {@link WorkflowRunResumeStatus}. */
// prettier-ignore
export const validateWorkflowRunResumeStatus: CompiledSchemaCheck<WorkflowRunResumeStatus> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunResumeStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunResumeStatus.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowRunResumeStatus.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "running") || (data === "waiting"))){validateWorkflowRunResumeStatus.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1530.enum}}];return false;}validateWorkflowRunResumeStatus.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunResumeStatus.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunResumeResponse}. */
// prettier-ignore
export const validateWorkflowRunResumeResponse: CompiledSchemaCheck<WorkflowRunResumeResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunResumeResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunResumeResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.status === undefined) && (missing0 = "status"))){validateWorkflowRunResumeResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "workflowRunId") || (key0 === "status")) || (key0 === "repinnedFromWorkflowVersionId")) || (key0 === "repinnedToWorkflowVersionId"))){validateWorkflowRunResumeResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){const _errs3: any = errors;if(!(validateWorkflowRunResumeStatus.call(this, data.status, {instancePath:instancePath+"/status",parentData:data,parentDataProperty:"status",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunResumeStatus.errors : vErrors.concat(validateWorkflowRunResumeStatus.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.repinnedFromWorkflowVersionId !== undefined){const _errs4: any = errors;if(!(validateWorkflowVersionId.call(this, data.repinnedFromWorkflowVersionId, {instancePath:instancePath+"/repinnedFromWorkflowVersionId",parentData:data,parentDataProperty:"repinnedFromWorkflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.repinnedToWorkflowVersionId !== undefined){const _errs5: any = errors;if(!(validateWorkflowVersionId.call(this, data.repinnedToWorkflowVersionId, {instancePath:instancePath+"/repinnedToWorkflowVersionId",parentData:data,parentDataProperty:"repinnedToWorkflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.repinnedFromWorkflowVersionId !== undefined && ((data.repinnedToWorkflowVersionId === undefined) && (missing1 = "repinnedToWorkflowVersionId"))){validateWorkflowRunResumeResponse.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "repinnedFromWorkflowVersionId",
    missingProperty: missing1,
    depsCount: 1,
    deps: "repinnedToWorkflowVersionId"}}];return false;}else {if(data.repinnedToWorkflowVersionId !== undefined && ((data.repinnedFromWorkflowVersionId === undefined) && (missing1 = "repinnedFromWorkflowVersionId"))){validateWorkflowRunResumeResponse.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "repinnedToWorkflowVersionId",
    missingProperty: missing1,
    depsCount: 1,
    deps: "repinnedFromWorkflowVersionId"}}];return false;}}}}}}}}}else {validateWorkflowRunResumeResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunResumeResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunResumeResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunRetryRequest}. */
// prettier-ignore
export const validateWorkflowRunRetryRequest: CompiledSchemaCheck<WorkflowRunRetryRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunRetryRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunRetryRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.fromNodeId === undefined) && (missing0 = "fromNodeId"))) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validateWorkflowRunRetryRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "workflowRunId") || (key0 === "fromNodeId")) || (key0 === "clientIdempotencyKey"))){validateWorkflowRunRetryRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.fromNodeId !== undefined){const _errs3: any = errors;if(!(validateWorkflowNodeId.call(this, data.fromNodeId, {instancePath:instancePath+"/fromNodeId",parentData:data,parentDataProperty:"fromNodeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data2: any = data.clientIdempotencyKey;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(!pattern88.test(data2)){validateWorkflowRunRetryRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateWorkflowRunRetryRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowRunRetryRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunRetryRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunRetryRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func0 = deepEqual;
/** Checks that a value is a {@link WorkflowRunRetryResponse}. */
// prettier-ignore
export const validateWorkflowRunRetryResponse: CompiledSchemaCheck<WorkflowRunRetryResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunRetryResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunRetryResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.sourceWorkflowRunId === undefined) && (missing0 = "sourceWorkflowRunId"))) || ((data.status === undefined) && (missing0 = "status"))){validateWorkflowRunRetryResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "workflowRunId") || (key0 === "sourceWorkflowRunId")) || (key0 === "status"))){validateWorkflowRunRetryResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;if(typeof data0 !== "string"){validateWorkflowRunRetryResponse.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"#/properties/workflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}if(!(validateWorkflowRunId.call(this, data0, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}else {const _errs4: any = errors;const _errs5: any = errors;const vSchema0: any = data && data.sourceWorkflowRunId;if(vSchema0 !== undefined && (!func0(data0, vSchema0))){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid1: any = _errs5 === errors;if(valid1){validateWorkflowRunRetryResponse.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"#/properties/workflowRunId/not",keyword:"not",params:{}}];return false;}else {errors = _errs4;if(vErrors !== null){if(_errs4){vErrors.length = _errs4;}else {vErrors = null;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourceWorkflowRunId !== undefined){const _errs6: any = errors;if(!(validateWorkflowRunId.call(this, data.sourceWorkflowRunId, {instancePath:instancePath+"/sourceWorkflowRunId",parentData:data,parentDataProperty:"sourceWorkflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){const _errs7: any = errors;if(!(validateWorkflowRunStartStatus.call(this, data.status, {instancePath:instancePath+"/status",parentData:data,parentDataProperty:"status",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunStartStatus.errors : vErrors.concat(validateWorkflowRunStartStatus.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowRunRetryResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunRetryResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunRetryResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunRerunRequest}. */
// prettier-ignore
export const validateWorkflowRunRerunRequest: CompiledSchemaCheck<WorkflowRunRerunRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunRerunRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunRerunRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validateWorkflowRunRerunRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "clientIdempotencyKey"))){validateWorkflowRunRerunRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data1: any = data.clientIdempotencyKey;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(!pattern88.test(data1)){validateWorkflowRunRerunRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateWorkflowRunRerunRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowRunRerunRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunRerunRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunRerunRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1514: any = {"description":"What a node run covers: the node alone (`Run this node`), or the node and its ancestors\n(`Run from here`).","type":"string","enum":["node","fromHere"]};
/** Checks that a value is a {@link WorkflowNodeExecuteScope}. */
// prettier-ignore
export const validateWorkflowNodeExecuteScope: CompiledSchemaCheck<WorkflowNodeExecuteScope> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeExecuteScope {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNodeExecuteScope.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowNodeExecuteScope.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "node") || (data === "fromHere"))){validateWorkflowNodeExecuteScope.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1514.enum}}];return false;}validateWorkflowNodeExecuteScope.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNodeExecuteScope.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowNodeExecuteRequest}. */
// prettier-ignore
export const validateWorkflowNodeExecuteRequest: CompiledSchemaCheck<WorkflowNodeExecuteRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeExecuteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNodeExecuteRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey")) || ((data.workflowVersionId === undefined) && (missing0 = "workflowVersionId"))) || ((data.nodeId === undefined) && (missing0 = "nodeId"))) || ((data.scope === undefined) && (missing0 = "scope"))){validateWorkflowNodeExecuteRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "clientIdempotencyKey") || (key0 === "workflowVersionId")) || (key0 === "sessionId")) || (key0 === "projectId")) || (key0 === "nodeId")) || (key0 === "scope")) || (key0 === "dirtyNodeIds")) || (key0 === "input"))){validateWorkflowNodeExecuteRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.clientIdempotencyKey !== undefined){let data0: any = data.clientIdempotencyKey;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(!pattern88.test(data0)){validateWorkflowNodeExecuteRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateWorkflowNodeExecuteRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.workflowVersionId !== undefined){const _errs4: any = errors;if(!(validateWorkflowVersionId.call(this, data.workflowVersionId, {instancePath:instancePath+"/workflowVersionId",parentData:data,parentDataProperty:"workflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){const _errs5: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.projectId !== undefined){const _errs6: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){const _errs7: any = errors;if(!(validateWorkflowNodeId.call(this, data.nodeId, {instancePath:instancePath+"/nodeId",parentData:data,parentDataProperty:"nodeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.scope !== undefined){const _errs8: any = errors;if(!(validateWorkflowNodeExecuteScope.call(this, data.scope, {instancePath:instancePath+"/scope",parentData:data,parentDataProperty:"scope",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeExecuteScope.errors : vErrors.concat(validateWorkflowNodeExecuteScope.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.dirtyNodeIds !== undefined){let data6: any = data.dirtyNodeIds;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data6)){var valid1: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){const _errs11: any = errors;if(!(validateWorkflowNodeId.call(this, data6[i0], {instancePath:instancePath+"/dirtyNodeIds/" + i0,parentData:data6,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid1: any = _errs11 === errors;if(!valid1){break;}}}else {validateWorkflowNodeExecuteRequest.errors = [{instancePath:instancePath+"/dirtyNodeIds",schemaPath:"#/properties/dirtyNodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.input !== undefined){let data8: any = data.input;const _errs12: any = errors;if(errors === _errs12){if(Array.isArray(data8)){var valid2: any = true;const len1: any = data8.length;for(let i1=0; i1<len1; i1++){const _errs14: any = errors;if(!(validateWorkflowItem.call(this, data8[i1], {instancePath:instancePath+"/input/" + i1,parentData:data8,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowItem.errors : vErrors.concat(validateWorkflowItem.errors);errors = vErrors.length;}var valid2: any = _errs14 === errors;if(!valid2){break;}}}else {validateWorkflowNodeExecuteRequest.errors = [{instancePath:instancePath+"/input",schemaPath:"#/properties/input/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validateWorkflowNodeExecuteRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowNodeExecuteRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNodeExecuteRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowNodeExecuteResponse}. */
// prettier-ignore
export const validateWorkflowNodeExecuteResponse: CompiledSchemaCheck<WorkflowNodeExecuteResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeExecuteResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNodeExecuteResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.executedNodeIds === undefined) && (missing0 = "executedNodeIds"))) || ((data.reusedNodeIds === undefined) && (missing0 = "reusedNodeIds"))){validateWorkflowNodeExecuteResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "workflowRunId") || (key0 === "executedNodeIds")) || (key0 === "reusedNodeIds"))){validateWorkflowNodeExecuteResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.executedNodeIds !== undefined){let data1: any = data.executedNodeIds;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateWorkflowNodeId.call(this, data1[i0], {instancePath:instancePath+"/executedNodeIds/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateWorkflowNodeExecuteResponse.errors = [{instancePath:instancePath+"/executedNodeIds",schemaPath:"#/properties/executedNodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.reusedNodeIds !== undefined){let data3: any = data.reusedNodeIds;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data3)){var valid2: any = true;const len1: any = data3.length;for(let i1=0; i1<len1; i1++){const _errs8: any = errors;if(!(validateWorkflowNodeId.call(this, data3[i1], {instancePath:instancePath+"/reusedNodeIds/" + i1,parentData:data3,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;if(!valid2){break;}}}else {validateWorkflowNodeExecuteResponse.errors = [{instancePath:instancePath+"/reusedNodeIds",schemaPath:"#/properties/reusedNodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowNodeExecuteResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowNodeExecuteResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNodeExecuteResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowResultsPostRequest}. */
// prettier-ignore
export const validateWorkflowResultsPostRequest: CompiledSchemaCheck<WorkflowResultsPostRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowResultsPostRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowResultsPostRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))){validateWorkflowResultsPostRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "sessionId"))){validateWorkflowResultsPostRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){const _errs3: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowResultsPostRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowResultsPostRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowResultsPostRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowResultsPostResponse}. */
// prettier-ignore
export const validateWorkflowResultsPostResponse: CompiledSchemaCheck<WorkflowResultsPostResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowResultsPostResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowResultsPostResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.posted === undefined) && (missing0 = "posted"))){validateWorkflowResultsPostResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "posted"))){validateWorkflowResultsPostResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.posted !== undefined){let data1: any = data.posted;const _errs3: any = errors;if(typeof data1 !== "boolean"){validateWorkflowResultsPostResponse.errors = [{instancePath:instancePath+"/posted",schemaPath:"#/properties/posted/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data1){validateWorkflowResultsPostResponse.errors = [{instancePath:instancePath+"/posted",schemaPath:"#/properties/posted/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowResultsPostResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowResultsPostResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowResultsPostResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunRepositoryRequiredDetails}. */
// prettier-ignore
export const validateWorkflowRunRepositoryRequiredDetails: CompiledSchemaCheck<WorkflowRunRepositoryRequiredDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunRepositoryRequiredDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunRepositoryRequiredDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.nodeIds === undefined) && (missing0 = "nodeIds")){validateWorkflowRunRepositoryRequiredDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "nodeIds")){validateWorkflowRunRepositoryRequiredDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.nodeIds !== undefined){let data0: any = data.nodeIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validateWorkflowRunRepositoryRequiredDetails.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateWorkflowNodeId.call(this, data0[i0], {instancePath:instancePath+"/nodeIds/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validateWorkflowRunRepositoryRequiredDetails.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateWorkflowRunRepositoryRequiredDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunRepositoryRequiredDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunRepositoryRequiredDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunProviderRequiredDetails}. */
// prettier-ignore
export const validateWorkflowRunProviderRequiredDetails: CompiledSchemaCheck<WorkflowRunProviderRequiredDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunProviderRequiredDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunProviderRequiredDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.nodeIds === undefined) && (missing0 = "nodeIds")){validateWorkflowRunProviderRequiredDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "nodeIds")){validateWorkflowRunProviderRequiredDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.nodeIds !== undefined){let data0: any = data.nodeIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validateWorkflowRunProviderRequiredDetails.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateWorkflowNodeId.call(this, data0[i0], {instancePath:instancePath+"/nodeIds/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validateWorkflowRunProviderRequiredDetails.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateWorkflowRunProviderRequiredDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunProviderRequiredDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunProviderRequiredDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunNodeKindUnavailableDetails}. */
// prettier-ignore
export const validateWorkflowRunNodeKindUnavailableDetails: CompiledSchemaCheck<WorkflowRunNodeKindUnavailableDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunNodeKindUnavailableDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunNodeKindUnavailableDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.nodeIds === undefined) && (missing0 = "nodeIds")){validateWorkflowRunNodeKindUnavailableDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "nodeIds")){validateWorkflowRunNodeKindUnavailableDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.nodeIds !== undefined){let data0: any = data.nodeIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validateWorkflowRunNodeKindUnavailableDetails.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateWorkflowNodeId.call(this, data0[i0], {instancePath:instancePath+"/nodeIds/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validateWorkflowRunNodeKindUnavailableDetails.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateWorkflowRunNodeKindUnavailableDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunNodeKindUnavailableDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunNodeKindUnavailableDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunHandleUndeclaredDetails}. */
// prettier-ignore
export const validateWorkflowRunHandleUndeclaredDetails: CompiledSchemaCheck<WorkflowRunHandleUndeclaredDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunHandleUndeclaredDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunHandleUndeclaredDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.nodeIds === undefined) && (missing0 = "nodeIds")) || ((data.handles === undefined) && (missing0 = "handles"))){validateWorkflowRunHandleUndeclaredDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "nodeIds") || (key0 === "handles"))){validateWorkflowRunHandleUndeclaredDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.nodeIds !== undefined){let data0: any = data.nodeIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validateWorkflowRunHandleUndeclaredDetails.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateWorkflowNodeId.call(this, data0[i0], {instancePath:instancePath+"/nodeIds/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validateWorkflowRunHandleUndeclaredDetails.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.handles !== undefined){let data2: any = data.handles;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data2)){if(data2.length < 1){validateWorkflowRunHandleUndeclaredDetails.errors = [{instancePath:instancePath+"/handles",schemaPath:"#/properties/handles/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid2: any = true;const len1: any = data2.length;for(let i1=0; i1<len1; i1++){let data3: any = data2[i1];const _errs7: any = errors;if(errors === _errs7){if(typeof data3 === "string"){if(func1(data3) < 1){validateWorkflowRunHandleUndeclaredDetails.errors = [{instancePath:instancePath+"/handles/" + i1,schemaPath:"#/properties/handles/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowRunHandleUndeclaredDetails.errors = [{instancePath:instancePath+"/handles/" + i1,schemaPath:"#/properties/handles/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;if(!valid2){break;}}}}else {validateWorkflowRunHandleUndeclaredDetails.errors = [{instancePath:instancePath+"/handles",schemaPath:"#/properties/handles/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowRunHandleUndeclaredDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunHandleUndeclaredDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunHandleUndeclaredDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunInputRequiredDetails}. */
// prettier-ignore
export const validateWorkflowRunInputRequiredDetails: CompiledSchemaCheck<WorkflowRunInputRequiredDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunInputRequiredDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunInputRequiredDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.inputNames === undefined) && (missing0 = "inputNames")){validateWorkflowRunInputRequiredDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "inputNames")){validateWorkflowRunInputRequiredDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.inputNames !== undefined){let data0: any = data.inputNames;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validateWorkflowRunInputRequiredDetails.errors = [{instancePath:instancePath+"/inputNames",schemaPath:"#/properties/inputNames/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validateWorkflowRunInputRequiredDetails.errors = [{instancePath:instancePath+"/inputNames/" + i0,schemaPath:"#/properties/inputNames/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowRunInputRequiredDetails.errors = [{instancePath:instancePath+"/inputNames/" + i0,schemaPath:"#/properties/inputNames/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validateWorkflowRunInputRequiredDetails.errors = [{instancePath:instancePath+"/inputNames",schemaPath:"#/properties/inputNames/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateWorkflowRunInputRequiredDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunInputRequiredDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunInputRequiredDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowCodePackagesNotLockedDetails}. */
// prettier-ignore
export const validateWorkflowCodePackagesNotLockedDetails: CompiledSchemaCheck<WorkflowCodePackagesNotLockedDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowCodePackagesNotLockedDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowCodePackagesNotLockedDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.nodeIds === undefined) && (missing0 = "nodeIds")){validateWorkflowCodePackagesNotLockedDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "nodeIds")){validateWorkflowCodePackagesNotLockedDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.nodeIds !== undefined){let data0: any = data.nodeIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validateWorkflowCodePackagesNotLockedDetails.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateWorkflowNodeId.call(this, data0[i0], {instancePath:instancePath+"/nodeIds/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validateWorkflowCodePackagesNotLockedDetails.errors = [{instancePath:instancePath+"/nodeIds",schemaPath:"#/properties/nodeIds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateWorkflowCodePackagesNotLockedDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowCodePackagesNotLockedDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowCodePackagesNotLockedDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1538: any = {"description":"Why `workflow.run.stillRunning` refused a retry; its one cause is a source run still going.","type":"string","enum":["sourceRunning"]};
/** Checks that a value is a {@link WorkflowRunStillRunningReason}. */
// prettier-ignore
export const validateWorkflowRunStillRunningReason: CompiledSchemaCheck<WorkflowRunStillRunningReason> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunStillRunningReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunStillRunningReason.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowRunStillRunningReason.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data === "sourceRunning")){validateWorkflowRunStillRunningReason.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1538.enum}}];return false;}validateWorkflowRunStillRunningReason.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunStillRunningReason.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunStillRunningDetails}. */
// prettier-ignore
export const validateWorkflowRunStillRunningDetails: CompiledSchemaCheck<WorkflowRunStillRunningDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunStillRunningDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunStillRunningDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.reason === undefined) && (missing0 = "reason")){validateWorkflowRunStillRunningDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "reason")){validateWorkflowRunStillRunningDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reason !== undefined){if(!(validateWorkflowRunStillRunningReason.call(this, data.reason, {instancePath:instancePath+"/reason",parentData:data,parentDataProperty:"reason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunStillRunningReason.errors : vErrors.concat(validateWorkflowRunStillRunningReason.errors);errors = vErrors.length;}}}}}else {validateWorkflowRunStillRunningDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunStillRunningDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunStillRunningDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunIdempotencyConflictDetails}. */
// prettier-ignore
export const validateWorkflowRunIdempotencyConflictDetails: CompiledSchemaCheck<WorkflowRunIdempotencyConflictDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunIdempotencyConflictDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunIdempotencyConflictDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workflowRunId === undefined) && (missing0 = "workflowRunId")){validateWorkflowRunIdempotencyConflictDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sourceWorkflowRunId") || (key0 === "workflowRunId"))){validateWorkflowRunIdempotencyConflictDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sourceWorkflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.sourceWorkflowRunId, {instancePath:instancePath+"/sourceWorkflowRunId",parentData:data,parentDataProperty:"sourceWorkflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.workflowRunId !== undefined){const _errs3: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowRunIdempotencyConflictDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunIdempotencyConflictDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunIdempotencyConflictDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

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
