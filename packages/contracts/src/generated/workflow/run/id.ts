/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The id of one workflow run, which every run method, event and step record carries.

import type { SchemaCheck } from "../../../schema-check.js";

/**
 * Identifies one workflow run: a UUID the daemon mints; a client never builds one.
 */
export type WorkflowRunId = string & { readonly __brand: "WorkflowRunId" };

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate2515(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2515.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate2515.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2515.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate2515.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2515.errors = null as any[] | null;
// prettier-ignore
validate2515.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunId}. */
export const validateWorkflowRunId: SchemaCheck<WorkflowRunId> = validate2515;
