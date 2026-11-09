/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The provider's own report of its accelerated-output state on one binding.

import { type SchemaCheck, ucs2length } from "../../../schema-check.js";

/**
 * The provider's own report of its accelerated-output state, held for the binding's life from the
 * first declaration the provider makes; absent until then and never stored.
 */
export interface ProviderOutputSpeedState {
  /**
   * The provider's level as sent; a level the driver does not list is kept, not coerced.
   */
  declared: string;
  /**
   * The provider's own explanation, where it gave one.
   */
  reason?: string;
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate1527(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderOutputSpeedState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1527.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.declared === undefined) && (missing0 = "declared")){validate1527.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "declared") || (key0 === "reason"))){validate1527.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.declared !== undefined){let data0: any = data.declared;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validate1527.errors = [{instancePath:instancePath+"/declared",schemaPath:"#/properties/declared/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validate1527.errors = [{instancePath:instancePath+"/declared",schemaPath:"#/properties/declared/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1527.errors = [{instancePath:instancePath+"/declared",schemaPath:"#/properties/declared/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1527.errors = [{instancePath:instancePath+"/declared",schemaPath:"#/properties/declared/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data1: any = data.reason;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 512){validate1527.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/maxLength",keyword:"maxLength",params:{limit: 512}}];return false;}else {if(func1(data1) < 1){validate1527.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1527.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1527.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate1527.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1527.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1527.errors = null as any[] | null;
// prettier-ignore
validate1527.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderOutputSpeedState}. */
export const validateProviderOutputSpeedState: SchemaCheck<ProviderOutputSpeedState> = validate1527;
