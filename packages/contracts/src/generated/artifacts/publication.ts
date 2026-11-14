// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Publishing an artifact from a payload the caller holds whole, and the event payload that announces an artifact was published.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { validateBytes } from "../internal/wire-scalars.js";
import { type RunId, validateRunId } from "../run/id.js";
import { type SessionId, validateSessionId } from "../session/id.js";
import { type ArtifactId, validateArtifactId } from "./id.js";
import {
  type ArtifactManifest,
  type ArtifactType,
  validateArtifactManifest,
  validateArtifactType,
} from "./manifest.js";

/**
 * Publishes one artifact in a single call. The daemon hashes the payload's bytes, so the digest
 * and size are never the caller's to declare, and it reads the recorded type from the bytes. A
 * client's `file` is refused: a file comes in through ingest. A resend under the same
 * `clientIdempotencyKey` answers the first publish's manifest, never a second artifact.
 */
export interface ArtifactPublishRequest {
  /**
   * The session the artifact belongs to.
   */
  sessionId: SessionId;
  /**
   * The run that produced it; absent when no run did.
   */
  runId?: RunId;
  /**
   * The artifact's kind.
   */
  artifactType: ArtifactType;
  /**
   * The payload's bytes.
   */
  payload: Uint8Array;
  /**
   * The key that makes a resent publish one artifact.
   */
  clientIdempotencyKey: string;
  /**
   * The caller's media type for the payload.
   */
  mediaType: string;
  /**
   * The artifact's freeform provenance.
   */
  metadata?: {
    [k: string]: unknown | undefined;
  };
}
/**
 * The published artifact's manifest: its id is the artifact id, its digest the content hash.
 */
export interface ArtifactPublishResponse {
  /**
   * The manifest the daemon recorded.
   */
  manifest: ArtifactManifest;
}
/**
 * The payload of `artifact.published`: it names the artifact and carries no content; an artifact
 * is never changed in place, so a new version is a new artifact with its own event. A member a
 * newer daemon adds is kept in `rest`, so an older reader keeps it rather than refusing a known
 * event.
 */
export interface ArtifactPublicationPayload {
  /**
   * The session the artifact belongs to.
   */
  sessionId: SessionId;
  /**
   * The artifact.
   */
  artifactId?: ArtifactId;
  /**
   * The run that produced it.
   */
  runId?: RunId;
  /**
   * The diff artifact that came with it.
   */
  diffArtifactId?: ArtifactId;
  [k: string]: unknown | undefined;
}

// prettier-ignore
const pattern88 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link ArtifactPublishRequest}. */
// prettier-ignore
export const validateArtifactPublishRequest: CompiledSchemaCheck<ArtifactPublishRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactPublishRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactPublishRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.artifactType === undefined) && (missing0 = "artifactType"))) || ((data.payload === undefined) && (missing0 = "payload"))) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))) || ((data.mediaType === undefined) && (missing0 = "mediaType"))){validateArtifactPublishRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "artifactType")) || (key0 === "payload")) || (key0 === "clientIdempotencyKey")) || (key0 === "mediaType")) || (key0 === "metadata"))){validateArtifactPublishRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.artifactType !== undefined){const _errs4: any = errors;if(!(validateArtifactType.call(this, data.artifactType, {instancePath:instancePath+"/artifactType",parentData:data,parentDataProperty:"artifactType",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactType.errors : vErrors.concat(validateArtifactType.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.payload !== undefined){let data3: any = data.payload;const _errs5: any = errors;if(!(validateBytes.call(this, data3, {instancePath:instancePath+"/payload",parentData:data,parentDataProperty:"payload",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBytes.errors : vErrors.concat(validateBytes.errors);errors = vErrors.length;}else {if(!(data3 && typeof data3 == "object" && Number.isInteger(data3.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data3.$bytes] instanceof Uint8Array && this.attachments[data3.$bytes].byteLength <= 4194300)){validateArtifactPublishRequest.errors = [{instancePath:instancePath+"/payload",schemaPath:"#/properties/payload/maxBytes",keyword:"maxBytes",params:{}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data4: any = data.clientIdempotencyKey;const _errs7: any = errors;if(errors === _errs7){if(typeof data4 === "string"){if(!pattern88.test(data4)){validateArtifactPublishRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateArtifactPublishRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.mediaType !== undefined){let data5: any = data.mediaType;const _errs9: any = errors;if(errors === _errs9){if(typeof data5 === "string"){if(func1(data5) < 1){validateArtifactPublishRequest.errors = [{instancePath:instancePath+"/mediaType",schemaPath:"#/properties/mediaType/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateArtifactPublishRequest.errors = [{instancePath:instancePath+"/mediaType",schemaPath:"#/properties/mediaType/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.metadata !== undefined){let data6: any = data.metadata;const _errs11: any = errors;if(errors === _errs11){if(data6 && typeof data6 == "object" && !Array.isArray(data6)){for(const key1 in data6){const _errs13: any = errors;const _errs14: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs14 === errors;if(valid2){const _errs16: any = errors;const _errs17: any = errors;const _errs18: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid3: any = _errs18 === errors;if(valid3){const err2: any = {instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs17;if(vErrors !== null){if(_errs17){vErrors.length = _errs17;}else {vErrors = null;}}}var valid2: any = _errs16 === errors;}var valid1: any = _errs13 === errors;if(!valid1){const err3: any = {instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateArtifactPublishRequest.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data6){const _errs20: any = errors;var valid4: any = _errs20 === errors;if(!valid4){break;}}}}else {validateArtifactPublishRequest.errors = [{instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validateArtifactPublishRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactPublishRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactPublishRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactPublishResponse}. */
// prettier-ignore
export const validateArtifactPublishResponse: CompiledSchemaCheck<ArtifactPublishResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactPublishResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactPublishResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.manifest === undefined) && (missing0 = "manifest")){validateArtifactPublishResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "manifest")){validateArtifactPublishResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.manifest !== undefined){if(!(validateArtifactManifest.call(this, data.manifest, {instancePath:instancePath+"/manifest",parentData:data,parentDataProperty:"manifest",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactManifest.errors : vErrors.concat(validateArtifactManifest.errors);errors = vErrors.length;}}}}}else {validateArtifactPublishResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactPublishResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactPublishResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactPublicationPayload}. */
// prettier-ignore
export const validateArtifactPublicationPayload: CompiledSchemaCheck<ArtifactPublicationPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactPublicationPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactPublicationPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateArtifactPublicationPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {for(const key0 in data){const _errs1: any = errors;const _errs2: any = errors;const _errs3: any = errors;if("__proto__" !== key0){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid1: any = _errs3 === errors;if(valid1){const err1: any = {instancePath,schemaPath:"#/propertyNames/not",keyword:"not",params:{},propertyName:key0};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}else {errors = _errs2;if(vErrors !== null){if(_errs2){vErrors.length = _errs2;}else {vErrors = null;}}}var valid0: any = _errs1 === errors;if(!valid0){const err2: any = {instancePath,schemaPath:"#/propertyNames",keyword:"propertyNames",params:{propertyName: key0}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;validateArtifactPublicationPayload.errors = vErrors;return false;break;}}if(valid0){if(data.sessionId !== undefined){const _errs5: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.artifactId !== undefined){const _errs6: any = errors;if(!(validateArtifactId.call(this, data.artifactId, {instancePath:instancePath+"/artifactId",parentData:data,parentDataProperty:"artifactId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.runId !== undefined){const _errs7: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.diffArtifactId !== undefined){const _errs8: any = errors;if(!(validateArtifactId.call(this, data.diffArtifactId, {instancePath:instancePath+"/diffArtifactId",parentData:data,parentDataProperty:"diffArtifactId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}}}else {validateArtifactPublicationPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactPublicationPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactPublicationPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
