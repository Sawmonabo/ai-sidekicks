/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Undo: the dry run, the undo itself with edit and resend, the event every undo settles with, and the list of a session's snapshots.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { AttachmentReferenceList } from "../artifacts/attachment-reference.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { EventCursor, SessionId } from "./id.js";

/**
 * The daemon-minted id of one of a session's snapshots. Opaque to every client.
 */
export type SnapshotId = string & { readonly __brand: "SnapshotId" };
/**
 * The point an undo goes back to: before one of the person's messages, or a snapshot.
 */
export type SessionRestoreTarget =
  | {
      kind: "message";
      /**
       * The message's cursor in the session's history.
       */
      anchorCursor: EventCursor;
    }
  | {
      kind: "snapshot";
      /**
       * The snapshot.
       */
      snapshotId: SnapshotId;
    };
/**
 * What an undo is asked to put back.
 */
export type SessionRestoreScope = "conversationAndFiles" | "conversation" | "files";
/**
 * One part an undo puts back on its own.
 */
export type SessionRestorePart = "conversation" | "files";
/**
 * What a finished undo put back: a scope, or nothing.
 */
export type SessionRestoredScope = "conversationAndFiles" | "conversation" | "files" | "nothing";
/**
 * Why a file is skipped rather than put back.
 */
export type SessionRestoreSkipReason =
  | "symbolicLink"
  | "hardLink"
  | "notARegularFile"
  | "directoryMoved"
  | "tooLarge"
  | "noPlaceOnVolume"
  | "branchMovedByCommand";
/**
 * What an undo, or an edit and resend, reports, split on `outcome`: a finished undo with what
 * was asked, what went back and the daemon's reason for every asked-for part that did not, or an
 * edit and resend whose undo applied and whose send failed.
 */
export type SessionRestoreOutcome =
  | {
      outcome: "restoreFinished";
      /**
       * What was asked.
       */
      requested: SessionRestoreScope;
      /**
       * What went back.
       */
      restored: SessionRestoredScope;
      /**
       * What the files part did, present exactly when the files went back.
       */
      files?: SessionRestoreFileOutcome;
      /**
       * The daemon's reason for each asked-for part that did not go back.
       */
      failures?: SessionRestoreFailures;
    }
  | {
      outcome: "resendUnapplied";
      /**
       * The send's reason.
       */
      reason: string;
    };

/**
 * Asks for a session's snapshots. A chat session has none.
 */
export interface SessionSnapshotListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One snapshot: its id, the name the inspector shows (`Before <turn>`), and when it was taken.
 */
export interface SessionSnapshotSummary {
  /**
   * The snapshot.
   */
  snapshotId: SnapshotId;
  /**
   * The name the inspector shows.
   */
  name: string;
  /**
   * When it was taken.
   */
  createdAt: WireInstant;
}
/**
 * A session's snapshots.
 */
export interface SessionSnapshotListResponse {
  /**
   * The snapshots.
   */
  snapshots: SessionSnapshotSummary[];
}
/**
 * A file an undo leaves as it is, and why. A skip is always named and never stops the undo.
 */
export interface SessionRestoreSkippedFile {
  /**
   * The file.
   */
  path: string;
  /**
   * Why it is skipped.
   */
  reason: SessionRestoreSkipReason;
}
/**
 * Paths another session working in the same folder also changed since the point.
 */
export interface SessionRestoreAlsoChanged {
  /**
   * The other session.
   */
  sessionId: SessionId;
  /**
   * The paths it changed.
   */
  paths: string[];
}
/**
 * Asks what an undo would do, and changes nothing.
 */
export interface SessionRestorePreviewRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The point to go back to.
   */
  target: SessionRestoreTarget;
  /**
   * What to put back.
   */
  scope: SessionRestoreScope;
}
/**
 * What an undo would do. `fileCount` and `lineCount` are the files it would put back and the
 * lines across them; `affectedChildCount` and `runningCommands` count the agents and commands
 * started after the point that are still running, which the undo stops first. `ignoredFolders`
 * and `commandsRanAfterPoint` feed the notice shown whenever a command ran after the point;
 * `alsoChangedBy` names the paths another session changed since the point.
 */
export interface SessionRestorePreviewResponse {
  /**
   * The files it would put back.
   */
  fileCount: number;
  /**
   * The lines across them.
   */
  lineCount: number;
  /**
   * The files it would skip.
   */
  skipped: SessionRestoreSkippedFile[];
  /**
   * The agents started after the point that are still running.
   */
  affectedChildCount: number;
  /**
   * The commands started after the point that are still running.
   */
  runningCommands: number;
  /**
   * The folders the project ignores, never put back.
   */
  ignoredFolders: string[];
  /**
   * Whether a command ran after the point.
   */
  commandsRanAfterPoint: boolean;
  /**
   * The paths other sessions changed since the point.
   */
  alsoChangedBy: SessionRestoreAlsoChanged[];
}
/**
 * The edited message an edit and resend sends once the undo has applied, with its files.
 */
export interface SessionRestoreResend {
  /**
   * The edited message.
   */
  content: string;
  /**
   * Its files, where it has any.
   */
  attachments?: AttachmentReferenceList;
}
/**
 * Undoes to a point, and with `resend` sends an edited message from there in the same call.
 * `clientIdempotencyKey` is unique within the session, so a retried undo never cuts twice.
 * `includeAlsoChanged` puts back the paths another session also changed since the point.
 * `resend` goes only with the conversation and the files together; a narrower scope is refused.
 */
export interface SessionRestoreRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The point to go back to.
   */
  target: SessionRestoreTarget;
  /**
   * What to put back.
   */
  scope: SessionRestoreScope;
  /**
   * The client's key for this undo.
   */
  clientIdempotencyKey: string;
  /**
   * Whether to put back the paths another session also changed.
   */
  includeAlsoChanged: boolean;
  /**
   * The edited message to send once the undo has applied.
   */
  resend?: SessionRestoreResend;
}
/**
 * Why one asked-for part did not go back, in the daemon's words.
 */
export interface SessionRestoreFailure {
  /**
   * The daemon's reason.
   */
  reason: string;
}
/**
 * The daemon's reason for each asked-for part that did not go back.
 */
export interface SessionRestoreFailures {
  /**
   * Why the conversation did not go back.
   */
  conversation?: SessionRestoreFailure;
  /**
   * Why the files did not go back.
   */
  files?: SessionRestoreFailure;
}
/**
 * What the files part of an undo actually did: the files it put back, the lines across them, and
 * every file it skipped with the reason. These are the undo's own figures, not the dry run's,
 * because the folder can change between the two.
 */
export interface SessionRestoreFileOutcome {
  /**
   * The files put back.
   */
  restoredFileCount: number;
  /**
   * The lines across them.
   */
  restoredLineCount: number;
  /**
   * The files skipped.
   */
  skipped: SessionRestoreSkippedFile[];
}
/**
 * The payload of `session.restore.completed`: one stored record per undo, carrying its result. The
 * conversation cut is also recorded by the run's own rolled-back event.
 */
export interface SessionRestoreCompletedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The point the undo went back to.
   */
  target: SessionRestoreTarget;
  /**
   * What it reported.
   */
  result: SessionRestoreOutcome;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate582(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate582.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate582.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "message"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.anchorCursor === undefined) && (missing0 = "anchorCursor"))){validate582.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "kind") || (key1 === "anchorCursor"))){validate582.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate582.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("message" !== data0){validate582.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "message"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.anchorCursor !== undefined){let data1: any = data.anchorCursor;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(func1(data1) > 256){validate582.errors = [{instancePath:instancePath+"/anchorCursor",schemaPath:"sidekicks-contracts:session/id#/$defs/EventCursor/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate582.errors = [{instancePath:instancePath+"/anchorCursor",schemaPath:"sidekicks-contracts:session/id#/$defs/EventCursor/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate582.errors = [{instancePath:instancePath+"/anchorCursor",schemaPath:"sidekicks-contracts:session/id#/$defs/EventCursor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate582.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "snapshot"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.kind === undefined) && (missing1 = "kind")) || ((data.snapshotId === undefined) && (missing1 = "snapshotId"))){validate582.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!((key2 === "kind") || (key2 === "snapshotId"))){validate582.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs15: any = errors;if(typeof data2 !== "string"){validate582.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("snapshot" !== data2){validate582.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "snapshot"}}];return false;}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data.snapshotId !== undefined){let data3: any = data.snapshotId;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(typeof data3 === "string"){if(func1(data3) > 256){validate582.errors = [{instancePath:instancePath+"/snapshotId",schemaPath:"#/$defs/SnapshotId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validate582.errors = [{instancePath:instancePath+"/snapshotId",schemaPath:"#/$defs/SnapshotId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate582.errors = [{instancePath:instancePath+"/snapshotId",schemaPath:"#/$defs/SnapshotId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}}}}}else {validate582.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate582.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate582.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate582.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate582.errors = vErrors;return errors === 0;}
// prettier-ignore
validate582.errors = null as any[] | null;
// prettier-ignore
validate582.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1081: any = {"description":"What an undo is asked to put back.","type":"string","enum":["conversationAndFiles","conversation","files"]};
// prettier-ignore
const schema1082: any = {"description":"What a finished undo put back: a scope, or nothing.","type":"string","enum":["conversationAndFiles","conversation","files","nothing"]};
// prettier-ignore
const schema1085: any = {"description":"Why a file is skipped rather than put back.","type":"string","enum":["symbolicLink","hardLink","notARegularFile","directoryMoved","tooLarge","noPlaceOnVolume","branchMovedByCommand"]};
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate586(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate586.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.path === undefined) && (missing0 = "path")) || ((data.reason === undefined) && (missing0 = "reason"))){validate586.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "path") || (key0 === "reason"))){validate586.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.path !== undefined){let data0: any = data.path;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate586.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validate586.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data0)){validate586.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate586.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data1: any = data.reason;const _errs4: any = errors;if(typeof data1 !== "string"){validate586.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/SessionRestoreSkipReason/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((data1 === "symbolicLink") || (data1 === "hardLink")) || (data1 === "notARegularFile")) || (data1 === "directoryMoved")) || (data1 === "tooLarge")) || (data1 === "noPlaceOnVolume")) || (data1 === "branchMovedByCommand"))){validate586.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/SessionRestoreSkipReason/enum",keyword:"enum",params:{allowedValues: schema1085.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate586.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate586.errors = vErrors;return errors === 0;}
// prettier-ignore
validate586.errors = null as any[] | null;
// prettier-ignore
validate586.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate585(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate585.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.restoredFileCount === undefined) && (missing0 = "restoredFileCount")) || ((data.restoredLineCount === undefined) && (missing0 = "restoredLineCount"))) || ((data.skipped === undefined) && (missing0 = "skipped"))){validate585.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "restoredFileCount") || (key0 === "restoredLineCount")) || (key0 === "skipped"))){validate585.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.restoredFileCount !== undefined){let data0: any = data.restoredFileCount;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate585.errors = [{instancePath:instancePath+"/restoredFileCount",schemaPath:"#/properties/restoredFileCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate585.errors = [{instancePath:instancePath+"/restoredFileCount",schemaPath:"#/properties/restoredFileCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validate585.errors = [{instancePath:instancePath+"/restoredFileCount",schemaPath:"#/properties/restoredFileCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.restoredLineCount !== undefined){let data1: any = data.restoredLineCount;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate585.errors = [{instancePath:instancePath+"/restoredLineCount",schemaPath:"#/properties/restoredLineCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate585.errors = [{instancePath:instancePath+"/restoredLineCount",schemaPath:"#/properties/restoredLineCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate585.errors = [{instancePath:instancePath+"/restoredLineCount",schemaPath:"#/properties/restoredLineCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.skipped !== undefined){let data2: any = data.skipped;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data2)){var valid1: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validate586.call(this, data2[i0], {instancePath:instancePath+"/skipped/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate586.errors : vErrors.concat(validate586.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;if(!valid1){break;}}}else {validate585.errors = [{instancePath:instancePath+"/skipped",schemaPath:"#/properties/skipped/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validate585.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate585.errors = vErrors;return errors === 0;}
// prettier-ignore
validate585.errors = null as any[] | null;
// prettier-ignore
validate585.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate589(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate589.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!((key0 === "conversation") || (key0 === "files"))){validate589.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.conversation !== undefined){let data0: any = data.conversation;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(data0 && typeof data0 == "object" && !Array.isArray(data0)){let missing0: any;if((data0.reason === undefined) && (missing0 = "reason")){validate589.errors = [{instancePath:instancePath+"/conversation",schemaPath:"#/$defs/SessionRestoreFailure/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data0){if(!(key1 === "reason")){validate589.errors = [{instancePath:instancePath+"/conversation",schemaPath:"#/$defs/SessionRestoreFailure/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data0.reason !== undefined){let data1: any = data0.reason;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){validate589.errors = [{instancePath:instancePath+"/conversation/reason",schemaPath:"#/$defs/SessionRestoreFailure/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate589.errors = [{instancePath:instancePath+"/conversation/reason",schemaPath:"#/$defs/SessionRestoreFailure/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate589.errors = [{instancePath:instancePath+"/conversation",schemaPath:"#/$defs/SessionRestoreFailure/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.files !== undefined){let data2: any = data.files;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if((data2.reason === undefined) && (missing1 = "reason")){validate589.errors = [{instancePath:instancePath+"/files",schemaPath:"#/$defs/SessionRestoreFailure/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key2 in data2){if(!(key2 === "reason")){validate589.errors = [{instancePath:instancePath+"/files",schemaPath:"#/$defs/SessionRestoreFailure/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs11 === errors){if(data2.reason !== undefined){let data3: any = data2.reason;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(func1(data3) < 1){validate589.errors = [{instancePath:instancePath+"/files/reason",schemaPath:"#/$defs/SessionRestoreFailure/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate589.errors = [{instancePath:instancePath+"/files/reason",schemaPath:"#/$defs/SessionRestoreFailure/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate589.errors = [{instancePath:instancePath+"/files",schemaPath:"#/$defs/SessionRestoreFailure/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}else {validate589.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate589.errors = vErrors;return errors === 0;}
// prettier-ignore
validate589.errors = null as any[] | null;
// prettier-ignore
validate589.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate584(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate584.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate584.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.outcome;if(typeof tag0 == "string"){if(tag0 === "restoreFinished"){const _errs3: any = errors;const _errs5: any = errors;const _errs6: any = errors;let valid3: any = true;const _errs7: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){if(data.restored !== undefined){let data0: any = data.restored;if(!((data0 === "conversationAndFiles") || (data0 === "files"))){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}}var _valid0: any = _errs7 === errors;errors = _errs6;if(vErrors !== null){if(_errs6){vErrors.length = _errs6;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs9: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.files === undefined) && (missing0 = "files")){validate584.errors = [{instancePath,schemaPath:"#/oneOf/0/allOf/0/then/required",keyword:"required",params:{missingProperty: missing0}}];return false;}}var _valid0: any = _errs9 === errors;valid3 = _valid0;if(valid3){var props0: any = {};props0.files = true;props0.restored = true;}ifClause0 = "then";}else {const _errs10: any = errors;const _errs11: any = errors;const _errs12: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.files === undefined) && (missing1 = "files")){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}var valid5: any = _errs12 === errors;if(valid5){validate584.errors = [{instancePath,schemaPath:"#/oneOf/0/allOf/0/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs11;if(vErrors !== null){if(_errs11){vErrors.length = _errs11;}else {vErrors = null;}}}var _valid0: any = _errs10 === errors;valid3 = _valid0;ifClause0 = "else";}if(!valid3){const err2: any = {instancePath,schemaPath:"#/oneOf/0/allOf/0/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;validate584.errors = vErrors;return false;}var valid2: any = _errs5 === errors;if(valid2){const _errs13: any = errors;const _errs14: any = errors;let valid6: any = true;const _errs15: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){if(data.requested !== undefined){let data1: any = data.requested;const _errs16: any = errors;if(!((data1 === "conversationAndFiles") || (data1 === "conversation"))){const err3: any = {};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var valid7: any = _errs16 === errors;}else {var valid7: any = true;}if(valid7){if(data.restored !== undefined){let data2: any = data.restored;const _errs17: any = errors;if(!((data2 === "files") || (data2 === "nothing"))){const err4: any = {};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var valid7: any = _errs17 === errors;}else {var valid7: any = true;}}}var _valid1: any = _errs15 === errors;errors = _errs14;if(vErrors !== null){if(_errs14){vErrors.length = _errs14;}else {vErrors = null;}}if(_valid1){const _errs18: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.failures === undefined) && (missing2 = "failures")){validate584.errors = [{instancePath,schemaPath:"#/oneOf/0/allOf/1/then/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {if(data.failures !== undefined){let data3: any = data.failures;const _errs19: any = errors;if(errors === _errs19){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing3: any;if((data3.conversation === undefined) && (missing3 = "conversation")){validate584.errors = [{instancePath:instancePath+"/failures",schemaPath:"#/oneOf/0/allOf/1/then/properties/failures/required",keyword:"required",params:{missingProperty: missing3}}];return false;}}else {validate584.errors = [{instancePath:instancePath+"/failures",schemaPath:"#/oneOf/0/allOf/1/then/properties/failures/type",keyword:"type",params:{type: "object"}}];return false;}}}}}var _valid1: any = _errs18 === errors;valid6 = _valid1;if(valid6){var props1: any = {};props1.failures = true;props1.requested = true;props1.restored = true;}}if(!valid6){const err5: any = {instancePath,schemaPath:"#/oneOf/0/allOf/1/if",keyword:"if",params:{failingKeyword: "then"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validate584.errors = vErrors;return false;}var valid2: any = _errs13 === errors;if(valid2){if(props0 !== true && props1 !== undefined){if(props1 === true){props0 = true;}else {props0 = props0 || {};Object.assign(props0, props1);}}const _errs21: any = errors;const _errs22: any = errors;let valid9: any = true;const _errs23: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){if(data.requested !== undefined){let data4: any = data.requested;const _errs24: any = errors;if(!((data4 === "conversationAndFiles") || (data4 === "files"))){const err6: any = {};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}var valid10: any = _errs24 === errors;}else {var valid10: any = true;}if(valid10){if(data.restored !== undefined){let data5: any = data.restored;const _errs25: any = errors;if(!((data5 === "conversation") || (data5 === "nothing"))){const err7: any = {};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}var valid10: any = _errs25 === errors;}else {var valid10: any = true;}}}var _valid2: any = _errs23 === errors;errors = _errs22;if(vErrors !== null){if(_errs22){vErrors.length = _errs22;}else {vErrors = null;}}if(_valid2){const _errs26: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((data.failures === undefined) && (missing4 = "failures")){validate584.errors = [{instancePath,schemaPath:"#/oneOf/0/allOf/2/then/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {if(data.failures !== undefined){let data6: any = data.failures;const _errs27: any = errors;if(errors === _errs27){if(data6 && typeof data6 == "object" && !Array.isArray(data6)){let missing5: any;if((data6.files === undefined) && (missing5 = "files")){validate584.errors = [{instancePath:instancePath+"/failures",schemaPath:"#/oneOf/0/allOf/2/then/properties/failures/required",keyword:"required",params:{missingProperty: missing5}}];return false;}}else {validate584.errors = [{instancePath:instancePath+"/failures",schemaPath:"#/oneOf/0/allOf/2/then/properties/failures/type",keyword:"type",params:{type: "object"}}];return false;}}}}}var _valid2: any = _errs26 === errors;valid9 = _valid2;if(valid9){var props2: any = {};props2.failures = true;props2.requested = true;props2.restored = true;}}if(!valid9){const err8: any = {instancePath,schemaPath:"#/oneOf/0/allOf/2/if",keyword:"if",params:{failingKeyword: "then"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;validate584.errors = vErrors;return false;}var valid2: any = _errs21 === errors;if(valid2){if(props0 !== true && props2 !== undefined){if(props2 === true){props0 = true;}else {props0 = props0 || {};Object.assign(props0, props2);}}}}}if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if((((data.outcome === undefined) && (missing6 = "outcome")) || ((data.requested === undefined) && (missing6 = "requested"))) || ((data.restored === undefined) && (missing6 = "restored"))){validate584.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs29: any = errors;for(const key1 in data){if(!(((((key1 === "outcome") || (key1 === "requested")) || (key1 === "restored")) || (key1 === "files")) || (key1 === "failures"))){validate584.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs29 === errors){if(data.outcome !== undefined){let data7: any = data.outcome;const _errs30: any = errors;if(typeof data7 !== "string"){validate584.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("restoreFinished" !== data7){validate584.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/const",keyword:"const",params:{allowedValue: "restoreFinished"}}];return false;}var valid12: any = _errs30 === errors;}else {var valid12: any = true;}if(valid12){if(data.requested !== undefined){let data8: any = data.requested;const _errs32: any = errors;if(typeof data8 !== "string"){validate584.errors = [{instancePath:instancePath+"/requested",schemaPath:"#/$defs/SessionRestoreScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data8 === "conversationAndFiles") || (data8 === "conversation")) || (data8 === "files"))){validate584.errors = [{instancePath:instancePath+"/requested",schemaPath:"#/$defs/SessionRestoreScope/enum",keyword:"enum",params:{allowedValues: schema1081.enum}}];return false;}var valid12: any = _errs32 === errors;}else {var valid12: any = true;}if(valid12){if(data.restored !== undefined){let data9: any = data.restored;const _errs35: any = errors;if(typeof data9 !== "string"){validate584.errors = [{instancePath:instancePath+"/restored",schemaPath:"#/$defs/SessionRestoredScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data9 === "conversationAndFiles") || (data9 === "conversation")) || (data9 === "files")) || (data9 === "nothing"))){validate584.errors = [{instancePath:instancePath+"/restored",schemaPath:"#/$defs/SessionRestoredScope/enum",keyword:"enum",params:{allowedValues: schema1082.enum}}];return false;}var valid12: any = _errs35 === errors;}else {var valid12: any = true;}if(valid12){if(data.files !== undefined){const _errs38: any = errors;if(!(validate585.call(this, data.files, {instancePath:instancePath+"/files",parentData:data,parentDataProperty:"files",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate585.errors : vErrors.concat(validate585.errors);errors = vErrors.length;}var valid12: any = _errs38 === errors;}else {var valid12: any = true;}if(valid12){if(data.failures !== undefined){const _errs39: any = errors;if(!(validate589.call(this, data.failures, {instancePath:instancePath+"/failures",parentData:data,parentDataProperty:"failures",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate589.errors : vErrors.concat(validate589.errors);errors = vErrors.length;}var valid12: any = _errs39 === errors;}else {var valid12: any = true;}}}}}}}}else {validate584.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "resendUnapplied"){const _errs40: any = errors;if(errors === _errs40){if(data && typeof data == "object" && !Array.isArray(data)){let missing7: any;if(((data.outcome === undefined) && (missing7 = "outcome")) || ((data.reason === undefined) && (missing7 = "reason"))){validate584.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing7}}];return false;}else {const _errs42: any = errors;for(const key2 in data){if(!((key2 === "outcome") || (key2 === "reason"))){validate584.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs42 === errors){if(data.outcome !== undefined){let data12: any = data.outcome;const _errs43: any = errors;if(typeof data12 !== "string"){validate584.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("resendUnapplied" !== data12){validate584.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/const",keyword:"const",params:{allowedValue: "resendUnapplied"}}];return false;}var valid16: any = _errs43 === errors;}else {var valid16: any = true;}if(valid16){if(data.reason !== undefined){let data13: any = data.reason;const _errs45: any = errors;if(errors === _errs45){if(typeof data13 === "string"){if(func1(data13) < 1){validate584.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate584.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid16: any = _errs45 === errors;}else {var valid16: any = true;}}}}}else {validate584.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate584.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "outcome", tagValue: tag0}}];return false;}}else {validate584.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "outcome", tagValue: tag0}}];return false;}}}else {validate584.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate584.errors = vErrors;return errors === 0;}
// prettier-ignore
validate584.errors = null as any[] | null;
// prettier-ignore
validate584.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2060(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionRestoreCompletedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2060.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.target === undefined) && (missing0 = "target"))) || ((data.result === undefined) && (missing0 = "result"))){validate2060.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "target")) || (key0 === "result"))){validate2060.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2060.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2060.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.target !== undefined){const _errs6: any = errors;if(!(validate582.call(this, data.target, {instancePath:instancePath+"/target",parentData:data,parentDataProperty:"target",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate582.errors : vErrors.concat(validate582.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.result !== undefined){const _errs7: any = errors;if(!(validate584.call(this, data.result, {instancePath:instancePath+"/result",parentData:data,parentDataProperty:"result",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate584.errors : vErrors.concat(validate584.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}else {validate2060.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2060.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2060.errors = null as any[] | null;
// prettier-ignore
validate2060.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2063(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionRestoreOutcome {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2063.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate2063.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.outcome;if(typeof tag0 == "string"){if(tag0 === "restoreFinished"){const _errs3: any = errors;const _errs5: any = errors;const _errs6: any = errors;let valid3: any = true;const _errs7: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){if(data.restored !== undefined){let data0: any = data.restored;if(!((data0 === "conversationAndFiles") || (data0 === "files"))){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}}var _valid0: any = _errs7 === errors;errors = _errs6;if(vErrors !== null){if(_errs6){vErrors.length = _errs6;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs9: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.files === undefined) && (missing0 = "files")){validate2063.errors = [{instancePath,schemaPath:"#/oneOf/0/allOf/0/then/required",keyword:"required",params:{missingProperty: missing0}}];return false;}}var _valid0: any = _errs9 === errors;valid3 = _valid0;if(valid3){var props0: any = {};props0.files = true;props0.restored = true;}ifClause0 = "then";}else {const _errs10: any = errors;const _errs11: any = errors;const _errs12: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.files === undefined) && (missing1 = "files")){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}var valid5: any = _errs12 === errors;if(valid5){validate2063.errors = [{instancePath,schemaPath:"#/oneOf/0/allOf/0/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs11;if(vErrors !== null){if(_errs11){vErrors.length = _errs11;}else {vErrors = null;}}}var _valid0: any = _errs10 === errors;valid3 = _valid0;ifClause0 = "else";}if(!valid3){const err2: any = {instancePath,schemaPath:"#/oneOf/0/allOf/0/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;validate2063.errors = vErrors;return false;}var valid2: any = _errs5 === errors;if(valid2){const _errs13: any = errors;const _errs14: any = errors;let valid6: any = true;const _errs15: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){if(data.requested !== undefined){let data1: any = data.requested;const _errs16: any = errors;if(!((data1 === "conversationAndFiles") || (data1 === "conversation"))){const err3: any = {};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var valid7: any = _errs16 === errors;}else {var valid7: any = true;}if(valid7){if(data.restored !== undefined){let data2: any = data.restored;const _errs17: any = errors;if(!((data2 === "files") || (data2 === "nothing"))){const err4: any = {};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var valid7: any = _errs17 === errors;}else {var valid7: any = true;}}}var _valid1: any = _errs15 === errors;errors = _errs14;if(vErrors !== null){if(_errs14){vErrors.length = _errs14;}else {vErrors = null;}}if(_valid1){const _errs18: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.failures === undefined) && (missing2 = "failures")){validate2063.errors = [{instancePath,schemaPath:"#/oneOf/0/allOf/1/then/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {if(data.failures !== undefined){let data3: any = data.failures;const _errs19: any = errors;if(errors === _errs19){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing3: any;if((data3.conversation === undefined) && (missing3 = "conversation")){validate2063.errors = [{instancePath:instancePath+"/failures",schemaPath:"#/oneOf/0/allOf/1/then/properties/failures/required",keyword:"required",params:{missingProperty: missing3}}];return false;}}else {validate2063.errors = [{instancePath:instancePath+"/failures",schemaPath:"#/oneOf/0/allOf/1/then/properties/failures/type",keyword:"type",params:{type: "object"}}];return false;}}}}}var _valid1: any = _errs18 === errors;valid6 = _valid1;if(valid6){var props1: any = {};props1.failures = true;props1.requested = true;props1.restored = true;}}if(!valid6){const err5: any = {instancePath,schemaPath:"#/oneOf/0/allOf/1/if",keyword:"if",params:{failingKeyword: "then"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validate2063.errors = vErrors;return false;}var valid2: any = _errs13 === errors;if(valid2){if(props0 !== true && props1 !== undefined){if(props1 === true){props0 = true;}else {props0 = props0 || {};Object.assign(props0, props1);}}const _errs21: any = errors;const _errs22: any = errors;let valid9: any = true;const _errs23: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){if(data.requested !== undefined){let data4: any = data.requested;const _errs24: any = errors;if(!((data4 === "conversationAndFiles") || (data4 === "files"))){const err6: any = {};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}var valid10: any = _errs24 === errors;}else {var valid10: any = true;}if(valid10){if(data.restored !== undefined){let data5: any = data.restored;const _errs25: any = errors;if(!((data5 === "conversation") || (data5 === "nothing"))){const err7: any = {};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}var valid10: any = _errs25 === errors;}else {var valid10: any = true;}}}var _valid2: any = _errs23 === errors;errors = _errs22;if(vErrors !== null){if(_errs22){vErrors.length = _errs22;}else {vErrors = null;}}if(_valid2){const _errs26: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((data.failures === undefined) && (missing4 = "failures")){validate2063.errors = [{instancePath,schemaPath:"#/oneOf/0/allOf/2/then/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {if(data.failures !== undefined){let data6: any = data.failures;const _errs27: any = errors;if(errors === _errs27){if(data6 && typeof data6 == "object" && !Array.isArray(data6)){let missing5: any;if((data6.files === undefined) && (missing5 = "files")){validate2063.errors = [{instancePath:instancePath+"/failures",schemaPath:"#/oneOf/0/allOf/2/then/properties/failures/required",keyword:"required",params:{missingProperty: missing5}}];return false;}}else {validate2063.errors = [{instancePath:instancePath+"/failures",schemaPath:"#/oneOf/0/allOf/2/then/properties/failures/type",keyword:"type",params:{type: "object"}}];return false;}}}}}var _valid2: any = _errs26 === errors;valid9 = _valid2;if(valid9){var props2: any = {};props2.failures = true;props2.requested = true;props2.restored = true;}}if(!valid9){const err8: any = {instancePath,schemaPath:"#/oneOf/0/allOf/2/if",keyword:"if",params:{failingKeyword: "then"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;validate2063.errors = vErrors;return false;}var valid2: any = _errs21 === errors;if(valid2){if(props0 !== true && props2 !== undefined){if(props2 === true){props0 = true;}else {props0 = props0 || {};Object.assign(props0, props2);}}}}}if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if((((data.outcome === undefined) && (missing6 = "outcome")) || ((data.requested === undefined) && (missing6 = "requested"))) || ((data.restored === undefined) && (missing6 = "restored"))){validate2063.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs29: any = errors;for(const key1 in data){if(!(((((key1 === "outcome") || (key1 === "requested")) || (key1 === "restored")) || (key1 === "files")) || (key1 === "failures"))){validate2063.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs29 === errors){if(data.outcome !== undefined){let data7: any = data.outcome;const _errs30: any = errors;if(typeof data7 !== "string"){validate2063.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("restoreFinished" !== data7){validate2063.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/const",keyword:"const",params:{allowedValue: "restoreFinished"}}];return false;}var valid12: any = _errs30 === errors;}else {var valid12: any = true;}if(valid12){if(data.requested !== undefined){let data8: any = data.requested;const _errs32: any = errors;if(typeof data8 !== "string"){validate2063.errors = [{instancePath:instancePath+"/requested",schemaPath:"#/$defs/SessionRestoreScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data8 === "conversationAndFiles") || (data8 === "conversation")) || (data8 === "files"))){validate2063.errors = [{instancePath:instancePath+"/requested",schemaPath:"#/$defs/SessionRestoreScope/enum",keyword:"enum",params:{allowedValues: schema1081.enum}}];return false;}var valid12: any = _errs32 === errors;}else {var valid12: any = true;}if(valid12){if(data.restored !== undefined){let data9: any = data.restored;const _errs35: any = errors;if(typeof data9 !== "string"){validate2063.errors = [{instancePath:instancePath+"/restored",schemaPath:"#/$defs/SessionRestoredScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data9 === "conversationAndFiles") || (data9 === "conversation")) || (data9 === "files")) || (data9 === "nothing"))){validate2063.errors = [{instancePath:instancePath+"/restored",schemaPath:"#/$defs/SessionRestoredScope/enum",keyword:"enum",params:{allowedValues: schema1082.enum}}];return false;}var valid12: any = _errs35 === errors;}else {var valid12: any = true;}if(valid12){if(data.files !== undefined){const _errs38: any = errors;if(!(validate585.call(this, data.files, {instancePath:instancePath+"/files",parentData:data,parentDataProperty:"files",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate585.errors : vErrors.concat(validate585.errors);errors = vErrors.length;}var valid12: any = _errs38 === errors;}else {var valid12: any = true;}if(valid12){if(data.failures !== undefined){const _errs39: any = errors;if(!(validate589.call(this, data.failures, {instancePath:instancePath+"/failures",parentData:data,parentDataProperty:"failures",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate589.errors : vErrors.concat(validate589.errors);errors = vErrors.length;}var valid12: any = _errs39 === errors;}else {var valid12: any = true;}}}}}}}}else {validate2063.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "resendUnapplied"){const _errs40: any = errors;if(errors === _errs40){if(data && typeof data == "object" && !Array.isArray(data)){let missing7: any;if(((data.outcome === undefined) && (missing7 = "outcome")) || ((data.reason === undefined) && (missing7 = "reason"))){validate2063.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing7}}];return false;}else {const _errs42: any = errors;for(const key2 in data){if(!((key2 === "outcome") || (key2 === "reason"))){validate2063.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs42 === errors){if(data.outcome !== undefined){let data12: any = data.outcome;const _errs43: any = errors;if(typeof data12 !== "string"){validate2063.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("resendUnapplied" !== data12){validate2063.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/const",keyword:"const",params:{allowedValue: "resendUnapplied"}}];return false;}var valid16: any = _errs43 === errors;}else {var valid16: any = true;}if(valid16){if(data.reason !== undefined){let data13: any = data.reason;const _errs45: any = errors;if(errors === _errs45){if(typeof data13 === "string"){if(func1(data13) < 1){validate2063.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2063.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid16: any = _errs45 === errors;}else {var valid16: any = true;}}}}}else {validate2063.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2063.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "outcome", tagValue: tag0}}];return false;}}else {validate2063.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "outcome", tagValue: tag0}}];return false;}}}else {validate2063.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2063.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2063.errors = null as any[] | null;
// prettier-ignore
validate2063.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2066(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionRestorePreviewRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2066.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.target === undefined) && (missing0 = "target"))) || ((data.scope === undefined) && (missing0 = "scope"))){validate2066.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "target")) || (key0 === "scope"))){validate2066.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2066.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2066.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.target !== undefined){const _errs6: any = errors;if(!(validate582.call(this, data.target, {instancePath:instancePath+"/target",parentData:data,parentDataProperty:"target",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate582.errors : vErrors.concat(validate582.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.scope !== undefined){let data2: any = data.scope;const _errs7: any = errors;if(typeof data2 !== "string"){validate2066.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/$defs/SessionRestoreScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "conversationAndFiles") || (data2 === "conversation")) || (data2 === "files"))){validate2066.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/$defs/SessionRestoreScope/enum",keyword:"enum",params:{allowedValues: schema1081.enum}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}else {validate2066.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2066.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2066.errors = null as any[] | null;
// prettier-ignore
validate2066.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2070(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2070.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.paths === undefined) && (missing0 = "paths"))){validate2070.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "paths"))){validate2070.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2070.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2070.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.paths !== undefined){let data1: any = data.paths;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 4096){validate2070.errors = [{instancePath:instancePath+"/paths/" + i0,schemaPath:"#/properties/paths/items/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validate2070.errors = [{instancePath:instancePath+"/paths/" + i0,schemaPath:"#/properties/paths/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data2)){validate2070.errors = [{instancePath:instancePath+"/paths/" + i0,schemaPath:"#/properties/paths/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2070.errors = [{instancePath:instancePath+"/paths/" + i0,schemaPath:"#/properties/paths/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;if(!valid2){break;}}}else {validate2070.errors = [{instancePath:instancePath+"/paths",schemaPath:"#/properties/paths/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2070.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2070.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2070.errors = null as any[] | null;
// prettier-ignore
validate2070.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2068(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionRestorePreviewResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2068.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.fileCount === undefined) && (missing0 = "fileCount")) || ((data.lineCount === undefined) && (missing0 = "lineCount"))) || ((data.skipped === undefined) && (missing0 = "skipped"))) || ((data.affectedChildCount === undefined) && (missing0 = "affectedChildCount"))) || ((data.runningCommands === undefined) && (missing0 = "runningCommands"))) || ((data.ignoredFolders === undefined) && (missing0 = "ignoredFolders"))) || ((data.commandsRanAfterPoint === undefined) && (missing0 = "commandsRanAfterPoint"))) || ((data.alsoChangedBy === undefined) && (missing0 = "alsoChangedBy"))){validate2068.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "fileCount") || (key0 === "lineCount")) || (key0 === "skipped")) || (key0 === "affectedChildCount")) || (key0 === "runningCommands")) || (key0 === "ignoredFolders")) || (key0 === "commandsRanAfterPoint")) || (key0 === "alsoChangedBy"))){validate2068.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.fileCount !== undefined){let data0: any = data.fileCount;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate2068.errors = [{instancePath:instancePath+"/fileCount",schemaPath:"#/properties/fileCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate2068.errors = [{instancePath:instancePath+"/fileCount",schemaPath:"#/properties/fileCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validate2068.errors = [{instancePath:instancePath+"/fileCount",schemaPath:"#/properties/fileCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.lineCount !== undefined){let data1: any = data.lineCount;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate2068.errors = [{instancePath:instancePath+"/lineCount",schemaPath:"#/properties/lineCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate2068.errors = [{instancePath:instancePath+"/lineCount",schemaPath:"#/properties/lineCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate2068.errors = [{instancePath:instancePath+"/lineCount",schemaPath:"#/properties/lineCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.skipped !== undefined){let data2: any = data.skipped;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data2)){var valid1: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validate586.call(this, data2[i0], {instancePath:instancePath+"/skipped/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate586.errors : vErrors.concat(validate586.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;if(!valid1){break;}}}else {validate2068.errors = [{instancePath:instancePath+"/skipped",schemaPath:"#/properties/skipped/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.affectedChildCount !== undefined){let data4: any = data.affectedChildCount;const _errs9: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate2068.errors = [{instancePath:instancePath+"/affectedChildCount",schemaPath:"#/properties/affectedChildCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate2068.errors = [{instancePath:instancePath+"/affectedChildCount",schemaPath:"#/properties/affectedChildCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validate2068.errors = [{instancePath:instancePath+"/affectedChildCount",schemaPath:"#/properties/affectedChildCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.runningCommands !== undefined){let data5: any = data.runningCommands;const _errs11: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate2068.errors = [{instancePath:instancePath+"/runningCommands",schemaPath:"#/properties/runningCommands/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs11){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate2068.errors = [{instancePath:instancePath+"/runningCommands",schemaPath:"#/properties/runningCommands/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validate2068.errors = [{instancePath:instancePath+"/runningCommands",schemaPath:"#/properties/runningCommands/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.ignoredFolders !== undefined){let data6: any = data.ignoredFolders;const _errs13: any = errors;if(errors === _errs13){if(Array.isArray(data6)){var valid2: any = true;const len1: any = data6.length;for(let i1=0; i1<len1; i1++){let data7: any = data6[i1];const _errs15: any = errors;if(errors === _errs15){if(typeof data7 === "string"){if(func1(data7) > 4096){validate2068.errors = [{instancePath:instancePath+"/ignoredFolders/" + i1,schemaPath:"#/properties/ignoredFolders/items/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data7) < 1){validate2068.errors = [{instancePath:instancePath+"/ignoredFolders/" + i1,schemaPath:"#/properties/ignoredFolders/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data7)){validate2068.errors = [{instancePath:instancePath+"/ignoredFolders/" + i1,schemaPath:"#/properties/ignoredFolders/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2068.errors = [{instancePath:instancePath+"/ignoredFolders/" + i1,schemaPath:"#/properties/ignoredFolders/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs15 === errors;if(!valid2){break;}}}else {validate2068.errors = [{instancePath:instancePath+"/ignoredFolders",schemaPath:"#/properties/ignoredFolders/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.commandsRanAfterPoint !== undefined){const _errs17: any = errors;if(typeof data.commandsRanAfterPoint !== "boolean"){validate2068.errors = [{instancePath:instancePath+"/commandsRanAfterPoint",schemaPath:"#/properties/commandsRanAfterPoint/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}if(valid0){if(data.alsoChangedBy !== undefined){let data9: any = data.alsoChangedBy;const _errs19: any = errors;if(errors === _errs19){if(Array.isArray(data9)){var valid3: any = true;const len2: any = data9.length;for(let i2=0; i2<len2; i2++){const _errs21: any = errors;if(!(validate2070.call(this, data9[i2], {instancePath:instancePath+"/alsoChangedBy/" + i2,parentData:data9,parentDataProperty:i2,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2070.errors : vErrors.concat(validate2070.errors);errors = vErrors.length;}var valid3: any = _errs21 === errors;if(!valid3){break;}}}else {validate2068.errors = [{instancePath:instancePath+"/alsoChangedBy",schemaPath:"#/properties/alsoChangedBy/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validate2068.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2068.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2068.errors = null as any[] | null;
// prettier-ignore
validate2068.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern222 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate196(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate196.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(Array.isArray(data)){var valid0: any = true;const len0: any = data.length;for(let i0=0; i0<len0; i0++){let data0: any = data[i0];const _errs1: any = errors;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate196.errors = [{instancePath:instancePath+"/" + i0,schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate196.errors = [{instancePath:instancePath+"/" + i0,schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs1 === errors;if(!valid0){break;}}}else {validate196.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "array"}}];return false;}}validate196.errors = vErrors;return errors === 0;}
// prettier-ignore
validate196.errors = null as any[] | null;
// prettier-ignore
validate196.evaluated = {"items":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2074(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2074.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.content === undefined) && (missing0 = "content")){validate2074.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "content") || (key0 === "attachments"))){validate2074.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.content !== undefined){let data0: any = data.content;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validate2074.errors = [{instancePath:instancePath+"/content",schemaPath:"#/properties/content/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate2074.errors = [{instancePath:instancePath+"/content",schemaPath:"#/properties/content/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2074.errors = [{instancePath:instancePath+"/content",schemaPath:"#/properties/content/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.attachments !== undefined){const _errs4: any = errors;if(!(validate196.call(this, data.attachments, {instancePath:instancePath+"/attachments",parentData:data,parentDataProperty:"attachments",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate196.errors : vErrors.concat(validate196.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate2074.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2074.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2074.errors = null as any[] | null;
// prettier-ignore
validate2074.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2072(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionRestoreRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2072.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = true;const _errs2: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.resend === undefined) && (missing0 = "resend")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}var _valid0: any = _errs2 === errors;errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}if(_valid0){const _errs3: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){if(data.scope !== undefined){if("conversationAndFiles" !== data.scope){validate2072.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/then/properties/scope/const",keyword:"const",params:{allowedValue: "conversationAndFiles"}}];return false;}}}var _valid0: any = _errs3 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.scope = true;props0.resend = true;}}if(!valid0){const err1: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: "then"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validate2072.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((data.sessionId === undefined) && (missing1 = "sessionId")) || ((data.target === undefined) && (missing1 = "target"))) || ((data.scope === undefined) && (missing1 = "scope"))) || ((data.clientIdempotencyKey === undefined) && (missing1 = "clientIdempotencyKey"))) || ((data.includeAlsoChanged === undefined) && (missing1 = "includeAlsoChanged"))){validate2072.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs5: any = errors;for(const key0 in data){if(!((((((key0 === "sessionId") || (key0 === "target")) || (key0 === "scope")) || (key0 === "clientIdempotencyKey")) || (key0 === "includeAlsoChanged")) || (key0 === "resend"))){validate2072.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs5 === errors){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2072.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2072.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.target !== undefined){const _errs10: any = errors;if(!(validate582.call(this, data.target, {instancePath:instancePath+"/target",parentData:data,parentDataProperty:"target",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate582.errors : vErrors.concat(validate582.errors);errors = vErrors.length;}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.scope !== undefined){let data3: any = data.scope;const _errs11: any = errors;if(typeof data3 !== "string"){validate2072.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/$defs/SessionRestoreScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data3 === "conversationAndFiles") || (data3 === "conversation")) || (data3 === "files"))){validate2072.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/$defs/SessionRestoreScope/enum",keyword:"enum",params:{allowedValues: schema1081.enum}}];return false;}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.clientIdempotencyKey !== undefined){let data4: any = data.clientIdempotencyKey;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(!pattern222.test(data4)){validate2072.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate2072.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data.includeAlsoChanged !== undefined){const _errs16: any = errors;if(typeof data.includeAlsoChanged !== "boolean"){validate2072.errors = [{instancePath:instancePath+"/includeAlsoChanged",schemaPath:"#/properties/includeAlsoChanged/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.resend !== undefined){const _errs18: any = errors;if(!(validate2074.call(this, data.resend, {instancePath:instancePath+"/resend",parentData:data,parentDataProperty:"resend",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2074.errors : vErrors.concat(validate2074.errors);errors = vErrors.length;}var valid2: any = _errs18 === errors;}else {var valid2: any = true;}}}}}}}}}else {validate2072.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2072.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2072.errors = null as any[] | null;
// prettier-ignore
validate2072.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2077(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionSnapshotListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2077.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate2077.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate2077.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2077.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2077.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2077.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2077.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2077.errors = null as any[] | null;
// prettier-ignore
validate2077.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate2079(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2079.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.snapshotId === undefined) && (missing0 = "snapshotId")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))){validate2079.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "snapshotId") || (key0 === "name")) || (key0 === "createdAt"))){validate2079.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.snapshotId !== undefined){let data0: any = data.snapshotId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate2079.errors = [{instancePath:instancePath+"/snapshotId",schemaPath:"#/$defs/SnapshotId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate2079.errors = [{instancePath:instancePath+"/snapshotId",schemaPath:"#/$defs/SnapshotId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2079.errors = [{instancePath:instancePath+"/snapshotId",schemaPath:"#/$defs/SnapshotId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){validate2079.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2079.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.createdAt !== undefined){let data2: any = data.createdAt;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(!pattern5.test(data2)){validate2079.errors = [{instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2079.errors = [{instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate2079.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2079.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2079.errors = null as any[] | null;
// prettier-ignore
validate2079.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2078(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionSnapshotListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2078.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.snapshots === undefined) && (missing0 = "snapshots")){validate2078.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "snapshots")){validate2078.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.snapshots !== undefined){let data0: any = data.snapshots;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate2079.call(this, data0[i0], {instancePath:instancePath+"/snapshots/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2079.errors : vErrors.concat(validate2079.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate2078.errors = [{instancePath:instancePath+"/snapshots",schemaPath:"#/properties/snapshots/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate2078.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2078.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2078.errors = null as any[] | null;
// prettier-ignore
validate2078.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionRestoreCompletedPayload}. */
export const validateSessionRestoreCompletedPayload: SchemaCheck<SessionRestoreCompletedPayload> =
  validate2060;
/** Checks that a value is a {@link SessionRestoreOutcome}. */
export const validateSessionRestoreOutcome: SchemaCheck<SessionRestoreOutcome> = validate2063;
/** Checks that a value is a {@link SessionRestorePreviewRequest}. */
export const validateSessionRestorePreviewRequest: SchemaCheck<SessionRestorePreviewRequest> =
  validate2066;
/** Checks that a value is a {@link SessionRestorePreviewResponse}. */
export const validateSessionRestorePreviewResponse: SchemaCheck<SessionRestorePreviewResponse> =
  validate2068;
/** Checks that a value is a {@link SessionRestoreRequest}. */
export const validateSessionRestoreRequest: SchemaCheck<SessionRestoreRequest> = validate2072;
/** Checks that a value is a {@link SessionSnapshotListRequest}. */
export const validateSessionSnapshotListRequest: SchemaCheck<SessionSnapshotListRequest> =
  validate2077;
/** Checks that a value is a {@link SessionSnapshotListResponse}. */
export const validateSessionSnapshotListResponse: SchemaCheck<SessionSnapshotListResponse> =
  validate2078;

/** The methods of {@link SESSION_RESTORE_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionRestoreMethodDescriptors {
  readonly "session.restore.preview": {
    readonly method: "session.restore.preview";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionRestorePreviewRequest>;
    readonly responseCheck: SchemaCheck<SessionRestorePreviewResponse>;
  };
  readonly "session.restore": {
    readonly method: "session.restore";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionRestoreRequest>;
    readonly responseCheck: SchemaCheck<SessionRestoreOutcome>;
  };
  readonly "session.snapshot.list": {
    readonly method: "session.snapshot.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionSnapshotListRequest>;
    readonly responseCheck: SchemaCheck<SessionSnapshotListResponse>;
  };
}
/** The undo methods, each with its types. */
export const SESSION_RESTORE_METHOD_DESCRIPTORS: SessionRestoreMethodDescriptors = Object.freeze({
  "session.restore.preview": Object.freeze({
    method: "session.restore.preview",
    procedureType: "query",
    mutating: false,
    requestCheck: validateSessionRestorePreviewRequest,
    responseCheck: validateSessionRestorePreviewResponse,
  }),
  "session.restore": Object.freeze({
    method: "session.restore",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionRestoreRequest,
    responseCheck: validateSessionRestoreOutcome,
  }),
  "session.snapshot.list": Object.freeze({
    method: "session.snapshot.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateSessionSnapshotListRequest,
    responseCheck: validateSessionSnapshotListResponse,
  }),
});
