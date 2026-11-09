/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Importing a provider's own conversations into the sessions list.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import type { PlacedPath, WslPlace } from "../place.js";
import type { ProviderId } from "./id.js";

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
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate1539(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1539.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.distro === undefined) && (missing0 = "distro")){validate1539.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "distro")){validate1539.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.distro !== undefined){let data0: any = data.distro;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1539.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data0)){validate1539.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1539.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1539.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1539.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1539.errors = null as any[] | null;
// prettier-ignore
validate1539.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1538(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1538.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.source === undefined) && (missing0 = "source")) || ((data.reason === undefined) && (missing0 = "reason"))){validate1538.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "source") || (key0 === "place")) || (key0 === "reason"))){validate1538.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.source !== undefined){let data0: any = data.source;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate1538.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validate1538.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data0)){validate1538.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1538.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.place !== undefined){const _errs4: any = errors;if(!(validate1539.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1539.errors : vErrors.concat(validate1539.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data2: any = data.reason;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 1024){validate1538.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data2) < 1){validate1538.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1538.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1538.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validate1538.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1538.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1538.errors = null as any[] | null;
// prettier-ignore
validate1538.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate477(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate477.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.distro === undefined) && (missing0 = "distro")){validate477.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "distro")){validate477.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.distro !== undefined){let data0: any = data.distro;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate477.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data0)){validate477.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate477.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate477.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate477.errors = vErrors;return errors === 0;}
// prettier-ignore
validate477.errors = null as any[] | null;
// prettier-ignore
validate477.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1542(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1542.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.path === undefined) && (missing0 = "path")){validate1542.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "path") || (key0 === "place"))){validate1542.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.path !== undefined){let data0: any = data.path;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate1542.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validate1542.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data0)){validate1542.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1542.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.place !== undefined){const _errs4: any = errors;if(!(validate477.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate477.errors : vErrors.concat(validate477.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate1542.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1542.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1542.errors = null as any[] | null;
// prettier-ignore
validate1542.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1537(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1537.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate1537.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.outcome;if(typeof tag0 == "string"){if(tag0 === "finished"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.outcome === undefined) && (missing0 = "outcome")) || ((data.imported === undefined) && (missing0 = "imported"))) || ((data.total === undefined) && (missing0 = "total"))) || ((data.alreadyHere === undefined) && (missing0 = "alreadyHere"))) || ((data.failures === undefined) && (missing0 = "failures"))) || ((data.unreadableFiles === undefined) && (missing0 = "unreadableFiles"))) || ((data.attachedProjects === undefined) && (missing0 = "attachedProjects"))){validate1537.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!(((((((key1 === "outcome") || (key1 === "imported")) || (key1 === "total")) || (key1 === "alreadyHere")) || (key1 === "failures")) || (key1 === "unreadableFiles")) || (key1 === "attachedProjects"))){validate1537.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.outcome !== undefined){let data0: any = data.outcome;const _errs6: any = errors;if(typeof data0 !== "string"){validate1537.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("finished" !== data0){validate1537.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/const",keyword:"const",params:{allowedValue: "finished"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.imported !== undefined){let data1: any = data.imported;const _errs8: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1537.errors = [{instancePath:instancePath+"/imported",schemaPath:"#/oneOf/0/properties/imported/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1537.errors = [{instancePath:instancePath+"/imported",schemaPath:"#/oneOf/0/properties/imported/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate1537.errors = [{instancePath:instancePath+"/imported",schemaPath:"#/oneOf/0/properties/imported/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.total !== undefined){let data2: any = data.total;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1537.errors = [{instancePath:instancePath+"/total",schemaPath:"#/oneOf/0/properties/total/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1537.errors = [{instancePath:instancePath+"/total",schemaPath:"#/oneOf/0/properties/total/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1537.errors = [{instancePath:instancePath+"/total",schemaPath:"#/oneOf/0/properties/total/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.alreadyHere !== undefined){let data3: any = data.alreadyHere;const _errs12: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1537.errors = [{instancePath:instancePath+"/alreadyHere",schemaPath:"#/oneOf/0/properties/alreadyHere/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1537.errors = [{instancePath:instancePath+"/alreadyHere",schemaPath:"#/oneOf/0/properties/alreadyHere/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1537.errors = [{instancePath:instancePath+"/alreadyHere",schemaPath:"#/oneOf/0/properties/alreadyHere/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.failures !== undefined){let data4: any = data.failures;const _errs14: any = errors;if(errors === _errs14){if(Array.isArray(data4)){if(data4.length > 10000){validate1537.errors = [{instancePath:instancePath+"/failures",schemaPath:"#/oneOf/0/properties/failures/maxItems",keyword:"maxItems",params:{limit: 10000}}];return false;}else {var valid3: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs16: any = errors;if(!(validate1538.call(this, data4[i0], {instancePath:instancePath+"/failures/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1538.errors : vErrors.concat(validate1538.errors);errors = vErrors.length;}var valid3: any = _errs16 === errors;if(!valid3){break;}}}}else {validate1537.errors = [{instancePath:instancePath+"/failures",schemaPath:"#/oneOf/0/properties/failures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data.unreadableFiles !== undefined){let data6: any = data.unreadableFiles;const _errs17: any = errors;if(errors === _errs17){if(Array.isArray(data6)){if(data6.length > 10000){validate1537.errors = [{instancePath:instancePath+"/unreadableFiles",schemaPath:"#/oneOf/0/properties/unreadableFiles/maxItems",keyword:"maxItems",params:{limit: 10000}}];return false;}else {var valid4: any = true;const len1: any = data6.length;for(let i1=0; i1<len1; i1++){const _errs19: any = errors;if(!(validate1542.call(this, data6[i1], {instancePath:instancePath+"/unreadableFiles/" + i1,parentData:data6,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1542.errors : vErrors.concat(validate1542.errors);errors = vErrors.length;}var valid4: any = _errs19 === errors;if(!valid4){break;}}}}else {validate1537.errors = [{instancePath:instancePath+"/unreadableFiles",schemaPath:"#/oneOf/0/properties/unreadableFiles/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs17 === errors;}else {var valid2: any = true;}if(valid2){if(data.attachedProjects !== undefined){let data8: any = data.attachedProjects;const _errs20: any = errors;if(errors === _errs20){if(Array.isArray(data8)){if(data8.length > 10000){validate1537.errors = [{instancePath:instancePath+"/attachedProjects",schemaPath:"#/oneOf/0/properties/attachedProjects/maxItems",keyword:"maxItems",params:{limit: 10000}}];return false;}else {var valid5: any = true;const len2: any = data8.length;for(let i2=0; i2<len2; i2++){let data9: any = data8[i2];const _errs22: any = errors;if(errors === _errs22){if(typeof data9 === "string"){if(func1(data9) > 256){validate1537.errors = [{instancePath:instancePath+"/attachedProjects/" + i2,schemaPath:"#/oneOf/0/properties/attachedProjects/items/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data9) < 1){validate1537.errors = [{instancePath:instancePath+"/attachedProjects/" + i2,schemaPath:"#/oneOf/0/properties/attachedProjects/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data9)){validate1537.errors = [{instancePath:instancePath+"/attachedProjects/" + i2,schemaPath:"#/oneOf/0/properties/attachedProjects/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1537.errors = [{instancePath:instancePath+"/attachedProjects/" + i2,schemaPath:"#/oneOf/0/properties/attachedProjects/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs22 === errors;if(!valid5){break;}}}}else {validate1537.errors = [{instancePath:instancePath+"/attachedProjects",schemaPath:"#/oneOf/0/properties/attachedProjects/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs20 === errors;}else {var valid2: any = true;}}}}}}}}}}else {validate1537.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "nothingNew"){const _errs24: any = errors;if(errors === _errs24){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.outcome === undefined) && (missing1 = "outcome")) || ((data.alreadyHere === undefined) && (missing1 = "alreadyHere"))) || ((data.unreadableFiles === undefined) && (missing1 = "unreadableFiles"))){validate1537.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs26: any = errors;for(const key2 in data){if(!(((key2 === "outcome") || (key2 === "alreadyHere")) || (key2 === "unreadableFiles"))){validate1537.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs26 === errors){if(data.outcome !== undefined){let data10: any = data.outcome;const _errs27: any = errors;if(typeof data10 !== "string"){validate1537.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("nothingNew" !== data10){validate1537.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/const",keyword:"const",params:{allowedValue: "nothingNew"}}];return false;}var valid7: any = _errs27 === errors;}else {var valid7: any = true;}if(valid7){if(data.alreadyHere !== undefined){let data11: any = data.alreadyHere;const _errs29: any = errors;if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){validate1537.errors = [{instancePath:instancePath+"/alreadyHere",schemaPath:"#/oneOf/1/properties/alreadyHere/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs29){if((typeof data11 == "number") && (isFinite(data11))){if(data11 > 9007199254740991 || isNaN(data11)){validate1537.errors = [{instancePath:instancePath+"/alreadyHere",schemaPath:"#/oneOf/1/properties/alreadyHere/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data11 < 0 || isNaN(data11)){validate1537.errors = [{instancePath:instancePath+"/alreadyHere",schemaPath:"#/oneOf/1/properties/alreadyHere/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid7: any = _errs29 === errors;}else {var valid7: any = true;}if(valid7){if(data.unreadableFiles !== undefined){let data12: any = data.unreadableFiles;const _errs31: any = errors;if(errors === _errs31){if(Array.isArray(data12)){if(data12.length > 10000){validate1537.errors = [{instancePath:instancePath+"/unreadableFiles",schemaPath:"#/oneOf/1/properties/unreadableFiles/maxItems",keyword:"maxItems",params:{limit: 10000}}];return false;}else {var valid8: any = true;const len3: any = data12.length;for(let i3=0; i3<len3; i3++){const _errs33: any = errors;if(!(validate1542.call(this, data12[i3], {instancePath:instancePath+"/unreadableFiles/" + i3,parentData:data12,parentDataProperty:i3,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1542.errors : vErrors.concat(validate1542.errors);errors = vErrors.length;}var valid8: any = _errs33 === errors;if(!valid8){break;}}}}else {validate1537.errors = [{instancePath:instancePath+"/unreadableFiles",schemaPath:"#/oneOf/1/properties/unreadableFiles/type",keyword:"type",params:{type: "array"}}];return false;}}var valid7: any = _errs31 === errors;}else {var valid7: any = true;}}}}}}else {validate1537.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "stopped"){const _errs34: any = errors;if(errors === _errs34){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.outcome === undefined) && (missing2 = "outcome")){validate1537.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs36: any = errors;for(const key3 in data){if(!(key3 === "outcome")){validate1537.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs36 === errors){if(data.outcome !== undefined){let data14: any = data.outcome;if(typeof data14 !== "string"){validate1537.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/2/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("stopped" !== data14){validate1537.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/2/properties/outcome/const",keyword:"const",params:{allowedValue: "stopped"}}];return false;}}}}}else {validate1537.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "refused"){const _errs39: any = errors;if(errors === _errs39){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((data.outcome === undefined) && (missing3 = "outcome")) || ((data.reason === undefined) && (missing3 = "reason"))){validate1537.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs41: any = errors;for(const key4 in data){if(!((key4 === "outcome") || (key4 === "reason"))){validate1537.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs41 === errors){if(data.outcome !== undefined){let data15: any = data.outcome;const _errs42: any = errors;if(typeof data15 !== "string"){validate1537.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/3/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("refused" !== data15){validate1537.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/3/properties/outcome/const",keyword:"const",params:{allowedValue: "refused"}}];return false;}var valid12: any = _errs42 === errors;}else {var valid12: any = true;}if(valid12){if(data.reason !== undefined){let data16: any = data.reason;const _errs44: any = errors;if(errors === _errs44){if(typeof data16 === "string"){if(func1(data16) > 1024){validate1537.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data16) < 1){validate1537.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data16)){validate1537.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1537.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs44 === errors;}else {var valid12: any = true;}}}}}else {validate1537.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate1537.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "outcome", tagValue: tag0}}];return false;}}else {validate1537.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "outcome", tagValue: tag0}}];return false;}}}else {validate1537.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1537.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1537.errors = null as any[] | null;
// prettier-ignore
validate1537.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1536(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderImportProgress {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1536.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate1536.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "progress"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.kind === undefined) && (missing0 = "kind")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.importId === undefined) && (missing0 = "importId"))) || ((data.read === undefined) && (missing0 = "read"))){validate1536.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((((key1 === "kind") || (key1 === "provider")) || (key1 === "importId")) || (key1 === "read"))){validate1536.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate1536.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("progress" !== data0){validate1536.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "progress"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.provider !== undefined){let data1: any = data.provider;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern16.test(data1)){validate1536.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1536.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.importId !== undefined){let data2: any = data.importId;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data2 === "string"){if(func1(data2) > 256){validate1536.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/$defs/ProviderImportId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate1536.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/$defs/ProviderImportId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1536.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/$defs/ProviderImportId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.read !== undefined){let data3: any = data.read;const _errs16: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1536.errors = [{instancePath:instancePath+"/read",schemaPath:"#/oneOf/0/properties/read/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs16){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1536.errors = [{instancePath:instancePath+"/read",schemaPath:"#/oneOf/0/properties/read/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1536.errors = [{instancePath:instancePath+"/read",schemaPath:"#/oneOf/0/properties/read/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}}}}}}}else {validate1536.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "settled"){const _errs18: any = errors;if(errors === _errs18){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.kind === undefined) && (missing1 = "kind")) || ((data.provider === undefined) && (missing1 = "provider"))) || ((data.importId === undefined) && (missing1 = "importId"))) || ((data.settlement === undefined) && (missing1 = "settlement"))){validate1536.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs20: any = errors;for(const key2 in data){if(!((((key2 === "kind") || (key2 === "provider")) || (key2 === "importId")) || (key2 === "settlement"))){validate1536.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs20 === errors){if(data.kind !== undefined){let data4: any = data.kind;const _errs21: any = errors;if(typeof data4 !== "string"){validate1536.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("settled" !== data4){validate1536.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "settled"}}];return false;}var valid6: any = _errs21 === errors;}else {var valid6: any = true;}if(valid6){if(data.provider !== undefined){let data5: any = data.provider;const _errs23: any = errors;const _errs24: any = errors;if(errors === _errs24){if(typeof data5 === "string"){if(!pattern16.test(data5)){validate1536.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1536.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs23 === errors;}else {var valid6: any = true;}if(valid6){if(data.importId !== undefined){let data6: any = data.importId;const _errs27: any = errors;const _errs28: any = errors;if(errors === _errs28){if(typeof data6 === "string"){if(func1(data6) > 256){validate1536.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/$defs/ProviderImportId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data6) < 1){validate1536.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/$defs/ProviderImportId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1536.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/$defs/ProviderImportId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs27 === errors;}else {var valid6: any = true;}if(valid6){if(data.settlement !== undefined){const _errs31: any = errors;if(!(validate1537.call(this, data.settlement, {instancePath:instancePath+"/settlement",parentData:data,parentDataProperty:"settlement",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1537.errors : vErrors.concat(validate1537.errors);errors = vErrors.length;}var valid6: any = _errs31 === errors;}else {var valid6: any = true;}}}}}}}else {validate1536.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate1536.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1536.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate1536.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1536.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1536.errors = null as any[] | null;
// prettier-ignore
validate1536.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1547(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionImportPreviewResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1547.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.projectsToAttach === undefined) && (missing0 = "projectsToAttach"))){validate1547.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "provider") || (key0 === "projectsToAttach"))){validate1547.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1547.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1547.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.projectsToAttach !== undefined){let data1: any = data.projectsToAttach;const _errs6: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1547.errors = [{instancePath:instancePath+"/projectsToAttach",schemaPath:"#/properties/projectsToAttach/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1547.errors = [{instancePath:instancePath+"/projectsToAttach",schemaPath:"#/properties/projectsToAttach/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate1547.errors = [{instancePath:instancePath+"/projectsToAttach",schemaPath:"#/properties/projectsToAttach/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1547.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1547.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1547.errors = null as any[] | null;
// prettier-ignore
validate1547.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1548(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionImportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1548.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.provider === undefined) && (missing0 = "provider")){validate1548.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "provider")){validate1548.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1548.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1548.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1548.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1548.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1548.errors = null as any[] | null;
// prettier-ignore
validate1548.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1549(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionImportStartResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1549.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.importId === undefined) && (missing0 = "importId")){validate1549.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "importId")){validate1549.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.importId !== undefined){let data0: any = data.importId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1549.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/$defs/ProviderImportId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1549.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/$defs/ProviderImportId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1549.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/$defs/ProviderImportId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1549.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1549.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1549.errors = null as any[] | null;
// prettier-ignore
validate1549.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1550(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionImportStopRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1550.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.importId === undefined) && (missing0 = "importId")){validate1550.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "importId")){validate1550.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.importId !== undefined){let data0: any = data.importId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1550.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/$defs/ProviderImportId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1550.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/$defs/ProviderImportId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1550.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/$defs/ProviderImportId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1550.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1550.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1550.errors = null as any[] | null;
// prettier-ignore
validate1550.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderImportProgress}. */
export const validateProviderImportProgress: SchemaCheck<ProviderImportProgress> = validate1536;
/** Checks that a value is a {@link SessionImportPreviewResponse}. */
export const validateSessionImportPreviewResponse: SchemaCheck<SessionImportPreviewResponse> =
  validate1547;
/** Checks that a value is a {@link SessionImportRequest}. */
export const validateSessionImportRequest: SchemaCheck<SessionImportRequest> = validate1548;
/** Checks that a value is a {@link SessionImportStartResponse}. */
export const validateSessionImportStartResponse: SchemaCheck<SessionImportStartResponse> =
  validate1549;
/** Checks that a value is a {@link SessionImportStopRequest}. */
export const validateSessionImportStopRequest: SchemaCheck<SessionImportStopRequest> = validate1550;

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
