// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What every method table shares: the payload of a method whose request or reply carries nothing, and the `null` reply of an act that reads nothing back.

import type { CompiledSchemaCheck } from "../schema-check.js";

/**
 * A request or reply that carries nothing: the method's whole effect is what it changed. Any
 * member is refused.
 */
export type EmptyPayload = Record<string, never>;
/**
 * The reply of an act that reads nothing back: `null`.
 */
export type NullPayload = null;

/** Checks that a value is a {@link EmptyPayload}. */
// prettier-ignore
export const validateEmptyPayload: CompiledSchemaCheck<EmptyPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is EmptyPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateEmptyPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){for(const key0 in data){validateEmptyPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}else {validateEmptyPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateEmptyPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateEmptyPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link NullPayload}. */
// prettier-ignore
export const validateNullPayload: CompiledSchemaCheck<NullPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is NullPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateNullPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(data !== null){validateNullPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "null"}}];return false;}validateNullPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateNullPayload.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
