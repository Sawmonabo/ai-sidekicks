// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The scalars the git modules share.

import { type CompiledSchemaCheck, SCHEMA_FORMATS, ucs2length } from "../../../schema-check.js";
import type {
  ChangeRequestNumber,
  GitShortObjectId,
  HostHandle,
  HostingAddress,
} from "../../git/shared.js";

// prettier-ignore
const pattern359 = new RegExp("^[0-9a-f]{4,64}$", "u");
/** Checks that a value is a {@link GitShortObjectId}. */
// prettier-ignore
export const validateGitShortObjectId: CompiledSchemaCheck<GitShortObjectId> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitShortObjectId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateGitShortObjectId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern359.test(data)){validateGitShortObjectId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{4,64}$"}}];return false;}}else {validateGitShortObjectId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateGitShortObjectId.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link HostHandle}. */
// prettier-ignore
export const validateHostHandle: CompiledSchemaCheck<HostHandle> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is HostHandle {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateHostHandle.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validateHostHandle.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateHostHandle.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateHostHandle.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
/** Checks that a value is a {@link ChangeRequestNumber}. */
// prettier-ignore
export const validateChangeRequestNumber: CompiledSchemaCheck<ChangeRequestNumber> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ChangeRequestNumber {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateChangeRequestNumber.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validateChangeRequestNumber.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === 0){if((typeof data == "number") && (isFinite(data))){if(data > 9007199254740991 || isNaN(data)){validateChangeRequestNumber.errors = [{instancePath,schemaPath:"#/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data < 1 || isNaN(data)){validateChangeRequestNumber.errors = [{instancePath,schemaPath:"#/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}validateChangeRequestNumber.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
// prettier-ignore
const formats8 = SCHEMA_FORMATS["web-url"];
// prettier-ignore
const pattern264 = new RegExp("^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*[hH][tT][tT][pP][sS]?://", "u");
/** Checks that a value is a {@link HostingAddress}. */
// prettier-ignore
export const validateHostingAddress: CompiledSchemaCheck<HostingAddress> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is HostingAddress {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateHostingAddress.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(errors === 0){if(typeof data === "string"){if(!pattern264.test(data)){validateHostingAddress.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*[hH][tT][tT][pP][sS]?://"}}];return false;}else {if(!(formats8(data))){validateHostingAddress.errors = [{instancePath,schemaPath:"#/format",keyword:"format",params:{format: "web-url"}}];return false;}}}else {validateHostingAddress.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}}validateHostingAddress.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
