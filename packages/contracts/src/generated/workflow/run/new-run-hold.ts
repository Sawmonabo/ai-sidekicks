// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The hold on starting new runs: one per daemon over its whole scheduler, and how many starts wait behind it.

import type { CompiledSchemaCheck } from "../../../schema-check.js";

/**
 * The `workflow.newRunHold.update` input: the hold on starting new runs, one per daemon over its
 * whole scheduler. A run already going finishes; every new start waits until the hold is off.
 */
export interface WorkflowNewRunHoldUpdateRequest {
  /**
   * Whether the hold is on.
   */
  held: boolean;
}
/**
 * The hold and how many starts wait behind it, as the `workflow.newRunHold.update` reply and the
 * `workflow.subscribe` stream carry it.
 */
export interface WorkflowNewRunHoldState {
  /**
   * Whether the hold is on.
   */
  held: boolean;
  /**
   * How many starts wait behind it.
   */
  waitingStartCount: number;
}

/** Checks that a value is a {@link WorkflowNewRunHoldUpdateRequest}. */
// prettier-ignore
export const validateWorkflowNewRunHoldUpdateRequest: CompiledSchemaCheck<WorkflowNewRunHoldUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNewRunHoldUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNewRunHoldUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.held === undefined) && (missing0 = "held")){validateWorkflowNewRunHoldUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "held")){validateWorkflowNewRunHoldUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.held !== undefined){if(typeof data.held !== "boolean"){validateWorkflowNewRunHoldUpdateRequest.errors = [{instancePath:instancePath+"/held",schemaPath:"#/properties/held/type",keyword:"type",params:{type: "boolean"}}];return false;}}}}}else {validateWorkflowNewRunHoldUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowNewRunHoldUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNewRunHoldUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowNewRunHoldState}. */
// prettier-ignore
export const validateWorkflowNewRunHoldState: CompiledSchemaCheck<WorkflowNewRunHoldState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNewRunHoldState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNewRunHoldState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.held === undefined) && (missing0 = "held")) || ((data.waitingStartCount === undefined) && (missing0 = "waitingStartCount"))){validateWorkflowNewRunHoldState.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "held") || (key0 === "waitingStartCount"))){validateWorkflowNewRunHoldState.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.held !== undefined){const _errs2: any = errors;if(typeof data.held !== "boolean"){validateWorkflowNewRunHoldState.errors = [{instancePath:instancePath+"/held",schemaPath:"#/properties/held/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.waitingStartCount !== undefined){let data1: any = data.waitingStartCount;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowNewRunHoldState.errors = [{instancePath:instancePath+"/waitingStartCount",schemaPath:"#/properties/waitingStartCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowNewRunHoldState.errors = [{instancePath:instancePath+"/waitingStartCount",schemaPath:"#/properties/waitingStartCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateWorkflowNewRunHoldState.errors = [{instancePath:instancePath+"/waitingStartCount",schemaPath:"#/properties/waitingStartCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowNewRunHoldState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowNewRunHoldState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNewRunHoldState.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
