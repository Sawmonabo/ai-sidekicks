// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Run retention: deleting one run, deleting the runs older than an instant and its preview, and marking a run Keep, which such a delete leaves.

import type { CompiledSchemaCheck } from "../../../schema-check.js";
import { type WireInstant, validateWireInstant } from "../../internal/wire-scalars.js";
import { type WorkflowRunId, validateWorkflowRunId } from "./id.js";

/**
 * The `workflow.run.delete` input. Deleting a run removes its record, its steps and its recorded
 * snapshots, and cannot be undone; a run that has not ended is refused: cancel it first.
 */
export interface WorkflowRunDeleteRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
}
/**
 * The `workflow.run.delete` result.
 */
export interface WorkflowRunDeleteResponse {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * Always `true`.
   */
  deleted: true;
}
/**
 * The `workflow.run.purge.preview` and `workflow.run.purge` input: the runs that started before
 * this instant. A run marked Keep, one that has not ended, and a chain's first run while a later
 * run of its chain has not ended are never removed.
 */
export interface WorkflowRunPurgeRequest {
  /**
   * The instant.
   */
  olderThan: WireInstant;
}
/**
 * The `workflow.run.purge.preview` result, read before the confirm: how many runs the delete would
 * remove, and how many older runs it would leave because they are kept or waiting.
 */
export interface WorkflowRunPurgePreviewResponse {
  /**
   * The runs it would remove.
   */
  deleteCount: number;
  /**
   * The older runs it would leave because they are marked Keep.
   */
  keptCount: number;
  /**
   * The older runs it would leave because they are waiting.
   */
  waitingCount: number;
}
/**
 * The `workflow.run.purge` result. Runs may start or end between the preview and the delete, so
 * this count, not the preview's, is what was removed.
 */
export interface WorkflowRunPurgeResponse {
  /**
   * The runs removed.
   */
  deletedCount: number;
}
/**
 * The `workflow.run.keep.update` input and result alike: whether the run is marked Keep, which
 * deleting old runs leaves.
 */
export interface WorkflowRunKeepSet {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * Whether it is marked Keep.
   */
  keep: boolean;
}

/** Checks that a value is a {@link WorkflowRunDeleteRequest}. */
// prettier-ignore
export const validateWorkflowRunDeleteRequest: CompiledSchemaCheck<WorkflowRunDeleteRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunDeleteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunDeleteRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workflowRunId === undefined) && (missing0 = "workflowRunId")){validateWorkflowRunDeleteRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "workflowRunId")){validateWorkflowRunDeleteRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}}}}}else {validateWorkflowRunDeleteRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunDeleteRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunDeleteRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunDeleteResponse}. */
// prettier-ignore
export const validateWorkflowRunDeleteResponse: CompiledSchemaCheck<WorkflowRunDeleteResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunDeleteResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunDeleteResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.deleted === undefined) && (missing0 = "deleted"))){validateWorkflowRunDeleteResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "deleted"))){validateWorkflowRunDeleteResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.deleted !== undefined){let data1: any = data.deleted;const _errs3: any = errors;if(typeof data1 !== "boolean"){validateWorkflowRunDeleteResponse.errors = [{instancePath:instancePath+"/deleted",schemaPath:"#/properties/deleted/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data1){validateWorkflowRunDeleteResponse.errors = [{instancePath:instancePath+"/deleted",schemaPath:"#/properties/deleted/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowRunDeleteResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunDeleteResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunDeleteResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunPurgeRequest}. */
// prettier-ignore
export const validateWorkflowRunPurgeRequest: CompiledSchemaCheck<WorkflowRunPurgeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunPurgeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunPurgeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.olderThan === undefined) && (missing0 = "olderThan")){validateWorkflowRunPurgeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "olderThan")){validateWorkflowRunPurgeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.olderThan !== undefined){if(!(validateWireInstant.call(this, data.olderThan, {instancePath:instancePath+"/olderThan",parentData:data,parentDataProperty:"olderThan",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}}}}}else {validateWorkflowRunPurgeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunPurgeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunPurgeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunPurgePreviewResponse}. */
// prettier-ignore
export const validateWorkflowRunPurgePreviewResponse: CompiledSchemaCheck<WorkflowRunPurgePreviewResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunPurgePreviewResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunPurgePreviewResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.deleteCount === undefined) && (missing0 = "deleteCount")) || ((data.keptCount === undefined) && (missing0 = "keptCount"))) || ((data.waitingCount === undefined) && (missing0 = "waitingCount"))){validateWorkflowRunPurgePreviewResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "deleteCount") || (key0 === "keptCount")) || (key0 === "waitingCount"))){validateWorkflowRunPurgePreviewResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.deleteCount !== undefined){let data0: any = data.deleteCount;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateWorkflowRunPurgePreviewResponse.errors = [{instancePath:instancePath+"/deleteCount",schemaPath:"#/properties/deleteCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateWorkflowRunPurgePreviewResponse.errors = [{instancePath:instancePath+"/deleteCount",schemaPath:"#/properties/deleteCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validateWorkflowRunPurgePreviewResponse.errors = [{instancePath:instancePath+"/deleteCount",schemaPath:"#/properties/deleteCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.keptCount !== undefined){let data1: any = data.keptCount;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowRunPurgePreviewResponse.errors = [{instancePath:instancePath+"/keptCount",schemaPath:"#/properties/keptCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowRunPurgePreviewResponse.errors = [{instancePath:instancePath+"/keptCount",schemaPath:"#/properties/keptCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateWorkflowRunPurgePreviewResponse.errors = [{instancePath:instancePath+"/keptCount",schemaPath:"#/properties/keptCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.waitingCount !== undefined){let data2: any = data.waitingCount;const _errs6: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateWorkflowRunPurgePreviewResponse.errors = [{instancePath:instancePath+"/waitingCount",schemaPath:"#/properties/waitingCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateWorkflowRunPurgePreviewResponse.errors = [{instancePath:instancePath+"/waitingCount",schemaPath:"#/properties/waitingCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateWorkflowRunPurgePreviewResponse.errors = [{instancePath:instancePath+"/waitingCount",schemaPath:"#/properties/waitingCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowRunPurgePreviewResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunPurgePreviewResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunPurgePreviewResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunPurgeResponse}. */
// prettier-ignore
export const validateWorkflowRunPurgeResponse: CompiledSchemaCheck<WorkflowRunPurgeResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunPurgeResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunPurgeResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.deletedCount === undefined) && (missing0 = "deletedCount")){validateWorkflowRunPurgeResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "deletedCount")){validateWorkflowRunPurgeResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.deletedCount !== undefined){let data0: any = data.deletedCount;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateWorkflowRunPurgeResponse.errors = [{instancePath:instancePath+"/deletedCount",schemaPath:"#/properties/deletedCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateWorkflowRunPurgeResponse.errors = [{instancePath:instancePath+"/deletedCount",schemaPath:"#/properties/deletedCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validateWorkflowRunPurgeResponse.errors = [{instancePath:instancePath+"/deletedCount",schemaPath:"#/properties/deletedCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validateWorkflowRunPurgeResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunPurgeResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunPurgeResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunKeepSet}. */
// prettier-ignore
export const validateWorkflowRunKeepSet: CompiledSchemaCheck<WorkflowRunKeepSet> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunKeepSet {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunKeepSet.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.keep === undefined) && (missing0 = "keep"))){validateWorkflowRunKeepSet.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "keep"))){validateWorkflowRunKeepSet.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.keep !== undefined){const _errs3: any = errors;if(typeof data.keep !== "boolean"){validateWorkflowRunKeepSet.errors = [{instancePath:instancePath+"/keep",schemaPath:"#/properties/keep/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowRunKeepSet.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowRunKeepSet.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowRunKeepSet.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
