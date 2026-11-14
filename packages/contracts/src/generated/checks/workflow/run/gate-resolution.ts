// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The record of one answer to a run's gate: an approval step's question or its chain's question, appended and never rewritten, numbered per run.

import type { CompiledSchemaCheck } from "../../../../schema-check.js";
import type { WorkflowGateResolutionId } from "../../../workflow/run/gate-resolution.js";

// prettier-ignore
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link WorkflowGateResolutionId}. */
// prettier-ignore
export const validateWorkflowGateResolutionId: CompiledSchemaCheck<WorkflowGateResolutionId> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowGateResolutionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowGateResolutionId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateWorkflowGateResolutionId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateWorkflowGateResolutionId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowGateResolutionId.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
