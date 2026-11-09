// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Backups of what the person would lose with the disk: where they stand, starting one now, the events a run records, and each backup's manifest.

import { type SchemaCheck, deepEqual, ucs2length } from "../../schema-check.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import type { DistroName } from "../place.js";
import type { ReleaseVersion } from "../release-manifest.js";

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
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate311(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BackupId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate311.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validate311.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validate311.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data)){validate311.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate311.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate311.errors = vErrors;return errors === 0;}
// prettier-ignore
validate311.errors = null as any[] | null;
// prettier-ignore
validate311.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func0 = deepEqual;
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
const pattern373 = new RegExp("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$", "u");
// prettier-ignore
function validate312(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BackupManifest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate312.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.backupId === undefined) && (missing0 = "backupId")) || ((data.takenAt === undefined) && (missing0 = "takenAt"))) || ((data.appVersion === undefined) && (missing0 = "appVersion"))) || ((data.serviceVersion === undefined) && (missing0 = "serviceVersion"))) || ((data.totalBytes === undefined) && (missing0 = "totalBytes"))) || ((data.computerName === undefined) && (missing0 = "computerName"))){validate312.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "backupId") || (key0 === "takenAt")) || (key0 === "appVersion")) || (key0 === "serviceVersion")) || (key0 === "totalBytes")) || (key0 === "computerName")) || (key0 === "distributionParts"))){validate312.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.backupId !== undefined){let data0: any = data.backupId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate312.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate312.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate312.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate312.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.takenAt !== undefined){let data1: any = data.takenAt;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern5.test(data1)){validate312.errors = [{instancePath:instancePath+"/takenAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate312.errors = [{instancePath:instancePath+"/takenAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.appVersion !== undefined){let data2: any = data.appVersion;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(func1(data2) > 64){validate312.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"sidekicks-contracts:release-manifest#/$defs/ReleaseVersion/maxLength",keyword:"maxLength",params:{limit: 64}}];return false;}else {if(!pattern373.test(data2)){validate312.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"sidekicks-contracts:release-manifest#/$defs/ReleaseVersion/pattern",keyword:"pattern",params:{pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"}}];return false;}}}else {validate312.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"sidekicks-contracts:release-manifest#/$defs/ReleaseVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.serviceVersion !== undefined){let data3: any = data.serviceVersion;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data3 === "string"){if(func1(data3) > 64){validate312.errors = [{instancePath:instancePath+"/serviceVersion",schemaPath:"sidekicks-contracts:release-manifest#/$defs/ReleaseVersion/maxLength",keyword:"maxLength",params:{limit: 64}}];return false;}else {if(!pattern373.test(data3)){validate312.errors = [{instancePath:instancePath+"/serviceVersion",schemaPath:"sidekicks-contracts:release-manifest#/$defs/ReleaseVersion/pattern",keyword:"pattern",params:{pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"}}];return false;}}}else {validate312.errors = [{instancePath:instancePath+"/serviceVersion",schemaPath:"sidekicks-contracts:release-manifest#/$defs/ReleaseVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.totalBytes !== undefined){let data4: any = data.totalBytes;const _errs15: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate312.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs15){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate312.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validate312.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.computerName !== undefined){let data5: any = data.computerName;const _errs17: any = errors;if(errors === _errs17){if(typeof data5 === "string"){if(func1(data5) > 256){validate312.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validate312.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate312.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate312.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}if(valid0){if(data.distributionParts !== undefined){let data6: any = data.distributionParts;const _errs19: any = errors;if(errors === _errs19){if(Array.isArray(data6)){if(data6.length < 1){validate312.errors = [{instancePath:instancePath+"/distributionParts",schemaPath:"#/properties/distributionParts/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid5: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){let data7: any = data6[i0];const _errs21: any = errors;const _errs22: any = errors;if(errors === _errs22){if(typeof data7 === "string"){if(func1(data7) > 256){validate312.errors = [{instancePath:instancePath+"/distributionParts/" + i0,schemaPath:"sidekicks-contracts:place#/$defs/DistroName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data7)){validate312.errors = [{instancePath:instancePath+"/distributionParts/" + i0,schemaPath:"sidekicks-contracts:place#/$defs/DistroName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate312.errors = [{instancePath:instancePath+"/distributionParts/" + i0,schemaPath:"sidekicks-contracts:place#/$defs/DistroName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs21 === errors;if(!valid5){break;}}if(valid5){let i1: any = data6.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data6[i1], data6[j0])){validate312.errors = [{instancePath:instancePath+"/distributionParts",schemaPath:"#/properties/distributionParts/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}}else {validate312.errors = [{instancePath:instancePath+"/distributionParts",schemaPath:"#/properties/distributionParts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validate312.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate312.errors = vErrors;return errors === 0;}
// prettier-ignore
validate312.errors = null as any[] | null;
// prettier-ignore
validate312.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate313(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonBackupCompletedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate313.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.backupId === undefined) && (missing0 = "backupId")) || ((data.totalBytes === undefined) && (missing0 = "totalBytes"))){validate313.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "backupId") || (key0 === "totalBytes"))){validate313.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.backupId !== undefined){let data0: any = data.backupId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate313.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate313.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate313.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate313.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.totalBytes !== undefined){let data1: any = data.totalBytes;const _errs6: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate313.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate313.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate313.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate313.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate313.errors = vErrors;return errors === 0;}
// prettier-ignore
validate313.errors = null as any[] | null;
// prettier-ignore
validate313.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate314(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonBackupFailedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate314.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.message === undefined) && (missing0 = "message")){validate314.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "message")){validate314.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.message !== undefined){let data0: any = data.message;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 8192){validate314.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data0) < 1){validate314.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate314.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate314.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate314.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate314.errors = vErrors;return errors === 0;}
// prettier-ignore
validate314.errors = null as any[] | null;
// prettier-ignore
validate314.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate316(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate316.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.outcome;if(typeof tag0 == "string"){if(tag0 === "completed"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.outcome === undefined) && (missing0 = "outcome")) || ((data.finishedAt === undefined) && (missing0 = "finishedAt"))){validate316.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "outcome") || (key0 === "finishedAt"))){validate316.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.outcome !== undefined){let data0: any = data.outcome;const _errs5: any = errors;if(typeof data0 !== "string"){validate316.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("completed" !== data0){validate316.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/const",keyword:"const",params:{allowedValue: "completed"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.finishedAt !== undefined){let data1: any = data.finishedAt;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(!pattern5.test(data1)){validate316.errors = [{instancePath:instancePath+"/finishedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate316.errors = [{instancePath:instancePath+"/finishedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validate316.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "failed"){const _errs10: any = errors;if(errors === _errs10){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.outcome === undefined) && (missing1 = "outcome")) || ((data.finishedAt === undefined) && (missing1 = "finishedAt"))) || ((data.message === undefined) && (missing1 = "message"))){validate316.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs12: any = errors;for(const key1 in data){if(!(((key1 === "outcome") || (key1 === "finishedAt")) || (key1 === "message"))){validate316.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs12 === errors){if(data.outcome !== undefined){let data2: any = data.outcome;const _errs13: any = errors;if(typeof data2 !== "string"){validate316.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data2){validate316.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}var valid5: any = _errs13 === errors;}else {var valid5: any = true;}if(valid5){if(data.finishedAt !== undefined){let data3: any = data.finishedAt;const _errs15: any = errors;const _errs16: any = errors;if(errors === _errs16){if(typeof data3 === "string"){if(!pattern5.test(data3)){validate316.errors = [{instancePath:instancePath+"/finishedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate316.errors = [{instancePath:instancePath+"/finishedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data.message !== undefined){let data4: any = data.message;const _errs18: any = errors;if(errors === _errs18){if(typeof data4 === "string"){if(func1(data4) > 8192){validate316.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/1/properties/message/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data4) < 1){validate316.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/1/properties/message/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate316.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/1/properties/message/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate316.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/1/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs18 === errors;}else {var valid5: any = true;}}}}}}else {validate316.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs10 === errors;if(props0 !== true){props0 = true;}valid0 = valid4;}else {validate316.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "outcome", tagValue: tag0}}];return false;}}else {validate316.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "outcome", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validate316.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validate316.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate316.errors = vErrors;return errors === 0;}
// prettier-ignore
validate316.errors = null as any[] | null;
// prettier-ignore
validate316.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate318(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate318.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.backupId === undefined) && (missing0 = "backupId")) || ((data.takenAt === undefined) && (missing0 = "takenAt"))) || ((data.totalBytes === undefined) && (missing0 = "totalBytes"))) || ((data.appVersion === undefined) && (missing0 = "appVersion"))) || ((data.computerName === undefined) && (missing0 = "computerName"))){validate318.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "backupId") || (key0 === "takenAt")) || (key0 === "totalBytes")) || (key0 === "appVersion")) || (key0 === "computerName"))){validate318.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.backupId !== undefined){let data0: any = data.backupId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate318.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate318.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate318.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate318.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.takenAt !== undefined){let data1: any = data.takenAt;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern5.test(data1)){validate318.errors = [{instancePath:instancePath+"/takenAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate318.errors = [{instancePath:instancePath+"/takenAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.totalBytes !== undefined){let data2: any = data.totalBytes;const _errs9: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate318.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate318.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate318.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.appVersion !== undefined){let data3: any = data.appVersion;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(func1(data3) > 64){validate318.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"sidekicks-contracts:release-manifest#/$defs/ReleaseVersion/maxLength",keyword:"maxLength",params:{limit: 64}}];return false;}else {if(!pattern373.test(data3)){validate318.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"sidekicks-contracts:release-manifest#/$defs/ReleaseVersion/pattern",keyword:"pattern",params:{pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"}}];return false;}}}else {validate318.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"sidekicks-contracts:release-manifest#/$defs/ReleaseVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.computerName !== undefined){let data4: any = data.computerName;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(func1(data4) > 256){validate318.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data4) < 1){validate318.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate318.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate318.errors = [{instancePath:instancePath+"/computerName",schemaPath:"#/properties/computerName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}}else {validate318.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate318.errors = vErrors;return errors === 0;}
// prettier-ignore
validate318.errors = null as any[] | null;
// prettier-ignore
validate318.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate315(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonBackupReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate315.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.folder === undefined) && (missing0 = "folder")) || ((data.folderOnServiceDisk === undefined) && (missing0 = "folderOnServiceDisk"))) || ((data.totalBytes === undefined) && (missing0 = "totalBytes"))) || ((data.lastRun === undefined) && (missing0 = "lastRun"))) || ((data.backups === undefined) && (missing0 = "backups"))){validate315.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "folder") || (key0 === "folderOnServiceDisk")) || (key0 === "totalBytes")) || (key0 === "lastRun")) || (key0 === "backups"))){validate315.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.folder !== undefined){let data0: any = data.folder;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate315.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validate315.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data0)){validate315.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate315.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.folderOnServiceDisk !== undefined){const _errs4: any = errors;if(typeof data.folderOnServiceDisk !== "boolean"){validate315.errors = [{instancePath:instancePath+"/folderOnServiceDisk",schemaPath:"#/properties/folderOnServiceDisk/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.totalBytes !== undefined){let data2: any = data.totalBytes;const _errs6: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate315.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate315.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate315.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastRun !== undefined){let data3: any = data.lastRun;const _errs8: any = errors;const _errs9: any = errors;let valid1: any = false;const _errs10: any = errors;if(!(validate316.call(this, data3, {instancePath:instancePath+"/lastRun",parentData:data,parentDataProperty:"lastRun",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate316.errors : vErrors.concat(validate316.errors);errors = vErrors.length;}var _valid0: any = _errs10 === errors;valid1 = valid1 || _valid0;const _errs11: any = errors;if(data3 !== null){const err0: any = {instancePath:instancePath+"/lastRun",schemaPath:"#/properties/lastRun/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs11 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/lastRun",schemaPath:"#/properties/lastRun/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validate315.errors = vErrors;return false;}else {errors = _errs9;if(vErrors !== null){if(_errs9){vErrors.length = _errs9;}else {vErrors = null;}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.backups !== undefined){let data4: any = data.backups;const _errs13: any = errors;if(errors === _errs13){if(Array.isArray(data4)){var valid2: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs15: any = errors;if(!(validate318.call(this, data4[i0], {instancePath:instancePath+"/backups/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate318.errors : vErrors.concat(validate318.errors);errors = vErrors.length;}var valid2: any = _errs15 === errors;if(!valid2){break;}}}else {validate315.errors = [{instancePath:instancePath+"/backups",schemaPath:"#/properties/backups/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}}}else {validate315.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate315.errors = vErrors;return errors === 0;}
// prettier-ignore
validate315.errors = null as any[] | null;
// prettier-ignore
validate315.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate321(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate321.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.distro === undefined) && (missing0 = "distro")) || ((data.sessionCount === undefined) && (missing0 = "sessionCount"))){validate321.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "distro") || (key0 === "sessionCount"))){validate321.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.distro !== undefined){let data0: any = data.distro;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate321.errors = [{instancePath:instancePath+"/distro",schemaPath:"sidekicks-contracts:place#/$defs/DistroName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data0)){validate321.errors = [{instancePath:instancePath+"/distro",schemaPath:"sidekicks-contracts:place#/$defs/DistroName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate321.errors = [{instancePath:instancePath+"/distro",schemaPath:"sidekicks-contracts:place#/$defs/DistroName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionCount !== undefined){let data1: any = data.sessionCount;const _errs6: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate321.errors = [{instancePath:instancePath+"/sessionCount",schemaPath:"#/properties/sessionCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate321.errors = [{instancePath:instancePath+"/sessionCount",schemaPath:"#/properties/sessionCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate321.errors = [{instancePath:instancePath+"/sessionCount",schemaPath:"#/properties/sessionCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate321.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate321.errors = vErrors;return errors === 0;}
// prettier-ignore
validate321.errors = null as any[] | null;
// prettier-ignore
validate321.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate320(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonBackupRestoredPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate320.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.backupId === undefined) && (missing0 = "backupId")){validate320.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "backupId") || (key0 === "keptDistributionParts"))){validate320.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.backupId !== undefined){let data0: any = data.backupId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate320.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate320.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate320.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate320.errors = [{instancePath:instancePath+"/backupId",schemaPath:"#/$defs/BackupId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.keptDistributionParts !== undefined){let data1: any = data.keptDistributionParts;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){if(data1.length < 1){validate320.errors = [{instancePath:instancePath+"/keptDistributionParts",schemaPath:"#/properties/keptDistributionParts/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validate321.call(this, data1[i0], {instancePath:instancePath+"/keptDistributionParts/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate321.errors : vErrors.concat(validate321.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;if(!valid2){break;}}if(valid2){let i1: any = data1.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data1[i1], data1[j0])){validate320.errors = [{instancePath:instancePath+"/keptDistributionParts",schemaPath:"#/properties/keptDistributionParts/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}}else {validate320.errors = [{instancePath:instancePath+"/keptDistributionParts",schemaPath:"#/properties/keptDistributionParts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate320.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate320.errors = vErrors;return errors === 0;}
// prettier-ignore
validate320.errors = null as any[] | null;
// prettier-ignore
validate320.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BackupId}. */
export const validateBackupId: SchemaCheck<BackupId> = validate311;
/** Checks that a value is a {@link BackupManifest}. */
export const validateBackupManifest: SchemaCheck<BackupManifest> = validate312;
/** Checks that a value is a {@link DaemonBackupCompletedPayload}. */
export const validateDaemonBackupCompletedPayload: SchemaCheck<DaemonBackupCompletedPayload> =
  validate313;
/** Checks that a value is a {@link DaemonBackupFailedPayload}. */
export const validateDaemonBackupFailedPayload: SchemaCheck<DaemonBackupFailedPayload> =
  validate314;
/** Checks that a value is a {@link DaemonBackupReadResponse}. */
export const validateDaemonBackupReadResponse: SchemaCheck<DaemonBackupReadResponse> = validate315;
/** Checks that a value is a {@link DaemonBackupRestoredPayload}. */
export const validateDaemonBackupRestoredPayload: SchemaCheck<DaemonBackupRestoredPayload> =
  validate320;

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
