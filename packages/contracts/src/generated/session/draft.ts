// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The composer's daemon-held store for one session: the unsent draft with what rides with its words, the staged files, covering part of a staged picture, and the refusals staging can answer with.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { AttachmentReferenceList } from "../artifacts/attachment-reference.js";
import type { ArtifactId } from "../artifacts/id.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import type { WorkspaceId } from "../repo/mount.js";
import type { QueuedSkillPick } from "../run/queue.js";
import type { SessionId } from "./id.js";

/** A draft save carrying a revision that is no longer the draft's current one. */
export const SESSION_DRAFT_REVISION_STALE_CODE = "session.draft.revisionStale" as const;

/** The code for a file the session cannot stage. */
export const SESSION_ATTACHMENT_REFUSED_CODE = "session.attachment.refused" as const;

/**
 * One thing to stage: a file picked, dropped or pasted, by its path, or a resource a tool server
 * publishes. A path reaches the daemon only from the main process or the command line; a
 * resource's address names it on its server and is never read as a path.
 */
export type SessionAttachmentItem =
  | {
      kind: "file";
      /**
       * The client's id for this one item, so a retried stage never stages it twice.
       */
      clientStagingId: string;
      /**
       * The file's path.
       */
      path: string;
    }
  | {
      kind: "mcpResource";
      /**
       * The client's id for this one item, so a retried stage never stages it twice.
       */
      clientStagingId: string;
      /**
       * The session's name for the server.
       */
      serverName: string;
      /**
       * The resource's own address on the server.
       */
      uri: string;
    };
/**
 * Why the session would not stage a file, by a rule of its own.
 */
export type SessionAttachmentLimitReason =
  | "countLimit"
  | "folder"
  | "providerTakesNoAttachments"
  | "cardWaiting";
/**
 * Why one item was not staged: a session rule, the provider's refusal with its words, a failed
 * copy with the daemon's cause, a disk too full with the room it has, or the ingest being busy.
 */
export type SessionAttachmentRefusalCause =
  | {
      /**
       * Always `session.attachment.refused`.
       */
      code: "session.attachment.refused";
      /**
       * The rule.
       */
      reason: SessionAttachmentLimitReason;
    }
  | {
      /**
       * Always `session.attachment.refused`.
       */
      code: "session.attachment.refused";
      /**
       * Always `providerRefused`.
       */
      reason: "providerRefused";
      /**
       * The provider's own words, shown as given.
       */
      providerMessage: string;
    }
  | {
      /**
       * Always `session.attachment.refused`.
       */
      code: "session.attachment.refused";
      /**
       * Always `copyFailed`.
       */
      reason: "copyFailed";
      /**
       * The daemon's own cause, the text after `·` on the refusal line.
       */
      detail: string;
    }
  | {
      /**
       * Always `artifact.tooLarge`.
       */
      code: "artifact.tooLarge";
      /**
       * The room the disk has, in bytes.
       */
      availableBytes: number;
    }
  | {
      /**
       * Always `artifact.ingest.capacityExhausted`.
       */
      code: "artifact.ingest.capacityExhausted";
    };

/**
 * What rides with a draft's words, in the shapes a send carries them: the files, the skill picks,
 * the output speed of its turn and the repository its run binds to. A message a Stop or an
 * interrupt returns to the composer brings its own here, so it is sent again whole.
 */
export interface SessionDraftExtras {
  /**
   * The files, in staging order, by artifact id. A returned message's files stay here as the
   * artifacts they are and go out as the next send's `attachments`.
   */
  attachments?: AttachmentReferenceList;
  /**
   * The skills picked, in the order picked.
   */
  skills?: QueuedSkillPick[];
  /**
   * The output-speed level its turn alone runs at.
   */
  outputSpeedForTurn?: string;
  /**
   * The repository the run its send starts binds to.
   */
  workspaceId?: WorkspaceId;
}
/**
 * A session's unsent draft, whole: the words and what rides with them. A draft the person saved
 * and one a Stop or an interrupt returned read the same. The text has no length limit of its own:
 * a message's limit is the send's to state, so a draft the send would take is never refused here.
 */
export interface SessionDraft {
  /**
   * The words; empty when none are typed.
   */
  text: string;
  /**
   * What rides with the words.
   */
  extras: SessionDraftExtras;
}
/**
 * Saves a session's draft. `draft` is the whole draft and replaces the one held; an empty draft,
 * no words and no extras, clears it, which is what Send does. A save over a draft that changed
 * since `expectedRevision` is refused rather than overwriting it.
 */
export interface SessionDraftUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The whole draft; an empty one clears it.
   */
  draft: SessionDraft;
  /**
   * The draft revision the save was typed over; 0 when no draft was ever held.
   */
  expectedRevision: number;
}
/**
 * The draft's new revision and when the daemon stored it.
 */
export interface SessionDraftUpdateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The draft's new revision.
   */
  revision: number;
  /**
   * When the draft was stored.
   */
  updatedAt: WireInstant;
}
/**
 * `session.draft.subscribe`: follows a session's draft, the draft held now and again after each
 * change.
 */
export interface SessionDraftSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * A session's draft as the daemon holds it, with its revision: an empty draft at revision 0
 * before any draft was held.
 */
export interface HeldSessionDraft {
  /**
   * The draft, whole.
   */
  draft: SessionDraft;
  /**
   * Its revision.
   */
  revision: number;
}
/**
 * One staged file as the daemon holds it. Every member is what the daemon found in the bytes it
 * copied, never what the caller declared: the name it stored the file under, the media type it
 * read from the bytes, and the size it measured.
 */
export interface SessionAttachmentSummary {
  /**
   * The staged file's artifact.
   */
  artifactId: ArtifactId;
  /**
   * The name the daemon stored it under.
   */
  fileName: string;
  /**
   * The media type read from its bytes.
   */
  mimeType: string;
  /**
   * Its size in bytes, as measured.
   */
  sizeBytes: number;
}
/**
 * Stages files for the next message. The count is not limited here: a pick over the message's
 * limit stages as many as fit and refuses each of the rest by name; an empty list is refused.
 */
export interface SessionAttachmentAddRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The things to stage; at least one.
   *
   * @minItems 1
   */
  items: [SessionAttachmentItem, ...SessionAttachmentItem[]];
}
/**
 * One item the daemon did not stage, by the name the refusal line shows.
 */
export interface SessionAttachmentRefusal {
  /**
   * The client's id for the item.
   */
  clientStagingId: string;
  /**
   * The name the refusal line shows.
   */
  name: string;
  /**
   * Why it was not staged.
   */
  cause: SessionAttachmentRefusalCause;
}
/**
 * The whole staged set after the add, so a client draws what the daemon holds rather than merging
 * its own add, and each item it did not stage with the cause.
 */
export interface SessionAttachmentAddResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The staged set.
   */
  attachments: SessionAttachmentSummary[];
  /**
   * The items not staged.
   */
  refused: SessionAttachmentRefusal[];
}
/**
 * Unstages one file. The artifact itself keeps its own life; only its place in the staged set
 * goes. Removing a file that is no longer staged answers with the set as it is.
 */
export interface SessionAttachmentRemoveRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The staged file's artifact.
   */
  artifactId: ArtifactId;
}
/**
 * The whole staged set left after the removal.
 */
export interface SessionAttachmentRemoveResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The staged set.
   */
  attachments: SessionAttachmentSummary[];
}
/**
 * One box to cover, in the picture's own pixels from its top-left corner; never empty.
 */
export interface SessionAttachmentCoverBox {
  /**
   * The left edge.
   */
  x: number;
  /**
   * The top edge.
   */
  y: number;
  /**
   * The width; at least one.
   */
  width: number;
  /**
   * The height; at least one.
   */
  height: number;
}
/**
 * Covers parts of a staged picture before Send. The daemon draws the boxes into the pixels, stores
 * the covered copy as a new artifact that takes the old one's place in the staged set, and deletes
 * the uncovered copy, so the provider only ever receives the covered picture. A picture already
 * sent cannot be covered; an empty box list is refused.
 */
export interface SessionAttachmentCoverRequest {
  /**
   * The staged picture.
   */
  attachmentId: ArtifactId;
  /**
   * The boxes to cover; at least one.
   *
   * @minItems 1
   */
  boxes: [SessionAttachmentCoverBox, ...SessionAttachmentCoverBox[]];
}
/**
 * The covered copy, which is now the staged attachment.
 */
export interface SessionAttachmentCoverResponse {
  /**
   * The covered copy.
   */
  attachment: SessionAttachmentSummary;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate196(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate196.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(Array.isArray(data)){var valid0: any = true;const len0: any = data.length;for(let i0=0; i0<len0; i0++){let data0: any = data[i0];const _errs1: any = errors;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate196.errors = [{instancePath:instancePath+"/" + i0,schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate196.errors = [{instancePath:instancePath+"/" + i0,schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs1 === errors;if(!valid0){break;}}}else {validate196.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "array"}}];return false;}}validate196.errors = vErrors;return errors === 0;}
// prettier-ignore
validate196.errors = null as any[] | null;
// prettier-ignore
validate196.evaluated = {"items":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate1922(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1922.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "attachments") || (key0 === "skills")) || (key0 === "outputSpeedForTurn")) || (key0 === "workspaceId"))){validate1922.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.attachments !== undefined){const _errs2: any = errors;if(!(validate196.call(this, data.attachments, {instancePath:instancePath+"/attachments",parentData:data,parentDataProperty:"attachments",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate196.errors : vErrors.concat(validate196.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.skills !== undefined){let data1: any = data.skills;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs5: any = errors;const _errs6: any = errors;if(errors === _errs6){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing0: any;if(((data2.name === undefined) && (missing0 = "name")) || ((data2.folderPath === undefined) && (missing0 = "folderPath"))){validate1922.errors = [{instancePath:instancePath+"/skills/" + i0,schemaPath:"sidekicks-contracts:run/queue#/$defs/QueuedSkillPick/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs8: any = errors;for(const key1 in data2){if(!((key1 === "name") || (key1 === "folderPath"))){validate1922.errors = [{instancePath:instancePath+"/skills/" + i0,schemaPath:"sidekicks-contracts:run/queue#/$defs/QueuedSkillPick/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs8 === errors){if(data2.name !== undefined){let data3: any = data2.name;const _errs9: any = errors;if(errors === _errs9){if(typeof data3 === "string"){if(func1(data3) > 4096){validate1922.errors = [{instancePath:instancePath+"/skills/" + i0+"/name",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueuedSkillPick/properties/name/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validate1922.errors = [{instancePath:instancePath+"/skills/" + i0+"/name",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueuedSkillPick/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate1922.errors = [{instancePath:instancePath+"/skills/" + i0+"/name",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueuedSkillPick/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1922.errors = [{instancePath:instancePath+"/skills/" + i0+"/name",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueuedSkillPick/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs9 === errors;}else {var valid3: any = true;}if(valid3){if(data2.folderPath !== undefined){let data4: any = data2.folderPath;const _errs11: any = errors;if(errors === _errs11){if(typeof data4 === "string"){if(func1(data4) > 4096){validate1922.errors = [{instancePath:instancePath+"/skills/" + i0+"/folderPath",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueuedSkillPick/properties/folderPath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data4) < 1){validate1922.errors = [{instancePath:instancePath+"/skills/" + i0+"/folderPath",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueuedSkillPick/properties/folderPath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data4)){validate1922.errors = [{instancePath:instancePath+"/skills/" + i0+"/folderPath",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueuedSkillPick/properties/folderPath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1922.errors = [{instancePath:instancePath+"/skills/" + i0+"/folderPath",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueuedSkillPick/properties/folderPath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs11 === errors;}else {var valid3: any = true;}}}}}else {validate1922.errors = [{instancePath:instancePath+"/skills/" + i0,schemaPath:"sidekicks-contracts:run/queue#/$defs/QueuedSkillPick/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validate1922.errors = [{instancePath:instancePath+"/skills",schemaPath:"#/properties/skills/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputSpeedForTurn !== undefined){let data5: any = data.outputSpeedForTurn;const _errs13: any = errors;if(errors === _errs13){if(typeof data5 === "string"){if(func1(data5) > 128){validate1922.errors = [{instancePath:instancePath+"/outputSpeedForTurn",schemaPath:"#/properties/outputSpeedForTurn/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data5) < 1){validate1922.errors = [{instancePath:instancePath+"/outputSpeedForTurn",schemaPath:"#/properties/outputSpeedForTurn/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1922.errors = [{instancePath:instancePath+"/outputSpeedForTurn",schemaPath:"#/properties/outputSpeedForTurn/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1922.errors = [{instancePath:instancePath+"/outputSpeedForTurn",schemaPath:"#/properties/outputSpeedForTurn/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.workspaceId !== undefined){let data6: any = data.workspaceId;const _errs15: any = errors;const _errs16: any = errors;if(errors === _errs16){if(typeof data6 === "string"){if(!pattern4.test(data6)){validate1922.errors = [{instancePath:instancePath+"/workspaceId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1922.errors = [{instancePath:instancePath+"/workspaceId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}}}}}}else {validate1922.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1922.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1922.errors = null as any[] | null;
// prettier-ignore
validate1922.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1921(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1921.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.text === undefined) && (missing0 = "text")) || ((data.extras === undefined) && (missing0 = "extras"))){validate1921.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "text") || (key0 === "extras"))){validate1921.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.text !== undefined){const _errs2: any = errors;if(typeof data.text !== "string"){validate1921.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.extras !== undefined){const _errs4: any = errors;if(!(validate1922.call(this, data.extras, {instancePath:instancePath+"/extras",parentData:data,parentDataProperty:"extras",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1922.errors : vErrors.concat(validate1922.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate1921.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1921.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1921.errors = null as any[] | null;
// prettier-ignore
validate1921.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1920(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is HeldSessionDraft {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1920.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.draft === undefined) && (missing0 = "draft")) || ((data.revision === undefined) && (missing0 = "revision"))){validate1920.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "draft") || (key0 === "revision"))){validate1920.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.draft !== undefined){const _errs2: any = errors;if(!(validate1921.call(this, data.draft, {instancePath:instancePath+"/draft",parentData:data,parentDataProperty:"draft",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1921.errors : vErrors.concat(validate1921.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.revision !== undefined){let data1: any = data.revision;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1920.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1920.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate1920.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validate1920.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1920.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1920.errors = null as any[] | null;
// prettier-ignore
validate1920.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern222 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
function validate1926(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentAddRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1926.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.items === undefined) && (missing0 = "items"))){validate1926.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "items"))){validate1926.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1926.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1926.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.items !== undefined){let data1: any = data.items;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){if(data1.length < 1){validate1926.errors = [{instancePath:instancePath+"/items",schemaPath:"#/properties/items/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let valid4: any = false;const tag0: any = data2.kind;if(typeof tag0 == "string"){if(tag0 === "file"){const _errs12: any = errors;if(errors === _errs12){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if((((data2.kind === undefined) && (missing1 = "kind")) || ((data2.clientStagingId === undefined) && (missing1 = "clientStagingId"))) || ((data2.path === undefined) && (missing1 = "path"))){validate1926.errors = [{instancePath:instancePath+"/items/" + i0,schemaPath:"#/$defs/SessionAttachmentItem/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key1 in data2){if(!(((key1 === "kind") || (key1 === "clientStagingId")) || (key1 === "path"))){validate1926.errors = [{instancePath:instancePath+"/items/" + i0,schemaPath:"#/$defs/SessionAttachmentItem/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs14 === errors){if(data2.kind !== undefined){let data3: any = data2.kind;const _errs15: any = errors;if(typeof data3 !== "string"){validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/kind",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("file" !== data3){validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/kind",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "file"}}];return false;}var valid6: any = _errs15 === errors;}else {var valid6: any = true;}if(valid6){if(data2.clientStagingId !== undefined){let data4: any = data2.clientStagingId;const _errs17: any = errors;if(errors === _errs17){if(typeof data4 === "string"){if(!pattern222.test(data4)){validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/clientStagingId",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/0/properties/clientStagingId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/clientStagingId",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/0/properties/clientStagingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs17 === errors;}else {var valid6: any = true;}if(valid6){if(data2.path !== undefined){let data5: any = data2.path;const _errs19: any = errors;if(errors === _errs19){if(typeof data5 === "string"){if(func1(data5) > 4096){validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/path",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/0/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data5) < 1){validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/path",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/0/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data5)){validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/path",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/0/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/path",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/0/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs19 === errors;}else {var valid6: any = true;}}}}}}else {validate1926.errors = [{instancePath:instancePath+"/items/" + i0,schemaPath:"#/$defs/SessionAttachmentItem/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs12 === errors;var props0: any = true;valid4 = valid5;}else if(tag0 === "mcpResource"){const _errs21: any = errors;if(errors === _errs21){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing2: any;if(((((data2.kind === undefined) && (missing2 = "kind")) || ((data2.clientStagingId === undefined) && (missing2 = "clientStagingId"))) || ((data2.serverName === undefined) && (missing2 = "serverName"))) || ((data2.uri === undefined) && (missing2 = "uri"))){validate1926.errors = [{instancePath:instancePath+"/items/" + i0,schemaPath:"#/$defs/SessionAttachmentItem/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs23: any = errors;for(const key2 in data2){if(!((((key2 === "kind") || (key2 === "clientStagingId")) || (key2 === "serverName")) || (key2 === "uri"))){validate1926.errors = [{instancePath:instancePath+"/items/" + i0,schemaPath:"#/$defs/SessionAttachmentItem/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs23 === errors){if(data2.kind !== undefined){let data6: any = data2.kind;const _errs24: any = errors;if(typeof data6 !== "string"){validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/kind",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("mcpResource" !== data6){validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/kind",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "mcpResource"}}];return false;}var valid8: any = _errs24 === errors;}else {var valid8: any = true;}if(valid8){if(data2.clientStagingId !== undefined){let data7: any = data2.clientStagingId;const _errs26: any = errors;if(errors === _errs26){if(typeof data7 === "string"){if(!pattern222.test(data7)){validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/clientStagingId",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/1/properties/clientStagingId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/clientStagingId",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/1/properties/clientStagingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs26 === errors;}else {var valid8: any = true;}if(valid8){if(data2.serverName !== undefined){let data8: any = data2.serverName;const _errs28: any = errors;if(errors === _errs28){if(typeof data8 === "string"){if(func1(data8) > 128){validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/serverName",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/1/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data8) < 1){validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/serverName",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/1/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data8)){validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/serverName",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/1/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/serverName",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/1/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs28 === errors;}else {var valid8: any = true;}if(valid8){if(data2.uri !== undefined){let data9: any = data2.uri;const _errs30: any = errors;if(errors === _errs30){if(typeof data9 === "string"){if(func1(data9) < 1){validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/uri",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/1/properties/uri/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1926.errors = [{instancePath:instancePath+"/items/" + i0+"/uri",schemaPath:"#/$defs/SessionAttachmentItem/oneOf/1/properties/uri/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs30 === errors;}else {var valid8: any = true;}}}}}}}else {validate1926.errors = [{instancePath:instancePath+"/items/" + i0,schemaPath:"#/$defs/SessionAttachmentItem/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs21 === errors;if(props0 !== true){props0 = true;}valid4 = valid7;}else {validate1926.errors = [{instancePath:instancePath+"/items/" + i0,schemaPath:"#/$defs/SessionAttachmentItem/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1926.errors = [{instancePath:instancePath+"/items/" + i0,schemaPath:"#/$defs/SessionAttachmentItem/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid4){if(props0 !== true){for(const key3 in data2){if(!props0 || !props0[key3]){validate1926.errors = [{instancePath:instancePath+"/items/" + i0,schemaPath:"#/$defs/SessionAttachmentItem/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validate1926.errors = [{instancePath:instancePath+"/items/" + i0,schemaPath:"#/$defs/SessionAttachmentItem/type",keyword:"type",params:{type: "object"}}];return false;}}var valid2: any = _errs8 === errors;if(!valid2){break;}}}}else {validate1926.errors = [{instancePath:instancePath+"/items",schemaPath:"#/properties/items/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1926.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1926.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1926.errors = null as any[] | null;
// prettier-ignore
validate1926.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1928(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1928.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.artifactId === undefined) && (missing0 = "artifactId")) || ((data.fileName === undefined) && (missing0 = "fileName"))) || ((data.mimeType === undefined) && (missing0 = "mimeType"))) || ((data.sizeBytes === undefined) && (missing0 = "sizeBytes"))){validate1928.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "artifactId") || (key0 === "fileName")) || (key0 === "mimeType")) || (key0 === "sizeBytes"))){validate1928.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.artifactId !== undefined){let data0: any = data.artifactId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1928.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1928.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.fileName !== undefined){let data1: any = data.fileName;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1928.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate1928.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1928.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.mimeType !== undefined){let data2: any = data.mimeType;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) < 1){validate1928.errors = [{instancePath:instancePath+"/mimeType",schemaPath:"#/properties/mimeType/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1928.errors = [{instancePath:instancePath+"/mimeType",schemaPath:"#/properties/mimeType/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.sizeBytes !== undefined){let data3: any = data.sizeBytes;const _errs10: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1928.errors = [{instancePath:instancePath+"/sizeBytes",schemaPath:"#/properties/sizeBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1928.errors = [{instancePath:instancePath+"/sizeBytes",schemaPath:"#/properties/sizeBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1928.errors = [{instancePath:instancePath+"/sizeBytes",schemaPath:"#/properties/sizeBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}else {validate1928.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1928.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1928.errors = null as any[] | null;
// prettier-ignore
validate1928.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3826: any = {"anyOf":[{"type":"object","additionalProperties":false,"properties":{"code":{"description":"Always `session.attachment.refused`.","type":"string","const":"session.attachment.refused"},"reason":{"$ref":"#/$defs/SessionAttachmentLimitReason","description":"The rule."}},"required":["code","reason"],"description":"A session rule."},{"type":"object","additionalProperties":false,"properties":{"code":{"description":"Always `session.attachment.refused`.","type":"string","const":"session.attachment.refused"},"reason":{"description":"Always `providerRefused`.","type":"string","enum":["providerRefused"]},"providerMessage":{"type":"string","minLength":1,"description":"The provider's own words, shown as given."}},"required":["code","reason","providerMessage"],"description":"The provider's refusal."},{"type":"object","additionalProperties":false,"properties":{"code":{"description":"Always `session.attachment.refused`.","type":"string","const":"session.attachment.refused"},"reason":{"description":"Always `copyFailed`.","type":"string","enum":["copyFailed"]},"detail":{"type":"string","minLength":1,"description":"The daemon's own cause, the text after `·` on the refusal line."}},"required":["code","reason","detail"],"description":"A failed copy."},{"type":"object","additionalProperties":false,"properties":{"code":{"description":"Always `artifact.tooLarge`.","type":"string","const":"artifact.tooLarge"},"availableBytes":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The room the disk has, in bytes."}},"required":["code","availableBytes"],"description":"A disk too full."},{"type":"object","additionalProperties":false,"properties":{"code":{"description":"Always `artifact.ingest.capacityExhausted`.","type":"string","const":"artifact.ingest.capacityExhausted"}},"required":["code"],"description":"The ingest is busy."}],"description":"Why one item was not staged: a session rule, the provider's refusal with its words, a failed\ncopy with the daemon's cause, a disk too full with the room it has, or the ingest being busy."};
// prettier-ignore
const schema3827: any = {"description":"Why the session would not stage a file, by a rule of its own.","type":"string","enum":["countLimit","folder","providerTakesNoAttachments","cardWaiting"]};
// prettier-ignore
function validate1931(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1931.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.code === undefined) && (missing0 = "code")) || ((data.reason === undefined) && (missing0 = "reason"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((key0 === "code") || (key0 === "reason"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.code !== undefined){let data0: any = data.code;const _errs4: any = errors;if(typeof data0 !== "string"){const err2: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/0/properties/code/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if("session.attachment.refused" !== data0){const err3: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/0/properties/code/const",keyword:"const",params:{allowedValue: "session.attachment.refused"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.reason !== undefined){let data1: any = data.reason;const _errs6: any = errors;if(typeof data1 !== "string"){const err4: any = {instancePath:instancePath+"/reason",schemaPath:"#/$defs/SessionAttachmentLimitReason/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}if(!((((data1 === "countLimit") || (data1 === "folder")) || (data1 === "providerTakesNoAttachments")) || (data1 === "cardWaiting"))){const err5: any = {instancePath:instancePath+"/reason",schemaPath:"#/$defs/SessionAttachmentLimitReason/enum",keyword:"enum",params:{allowedValues: schema3827.enum}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}var valid1: any = _errs6 === errors;}else {var valid1: any = true;}}}}}else {const err6: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.code === undefined) && (missing1 = "code")) || ((data.reason === undefined) && (missing1 = "reason"))) || ((data.providerMessage === undefined) && (missing1 = "providerMessage"))){const err7: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}else {const _errs11: any = errors;for(const key1 in data){if(!(((key1 === "code") || (key1 === "reason")) || (key1 === "providerMessage"))){const err8: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;break;}}if(_errs11 === errors){if(data.code !== undefined){let data2: any = data.code;const _errs12: any = errors;if(typeof data2 !== "string"){const err9: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/1/properties/code/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}if("session.attachment.refused" !== data2){const err10: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/1/properties/code/const",keyword:"const",params:{allowedValue: "session.attachment.refused"}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}var valid3: any = _errs12 === errors;}else {var valid3: any = true;}if(valid3){if(data.reason !== undefined){let data3: any = data.reason;const _errs14: any = errors;if(typeof data3 !== "string"){const err11: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/1/properties/reason/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}if(!(data3 === "providerRefused")){const err12: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/1/properties/reason/enum",keyword:"enum",params:{allowedValues: schema3826.anyOf[1].properties.reason.enum}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}var valid3: any = _errs14 === errors;}else {var valid3: any = true;}if(valid3){if(data.providerMessage !== undefined){let data4: any = data.providerMessage;const _errs16: any = errors;if(errors === _errs16){if(typeof data4 === "string"){if(func1(data4) < 1){const err13: any = {instancePath:instancePath+"/providerMessage",schemaPath:"#/anyOf/1/properties/providerMessage/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}else {const err14: any = {instancePath:instancePath+"/providerMessage",schemaPath:"#/anyOf/1/properties/providerMessage/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}}var valid3: any = _errs16 === errors;}else {var valid3: any = true;}}}}}}else {const err15: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}}var _valid0: any = _errs9 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs18: any = errors;if(errors === _errs18){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.code === undefined) && (missing2 = "code")) || ((data.reason === undefined) && (missing2 = "reason"))) || ((data.detail === undefined) && (missing2 = "detail"))){const err16: any = {instancePath,schemaPath:"#/anyOf/2/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}else {const _errs20: any = errors;for(const key2 in data){if(!(((key2 === "code") || (key2 === "reason")) || (key2 === "detail"))){const err17: any = {instancePath,schemaPath:"#/anyOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;break;}}if(_errs20 === errors){if(data.code !== undefined){let data5: any = data.code;const _errs21: any = errors;if(typeof data5 !== "string"){const err18: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/2/properties/code/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}if("session.attachment.refused" !== data5){const err19: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/2/properties/code/const",keyword:"const",params:{allowedValue: "session.attachment.refused"}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}var valid4: any = _errs21 === errors;}else {var valid4: any = true;}if(valid4){if(data.reason !== undefined){let data6: any = data.reason;const _errs23: any = errors;if(typeof data6 !== "string"){const err20: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/2/properties/reason/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}if(!(data6 === "copyFailed")){const err21: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/2/properties/reason/enum",keyword:"enum",params:{allowedValues: schema3826.anyOf[2].properties.reason.enum}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}var valid4: any = _errs23 === errors;}else {var valid4: any = true;}if(valid4){if(data.detail !== undefined){let data7: any = data.detail;const _errs25: any = errors;if(errors === _errs25){if(typeof data7 === "string"){if(func1(data7) < 1){const err22: any = {instancePath:instancePath+"/detail",schemaPath:"#/anyOf/2/properties/detail/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}}else {const err23: any = {instancePath:instancePath+"/detail",schemaPath:"#/anyOf/2/properties/detail/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}}var valid4: any = _errs25 === errors;}else {var valid4: any = true;}}}}}}else {const err24: any = {instancePath,schemaPath:"#/anyOf/2/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}}var _valid0: any = _errs18 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs27: any = errors;if(errors === _errs27){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((data.code === undefined) && (missing3 = "code")) || ((data.availableBytes === undefined) && (missing3 = "availableBytes"))){const err25: any = {instancePath,schemaPath:"#/anyOf/3/required",keyword:"required",params:{missingProperty: missing3}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}else {const _errs29: any = errors;for(const key3 in data){if(!((key3 === "code") || (key3 === "availableBytes"))){const err26: any = {instancePath,schemaPath:"#/anyOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;break;}}if(_errs29 === errors){if(data.code !== undefined){let data8: any = data.code;const _errs30: any = errors;if(typeof data8 !== "string"){const err27: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/3/properties/code/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}if("artifact.tooLarge" !== data8){const err28: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/3/properties/code/const",keyword:"const",params:{allowedValue: "artifact.tooLarge"}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}var valid5: any = _errs30 === errors;}else {var valid5: any = true;}if(valid5){if(data.availableBytes !== undefined){let data9: any = data.availableBytes;const _errs32: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){const err29: any = {instancePath:instancePath+"/availableBytes",schemaPath:"#/anyOf/3/properties/availableBytes/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}if(errors === _errs32){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){const err30: any = {instancePath:instancePath+"/availableBytes",schemaPath:"#/anyOf/3/properties/availableBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;}else {if(data9 < 0 || isNaN(data9)){const err31: any = {instancePath:instancePath+"/availableBytes",schemaPath:"#/anyOf/3/properties/availableBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;}}}}var valid5: any = _errs32 === errors;}else {var valid5: any = true;}}}}}else {const err32: any = {instancePath,schemaPath:"#/anyOf/3/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;}}var _valid0: any = _errs27 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs34: any = errors;if(errors === _errs34){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((data.code === undefined) && (missing4 = "code")){const err33: any = {instancePath,schemaPath:"#/anyOf/4/required",keyword:"required",params:{missingProperty: missing4}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;}else {const _errs36: any = errors;for(const key4 in data){if(!(key4 === "code")){const err34: any = {instancePath,schemaPath:"#/anyOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}};if(vErrors === null){vErrors = [err34];}else {vErrors.push(err34);}errors++;break;}}if(_errs36 === errors){if(data.code !== undefined){let data10: any = data.code;if(typeof data10 !== "string"){const err35: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/4/properties/code/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err35];}else {vErrors.push(err35);}errors++;}if("artifact.ingest.capacityExhausted" !== data10){const err36: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/4/properties/code/const",keyword:"const",params:{allowedValue: "artifact.ingest.capacityExhausted"}};if(vErrors === null){vErrors = [err36];}else {vErrors.push(err36);}errors++;}}}}}else {const err37: any = {instancePath,schemaPath:"#/anyOf/4/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err37];}else {vErrors.push(err37);}errors++;}}var _valid0: any = _errs34 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err38: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err38];}else {vErrors.push(err38);}errors++;validate1931.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1931.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1931.errors = null as any[] | null;
// prettier-ignore
validate1931.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
function validate1930(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1930.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.clientStagingId === undefined) && (missing0 = "clientStagingId")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.cause === undefined) && (missing0 = "cause"))){validate1930.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "clientStagingId") || (key0 === "name")) || (key0 === "cause"))){validate1930.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.clientStagingId !== undefined){let data0: any = data.clientStagingId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(!pattern222.test(data0)){validate1930.errors = [{instancePath:instancePath+"/clientStagingId",schemaPath:"#/properties/clientStagingId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate1930.errors = [{instancePath:instancePath+"/clientStagingId",schemaPath:"#/properties/clientStagingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validate1930.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1930.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.cause !== undefined){const _errs6: any = errors;if(!(validate1931.call(this, data.cause, {instancePath:instancePath+"/cause",parentData:data,parentDataProperty:"cause",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1931.errors : vErrors.concat(validate1931.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validate1930.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1930.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1930.errors = null as any[] | null;
// prettier-ignore
validate1930.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1927(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentAddResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1927.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.attachments === undefined) && (missing0 = "attachments"))) || ((data.refused === undefined) && (missing0 = "refused"))){validate1927.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "attachments")) || (key0 === "refused"))){validate1927.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1927.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1927.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.attachments !== undefined){let data1: any = data.attachments;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validate1928.call(this, data1[i0], {instancePath:instancePath+"/attachments/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1928.errors : vErrors.concat(validate1928.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;if(!valid2){break;}}}else {validate1927.errors = [{instancePath:instancePath+"/attachments",schemaPath:"#/properties/attachments/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.refused !== undefined){let data3: any = data.refused;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data3)){var valid3: any = true;const len1: any = data3.length;for(let i1=0; i1<len1; i1++){const _errs11: any = errors;if(!(validate1930.call(this, data3[i1], {instancePath:instancePath+"/refused/" + i1,parentData:data3,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1930.errors : vErrors.concat(validate1930.errors);errors = vErrors.length;}var valid3: any = _errs11 === errors;if(!valid3){break;}}}else {validate1927.errors = [{instancePath:instancePath+"/refused",schemaPath:"#/properties/refused/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}else {validate1927.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1927.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1927.errors = null as any[] | null;
// prettier-ignore
validate1927.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1934(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentCoverRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1934.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.attachmentId === undefined) && (missing0 = "attachmentId")) || ((data.boxes === undefined) && (missing0 = "boxes"))){validate1934.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "attachmentId") || (key0 === "boxes"))){validate1934.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.attachmentId !== undefined){let data0: any = data.attachmentId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1934.errors = [{instancePath:instancePath+"/attachmentId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1934.errors = [{instancePath:instancePath+"/attachmentId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.boxes !== undefined){let data1: any = data.boxes;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){if(data1.length < 1){validate1934.errors = [{instancePath:instancePath+"/boxes",schemaPath:"#/properties/boxes/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if(((((data2.x === undefined) && (missing1 = "x")) || ((data2.y === undefined) && (missing1 = "y"))) || ((data2.width === undefined) && (missing1 = "width"))) || ((data2.height === undefined) && (missing1 = "height"))){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0,schemaPath:"#/$defs/SessionAttachmentCoverBox/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key1 in data2){if(!((((key1 === "x") || (key1 === "y")) || (key1 === "width")) || (key1 === "height"))){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0,schemaPath:"#/$defs/SessionAttachmentCoverBox/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs11 === errors){if(data2.x !== undefined){let data3: any = data2.x;const _errs12: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0+"/x",schemaPath:"#/$defs/SessionAttachmentCoverBox/properties/x/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0+"/x",schemaPath:"#/$defs/SessionAttachmentCoverBox/properties/x/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0+"/x",schemaPath:"#/$defs/SessionAttachmentCoverBox/properties/x/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid4: any = _errs12 === errors;}else {var valid4: any = true;}if(valid4){if(data2.y !== undefined){let data4: any = data2.y;const _errs14: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0+"/y",schemaPath:"#/$defs/SessionAttachmentCoverBox/properties/y/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs14){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0+"/y",schemaPath:"#/$defs/SessionAttachmentCoverBox/properties/y/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0+"/y",schemaPath:"#/$defs/SessionAttachmentCoverBox/properties/y/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}if(valid4){if(data2.width !== undefined){let data5: any = data2.width;const _errs16: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0+"/width",schemaPath:"#/$defs/SessionAttachmentCoverBox/properties/width/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs16){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0+"/width",schemaPath:"#/$defs/SessionAttachmentCoverBox/properties/width/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 1 || isNaN(data5)){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0+"/width",schemaPath:"#/$defs/SessionAttachmentCoverBox/properties/width/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}if(valid4){if(data2.height !== undefined){let data6: any = data2.height;const _errs18: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0+"/height",schemaPath:"#/$defs/SessionAttachmentCoverBox/properties/height/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs18){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0+"/height",schemaPath:"#/$defs/SessionAttachmentCoverBox/properties/height/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 1 || isNaN(data6)){validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0+"/height",schemaPath:"#/$defs/SessionAttachmentCoverBox/properties/height/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}}}}}}}else {validate1934.errors = [{instancePath:instancePath+"/boxes/" + i0,schemaPath:"#/$defs/SessionAttachmentCoverBox/type",keyword:"type",params:{type: "object"}}];return false;}}var valid2: any = _errs8 === errors;if(!valid2){break;}}}}else {validate1934.errors = [{instancePath:instancePath+"/boxes",schemaPath:"#/properties/boxes/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1934.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1934.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1934.errors = null as any[] | null;
// prettier-ignore
validate1934.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1935(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentCoverResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1935.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.attachment === undefined) && (missing0 = "attachment")){validate1935.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "attachment")){validate1935.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.attachment !== undefined){if(!(validate1928.call(this, data.attachment, {instancePath:instancePath+"/attachment",parentData:data,parentDataProperty:"attachment",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1928.errors : vErrors.concat(validate1928.errors);errors = vErrors.length;}}}}}else {validate1935.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1935.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1935.errors = null as any[] | null;
// prettier-ignore
validate1935.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1937(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentRemoveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1937.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.artifactId === undefined) && (missing0 = "artifactId"))){validate1937.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "artifactId"))){validate1937.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1937.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1937.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.artifactId !== undefined){let data1: any = data.artifactId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1937.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1937.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1937.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1937.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1937.errors = null as any[] | null;
// prettier-ignore
validate1937.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1938(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentRemoveResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1938.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.attachments === undefined) && (missing0 = "attachments"))){validate1938.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "attachments"))){validate1938.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1938.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1938.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.attachments !== undefined){let data1: any = data.attachments;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validate1928.call(this, data1[i0], {instancePath:instancePath+"/attachments/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1928.errors : vErrors.concat(validate1928.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;if(!valid2){break;}}}else {validate1938.errors = [{instancePath:instancePath+"/attachments",schemaPath:"#/properties/attachments/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1938.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1938.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1938.errors = null as any[] | null;
// prettier-ignore
validate1938.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1940(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionDraftSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1940.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1940.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate1940.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1940.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1940.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1940.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1940.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1940.errors = null as any[] | null;
// prettier-ignore
validate1940.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1941(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionDraftUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1941.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.draft === undefined) && (missing0 = "draft"))) || ((data.expectedRevision === undefined) && (missing0 = "expectedRevision"))){validate1941.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "draft")) || (key0 === "expectedRevision"))){validate1941.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1941.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1941.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.draft !== undefined){const _errs6: any = errors;if(!(validate1921.call(this, data.draft, {instancePath:instancePath+"/draft",parentData:data,parentDataProperty:"draft",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1921.errors : vErrors.concat(validate1921.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.expectedRevision !== undefined){let data2: any = data.expectedRevision;const _errs7: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1941.errors = [{instancePath:instancePath+"/expectedRevision",schemaPath:"#/properties/expectedRevision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1941.errors = [{instancePath:instancePath+"/expectedRevision",schemaPath:"#/properties/expectedRevision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1941.errors = [{instancePath:instancePath+"/expectedRevision",schemaPath:"#/properties/expectedRevision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}else {validate1941.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1941.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1941.errors = null as any[] | null;
// prettier-ignore
validate1941.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate1943(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionDraftUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1943.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.revision === undefined) && (missing0 = "revision"))) || ((data.updatedAt === undefined) && (missing0 = "updatedAt"))){validate1943.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "revision")) || (key0 === "updatedAt"))){validate1943.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1943.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1943.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.revision !== undefined){let data1: any = data.revision;const _errs6: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1943.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1943.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validate1943.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.updatedAt !== undefined){let data2: any = data.updatedAt;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(!pattern5.test(data2)){validate1943.errors = [{instancePath:instancePath+"/updatedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1943.errors = [{instancePath:instancePath+"/updatedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1943.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1943.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1943.errors = null as any[] | null;
// prettier-ignore
validate1943.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link HeldSessionDraft}. */
export const validateHeldSessionDraft: SchemaCheck<HeldSessionDraft> = validate1920;
/** Checks that a value is a {@link SessionAttachmentAddRequest}. */
export const validateSessionAttachmentAddRequest: SchemaCheck<SessionAttachmentAddRequest> =
  validate1926;
/** Checks that a value is a {@link SessionAttachmentAddResponse}. */
export const validateSessionAttachmentAddResponse: SchemaCheck<SessionAttachmentAddResponse> =
  validate1927;
/** Checks that a value is a {@link SessionAttachmentCoverRequest}. */
export const validateSessionAttachmentCoverRequest: SchemaCheck<SessionAttachmentCoverRequest> =
  validate1934;
/** Checks that a value is a {@link SessionAttachmentCoverResponse}. */
export const validateSessionAttachmentCoverResponse: SchemaCheck<SessionAttachmentCoverResponse> =
  validate1935;
/** Checks that a value is a {@link SessionAttachmentRemoveRequest}. */
export const validateSessionAttachmentRemoveRequest: SchemaCheck<SessionAttachmentRemoveRequest> =
  validate1937;
/** Checks that a value is a {@link SessionAttachmentRemoveResponse}. */
export const validateSessionAttachmentRemoveResponse: SchemaCheck<SessionAttachmentRemoveResponse> =
  validate1938;
/** Checks that a value is a {@link SessionDraftSubscribeRequest}. */
export const validateSessionDraftSubscribeRequest: SchemaCheck<SessionDraftSubscribeRequest> =
  validate1940;
/** Checks that a value is a {@link SessionDraftUpdateRequest}. */
export const validateSessionDraftUpdateRequest: SchemaCheck<SessionDraftUpdateRequest> =
  validate1941;
/** Checks that a value is a {@link SessionDraftUpdateResponse}. */
export const validateSessionDraftUpdateResponse: SchemaCheck<SessionDraftUpdateResponse> =
  validate1943;

/** The methods of {@link SESSION_DRAFT_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionDraftMethodDescriptors {
  readonly "session.draft.update": {
    readonly method: "session.draft.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionDraftUpdateRequest>;
    readonly responseCheck: SchemaCheck<SessionDraftUpdateResponse>;
  };
  readonly "session.draft.subscribe": {
    readonly method: "session.draft.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionDraftSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<HeldSessionDraft>;
  };
  readonly "session.attachment.add": {
    readonly method: "session.attachment.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionAttachmentAddRequest>;
    readonly responseCheck: SchemaCheck<SessionAttachmentAddResponse>;
  };
  readonly "session.attachment.remove": {
    readonly method: "session.attachment.remove";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionAttachmentRemoveRequest>;
    readonly responseCheck: SchemaCheck<SessionAttachmentRemoveResponse>;
  };
  readonly "session.attachment.cover": {
    readonly method: "session.attachment.cover";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionAttachmentCoverRequest>;
    readonly responseCheck: SchemaCheck<SessionAttachmentCoverResponse>;
  };
}
/** The composer store's methods, each with its types. */
export const SESSION_DRAFT_METHOD_DESCRIPTORS: SessionDraftMethodDescriptors = Object.freeze({
  "session.draft.update": Object.freeze({
    method: "session.draft.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionDraftUpdateRequest,
    responseCheck: validateSessionDraftUpdateResponse,
  }),
  "session.draft.subscribe": Object.freeze({
    method: "session.draft.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateSessionDraftSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateHeldSessionDraft,
  }),
  "session.attachment.add": Object.freeze({
    method: "session.attachment.add",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionAttachmentAddRequest,
    responseCheck: validateSessionAttachmentAddResponse,
  }),
  "session.attachment.remove": Object.freeze({
    method: "session.attachment.remove",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionAttachmentRemoveRequest,
    responseCheck: validateSessionAttachmentRemoveResponse,
  }),
  "session.attachment.cover": Object.freeze({
    method: "session.attachment.cover",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionAttachmentCoverRequest,
    responseCheck: validateSessionAttachmentCoverResponse,
  }),
});
