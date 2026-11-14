// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Importing a provider's own conversations into the sessions list.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import { type PlacedPath, type WslPlace, validatePlacedPath, validateWslPlace } from "../place.js";
import { type ProviderId, validateProviderId } from "./id.js";

/** The longest import id. */
export const PROVIDER_IMPORT_ID_MAX_LEN = 256 as const;

/** The longest reason text. */
export const PROVIDER_IMPORT_REASON_MAX_LEN = 1024 as const;

/** The longest project name in a settled line. */
export const PROVIDER_IMPORT_PROJECT_NAME_MAX_LEN = 256 as const;

/** The most failures, unreadable files or attached projects one settled line may list. */
export const PROVIDER_IMPORT_LIST_MAX = 10000 as const;

/**
 * The daemon-minted id of one import, opaque to every client.
 */
export type ProviderImportId = string & { readonly __brand: "ProviderImportId" };
/**
 * How an import ended. `nothingNew` still reports what was already here and what could not be
 * read, so an empty result is never blank; `stopped` leaves the sessions already read in the list.
 */
export type ProviderImportOutcome =
  | {
      outcome: "finished";
      /**
       * The conversations imported.
       */
      imported: number;
      /**
       * The conversations read.
       */
      total: number;
      /**
       * The conversations already here.
       */
      alreadyHere: number;
      /**
       * Each conversation not brought in, with its reason.
       *
       * @maxItems 10000
       */
      failures: ProviderImportFailure[];
      /**
       * The files that could not be opened, each with the distribution it is in.
       *
       * @maxItems 10000
       */
      unreadableFiles: PlacedPath[];
      /**
       * The projects the import attached.
       *
       * @maxItems 10000
       */
      attachedProjects: string[];
    }
  | {
      outcome: "nothingNew";
      /**
       * The conversations already here.
       */
      alreadyHere: number;
      /**
       * The files that could not be opened, each with the distribution it is in.
       *
       * @maxItems 10000
       */
      unreadableFiles: PlacedPath[];
    }
  | {
      outcome: "stopped";
    }
  | {
      outcome: "refused";
      /**
       * The service's own words.
       */
      reason: string;
    };
/**
 * One message on a provider's import stream: the running import's count of conversations read so
 * far, or how the last import ended.
 */
export type ProviderImportProgress =
  | {
      kind: "progress";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The import.
       */
      importId: ProviderImportId;
      /**
       * The conversations read so far.
       */
      read: number;
    }
  | {
      kind: "settled";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The import.
       */
      importId: ProviderImportId;
      /**
       * How it ended.
       */
      settlement: ProviderImportOutcome;
    };

/**
 * A request naming the provider whose conversations are imported.
 */
export interface SessionImportRequest {
  /**
   * The provider.
   */
  provider: ProviderId;
}
/**
 * How many projects the app does not have the import would attach. A count above zero is
 * confirmed before the import runs, because attaching a project trusts its folder.
 */
export interface SessionImportPreviewResponse {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The projects the import would attach.
   */
  projectsToAttach: number;
}
/**
 * The import now running for that provider: a new one, or the one already running.
 */
export interface SessionImportStartResponse {
  /**
   * The import.
   */
  importId: ProviderImportId;
}
/**
 * One conversation the import could not bring in, and the service's reason.
 */
export interface ProviderImportFailure {
  /**
   * The conversation's file.
   */
  source: string;
  /**
   * The distribution the file is in, its path in Linux form; absent elsewhere.
   */
  place?: WslPlace;
  /**
   * Why it was not brought in.
   */
  reason: string;
}
/**
 * Stop one import. The conversations already read stay in the sessions list, and the stopped
 * outcome arrives on the provider's stream; stopping a settled import changes nothing.
 */
export interface SessionImportStopRequest {
  /**
   * The import.
   */
  importId: ProviderImportId;
}

// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link ProviderImportId}. */
// prettier-ignore
export const validateProviderImportId: CompiledSchemaCheck<ProviderImportId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderImportId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderImportId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateProviderImportId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateProviderImportId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateProviderImportId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateProviderImportId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderImportId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionImportRequest}. */
// prettier-ignore
export const validateSessionImportRequest: CompiledSchemaCheck<SessionImportRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionImportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionImportRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.provider === undefined) && (missing0 = "provider")){validateSessionImportRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "provider")){validateSessionImportRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}}}}}else {validateSessionImportRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionImportRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionImportRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionImportPreviewResponse}. */
// prettier-ignore
export const validateSessionImportPreviewResponse: CompiledSchemaCheck<SessionImportPreviewResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionImportPreviewResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionImportPreviewResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.projectsToAttach === undefined) && (missing0 = "projectsToAttach"))){validateSessionImportPreviewResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "provider") || (key0 === "projectsToAttach"))){validateSessionImportPreviewResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){const _errs2: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.projectsToAttach !== undefined){let data1: any = data.projectsToAttach;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateSessionImportPreviewResponse.errors = [{instancePath:instancePath+"/projectsToAttach",schemaPath:"#/properties/projectsToAttach/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateSessionImportPreviewResponse.errors = [{instancePath:instancePath+"/projectsToAttach",schemaPath:"#/properties/projectsToAttach/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateSessionImportPreviewResponse.errors = [{instancePath:instancePath+"/projectsToAttach",schemaPath:"#/properties/projectsToAttach/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionImportPreviewResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionImportPreviewResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionImportPreviewResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionImportStartResponse}. */
// prettier-ignore
export const validateSessionImportStartResponse: CompiledSchemaCheck<SessionImportStartResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionImportStartResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionImportStartResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.importId === undefined) && (missing0 = "importId")){validateSessionImportStartResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "importId")){validateSessionImportStartResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.importId !== undefined){if(!(validateProviderImportId.call(this, data.importId, {instancePath:instancePath+"/importId",parentData:data,parentDataProperty:"importId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderImportId.errors : vErrors.concat(validateProviderImportId.errors);errors = vErrors.length;}}}}}else {validateSessionImportStartResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionImportStartResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionImportStartResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link ProviderImportFailure}. */
// prettier-ignore
export const validateProviderImportFailure: CompiledSchemaCheck<ProviderImportFailure> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderImportFailure {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderImportFailure.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.source === undefined) && (missing0 = "source")) || ((data.reason === undefined) && (missing0 = "reason"))){validateProviderImportFailure.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "source") || (key0 === "place")) || (key0 === "reason"))){validateProviderImportFailure.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.source !== undefined){let data0: any = data.source;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validateProviderImportFailure.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validateProviderImportFailure.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data0)){validateProviderImportFailure.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateProviderImportFailure.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.place !== undefined){const _errs4: any = errors;if(!(validateWslPlace.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWslPlace.errors : vErrors.concat(validateWslPlace.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data2: any = data.reason;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 1024){validateProviderImportFailure.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data2) < 1){validateProviderImportFailure.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateProviderImportFailure.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderImportFailure.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateProviderImportFailure.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderImportFailure.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderImportFailure.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderImportOutcome}. */
// prettier-ignore
export const validateProviderImportOutcome: CompiledSchemaCheck<ProviderImportOutcome> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderImportOutcome {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderImportOutcome.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.outcome;if(typeof tag0 == "string"){if(tag0 === "finished"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.outcome === undefined) && (missing0 = "outcome")) || ((data.imported === undefined) && (missing0 = "imported"))) || ((data.total === undefined) && (missing0 = "total"))) || ((data.alreadyHere === undefined) && (missing0 = "alreadyHere"))) || ((data.failures === undefined) && (missing0 = "failures"))) || ((data.unreadableFiles === undefined) && (missing0 = "unreadableFiles"))) || ((data.attachedProjects === undefined) && (missing0 = "attachedProjects"))){validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((((((key0 === "outcome") || (key0 === "imported")) || (key0 === "total")) || (key0 === "alreadyHere")) || (key0 === "failures")) || (key0 === "unreadableFiles")) || (key0 === "attachedProjects"))){validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.outcome !== undefined){let data0: any = data.outcome;const _errs5: any = errors;if(typeof data0 !== "string"){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("finished" !== data0){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/const",keyword:"const",params:{allowedValue: "finished"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.imported !== undefined){let data1: any = data.imported;const _errs7: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/imported",schemaPath:"#/oneOf/0/properties/imported/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/imported",schemaPath:"#/oneOf/0/properties/imported/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/imported",schemaPath:"#/oneOf/0/properties/imported/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.total !== undefined){let data2: any = data.total;const _errs9: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/total",schemaPath:"#/oneOf/0/properties/total/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/total",schemaPath:"#/oneOf/0/properties/total/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/total",schemaPath:"#/oneOf/0/properties/total/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.alreadyHere !== undefined){let data3: any = data.alreadyHere;const _errs11: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/alreadyHere",schemaPath:"#/oneOf/0/properties/alreadyHere/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs11){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/alreadyHere",schemaPath:"#/oneOf/0/properties/alreadyHere/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/alreadyHere",schemaPath:"#/oneOf/0/properties/alreadyHere/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.failures !== undefined){let data4: any = data.failures;const _errs13: any = errors;if(errors === _errs13){if(Array.isArray(data4)){if(data4.length > 10000){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/failures",schemaPath:"#/oneOf/0/properties/failures/maxItems",keyword:"maxItems",params:{limit: 10000}}];return false;}else {var valid3: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs15: any = errors;if(!(validateProviderImportFailure.call(this, data4[i0], {instancePath:instancePath+"/failures/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderImportFailure.errors : vErrors.concat(validateProviderImportFailure.errors);errors = vErrors.length;}var valid3: any = _errs15 === errors;if(!valid3){break;}}}}else {validateProviderImportOutcome.errors = [{instancePath:instancePath+"/failures",schemaPath:"#/oneOf/0/properties/failures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.unreadableFiles !== undefined){let data6: any = data.unreadableFiles;const _errs16: any = errors;if(errors === _errs16){if(Array.isArray(data6)){if(data6.length > 10000){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/unreadableFiles",schemaPath:"#/oneOf/0/properties/unreadableFiles/maxItems",keyword:"maxItems",params:{limit: 10000}}];return false;}else {var valid4: any = true;const len1: any = data6.length;for(let i1=0; i1<len1; i1++){const _errs18: any = errors;if(!(validatePlacedPath.call(this, data6[i1], {instancePath:instancePath+"/unreadableFiles/" + i1,parentData:data6,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlacedPath.errors : vErrors.concat(validatePlacedPath.errors);errors = vErrors.length;}var valid4: any = _errs18 === errors;if(!valid4){break;}}}}else {validateProviderImportOutcome.errors = [{instancePath:instancePath+"/unreadableFiles",schemaPath:"#/oneOf/0/properties/unreadableFiles/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.attachedProjects !== undefined){let data8: any = data.attachedProjects;const _errs19: any = errors;if(errors === _errs19){if(Array.isArray(data8)){if(data8.length > 10000){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/attachedProjects",schemaPath:"#/oneOf/0/properties/attachedProjects/maxItems",keyword:"maxItems",params:{limit: 10000}}];return false;}else {var valid5: any = true;const len2: any = data8.length;for(let i2=0; i2<len2; i2++){let data9: any = data8[i2];const _errs21: any = errors;if(errors === _errs21){if(typeof data9 === "string"){if(func1(data9) > 256){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/attachedProjects/" + i2,schemaPath:"#/oneOf/0/properties/attachedProjects/items/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data9) < 1){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/attachedProjects/" + i2,schemaPath:"#/oneOf/0/properties/attachedProjects/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data9)){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/attachedProjects/" + i2,schemaPath:"#/oneOf/0/properties/attachedProjects/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderImportOutcome.errors = [{instancePath:instancePath+"/attachedProjects/" + i2,schemaPath:"#/oneOf/0/properties/attachedProjects/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs21 === errors;if(!valid5){break;}}}}else {validateProviderImportOutcome.errors = [{instancePath:instancePath+"/attachedProjects",schemaPath:"#/oneOf/0/properties/attachedProjects/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs19 === errors;}else {var valid2: any = true;}}}}}}}}}}else {validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "nothingNew"){const _errs23: any = errors;if(errors === _errs23){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.outcome === undefined) && (missing1 = "outcome")) || ((data.alreadyHere === undefined) && (missing1 = "alreadyHere"))) || ((data.unreadableFiles === undefined) && (missing1 = "unreadableFiles"))){validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs25: any = errors;for(const key1 in data){if(!(((key1 === "outcome") || (key1 === "alreadyHere")) || (key1 === "unreadableFiles"))){validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs25 === errors){if(data.outcome !== undefined){let data10: any = data.outcome;const _errs26: any = errors;if(typeof data10 !== "string"){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("nothingNew" !== data10){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/const",keyword:"const",params:{allowedValue: "nothingNew"}}];return false;}var valid7: any = _errs26 === errors;}else {var valid7: any = true;}if(valid7){if(data.alreadyHere !== undefined){let data11: any = data.alreadyHere;const _errs28: any = errors;if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/alreadyHere",schemaPath:"#/oneOf/1/properties/alreadyHere/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs28){if((typeof data11 == "number") && (isFinite(data11))){if(data11 > 9007199254740991 || isNaN(data11)){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/alreadyHere",schemaPath:"#/oneOf/1/properties/alreadyHere/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data11 < 0 || isNaN(data11)){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/alreadyHere",schemaPath:"#/oneOf/1/properties/alreadyHere/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid7: any = _errs28 === errors;}else {var valid7: any = true;}if(valid7){if(data.unreadableFiles !== undefined){let data12: any = data.unreadableFiles;const _errs30: any = errors;if(errors === _errs30){if(Array.isArray(data12)){if(data12.length > 10000){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/unreadableFiles",schemaPath:"#/oneOf/1/properties/unreadableFiles/maxItems",keyword:"maxItems",params:{limit: 10000}}];return false;}else {var valid8: any = true;const len3: any = data12.length;for(let i3=0; i3<len3; i3++){const _errs32: any = errors;if(!(validatePlacedPath.call(this, data12[i3], {instancePath:instancePath+"/unreadableFiles/" + i3,parentData:data12,parentDataProperty:i3,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlacedPath.errors : vErrors.concat(validatePlacedPath.errors);errors = vErrors.length;}var valid8: any = _errs32 === errors;if(!valid8){break;}}}}else {validateProviderImportOutcome.errors = [{instancePath:instancePath+"/unreadableFiles",schemaPath:"#/oneOf/1/properties/unreadableFiles/type",keyword:"type",params:{type: "array"}}];return false;}}var valid7: any = _errs30 === errors;}else {var valid7: any = true;}}}}}}else {validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs23 === errors;if(props0 !== true){props0 = true;}valid0 = valid6;}else if(tag0 === "stopped"){const _errs33: any = errors;if(errors === _errs33){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.outcome === undefined) && (missing2 = "outcome")){validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs35: any = errors;for(const key2 in data){if(!(key2 === "outcome")){validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs35 === errors){if(data.outcome !== undefined){let data14: any = data.outcome;if(typeof data14 !== "string"){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/2/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("stopped" !== data14){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/2/properties/outcome/const",keyword:"const",params:{allowedValue: "stopped"}}];return false;}}}}}else {validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs33 === errors;if(props0 !== true){props0 = true;}valid0 = valid9;}else if(tag0 === "refused"){const _errs38: any = errors;if(errors === _errs38){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((data.outcome === undefined) && (missing3 = "outcome")) || ((data.reason === undefined) && (missing3 = "reason"))){validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs40: any = errors;for(const key3 in data){if(!((key3 === "outcome") || (key3 === "reason"))){validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs40 === errors){if(data.outcome !== undefined){let data15: any = data.outcome;const _errs41: any = errors;if(typeof data15 !== "string"){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/3/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("refused" !== data15){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/3/properties/outcome/const",keyword:"const",params:{allowedValue: "refused"}}];return false;}var valid12: any = _errs41 === errors;}else {var valid12: any = true;}if(valid12){if(data.reason !== undefined){let data16: any = data.reason;const _errs43: any = errors;if(errors === _errs43){if(typeof data16 === "string"){if(func1(data16) > 1024){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data16) < 1){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data16)){validateProviderImportOutcome.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderImportOutcome.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs43 === errors;}else {var valid12: any = true;}}}}}else {validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid11: any = _errs38 === errors;if(props0 !== true){props0 = true;}valid0 = valid11;}else {validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "outcome", tagValue: tag0}}];return false;}}else {validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "outcome", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key4 in data){if(!props0 || !props0[key4]){validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key4}}];return false;break;}}}}}else {validateProviderImportOutcome.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderImportOutcome.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderImportOutcome.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderImportProgress}. */
// prettier-ignore
export const validateProviderImportProgress: CompiledSchemaCheck<ProviderImportProgress> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderImportProgress {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderImportProgress.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "progress"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.kind === undefined) && (missing0 = "kind")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.importId === undefined) && (missing0 = "importId"))) || ((data.read === undefined) && (missing0 = "read"))){validateProviderImportProgress.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((key0 === "kind") || (key0 === "provider")) || (key0 === "importId")) || (key0 === "read"))){validateProviderImportProgress.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateProviderImportProgress.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("progress" !== data0){validateProviderImportProgress.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "progress"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.provider !== undefined){const _errs7: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.importId !== undefined){const _errs8: any = errors;if(!(validateProviderImportId.call(this, data.importId, {instancePath:instancePath+"/importId",parentData:data,parentDataProperty:"importId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderImportId.errors : vErrors.concat(validateProviderImportId.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.read !== undefined){let data3: any = data.read;const _errs9: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateProviderImportProgress.errors = [{instancePath:instancePath+"/read",schemaPath:"#/oneOf/0/properties/read/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateProviderImportProgress.errors = [{instancePath:instancePath+"/read",schemaPath:"#/oneOf/0/properties/read/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateProviderImportProgress.errors = [{instancePath:instancePath+"/read",schemaPath:"#/oneOf/0/properties/read/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}}}}}}}else {validateProviderImportProgress.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "settled"){const _errs11: any = errors;if(errors === _errs11){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.kind === undefined) && (missing1 = "kind")) || ((data.provider === undefined) && (missing1 = "provider"))) || ((data.importId === undefined) && (missing1 = "importId"))) || ((data.settlement === undefined) && (missing1 = "settlement"))){validateProviderImportProgress.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs13: any = errors;for(const key1 in data){if(!((((key1 === "kind") || (key1 === "provider")) || (key1 === "importId")) || (key1 === "settlement"))){validateProviderImportProgress.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs13 === errors){if(data.kind !== undefined){let data4: any = data.kind;const _errs14: any = errors;if(typeof data4 !== "string"){validateProviderImportProgress.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("settled" !== data4){validateProviderImportProgress.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "settled"}}];return false;}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}if(valid4){if(data.provider !== undefined){const _errs16: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}if(valid4){if(data.importId !== undefined){const _errs17: any = errors;if(!(validateProviderImportId.call(this, data.importId, {instancePath:instancePath+"/importId",parentData:data,parentDataProperty:"importId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderImportId.errors : vErrors.concat(validateProviderImportId.errors);errors = vErrors.length;}var valid4: any = _errs17 === errors;}else {var valid4: any = true;}if(valid4){if(data.settlement !== undefined){const _errs18: any = errors;if(!(validateProviderImportOutcome.call(this, data.settlement, {instancePath:instancePath+"/settlement",parentData:data,parentDataProperty:"settlement",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderImportOutcome.errors : vErrors.concat(validateProviderImportOutcome.errors);errors = vErrors.length;}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}}}}}}}else {validateProviderImportProgress.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs11 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateProviderImportProgress.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateProviderImportProgress.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateProviderImportProgress.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateProviderImportProgress.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderImportProgress.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderImportProgress.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionImportStopRequest}. */
// prettier-ignore
export const validateSessionImportStopRequest: CompiledSchemaCheck<SessionImportStopRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionImportStopRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionImportStopRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.importId === undefined) && (missing0 = "importId")){validateSessionImportStopRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "importId")){validateSessionImportStopRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.importId !== undefined){if(!(validateProviderImportId.call(this, data.importId, {instancePath:instancePath+"/importId",parentData:data,parentDataProperty:"importId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderImportId.errors : vErrors.concat(validateProviderImportId.errors);errors = vErrors.length;}}}}}else {validateSessionImportStopRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionImportStopRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionImportStopRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link SESSION_IMPORT_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionImportMethodDescriptors {
  readonly "session.import.preview": {
    readonly method: "session.import.preview";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionImportRequest>;
    readonly responseCheck: SchemaCheck<SessionImportPreviewResponse>;
  };
  readonly "session.import.start": {
    readonly method: "session.import.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionImportRequest>;
    readonly responseCheck: SchemaCheck<SessionImportStartResponse>;
  };
  readonly "session.import.subscribe": {
    readonly method: "session.import.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionImportRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<ProviderImportProgress>;
  };
  readonly "session.import.stop": {
    readonly method: "session.import.stop";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionImportStopRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The four import methods: their names, how each answers, and their shapes. */
export const SESSION_IMPORT_METHOD_DESCRIPTORS: SessionImportMethodDescriptors = Object.freeze({
  "session.import.preview": Object.freeze({
    method: "session.import.preview",
    procedureType: "query",
    mutating: false,
    requestCheck: validateSessionImportRequest,
    responseCheck: validateSessionImportPreviewResponse,
  }),
  "session.import.start": Object.freeze({
    method: "session.import.start",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionImportRequest,
    responseCheck: validateSessionImportStartResponse,
  }),
  "session.import.subscribe": Object.freeze({
    method: "session.import.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateSessionImportRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateProviderImportProgress,
  }),
  "session.import.stop": Object.freeze({
    method: "session.import.stop",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionImportStopRequest,
    responseCheck: validateEmptyPayload,
  }),
});
