// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The one tag rule every tagged record follows: what a tag may hold, and how a list of tags holds each tag once.

import { type SchemaCheck, ucs2length } from "../schema-check.js";

/**
 * A tag, nested with /: no whitespace, never empty, and no empty level around a /.
 */
export type Tag = string;
/**
 * Tags, each nested with / and held once ignoring case; no whitespace or empty level.
 */
export type TagList = Tag[];

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern2815 = new RegExp("^[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+(?:/[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+)*$", "u");
// prettier-ignore
function validate2126(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is Tag {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2126.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validate2126.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern2815.test(data)){validate2126.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+(?:/[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+)*$"}}];return false;}}}else {validate2126.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate2126.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2126.errors = null as any[] | null;
// prettier-ignore
validate2126.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2127(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TagList {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2127.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(Array.isArray(data)){var valid0: any = true;const len0: any = data.length;for(let i0=0; i0<len0; i0++){let data0: any = data[i0];const _errs1: any = errors;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 256){validate2127.errors = [{instancePath:instancePath+"/" + i0,schemaPath:"#/$defs/Tag/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern2815.test(data0)){validate2127.errors = [{instancePath:instancePath+"/" + i0,schemaPath:"#/$defs/Tag/pattern",keyword:"pattern",params:{pattern: "^[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+(?:/[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+)*$"}}];return false;}}}else {validate2127.errors = [{instancePath:instancePath+"/" + i0,schemaPath:"#/$defs/Tag/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs1 === errors;if(!valid0){break;}}}else {validate2127.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "array"}}];return false;}}validate2127.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2127.errors = null as any[] | null;
// prettier-ignore
validate2127.evaluated = {"items":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link Tag}. */
export const validateTag: SchemaCheck<Tag> = validate2126;
/** Checks that a value is a {@link TagList}. */
export const validateTagList: SchemaCheck<TagList> = validate2127;
