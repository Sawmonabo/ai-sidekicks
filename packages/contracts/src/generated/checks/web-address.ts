// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The one rule every web address the app opens is held to: only `http:` and `https:`.

import type { CompiledSchemaCheck } from "../../schema-check.js";
import type { WebAddressFault } from "../web-address.js";

// prettier-ignore
const schema813: any = {"description":"Why a parsed address is not a web address the app opens: `scheme` when its scheme is neither\n`http:` nor `https:`.","type":"string","enum":["scheme"]};
/** Checks that a value is a {@link WebAddressFault}. */
// prettier-ignore
export const validateWebAddressFault: CompiledSchemaCheck<WebAddressFault> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAddressFault {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWebAddressFault.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWebAddressFault.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data === "scheme")){validateWebAddressFault.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema813.enum}}];return false;}validateWebAddressFault.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
