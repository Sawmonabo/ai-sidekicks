/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The id of one run, which every run, session, approval, question, plan and workflow contract carries.

import type { SchemaCheck } from "../../schema-check.js";

/**
 * Identifies one run. Only a UUID is accepted, so a path or an SQL fragment never reaches a
 * store lookup.
 */
export type RunId = string & { readonly __brand: "RunId" };

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate1753(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RunId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1753.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate1753.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1753.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1753.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1753.errors = null as any[] | null;
// prettier-ignore
validate1753.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RunId}. */
export const validateRunId: SchemaCheck<RunId> = validate1753;
