// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A workflow's kept values: what `Keep for later runs` holds for the workflow's later runs, and clearing them, with its method table.

import type { CompiledSchemaCheck, SchemaCheck } from "../../schema-check.js";
import { type WorkflowDefinitionId, validateWorkflowDefinitionId } from "./definition/document.js";

/**
 * The `workflow.keptValue.clear` input: clear every value `Keep for later runs` kept for one
 * workflow. Kept values belong to the workflow, not to a version.
 */
export interface WorkflowKeptValueClearRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
}
/**
 * The `workflow.keptValue.clear` result: how many kept values went.
 */
export interface WorkflowKeptValueClearResponse {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * How many kept values were cleared.
   */
  clearedCount: number;
}

/** Checks that a value is a {@link WorkflowKeptValueClearRequest}. */
// prettier-ignore
export const validateWorkflowKeptValueClearRequest: CompiledSchemaCheck<WorkflowKeptValueClearRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowKeptValueClearRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowKeptValueClearRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.definitionId === undefined) && (missing0 = "definitionId")){validateWorkflowKeptValueClearRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "definitionId")){validateWorkflowKeptValueClearRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}}}}}else {validateWorkflowKeptValueClearRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowKeptValueClearRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowKeptValueClearRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowKeptValueClearResponse}. */
// prettier-ignore
export const validateWorkflowKeptValueClearResponse: CompiledSchemaCheck<WorkflowKeptValueClearResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowKeptValueClearResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowKeptValueClearResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.clearedCount === undefined) && (missing0 = "clearedCount"))){validateWorkflowKeptValueClearResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitionId") || (key0 === "clearedCount"))){validateWorkflowKeptValueClearResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.clearedCount !== undefined){let data1: any = data.clearedCount;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowKeptValueClearResponse.errors = [{instancePath:instancePath+"/clearedCount",schemaPath:"#/properties/clearedCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowKeptValueClearResponse.errors = [{instancePath:instancePath+"/clearedCount",schemaPath:"#/properties/clearedCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateWorkflowKeptValueClearResponse.errors = [{instancePath:instancePath+"/clearedCount",schemaPath:"#/properties/clearedCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowKeptValueClearResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowKeptValueClearResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowKeptValueClearResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link WORKFLOW_KEPT_VALUE_METHOD_DESCRIPTORS}, each with its checks. */
export interface WorkflowKeptValueMethodDescriptors {
  readonly "workflow.keptValue.clear": {
    readonly method: "workflow.keptValue.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowKeptValueClearRequest>;
    readonly responseCheck: SchemaCheck<WorkflowKeptValueClearResponse>;
  };
}
/** The `workflow.keptValue.clear` method's table. */
export const WORKFLOW_KEPT_VALUE_METHOD_DESCRIPTORS: WorkflowKeptValueMethodDescriptors =
  Object.freeze({
    "workflow.keptValue.clear": Object.freeze({
      method: "workflow.keptValue.clear",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowKeptValueClearRequest,
      responseCheck: validateWorkflowKeptValueClearResponse,
    }),
  });
