/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Run retention: deleting one run, deleting the runs older than an instant and its preview, and marking a run Keep, which such a delete leaves.

import type { SchemaCheck } from "../../../schema-check.js";
import type { WireInstant } from "../../internal/wire-scalars.js";
import type { WorkflowRunId } from "./id.js";

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

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate2745(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunDeleteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2745.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workflowRunId === undefined) && (missing0 = "workflowRunId")){validate2745.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "workflowRunId")){validate2745.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2745.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2745.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2745.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2745.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2745.errors = null as any[] | null;
// prettier-ignore
validate2745.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2746(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunDeleteResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2746.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.deleted === undefined) && (missing0 = "deleted"))){validate2746.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "deleted"))){validate2746.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2746.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2746.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.deleted !== undefined){let data1: any = data.deleted;const _errs6: any = errors;if(typeof data1 !== "boolean"){validate2746.errors = [{instancePath:instancePath+"/deleted",schemaPath:"#/properties/deleted/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data1){validate2746.errors = [{instancePath:instancePath+"/deleted",schemaPath:"#/properties/deleted/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2746.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2746.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2746.errors = null as any[] | null;
// prettier-ignore
validate2746.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2747(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunKeepSet {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2747.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.keep === undefined) && (missing0 = "keep"))){validate2747.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "workflowRunId") || (key0 === "keep"))){validate2747.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){let data0: any = data.workflowRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2747.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2747.errors = [{instancePath:instancePath+"/workflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.keep !== undefined){const _errs6: any = errors;if(typeof data.keep !== "boolean"){validate2747.errors = [{instancePath:instancePath+"/keep",schemaPath:"#/properties/keep/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2747.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2747.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2747.errors = null as any[] | null;
// prettier-ignore
validate2747.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2748(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunPurgePreviewResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2748.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.deleteCount === undefined) && (missing0 = "deleteCount")) || ((data.keptCount === undefined) && (missing0 = "keptCount"))) || ((data.waitingCount === undefined) && (missing0 = "waitingCount"))){validate2748.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "deleteCount") || (key0 === "keptCount")) || (key0 === "waitingCount"))){validate2748.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.deleteCount !== undefined){let data0: any = data.deleteCount;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate2748.errors = [{instancePath:instancePath+"/deleteCount",schemaPath:"#/properties/deleteCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate2748.errors = [{instancePath:instancePath+"/deleteCount",schemaPath:"#/properties/deleteCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validate2748.errors = [{instancePath:instancePath+"/deleteCount",schemaPath:"#/properties/deleteCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.keptCount !== undefined){let data1: any = data.keptCount;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate2748.errors = [{instancePath:instancePath+"/keptCount",schemaPath:"#/properties/keptCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate2748.errors = [{instancePath:instancePath+"/keptCount",schemaPath:"#/properties/keptCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate2748.errors = [{instancePath:instancePath+"/keptCount",schemaPath:"#/properties/keptCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.waitingCount !== undefined){let data2: any = data.waitingCount;const _errs6: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate2748.errors = [{instancePath:instancePath+"/waitingCount",schemaPath:"#/properties/waitingCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate2748.errors = [{instancePath:instancePath+"/waitingCount",schemaPath:"#/properties/waitingCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate2748.errors = [{instancePath:instancePath+"/waitingCount",schemaPath:"#/properties/waitingCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validate2748.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2748.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2748.errors = null as any[] | null;
// prettier-ignore
validate2748.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate2749(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunPurgeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2749.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.olderThan === undefined) && (missing0 = "olderThan")){validate2749.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "olderThan")){validate2749.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.olderThan !== undefined){let data0: any = data.olderThan;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern5.test(data0)){validate2749.errors = [{instancePath:instancePath+"/olderThan",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2749.errors = [{instancePath:instancePath+"/olderThan",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2749.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2749.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2749.errors = null as any[] | null;
// prettier-ignore
validate2749.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2750(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunPurgeResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2750.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.deletedCount === undefined) && (missing0 = "deletedCount")){validate2750.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "deletedCount")){validate2750.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.deletedCount !== undefined){let data0: any = data.deletedCount;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate2750.errors = [{instancePath:instancePath+"/deletedCount",schemaPath:"#/properties/deletedCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate2750.errors = [{instancePath:instancePath+"/deletedCount",schemaPath:"#/properties/deletedCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validate2750.errors = [{instancePath:instancePath+"/deletedCount",schemaPath:"#/properties/deletedCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate2750.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2750.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2750.errors = null as any[] | null;
// prettier-ignore
validate2750.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunDeleteRequest}. */
export const validateWorkflowRunDeleteRequest: SchemaCheck<WorkflowRunDeleteRequest> = validate2745;
/** Checks that a value is a {@link WorkflowRunDeleteResponse}. */
export const validateWorkflowRunDeleteResponse: SchemaCheck<WorkflowRunDeleteResponse> =
  validate2746;
/** Checks that a value is a {@link WorkflowRunKeepSet}. */
export const validateWorkflowRunKeepSet: SchemaCheck<WorkflowRunKeepSet> = validate2747;
/** Checks that a value is a {@link WorkflowRunPurgePreviewResponse}. */
export const validateWorkflowRunPurgePreviewResponse: SchemaCheck<WorkflowRunPurgePreviewResponse> =
  validate2748;
/** Checks that a value is a {@link WorkflowRunPurgeRequest}. */
export const validateWorkflowRunPurgeRequest: SchemaCheck<WorkflowRunPurgeRequest> = validate2749;
/** Checks that a value is a {@link WorkflowRunPurgeResponse}. */
export const validateWorkflowRunPurgeResponse: SchemaCheck<WorkflowRunPurgeResponse> = validate2750;
