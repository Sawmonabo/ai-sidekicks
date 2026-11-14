// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The open id a provider's driver answers to, checked against the registered drivers wherever a request or a provider message brings one in.

import type { CompiledSchemaCheck } from "../../schema-check.js";

/**
 * A provider's id as its driver declares it: a lowercase letter, then up to 31 lowercase
 * letters, digits or hyphens. Opaque to every client, which never branches on its value.
 */
export type ProviderId = string & { readonly __brand: "ProviderId" };

// prettier-ignore
const pattern11 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
/** Checks that a value is a {@link ProviderId}. */
// prettier-ignore
export const validateProviderId: CompiledSchemaCheck<ProviderId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern11.test(data)){validateProviderId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validateProviderId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateProviderId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
