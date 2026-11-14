// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Listing a session's artifacts and reading one of them, and the refusal codes the artifact calls answer with.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { validateBytes } from "../internal/wire-scalars.js";
import { type PlanId, type PlanState, validatePlanId, validatePlanState } from "../plan.js";
import { type SessionId, validateSessionId } from "../session/id.js";
import { type ArtifactId, validateArtifactId } from "./id.js";
import { type ArtifactManifest, validateArtifactManifest } from "./manifest.js";

/** Every refusal an artifact call answers with. */
export const ARTIFACT_REFUSAL_CODES = [
  "artifact.notFound",
  "artifact.tooLarge",
  "artifact.filePublishRefused",
  "artifact.idempotencyConflict",
  "artifact.ingest.capacityExhausted",
  "artifact.ingest.streamInvalid",
] as const;

/**
 * One artifact in a session's list: a plan the agent finished, with its first heading and the
 * state word its plan record holds, or a file or folder a chat wrote, with its path in the chat's
 * workspace and how many versions it has. Each carries its newest manifest; a folder's media type
 * is `inode/directory`.
 */
export type ArtifactListEntry =
  | {
      kind: "plan";
      /**
       * The plan's manifest.
       */
      manifest: ArtifactManifest;
      /**
       * The plan.
       */
      planId: PlanId;
      /**
       * The plan's first heading.
       */
      title: string;
      /**
       * The state word its plan record holds.
       */
      state: PlanState;
    }
  | {
      kind: "file";
      /**
       * The newest version's manifest.
       */
      manifest: ArtifactManifest;
      /**
       * Its path in the chat's workspace.
       */
      path: string;
      /**
       * How many versions it has; a folder's is 1.
       */
      versionCount: number;
    };
/**
 * How much of the payload a read returns: the handle only, the bytes when they fit in one message
 * (the handle otherwise, so a large payload is read window by window), or one window of `length`
 * bytes from `offset`, counted from 0. A window reaching past the payload's end answers the bytes
 * up to the end.
 */
export type ArtifactPayloadSelection =
  | {
      kind: "none";
    }
  | {
      kind: "whole";
    }
  | {
      kind: "range";
      /**
       * The window's first byte, from 0.
       */
      offset: number;
      /**
       * The window's length in bytes, at most one chunk.
       */
      length: number;
    };
/**
 * What a read answers: the manifest, plus either a handle to fetch the bytes with or the bytes. A
 * read whose payload would not fit one message gets the handle arm, a served answer rather than a
 * refusal.
 */
export type ArtifactReadResponse =
  | {
      /**
       * The manifest of the version in view; its `createdAt` is when that version was
       * written.
       */
      manifest: ArtifactManifest;
      /**
       * The version in view, from 1, oldest first; never above `versionCount`.
       */
      versionNumber: number;
      /**
       * How many versions exist; 1 for a plan and any artifact no chat wrote.
       */
      versionCount: number;
      /**
       * A picture's size; present only on a picture.
       */
      naturalSize?: ArtifactPictureSize;
      /**
       * A PDF's first page; present only on a PDF whose first page could be generated.
       */
      pdfPreview?: ArtifactPdfPreview;
      /**
       * The content-store key or address for the payload.
       */
      payloadHandle: string;
      /**
       * Absent: this arm carries no bytes.
       */
      payload?: never;
    }
  | {
      /**
       * The manifest of the version in view; its `createdAt` is when that version was
       * written.
       */
      manifest: ArtifactManifest;
      /**
       * The version in view, from 1, oldest first; never above `versionCount`.
       */
      versionNumber: number;
      /**
       * How many versions exist; 1 for a plan and any artifact no chat wrote.
       */
      versionCount: number;
      /**
       * A picture's size; present only on a picture.
       */
      naturalSize?: ArtifactPictureSize;
      /**
       * A PDF's first page; present only on a PDF whose first page could be generated.
       */
      pdfPreview?: ArtifactPdfPreview;
      /**
       * The content-store key or address for the payload; a reply may return both.
       */
      payloadHandle?: string;
      /**
       * The bytes.
       */
      payload: Uint8Array;
    };
/**
 * A refusal an artifact call answers with.
 */
export type ArtifactRefusalCode =
  | "artifact.notFound"
  | "artifact.tooLarge"
  | "artifact.filePublishRefused"
  | "artifact.idempotencyConflict"
  | "artifact.ingest.capacityExhausted"
  | "artifact.ingest.streamInvalid";
/**
 * Why an `artifact.ingest.streamInvalid` stream call cannot go on, carried as its `reason`.
 */
export type IngestStreamInvalidReason =
  | "unknownStream"
  | "sequenceBroken"
  | "lifetimeExpired"
  | "alreadyCompleted"
  | "completionRecordMismatch";
/**
 * Why an `artifact.tooLarge` refusal was raised, carried as its `reason`.
 */
export type ArtifactTooLargeReason = "volumeTooSmall" | "declaredSizeExceeded";

/**
 * Asks for the artifacts of one session.
 */
export interface ArtifactListRequest {
  /**
   * The session whose artifacts to list.
   */
  sessionId: SessionId;
}
/**
 * The session's artifacts.
 */
export interface ArtifactListResponse {
  /**
   * The artifacts, each with its newest manifest.
   */
  artifacts: ArtifactListEntry[];
}
/**
 * Asks for one artifact: its manifest, a handle, and as much of the payload as `payloadSelection`
 * picks. `version` counts from 1, oldest first; without it the read answers the newest.
 */
export interface ArtifactReadRequest {
  /**
   * The artifact to read.
   */
  artifactId: ArtifactId;
  /**
   * The version to read, from 1; absent for the newest.
   */
  version?: number;
  /**
   * How much of the payload to answer.
   */
  payloadSelection: ArtifactPayloadSelection;
}
/**
 * A picture's width and height in pixels, read from its header when its bytes were stored, its
 * orientation applied, so it is the size the picture is drawn at.
 */
export interface ArtifactPictureSize {
  /**
   * The width in pixels.
   */
  width: number;
  /**
   * The height in pixels.
   */
  height: number;
}
/**
 * A PDF's first page, generated at ingest and stored as an artifact of its own, and how many
 * pages the PDF has.
 */
export interface ArtifactPdfPreview {
  /**
   * The artifact holding the first page.
   */
  firstPageArtifactId: ArtifactId;
  /**
   * How many pages the PDF has.
   */
  pageCount: number;
}

/** Checks that a value is a {@link ArtifactListRequest}. */
// prettier-ignore
export const validateArtifactListRequest: CompiledSchemaCheck<ArtifactListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateArtifactListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateArtifactListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateArtifactListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link ArtifactListEntry}. */
// prettier-ignore
export const validateArtifactListEntry: CompiledSchemaCheck<ArtifactListEntry> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactListEntry {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactListEntry.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "plan"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.kind === undefined) && (missing0 = "kind")) || ((data.manifest === undefined) && (missing0 = "manifest"))) || ((data.planId === undefined) && (missing0 = "planId"))) || ((data.title === undefined) && (missing0 = "title"))) || ((data.state === undefined) && (missing0 = "state"))){validateArtifactListEntry.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((((key0 === "kind") || (key0 === "manifest")) || (key0 === "planId")) || (key0 === "title")) || (key0 === "state"))){validateArtifactListEntry.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateArtifactListEntry.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("plan" !== data0){validateArtifactListEntry.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "plan"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.manifest !== undefined){const _errs7: any = errors;if(!(validateArtifactManifest.call(this, data.manifest, {instancePath:instancePath+"/manifest",parentData:data,parentDataProperty:"manifest",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactManifest.errors : vErrors.concat(validateArtifactManifest.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.planId !== undefined){const _errs8: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.title !== undefined){const _errs9: any = errors;if(typeof data.title !== "string"){validateArtifactListEntry.errors = [{instancePath:instancePath+"/title",schemaPath:"#/oneOf/0/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.state !== undefined){const _errs11: any = errors;if(!(validatePlanState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanState.errors : vErrors.concat(validatePlanState.errors);errors = vErrors.length;}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}}}}}}}}else {validateArtifactListEntry.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "file"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.kind === undefined) && (missing1 = "kind")) || ((data.manifest === undefined) && (missing1 = "manifest"))) || ((data.path === undefined) && (missing1 = "path"))) || ((data.versionCount === undefined) && (missing1 = "versionCount"))){validateArtifactListEntry.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key1 in data){if(!((((key1 === "kind") || (key1 === "manifest")) || (key1 === "path")) || (key1 === "versionCount"))){validateArtifactListEntry.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs14 === errors){if(data.kind !== undefined){let data5: any = data.kind;const _errs15: any = errors;if(typeof data5 !== "string"){validateArtifactListEntry.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("file" !== data5){validateArtifactListEntry.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "file"}}];return false;}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data.manifest !== undefined){const _errs17: any = errors;if(!(validateArtifactManifest.call(this, data.manifest, {instancePath:instancePath+"/manifest",parentData:data,parentDataProperty:"manifest",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactManifest.errors : vErrors.concat(validateArtifactManifest.errors);errors = vErrors.length;}var valid4: any = _errs17 === errors;}else {var valid4: any = true;}if(valid4){if(data.path !== undefined){let data7: any = data.path;const _errs18: any = errors;if(errors === _errs18){if(typeof data7 === "string"){if(func1(data7) < 1){validateArtifactListEntry.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateArtifactListEntry.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data.versionCount !== undefined){let data8: any = data.versionCount;const _errs20: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validateArtifactListEntry.errors = [{instancePath:instancePath+"/versionCount",schemaPath:"#/oneOf/1/properties/versionCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs20){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validateArtifactListEntry.errors = [{instancePath:instancePath+"/versionCount",schemaPath:"#/oneOf/1/properties/versionCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 1 || isNaN(data8)){validateArtifactListEntry.errors = [{instancePath:instancePath+"/versionCount",schemaPath:"#/oneOf/1/properties/versionCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid4: any = _errs20 === errors;}else {var valid4: any = true;}}}}}}}else {validateArtifactListEntry.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs12 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateArtifactListEntry.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateArtifactListEntry.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateArtifactListEntry.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateArtifactListEntry.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactListEntry.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactListEntry.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactListResponse}. */
// prettier-ignore
export const validateArtifactListResponse: CompiledSchemaCheck<ArtifactListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.artifacts === undefined) && (missing0 = "artifacts")){validateArtifactListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "artifacts")){validateArtifactListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.artifacts !== undefined){let data0: any = data.artifacts;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateArtifactListEntry.call(this, data0[i0], {instancePath:instancePath+"/artifacts/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactListEntry.errors : vErrors.concat(validateArtifactListEntry.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateArtifactListResponse.errors = [{instancePath:instancePath+"/artifacts",schemaPath:"#/properties/artifacts/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateArtifactListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactPayloadSelection}. */
// prettier-ignore
export const validateArtifactPayloadSelection: CompiledSchemaCheck<ArtifactPayloadSelection> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactPayloadSelection {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactPayloadSelection.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "none"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.kind === undefined) && (missing0 = "kind")){validateArtifactPayloadSelection.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(key0 === "kind")){validateArtifactPayloadSelection.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;if(typeof data0 !== "string"){validateArtifactPayloadSelection.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("none" !== data0){validateArtifactPayloadSelection.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "none"}}];return false;}}}}}else {validateArtifactPayloadSelection.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "whole"){const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.kind === undefined) && (missing1 = "kind")){validateArtifactPayloadSelection.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data){if(!(key1 === "kind")){validateArtifactPayloadSelection.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data.kind !== undefined){let data1: any = data.kind;if(typeof data1 !== "string"){validateArtifactPayloadSelection.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("whole" !== data1){validateArtifactPayloadSelection.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "whole"}}];return false;}}}}}else {validateArtifactPayloadSelection.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs7 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "range"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.kind === undefined) && (missing2 = "kind")) || ((data.offset === undefined) && (missing2 = "offset"))) || ((data.length === undefined) && (missing2 = "length"))){validateArtifactPayloadSelection.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "offset")) || (key2 === "length"))){validateArtifactPayloadSelection.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs15: any = errors;if(typeof data2 !== "string"){validateArtifactPayloadSelection.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("range" !== data2){validateArtifactPayloadSelection.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "range"}}];return false;}var valid6: any = _errs15 === errors;}else {var valid6: any = true;}if(valid6){if(data.offset !== undefined){let data3: any = data.offset;const _errs17: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateArtifactPayloadSelection.errors = [{instancePath:instancePath+"/offset",schemaPath:"#/oneOf/2/properties/offset/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs17){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateArtifactPayloadSelection.errors = [{instancePath:instancePath+"/offset",schemaPath:"#/oneOf/2/properties/offset/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateArtifactPayloadSelection.errors = [{instancePath:instancePath+"/offset",schemaPath:"#/oneOf/2/properties/offset/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid6: any = _errs17 === errors;}else {var valid6: any = true;}if(valid6){if(data.length !== undefined){let data4: any = data.length;const _errs19: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateArtifactPayloadSelection.errors = [{instancePath:instancePath+"/length",schemaPath:"#/oneOf/2/properties/length/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs19){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 524288 || isNaN(data4)){validateArtifactPayloadSelection.errors = [{instancePath:instancePath+"/length",schemaPath:"#/oneOf/2/properties/length/maximum",keyword:"maximum",params:{comparison: "<=", limit: 524288}}];return false;}else {if(data4 < 1 || isNaN(data4)){validateArtifactPayloadSelection.errors = [{instancePath:instancePath+"/length",schemaPath:"#/oneOf/2/properties/length/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid6: any = _errs19 === errors;}else {var valid6: any = true;}}}}}}else {validateArtifactPayloadSelection.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs12 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validateArtifactPayloadSelection.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateArtifactPayloadSelection.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validateArtifactPayloadSelection.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validateArtifactPayloadSelection.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactPayloadSelection.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactPayloadSelection.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactReadRequest}. */
// prettier-ignore
export const validateArtifactReadRequest: CompiledSchemaCheck<ArtifactReadRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactReadRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.artifactId === undefined) && (missing0 = "artifactId")) || ((data.payloadSelection === undefined) && (missing0 = "payloadSelection"))){validateArtifactReadRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "artifactId") || (key0 === "version")) || (key0 === "payloadSelection"))){validateArtifactReadRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.artifactId !== undefined){const _errs2: any = errors;if(!(validateArtifactId.call(this, data.artifactId, {instancePath:instancePath+"/artifactId",parentData:data,parentDataProperty:"artifactId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.version !== undefined){let data1: any = data.version;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateArtifactReadRequest.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateArtifactReadRequest.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateArtifactReadRequest.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.payloadSelection !== undefined){const _errs5: any = errors;if(!(validateArtifactPayloadSelection.call(this, data.payloadSelection, {instancePath:instancePath+"/payloadSelection",parentData:data,parentDataProperty:"payloadSelection",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactPayloadSelection.errors : vErrors.concat(validateArtifactPayloadSelection.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateArtifactReadRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactReadRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactReadRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactPictureSize}. */
// prettier-ignore
export const validateArtifactPictureSize: CompiledSchemaCheck<ArtifactPictureSize> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactPictureSize {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactPictureSize.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.width === undefined) && (missing0 = "width")) || ((data.height === undefined) && (missing0 = "height"))){validateArtifactPictureSize.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "width") || (key0 === "height"))){validateArtifactPictureSize.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.width !== undefined){let data0: any = data.width;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateArtifactPictureSize.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateArtifactPictureSize.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validateArtifactPictureSize.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.height !== undefined){let data1: any = data.height;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateArtifactPictureSize.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateArtifactPictureSize.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateArtifactPictureSize.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateArtifactPictureSize.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactPictureSize.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactPictureSize.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactPdfPreview}. */
// prettier-ignore
export const validateArtifactPdfPreview: CompiledSchemaCheck<ArtifactPdfPreview> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactPdfPreview {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactPdfPreview.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.firstPageArtifactId === undefined) && (missing0 = "firstPageArtifactId")) || ((data.pageCount === undefined) && (missing0 = "pageCount"))){validateArtifactPdfPreview.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "firstPageArtifactId") || (key0 === "pageCount"))){validateArtifactPdfPreview.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.firstPageArtifactId !== undefined){const _errs2: any = errors;if(!(validateArtifactId.call(this, data.firstPageArtifactId, {instancePath:instancePath+"/firstPageArtifactId",parentData:data,parentDataProperty:"firstPageArtifactId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageCount !== undefined){let data1: any = data.pageCount;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateArtifactPdfPreview.errors = [{instancePath:instancePath+"/pageCount",schemaPath:"#/properties/pageCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateArtifactPdfPreview.errors = [{instancePath:instancePath+"/pageCount",schemaPath:"#/properties/pageCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateArtifactPdfPreview.errors = [{instancePath:instancePath+"/pageCount",schemaPath:"#/properties/pageCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateArtifactPdfPreview.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactPdfPreview.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactPdfPreview.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactReadResponse}. */
// prettier-ignore
export const validateArtifactReadResponse: CompiledSchemaCheck<ArtifactReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.manifest === undefined) && (missing0 = "manifest")) || ((data.versionNumber === undefined) && (missing0 = "versionNumber"))) || ((data.versionCount === undefined) && (missing0 = "versionCount"))) || ((data.payloadHandle === undefined) && (missing0 = "payloadHandle"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(((((((key0 === "manifest") || (key0 === "versionNumber")) || (key0 === "versionCount")) || (key0 === "naturalSize")) || (key0 === "pdfPreview")) || (key0 === "payloadHandle")) || (key0 === "payload"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.manifest !== undefined){const _errs4: any = errors;if(!(validateArtifactManifest.call(this, data.manifest, {instancePath:instancePath+"/manifest",parentData:data,parentDataProperty:"manifest",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactManifest.errors : vErrors.concat(validateArtifactManifest.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.versionNumber !== undefined){let data1: any = data.versionNumber;const _errs5: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){const err2: any = {instancePath:instancePath+"/versionNumber",schemaPath:"#/anyOf/0/properties/versionNumber/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(errors === _errs5){if((typeof data1 == "number") && (isFinite(data1))){const vSchema0: any = data && data.versionCount;if(vSchema0 !== undefined && ((!((typeof vSchema0 == "number") && (isFinite(vSchema0)))) || (data1 > vSchema0 || isNaN(data1)))){const err3: any = {instancePath:instancePath+"/versionNumber",schemaPath:"#/anyOf/0/properties/versionNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: vSchema0}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(data1 < 1 || isNaN(data1)){const err4: any = {instancePath:instancePath+"/versionNumber",schemaPath:"#/anyOf/0/properties/versionNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}}}var valid1: any = _errs5 === errors;}else {var valid1: any = true;}if(valid1){if(data.versionCount !== undefined){let data2: any = data.versionCount;const _errs7: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){const err5: any = {instancePath:instancePath+"/versionCount",schemaPath:"#/anyOf/0/properties/versionCount/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}if(errors === _errs7){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){const err6: any = {instancePath:instancePath+"/versionCount",schemaPath:"#/anyOf/0/properties/versionCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {if(data2 < 1 || isNaN(data2)){const err7: any = {instancePath:instancePath+"/versionCount",schemaPath:"#/anyOf/0/properties/versionCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}}}var valid1: any = _errs7 === errors;}else {var valid1: any = true;}if(valid1){if(data.naturalSize !== undefined){const _errs9: any = errors;if(!(validateArtifactPictureSize.call(this, data.naturalSize, {instancePath:instancePath+"/naturalSize",parentData:data,parentDataProperty:"naturalSize",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactPictureSize.errors : vErrors.concat(validateArtifactPictureSize.errors);errors = vErrors.length;}var valid1: any = _errs9 === errors;}else {var valid1: any = true;}if(valid1){if(data.pdfPreview !== undefined){const _errs10: any = errors;if(!(validateArtifactPdfPreview.call(this, data.pdfPreview, {instancePath:instancePath+"/pdfPreview",parentData:data,parentDataProperty:"pdfPreview",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactPdfPreview.errors : vErrors.concat(validateArtifactPdfPreview.errors);errors = vErrors.length;}var valid1: any = _errs10 === errors;}else {var valid1: any = true;}if(valid1){if(data.payloadHandle !== undefined){let data5: any = data.payloadHandle;const _errs11: any = errors;if(errors === _errs11){if(typeof data5 === "string"){if(func1(data5) < 1){const err8: any = {instancePath:instancePath+"/payloadHandle",schemaPath:"#/anyOf/0/properties/payloadHandle/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}else {const err9: any = {instancePath:instancePath+"/payloadHandle",schemaPath:"#/anyOf/0/properties/payloadHandle/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}var valid1: any = _errs11 === errors;}else {var valid1: any = true;}if(valid1){if(data.payload !== undefined){const _errs13: any = errors;const err10: any = {instancePath:instancePath+"/payload",schemaPath:"#/anyOf/0/properties/payload/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;var valid1: any = _errs13 === errors;}else {var valid1: any = true;}}}}}}}}}}else {const err11: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs16: any = errors;if(errors === _errs16){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.manifest === undefined) && (missing1 = "manifest")) || ((data.versionNumber === undefined) && (missing1 = "versionNumber"))) || ((data.versionCount === undefined) && (missing1 = "versionCount"))) || ((data.payload === undefined) && (missing1 = "payload"))){const err12: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}else {const _errs18: any = errors;for(const key1 in data){if(!(((((((key1 === "manifest") || (key1 === "versionNumber")) || (key1 === "versionCount")) || (key1 === "naturalSize")) || (key1 === "pdfPreview")) || (key1 === "payloadHandle")) || (key1 === "payload"))){const err13: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;break;}}if(_errs18 === errors){if(data.manifest !== undefined){const _errs19: any = errors;if(!(validateArtifactManifest.call(this, data.manifest, {instancePath:instancePath+"/manifest",parentData:data,parentDataProperty:"manifest",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactManifest.errors : vErrors.concat(validateArtifactManifest.errors);errors = vErrors.length;}var valid2: any = _errs19 === errors;}else {var valid2: any = true;}if(valid2){if(data.versionNumber !== undefined){let data8: any = data.versionNumber;const _errs20: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){const err14: any = {instancePath:instancePath+"/versionNumber",schemaPath:"#/anyOf/1/properties/versionNumber/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}if(errors === _errs20){if((typeof data8 == "number") && (isFinite(data8))){const vSchema1: any = data && data.versionCount;if(vSchema1 !== undefined && ((!((typeof vSchema1 == "number") && (isFinite(vSchema1)))) || (data8 > vSchema1 || isNaN(data8)))){const err15: any = {instancePath:instancePath+"/versionNumber",schemaPath:"#/anyOf/1/properties/versionNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: vSchema1}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}else {if(data8 < 1 || isNaN(data8)){const err16: any = {instancePath:instancePath+"/versionNumber",schemaPath:"#/anyOf/1/properties/versionNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}}}var valid2: any = _errs20 === errors;}else {var valid2: any = true;}if(valid2){if(data.versionCount !== undefined){let data9: any = data.versionCount;const _errs22: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){const err17: any = {instancePath:instancePath+"/versionCount",schemaPath:"#/anyOf/1/properties/versionCount/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}if(errors === _errs22){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){const err18: any = {instancePath:instancePath+"/versionCount",schemaPath:"#/anyOf/1/properties/versionCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}else {if(data9 < 1 || isNaN(data9)){const err19: any = {instancePath:instancePath+"/versionCount",schemaPath:"#/anyOf/1/properties/versionCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}}}}var valid2: any = _errs22 === errors;}else {var valid2: any = true;}if(valid2){if(data.naturalSize !== undefined){const _errs24: any = errors;if(!(validateArtifactPictureSize.call(this, data.naturalSize, {instancePath:instancePath+"/naturalSize",parentData:data,parentDataProperty:"naturalSize",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactPictureSize.errors : vErrors.concat(validateArtifactPictureSize.errors);errors = vErrors.length;}var valid2: any = _errs24 === errors;}else {var valid2: any = true;}if(valid2){if(data.pdfPreview !== undefined){const _errs25: any = errors;if(!(validateArtifactPdfPreview.call(this, data.pdfPreview, {instancePath:instancePath+"/pdfPreview",parentData:data,parentDataProperty:"pdfPreview",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactPdfPreview.errors : vErrors.concat(validateArtifactPdfPreview.errors);errors = vErrors.length;}var valid2: any = _errs25 === errors;}else {var valid2: any = true;}if(valid2){if(data.payloadHandle !== undefined){let data12: any = data.payloadHandle;const _errs26: any = errors;if(errors === _errs26){if(typeof data12 === "string"){if(func1(data12) < 1){const err20: any = {instancePath:instancePath+"/payloadHandle",schemaPath:"#/anyOf/1/properties/payloadHandle/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}}else {const err21: any = {instancePath:instancePath+"/payloadHandle",schemaPath:"#/anyOf/1/properties/payloadHandle/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}}var valid2: any = _errs26 === errors;}else {var valid2: any = true;}if(valid2){if(data.payload !== undefined){let data13: any = data.payload;const _errs28: any = errors;if(!(validateBytes.call(this, data13, {instancePath:instancePath+"/payload",parentData:data,parentDataProperty:"payload",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBytes.errors : vErrors.concat(validateBytes.errors);errors = vErrors.length;}else {if(!(data13 && typeof data13 == "object" && Number.isInteger(data13.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data13.$bytes] instanceof Uint8Array && this.attachments[data13.$bytes].byteLength <= 4194300)){const err22: any = {instancePath:instancePath+"/payload",schemaPath:"#/anyOf/1/properties/payload/maxBytes",keyword:"maxBytes",params:{}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}}var valid2: any = _errs28 === errors;}else {var valid2: any = true;}}}}}}}}}}else {const err23: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}}var _valid0: any = _errs16 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err24: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;validateArtifactReadResponse.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateArtifactReadResponse.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateArtifactReadResponse.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
