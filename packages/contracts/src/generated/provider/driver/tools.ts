// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The tools a driver declares and the daemon offers: each tool's metadata and idempotency class, and the callback tools the daemon serves the model.

import { type SchemaCheck, ucs2length } from "../../../schema-check.js";

/** Every idempotency class, safest to repeat first. */
export const IDEMPOTENCY_CLASSES = ["idempotent", "compensable", "manualReconcileOnly"] as const;

/**
 * A tool's declared idempotency: safe to repeat, undoable, or needing a person to reconcile. A
 * daemon restart runs no call again, whatever its class.
 */
export type IdempotencyClass = "idempotent" | "compensable" | "manualReconcileOnly";

/**
 * A tool a driver declares. An undeclared class reads as `manualReconcileOnly`, and unknown
 * members are dropped rather than refused, because providers extend the declaration.
 */
export interface ProviderToolMetadata {
  /**
   * The tool's name.
   */
  name: string;
  /**
   * The tool's idempotency.
   */
  idempotency_class?: IdempotencyClass;
  /**
   * The tool's description.
   */
  description?: string;
}
/**
 * A tool the daemon offers the model: a name, a description and a JSON Schema input. Every call
 * goes through the daemon's approval pipeline and lands as an ordinary tool activity row.
 */
export interface SessionCallbackTool {
  /**
   * The tool's name.
   */
  name: string;
  /**
   * What the tool does, for the model.
   */
  description: string;
  /**
   * The tool's input as a JSON Schema.
   */
  inputSchema: {
    [k: string]: unknown | undefined;
  };
}

// prettier-ignore
const schema2881: any = {"description":"A tool's declared idempotency: safe to repeat, undoable, or needing a person to reconcile. A\ndaemon restart runs no call again, whatever its class.","type":"string","enum":["idempotent","compensable","manualReconcileOnly"]};
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate1531(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderToolMetadata {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1531.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.name === undefined) && (missing0 = "name")){validate1531.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {if(data.name !== undefined){let data0: any = data.name;const _errs1: any = errors;if(errors === _errs1){if(typeof data0 === "string"){if(func1(data0) > 128){validate1531.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validate1531.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1531.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1531.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs1 === errors;}else {var valid0: any = true;}if(valid0){if(data.idempotency_class !== undefined){let data1: any = data.idempotency_class;const _errs3: any = errors;if(typeof data1 !== "string"){validate1531.errors = [{instancePath:instancePath+"/idempotency_class",schemaPath:"#/$defs/IdempotencyClass/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data1 === "idempotent") || (data1 === "compensable")) || (data1 === "manualReconcileOnly"))){validate1531.errors = [{instancePath:instancePath+"/idempotency_class",schemaPath:"#/$defs/IdempotencyClass/enum",keyword:"enum",params:{allowedValues: schema2881.enum}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){let data2: any = data.description;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) > 16384){validate1531.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data2) < 1){validate1531.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1531.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1531.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1531.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1531.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1531.errors = null as any[] | null;
// prettier-ignore
validate1531.evaluated = {"props":{"name":true,"idempotency_class":true,"description":true},"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderToolMetadata}. */
export const validateProviderToolMetadata: SchemaCheck<ProviderToolMetadata> = validate1531;
