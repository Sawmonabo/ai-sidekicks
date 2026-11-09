// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The relay's sign-in-route limit as a device reads it: the body of a 429 refusal, and the code a sign-in route refuses with when the relay cannot tell which address a request came from.

import type { SchemaCheck } from "../schema-check.js";
import type { WireInstant } from "./internal/wire-scalars.js";

/** The code every 429 refusal of a sign-in route carries. */
export const RELAY_RATE_LIMITED_CODE = "relay.rateLimited" as const;

/**
 * The code of the 400 a sign-in route answers when the request carries no source address the
 * relay can count, so it is refused rather than counted in a bucket other callers share.
 */
export const RELAY_SOURCE_ADDRESS_UNRESOLVABLE_CODE = "relay.sourceAddressUnresolvable" as const;

/**
 * The body of a 429 from a sign-in route. `retryAfter` is whole seconds until a retry is allowed,
 * the same value as the `Retry-After` header; `resetAt` is the instant the oldest counted request
 * leaves the window, when the next request is admitted.
 */
export interface RateLimitResponse {
  /**
   * Always `relay.rateLimited`.
   */
  code: "relay.rateLimited";
  /**
   * Always `resourceExhausted`.
   */
  category: "resourceExhausted";
  /**
   * A sentence for a person.
   */
  message: string;
  /**
   * Whole seconds until a retry is allowed.
   */
  retryAfter: number;
  /**
   * The requests the window admits.
   */
  limit: number;
  /**
   * The requests the window still admits.
   */
  remaining: number;
  /**
   * When the oldest counted request leaves the window.
   */
  resetAt: WireInstant;
}

// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate1615(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RateLimitResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1615.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.code === undefined) && (missing0 = "code")) || ((data.category === undefined) && (missing0 = "category"))) || ((data.message === undefined) && (missing0 = "message"))) || ((data.retryAfter === undefined) && (missing0 = "retryAfter"))) || ((data.limit === undefined) && (missing0 = "limit"))) || ((data.remaining === undefined) && (missing0 = "remaining"))) || ((data.resetAt === undefined) && (missing0 = "resetAt"))){validate1615.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "code") || (key0 === "category")) || (key0 === "message")) || (key0 === "retryAfter")) || (key0 === "limit")) || (key0 === "remaining")) || (key0 === "resetAt"))){validate1615.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.code !== undefined){let data0: any = data.code;const _errs2: any = errors;if(typeof data0 !== "string"){validate1615.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/type",keyword:"type",params:{type: "string"}}];return false;}if("relay.rateLimited" !== data0){validate1615.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/const",keyword:"const",params:{allowedValue: "relay.rateLimited"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.category !== undefined){let data1: any = data.category;const _errs4: any = errors;if(typeof data1 !== "string"){validate1615.errors = [{instancePath:instancePath+"/category",schemaPath:"#/properties/category/type",keyword:"type",params:{type: "string"}}];return false;}if("resourceExhausted" !== data1){validate1615.errors = [{instancePath:instancePath+"/category",schemaPath:"#/properties/category/const",keyword:"const",params:{allowedValue: "resourceExhausted"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.message !== undefined){const _errs6: any = errors;if(typeof data.message !== "string"){validate1615.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.retryAfter !== undefined){let data3: any = data.retryAfter;const _errs8: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1615.errors = [{instancePath:instancePath+"/retryAfter",schemaPath:"#/properties/retryAfter/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1615.errors = [{instancePath:instancePath+"/retryAfter",schemaPath:"#/properties/retryAfter/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1615.errors = [{instancePath:instancePath+"/retryAfter",schemaPath:"#/properties/retryAfter/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.limit !== undefined){let data4: any = data.limit;const _errs10: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate1615.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate1615.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validate1615.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.remaining !== undefined){let data5: any = data.remaining;const _errs12: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate1615.errors = [{instancePath:instancePath+"/remaining",schemaPath:"#/properties/remaining/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate1615.errors = [{instancePath:instancePath+"/remaining",schemaPath:"#/properties/remaining/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validate1615.errors = [{instancePath:instancePath+"/remaining",schemaPath:"#/properties/remaining/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.resetAt !== undefined){let data6: any = data.resetAt;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data6 === "string"){if(!pattern5.test(data6)){validate1615.errors = [{instancePath:instancePath+"/resetAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1615.errors = [{instancePath:instancePath+"/resetAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validate1615.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1615.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1615.errors = null as any[] | null;
// prettier-ignore
validate1615.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RateLimitResponse}. */
export const validateRateLimitResponse: SchemaCheck<RateLimitResponse> = validate1615;
