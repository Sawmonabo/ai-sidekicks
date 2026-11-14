// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A workflow's kept values: what `Keep for later runs` holds for the workflow's later runs, and clearing them, with its method table.

import type { SchemaCheck } from "../../schema-check.js";
import {
  validateWorkflowKeptValueClearRequest,
  validateWorkflowKeptValueClearResponse,
} from "../checks/workflow/kept-values.js";
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

export {
  validateWorkflowKeptValueClearRequest,
  validateWorkflowKeptValueClearResponse,
} from "../checks/workflow/kept-values.js";

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
  /* @__PURE__ */ Object.freeze({
    "workflow.keptValue.clear": /* @__PURE__ */ Object.freeze({
      method: "workflow.keptValue.clear",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowKeptValueClearRequest,
      responseCheck: validateWorkflowKeptValueClearResponse,
    }),
  });
