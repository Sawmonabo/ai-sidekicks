// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Why this machine's keychain could not be used: the one cause a refused seal or erase carries.

import type { CompiledSchemaCheck } from "../../schema-check.js";
import type { KeychainRefusalCause } from "../keychain.js";

// prettier-ignore
const schema156: any = {"description":"Why this machine's keychain could not be used: it is `locked`, or it cannot be used now or at\nall (`unavailable`). A secret that cannot be sealed is refused and stored nowhere else.","type":"string","enum":["locked","unavailable"]};
/** Checks that a value is a {@link KeychainRefusalCause}. */
// prettier-ignore
export const validateKeychainRefusalCause: CompiledSchemaCheck<KeychainRefusalCause> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is KeychainRefusalCause {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateKeychainRefusalCause.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateKeychainRefusalCause.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "locked") || (data === "unavailable"))){validateKeychainRefusalCause.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema156.enum}}];return false;}validateKeychainRefusalCause.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
