// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The account's trust, as every machine verifies it: the identity and channel keys, who signed, and the append-only chain of signed statements the control plane keeps and serves.
//
// Trust is the chain, not the control plane. Every machine checks each statement itself and trusts a key only when a path of statements reaches it from its own machine key, so every request that changes who is trusted carries a statement signed by one of the person's own keys rather than asking the control plane to decide.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import type { DeviceId } from "../trust-statement.js";

// prettier-ignore
const func2 = ucs2length;
// prettier-ignore
const pattern7 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link DeviceId}. */
// prettier-ignore
export const validateDeviceId: CompiledSchemaCheck<DeviceId> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func2(data) > 256){validateDeviceId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern7.test(data)){validateDeviceId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateDeviceId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateDeviceId.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
