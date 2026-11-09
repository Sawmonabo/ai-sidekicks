// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Converting a chat to a project: the request, the copy's outcome, the `session.converted` payload, the read of the files the copy skipped, and the details of a refused or incomplete conversion.

import { type SchemaCheck, ucs2length, wireByteLength } from "../../schema-check.js";
import type { Place } from "../place.js";
import type { RepoMountId } from "../repo/mount.js";
import type { SessionId } from "./id.js";

/**
 * Why one of the workspace's files was not copied.
 */
export type SessionConvertSkipReason =
  | "repositoryHasFile"
  | "repositoryPathNotAFolder"
  | "link"
  | "specialFile";
/**
 * Where the next `session.conversion.skippedFile.list` page starts: base64url without padding,
 * at least one character and at most four for each UTF-16 unit of the longest path. The daemon
 * writes it and owns its format; a client passes it back unchanged with the same session.
 */
export type SessionConvertSkippedFileCursor = string & {
  readonly __brand: "SessionConvertSkippedFileCursor";
};
/**
 * One page of the files a conversion did not copy, in the order of their path keys, split on
 * `hasMore`. A path key is the path's stable bytes compared byte by byte: on macOS and Linux the
 * path's own bytes, on Windows its UTF-16 units as two little-endian bytes each, so the order
 * follows no text collation and a client keeps it as given.
 */
export type SessionConversionSkippedFileListResponse =
  | {
      /**
       * The files, in the order of their path keys.
       *
       * @minItems 1
       * @maxItems 256
       */
      files: [SessionConvertSkippedFile, ...SessionConvertSkippedFile[]];
      /**
       * More files follow.
       */
      hasMore: true;
      /**
       * Where to continue.
       */
      nextCursor: SessionConvertSkippedFileCursor;
    }
  | {
      /**
       * The files, in the order of their path keys.
       *
       * @maxItems 256
       */
      files: SessionConvertSkippedFile[];
      /**
       * No files follow.
       */
      hasMore: false;
    };
/**
 * Why a `session.conversion.refused` refusal turned the convert away; a session that is not a chat
 * is refused with no reason.
 */
export type SessionConversionRefusedReason =
  | "noManagedWorkspace"
  | "idempotencyKeyReused"
  | "conversionUnfinished"
  | "folderInAnotherPlace";

/**
 * Converts a chat to a project. `path` is the folder the person typed; it travels as data and the
 * daemon checks it, reusing the machine's mount for that folder or attaching one, and refusing a
 * folder that is not a git repository. The path is read in the chat's own place: a Linux path in
 * the chat's distribution, a drive path or its `/mnt/<drive>` form on Windows; a folder in another
 * place is refused with `session.conversion.refused`.
 */
export interface SessionConvertRequest {
  /**
   * The chat.
   */
  sessionId: SessionId;
  /**
   * The folder.
   */
  path: string;
  /**
   * The key that makes a repeated convert one conversion.
   */
  clientIdempotencyKey: string;
}
/**
 * One file the conversion did not copy, by its path relative to the workspace, and why.
 */
export interface SessionConvertSkippedFile {
  /**
   * The path; any name the filesystem holds, a name of spaces alone included.
   */
  path: string;
  /**
   * Why it was not copied.
   */
  reason: SessionConvertSkipReason;
}
/**
 * How many of the workspace's files were copied into the repository and how many were not. A
 * file not copied stays in the chat's workspace, which the session keeps, and nothing is merged.
 */
export interface SessionConvertResponse {
  /**
   * Files copied.
   */
  copiedCount: number;
  /**
   * Files not copied, each read with its reason through `session.conversion.skippedFile.list`.
   */
  skippedCount: number;
}
/**
 * The `session.converted` payload: the project the chat became, and the copy's outcome.
 */
export interface SessionConvertedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The repository it now works in.
   */
  repoMountId: RepoMountId;
  /**
   * Files copied.
   */
  copiedCount: number;
  /**
   * Files not copied.
   */
  skippedCount: number;
}
/**
 * The `session.conversion.skippedFile.list` input: the converted session and, past the first page,
 * the previous page's `nextCursor`.
 */
export interface SessionConversionSkippedFileListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Continue from this cursor.
   */
  afterCursor?: SessionConvertSkippedFileCursor;
  /**
   * The most files on one page; the default is the most.
   */
  limit?: number;
}
/**
 * The details of a `session.conversion.refused` refusal: its reason, the mount of the stopped
 * conversion a `conversionUnfinished` names, and the chat's place a `folderInAnotherPlace` names.
 */
export interface SessionConversionRefusedDetails {
  /**
   * Why; absent for a session that is not a chat.
   */
  reason?: SessionConversionRefusedReason;
  /**
   * The mount the stopped conversion copies into.
   */
  repoMountId?: RepoMountId;
  /**
   * The chat's place.
   */
  place?: Place;
}
/**
 * The details of a `session.conversion.incomplete` failure: what the conversion did before it
 * stopped. The session still reads as a chat.
 */
export interface SessionConversionIncompleteDetails {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The mount the repository is attached as.
   */
  repoMountId: RepoMountId;
  /**
   * Files copied into it so far.
   */
  copiedCount: number;
  /**
   * Files not copied so far.
   */
  skippedCount: number;
  /**
   * Whether the session was bound to the project.
   */
  isBound: boolean;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern2640 = new RegExp("^[A-Za-z0-9_-]+$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1858(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionConversionSkippedFileListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1858.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1858.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "afterCursor")) || (key0 === "limit"))){validate1858.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1858.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1858.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.afterCursor !== undefined){let data1: any = data.afterCursor;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 16384){validate1858.errors = [{instancePath:instancePath+"/afterCursor",schemaPath:"#/$defs/SessionConvertSkippedFileCursor/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(!pattern2640.test(data1)){validate1858.errors = [{instancePath:instancePath+"/afterCursor",schemaPath:"#/$defs/SessionConvertSkippedFileCursor/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9_-]+$"}}];return false;}}}else {validate1858.errors = [{instancePath:instancePath+"/afterCursor",schemaPath:"#/$defs/SessionConvertSkippedFileCursor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.limit !== undefined){let data2: any = data.limit;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1858.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 256 || isNaN(data2)){validate1858.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/maximum",keyword:"maximum",params:{comparison: "<=", limit: 256}}];return false;}else {if(data2 < 1 || isNaN(data2)){validate1858.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1858.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1858.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1858.errors = null as any[] | null;
// prettier-ignore
validate1858.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3717: any = {"description":"Why one of the workspace's files was not copied.","type":"string","enum":["repositoryHasFile","repositoryPathNotAFolder","link","specialFile"]};
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate1860(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1860.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.path === undefined) && (missing0 = "path")) || ((data.reason === undefined) && (missing0 = "reason"))){validate1860.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "path") || (key0 === "reason"))){validate1860.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.path !== undefined){let data0: any = data.path;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate1860.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validate1860.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data0)){validate1860.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1860.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data1: any = data.reason;const _errs4: any = errors;if(typeof data1 !== "string"){validate1860.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/SessionConvertSkipReason/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data1 === "repositoryHasFile") || (data1 === "repositoryPathNotAFolder")) || (data1 === "link")) || (data1 === "specialFile"))){validate1860.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/SessionConvertSkipReason/enum",keyword:"enum",params:{allowedValues: schema3717.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate1860.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1860.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1860.errors = null as any[] | null;
// prettier-ignore
validate1860.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1859(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionConversionSkippedFileListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1859.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.files === undefined) && (missing0 = "files")) || ((data.hasMore === undefined) && (missing0 = "hasMore"))) || ((data.nextCursor === undefined) && (missing0 = "nextCursor"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(((key0 === "files") || (key0 === "hasMore")) || (key0 === "nextCursor"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.files !== undefined){let data0: any = data.files;const _errs4: any = errors;if(wireByteLength(data0, this && this.attachments) > 991808){const err2: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/0/properties/files/maxJsonBytes",keyword:"maxJsonBytes",params:{}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(errors === _errs4){if(Array.isArray(data0)){if(data0.length > 256){const err3: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/0/properties/files/maxItems",keyword:"maxItems",params:{limit: 256}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(data0.length < 1){const err4: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/0/properties/files/minItems",keyword:"minItems",params:{limit: 1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}else {var valid2: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs6: any = errors;if(!(validate1860.call(this, data0[i0], {instancePath:instancePath+"/files/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1860.errors : vErrors.concat(validate1860.errors);errors = vErrors.length;}var valid2: any = _errs6 === errors;if(!valid2){break;}}}}}else {const err5: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/0/properties/files/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.hasMore !== undefined){let data2: any = data.hasMore;const _errs7: any = errors;if(typeof data2 !== "boolean"){const err6: any = {instancePath:instancePath+"/hasMore",schemaPath:"#/anyOf/0/properties/hasMore/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}if(true !== data2){const err7: any = {instancePath:instancePath+"/hasMore",schemaPath:"#/anyOf/0/properties/hasMore/const",keyword:"const",params:{allowedValue: true}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}var valid1: any = _errs7 === errors;}else {var valid1: any = true;}if(valid1){if(data.nextCursor !== undefined){let data3: any = data.nextCursor;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) > 16384){const err8: any = {instancePath:instancePath+"/nextCursor",schemaPath:"#/$defs/SessionConvertSkippedFileCursor/maxLength",keyword:"maxLength",params:{limit: 16384}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}else {if(!pattern2640.test(data3)){const err9: any = {instancePath:instancePath+"/nextCursor",schemaPath:"#/$defs/SessionConvertSkippedFileCursor/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9_-]+$"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}}else {const err10: any = {instancePath:instancePath+"/nextCursor",schemaPath:"#/$defs/SessionConvertSkippedFileCursor/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}var valid1: any = _errs9 === errors;}else {var valid1: any = true;}}}}}}else {const err11: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs13: any = errors;if(errors === _errs13){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.files === undefined) && (missing1 = "files")) || ((data.hasMore === undefined) && (missing1 = "hasMore"))){const err12: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}else {const _errs15: any = errors;for(const key1 in data){if(!((key1 === "files") || (key1 === "hasMore"))){const err13: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;break;}}if(_errs15 === errors){if(data.files !== undefined){let data4: any = data.files;const _errs16: any = errors;if(wireByteLength(data4, this && this.attachments) > 991808){const err14: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/1/properties/files/maxJsonBytes",keyword:"maxJsonBytes",params:{}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}if(errors === _errs16){if(Array.isArray(data4)){if(data4.length > 256){const err15: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/1/properties/files/maxItems",keyword:"maxItems",params:{limit: 256}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}else {var valid5: any = true;const len1: any = data4.length;for(let i1=0; i1<len1; i1++){const _errs18: any = errors;if(!(validate1860.call(this, data4[i1], {instancePath:instancePath+"/files/" + i1,parentData:data4,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1860.errors : vErrors.concat(validate1860.errors);errors = vErrors.length;}var valid5: any = _errs18 === errors;if(!valid5){break;}}}}else {const err16: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/1/properties/files/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}if(valid4){if(data.hasMore !== undefined){let data6: any = data.hasMore;const _errs19: any = errors;if(typeof data6 !== "boolean"){const err17: any = {instancePath:instancePath+"/hasMore",schemaPath:"#/anyOf/1/properties/hasMore/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}if(false !== data6){const err18: any = {instancePath:instancePath+"/hasMore",schemaPath:"#/anyOf/1/properties/hasMore/const",keyword:"const",params:{allowedValue: false}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}var valid4: any = _errs19 === errors;}else {var valid4: any = true;}}}}}else {const err19: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}}var _valid0: any = _errs13 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err20: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;validate1859.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1859.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1859.errors = null as any[] | null;
// prettier-ignore
validate1859.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const pattern222 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
function validate1863(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionConvertRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1863.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.path === undefined) && (missing0 = "path"))) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validate1863.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "path")) || (key0 === "clientIdempotencyKey"))){validate1863.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1863.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1863.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1863.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate1863.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data1)){validate1863.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1863.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data2: any = data.clientIdempotencyKey;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(!pattern222.test(data2)){validate1863.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate1863.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1863.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1863.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1863.errors = null as any[] | null;
// prettier-ignore
validate1863.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1864(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionConvertResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1864.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.copiedCount === undefined) && (missing0 = "copiedCount")) || ((data.skippedCount === undefined) && (missing0 = "skippedCount"))){validate1864.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "copiedCount") || (key0 === "skippedCount"))){validate1864.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.copiedCount !== undefined){let data0: any = data.copiedCount;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate1864.errors = [{instancePath:instancePath+"/copiedCount",schemaPath:"#/properties/copiedCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate1864.errors = [{instancePath:instancePath+"/copiedCount",schemaPath:"#/properties/copiedCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validate1864.errors = [{instancePath:instancePath+"/copiedCount",schemaPath:"#/properties/copiedCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.skippedCount !== undefined){let data1: any = data.skippedCount;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1864.errors = [{instancePath:instancePath+"/skippedCount",schemaPath:"#/properties/skippedCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1864.errors = [{instancePath:instancePath+"/skippedCount",schemaPath:"#/properties/skippedCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate1864.errors = [{instancePath:instancePath+"/skippedCount",schemaPath:"#/properties/skippedCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate1864.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1864.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1864.errors = null as any[] | null;
// prettier-ignore
validate1864.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1865(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionConvertedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1865.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.repoMountId === undefined) && (missing0 = "repoMountId"))) || ((data.copiedCount === undefined) && (missing0 = "copiedCount"))) || ((data.skippedCount === undefined) && (missing0 = "skippedCount"))){validate1865.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "repoMountId")) || (key0 === "copiedCount")) || (key0 === "skippedCount"))){validate1865.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1865.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1865.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repoMountId !== undefined){let data1: any = data.repoMountId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1865.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1865.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.copiedCount !== undefined){let data2: any = data.copiedCount;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1865.errors = [{instancePath:instancePath+"/copiedCount",schemaPath:"#/properties/copiedCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1865.errors = [{instancePath:instancePath+"/copiedCount",schemaPath:"#/properties/copiedCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1865.errors = [{instancePath:instancePath+"/copiedCount",schemaPath:"#/properties/copiedCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.skippedCount !== undefined){let data3: any = data.skippedCount;const _errs12: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1865.errors = [{instancePath:instancePath+"/skippedCount",schemaPath:"#/properties/skippedCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1865.errors = [{instancePath:instancePath+"/skippedCount",schemaPath:"#/properties/skippedCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1865.errors = [{instancePath:instancePath+"/skippedCount",schemaPath:"#/properties/skippedCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}else {validate1865.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1865.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1865.errors = null as any[] | null;
// prettier-ignore
validate1865.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionConversionSkippedFileListRequest}. */
export const validateSessionConversionSkippedFileListRequest: SchemaCheck<SessionConversionSkippedFileListRequest> =
  validate1858;
/** Checks that a value is a {@link SessionConversionSkippedFileListResponse}. */
export const validateSessionConversionSkippedFileListResponse: SchemaCheck<SessionConversionSkippedFileListResponse> =
  validate1859;
/** Checks that a value is a {@link SessionConvertRequest}. */
export const validateSessionConvertRequest: SchemaCheck<SessionConvertRequest> = validate1863;
/** Checks that a value is a {@link SessionConvertResponse}. */
export const validateSessionConvertResponse: SchemaCheck<SessionConvertResponse> = validate1864;
/** Checks that a value is a {@link SessionConvertedPayload}. */
export const validateSessionConvertedPayload: SchemaCheck<SessionConvertedPayload> = validate1865;
