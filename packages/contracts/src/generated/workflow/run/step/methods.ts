// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `workflow.*` methods on one step: reading its input, output or log, storing what one of its panel's tabs holds as an artifact, the agent and human steps' saved outputs, answering an approval step or a chain's question, loading, saving and submitting a waiting form, and opening a fix session on a failed step, with their refusals and their method table.

import {
  type CompiledSchemaCheck,
  type SchemaCheck,
  deepEqual,
  repeatsItemKey,
  ucs2length,
} from "../../../../schema-check.js";
import { type ApprovalDecision, validateApprovalDecision } from "../../../approval.js";
import { type ArtifactId, validateArtifactId } from "../../../artifacts/id.js";
import { type WireInstant, validateWireInstant } from "../../../internal/wire-scalars.js";
import { type SessionId, validateSessionId } from "../../../session/id.js";
import { type WorkflowNodeId, validateWorkflowNodeId } from "../../definition/document.js";
import { type WorkflowParamSpec, validateWorkflowParamSpec } from "../../kind.js";
import {
  type WorkflowGateResolutionId,
  validateWorkflowGateResolutionId,
} from "../gate-resolution.js";
import { type WorkflowRunId, validateWorkflowRunId } from "../id.js";
import {
  type WorkflowPayloadRef,
  type WorkflowStepKey,
  validateWorkflowPayloadRef,
  validateWorkflowStepKey,
} from "./record.js";

/**
 * A step panel's tabs, in the order the panel shows them: its three payloads, then its cost
 * and its error.
 */
export const WORKFLOW_STEP_TABS = ["input", "output", "log", "cost", "error"] as const;

/**
 * An approval answered, a form read or a form submitted on a step that is no longer waiting,
 * an answer after the step's `Timeout` passed included, even before its timer has run; also a
 * chain's question answered once it is no longer open.
 */
export const WORKFLOW_STEP_NOT_WAITING_CODE = "workflow.step.notWaiting" as const;

/** A form draft save or a form submit carrying a revision that is no longer current. */
export const WORKFLOW_HUMAN_FORM_REVISION_STALE_CODE = "workflow.humanForm.revisionStale" as const;

/**
 * One tab of a step's panel: its input, output or log, its cost or its error.
 */
export type WorkflowStepTab = "input" | "output" | "log" | "cost" | "error";
/**
 * Which of a step's three payloads a read returns: the tabs that hold items.
 */
export type WorkflowStepPayloadKind = "input" | "output" | "log";
/**
 * Where the next page of a step's payload starts. The daemon writes it and owns its format; a
 * client passes it back unchanged with the same step and payload.
 */
export type WorkflowStepReadCursor = string & { readonly __brand: "WorkflowStepReadCursor" };
/**
 * One saved output of a finished step: its summary and, for an artifact, the artifact's id. An
 * `artifactRef` output points at a stored artifact and never carries its bytes; an `inline`
 * output carries no artifact.
 */
export type WorkflowStepOutput =
  | {
      valueKind: "inline";
      /**
       * What it holds.
       */
      summary: string;
      /**
       * When the step produced it.
       */
      producedAt: WireInstant;
    }
  | {
      valueKind: "artifactRef";
      /**
       * The artifact.
       */
      artifactId: ArtifactId;
      /**
       * What it holds.
       */
      summary: string;
      /**
       * When the step produced it.
       */
      producedAt: WireInstant;
    };
/**
 * The status of a step whose outputs are listed: it finished, succeeded or failed.
 */
export type WorkflowStepOutputStatus = "succeeded" | "failed";

/**
 * The `workflow.step.read` input: one step's input, output or log, paged. Every secret value
 * was redacted before the payload was written, so a read never returns one.
 */
export interface WorkflowStepReadRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which attempt at the step, counted from 1: each retry is a new attempt.
   */
  attempt: number;
  /**
   * Which execution of the node, increasing through the run.
   */
  executionIndex: number;
  /**
   * Which payload.
   */
  which: WorkflowStepPayloadKind;
  /**
   * The most items on one page.
   */
  limit?: number;
  /**
   * Continue from this cursor, the previous page's `nextCursor`.
   */
  cursor?: WorkflowStepReadCursor;
}
/**
 * The `workflow.step.read` result: the payload inline or as an artifact reference, with a cursor
 * while more remains.
 */
export interface WorkflowStepReadResponse {
  /**
   * The step's node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which execution of the node.
   */
  executionIndex: number;
  /**
   * Which payload.
   */
  which: WorkflowStepPayloadKind;
  /**
   * The payload's page.
   */
  payload: WorkflowPayloadRef;
  /**
   * Where the next page starts; absent on the last.
   */
  nextCursor?: WorkflowStepReadCursor;
}
/**
 * The `workflow.step.tabArtifact.create` input: the step-panel tab whose content is stored as
 * an artifact of the run's session, for the tab's `Open as artifact`.
 */
export interface WorkflowStepTabArtifactCreateRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which attempt at the step, counted from 1: each retry is a new attempt.
   */
  attempt: number;
  /**
   * Which execution of the node, increasing through the run.
   */
  executionIndex: number;
  /**
   * The tab.
   */
  which: WorkflowStepTab;
}
/**
 * The `workflow.step.tabArtifact.create` result: the stored artifact's id.
 */
export interface WorkflowStepTabArtifactCreateResponse {
  /**
   * The artifact.
   */
  artifactId: ArtifactId;
}
/**
 * The `workflow.step.output.list` input: the run whose agent and human steps' outputs are listed.
 */
export interface WorkflowStepOutputListRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
}
/**
 * One finished agent or human step and its saved outputs. `status` is the step's, not the run's;
 * a retry adds steps and never rewrites one.
 */
export interface WorkflowStepOutputs {
  /**
   * The step's node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which execution of the node.
   */
  executionIndex: number;
  /**
   * How the step finished.
   */
  status: WorkflowStepOutputStatus;
  /**
   * Its saved outputs.
   */
  outputs: WorkflowStepOutput[];
}
/**
 * The `workflow.step.output.list` result: summaries and artifact references only. One step's full
 * input, output or log comes from `workflow.step.read`.
 */
export interface WorkflowStepOutputListResponse {
  /**
   * The finished agent and human steps.
   */
  steps: WorkflowStepOutputs[];
}
/**
 * The `workflow.gate.resolve` input: the person's answer to an approval step, named by `nodeId`,
 * or to the question a chain raises on its first run, which names no node: `approved` keeps the
 * chain going and `rejected` stops every run of it. The answer goes through the approvals pipeline
 * and its policy check.
 */
export interface WorkflowGateResolveRequest {
  /**
   * The run; for a chain's question, the chain's first run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The approval step answered; absent for a chain's question.
   */
  nodeId?: WorkflowNodeId;
  /**
   * The answer.
   */
  decision: ApprovalDecision;
  /**
   * The person's words with it.
   */
  feedback?: string;
}
/**
 * The `workflow.gate.resolve` result: the answer's entry in the run's approval record.
 */
export interface WorkflowGateResolveResponse {
  /**
   * The answer's record, which the `workflow.gate.resolved` event names.
   */
  gateResolutionId: WorkflowGateResolutionId;
  /**
   * When the answer was recorded, which the step panel's receipt reads.
   */
  decidedAt: WireInstant;
}
/**
 * What the person has typed into a waiting form so far, held by the daemon so a reload keeps it.
 * `revision` counts draft saves and guards only them.
 */
export interface WorkflowHumanFormDraft {
  /**
   * The form's values as typed.
   */
  formState: {
    [k: string]: unknown | undefined;
  };
  /**
   * The draft's revision, counted from 1.
   */
  revision: number;
  /**
   * When it was saved.
   */
  savedAt: WireInstant;
}
/**
 * The `workflow.humanForm.read` result: the node's prompt, its fields (the same parameter specs
 * the inspector's form draws), the draft saved so far, and `formRevision`, the token a submit
 * carries back: 0 while the step has no accepted answer.
 */
export interface WorkflowHumanFormReadResponse {
  /**
   * What the form asks.
   */
  prompt: string;
  /**
   * Its fields.
   */
  fields: WorkflowParamSpec[];
  /**
   * The revision a submit carries back.
   */
  formRevision: number;
  /**
   * The draft saved so far.
   */
  draft?: WorkflowHumanFormDraft;
}
/**
 * The `workflow.humanForm.draft.update` input: the form as it is typed. With
 * `expectedRevision`, a save over a newer draft is refused rather than overwriting it.
 */
export interface WorkflowHumanFormDraftUpdateRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which attempt at the step, counted from 1: each retry is a new attempt.
   */
  attempt: number;
  /**
   * Which execution of the node, increasing through the run.
   */
  executionIndex: number;
  /**
   * The form's values as typed.
   */
  formState: {
    [k: string]: unknown | undefined;
  };
  /**
   * The draft revision the save was typed over.
   */
  expectedRevision?: number;
}
/**
 * The `workflow.humanForm.draft.update` result: the draft's new revision and when it was saved.
 */
export interface WorkflowHumanFormDraftUpdateResponse {
  /**
   * The draft's new revision.
   */
  revision: number;
  /**
   * When it was saved.
   */
  savedAt: WireInstant;
}
/**
 * One `path` field's answer: the field, by its dotted place in the form (`parent.child`, or
 * `parent.0.child` inside a repeating collection), and the path picked with the platform's own
 * chooser. It sits beside `fields`, never in it, so the page's file token for the path is found at
 * one fixed member whatever the form holds; a `json` answer can hold any key.
 */
export interface WorkflowHumanFormPathAnswer {
  /**
   * The field's dotted place in the form.
   */
  field: string;
  /**
   * The path picked.
   */
  path: string;
}
/**
 * The `workflow.humanForm.submit` input: every answer is in `fields` but a `path` field's, in
 * `paths` at most once per field, and a form has no artifact field. `expectedRevision` is the
 * form's revision when read; a stale one is refused and never overwrites an accepted answer.
 */
export interface WorkflowHumanFormSubmitRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which attempt at the step, counted from 1: each retry is a new attempt.
   */
  attempt: number;
  /**
   * Which execution of the node, increasing through the run.
   */
  executionIndex: number;
  /**
   * The answers by field, a `path` field's aside.
   */
  fields: {
    [k: string]: unknown | undefined;
  };
  /**
   * The `path` fields' answers, one per field at most.
   */
  paths?: WorkflowHumanFormPathAnswer[];
  /**
   * The form's revision when it was read.
   */
  expectedRevision: number;
}
/**
 * The `workflow.humanForm.submit` result: when the answer was accepted.
 */
export interface WorkflowHumanFormSubmitResponse {
  /**
   * When the answer was accepted.
   */
  submittedAt: WireInstant;
}
/**
 * The `workflow.fixSession.create` result: the fix session, opened on the failed step's own
 * project and checkout and seeded with the step; the step's own record receives nothing, and the
 * run links the new session.
 */
export interface WorkflowFixSessionCreateResponse {
  /**
   * The new session.
   */
  sessionId: SessionId;
}

// prettier-ignore
const schema1586: any = {"description":"One tab of a step's panel: its input, output or log, its cost or its error.","type":"string","enum":["input","output","log","cost","error"]};
/** Checks that a value is a {@link WorkflowStepTab}. */
// prettier-ignore
export const validateWorkflowStepTab: CompiledSchemaCheck<WorkflowStepTab> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStepTab {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStepTab.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowStepTab.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data === "input") || (data === "output")) || (data === "log")) || (data === "cost")) || (data === "error"))){validateWorkflowStepTab.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1586.enum}}];return false;}validateWorkflowStepTab.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStepTab.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1582: any = {"description":"Which of a step's three payloads a read returns: the tabs that hold items.","type":"string","enum":["input","output","log"]};
/** Checks that a value is a {@link WorkflowStepPayloadKind}. */
// prettier-ignore
export const validateWorkflowStepPayloadKind: CompiledSchemaCheck<WorkflowStepPayloadKind> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStepPayloadKind {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStepPayloadKind.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowStepPayloadKind.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "input") || (data === "output")) || (data === "log"))){validateWorkflowStepPayloadKind.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1582.enum}}];return false;}validateWorkflowStepPayloadKind.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStepPayloadKind.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link WorkflowStepReadCursor}. */
// prettier-ignore
export const validateWorkflowStepReadCursor: CompiledSchemaCheck<WorkflowStepReadCursor> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStepReadCursor {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStepReadCursor.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateWorkflowStepReadCursor.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateWorkflowStepReadCursor.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateWorkflowStepReadCursor.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowStepReadCursor.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStepReadCursor.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowStepReadRequest}. */
// prettier-ignore
export const validateWorkflowStepReadRequest: CompiledSchemaCheck<WorkflowStepReadRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStepReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStepReadRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.nodeId === undefined) && (missing0 = "nodeId"))) || ((data.attempt === undefined) && (missing0 = "attempt"))) || ((data.executionIndex === undefined) && (missing0 = "executionIndex"))) || ((data.which === undefined) && (missing0 = "which"))){validateWorkflowStepReadRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "workflowRunId") || (key0 === "nodeId")) || (key0 === "attempt")) || (key0 === "executionIndex")) || (key0 === "which")) || (key0 === "limit")) || (key0 === "cursor"))){validateWorkflowStepReadRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){const _errs3: any = errors;if(!(validateWorkflowNodeId.call(this, data.nodeId, {instancePath:instancePath+"/nodeId",parentData:data,parentDataProperty:"nodeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.attempt !== undefined){let data2: any = data.attempt;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateWorkflowStepReadRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateWorkflowStepReadRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateWorkflowStepReadRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionIndex !== undefined){let data3: any = data.executionIndex;const _errs6: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateWorkflowStepReadRequest.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateWorkflowStepReadRequest.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateWorkflowStepReadRequest.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.which !== undefined){const _errs8: any = errors;if(!(validateWorkflowStepPayloadKind.call(this, data.which, {instancePath:instancePath+"/which",parentData:data,parentDataProperty:"which",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStepPayloadKind.errors : vErrors.concat(validateWorkflowStepPayloadKind.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.limit !== undefined){let data5: any = data.limit;const _errs9: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validateWorkflowStepReadRequest.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validateWorkflowStepReadRequest.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 1 || isNaN(data5)){validateWorkflowStepReadRequest.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.cursor !== undefined){const _errs11: any = errors;if(!(validateWorkflowStepReadCursor.call(this, data.cursor, {instancePath:instancePath+"/cursor",parentData:data,parentDataProperty:"cursor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStepReadCursor.errors : vErrors.concat(validateWorkflowStepReadCursor.errors);errors = vErrors.length;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validateWorkflowStepReadRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowStepReadRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStepReadRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowStepReadResponse}. */
// prettier-ignore
export const validateWorkflowStepReadResponse: CompiledSchemaCheck<WorkflowStepReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStepReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStepReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.nodeId === undefined) && (missing0 = "nodeId")) || ((data.executionIndex === undefined) && (missing0 = "executionIndex"))) || ((data.which === undefined) && (missing0 = "which"))) || ((data.payload === undefined) && (missing0 = "payload"))){validateWorkflowStepReadResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "nodeId") || (key0 === "executionIndex")) || (key0 === "which")) || (key0 === "payload")) || (key0 === "nextCursor"))){validateWorkflowStepReadResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.nodeId !== undefined){const _errs2: any = errors;if(!(validateWorkflowNodeId.call(this, data.nodeId, {instancePath:instancePath+"/nodeId",parentData:data,parentDataProperty:"nodeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionIndex !== undefined){let data1: any = data.executionIndex;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowStepReadResponse.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowStepReadResponse.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateWorkflowStepReadResponse.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.which !== undefined){const _errs5: any = errors;if(!(validateWorkflowStepPayloadKind.call(this, data.which, {instancePath:instancePath+"/which",parentData:data,parentDataProperty:"which",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStepPayloadKind.errors : vErrors.concat(validateWorkflowStepPayloadKind.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.payload !== undefined){const _errs6: any = errors;if(!(validateWorkflowPayloadRef.call(this, data.payload, {instancePath:instancePath+"/payload",parentData:data,parentDataProperty:"payload",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowPayloadRef.errors : vErrors.concat(validateWorkflowPayloadRef.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.nextCursor !== undefined){const _errs7: any = errors;if(!(validateWorkflowStepReadCursor.call(this, data.nextCursor, {instancePath:instancePath+"/nextCursor",parentData:data,parentDataProperty:"nextCursor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStepReadCursor.errors : vErrors.concat(validateWorkflowStepReadCursor.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}}else {validateWorkflowStepReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowStepReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStepReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowStepTabArtifactCreateRequest}. */
// prettier-ignore
export const validateWorkflowStepTabArtifactCreateRequest: CompiledSchemaCheck<WorkflowStepTabArtifactCreateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStepTabArtifactCreateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStepTabArtifactCreateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.nodeId === undefined) && (missing0 = "nodeId"))) || ((data.attempt === undefined) && (missing0 = "attempt"))) || ((data.executionIndex === undefined) && (missing0 = "executionIndex"))) || ((data.which === undefined) && (missing0 = "which"))){validateWorkflowStepTabArtifactCreateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "workflowRunId") || (key0 === "nodeId")) || (key0 === "attempt")) || (key0 === "executionIndex")) || (key0 === "which"))){validateWorkflowStepTabArtifactCreateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){const _errs3: any = errors;if(!(validateWorkflowNodeId.call(this, data.nodeId, {instancePath:instancePath+"/nodeId",parentData:data,parentDataProperty:"nodeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.attempt !== undefined){let data2: any = data.attempt;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateWorkflowStepTabArtifactCreateRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateWorkflowStepTabArtifactCreateRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateWorkflowStepTabArtifactCreateRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionIndex !== undefined){let data3: any = data.executionIndex;const _errs6: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateWorkflowStepTabArtifactCreateRequest.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateWorkflowStepTabArtifactCreateRequest.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateWorkflowStepTabArtifactCreateRequest.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.which !== undefined){const _errs8: any = errors;if(!(validateWorkflowStepTab.call(this, data.which, {instancePath:instancePath+"/which",parentData:data,parentDataProperty:"which",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStepTab.errors : vErrors.concat(validateWorkflowStepTab.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}}else {validateWorkflowStepTabArtifactCreateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowStepTabArtifactCreateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStepTabArtifactCreateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowStepTabArtifactCreateResponse}. */
// prettier-ignore
export const validateWorkflowStepTabArtifactCreateResponse: CompiledSchemaCheck<WorkflowStepTabArtifactCreateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStepTabArtifactCreateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStepTabArtifactCreateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.artifactId === undefined) && (missing0 = "artifactId")){validateWorkflowStepTabArtifactCreateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "artifactId")){validateWorkflowStepTabArtifactCreateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.artifactId !== undefined){if(!(validateArtifactId.call(this, data.artifactId, {instancePath:instancePath+"/artifactId",parentData:data,parentDataProperty:"artifactId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}}}}}else {validateWorkflowStepTabArtifactCreateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowStepTabArtifactCreateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStepTabArtifactCreateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowStepOutputListRequest}. */
// prettier-ignore
export const validateWorkflowStepOutputListRequest: CompiledSchemaCheck<WorkflowStepOutputListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStepOutputListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStepOutputListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workflowRunId === undefined) && (missing0 = "workflowRunId")){validateWorkflowStepOutputListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "workflowRunId")){validateWorkflowStepOutputListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}}}}}else {validateWorkflowStepOutputListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowStepOutputListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStepOutputListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowStepOutput}. */
// prettier-ignore
export const validateWorkflowStepOutput: CompiledSchemaCheck<WorkflowStepOutput> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStepOutput {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStepOutput.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.valueKind;if(typeof tag0 == "string"){if(tag0 === "inline"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.valueKind === undefined) && (missing0 = "valueKind")) || ((data.summary === undefined) && (missing0 = "summary"))) || ((data.producedAt === undefined) && (missing0 = "producedAt"))){validateWorkflowStepOutput.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((key0 === "valueKind") || (key0 === "summary")) || (key0 === "producedAt"))){validateWorkflowStepOutput.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.valueKind !== undefined){let data0: any = data.valueKind;const _errs5: any = errors;if(typeof data0 !== "string"){validateWorkflowStepOutput.errors = [{instancePath:instancePath+"/valueKind",schemaPath:"#/oneOf/0/properties/valueKind/type",keyword:"type",params:{type: "string"}}];return false;}if("inline" !== data0){validateWorkflowStepOutput.errors = [{instancePath:instancePath+"/valueKind",schemaPath:"#/oneOf/0/properties/valueKind/const",keyword:"const",params:{allowedValue: "inline"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.summary !== undefined){const _errs7: any = errors;if(typeof data.summary !== "string"){validateWorkflowStepOutput.errors = [{instancePath:instancePath+"/summary",schemaPath:"#/oneOf/0/properties/summary/type",keyword:"type",params:{type: "string"}}];return false;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.producedAt !== undefined){const _errs9: any = errors;if(!(validateWireInstant.call(this, data.producedAt, {instancePath:instancePath+"/producedAt",parentData:data,parentDataProperty:"producedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}}}}}}else {validateWorkflowStepOutput.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "artifactRef"){const _errs10: any = errors;if(errors === _errs10){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.valueKind === undefined) && (missing1 = "valueKind")) || ((data.artifactId === undefined) && (missing1 = "artifactId"))) || ((data.summary === undefined) && (missing1 = "summary"))) || ((data.producedAt === undefined) && (missing1 = "producedAt"))){validateWorkflowStepOutput.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs12: any = errors;for(const key1 in data){if(!((((key1 === "valueKind") || (key1 === "artifactId")) || (key1 === "summary")) || (key1 === "producedAt"))){validateWorkflowStepOutput.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs12 === errors){if(data.valueKind !== undefined){let data3: any = data.valueKind;const _errs13: any = errors;if(typeof data3 !== "string"){validateWorkflowStepOutput.errors = [{instancePath:instancePath+"/valueKind",schemaPath:"#/oneOf/1/properties/valueKind/type",keyword:"type",params:{type: "string"}}];return false;}if("artifactRef" !== data3){validateWorkflowStepOutput.errors = [{instancePath:instancePath+"/valueKind",schemaPath:"#/oneOf/1/properties/valueKind/const",keyword:"const",params:{allowedValue: "artifactRef"}}];return false;}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}if(valid4){if(data.artifactId !== undefined){const _errs15: any = errors;if(!(validateArtifactId.call(this, data.artifactId, {instancePath:instancePath+"/artifactId",parentData:data,parentDataProperty:"artifactId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data.summary !== undefined){const _errs16: any = errors;if(typeof data.summary !== "string"){validateWorkflowStepOutput.errors = [{instancePath:instancePath+"/summary",schemaPath:"#/oneOf/1/properties/summary/type",keyword:"type",params:{type: "string"}}];return false;}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}if(valid4){if(data.producedAt !== undefined){const _errs18: any = errors;if(!(validateWireInstant.call(this, data.producedAt, {instancePath:instancePath+"/producedAt",parentData:data,parentDataProperty:"producedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}}}}}}}else {validateWorkflowStepOutput.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs10 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateWorkflowStepOutput.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "valueKind", tagValue: tag0}}];return false;}}else {validateWorkflowStepOutput.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "valueKind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateWorkflowStepOutput.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateWorkflowStepOutput.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowStepOutput.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStepOutput.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1579: any = {"description":"The status of a step whose outputs are listed: it finished, succeeded or failed.","type":"string","enum":["succeeded","failed"]};
/** Checks that a value is a {@link WorkflowStepOutputStatus}. */
// prettier-ignore
export const validateWorkflowStepOutputStatus: CompiledSchemaCheck<WorkflowStepOutputStatus> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStepOutputStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStepOutputStatus.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowStepOutputStatus.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "succeeded") || (data === "failed"))){validateWorkflowStepOutputStatus.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1579.enum}}];return false;}validateWorkflowStepOutputStatus.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStepOutputStatus.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowStepOutputs}. */
// prettier-ignore
export const validateWorkflowStepOutputs: CompiledSchemaCheck<WorkflowStepOutputs> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStepOutputs {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStepOutputs.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.nodeId === undefined) && (missing0 = "nodeId")) || ((data.executionIndex === undefined) && (missing0 = "executionIndex"))) || ((data.status === undefined) && (missing0 = "status"))) || ((data.outputs === undefined) && (missing0 = "outputs"))){validateWorkflowStepOutputs.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "nodeId") || (key0 === "executionIndex")) || (key0 === "status")) || (key0 === "outputs"))){validateWorkflowStepOutputs.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.nodeId !== undefined){const _errs2: any = errors;if(!(validateWorkflowNodeId.call(this, data.nodeId, {instancePath:instancePath+"/nodeId",parentData:data,parentDataProperty:"nodeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionIndex !== undefined){let data1: any = data.executionIndex;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowStepOutputs.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowStepOutputs.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateWorkflowStepOutputs.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){const _errs5: any = errors;if(!(validateWorkflowStepOutputStatus.call(this, data.status, {instancePath:instancePath+"/status",parentData:data,parentDataProperty:"status",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStepOutputStatus.errors : vErrors.concat(validateWorkflowStepOutputStatus.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputs !== undefined){let data3: any = data.outputs;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data3)){var valid1: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validateWorkflowStepOutput.call(this, data3[i0], {instancePath:instancePath+"/outputs/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStepOutput.errors : vErrors.concat(validateWorkflowStepOutput.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;if(!valid1){break;}}}else {validateWorkflowStepOutputs.errors = [{instancePath:instancePath+"/outputs",schemaPath:"#/properties/outputs/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateWorkflowStepOutputs.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowStepOutputs.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStepOutputs.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowStepOutputListResponse}. */
// prettier-ignore
export const validateWorkflowStepOutputListResponse: CompiledSchemaCheck<WorkflowStepOutputListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStepOutputListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStepOutputListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.steps === undefined) && (missing0 = "steps")){validateWorkflowStepOutputListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "steps")){validateWorkflowStepOutputListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.steps !== undefined){let data0: any = data.steps;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateWorkflowStepOutputs.call(this, data0[i0], {instancePath:instancePath+"/steps/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStepOutputs.errors : vErrors.concat(validateWorkflowStepOutputs.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateWorkflowStepOutputListResponse.errors = [{instancePath:instancePath+"/steps",schemaPath:"#/properties/steps/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateWorkflowStepOutputListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowStepOutputListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStepOutputListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowGateResolveRequest}. */
// prettier-ignore
export const validateWorkflowGateResolveRequest: CompiledSchemaCheck<WorkflowGateResolveRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowGateResolveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowGateResolveRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.decision === undefined) && (missing0 = "decision"))){validateWorkflowGateResolveRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "workflowRunId") || (key0 === "nodeId")) || (key0 === "decision")) || (key0 === "feedback"))){validateWorkflowGateResolveRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){const _errs3: any = errors;if(!(validateWorkflowNodeId.call(this, data.nodeId, {instancePath:instancePath+"/nodeId",parentData:data,parentDataProperty:"nodeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.decision !== undefined){const _errs4: any = errors;if(!(validateApprovalDecision.call(this, data.decision, {instancePath:instancePath+"/decision",parentData:data,parentDataProperty:"decision",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalDecision.errors : vErrors.concat(validateApprovalDecision.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.feedback !== undefined){let data3: any = data.feedback;const _errs5: any = errors;if(errors === _errs5){if(typeof data3 === "string"){if(func1(data3) < 1){validateWorkflowGateResolveRequest.errors = [{instancePath:instancePath+"/feedback",schemaPath:"#/properties/feedback/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowGateResolveRequest.errors = [{instancePath:instancePath+"/feedback",schemaPath:"#/properties/feedback/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validateWorkflowGateResolveRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowGateResolveRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowGateResolveRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowGateResolveResponse}. */
// prettier-ignore
export const validateWorkflowGateResolveResponse: CompiledSchemaCheck<WorkflowGateResolveResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowGateResolveResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowGateResolveResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.gateResolutionId === undefined) && (missing0 = "gateResolutionId")) || ((data.decidedAt === undefined) && (missing0 = "decidedAt"))){validateWorkflowGateResolveResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "gateResolutionId") || (key0 === "decidedAt"))){validateWorkflowGateResolveResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.gateResolutionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowGateResolutionId.call(this, data.gateResolutionId, {instancePath:instancePath+"/gateResolutionId",parentData:data,parentDataProperty:"gateResolutionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowGateResolutionId.errors : vErrors.concat(validateWorkflowGateResolutionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.decidedAt !== undefined){const _errs3: any = errors;if(!(validateWireInstant.call(this, data.decidedAt, {instancePath:instancePath+"/decidedAt",parentData:data,parentDataProperty:"decidedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowGateResolveResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowGateResolveResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowGateResolveResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowHumanFormDraft}. */
// prettier-ignore
export const validateWorkflowHumanFormDraft: CompiledSchemaCheck<WorkflowHumanFormDraft> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowHumanFormDraft {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowHumanFormDraft.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.formState === undefined) && (missing0 = "formState")) || ((data.revision === undefined) && (missing0 = "revision"))) || ((data.savedAt === undefined) && (missing0 = "savedAt"))){validateWorkflowHumanFormDraft.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "formState") || (key0 === "revision")) || (key0 === "savedAt"))){validateWorkflowHumanFormDraft.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.formState !== undefined){let data0: any = data.formState;const _errs2: any = errors;if(errors === _errs2){if(data0 && typeof data0 == "object" && !Array.isArray(data0)){for(const key1 in data0){const _errs4: any = errors;const _errs5: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/formState",schemaPath:"#/properties/formState/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs5 === errors;if(valid2){const _errs7: any = errors;const _errs8: any = errors;const _errs9: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid3: any = _errs9 === errors;if(valid3){const err2: any = {instancePath:instancePath+"/formState",schemaPath:"#/properties/formState/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs8;if(vErrors !== null){if(_errs8){vErrors.length = _errs8;}else {vErrors = null;}}}var valid2: any = _errs7 === errors;}var valid1: any = _errs4 === errors;if(!valid1){const err3: any = {instancePath:instancePath+"/formState",schemaPath:"#/properties/formState/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateWorkflowHumanFormDraft.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data0){const _errs11: any = errors;var valid4: any = _errs11 === errors;if(!valid4){break;}}}}else {validateWorkflowHumanFormDraft.errors = [{instancePath:instancePath+"/formState",schemaPath:"#/properties/formState/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.revision !== undefined){let data2: any = data.revision;const _errs13: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateWorkflowHumanFormDraft.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateWorkflowHumanFormDraft.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateWorkflowHumanFormDraft.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.savedAt !== undefined){const _errs15: any = errors;if(!(validateWireInstant.call(this, data.savedAt, {instancePath:instancePath+"/savedAt",parentData:data,parentDataProperty:"savedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowHumanFormDraft.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowHumanFormDraft.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowHumanFormDraft.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowHumanFormReadResponse}. */
// prettier-ignore
export const validateWorkflowHumanFormReadResponse: CompiledSchemaCheck<WorkflowHumanFormReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowHumanFormReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowHumanFormReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.prompt === undefined) && (missing0 = "prompt")) || ((data.fields === undefined) && (missing0 = "fields"))) || ((data.formRevision === undefined) && (missing0 = "formRevision"))){validateWorkflowHumanFormReadResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "prompt") || (key0 === "fields")) || (key0 === "formRevision")) || (key0 === "draft"))){validateWorkflowHumanFormReadResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.prompt !== undefined){let data0: any = data.prompt;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateWorkflowHumanFormReadResponse.errors = [{instancePath:instancePath+"/prompt",schemaPath:"#/properties/prompt/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowHumanFormReadResponse.errors = [{instancePath:instancePath+"/prompt",schemaPath:"#/properties/prompt/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.fields !== undefined){let data1: any = data.fields;const _errs4: any = errors;if(errors === _errs4){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs6: any = errors;if(!(validateWorkflowParamSpec.call(this, data1[i0], {instancePath:instancePath+"/fields/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowParamSpec.errors : vErrors.concat(validateWorkflowParamSpec.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;if(!valid1){break;}}}else {validateWorkflowHumanFormReadResponse.errors = [{instancePath:instancePath+"/fields",schemaPath:"#/properties/fields/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.formRevision !== undefined){let data3: any = data.formRevision;const _errs7: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateWorkflowHumanFormReadResponse.errors = [{instancePath:instancePath+"/formRevision",schemaPath:"#/properties/formRevision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateWorkflowHumanFormReadResponse.errors = [{instancePath:instancePath+"/formRevision",schemaPath:"#/properties/formRevision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateWorkflowHumanFormReadResponse.errors = [{instancePath:instancePath+"/formRevision",schemaPath:"#/properties/formRevision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.draft !== undefined){const _errs9: any = errors;if(!(validateWorkflowHumanFormDraft.call(this, data.draft, {instancePath:instancePath+"/draft",parentData:data,parentDataProperty:"draft",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowHumanFormDraft.errors : vErrors.concat(validateWorkflowHumanFormDraft.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}}else {validateWorkflowHumanFormReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowHumanFormReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowHumanFormReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowHumanFormDraftUpdateRequest}. */
// prettier-ignore
export const validateWorkflowHumanFormDraftUpdateRequest: CompiledSchemaCheck<WorkflowHumanFormDraftUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowHumanFormDraftUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowHumanFormDraftUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.nodeId === undefined) && (missing0 = "nodeId"))) || ((data.attempt === undefined) && (missing0 = "attempt"))) || ((data.executionIndex === undefined) && (missing0 = "executionIndex"))) || ((data.formState === undefined) && (missing0 = "formState"))){validateWorkflowHumanFormDraftUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "workflowRunId") || (key0 === "nodeId")) || (key0 === "attempt")) || (key0 === "executionIndex")) || (key0 === "formState")) || (key0 === "expectedRevision"))){validateWorkflowHumanFormDraftUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){const _errs3: any = errors;if(!(validateWorkflowNodeId.call(this, data.nodeId, {instancePath:instancePath+"/nodeId",parentData:data,parentDataProperty:"nodeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.attempt !== undefined){let data2: any = data.attempt;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateWorkflowHumanFormDraftUpdateRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateWorkflowHumanFormDraftUpdateRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateWorkflowHumanFormDraftUpdateRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionIndex !== undefined){let data3: any = data.executionIndex;const _errs6: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateWorkflowHumanFormDraftUpdateRequest.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateWorkflowHumanFormDraftUpdateRequest.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateWorkflowHumanFormDraftUpdateRequest.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.formState !== undefined){let data4: any = data.formState;const _errs8: any = errors;if(errors === _errs8){if(data4 && typeof data4 == "object" && !Array.isArray(data4)){for(const key1 in data4){const _errs10: any = errors;const _errs11: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/formState",schemaPath:"#/properties/formState/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs11 === errors;if(valid2){const _errs13: any = errors;const _errs14: any = errors;const _errs15: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid3: any = _errs15 === errors;if(valid3){const err2: any = {instancePath:instancePath+"/formState",schemaPath:"#/properties/formState/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs14;if(vErrors !== null){if(_errs14){vErrors.length = _errs14;}else {vErrors = null;}}}var valid2: any = _errs13 === errors;}var valid1: any = _errs10 === errors;if(!valid1){const err3: any = {instancePath:instancePath+"/formState",schemaPath:"#/properties/formState/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateWorkflowHumanFormDraftUpdateRequest.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data4){const _errs17: any = errors;var valid4: any = _errs17 === errors;if(!valid4){break;}}}}else {validateWorkflowHumanFormDraftUpdateRequest.errors = [{instancePath:instancePath+"/formState",schemaPath:"#/properties/formState/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.expectedRevision !== undefined){let data6: any = data.expectedRevision;const _errs19: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validateWorkflowHumanFormDraftUpdateRequest.errors = [{instancePath:instancePath+"/expectedRevision",schemaPath:"#/properties/expectedRevision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs19){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validateWorkflowHumanFormDraftUpdateRequest.errors = [{instancePath:instancePath+"/expectedRevision",schemaPath:"#/properties/expectedRevision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 1 || isNaN(data6)){validateWorkflowHumanFormDraftUpdateRequest.errors = [{instancePath:instancePath+"/expectedRevision",schemaPath:"#/properties/expectedRevision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateWorkflowHumanFormDraftUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowHumanFormDraftUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowHumanFormDraftUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowHumanFormDraftUpdateResponse}. */
// prettier-ignore
export const validateWorkflowHumanFormDraftUpdateResponse: CompiledSchemaCheck<WorkflowHumanFormDraftUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowHumanFormDraftUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowHumanFormDraftUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.revision === undefined) && (missing0 = "revision")) || ((data.savedAt === undefined) && (missing0 = "savedAt"))){validateWorkflowHumanFormDraftUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "revision") || (key0 === "savedAt"))){validateWorkflowHumanFormDraftUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.revision !== undefined){let data0: any = data.revision;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateWorkflowHumanFormDraftUpdateResponse.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateWorkflowHumanFormDraftUpdateResponse.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validateWorkflowHumanFormDraftUpdateResponse.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.savedAt !== undefined){const _errs4: any = errors;if(!(validateWireInstant.call(this, data.savedAt, {instancePath:instancePath+"/savedAt",parentData:data,parentDataProperty:"savedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowHumanFormDraftUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowHumanFormDraftUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowHumanFormDraftUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link WorkflowHumanFormPathAnswer}. */
// prettier-ignore
export const validateWorkflowHumanFormPathAnswer: CompiledSchemaCheck<WorkflowHumanFormPathAnswer> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowHumanFormPathAnswer {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowHumanFormPathAnswer.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.field === undefined) && (missing0 = "field")) || ((data.path === undefined) && (missing0 = "path"))){validateWorkflowHumanFormPathAnswer.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "field") || (key0 === "path"))){validateWorkflowHumanFormPathAnswer.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.field !== undefined){let data0: any = data.field;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateWorkflowHumanFormPathAnswer.errors = [{instancePath:instancePath+"/field",schemaPath:"#/properties/field/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowHumanFormPathAnswer.errors = [{instancePath:instancePath+"/field",schemaPath:"#/properties/field/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 4096){validateWorkflowHumanFormPathAnswer.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validateWorkflowHumanFormPathAnswer.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data1)){validateWorkflowHumanFormPathAnswer.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateWorkflowHumanFormPathAnswer.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowHumanFormPathAnswer.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowHumanFormPathAnswer.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowHumanFormPathAnswer.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func0 = deepEqual;
/** Checks that a value is a {@link WorkflowHumanFormSubmitRequest}. */
// prettier-ignore
export const validateWorkflowHumanFormSubmitRequest: CompiledSchemaCheck<WorkflowHumanFormSubmitRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowHumanFormSubmitRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowHumanFormSubmitRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.nodeId === undefined) && (missing0 = "nodeId"))) || ((data.attempt === undefined) && (missing0 = "attempt"))) || ((data.executionIndex === undefined) && (missing0 = "executionIndex"))) || ((data.fields === undefined) && (missing0 = "fields"))) || ((data.expectedRevision === undefined) && (missing0 = "expectedRevision"))){validateWorkflowHumanFormSubmitRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "workflowRunId") || (key0 === "nodeId")) || (key0 === "attempt")) || (key0 === "executionIndex")) || (key0 === "fields")) || (key0 === "paths")) || (key0 === "expectedRevision"))){validateWorkflowHumanFormSubmitRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){const _errs3: any = errors;if(!(validateWorkflowNodeId.call(this, data.nodeId, {instancePath:instancePath+"/nodeId",parentData:data,parentDataProperty:"nodeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.attempt !== undefined){let data2: any = data.attempt;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateWorkflowHumanFormSubmitRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateWorkflowHumanFormSubmitRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateWorkflowHumanFormSubmitRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionIndex !== undefined){let data3: any = data.executionIndex;const _errs6: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateWorkflowHumanFormSubmitRequest.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateWorkflowHumanFormSubmitRequest.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateWorkflowHumanFormSubmitRequest.errors = [{instancePath:instancePath+"/executionIndex",schemaPath:"#/properties/executionIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.fields !== undefined){let data4: any = data.fields;const _errs8: any = errors;if(errors === _errs8){if(data4 && typeof data4 == "object" && !Array.isArray(data4)){for(const key1 in data4){const _errs10: any = errors;const _errs11: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/fields",schemaPath:"#/properties/fields/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs11 === errors;if(valid2){const _errs13: any = errors;const _errs14: any = errors;const _errs15: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid3: any = _errs15 === errors;if(valid3){const err2: any = {instancePath:instancePath+"/fields",schemaPath:"#/properties/fields/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs14;if(vErrors !== null){if(_errs14){vErrors.length = _errs14;}else {vErrors = null;}}}var valid2: any = _errs13 === errors;}var valid1: any = _errs10 === errors;if(!valid1){const err3: any = {instancePath:instancePath+"/fields",schemaPath:"#/properties/fields/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateWorkflowHumanFormSubmitRequest.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data4){const _errs17: any = errors;var valid4: any = _errs17 === errors;if(!valid4){break;}}}}else {validateWorkflowHumanFormSubmitRequest.errors = [{instancePath:instancePath+"/fields",schemaPath:"#/properties/fields/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.paths !== undefined){let data6: any = data.paths;const _errs19: any = errors;if(errors === _errs19){if(Array.isArray(data6)){var valid5: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){const _errs21: any = errors;if(!(validateWorkflowHumanFormPathAnswer.call(this, data6[i0], {instancePath:instancePath+"/paths/" + i0,parentData:data6,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowHumanFormPathAnswer.errors : vErrors.concat(validateWorkflowHumanFormPathAnswer.errors);errors = vErrors.length;}var valid5: any = _errs21 === errors;if(!valid5){break;}}if(valid5){let valid6: any;let i1: any = data6.length;let j0: any;valid6 = true;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data6[i1], data6[j0])){validateWorkflowHumanFormSubmitRequest.errors = [{instancePath:instancePath+"/paths",schemaPath:"#/properties/paths/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;valid6 = false;break outer0;}}}}if(valid6){if(repeatsItemKey(data6, "field")){validateWorkflowHumanFormSubmitRequest.errors = [{instancePath:instancePath+"/paths",schemaPath:"#/properties/paths/uniqueItemKey",keyword:"uniqueItemKey",params:{}}];return false;}}}}else {validateWorkflowHumanFormSubmitRequest.errors = [{instancePath:instancePath+"/paths",schemaPath:"#/properties/paths/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}if(valid0){if(data.expectedRevision !== undefined){let data8: any = data.expectedRevision;const _errs22: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validateWorkflowHumanFormSubmitRequest.errors = [{instancePath:instancePath+"/expectedRevision",schemaPath:"#/properties/expectedRevision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs22){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validateWorkflowHumanFormSubmitRequest.errors = [{instancePath:instancePath+"/expectedRevision",schemaPath:"#/properties/expectedRevision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 0 || isNaN(data8)){validateWorkflowHumanFormSubmitRequest.errors = [{instancePath:instancePath+"/expectedRevision",schemaPath:"#/properties/expectedRevision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validateWorkflowHumanFormSubmitRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowHumanFormSubmitRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowHumanFormSubmitRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowHumanFormSubmitResponse}. */
// prettier-ignore
export const validateWorkflowHumanFormSubmitResponse: CompiledSchemaCheck<WorkflowHumanFormSubmitResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowHumanFormSubmitResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowHumanFormSubmitResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.submittedAt === undefined) && (missing0 = "submittedAt")){validateWorkflowHumanFormSubmitResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "submittedAt")){validateWorkflowHumanFormSubmitResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.submittedAt !== undefined){if(!(validateWireInstant.call(this, data.submittedAt, {instancePath:instancePath+"/submittedAt",parentData:data,parentDataProperty:"submittedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}}}}}else {validateWorkflowHumanFormSubmitResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowHumanFormSubmitResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowHumanFormSubmitResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowFixSessionCreateResponse}. */
// prettier-ignore
export const validateWorkflowFixSessionCreateResponse: CompiledSchemaCheck<WorkflowFixSessionCreateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowFixSessionCreateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowFixSessionCreateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateWorkflowFixSessionCreateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateWorkflowFixSessionCreateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateWorkflowFixSessionCreateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowFixSessionCreateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowFixSessionCreateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link WORKFLOW_STEP_METHOD_DESCRIPTORS}, each with its checks. */
export interface WorkflowStepMethodDescriptors {
  readonly "workflow.step.read": {
    readonly method: "workflow.step.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowStepReadRequest>;
    readonly responseCheck: SchemaCheck<WorkflowStepReadResponse>;
  };
  readonly "workflow.step.tabArtifact.create": {
    readonly method: "workflow.step.tabArtifact.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowStepTabArtifactCreateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowStepTabArtifactCreateResponse>;
  };
  readonly "workflow.step.output.list": {
    readonly method: "workflow.step.output.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowStepOutputListRequest>;
    readonly responseCheck: SchemaCheck<WorkflowStepOutputListResponse>;
  };
  readonly "workflow.gate.resolve": {
    readonly method: "workflow.gate.resolve";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowGateResolveRequest>;
    readonly responseCheck: SchemaCheck<WorkflowGateResolveResponse>;
  };
  readonly "workflow.humanForm.read": {
    readonly method: "workflow.humanForm.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowStepKey>;
    readonly responseCheck: SchemaCheck<WorkflowHumanFormReadResponse>;
  };
  readonly "workflow.humanForm.draft.update": {
    readonly method: "workflow.humanForm.draft.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowHumanFormDraftUpdateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowHumanFormDraftUpdateResponse>;
  };
  readonly "workflow.humanForm.submit": {
    readonly method: "workflow.humanForm.submit";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowHumanFormSubmitRequest>;
    readonly responseCheck: SchemaCheck<WorkflowHumanFormSubmitResponse>;
  };
  readonly "workflow.fixSession.create": {
    readonly method: "workflow.fixSession.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowStepKey>;
    readonly responseCheck: SchemaCheck<WorkflowFixSessionCreateResponse>;
  };
}
/** The `workflow.*` methods on one step. */
export const WORKFLOW_STEP_METHOD_DESCRIPTORS: WorkflowStepMethodDescriptors = Object.freeze({
  "workflow.step.read": Object.freeze({
    method: "workflow.step.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateWorkflowStepReadRequest,
    responseCheck: validateWorkflowStepReadResponse,
  }),
  "workflow.step.tabArtifact.create": Object.freeze({
    method: "workflow.step.tabArtifact.create",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateWorkflowStepTabArtifactCreateRequest,
    responseCheck: validateWorkflowStepTabArtifactCreateResponse,
  }),
  "workflow.step.output.list": Object.freeze({
    method: "workflow.step.output.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateWorkflowStepOutputListRequest,
    responseCheck: validateWorkflowStepOutputListResponse,
  }),
  "workflow.gate.resolve": Object.freeze({
    method: "workflow.gate.resolve",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateWorkflowGateResolveRequest,
    responseCheck: validateWorkflowGateResolveResponse,
  }),
  "workflow.humanForm.read": Object.freeze({
    method: "workflow.humanForm.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateWorkflowStepKey,
    responseCheck: validateWorkflowHumanFormReadResponse,
  }),
  "workflow.humanForm.draft.update": Object.freeze({
    method: "workflow.humanForm.draft.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateWorkflowHumanFormDraftUpdateRequest,
    responseCheck: validateWorkflowHumanFormDraftUpdateResponse,
  }),
  "workflow.humanForm.submit": Object.freeze({
    method: "workflow.humanForm.submit",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateWorkflowHumanFormSubmitRequest,
    responseCheck: validateWorkflowHumanFormSubmitResponse,
  }),
  "workflow.fixSession.create": Object.freeze({
    method: "workflow.fixSession.create",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateWorkflowStepKey,
    responseCheck: validateWorkflowFixSessionCreateResponse,
  }),
});
