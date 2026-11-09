// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The scalars every contract module shares: an instant and a calendar date on the wire, a count, the text the daemon composes, text that is not blank, a port and the placeholder a byte member is written as.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";

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
const func1 = ucs2length;
// prettier-ignore
function validate1013(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ComposedText {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1013.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validate1013.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1013.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1013.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1013.errors = null as any[] | null;
// prettier-ignore
validate1013.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1014(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SafeInt0 {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1014.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validate1014.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === 0){if((typeof data == "number") && (isFinite(data))){if(data > 9007199254740991 || isNaN(data)){validate1014.errors = [{instancePath,schemaPath:"#/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data < 0 || isNaN(data)){validate1014.errors = [{instancePath,schemaPath:"#/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}validate1014.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1014.errors = null as any[] | null;
// prettier-ignore
validate1014.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate1015(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WireInstant {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1015.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern5.test(data)){validate1015.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1015.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1015.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1015.errors = null as any[] | null;
// prettier-ignore
validate1015.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ComposedText}. */
export const validateComposedText: SchemaCheck<ComposedText> = validate1013;
/** Checks that a value is a {@link SafeInt0}. */
export const validateSafeInt0: SchemaCheck<SafeInt0> = validate1014;
/** Checks that a value is a {@link WireInstant}. */
export const validateWireInstant: SchemaCheck<WireInstant> = validate1015;
