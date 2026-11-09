// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The scalars the git modules share.

import { SCHEMA_FORMATS, type SchemaCheck } from "../../schema-check.js";

/**
 * A commit's short id, git's own abbreviation, which is as long as the repository needs.
 */
export type GitShortObjectId = string;
/**
 * An id the hosting service minted (a thread, a comment, a check), opaque to every client.
 */
export type HostHandle = string & { readonly __brand: "HostHandle" };
/**
 * A change request's number on its host: `#482` on GitHub, `!482` on GitLab.
 */
export type ChangeRequestNumber = number;
/**
 * An `http:` or `https:` address on the hosting service, written with its `//` and opened in
 * the system browser.
 */
export type HostingAddress = string;

// prettier-ignore
function validate1004(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ChangeRequestNumber {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1004.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validate1004.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === 0){if((typeof data == "number") && (isFinite(data))){if(data > 9007199254740991 || isNaN(data)){validate1004.errors = [{instancePath,schemaPath:"#/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data < 1 || isNaN(data)){validate1004.errors = [{instancePath,schemaPath:"#/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}validate1004.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1004.errors = null as any[] | null;
// prettier-ignore
validate1004.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern1171 = new RegExp("^[0-9a-f]{4,64}$", "u");
// prettier-ignore
function validate1005(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitShortObjectId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1005.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern1171.test(data)){validate1005.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{4,64}$"}}];return false;}}else {validate1005.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1005.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1005.errors = null as any[] | null;
// prettier-ignore
validate1005.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const formats18 = SCHEMA_FORMATS["web-url"];
// prettier-ignore
const pattern738 = new RegExp("^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*[hH][tT][tT][pP][sS]?://", "u");
// prettier-ignore
function validate1006(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is HostingAddress {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1006.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(errors === 0){if(typeof data === "string"){if(!pattern738.test(data)){validate1006.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*[hH][tT][tT][pP][sS]?://"}}];return false;}else {if(!(formats18(data))){validate1006.errors = [{instancePath,schemaPath:"#/format",keyword:"format",params:{format: "web-url"}}];return false;}}}else {validate1006.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}}validate1006.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1006.errors = null as any[] | null;
// prettier-ignore
validate1006.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ChangeRequestNumber}. */
export const validateChangeRequestNumber: SchemaCheck<ChangeRequestNumber> = validate1004;
/** Checks that a value is a {@link GitShortObjectId}. */
export const validateGitShortObjectId: SchemaCheck<GitShortObjectId> = validate1005;
/** Checks that a value is a {@link HostingAddress}. */
export const validateHostingAddress: SchemaCheck<HostingAddress> = validate1006;
