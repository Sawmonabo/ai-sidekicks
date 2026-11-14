// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The one tag rule every tagged record follows: what a tag may hold, and how a list of tags holds each tag once.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import type { Tag, TagList } from "../tag.js";

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern842 = new RegExp("^[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+(?:/[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+)*$", "u");
/** Checks that a value is a {@link Tag}. */
// prettier-ignore
export const validateTag: CompiledSchemaCheck<Tag> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is Tag {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTag.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateTag.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern842.test(data)){validateTag.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+(?:/[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+)*$"}}];return false;}}}else {validateTag.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateTag.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
/** Checks that a value is a {@link TagList}. */
// prettier-ignore
export const validateTagList: CompiledSchemaCheck<TagList> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TagList {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTagList.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(Array.isArray(data)){var valid0: any = true;const len0: any = data.length;for(let i0=0; i0<len0; i0++){const _errs1: any = errors;if(!(validateTag.call(this, data[i0], {instancePath:instancePath+"/" + i0,parentData:data,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTag.errors : vErrors.concat(validateTag.errors);errors = vErrors.length;}var valid0: any = _errs1 === errors;if(!valid0){break;}}}else {validateTagList.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "array"}}];return false;}}validateTagList.errors = vErrors;return errors === 0;}, { evaluated: {"items":true,"dynamicProps":false,"dynamicItems":false} as any });
