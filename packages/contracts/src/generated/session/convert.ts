// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Converting a chat to a project: the request, the copy's outcome, the `session.converted` payload, the read of the files the copy skipped, and the details of a refused or incomplete conversion.

import { type CompiledSchemaCheck, ucs2length, wireByteLength } from "../../schema-check.js";
import type { Place } from "../place.js";
import { type RepoMountId, validateRepoMountId } from "../repo/mount.js";
import { type SessionId, validateSessionId } from "./id.js";

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
const func1 = ucs2length;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const pattern88 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
/** Checks that a value is a {@link SessionConvertRequest}. */
// prettier-ignore
export const validateSessionConvertRequest: CompiledSchemaCheck<SessionConvertRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionConvertRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionConvertRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.path === undefined) && (missing0 = "path"))) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validateSessionConvertRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "path")) || (key0 === "clientIdempotencyKey"))){validateSessionConvertRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 4096){validateSessionConvertRequest.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validateSessionConvertRequest.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data1)){validateSessionConvertRequest.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateSessionConvertRequest.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data2: any = data.clientIdempotencyKey;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(!pattern88.test(data2)){validateSessionConvertRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateSessionConvertRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionConvertRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionConvertRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionConvertRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1163: any = {"description":"Why one of the workspace's files was not copied.","type":"string","enum":["repositoryHasFile","repositoryPathNotAFolder","link","specialFile"]};
/** Checks that a value is a {@link SessionConvertSkipReason}. */
// prettier-ignore
export const validateSessionConvertSkipReason: CompiledSchemaCheck<SessionConvertSkipReason> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionConvertSkipReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionConvertSkipReason.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateSessionConvertSkipReason.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "repositoryHasFile") || (data === "repositoryPathNotAFolder")) || (data === "link")) || (data === "specialFile"))){validateSessionConvertSkipReason.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1163.enum}}];return false;}validateSessionConvertSkipReason.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionConvertSkipReason.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionConvertSkippedFile}. */
// prettier-ignore
export const validateSessionConvertSkippedFile: CompiledSchemaCheck<SessionConvertSkippedFile> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionConvertSkippedFile {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionConvertSkippedFile.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.path === undefined) && (missing0 = "path")) || ((data.reason === undefined) && (missing0 = "reason"))){validateSessionConvertSkippedFile.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "path") || (key0 === "reason"))){validateSessionConvertSkippedFile.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.path !== undefined){let data0: any = data.path;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validateSessionConvertSkippedFile.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validateSessionConvertSkippedFile.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data0)){validateSessionConvertSkippedFile.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateSessionConvertSkippedFile.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){const _errs4: any = errors;if(!(validateSessionConvertSkipReason.call(this, data.reason, {instancePath:instancePath+"/reason",parentData:data,parentDataProperty:"reason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionConvertSkipReason.errors : vErrors.concat(validateSessionConvertSkipReason.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateSessionConvertSkippedFile.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionConvertSkippedFile.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionConvertSkippedFile.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionConvertResponse}. */
// prettier-ignore
export const validateSessionConvertResponse: CompiledSchemaCheck<SessionConvertResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionConvertResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionConvertResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.copiedCount === undefined) && (missing0 = "copiedCount")) || ((data.skippedCount === undefined) && (missing0 = "skippedCount"))){validateSessionConvertResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "copiedCount") || (key0 === "skippedCount"))){validateSessionConvertResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.copiedCount !== undefined){let data0: any = data.copiedCount;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateSessionConvertResponse.errors = [{instancePath:instancePath+"/copiedCount",schemaPath:"#/properties/copiedCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateSessionConvertResponse.errors = [{instancePath:instancePath+"/copiedCount",schemaPath:"#/properties/copiedCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validateSessionConvertResponse.errors = [{instancePath:instancePath+"/copiedCount",schemaPath:"#/properties/copiedCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.skippedCount !== undefined){let data1: any = data.skippedCount;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateSessionConvertResponse.errors = [{instancePath:instancePath+"/skippedCount",schemaPath:"#/properties/skippedCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateSessionConvertResponse.errors = [{instancePath:instancePath+"/skippedCount",schemaPath:"#/properties/skippedCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateSessionConvertResponse.errors = [{instancePath:instancePath+"/skippedCount",schemaPath:"#/properties/skippedCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateSessionConvertResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionConvertResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionConvertResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionConvertedPayload}. */
// prettier-ignore
export const validateSessionConvertedPayload: CompiledSchemaCheck<SessionConvertedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionConvertedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionConvertedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.repoMountId === undefined) && (missing0 = "repoMountId"))) || ((data.copiedCount === undefined) && (missing0 = "copiedCount"))) || ((data.skippedCount === undefined) && (missing0 = "skippedCount"))){validateSessionConvertedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "repoMountId")) || (key0 === "copiedCount")) || (key0 === "skippedCount"))){validateSessionConvertedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repoMountId !== undefined){const _errs3: any = errors;if(!(validateRepoMountId.call(this, data.repoMountId, {instancePath:instancePath+"/repoMountId",parentData:data,parentDataProperty:"repoMountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRepoMountId.errors : vErrors.concat(validateRepoMountId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.copiedCount !== undefined){let data2: any = data.copiedCount;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateSessionConvertedPayload.errors = [{instancePath:instancePath+"/copiedCount",schemaPath:"#/properties/copiedCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateSessionConvertedPayload.errors = [{instancePath:instancePath+"/copiedCount",schemaPath:"#/properties/copiedCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateSessionConvertedPayload.errors = [{instancePath:instancePath+"/copiedCount",schemaPath:"#/properties/copiedCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.skippedCount !== undefined){let data3: any = data.skippedCount;const _errs6: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateSessionConvertedPayload.errors = [{instancePath:instancePath+"/skippedCount",schemaPath:"#/properties/skippedCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateSessionConvertedPayload.errors = [{instancePath:instancePath+"/skippedCount",schemaPath:"#/properties/skippedCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateSessionConvertedPayload.errors = [{instancePath:instancePath+"/skippedCount",schemaPath:"#/properties/skippedCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateSessionConvertedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionConvertedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionConvertedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern789 = new RegExp("^[A-Za-z0-9_-]+$", "u");
/** Checks that a value is a {@link SessionConvertSkippedFileCursor}. */
// prettier-ignore
export const validateSessionConvertSkippedFileCursor: CompiledSchemaCheck<SessionConvertSkippedFileCursor> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionConvertSkippedFileCursor {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionConvertSkippedFileCursor.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 16384){validateSessionConvertSkippedFileCursor.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(!pattern789.test(data)){validateSessionConvertSkippedFileCursor.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9_-]+$"}}];return false;}}}else {validateSessionConvertSkippedFileCursor.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateSessionConvertSkippedFileCursor.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionConvertSkippedFileCursor.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionConversionSkippedFileListRequest}. */
// prettier-ignore
export const validateSessionConversionSkippedFileListRequest: CompiledSchemaCheck<SessionConversionSkippedFileListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionConversionSkippedFileListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionConversionSkippedFileListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateSessionConversionSkippedFileListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "afterCursor")) || (key0 === "limit"))){validateSessionConversionSkippedFileListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.afterCursor !== undefined){const _errs3: any = errors;if(!(validateSessionConvertSkippedFileCursor.call(this, data.afterCursor, {instancePath:instancePath+"/afterCursor",parentData:data,parentDataProperty:"afterCursor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionConvertSkippedFileCursor.errors : vErrors.concat(validateSessionConvertSkippedFileCursor.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.limit !== undefined){let data2: any = data.limit;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateSessionConversionSkippedFileListRequest.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 256 || isNaN(data2)){validateSessionConversionSkippedFileListRequest.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/maximum",keyword:"maximum",params:{comparison: "<=", limit: 256}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateSessionConversionSkippedFileListRequest.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionConversionSkippedFileListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionConversionSkippedFileListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionConversionSkippedFileListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionConversionSkippedFileListResponse}. */
// prettier-ignore
export const validateSessionConversionSkippedFileListResponse: CompiledSchemaCheck<SessionConversionSkippedFileListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionConversionSkippedFileListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionConversionSkippedFileListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.files === undefined) && (missing0 = "files")) || ((data.hasMore === undefined) && (missing0 = "hasMore"))) || ((data.nextCursor === undefined) && (missing0 = "nextCursor"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(((key0 === "files") || (key0 === "hasMore")) || (key0 === "nextCursor"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.files !== undefined){let data0: any = data.files;const _errs4: any = errors;if(wireByteLength(data0, this && this.attachments) > 991808){const err2: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/0/properties/files/maxJsonBytes",keyword:"maxJsonBytes",params:{}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(errors === _errs4){if(Array.isArray(data0)){if(data0.length > 256){const err3: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/0/properties/files/maxItems",keyword:"maxItems",params:{limit: 256}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(data0.length < 1){const err4: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/0/properties/files/minItems",keyword:"minItems",params:{limit: 1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}else {var valid2: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs6: any = errors;if(!(validateSessionConvertSkippedFile.call(this, data0[i0], {instancePath:instancePath+"/files/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionConvertSkippedFile.errors : vErrors.concat(validateSessionConvertSkippedFile.errors);errors = vErrors.length;}var valid2: any = _errs6 === errors;if(!valid2){break;}}}}}else {const err5: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/0/properties/files/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.hasMore !== undefined){let data2: any = data.hasMore;const _errs7: any = errors;if(typeof data2 !== "boolean"){const err6: any = {instancePath:instancePath+"/hasMore",schemaPath:"#/anyOf/0/properties/hasMore/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}if(true !== data2){const err7: any = {instancePath:instancePath+"/hasMore",schemaPath:"#/anyOf/0/properties/hasMore/const",keyword:"const",params:{allowedValue: true}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}var valid1: any = _errs7 === errors;}else {var valid1: any = true;}if(valid1){if(data.nextCursor !== undefined){const _errs9: any = errors;if(!(validateSessionConvertSkippedFileCursor.call(this, data.nextCursor, {instancePath:instancePath+"/nextCursor",parentData:data,parentDataProperty:"nextCursor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionConvertSkippedFileCursor.errors : vErrors.concat(validateSessionConvertSkippedFileCursor.errors);errors = vErrors.length;}var valid1: any = _errs9 === errors;}else {var valid1: any = true;}}}}}}else {const err8: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs10: any = errors;if(errors === _errs10){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.files === undefined) && (missing1 = "files")) || ((data.hasMore === undefined) && (missing1 = "hasMore"))){const err9: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}else {const _errs12: any = errors;for(const key1 in data){if(!((key1 === "files") || (key1 === "hasMore"))){const err10: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;break;}}if(_errs12 === errors){if(data.files !== undefined){let data4: any = data.files;const _errs13: any = errors;if(wireByteLength(data4, this && this.attachments) > 991808){const err11: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/1/properties/files/maxJsonBytes",keyword:"maxJsonBytes",params:{}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}if(errors === _errs13){if(Array.isArray(data4)){if(data4.length > 256){const err12: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/1/properties/files/maxItems",keyword:"maxItems",params:{limit: 256}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}else {var valid4: any = true;const len1: any = data4.length;for(let i1=0; i1<len1; i1++){const _errs15: any = errors;if(!(validateSessionConvertSkippedFile.call(this, data4[i1], {instancePath:instancePath+"/files/" + i1,parentData:data4,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionConvertSkippedFile.errors : vErrors.concat(validateSessionConvertSkippedFile.errors);errors = vErrors.length;}var valid4: any = _errs15 === errors;if(!valid4){break;}}}}else {const err13: any = {instancePath:instancePath+"/files",schemaPath:"#/anyOf/1/properties/files/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}var valid3: any = _errs13 === errors;}else {var valid3: any = true;}if(valid3){if(data.hasMore !== undefined){let data6: any = data.hasMore;const _errs16: any = errors;if(typeof data6 !== "boolean"){const err14: any = {instancePath:instancePath+"/hasMore",schemaPath:"#/anyOf/1/properties/hasMore/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}if(false !== data6){const err15: any = {instancePath:instancePath+"/hasMore",schemaPath:"#/anyOf/1/properties/hasMore/const",keyword:"const",params:{allowedValue: false}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}var valid3: any = _errs16 === errors;}else {var valid3: any = true;}}}}}else {const err16: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}var _valid0: any = _errs10 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err17: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;validateSessionConversionSkippedFileListResponse.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateSessionConversionSkippedFileListResponse.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateSessionConversionSkippedFileListResponse.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
