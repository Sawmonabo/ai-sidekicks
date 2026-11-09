// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A workflow's kept values: what `Keep for later runs` holds for the workflow's later runs, and clearing them, with its method table.

import type { SchemaCheck } from "../../schema-check.js";
import type { WorkflowDefinitionId } from "./definition/document.js";

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

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate2446(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowKeptValueClearRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2446.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.definitionId === undefined) && (missing0 = "definitionId")){validate2446.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "definitionId")){validate2446.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){let data0: any = data.definitionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2446.errors = [{instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2446.errors = [{instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2446.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2446.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2446.errors = null as any[] | null;
// prettier-ignore
validate2446.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2447(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowKeptValueClearResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2447.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.clearedCount === undefined) && (missing0 = "clearedCount"))){validate2447.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitionId") || (key0 === "clearedCount"))){validate2447.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){let data0: any = data.definitionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2447.errors = [{instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2447.errors = [{instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.clearedCount !== undefined){let data1: any = data.clearedCount;const _errs6: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate2447.errors = [{instancePath:instancePath+"/clearedCount",schemaPath:"#/properties/clearedCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate2447.errors = [{instancePath:instancePath+"/clearedCount",schemaPath:"#/properties/clearedCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate2447.errors = [{instancePath:instancePath+"/clearedCount",schemaPath:"#/properties/clearedCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2447.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2447.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2447.errors = null as any[] | null;
// prettier-ignore
validate2447.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowKeptValueClearRequest}. */
export const validateWorkflowKeptValueClearRequest: SchemaCheck<WorkflowKeptValueClearRequest> =
  validate2446;
/** Checks that a value is a {@link WorkflowKeptValueClearResponse}. */
export const validateWorkflowKeptValueClearResponse: SchemaCheck<WorkflowKeptValueClearResponse> =
  validate2447;

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
