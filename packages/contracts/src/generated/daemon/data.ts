// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Everything the service keeps for the person: the data folder, and the two acts on it, export and erase.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type KeychainRefusalCause, validateKeychainRefusalCause } from "../keychain.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import { type ProviderAccountId, validateProviderAccountId } from "../provider/account/record.js";
import { type ProviderId, validateProviderId } from "../provider/id.js";

/**
 * The service's data folder, inside the person's home folder: its database, the machine's
 * settings and every other file it keeps.
 */
export const DAEMON_DATA_FOLDER_NAME = ".ai-sidekicks" as const;

/**
 * The id of one export job, minted by the service.
 */
export type DataExportJobId = string & { readonly __brand: "DataExportJobId" };
/**
 * Where an export stands, told apart by its `state`. A running export exports one session at a
 * time, so it counts sessions, never past its total.
 */
export type DataExportProgress =
  | {
      state: "running";
      /**
       * The sessions exported so far; never more than `sessionsTotal`.
       */
      sessionsExported: number;
      /**
       * The sessions the export holds.
       */
      sessionsTotal: number;
    }
  | {
      state: "completed";
      /**
       * The folder written.
       */
      path: string;
      /**
       * The sessions exported.
       */
      sessionsExported: number;
      /**
       * Its size in bytes.
       */
      totalBytes: number;
    }
  | {
      state: "failed";
      /**
       * The cause.
       */
      message: string;
    }
  | {
      state: "canceled";
      /**
       * The folder the export was writing.
       */
      path: string;
    };
/**
 * Why the erase left an account signed in with its provider: no registered provider runs its
 * sign-out (`noProvider`), the provider's own sign-out failed or was refused (`refused`), or it
 * did not end within its bound (`timedOut`).
 */
export type DataEraseSignOutFailure = "noProvider" | "refused" | "timedOut";
/**
 * How an account the erase left signed in stood on the account list: listed there (`listed`),
 * removed from it, its home kept (`removed`), or minted by a sign-in that did not finish, so it
 * never reached the list (`signInUnfinished`).
 */
export type DataEraseAccountListing = "listed" | "removed" | "signInUnfinished";

/**
 * Starts an export into a new folder. `destination` is the folder's path: the one the platform's
 * save dialog picked, which the desktop app's main process turns from its token into a path, or
 * the one typed on the command line.
 */
export interface DaemonDataExportStartRequest {
  /**
   * The new folder's path.
   */
  destination: string;
}
/**
 * The export job the request started; its progress streams on `daemon.dataExport.subscribe`.
 */
export interface DaemonDataExportStartResponse {
  /**
   * The job.
   */
  jobId: DataExportJobId;
}
/**
 * The export job whose progress to stream.
 */
export interface DaemonDataExportSubscribeRequest {
  /**
   * The job.
   */
  jobId: DataExportJobId;
}
/**
 * The export job to stop. A job already finished stays as it ended.
 */
export interface DaemonDataExportCancelRequest {
  /**
   * The job.
   */
  jobId: DataExportJobId;
}
/**
 * The details of `daemon.dataExport.alreadyRunning`: the export that runs now.
 */
export interface DaemonDataExportAlreadyRunningDetails {
  /**
   * The running job.
   */
  jobId: DataExportJobId;
}
/**
 * The details of `daemon.dataExport.destination.notWritable`: the folder that could not be made.
 */
export interface DaemonDataExportDestinationNotWritableDetails {
  /**
   * The folder.
   */
  path: string;
}
/**
 * The details of `daemon.data.storeUnavailable`: why the keychain the erase must empty could not
 * be used. The erase is refused before anything is erased, so it can be sent again.
 */
export interface DaemonDataStoreUnavailableDetails {
  /**
   * Why the keychain could not be used: `locked`, or it cannot be used (`unavailable`).
   */
  cause: KeychainRefusalCause;
}
/**
 * An account the erase could not sign out, which stays signed in with its provider once its home
 * is deleted.
 */
export interface DataEraseSignedInAccount {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
  /**
   * The account's provider, named here since a removed account has no row to name it.
   */
  provider: ProviderId;
  /**
   * How the account stood on the account list.
   */
  listing: DataEraseAccountListing;
  /**
   * Why it was not signed out.
   */
  cause: DataEraseSignOutFailure;
}
/**
 * The erase's answer, sent once every account's sign-out has ended and the sessions' folders on
 * other volumes were removed, and before the work stops; the rest of the erase follows it.
 */
export interface DaemonDataEraseResponse {
  /**
   * Each account left signed in with its provider, with why; empty when every one signed out.
   */
  signedInAccounts: DataEraseSignedInAccount[];
  /**
   * Whether the account list could not all be read: none was signed out where it could not be
   * read at all, and a row naming no valid account or provider id was left signed in while the
   * rest were signed out.
   */
  isAccountListUnread: boolean;
  /**
   * Each session's own folder on another volume that stays once the data folder is gone, its
   * volume not connected or its removal refused; empty when every one went.
   */
  volumeFoldersLeft: string[];
  /**
   * Whether the sessions' folders on other volumes could not be read, so none was removed.
   */
  isVolumeFolderListUnread: boolean;
}

// prettier-ignore
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link DataExportJobId}. */
// prettier-ignore
export const validateDataExportJobId: CompiledSchemaCheck<DataExportJobId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DataExportJobId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDataExportJobId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateDataExportJobId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateDataExportJobId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateDataExportJobId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDataExportJobId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link DaemonDataExportStartRequest}. */
// prettier-ignore
export const validateDaemonDataExportStartRequest: CompiledSchemaCheck<DaemonDataExportStartRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataExportStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonDataExportStartRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.destination === undefined) && (missing0 = "destination")){validateDaemonDataExportStartRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "destination")){validateDaemonDataExportStartRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.destination !== undefined){let data0: any = data.destination;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validateDaemonDataExportStartRequest.errors = [{instancePath:instancePath+"/destination",schemaPath:"#/properties/destination/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validateDaemonDataExportStartRequest.errors = [{instancePath:instancePath+"/destination",schemaPath:"#/properties/destination/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data0)){validateDaemonDataExportStartRequest.errors = [{instancePath:instancePath+"/destination",schemaPath:"#/properties/destination/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateDaemonDataExportStartRequest.errors = [{instancePath:instancePath+"/destination",schemaPath:"#/properties/destination/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateDaemonDataExportStartRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonDataExportStartRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonDataExportStartRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonDataExportStartResponse}. */
// prettier-ignore
export const validateDaemonDataExportStartResponse: CompiledSchemaCheck<DaemonDataExportStartResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataExportStartResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonDataExportStartResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.jobId === undefined) && (missing0 = "jobId")){validateDaemonDataExportStartResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "jobId")){validateDaemonDataExportStartResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.jobId !== undefined){if(!(validateDataExportJobId.call(this, data.jobId, {instancePath:instancePath+"/jobId",parentData:data,parentDataProperty:"jobId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDataExportJobId.errors : vErrors.concat(validateDataExportJobId.errors);errors = vErrors.length;}}}}}else {validateDaemonDataExportStartResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonDataExportStartResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonDataExportStartResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonDataExportSubscribeRequest}. */
// prettier-ignore
export const validateDaemonDataExportSubscribeRequest: CompiledSchemaCheck<DaemonDataExportSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataExportSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonDataExportSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.jobId === undefined) && (missing0 = "jobId")){validateDaemonDataExportSubscribeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "jobId")){validateDaemonDataExportSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.jobId !== undefined){if(!(validateDataExportJobId.call(this, data.jobId, {instancePath:instancePath+"/jobId",parentData:data,parentDataProperty:"jobId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDataExportJobId.errors : vErrors.concat(validateDataExportJobId.errors);errors = vErrors.length;}}}}}else {validateDaemonDataExportSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonDataExportSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonDataExportSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonDataExportCancelRequest}. */
// prettier-ignore
export const validateDaemonDataExportCancelRequest: CompiledSchemaCheck<DaemonDataExportCancelRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataExportCancelRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonDataExportCancelRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.jobId === undefined) && (missing0 = "jobId")){validateDaemonDataExportCancelRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "jobId")){validateDaemonDataExportCancelRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.jobId !== undefined){if(!(validateDataExportJobId.call(this, data.jobId, {instancePath:instancePath+"/jobId",parentData:data,parentDataProperty:"jobId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDataExportJobId.errors : vErrors.concat(validateDataExportJobId.errors);errors = vErrors.length;}}}}}else {validateDaemonDataExportCancelRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonDataExportCancelRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonDataExportCancelRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonDataExportAlreadyRunningDetails}. */
// prettier-ignore
export const validateDaemonDataExportAlreadyRunningDetails: CompiledSchemaCheck<DaemonDataExportAlreadyRunningDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataExportAlreadyRunningDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonDataExportAlreadyRunningDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.jobId === undefined) && (missing0 = "jobId")){validateDaemonDataExportAlreadyRunningDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "jobId")){validateDaemonDataExportAlreadyRunningDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.jobId !== undefined){if(!(validateDataExportJobId.call(this, data.jobId, {instancePath:instancePath+"/jobId",parentData:data,parentDataProperty:"jobId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDataExportJobId.errors : vErrors.concat(validateDataExportJobId.errors);errors = vErrors.length;}}}}}else {validateDaemonDataExportAlreadyRunningDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonDataExportAlreadyRunningDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonDataExportAlreadyRunningDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonDataExportDestinationNotWritableDetails}. */
// prettier-ignore
export const validateDaemonDataExportDestinationNotWritableDetails: CompiledSchemaCheck<DaemonDataExportDestinationNotWritableDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataExportDestinationNotWritableDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonDataExportDestinationNotWritableDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.path === undefined) && (missing0 = "path")){validateDaemonDataExportDestinationNotWritableDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "path")){validateDaemonDataExportDestinationNotWritableDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.path !== undefined){let data0: any = data.path;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validateDaemonDataExportDestinationNotWritableDetails.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validateDaemonDataExportDestinationNotWritableDetails.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data0)){validateDaemonDataExportDestinationNotWritableDetails.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateDaemonDataExportDestinationNotWritableDetails.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateDaemonDataExportDestinationNotWritableDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonDataExportDestinationNotWritableDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonDataExportDestinationNotWritableDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link DataExportProgress}. */
// prettier-ignore
export const validateDataExportProgress: CompiledSchemaCheck<DataExportProgress> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DataExportProgress {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDataExportProgress.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "running"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.state === undefined) && (missing0 = "state")) || ((data.sessionsExported === undefined) && (missing0 = "sessionsExported"))) || ((data.sessionsTotal === undefined) && (missing0 = "sessionsTotal"))){validateDataExportProgress.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((key0 === "state") || (key0 === "sessionsExported")) || (key0 === "sessionsTotal"))){validateDataExportProgress.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.state !== undefined){let data0: any = data.state;const _errs5: any = errors;if(typeof data0 !== "string"){validateDataExportProgress.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("running" !== data0){validateDataExportProgress.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "running"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionsExported !== undefined){let data1: any = data.sessionsExported;const _errs7: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateDataExportProgress.errors = [{instancePath:instancePath+"/sessionsExported",schemaPath:"#/oneOf/0/properties/sessionsExported/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data1 == "number") && (isFinite(data1))){const vSchema0: any = data && data.sessionsTotal;if(vSchema0 !== undefined && ((!((typeof vSchema0 == "number") && (isFinite(vSchema0)))) || (data1 > vSchema0 || isNaN(data1)))){validateDataExportProgress.errors = [{instancePath:instancePath+"/sessionsExported",schemaPath:"#/oneOf/0/properties/sessionsExported/maximum",keyword:"maximum",params:{comparison: "<=", limit: vSchema0}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateDataExportProgress.errors = [{instancePath:instancePath+"/sessionsExported",schemaPath:"#/oneOf/0/properties/sessionsExported/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionsTotal !== undefined){let data2: any = data.sessionsTotal;const _errs9: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateDataExportProgress.errors = [{instancePath:instancePath+"/sessionsTotal",schemaPath:"#/oneOf/0/properties/sessionsTotal/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateDataExportProgress.errors = [{instancePath:instancePath+"/sessionsTotal",schemaPath:"#/oneOf/0/properties/sessionsTotal/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateDataExportProgress.errors = [{instancePath:instancePath+"/sessionsTotal",schemaPath:"#/oneOf/0/properties/sessionsTotal/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}}}}}}else {validateDataExportProgress.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "completed"){const _errs11: any = errors;if(errors === _errs11){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.state === undefined) && (missing1 = "state")) || ((data.path === undefined) && (missing1 = "path"))) || ((data.sessionsExported === undefined) && (missing1 = "sessionsExported"))) || ((data.totalBytes === undefined) && (missing1 = "totalBytes"))){validateDataExportProgress.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs13: any = errors;for(const key1 in data){if(!((((key1 === "state") || (key1 === "path")) || (key1 === "sessionsExported")) || (key1 === "totalBytes"))){validateDataExportProgress.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs13 === errors){if(data.state !== undefined){let data3: any = data.state;const _errs14: any = errors;if(typeof data3 !== "string"){validateDataExportProgress.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("completed" !== data3){validateDataExportProgress.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "completed"}}];return false;}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}if(valid4){if(data.path !== undefined){let data4: any = data.path;const _errs16: any = errors;if(errors === _errs16){if(typeof data4 === "string"){if(func1(data4) > 4096){validateDataExportProgress.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data4) < 1){validateDataExportProgress.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data4)){validateDataExportProgress.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateDataExportProgress.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}if(valid4){if(data.sessionsExported !== undefined){let data5: any = data.sessionsExported;const _errs18: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validateDataExportProgress.errors = [{instancePath:instancePath+"/sessionsExported",schemaPath:"#/oneOf/1/properties/sessionsExported/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs18){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validateDataExportProgress.errors = [{instancePath:instancePath+"/sessionsExported",schemaPath:"#/oneOf/1/properties/sessionsExported/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validateDataExportProgress.errors = [{instancePath:instancePath+"/sessionsExported",schemaPath:"#/oneOf/1/properties/sessionsExported/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data.totalBytes !== undefined){let data6: any = data.totalBytes;const _errs20: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validateDataExportProgress.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/oneOf/1/properties/totalBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs20){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validateDataExportProgress.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/oneOf/1/properties/totalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 0 || isNaN(data6)){validateDataExportProgress.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/oneOf/1/properties/totalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid4: any = _errs20 === errors;}else {var valid4: any = true;}}}}}}}else {validateDataExportProgress.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs11 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "failed"){const _errs22: any = errors;if(errors === _errs22){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.state === undefined) && (missing2 = "state")) || ((data.message === undefined) && (missing2 = "message"))){validateDataExportProgress.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs24: any = errors;for(const key2 in data){if(!((key2 === "state") || (key2 === "message"))){validateDataExportProgress.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs24 === errors){if(data.state !== undefined){let data7: any = data.state;const _errs25: any = errors;if(typeof data7 !== "string"){validateDataExportProgress.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data7){validateDataExportProgress.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}var valid6: any = _errs25 === errors;}else {var valid6: any = true;}if(valid6){if(data.message !== undefined){let data8: any = data.message;const _errs27: any = errors;if(errors === _errs27){if(typeof data8 === "string"){if(func1(data8) > 8192){validateDataExportProgress.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/2/properties/message/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data8) < 1){validateDataExportProgress.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/2/properties/message/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data8)){validateDataExportProgress.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/2/properties/message/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDataExportProgress.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/2/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs27 === errors;}else {var valid6: any = true;}}}}}else {validateDataExportProgress.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs22 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else if(tag0 === "canceled"){const _errs29: any = errors;if(errors === _errs29){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((data.state === undefined) && (missing3 = "state")) || ((data.path === undefined) && (missing3 = "path"))){validateDataExportProgress.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs31: any = errors;for(const key3 in data){if(!((key3 === "state") || (key3 === "path"))){validateDataExportProgress.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs31 === errors){if(data.state !== undefined){let data9: any = data.state;const _errs32: any = errors;if(typeof data9 !== "string"){validateDataExportProgress.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("canceled" !== data9){validateDataExportProgress.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/const",keyword:"const",params:{allowedValue: "canceled"}}];return false;}var valid8: any = _errs32 === errors;}else {var valid8: any = true;}if(valid8){if(data.path !== undefined){let data10: any = data.path;const _errs34: any = errors;if(errors === _errs34){if(typeof data10 === "string"){if(func1(data10) > 4096){validateDataExportProgress.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/3/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data10) < 1){validateDataExportProgress.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/3/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data10)){validateDataExportProgress.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/3/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateDataExportProgress.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/3/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs34 === errors;}else {var valid8: any = true;}}}}}else {validateDataExportProgress.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs29 === errors;if(props0 !== true){props0 = true;}valid0 = valid7;}else {validateDataExportProgress.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validateDataExportProgress.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key4 in data){if(!props0 || !props0[key4]){validateDataExportProgress.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key4}}];return false;break;}}}}}else {validateDataExportProgress.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDataExportProgress.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDataExportProgress.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonDataStoreUnavailableDetails}. */
// prettier-ignore
export const validateDaemonDataStoreUnavailableDetails: CompiledSchemaCheck<DaemonDataStoreUnavailableDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataStoreUnavailableDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonDataStoreUnavailableDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cause === undefined) && (missing0 = "cause")){validateDaemonDataStoreUnavailableDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cause")){validateDaemonDataStoreUnavailableDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cause !== undefined){if(!(validateKeychainRefusalCause.call(this, data.cause, {instancePath:instancePath+"/cause",parentData:data,parentDataProperty:"cause",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateKeychainRefusalCause.errors : vErrors.concat(validateKeychainRefusalCause.errors);errors = vErrors.length;}}}}}else {validateDaemonDataStoreUnavailableDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonDataStoreUnavailableDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonDataStoreUnavailableDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema251: any = {"description":"Why the erase left an account signed in with its provider: no registered provider runs its\nsign-out (`noProvider`), the provider's own sign-out failed or was refused (`refused`), or it\ndid not end within its bound (`timedOut`).","type":"string","enum":["noProvider","refused","timedOut"]};
/** Checks that a value is a {@link DataEraseSignOutFailure}. */
// prettier-ignore
export const validateDataEraseSignOutFailure: CompiledSchemaCheck<DataEraseSignOutFailure> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DataEraseSignOutFailure {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDataEraseSignOutFailure.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateDataEraseSignOutFailure.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "noProvider") || (data === "refused")) || (data === "timedOut"))){validateDataEraseSignOutFailure.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema251.enum}}];return false;}validateDataEraseSignOutFailure.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDataEraseSignOutFailure.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema250: any = {"description":"How an account the erase left signed in stood on the account list: listed there (`listed`),\nremoved from it, its home kept (`removed`), or minted by a sign-in that did not finish, so it\nnever reached the list (`signInUnfinished`).","type":"string","enum":["listed","removed","signInUnfinished"]};
/** Checks that a value is a {@link DataEraseAccountListing}. */
// prettier-ignore
export const validateDataEraseAccountListing: CompiledSchemaCheck<DataEraseAccountListing> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DataEraseAccountListing {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDataEraseAccountListing.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateDataEraseAccountListing.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "listed") || (data === "removed")) || (data === "signInUnfinished"))){validateDataEraseAccountListing.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema250.enum}}];return false;}validateDataEraseAccountListing.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDataEraseAccountListing.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DataEraseSignedInAccount}. */
// prettier-ignore
export const validateDataEraseSignedInAccount: CompiledSchemaCheck<DataEraseSignedInAccount> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DataEraseSignedInAccount {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDataEraseSignedInAccount.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.accountId === undefined) && (missing0 = "accountId")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.listing === undefined) && (missing0 = "listing"))) || ((data.cause === undefined) && (missing0 = "cause"))){validateDataEraseSignedInAccount.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "accountId") || (key0 === "provider")) || (key0 === "listing")) || (key0 === "cause"))){validateDataEraseSignedInAccount.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accountId !== undefined){const _errs2: any = errors;if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){const _errs3: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.listing !== undefined){const _errs4: any = errors;if(!(validateDataEraseAccountListing.call(this, data.listing, {instancePath:instancePath+"/listing",parentData:data,parentDataProperty:"listing",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDataEraseAccountListing.errors : vErrors.concat(validateDataEraseAccountListing.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.cause !== undefined){const _errs5: any = errors;if(!(validateDataEraseSignOutFailure.call(this, data.cause, {instancePath:instancePath+"/cause",parentData:data,parentDataProperty:"cause",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDataEraseSignOutFailure.errors : vErrors.concat(validateDataEraseSignOutFailure.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validateDataEraseSignedInAccount.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDataEraseSignedInAccount.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDataEraseSignedInAccount.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonDataEraseResponse}. */
// prettier-ignore
export const validateDaemonDataEraseResponse: CompiledSchemaCheck<DaemonDataEraseResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataEraseResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonDataEraseResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.signedInAccounts === undefined) && (missing0 = "signedInAccounts")) || ((data.isAccountListUnread === undefined) && (missing0 = "isAccountListUnread"))) || ((data.volumeFoldersLeft === undefined) && (missing0 = "volumeFoldersLeft"))) || ((data.isVolumeFolderListUnread === undefined) && (missing0 = "isVolumeFolderListUnread"))){validateDaemonDataEraseResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "signedInAccounts") || (key0 === "isAccountListUnread")) || (key0 === "volumeFoldersLeft")) || (key0 === "isVolumeFolderListUnread"))){validateDaemonDataEraseResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.signedInAccounts !== undefined){let data0: any = data.signedInAccounts;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateDataEraseSignedInAccount.call(this, data0[i0], {instancePath:instancePath+"/signedInAccounts/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDataEraseSignedInAccount.errors : vErrors.concat(validateDataEraseSignedInAccount.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateDaemonDataEraseResponse.errors = [{instancePath:instancePath+"/signedInAccounts",schemaPath:"#/properties/signedInAccounts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.isAccountListUnread !== undefined){const _errs5: any = errors;if(typeof data.isAccountListUnread !== "boolean"){validateDaemonDataEraseResponse.errors = [{instancePath:instancePath+"/isAccountListUnread",schemaPath:"#/properties/isAccountListUnread/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.volumeFoldersLeft !== undefined){let data3: any = data.volumeFoldersLeft;const _errs7: any = errors;if(errors === _errs7){if(Array.isArray(data3)){var valid2: any = true;const len1: any = data3.length;for(let i1=0; i1<len1; i1++){let data4: any = data3[i1];const _errs9: any = errors;if(errors === _errs9){if(typeof data4 === "string"){if(func1(data4) > 4096){validateDaemonDataEraseResponse.errors = [{instancePath:instancePath+"/volumeFoldersLeft/" + i1,schemaPath:"#/properties/volumeFoldersLeft/items/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data4) < 1){validateDaemonDataEraseResponse.errors = [{instancePath:instancePath+"/volumeFoldersLeft/" + i1,schemaPath:"#/properties/volumeFoldersLeft/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data4)){validateDaemonDataEraseResponse.errors = [{instancePath:instancePath+"/volumeFoldersLeft/" + i1,schemaPath:"#/properties/volumeFoldersLeft/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateDaemonDataEraseResponse.errors = [{instancePath:instancePath+"/volumeFoldersLeft/" + i1,schemaPath:"#/properties/volumeFoldersLeft/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs9 === errors;if(!valid2){break;}}}else {validateDaemonDataEraseResponse.errors = [{instancePath:instancePath+"/volumeFoldersLeft",schemaPath:"#/properties/volumeFoldersLeft/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.isVolumeFolderListUnread !== undefined){const _errs11: any = errors;if(typeof data.isVolumeFolderListUnread !== "boolean"){validateDaemonDataEraseResponse.errors = [{instancePath:instancePath+"/isVolumeFolderListUnread",schemaPath:"#/properties/isVolumeFolderListUnread/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}else {validateDaemonDataEraseResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonDataEraseResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonDataEraseResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link DAEMON_DATA_METHOD_DESCRIPTORS}, each with its checks. */
export interface DaemonDataMethodDescriptors {
  readonly "daemon.dataExport.start": {
    readonly method: "daemon.dataExport.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DaemonDataExportStartRequest>;
    readonly responseCheck: SchemaCheck<DaemonDataExportStartResponse>;
  };
  readonly "daemon.dataExport.subscribe": {
    readonly method: "daemon.dataExport.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<DaemonDataExportSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<DataExportProgress>;
  };
  readonly "daemon.dataExport.cancel": {
    readonly method: "daemon.dataExport.cancel";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DaemonDataExportCancelRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "daemon.data.erase": {
    readonly method: "daemon.data.erase";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<DaemonDataEraseResponse>;
  };
}
/**
 * The data methods. The export stream's acknowledgment is the subscription, and each
 * emission is the job's progress as it changes.
 */
export const DAEMON_DATA_METHOD_DESCRIPTORS: DaemonDataMethodDescriptors = Object.freeze({
  "daemon.dataExport.start": Object.freeze({
    method: "daemon.dataExport.start",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateDaemonDataExportStartRequest,
    responseCheck: validateDaemonDataExportStartResponse,
  }),
  "daemon.dataExport.subscribe": Object.freeze({
    method: "daemon.dataExport.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateDaemonDataExportSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateDataExportProgress,
  }),
  "daemon.dataExport.cancel": Object.freeze({
    method: "daemon.dataExport.cancel",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateDaemonDataExportCancelRequest,
    responseCheck: validateEmptyPayload,
  }),
  "daemon.data.erase": Object.freeze({
    method: "daemon.data.erase",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateDaemonDataEraseResponse,
  }),
});
