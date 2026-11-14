// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Backups of what the person would lose with the disk: where they stand, starting one now, the events a run records, and each backup's manifest.

import {
  type CompiledSchemaCheck,
  type SchemaCheck,
  deepEqual,
  repeatsItemKey,
  ucs2length,
} from "../../schema-check.js";
import { type WireInstant, validateWireInstant } from "../internal/wire-scalars.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import { type DistroName, validateDistroName } from "../place.js";
import { type ReleaseVersion, validateReleaseVersion } from "../release-manifest.js";

/** The longest backup id or computer name accepted, in code points. */
export const BACKUP_LABEL_MAX_LEN = 256 as const;

/**
 * One backup's id, minted by the service when it writes the backup. Opaque to every client.
 */
export type BackupId = string & { readonly __brand: "BackupId" };
/**
 * How the last backup run ended: `completed`, or `failed` with the service's own words for the
 * cause. A failed run keeps the backups already there.
 */
export type BackupLastRun =
  | {
      outcome: "completed";
      /**
       * When it finished.
       */
      finishedAt: WireInstant;
    }
  | {
      outcome: "failed";
      /**
       * When it stopped.
       */
      finishedAt: WireInstant;
      /**
       * The cause, in the service's own words.
       */
      message: string;
    };

/**
 * What a backup records about itself: when it was taken, the app and service versions that wrote
 * it, its size and the computer that wrote it. On a Windows computer it also names each WSL 2
 * distribution whose part it holds, so a restore writes each part back into the distribution of
 * that name and keeps a part whose distribution is not on the computer.
 */
export interface BackupManifest {
  /**
   * The backup.
   */
  backupId: BackupId;
  /**
   * When it was taken.
   */
  takenAt: WireInstant;
  /**
   * The app version that wrote it.
   */
  appVersion: ReleaseVersion;
  /**
   * The service version that wrote it.
   */
  serviceVersion: ReleaseVersion;
  /**
   * Its size in bytes.
   */
  totalBytes: number;
  /**
   * The computer that wrote it.
   */
  computerName: string;
  /**
   * The WSL 2 distributions whose parts it holds, by name; absent where it holds none.
   *
   * @minItems 1
   */
  distributionParts?: [DistroName, ...DistroName[]];
}
/**
 * One backup in the folder, as `Restore…` lists it.
 */
export interface BackupListEntry {
  /**
   * The backup.
   */
  backupId: BackupId;
  /**
   * When it was taken.
   */
  takenAt: WireInstant;
  /**
   * Its size in bytes.
   */
  totalBytes: number;
  /**
   * The app version that wrote it.
   */
  appVersion: ReleaseVersion;
  /**
   * The computer that wrote it.
   */
  computerName: string;
}
/**
 * Where the backups stand: the folder and whether it sits on the service's own disk, the
 * folder's total size, the last run (`null` before the first) and every backup in the folder.
 */
export interface DaemonBackupReadResponse {
  /**
   * The folder.
   */
  folder: string;
  /**
   * Whether the folder sits on the service's own disk.
   */
  folderOnServiceDisk: boolean;
  /**
   * The folder's total size in bytes.
   */
  totalBytes: number;
  /**
   * The last run, or `null` before the first.
   */
  lastRun: BackupLastRun | null;
  /**
   * Every backup in the folder.
   */
  backups: BackupListEntry[];
}
/**
 * `daemon.backup.completed`: a run wrote a backup.
 */
export interface DaemonBackupCompletedPayload {
  /**
   * The backup.
   */
  backupId: BackupId;
  /**
   * Its size in bytes.
   */
  totalBytes: number;
}
/**
 * `daemon.backup.failed`: a run did not finish, in the service's own words.
 */
export interface DaemonBackupFailedPayload {
  /**
   * The cause.
   */
  message: string;
}
/**
 * One WSL 2 distribution's part a restore kept in the backup, because no distribution of that
 * name is on this computer, with how many sessions it holds.
 */
export interface BackupKeptDistributionPart {
  /**
   * The distribution, by name.
   */
  distro: DistroName;
  /**
   * How many sessions the part holds.
   */
  sessionCount: number;
}
/**
 * `daemon.backup.restored`: the service started again from a backup, naming each distribution part
 * it kept in the backup.
 */
export interface DaemonBackupRestoredPayload {
  /**
   * The backup.
   */
  backupId: BackupId;
  /**
   * The distribution parts kept in the backup; absent where every part was written back.
   *
   * @minItems 1
   */
  keptDistributionParts?: [BackupKeptDistributionPart, ...BackupKeptDistributionPart[]];
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link BackupId}. */
// prettier-ignore
export const validateBackupId: CompiledSchemaCheck<BackupId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BackupId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBackupId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateBackupId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateBackupId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data)){validateBackupId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateBackupId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateBackupId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBackupId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func0 = deepEqual;
/** Checks that a value is a {@link BackupManifest}. */
// prettier-ignore
export const validateBackupManifest: CompiledSchemaCheck<BackupManifest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BackupManifest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBackupManifest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.backupId === undefined) && (missing0 = "backupId")) || ((data.takenAt === undefined) && (missing0 = "takenAt"))) || ((data.appVersion === undefined) && (missing0 = "appVersion"))) || ((data.serviceVersion === undefined) && (missing0 = "serviceVersion"))) || ((data.totalBytes === undefined) && (missing0 = "totalBytes"))) || ((data.computerName === undefined) && (missing0 = "computerName"))){validateBackupManifest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "backupId") || (key0 === "takenAt")) || (key0 === "appVersion")) || (key0 === "serviceVersion")) || (key0 === "totalBytes")) || (key0 === "computerName")) || (key0 === "distributionParts"))){validateBackupManifest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.backupId !== undefined){const _errs2: any = errors;if(!(validateBackupId.call(this, data.backupId, {instancePath:instancePath+"/backupId",parentData:data,parentDataProperty:"backupId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBackupId.errors : vErrors.concat(validateBackupId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.takenAt !== undefined){const _errs3: any = errors;if(!(validateWireInstant.call(this, data.takenAt, {instancePath:instancePath+"/takenAt",parentData:data,parentDataProperty:"takenAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.appVersion !== undefined){const _errs4: any = errors;if(!(validateReleaseVersion.call(this, data.appVersion, {instancePath:instancePath+"/appVersion",parentData:data,parentDataProperty:"appVersion",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReleaseVersion.errors : vErrors.concat(validateReleaseVersion.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.serviceVersion !== undefined){const _errs5: any = errors;if(!(validateReleaseVersion.call(this, data.serviceVersion, {instancePath:instancePath+"/serviceVersion",parentData:data,parentDataProperty:"serviceVersion",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReleaseVersion.errors : vErrors.concat(validateReleaseVersion.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.totalBytes !== undefined){let data4: any = data.totalBytes;const _errs6: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateBackupManifest.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateBackupManifest.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validateBackupManifest.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.computerName !== undefined){let data5: any = data.computerName;const _errs8: any = errors;if(errors === _errs8){if(typeof data5 === "string"){if(func1(data5) > 256){validateBackupManifest.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validateBackupManifest.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validateBackupManifest.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateBackupManifest.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.distributionParts !== undefined){let data6: any = data.distributionParts;const _errs10: any = errors;if(errors === _errs10){if(Array.isArray(data6)){if(data6.length < 1){validateBackupManifest.errors = [{instancePath:instancePath+"/distributionParts",schemaPath:"#/properties/distributionParts/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){const _errs12: any = errors;if(!(validateDistroName.call(this, data6[i0], {instancePath:instancePath+"/distributionParts/" + i0,parentData:data6,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDistroName.errors : vErrors.concat(validateDistroName.errors);errors = vErrors.length;}var valid1: any = _errs12 === errors;if(!valid1){break;}}if(valid1){let i1: any = data6.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data6[i1], data6[j0])){validateBackupManifest.errors = [{instancePath:instancePath+"/distributionParts",schemaPath:"#/properties/distributionParts/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}}else {validateBackupManifest.errors = [{instancePath:instancePath+"/distributionParts",schemaPath:"#/properties/distributionParts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validateBackupManifest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBackupManifest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBackupManifest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BackupListEntry}. */
// prettier-ignore
export const validateBackupListEntry: CompiledSchemaCheck<BackupListEntry> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BackupListEntry {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBackupListEntry.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.backupId === undefined) && (missing0 = "backupId")) || ((data.takenAt === undefined) && (missing0 = "takenAt"))) || ((data.totalBytes === undefined) && (missing0 = "totalBytes"))) || ((data.appVersion === undefined) && (missing0 = "appVersion"))) || ((data.computerName === undefined) && (missing0 = "computerName"))){validateBackupListEntry.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "backupId") || (key0 === "takenAt")) || (key0 === "totalBytes")) || (key0 === "appVersion")) || (key0 === "computerName"))){validateBackupListEntry.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.backupId !== undefined){const _errs2: any = errors;if(!(validateBackupId.call(this, data.backupId, {instancePath:instancePath+"/backupId",parentData:data,parentDataProperty:"backupId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBackupId.errors : vErrors.concat(validateBackupId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.takenAt !== undefined){const _errs3: any = errors;if(!(validateWireInstant.call(this, data.takenAt, {instancePath:instancePath+"/takenAt",parentData:data,parentDataProperty:"takenAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.totalBytes !== undefined){let data2: any = data.totalBytes;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateBackupListEntry.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateBackupListEntry.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateBackupListEntry.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.appVersion !== undefined){const _errs6: any = errors;if(!(validateReleaseVersion.call(this, data.appVersion, {instancePath:instancePath+"/appVersion",parentData:data,parentDataProperty:"appVersion",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReleaseVersion.errors : vErrors.concat(validateReleaseVersion.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.computerName !== undefined){let data4: any = data.computerName;const _errs7: any = errors;if(errors === _errs7){if(typeof data4 === "string"){if(func1(data4) > 256){validateBackupListEntry.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data4) < 1){validateBackupListEntry.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data4)){validateBackupListEntry.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateBackupListEntry.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}}else {validateBackupListEntry.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBackupListEntry.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBackupListEntry.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BackupLastRun}. */
// prettier-ignore
export const validateBackupLastRun: CompiledSchemaCheck<BackupLastRun> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BackupLastRun {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBackupLastRun.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.outcome;if(typeof tag0 == "string"){if(tag0 === "completed"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.outcome === undefined) && (missing0 = "outcome")) || ((data.finishedAt === undefined) && (missing0 = "finishedAt"))){validateBackupLastRun.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "outcome") || (key0 === "finishedAt"))){validateBackupLastRun.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.outcome !== undefined){let data0: any = data.outcome;const _errs5: any = errors;if(typeof data0 !== "string"){validateBackupLastRun.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("completed" !== data0){validateBackupLastRun.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/const",keyword:"const",params:{allowedValue: "completed"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.finishedAt !== undefined){const _errs7: any = errors;if(!(validateWireInstant.call(this, data.finishedAt, {instancePath:instancePath+"/finishedAt",parentData:data,parentDataProperty:"finishedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validateBackupLastRun.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "failed"){const _errs8: any = errors;if(errors === _errs8){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.outcome === undefined) && (missing1 = "outcome")) || ((data.finishedAt === undefined) && (missing1 = "finishedAt"))) || ((data.message === undefined) && (missing1 = "message"))){validateBackupLastRun.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs10: any = errors;for(const key1 in data){if(!(((key1 === "outcome") || (key1 === "finishedAt")) || (key1 === "message"))){validateBackupLastRun.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs10 === errors){if(data.outcome !== undefined){let data2: any = data.outcome;const _errs11: any = errors;if(typeof data2 !== "string"){validateBackupLastRun.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data2){validateBackupLastRun.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}var valid4: any = _errs11 === errors;}else {var valid4: any = true;}if(valid4){if(data.finishedAt !== undefined){const _errs13: any = errors;if(!(validateWireInstant.call(this, data.finishedAt, {instancePath:instancePath+"/finishedAt",parentData:data,parentDataProperty:"finishedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}if(valid4){if(data.message !== undefined){let data4: any = data.message;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(func1(data4) > 8192){validateBackupLastRun.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/1/properties/message/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data4) < 1){validateBackupLastRun.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/1/properties/message/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data4)){validateBackupLastRun.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/1/properties/message/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateBackupLastRun.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/1/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}}}}}}else {validateBackupLastRun.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs8 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateBackupLastRun.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "outcome", tagValue: tag0}}];return false;}}else {validateBackupLastRun.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "outcome", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateBackupLastRun.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateBackupLastRun.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBackupLastRun.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBackupLastRun.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link DaemonBackupReadResponse}. */
// prettier-ignore
export const validateDaemonBackupReadResponse: CompiledSchemaCheck<DaemonBackupReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonBackupReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonBackupReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.folder === undefined) && (missing0 = "folder")) || ((data.folderOnServiceDisk === undefined) && (missing0 = "folderOnServiceDisk"))) || ((data.totalBytes === undefined) && (missing0 = "totalBytes"))) || ((data.lastRun === undefined) && (missing0 = "lastRun"))) || ((data.backups === undefined) && (missing0 = "backups"))){validateDaemonBackupReadResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "folder") || (key0 === "folderOnServiceDisk")) || (key0 === "totalBytes")) || (key0 === "lastRun")) || (key0 === "backups"))){validateDaemonBackupReadResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.folder !== undefined){let data0: any = data.folder;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validateDaemonBackupReadResponse.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validateDaemonBackupReadResponse.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data0)){validateDaemonBackupReadResponse.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateDaemonBackupReadResponse.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.folderOnServiceDisk !== undefined){const _errs4: any = errors;if(typeof data.folderOnServiceDisk !== "boolean"){validateDaemonBackupReadResponse.errors = [{instancePath:instancePath+"/folderOnServiceDisk",schemaPath:"#/properties/folderOnServiceDisk/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.totalBytes !== undefined){let data2: any = data.totalBytes;const _errs6: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateDaemonBackupReadResponse.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateDaemonBackupReadResponse.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateDaemonBackupReadResponse.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastRun !== undefined){let data3: any = data.lastRun;const _errs8: any = errors;const _errs9: any = errors;let valid1: any = false;const _errs10: any = errors;if(!(validateBackupLastRun.call(this, data3, {instancePath:instancePath+"/lastRun",parentData:data,parentDataProperty:"lastRun",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBackupLastRun.errors : vErrors.concat(validateBackupLastRun.errors);errors = vErrors.length;}var _valid0: any = _errs10 === errors;valid1 = valid1 || _valid0;const _errs11: any = errors;if(data3 !== null){const err0: any = {instancePath:instancePath+"/lastRun",schemaPath:"#/properties/lastRun/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs11 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/lastRun",schemaPath:"#/properties/lastRun/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateDaemonBackupReadResponse.errors = vErrors;return false;}else {errors = _errs9;if(vErrors !== null){if(_errs9){vErrors.length = _errs9;}else {vErrors = null;}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.backups !== undefined){let data4: any = data.backups;const _errs13: any = errors;if(errors === _errs13){if(Array.isArray(data4)){var valid2: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs15: any = errors;if(!(validateBackupListEntry.call(this, data4[i0], {instancePath:instancePath+"/backups/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBackupListEntry.errors : vErrors.concat(validateBackupListEntry.errors);errors = vErrors.length;}var valid2: any = _errs15 === errors;if(!valid2){break;}}}else {validateDaemonBackupReadResponse.errors = [{instancePath:instancePath+"/backups",schemaPath:"#/properties/backups/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}}}else {validateDaemonBackupReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonBackupReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonBackupReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonBackupCompletedPayload}. */
// prettier-ignore
export const validateDaemonBackupCompletedPayload: CompiledSchemaCheck<DaemonBackupCompletedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonBackupCompletedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonBackupCompletedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.backupId === undefined) && (missing0 = "backupId")) || ((data.totalBytes === undefined) && (missing0 = "totalBytes"))){validateDaemonBackupCompletedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "backupId") || (key0 === "totalBytes"))){validateDaemonBackupCompletedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.backupId !== undefined){const _errs2: any = errors;if(!(validateBackupId.call(this, data.backupId, {instancePath:instancePath+"/backupId",parentData:data,parentDataProperty:"backupId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBackupId.errors : vErrors.concat(validateBackupId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.totalBytes !== undefined){let data1: any = data.totalBytes;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateDaemonBackupCompletedPayload.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateDaemonBackupCompletedPayload.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateDaemonBackupCompletedPayload.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateDaemonBackupCompletedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonBackupCompletedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonBackupCompletedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonBackupFailedPayload}. */
// prettier-ignore
export const validateDaemonBackupFailedPayload: CompiledSchemaCheck<DaemonBackupFailedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonBackupFailedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonBackupFailedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.message === undefined) && (missing0 = "message")){validateDaemonBackupFailedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "message")){validateDaemonBackupFailedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.message !== undefined){let data0: any = data.message;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 8192){validateDaemonBackupFailedPayload.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data0) < 1){validateDaemonBackupFailedPayload.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateDaemonBackupFailedPayload.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDaemonBackupFailedPayload.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateDaemonBackupFailedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonBackupFailedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonBackupFailedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BackupKeptDistributionPart}. */
// prettier-ignore
export const validateBackupKeptDistributionPart: CompiledSchemaCheck<BackupKeptDistributionPart> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BackupKeptDistributionPart {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBackupKeptDistributionPart.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.distro === undefined) && (missing0 = "distro")) || ((data.sessionCount === undefined) && (missing0 = "sessionCount"))){validateBackupKeptDistributionPart.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "distro") || (key0 === "sessionCount"))){validateBackupKeptDistributionPart.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.distro !== undefined){const _errs2: any = errors;if(!(validateDistroName.call(this, data.distro, {instancePath:instancePath+"/distro",parentData:data,parentDataProperty:"distro",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDistroName.errors : vErrors.concat(validateDistroName.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionCount !== undefined){let data1: any = data.sessionCount;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateBackupKeptDistributionPart.errors = [{instancePath:instancePath+"/sessionCount",schemaPath:"#/properties/sessionCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateBackupKeptDistributionPart.errors = [{instancePath:instancePath+"/sessionCount",schemaPath:"#/properties/sessionCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateBackupKeptDistributionPart.errors = [{instancePath:instancePath+"/sessionCount",schemaPath:"#/properties/sessionCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateBackupKeptDistributionPart.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBackupKeptDistributionPart.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBackupKeptDistributionPart.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonBackupRestoredPayload}. */
// prettier-ignore
export const validateDaemonBackupRestoredPayload: CompiledSchemaCheck<DaemonBackupRestoredPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonBackupRestoredPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonBackupRestoredPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.backupId === undefined) && (missing0 = "backupId")){validateDaemonBackupRestoredPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "backupId") || (key0 === "keptDistributionParts"))){validateDaemonBackupRestoredPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.backupId !== undefined){const _errs2: any = errors;if(!(validateBackupId.call(this, data.backupId, {instancePath:instancePath+"/backupId",parentData:data,parentDataProperty:"backupId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBackupId.errors : vErrors.concat(validateBackupId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.keptDistributionParts !== undefined){let data1: any = data.keptDistributionParts;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){if(data1.length < 1){validateDaemonBackupRestoredPayload.errors = [{instancePath:instancePath+"/keptDistributionParts",schemaPath:"#/properties/keptDistributionParts/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateBackupKeptDistributionPart.call(this, data1[i0], {instancePath:instancePath+"/keptDistributionParts/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBackupKeptDistributionPart.errors : vErrors.concat(validateBackupKeptDistributionPart.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}if(valid1){let valid2: any;let i1: any = data1.length;let j0: any;valid2 = true;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data1[i1], data1[j0])){validateDaemonBackupRestoredPayload.errors = [{instancePath:instancePath+"/keptDistributionParts",schemaPath:"#/properties/keptDistributionParts/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;valid2 = false;break outer0;}}}}if(valid2){if(repeatsItemKey(data1, "distro")){validateDaemonBackupRestoredPayload.errors = [{instancePath:instancePath+"/keptDistributionParts",schemaPath:"#/properties/keptDistributionParts/uniqueItemKey",keyword:"uniqueItemKey",params:{}}];return false;}}}}}else {validateDaemonBackupRestoredPayload.errors = [{instancePath:instancePath+"/keptDistributionParts",schemaPath:"#/properties/keptDistributionParts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateDaemonBackupRestoredPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonBackupRestoredPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonBackupRestoredPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link DAEMON_BACKUP_METHOD_DESCRIPTORS}, each with its checks. */
export interface DaemonBackupMethodDescriptors {
  readonly "daemon.backup.read": {
    readonly method: "daemon.backup.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<DaemonBackupReadResponse>;
  };
  readonly "daemon.backup.start": {
    readonly method: "daemon.backup.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The backup methods. A run started now reports its end through the `daemon.backup.*` events. */
export const DAEMON_BACKUP_METHOD_DESCRIPTORS: DaemonBackupMethodDescriptors = Object.freeze({
  "daemon.backup.read": Object.freeze({
    method: "daemon.backup.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateDaemonBackupReadResponse,
  }),
  "daemon.backup.start": Object.freeze({
    method: "daemon.backup.start",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateEmptyPayload,
  }),
});
