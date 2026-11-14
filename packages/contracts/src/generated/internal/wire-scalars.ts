// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The scalars every contract module shares: an instant and a calendar date on the wire, a count, the text the daemon composes, text that is not blank, a port and the placeholder a byte member is written as.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";

/**
 * An RFC 3339 instant with its offset, as a peer sent it.
 */
export type WireInstant = string;
/**
 * An ISO 8601 calendar date, `YYYY-MM-DD`, as a peer sent it.
 */
export type WireDate = string;
/**
 * A count of things, or a number of seconds or bytes: a whole number, zero or more.
 */
export type SafeInt0 = number;
/**
 * Text the daemon composed: a path, a provider's words, a name; never empty.
 */
export type ComposedText = string;
/**
 * Text holding at least one character outside ECMAScript's `\s` set; unlike free-form text it
 * may hold a NUL.
 */
export type NonBlankText = string;
/**
 * A TCP port number: a whole number from 1 to 65535.
 */
export type Port = number;
/**
 * Bytes that travel beside the message's JSON, as the attachment the placeholder names.
 */
export type Bytes = Uint8Array;

// prettier-ignore
const pattern4 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
/** Checks that a value is a {@link WireInstant}. */
// prettier-ignore
export const validateWireInstant: CompiledSchemaCheck<WireInstant> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WireInstant {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWireInstant.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validateWireInstant.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validateWireInstant.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWireInstant.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWireInstant.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern614 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))$", "u");
/** Checks that a value is a {@link WireDate}. */
// prettier-ignore
export const validateWireDate: CompiledSchemaCheck<WireDate> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WireDate {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWireDate.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern614.test(data)){validateWireDate.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))$"}}];return false;}}else {validateWireDate.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWireDate.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWireDate.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SafeInt0}. */
// prettier-ignore
export const validateSafeInt0: CompiledSchemaCheck<SafeInt0> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SafeInt0 {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSafeInt0.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validateSafeInt0.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === 0){if((typeof data == "number") && (isFinite(data))){if(data > 9007199254740991 || isNaN(data)){validateSafeInt0.errors = [{instancePath,schemaPath:"#/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data < 0 || isNaN(data)){validateSafeInt0.errors = [{instancePath,schemaPath:"#/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}validateSafeInt0.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSafeInt0.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link ComposedText}. */
// prettier-ignore
export const validateComposedText: CompiledSchemaCheck<ComposedText> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ComposedText {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateComposedText.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validateComposedText.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateComposedText.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateComposedText.errors = vErrors;return errors === 0;};
// prettier-ignore
validateComposedText.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern124 = new RegExp("[^\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]", "u");
/** Checks that a value is a {@link NonBlankText}. */
// prettier-ignore
export const validateNonBlankText: CompiledSchemaCheck<NonBlankText> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is NonBlankText {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateNonBlankText.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern124.test(data)){validateNonBlankText.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "[^\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"}}];return false;}}else {validateNonBlankText.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateNonBlankText.errors = vErrors;return errors === 0;};
// prettier-ignore
validateNonBlankText.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link Port}. */
// prettier-ignore
export const validatePort: CompiledSchemaCheck<Port> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is Port {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePort.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validatePort.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === 0){if((typeof data == "number") && (isFinite(data))){if(data > 65535 || isNaN(data)){validatePort.errors = [{instancePath,schemaPath:"#/maximum",keyword:"maximum",params:{comparison: "<=", limit: 65535}}];return false;}else {if(data < 1 || isNaN(data)){validatePort.errors = [{instancePath,schemaPath:"#/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}validatePort.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePort.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link Bytes}. */
// prettier-ignore
export const validateBytes: CompiledSchemaCheck<Bytes> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is Bytes {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBytes.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.$bytes === undefined) && (missing0 = "$bytes")){validateBytes.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs2: any = errors;for(const key0 in data){if(!(key0 === "$bytes")){validateBytes.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs2 === errors){if(data.$bytes !== undefined){let data0: any = data.$bytes;const _errs3: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateBytes.errors = [{instancePath:instancePath+"/$bytes",schemaPath:"#/properties/%24bytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 4294967295 || isNaN(data0)){validateBytes.errors = [{instancePath:instancePath+"/$bytes",schemaPath:"#/properties/%24bytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295}}];return false;}else {if(data0 < 0 || isNaN(data0)){validateBytes.errors = [{instancePath:instancePath+"/$bytes",schemaPath:"#/properties/%24bytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validateBytes.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBytes.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBytes.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
