// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The leaf of the session event contracts: the envelope's version. It imports no other event module, so every one of them can import it.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";

/**
 * A producer's "MAJOR.MINOR" protocol version, written at emit time and never rewritten on read.
 */
export type EventEnvelopeVersion = string & { readonly __brand: "EventEnvelopeVersion" };

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern216 = new RegExp("^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$", "u");
/** Checks that a value is a {@link EventEnvelopeVersion}. */
// prettier-ignore
export const validateEventEnvelopeVersion: CompiledSchemaCheck<EventEnvelopeVersion> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is EventEnvelopeVersion {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateEventEnvelopeVersion.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 64){validateEventEnvelopeVersion.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 64}}];return false;}else {if(!pattern216.test(data)){validateEventEnvelopeVersion.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$"}}];return false;}}}else {validateEventEnvelopeVersion.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateEventEnvelopeVersion.errors = vErrors;return errors === 0;};
// prettier-ignore
validateEventEnvelopeVersion.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
