/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Everything the service keeps for the person: the data folder, and the two acts on it, export and erase.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import type { KeychainRefusalCause } from "../keychain.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import type { ProviderAccountId } from "../provider/account/record.js";
import type { ProviderId } from "../provider/id.js";

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
 * The erase's answer, sent once every account's sign-out has ended and before the work stops;
 * the rest of the erase follows it.
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
}

// prettier-ignore
const schema650: any = {"description":"How an account the erase left signed in stood on the account list: listed there (`listed`),\nremoved from it, its home kept (`removed`), or minted by a sign-in that did not finish, so it\nnever reached the list (`signInUnfinished`).","type":"string","enum":["listed","removed","signInUnfinished"]};
// prettier-ignore
const schema651: any = {"description":"Why the erase left an account signed in with its provider: no registered provider runs its\nsign-out (`noProvider`), the provider's own sign-out failed or was refused (`refused`), or it\ndid not end within its bound (`timedOut`).","type":"string","enum":["noProvider","refused","timedOut"]};
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
function validate334(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate334.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.accountId === undefined) && (missing0 = "accountId")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.listing === undefined) && (missing0 = "listing"))) || ((data.cause === undefined) && (missing0 = "cause"))){validate334.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "accountId") || (key0 === "provider")) || (key0 === "listing")) || (key0 === "cause"))){validate334.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accountId !== undefined){let data0: any = data.accountId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate334.errors = [{instancePath:instancePath+"/accountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate334.errors = [{instancePath:instancePath+"/accountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate334.errors = [{instancePath:instancePath+"/accountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){let data1: any = data.provider;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern16.test(data1)){validate334.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate334.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.listing !== undefined){let data2: any = data.listing;const _errs10: any = errors;if(typeof data2 !== "string"){validate334.errors = [{instancePath:instancePath+"/listing",schemaPath:"#/$defs/DataEraseAccountListing/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "listed") || (data2 === "removed")) || (data2 === "signInUnfinished"))){validate334.errors = [{instancePath:instancePath+"/listing",schemaPath:"#/$defs/DataEraseAccountListing/enum",keyword:"enum",params:{allowedValues: schema650.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.cause !== undefined){let data3: any = data.cause;const _errs13: any = errors;if(typeof data3 !== "string"){validate334.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/$defs/DataEraseSignOutFailure/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data3 === "noProvider") || (data3 === "refused")) || (data3 === "timedOut"))){validate334.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/$defs/DataEraseSignOutFailure/enum",keyword:"enum",params:{allowedValues: schema651.enum}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}}else {validate334.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate334.errors = vErrors;return errors === 0;}
// prettier-ignore
validate334.errors = null as any[] | null;
// prettier-ignore
validate334.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate333(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataEraseResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate333.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.signedInAccounts === undefined) && (missing0 = "signedInAccounts")) || ((data.isAccountListUnread === undefined) && (missing0 = "isAccountListUnread"))){validate333.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "signedInAccounts") || (key0 === "isAccountListUnread"))){validate333.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.signedInAccounts !== undefined){let data0: any = data.signedInAccounts;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate334.call(this, data0[i0], {instancePath:instancePath+"/signedInAccounts/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate334.errors : vErrors.concat(validate334.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate333.errors = [{instancePath:instancePath+"/signedInAccounts",schemaPath:"#/properties/signedInAccounts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.isAccountListUnread !== undefined){const _errs5: any = errors;if(typeof data.isAccountListUnread !== "boolean"){validate333.errors = [{instancePath:instancePath+"/isAccountListUnread",schemaPath:"#/properties/isAccountListUnread/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate333.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate333.errors = vErrors;return errors === 0;}
// prettier-ignore
validate333.errors = null as any[] | null;
// prettier-ignore
validate333.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate336(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataExportAlreadyRunningDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate336.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.jobId === undefined) && (missing0 = "jobId")){validate336.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "jobId")){validate336.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.jobId !== undefined){let data0: any = data.jobId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate336.errors = [{instancePath:instancePath+"/jobId",schemaPath:"#/$defs/DataExportJobId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate336.errors = [{instancePath:instancePath+"/jobId",schemaPath:"#/$defs/DataExportJobId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate336.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate336.errors = vErrors;return errors === 0;}
// prettier-ignore
validate336.errors = null as any[] | null;
// prettier-ignore
validate336.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate337(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataExportCancelRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate337.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.jobId === undefined) && (missing0 = "jobId")){validate337.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "jobId")){validate337.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.jobId !== undefined){let data0: any = data.jobId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate337.errors = [{instancePath:instancePath+"/jobId",schemaPath:"#/$defs/DataExportJobId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate337.errors = [{instancePath:instancePath+"/jobId",schemaPath:"#/$defs/DataExportJobId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate337.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate337.errors = vErrors;return errors === 0;}
// prettier-ignore
validate337.errors = null as any[] | null;
// prettier-ignore
validate337.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate338(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataExportDestinationNotWritableDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate338.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.path === undefined) && (missing0 = "path")){validate338.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "path")){validate338.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.path !== undefined){let data0: any = data.path;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate338.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validate338.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data0)){validate338.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate338.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate338.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate338.errors = vErrors;return errors === 0;}
// prettier-ignore
validate338.errors = null as any[] | null;
// prettier-ignore
validate338.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate339(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataExportStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate339.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.destination === undefined) && (missing0 = "destination")){validate339.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "destination")){validate339.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.destination !== undefined){let data0: any = data.destination;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate339.errors = [{instancePath:instancePath+"/destination",schemaPath:"#/properties/destination/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validate339.errors = [{instancePath:instancePath+"/destination",schemaPath:"#/properties/destination/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data0)){validate339.errors = [{instancePath:instancePath+"/destination",schemaPath:"#/properties/destination/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate339.errors = [{instancePath:instancePath+"/destination",schemaPath:"#/properties/destination/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate339.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate339.errors = vErrors;return errors === 0;}
// prettier-ignore
validate339.errors = null as any[] | null;
// prettier-ignore
validate339.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate340(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataExportStartResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate340.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.jobId === undefined) && (missing0 = "jobId")){validate340.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "jobId")){validate340.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.jobId !== undefined){let data0: any = data.jobId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate340.errors = [{instancePath:instancePath+"/jobId",schemaPath:"#/$defs/DataExportJobId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate340.errors = [{instancePath:instancePath+"/jobId",schemaPath:"#/$defs/DataExportJobId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate340.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate340.errors = vErrors;return errors === 0;}
// prettier-ignore
validate340.errors = null as any[] | null;
// prettier-ignore
validate340.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate341(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataExportSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate341.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.jobId === undefined) && (missing0 = "jobId")){validate341.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "jobId")){validate341.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.jobId !== undefined){let data0: any = data.jobId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate341.errors = [{instancePath:instancePath+"/jobId",schemaPath:"#/$defs/DataExportJobId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate341.errors = [{instancePath:instancePath+"/jobId",schemaPath:"#/$defs/DataExportJobId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate341.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate341.errors = vErrors;return errors === 0;}
// prettier-ignore
validate341.errors = null as any[] | null;
// prettier-ignore
validate341.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema444: any = {"description":"Why this machine's keychain could not be used: it is `locked`, or it cannot be used now or at\nall (`unavailable`). A secret that cannot be sealed is refused and stored nowhere else.","type":"string","enum":["locked","unavailable"]};
// prettier-ignore
function validate342(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonDataStoreUnavailableDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate342.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cause === undefined) && (missing0 = "cause")){validate342.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cause")){validate342.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cause !== undefined){let data0: any = data.cause;if(typeof data0 !== "string"){validate342.errors = [{instancePath:instancePath+"/cause",schemaPath:"sidekicks-contracts:keychain#/$defs/KeychainRefusalCause/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data0 === "locked") || (data0 === "unavailable"))){validate342.errors = [{instancePath:instancePath+"/cause",schemaPath:"sidekicks-contracts:keychain#/$defs/KeychainRefusalCause/enum",keyword:"enum",params:{allowedValues: schema444.enum}}];return false;}}}}}else {validate342.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate342.errors = vErrors;return errors === 0;}
// prettier-ignore
validate342.errors = null as any[] | null;
// prettier-ignore
validate342.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate343(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DataEraseSignedInAccount {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate343.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.accountId === undefined) && (missing0 = "accountId")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.listing === undefined) && (missing0 = "listing"))) || ((data.cause === undefined) && (missing0 = "cause"))){validate343.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "accountId") || (key0 === "provider")) || (key0 === "listing")) || (key0 === "cause"))){validate343.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accountId !== undefined){let data0: any = data.accountId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate343.errors = [{instancePath:instancePath+"/accountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate343.errors = [{instancePath:instancePath+"/accountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate343.errors = [{instancePath:instancePath+"/accountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){let data1: any = data.provider;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern16.test(data1)){validate343.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate343.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.listing !== undefined){let data2: any = data.listing;const _errs10: any = errors;if(typeof data2 !== "string"){validate343.errors = [{instancePath:instancePath+"/listing",schemaPath:"#/$defs/DataEraseAccountListing/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "listed") || (data2 === "removed")) || (data2 === "signInUnfinished"))){validate343.errors = [{instancePath:instancePath+"/listing",schemaPath:"#/$defs/DataEraseAccountListing/enum",keyword:"enum",params:{allowedValues: schema650.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.cause !== undefined){let data3: any = data.cause;const _errs13: any = errors;if(typeof data3 !== "string"){validate343.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/$defs/DataEraseSignOutFailure/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data3 === "noProvider") || (data3 === "refused")) || (data3 === "timedOut"))){validate343.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/$defs/DataEraseSignOutFailure/enum",keyword:"enum",params:{allowedValues: schema651.enum}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}}else {validate343.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate343.errors = vErrors;return errors === 0;}
// prettier-ignore
validate343.errors = null as any[] | null;
// prettier-ignore
validate343.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate344(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DataExportJobId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate344.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate344.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate344.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate344.errors = vErrors;return errors === 0;}
// prettier-ignore
validate344.errors = null as any[] | null;
// prettier-ignore
validate344.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate345(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DataExportProgress {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate345.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate345.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "running"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.state === undefined) && (missing0 = "state")) || ((data.sessionsExported === undefined) && (missing0 = "sessionsExported"))) || ((data.sessionsTotal === undefined) && (missing0 = "sessionsTotal"))){validate345.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!(((key1 === "state") || (key1 === "sessionsExported")) || (key1 === "sessionsTotal"))){validate345.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.state !== undefined){let data0: any = data.state;const _errs6: any = errors;if(typeof data0 !== "string"){validate345.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("running" !== data0){validate345.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "running"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionsExported !== undefined){let data1: any = data.sessionsExported;const _errs8: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate345.errors = [{instancePath:instancePath+"/sessionsExported",schemaPath:"#/oneOf/0/properties/sessionsExported/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data1 == "number") && (isFinite(data1))){const vSchema0: any = data && data.sessionsTotal;if(vSchema0 !== undefined && ((!((typeof vSchema0 == "number") && (isFinite(vSchema0)))) || (data1 > vSchema0 || isNaN(data1)))){validate345.errors = [{instancePath:instancePath+"/sessionsExported",schemaPath:"#/oneOf/0/properties/sessionsExported/maximum",keyword:"maximum",params:{comparison: "<=", limit: vSchema0}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate345.errors = [{instancePath:instancePath+"/sessionsExported",schemaPath:"#/oneOf/0/properties/sessionsExported/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionsTotal !== undefined){let data2: any = data.sessionsTotal;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate345.errors = [{instancePath:instancePath+"/sessionsTotal",schemaPath:"#/oneOf/0/properties/sessionsTotal/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate345.errors = [{instancePath:instancePath+"/sessionsTotal",schemaPath:"#/oneOf/0/properties/sessionsTotal/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate345.errors = [{instancePath:instancePath+"/sessionsTotal",schemaPath:"#/oneOf/0/properties/sessionsTotal/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}}}}}}else {validate345.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "completed"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.state === undefined) && (missing1 = "state")) || ((data.path === undefined) && (missing1 = "path"))) || ((data.sessionsExported === undefined) && (missing1 = "sessionsExported"))) || ((data.totalBytes === undefined) && (missing1 = "totalBytes"))){validate345.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!((((key2 === "state") || (key2 === "path")) || (key2 === "sessionsExported")) || (key2 === "totalBytes"))){validate345.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.state !== undefined){let data3: any = data.state;const _errs15: any = errors;if(typeof data3 !== "string"){validate345.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("completed" !== data3){validate345.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "completed"}}];return false;}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data.path !== undefined){let data4: any = data.path;const _errs17: any = errors;if(errors === _errs17){if(typeof data4 === "string"){if(func1(data4) > 4096){validate345.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data4) < 1){validate345.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data4)){validate345.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate345.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs17 === errors;}else {var valid4: any = true;}if(valid4){if(data.sessionsExported !== undefined){let data5: any = data.sessionsExported;const _errs19: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate345.errors = [{instancePath:instancePath+"/sessionsExported",schemaPath:"#/oneOf/1/properties/sessionsExported/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs19){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate345.errors = [{instancePath:instancePath+"/sessionsExported",schemaPath:"#/oneOf/1/properties/sessionsExported/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validate345.errors = [{instancePath:instancePath+"/sessionsExported",schemaPath:"#/oneOf/1/properties/sessionsExported/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid4: any = _errs19 === errors;}else {var valid4: any = true;}if(valid4){if(data.totalBytes !== undefined){let data6: any = data.totalBytes;const _errs21: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validate345.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/oneOf/1/properties/totalBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs21){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validate345.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/oneOf/1/properties/totalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 0 || isNaN(data6)){validate345.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/oneOf/1/properties/totalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid4: any = _errs21 === errors;}else {var valid4: any = true;}}}}}}}else {validate345.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "failed"){const _errs23: any = errors;if(errors === _errs23){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.state === undefined) && (missing2 = "state")) || ((data.message === undefined) && (missing2 = "message"))){validate345.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs25: any = errors;for(const key3 in data){if(!((key3 === "state") || (key3 === "message"))){validate345.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs25 === errors){if(data.state !== undefined){let data7: any = data.state;const _errs26: any = errors;if(typeof data7 !== "string"){validate345.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data7){validate345.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}var valid6: any = _errs26 === errors;}else {var valid6: any = true;}if(valid6){if(data.message !== undefined){let data8: any = data.message;const _errs28: any = errors;if(errors === _errs28){if(typeof data8 === "string"){if(func1(data8) > 8192){validate345.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/2/properties/message/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data8) < 1){validate345.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/2/properties/message/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data8)){validate345.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/2/properties/message/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate345.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/2/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs28 === errors;}else {var valid6: any = true;}}}}}else {validate345.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "canceled"){const _errs30: any = errors;if(errors === _errs30){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((data.state === undefined) && (missing3 = "state")) || ((data.path === undefined) && (missing3 = "path"))){validate345.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs32: any = errors;for(const key4 in data){if(!((key4 === "state") || (key4 === "path"))){validate345.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs32 === errors){if(data.state !== undefined){let data9: any = data.state;const _errs33: any = errors;if(typeof data9 !== "string"){validate345.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("canceled" !== data9){validate345.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/const",keyword:"const",params:{allowedValue: "canceled"}}];return false;}var valid8: any = _errs33 === errors;}else {var valid8: any = true;}if(valid8){if(data.path !== undefined){let data10: any = data.path;const _errs35: any = errors;if(errors === _errs35){if(typeof data10 === "string"){if(func1(data10) > 4096){validate345.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/3/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data10) < 1){validate345.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/3/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data10)){validate345.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/3/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate345.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/3/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs35 === errors;}else {var valid8: any = true;}}}}}else {validate345.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate345.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validate345.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}}}else {validate345.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate345.errors = vErrors;return errors === 0;}
// prettier-ignore
validate345.errors = null as any[] | null;
// prettier-ignore
validate345.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonDataEraseResponse}. */
export const validateDaemonDataEraseResponse: SchemaCheck<DaemonDataEraseResponse> = validate333;
/** Checks that a value is a {@link DaemonDataExportAlreadyRunningDetails}. */
export const validateDaemonDataExportAlreadyRunningDetails: SchemaCheck<DaemonDataExportAlreadyRunningDetails> =
  validate336;
/** Checks that a value is a {@link DaemonDataExportCancelRequest}. */
export const validateDaemonDataExportCancelRequest: SchemaCheck<DaemonDataExportCancelRequest> =
  validate337;
/** Checks that a value is a {@link DaemonDataExportDestinationNotWritableDetails}. */
export const validateDaemonDataExportDestinationNotWritableDetails: SchemaCheck<DaemonDataExportDestinationNotWritableDetails> =
  validate338;
/** Checks that a value is a {@link DaemonDataExportStartRequest}. */
export const validateDaemonDataExportStartRequest: SchemaCheck<DaemonDataExportStartRequest> =
  validate339;
/** Checks that a value is a {@link DaemonDataExportStartResponse}. */
export const validateDaemonDataExportStartResponse: SchemaCheck<DaemonDataExportStartResponse> =
  validate340;
/** Checks that a value is a {@link DaemonDataExportSubscribeRequest}. */
export const validateDaemonDataExportSubscribeRequest: SchemaCheck<DaemonDataExportSubscribeRequest> =
  validate341;
/** Checks that a value is a {@link DaemonDataStoreUnavailableDetails}. */
export const validateDaemonDataStoreUnavailableDetails: SchemaCheck<DaemonDataStoreUnavailableDetails> =
  validate342;
/** Checks that a value is a {@link DataEraseSignedInAccount}. */
export const validateDataEraseSignedInAccount: SchemaCheck<DataEraseSignedInAccount> = validate343;
/** Checks that a value is a {@link DataExportJobId}. */
export const validateDataExportJobId: SchemaCheck<DataExportJobId> = validate344;
/** Checks that a value is a {@link DataExportProgress}. */
export const validateDataExportProgress: SchemaCheck<DataExportProgress> = validate345;

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
