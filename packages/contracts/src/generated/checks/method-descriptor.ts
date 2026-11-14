// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What every method table shares: the payload of a method whose request or reply carries nothing, and the `null` reply of an act that reads nothing back.

import type { CompiledSchemaCheck } from "../../schema-check.js";
import type { EmptyPayload } from "../method-descriptor.js";

/** Checks that a value is a {@link EmptyPayload}. */
// prettier-ignore
export const validateEmptyPayload: CompiledSchemaCheck<EmptyPayload> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is EmptyPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateEmptyPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){for(const key0 in data){validateEmptyPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}else {validateEmptyPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateEmptyPayload.errors = vErrors;return errors === 0;}, { evaluated: {"props":true,"dynamicProps":false,"dynamicItems":false} as any });
