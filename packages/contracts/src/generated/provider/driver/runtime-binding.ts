// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The id of a runtime binding, one live session's leg on its provider.

import { type CompiledSchemaCheck, ucs2length } from "../../../schema-check.js";

/**
 * The id of a runtime binding, one live session's leg on its provider: minted by the
 * daemon's store, or by the driver for a leg it relaunched. Opaque to every client.
 */
export type RuntimeBindingId = string & { readonly __brand: "RuntimeBindingId" };

// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link RuntimeBindingId}. */
// prettier-ignore
export const validateRuntimeBindingId: CompiledSchemaCheck<RuntimeBindingId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RuntimeBindingId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRuntimeBindingId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateRuntimeBindingId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateRuntimeBindingId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateRuntimeBindingId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateRuntimeBindingId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRuntimeBindingId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
