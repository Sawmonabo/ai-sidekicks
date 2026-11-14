// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The three calls that stream a caller's file into a session's artifacts: open a stream, send its bytes in numbered chunks, and complete it.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { validateBytes } from "../internal/wire-scalars.js";
import { type RunId, validateRunId } from "../run/id.js";
import { type SessionId, validateSessionId } from "../session/id.js";
import { type ArtifactId, validateArtifactId } from "./id.js";

/**
 * The most bytes one artifact chunk carries, either way: a chunk a caller streams in, and a
 * byte range `artifact.read` answers.
 */
export const ARTIFACT_CHUNK_MAX_BYTES = 524288 as const;

/**
 * Opens an ingest stream for one file. `mediaType` is the caller's guess, absent when the file
 * declared none; it refuses nothing and is recorded nowhere, since the daemon reads the type from
 * the bytes. `declaredSizeBytes` also reserves the stream's spool space, so the stream's bytes
 * may not exceed it. A resend under the same `clientIdempotencyKey` answers the first opening's
 * `ingestId`, never a second stream.
 */
export interface ArtifactIngestStartRequest {
  /**
   * The session the file is for.
   */
  sessionId: SessionId;
  /**
   * The run the file is for; absent when no run asked for it.
   */
  runId?: RunId;
  /**
   * The file's name.
   */
  fileName: string;
  /**
   * The caller's guess at the media type; never sent empty.
   */
  mediaType?: string;
  /**
   * The size the caller declares, in bytes.
   */
  declaredSizeBytes: number;
  /**
   * The key that makes a resent opening one stream.
   */
  clientIdempotencyKey: string;
}
/**
 * The opened stream: `ingestId` is a single-use handle, bound to the session and to the stream's
 * lifetime, that every chunk and the completion name.
 */
export interface ArtifactIngestStartResponse {
  /**
   * The stream's handle.
   */
  ingestId: string;
}
/**
 * One chunk of an open stream. `sequenceNumber` counts from 0 with no gaps, and a resent chunk
 * carries the number it was first sent with; `chunk` is at most
 * [`ARTIFACT_CHUNK_MAX_BYTES`] bytes.
 */
export interface ArtifactIngestWriteRequest {
  /**
   * The stream's handle.
   */
  ingestId: string;
  /**
   * The chunk's place in the stream, from 0.
   */
  sequenceNumber: number;
  /**
   * The chunk's bytes.
   */
  chunk: Uint8Array;
}
/**
 * One chunk's acknowledgment. `receivedBytes` is the stream's running total after the chunk, so
 * progress is the daemon's count and never the sender's.
 */
export interface ArtifactIngestWriteResponse {
  /**
   * The stream's handle.
   */
  ingestId: string;
  /**
   * The bytes the stream has received so far.
   */
  receivedBytes: number;
}
/**
 * Completes a stream. The stream's handle is the only member: the daemon checks the spooled bytes
 * and commits them, and a resent completion answers with the first one's result.
 */
export interface ArtifactIngestCompleteRequest {
  /**
   * The stream's handle.
   */
  ingestId: string;
}
/**
 * What the daemon committed. Every member is derived from the spooled bytes, never taken from the
 * opening request, so a caller that declared the wrong type or size learns what was recorded.
 */
export interface ArtifactIngestCompleteResponse {
  /**
   * The artifact the file became.
   */
  artifactId: ArtifactId;
  /**
   * The payload's SHA-256, the manifest's `digest`.
   */
  contentHash: string;
  /**
   * The file's name as stored.
   */
  normalizedName: string;
  /**
   * The media type read from the bytes.
   */
  derivedMediaType: string;
  /**
   * The size measured from the bytes.
   */
  derivedSizeBytes: number;
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern88 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
/** Checks that a value is a {@link ArtifactIngestStartRequest}. */
// prettier-ignore
export const validateArtifactIngestStartRequest: CompiledSchemaCheck<ArtifactIngestStartRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactIngestStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactIngestStartRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.fileName === undefined) && (missing0 = "fileName"))) || ((data.declaredSizeBytes === undefined) && (missing0 = "declaredSizeBytes"))) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validateArtifactIngestStartRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "fileName")) || (key0 === "mediaType")) || (key0 === "declaredSizeBytes")) || (key0 === "clientIdempotencyKey"))){validateArtifactIngestStartRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.fileName !== undefined){let data2: any = data.fileName;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) > 4096){validateArtifactIngestStartRequest.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validateArtifactIngestStartRequest.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateArtifactIngestStartRequest.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.mediaType !== undefined){let data3: any = data.mediaType;const _errs6: any = errors;if(errors === _errs6){if(typeof data3 === "string"){if(func1(data3) < 1){validateArtifactIngestStartRequest.errors = [{instancePath:instancePath+"/mediaType",schemaPath:"#/properties/mediaType/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateArtifactIngestStartRequest.errors = [{instancePath:instancePath+"/mediaType",schemaPath:"#/properties/mediaType/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.declaredSizeBytes !== undefined){let data4: any = data.declaredSizeBytes;const _errs8: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateArtifactIngestStartRequest.errors = [{instancePath:instancePath+"/declaredSizeBytes",schemaPath:"#/properties/declaredSizeBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateArtifactIngestStartRequest.errors = [{instancePath:instancePath+"/declaredSizeBytes",schemaPath:"#/properties/declaredSizeBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validateArtifactIngestStartRequest.errors = [{instancePath:instancePath+"/declaredSizeBytes",schemaPath:"#/properties/declaredSizeBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data5: any = data.clientIdempotencyKey;const _errs10: any = errors;if(errors === _errs10){if(typeof data5 === "string"){if(!pattern88.test(data5)){validateArtifactIngestStartRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateArtifactIngestStartRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateArtifactIngestStartRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactIngestStartRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactIngestStartRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactIngestStartResponse}. */
// prettier-ignore
export const validateArtifactIngestStartResponse: CompiledSchemaCheck<ArtifactIngestStartResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactIngestStartResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactIngestStartResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.ingestId === undefined) && (missing0 = "ingestId")){validateArtifactIngestStartResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "ingestId")){validateArtifactIngestStartResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.ingestId !== undefined){let data0: any = data.ingestId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateArtifactIngestStartResponse.errors = [{instancePath:instancePath+"/ingestId",schemaPath:"#/properties/ingestId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateArtifactIngestStartResponse.errors = [{instancePath:instancePath+"/ingestId",schemaPath:"#/properties/ingestId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateArtifactIngestStartResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactIngestStartResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactIngestStartResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactIngestWriteRequest}. */
// prettier-ignore
export const validateArtifactIngestWriteRequest: CompiledSchemaCheck<ArtifactIngestWriteRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactIngestWriteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactIngestWriteRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.ingestId === undefined) && (missing0 = "ingestId")) || ((data.sequenceNumber === undefined) && (missing0 = "sequenceNumber"))) || ((data.chunk === undefined) && (missing0 = "chunk"))){validateArtifactIngestWriteRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "ingestId") || (key0 === "sequenceNumber")) || (key0 === "chunk"))){validateArtifactIngestWriteRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.ingestId !== undefined){let data0: any = data.ingestId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateArtifactIngestWriteRequest.errors = [{instancePath:instancePath+"/ingestId",schemaPath:"#/properties/ingestId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateArtifactIngestWriteRequest.errors = [{instancePath:instancePath+"/ingestId",schemaPath:"#/properties/ingestId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sequenceNumber !== undefined){let data1: any = data.sequenceNumber;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateArtifactIngestWriteRequest.errors = [{instancePath:instancePath+"/sequenceNumber",schemaPath:"#/properties/sequenceNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateArtifactIngestWriteRequest.errors = [{instancePath:instancePath+"/sequenceNumber",schemaPath:"#/properties/sequenceNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateArtifactIngestWriteRequest.errors = [{instancePath:instancePath+"/sequenceNumber",schemaPath:"#/properties/sequenceNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.chunk !== undefined){let data2: any = data.chunk;const _errs6: any = errors;if(!(validateBytes.call(this, data2, {instancePath:instancePath+"/chunk",parentData:data,parentDataProperty:"chunk",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBytes.errors : vErrors.concat(validateBytes.errors);errors = vErrors.length;}else {if(!(data2 && typeof data2 == "object" && Number.isInteger(data2.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data2.$bytes] instanceof Uint8Array && this.attachments[data2.$bytes].byteLength <= 524288)){validateArtifactIngestWriteRequest.errors = [{instancePath:instancePath+"/chunk",schemaPath:"#/properties/chunk/maxBytes",keyword:"maxBytes",params:{}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateArtifactIngestWriteRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactIngestWriteRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactIngestWriteRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactIngestWriteResponse}. */
// prettier-ignore
export const validateArtifactIngestWriteResponse: CompiledSchemaCheck<ArtifactIngestWriteResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactIngestWriteResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactIngestWriteResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.ingestId === undefined) && (missing0 = "ingestId")) || ((data.receivedBytes === undefined) && (missing0 = "receivedBytes"))){validateArtifactIngestWriteResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "ingestId") || (key0 === "receivedBytes"))){validateArtifactIngestWriteResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.ingestId !== undefined){let data0: any = data.ingestId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateArtifactIngestWriteResponse.errors = [{instancePath:instancePath+"/ingestId",schemaPath:"#/properties/ingestId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateArtifactIngestWriteResponse.errors = [{instancePath:instancePath+"/ingestId",schemaPath:"#/properties/ingestId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.receivedBytes !== undefined){let data1: any = data.receivedBytes;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateArtifactIngestWriteResponse.errors = [{instancePath:instancePath+"/receivedBytes",schemaPath:"#/properties/receivedBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateArtifactIngestWriteResponse.errors = [{instancePath:instancePath+"/receivedBytes",schemaPath:"#/properties/receivedBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateArtifactIngestWriteResponse.errors = [{instancePath:instancePath+"/receivedBytes",schemaPath:"#/properties/receivedBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateArtifactIngestWriteResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactIngestWriteResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactIngestWriteResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactIngestCompleteRequest}. */
// prettier-ignore
export const validateArtifactIngestCompleteRequest: CompiledSchemaCheck<ArtifactIngestCompleteRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactIngestCompleteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactIngestCompleteRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.ingestId === undefined) && (missing0 = "ingestId")){validateArtifactIngestCompleteRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "ingestId")){validateArtifactIngestCompleteRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.ingestId !== undefined){let data0: any = data.ingestId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateArtifactIngestCompleteRequest.errors = [{instancePath:instancePath+"/ingestId",schemaPath:"#/properties/ingestId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateArtifactIngestCompleteRequest.errors = [{instancePath:instancePath+"/ingestId",schemaPath:"#/properties/ingestId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateArtifactIngestCompleteRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactIngestCompleteRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactIngestCompleteRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactIngestCompleteResponse}. */
// prettier-ignore
export const validateArtifactIngestCompleteResponse: CompiledSchemaCheck<ArtifactIngestCompleteResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactIngestCompleteResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactIngestCompleteResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.artifactId === undefined) && (missing0 = "artifactId")) || ((data.contentHash === undefined) && (missing0 = "contentHash"))) || ((data.normalizedName === undefined) && (missing0 = "normalizedName"))) || ((data.derivedMediaType === undefined) && (missing0 = "derivedMediaType"))) || ((data.derivedSizeBytes === undefined) && (missing0 = "derivedSizeBytes"))){validateArtifactIngestCompleteResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "artifactId") || (key0 === "contentHash")) || (key0 === "normalizedName")) || (key0 === "derivedMediaType")) || (key0 === "derivedSizeBytes"))){validateArtifactIngestCompleteResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.artifactId !== undefined){const _errs2: any = errors;if(!(validateArtifactId.call(this, data.artifactId, {instancePath:instancePath+"/artifactId",parentData:data,parentDataProperty:"artifactId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.contentHash !== undefined){let data1: any = data.contentHash;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validateArtifactIngestCompleteResponse.errors = [{instancePath:instancePath+"/contentHash",schemaPath:"#/properties/contentHash/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateArtifactIngestCompleteResponse.errors = [{instancePath:instancePath+"/contentHash",schemaPath:"#/properties/contentHash/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.normalizedName !== undefined){let data2: any = data.normalizedName;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 4096){validateArtifactIngestCompleteResponse.errors = [{instancePath:instancePath+"/normalizedName",schemaPath:"#/properties/normalizedName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validateArtifactIngestCompleteResponse.errors = [{instancePath:instancePath+"/normalizedName",schemaPath:"#/properties/normalizedName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateArtifactIngestCompleteResponse.errors = [{instancePath:instancePath+"/normalizedName",schemaPath:"#/properties/normalizedName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.derivedMediaType !== undefined){let data3: any = data.derivedMediaType;const _errs7: any = errors;if(errors === _errs7){if(typeof data3 === "string"){if(func1(data3) < 1){validateArtifactIngestCompleteResponse.errors = [{instancePath:instancePath+"/derivedMediaType",schemaPath:"#/properties/derivedMediaType/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateArtifactIngestCompleteResponse.errors = [{instancePath:instancePath+"/derivedMediaType",schemaPath:"#/properties/derivedMediaType/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.derivedSizeBytes !== undefined){let data4: any = data.derivedSizeBytes;const _errs9: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateArtifactIngestCompleteResponse.errors = [{instancePath:instancePath+"/derivedSizeBytes",schemaPath:"#/properties/derivedSizeBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateArtifactIngestCompleteResponse.errors = [{instancePath:instancePath+"/derivedSizeBytes",schemaPath:"#/properties/derivedSizeBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validateArtifactIngestCompleteResponse.errors = [{instancePath:instancePath+"/derivedSizeBytes",schemaPath:"#/properties/derivedSizeBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}}}else {validateArtifactIngestCompleteResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactIngestCompleteResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactIngestCompleteResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
