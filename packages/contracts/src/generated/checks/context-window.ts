// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Where the window size on a `usage.contextWindow.updated` row came from.

import type { CompiledSchemaCheck } from "../../schema-check.js";
import type { ContextWindowSource } from "../context-window.js";

// prettier-ignore
const schema462: any = {"description":"Where a context window's figures came from: the provider reported them, or the window is the\nmodel's declared default.","type":"string","enum":["providerReported","modelDefault"]};
/** Checks that a value is a {@link ContextWindowSource}. */
// prettier-ignore
export const validateContextWindowSource: CompiledSchemaCheck<ContextWindowSource> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ContextWindowSource {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateContextWindowSource.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateContextWindowSource.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "providerReported") || (data === "modelDefault"))){validateContextWindowSource.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema462.enum}}];return false;}validateContextWindowSource.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
