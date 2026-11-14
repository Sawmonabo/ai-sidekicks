// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The composer's daemon-held store for one session: the unsent draft with what rides with its words, the staged files, covering part of a staged picture, and the refusals staging can answer with.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../../schema-check.js";
import {
  type AttachmentReferenceList,
  validateAttachmentReferenceList,
} from "../artifacts/attachment-reference.js";
import { type ArtifactId, validateArtifactId } from "../artifacts/id.js";
import { type WireInstant, validateWireInstant } from "../internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type WorkspaceId, validateWorkspaceId } from "../repo/mount.js";
import { type QueuedSkillPick, validateQueuedSkillPick } from "../run/queue.js";
import { type SessionId, validateSessionId } from "./id.js";

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
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link SessionDraftExtras}. */
// prettier-ignore
export const validateSessionDraftExtras: CompiledSchemaCheck<SessionDraftExtras> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionDraftExtras {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionDraftExtras.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "attachments") || (key0 === "skills")) || (key0 === "outputSpeedForTurn")) || (key0 === "workspaceId"))){validateSessionDraftExtras.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.attachments !== undefined){const _errs2: any = errors;if(!(validateAttachmentReferenceList.call(this, data.attachments, {instancePath:instancePath+"/attachments",parentData:data,parentDataProperty:"attachments",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttachmentReferenceList.errors : vErrors.concat(validateAttachmentReferenceList.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.skills !== undefined){let data1: any = data.skills;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateQueuedSkillPick.call(this, data1[i0], {instancePath:instancePath+"/skills/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueuedSkillPick.errors : vErrors.concat(validateQueuedSkillPick.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateSessionDraftExtras.errors = [{instancePath:instancePath+"/skills",schemaPath:"#/properties/skills/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputSpeedForTurn !== undefined){let data3: any = data.outputSpeedForTurn;const _errs6: any = errors;if(errors === _errs6){if(typeof data3 === "string"){if(func1(data3) > 128){validateSessionDraftExtras.errors = [{instancePath:instancePath+"/outputSpeedForTurn",schemaPath:"#/properties/outputSpeedForTurn/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data3) < 1){validateSessionDraftExtras.errors = [{instancePath:instancePath+"/outputSpeedForTurn",schemaPath:"#/properties/outputSpeedForTurn/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateSessionDraftExtras.errors = [{instancePath:instancePath+"/outputSpeedForTurn",schemaPath:"#/properties/outputSpeedForTurn/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionDraftExtras.errors = [{instancePath:instancePath+"/outputSpeedForTurn",schemaPath:"#/properties/outputSpeedForTurn/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.workspaceId !== undefined){const _errs8: any = errors;if(!(validateWorkspaceId.call(this, data.workspaceId, {instancePath:instancePath+"/workspaceId",parentData:data,parentDataProperty:"workspaceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkspaceId.errors : vErrors.concat(validateWorkspaceId.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionDraftExtras.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionDraftExtras.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionDraftExtras.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionDraft}. */
// prettier-ignore
export const validateSessionDraft: CompiledSchemaCheck<SessionDraft> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionDraft {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionDraft.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.text === undefined) && (missing0 = "text")) || ((data.extras === undefined) && (missing0 = "extras"))){validateSessionDraft.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "text") || (key0 === "extras"))){validateSessionDraft.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.text !== undefined){const _errs2: any = errors;if(typeof data.text !== "string"){validateSessionDraft.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.extras !== undefined){const _errs4: any = errors;if(!(validateSessionDraftExtras.call(this, data.extras, {instancePath:instancePath+"/extras",parentData:data,parentDataProperty:"extras",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionDraftExtras.errors : vErrors.concat(validateSessionDraftExtras.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateSessionDraft.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionDraft.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionDraft.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionDraftUpdateRequest}. */
// prettier-ignore
export const validateSessionDraftUpdateRequest: CompiledSchemaCheck<SessionDraftUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionDraftUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionDraftUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.draft === undefined) && (missing0 = "draft"))) || ((data.expectedRevision === undefined) && (missing0 = "expectedRevision"))){validateSessionDraftUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "draft")) || (key0 === "expectedRevision"))){validateSessionDraftUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.draft !== undefined){const _errs3: any = errors;if(!(validateSessionDraft.call(this, data.draft, {instancePath:instancePath+"/draft",parentData:data,parentDataProperty:"draft",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionDraft.errors : vErrors.concat(validateSessionDraft.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.expectedRevision !== undefined){let data2: any = data.expectedRevision;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateSessionDraftUpdateRequest.errors = [{instancePath:instancePath+"/expectedRevision",schemaPath:"#/properties/expectedRevision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateSessionDraftUpdateRequest.errors = [{instancePath:instancePath+"/expectedRevision",schemaPath:"#/properties/expectedRevision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateSessionDraftUpdateRequest.errors = [{instancePath:instancePath+"/expectedRevision",schemaPath:"#/properties/expectedRevision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionDraftUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionDraftUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionDraftUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionDraftUpdateResponse}. */
// prettier-ignore
export const validateSessionDraftUpdateResponse: CompiledSchemaCheck<SessionDraftUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionDraftUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionDraftUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.revision === undefined) && (missing0 = "revision"))) || ((data.updatedAt === undefined) && (missing0 = "updatedAt"))){validateSessionDraftUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "revision")) || (key0 === "updatedAt"))){validateSessionDraftUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.revision !== undefined){let data1: any = data.revision;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateSessionDraftUpdateResponse.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateSessionDraftUpdateResponse.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateSessionDraftUpdateResponse.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.updatedAt !== undefined){const _errs5: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionDraftUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionDraftUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionDraftUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionDraftSubscribeRequest}. */
// prettier-ignore
export const validateSessionDraftSubscribeRequest: CompiledSchemaCheck<SessionDraftSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionDraftSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionDraftSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateSessionDraftSubscribeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateSessionDraftSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateSessionDraftSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionDraftSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionDraftSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link HeldSessionDraft}. */
// prettier-ignore
export const validateHeldSessionDraft: CompiledSchemaCheck<HeldSessionDraft> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is HeldSessionDraft {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateHeldSessionDraft.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.draft === undefined) && (missing0 = "draft")) || ((data.revision === undefined) && (missing0 = "revision"))){validateHeldSessionDraft.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "draft") || (key0 === "revision"))){validateHeldSessionDraft.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.draft !== undefined){const _errs2: any = errors;if(!(validateSessionDraft.call(this, data.draft, {instancePath:instancePath+"/draft",parentData:data,parentDataProperty:"draft",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionDraft.errors : vErrors.concat(validateSessionDraft.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.revision !== undefined){let data1: any = data.revision;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateHeldSessionDraft.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateHeldSessionDraft.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateHeldSessionDraft.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateHeldSessionDraft.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateHeldSessionDraft.errors = vErrors;return errors === 0;};
// prettier-ignore
validateHeldSessionDraft.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionAttachmentSummary}. */
// prettier-ignore
export const validateSessionAttachmentSummary: CompiledSchemaCheck<SessionAttachmentSummary> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentSummary {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAttachmentSummary.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.artifactId === undefined) && (missing0 = "artifactId")) || ((data.fileName === undefined) && (missing0 = "fileName"))) || ((data.mimeType === undefined) && (missing0 = "mimeType"))) || ((data.sizeBytes === undefined) && (missing0 = "sizeBytes"))){validateSessionAttachmentSummary.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "artifactId") || (key0 === "fileName")) || (key0 === "mimeType")) || (key0 === "sizeBytes"))){validateSessionAttachmentSummary.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.artifactId !== undefined){const _errs2: any = errors;if(!(validateArtifactId.call(this, data.artifactId, {instancePath:instancePath+"/artifactId",parentData:data,parentDataProperty:"artifactId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.fileName !== undefined){let data1: any = data.fileName;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 4096){validateSessionAttachmentSummary.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validateSessionAttachmentSummary.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateSessionAttachmentSummary.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.mimeType !== undefined){let data2: any = data.mimeType;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) < 1){validateSessionAttachmentSummary.errors = [{instancePath:instancePath+"/mimeType",schemaPath:"#/properties/mimeType/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionAttachmentSummary.errors = [{instancePath:instancePath+"/mimeType",schemaPath:"#/properties/mimeType/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.sizeBytes !== undefined){let data3: any = data.sizeBytes;const _errs7: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateSessionAttachmentSummary.errors = [{instancePath:instancePath+"/sizeBytes",schemaPath:"#/properties/sizeBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateSessionAttachmentSummary.errors = [{instancePath:instancePath+"/sizeBytes",schemaPath:"#/properties/sizeBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateSessionAttachmentSummary.errors = [{instancePath:instancePath+"/sizeBytes",schemaPath:"#/properties/sizeBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}else {validateSessionAttachmentSummary.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAttachmentSummary.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAttachmentSummary.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern88 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
/** Checks that a value is a {@link SessionAttachmentItem}. */
// prettier-ignore
export const validateSessionAttachmentItem: CompiledSchemaCheck<SessionAttachmentItem> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentItem {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAttachmentItem.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "file"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.kind === undefined) && (missing0 = "kind")) || ((data.clientStagingId === undefined) && (missing0 = "clientStagingId"))) || ((data.path === undefined) && (missing0 = "path"))){validateSessionAttachmentItem.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((key0 === "kind") || (key0 === "clientStagingId")) || (key0 === "path"))){validateSessionAttachmentItem.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("file" !== data0){validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "file"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.clientStagingId !== undefined){let data1: any = data.clientStagingId;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern88.test(data1)){validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/clientStagingId",schemaPath:"#/oneOf/0/properties/clientStagingId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/clientStagingId",schemaPath:"#/oneOf/0/properties/clientStagingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.path !== undefined){let data2: any = data.path;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(func1(data2) > 4096){validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data2)){validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}}}}}}else {validateSessionAttachmentItem.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "mcpResource"){const _errs11: any = errors;if(errors === _errs11){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.kind === undefined) && (missing1 = "kind")) || ((data.clientStagingId === undefined) && (missing1 = "clientStagingId"))) || ((data.serverName === undefined) && (missing1 = "serverName"))) || ((data.uri === undefined) && (missing1 = "uri"))){validateSessionAttachmentItem.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs13: any = errors;for(const key1 in data){if(!((((key1 === "kind") || (key1 === "clientStagingId")) || (key1 === "serverName")) || (key1 === "uri"))){validateSessionAttachmentItem.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs13 === errors){if(data.kind !== undefined){let data3: any = data.kind;const _errs14: any = errors;if(typeof data3 !== "string"){validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("mcpResource" !== data3){validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "mcpResource"}}];return false;}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}if(valid4){if(data.clientStagingId !== undefined){let data4: any = data.clientStagingId;const _errs16: any = errors;if(errors === _errs16){if(typeof data4 === "string"){if(!pattern88.test(data4)){validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/clientStagingId",schemaPath:"#/oneOf/1/properties/clientStagingId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/clientStagingId",schemaPath:"#/oneOf/1/properties/clientStagingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}if(valid4){if(data.serverName !== undefined){let data5: any = data.serverName;const _errs18: any = errors;if(errors === _errs18){if(typeof data5 === "string"){if(func1(data5) > 128){validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/1/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data5) < 1){validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/1/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/1/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/1/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data.uri !== undefined){let data6: any = data.uri;const _errs20: any = errors;if(errors === _errs20){if(typeof data6 === "string"){if(func1(data6) < 1){validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/uri",schemaPath:"#/oneOf/1/properties/uri/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionAttachmentItem.errors = [{instancePath:instancePath+"/uri",schemaPath:"#/oneOf/1/properties/uri/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs20 === errors;}else {var valid4: any = true;}}}}}}}else {validateSessionAttachmentItem.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs11 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateSessionAttachmentItem.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateSessionAttachmentItem.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateSessionAttachmentItem.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateSessionAttachmentItem.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAttachmentItem.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAttachmentItem.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionAttachmentAddRequest}. */
// prettier-ignore
export const validateSessionAttachmentAddRequest: CompiledSchemaCheck<SessionAttachmentAddRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentAddRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAttachmentAddRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.items === undefined) && (missing0 = "items"))){validateSessionAttachmentAddRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "items"))){validateSessionAttachmentAddRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.items !== undefined){let data1: any = data.items;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){if(data1.length < 1){validateSessionAttachmentAddRequest.errors = [{instancePath:instancePath+"/items",schemaPath:"#/properties/items/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateSessionAttachmentItem.call(this, data1[i0], {instancePath:instancePath+"/items/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionAttachmentItem.errors : vErrors.concat(validateSessionAttachmentItem.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}}else {validateSessionAttachmentAddRequest.errors = [{instancePath:instancePath+"/items",schemaPath:"#/properties/items/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionAttachmentAddRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAttachmentAddRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAttachmentAddRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1205: any = {"description":"Why the session would not stage a file, by a rule of its own.","type":"string","enum":["countLimit","folder","providerTakesNoAttachments","cardWaiting"]};
/** Checks that a value is a {@link SessionAttachmentLimitReason}. */
// prettier-ignore
export const validateSessionAttachmentLimitReason: CompiledSchemaCheck<SessionAttachmentLimitReason> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentLimitReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAttachmentLimitReason.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateSessionAttachmentLimitReason.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "countLimit") || (data === "folder")) || (data === "providerTakesNoAttachments")) || (data === "cardWaiting"))){validateSessionAttachmentLimitReason.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1205.enum}}];return false;}validateSessionAttachmentLimitReason.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAttachmentLimitReason.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1204: any = {"anyOf":[{"type":"object","additionalProperties":false,"properties":{"code":{"description":"Always `session.attachment.refused`.","type":"string","const":"session.attachment.refused"},"reason":{"$ref":"#/$defs/SessionAttachmentLimitReason","description":"The rule."}},"required":["code","reason"],"description":"A session rule."},{"type":"object","additionalProperties":false,"properties":{"code":{"description":"Always `session.attachment.refused`.","type":"string","const":"session.attachment.refused"},"reason":{"description":"Always `providerRefused`.","type":"string","enum":["providerRefused"]},"providerMessage":{"type":"string","minLength":1,"description":"The provider's own words, shown as given."}},"required":["code","reason","providerMessage"],"description":"The provider's refusal."},{"type":"object","additionalProperties":false,"properties":{"code":{"description":"Always `session.attachment.refused`.","type":"string","const":"session.attachment.refused"},"reason":{"description":"Always `copyFailed`.","type":"string","enum":["copyFailed"]},"detail":{"type":"string","minLength":1,"description":"The daemon's own cause, the text after `·` on the refusal line."}},"required":["code","reason","detail"],"description":"A failed copy."},{"type":"object","additionalProperties":false,"properties":{"code":{"description":"Always `artifact.tooLarge`.","type":"string","const":"artifact.tooLarge"},"availableBytes":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The room the disk has, in bytes."}},"required":["code","availableBytes"],"description":"A disk too full."},{"type":"object","additionalProperties":false,"properties":{"code":{"description":"Always `artifact.ingest.capacityExhausted`.","type":"string","const":"artifact.ingest.capacityExhausted"}},"required":["code"],"description":"The ingest is busy."}],"description":"Why one item was not staged: a session rule, the provider's refusal with its words, a failed\ncopy with the daemon's cause, a disk too full with the room it has, or the ingest being busy."};
/** Checks that a value is a {@link SessionAttachmentRefusalCause}. */
// prettier-ignore
export const validateSessionAttachmentRefusalCause: CompiledSchemaCheck<SessionAttachmentRefusalCause> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentRefusalCause {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAttachmentRefusalCause.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.code === undefined) && (missing0 = "code")) || ((data.reason === undefined) && (missing0 = "reason"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((key0 === "code") || (key0 === "reason"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.code !== undefined){let data0: any = data.code;const _errs4: any = errors;if(typeof data0 !== "string"){const err2: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/0/properties/code/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if("session.attachment.refused" !== data0){const err3: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/0/properties/code/const",keyword:"const",params:{allowedValue: "session.attachment.refused"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.reason !== undefined){const _errs6: any = errors;if(!(validateSessionAttachmentLimitReason.call(this, data.reason, {instancePath:instancePath+"/reason",parentData:data,parentDataProperty:"reason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionAttachmentLimitReason.errors : vErrors.concat(validateSessionAttachmentLimitReason.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;}else {var valid1: any = true;}}}}}else {const err4: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.code === undefined) && (missing1 = "code")) || ((data.reason === undefined) && (missing1 = "reason"))) || ((data.providerMessage === undefined) && (missing1 = "providerMessage"))){const err5: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}else {const _errs9: any = errors;for(const key1 in data){if(!(((key1 === "code") || (key1 === "reason")) || (key1 === "providerMessage"))){const err6: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;break;}}if(_errs9 === errors){if(data.code !== undefined){let data2: any = data.code;const _errs10: any = errors;if(typeof data2 !== "string"){const err7: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/1/properties/code/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}if("session.attachment.refused" !== data2){const err8: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/1/properties/code/const",keyword:"const",params:{allowedValue: "session.attachment.refused"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.reason !== undefined){let data3: any = data.reason;const _errs12: any = errors;if(typeof data3 !== "string"){const err9: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/1/properties/reason/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}if(!(data3 === "providerRefused")){const err10: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/1/properties/reason/enum",keyword:"enum",params:{allowedValues: schema1204.anyOf[1].properties.reason.enum}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.providerMessage !== undefined){let data4: any = data.providerMessage;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(func1(data4) < 1){const err11: any = {instancePath:instancePath+"/providerMessage",schemaPath:"#/anyOf/1/properties/providerMessage/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}else {const err12: any = {instancePath:instancePath+"/providerMessage",schemaPath:"#/anyOf/1/properties/providerMessage/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}}}}}}else {const err13: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}var _valid0: any = _errs7 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs16: any = errors;if(errors === _errs16){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.code === undefined) && (missing2 = "code")) || ((data.reason === undefined) && (missing2 = "reason"))) || ((data.detail === undefined) && (missing2 = "detail"))){const err14: any = {instancePath,schemaPath:"#/anyOf/2/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}else {const _errs18: any = errors;for(const key2 in data){if(!(((key2 === "code") || (key2 === "reason")) || (key2 === "detail"))){const err15: any = {instancePath,schemaPath:"#/anyOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;break;}}if(_errs18 === errors){if(data.code !== undefined){let data5: any = data.code;const _errs19: any = errors;if(typeof data5 !== "string"){const err16: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/2/properties/code/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}if("session.attachment.refused" !== data5){const err17: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/2/properties/code/const",keyword:"const",params:{allowedValue: "session.attachment.refused"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}var valid3: any = _errs19 === errors;}else {var valid3: any = true;}if(valid3){if(data.reason !== undefined){let data6: any = data.reason;const _errs21: any = errors;if(typeof data6 !== "string"){const err18: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/2/properties/reason/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}if(!(data6 === "copyFailed")){const err19: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/2/properties/reason/enum",keyword:"enum",params:{allowedValues: schema1204.anyOf[2].properties.reason.enum}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}var valid3: any = _errs21 === errors;}else {var valid3: any = true;}if(valid3){if(data.detail !== undefined){let data7: any = data.detail;const _errs23: any = errors;if(errors === _errs23){if(typeof data7 === "string"){if(func1(data7) < 1){const err20: any = {instancePath:instancePath+"/detail",schemaPath:"#/anyOf/2/properties/detail/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}}else {const err21: any = {instancePath:instancePath+"/detail",schemaPath:"#/anyOf/2/properties/detail/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}}var valid3: any = _errs23 === errors;}else {var valid3: any = true;}}}}}}else {const err22: any = {instancePath,schemaPath:"#/anyOf/2/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}}var _valid0: any = _errs16 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs25: any = errors;if(errors === _errs25){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((data.code === undefined) && (missing3 = "code")) || ((data.availableBytes === undefined) && (missing3 = "availableBytes"))){const err23: any = {instancePath,schemaPath:"#/anyOf/3/required",keyword:"required",params:{missingProperty: missing3}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}else {const _errs27: any = errors;for(const key3 in data){if(!((key3 === "code") || (key3 === "availableBytes"))){const err24: any = {instancePath,schemaPath:"#/anyOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;break;}}if(_errs27 === errors){if(data.code !== undefined){let data8: any = data.code;const _errs28: any = errors;if(typeof data8 !== "string"){const err25: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/3/properties/code/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}if("artifact.tooLarge" !== data8){const err26: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/3/properties/code/const",keyword:"const",params:{allowedValue: "artifact.tooLarge"}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}var valid4: any = _errs28 === errors;}else {var valid4: any = true;}if(valid4){if(data.availableBytes !== undefined){let data9: any = data.availableBytes;const _errs30: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){const err27: any = {instancePath:instancePath+"/availableBytes",schemaPath:"#/anyOf/3/properties/availableBytes/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}if(errors === _errs30){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){const err28: any = {instancePath:instancePath+"/availableBytes",schemaPath:"#/anyOf/3/properties/availableBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}else {if(data9 < 0 || isNaN(data9)){const err29: any = {instancePath:instancePath+"/availableBytes",schemaPath:"#/anyOf/3/properties/availableBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}}}}var valid4: any = _errs30 === errors;}else {var valid4: any = true;}}}}}else {const err30: any = {instancePath,schemaPath:"#/anyOf/3/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;}}var _valid0: any = _errs25 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs32: any = errors;if(errors === _errs32){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((data.code === undefined) && (missing4 = "code")){const err31: any = {instancePath,schemaPath:"#/anyOf/4/required",keyword:"required",params:{missingProperty: missing4}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;}else {const _errs34: any = errors;for(const key4 in data){if(!(key4 === "code")){const err32: any = {instancePath,schemaPath:"#/anyOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;break;}}if(_errs34 === errors){if(data.code !== undefined){let data10: any = data.code;if(typeof data10 !== "string"){const err33: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/4/properties/code/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;}if("artifact.ingest.capacityExhausted" !== data10){const err34: any = {instancePath:instancePath+"/code",schemaPath:"#/anyOf/4/properties/code/const",keyword:"const",params:{allowedValue: "artifact.ingest.capacityExhausted"}};if(vErrors === null){vErrors = [err34];}else {vErrors.push(err34);}errors++;}}}}}else {const err35: any = {instancePath,schemaPath:"#/anyOf/4/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err35];}else {vErrors.push(err35);}errors++;}}var _valid0: any = _errs32 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err36: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err36];}else {vErrors.push(err36);}errors++;validateSessionAttachmentRefusalCause.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateSessionAttachmentRefusalCause.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateSessionAttachmentRefusalCause.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionAttachmentRefusal}. */
// prettier-ignore
export const validateSessionAttachmentRefusal: CompiledSchemaCheck<SessionAttachmentRefusal> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentRefusal {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAttachmentRefusal.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.clientStagingId === undefined) && (missing0 = "clientStagingId")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.cause === undefined) && (missing0 = "cause"))){validateSessionAttachmentRefusal.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "clientStagingId") || (key0 === "name")) || (key0 === "cause"))){validateSessionAttachmentRefusal.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.clientStagingId !== undefined){let data0: any = data.clientStagingId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(!pattern88.test(data0)){validateSessionAttachmentRefusal.errors = [{instancePath:instancePath+"/clientStagingId",schemaPath:"#/properties/clientStagingId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateSessionAttachmentRefusal.errors = [{instancePath:instancePath+"/clientStagingId",schemaPath:"#/properties/clientStagingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validateSessionAttachmentRefusal.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionAttachmentRefusal.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.cause !== undefined){const _errs6: any = errors;if(!(validateSessionAttachmentRefusalCause.call(this, data.cause, {instancePath:instancePath+"/cause",parentData:data,parentDataProperty:"cause",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionAttachmentRefusalCause.errors : vErrors.concat(validateSessionAttachmentRefusalCause.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionAttachmentRefusal.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAttachmentRefusal.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAttachmentRefusal.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionAttachmentAddResponse}. */
// prettier-ignore
export const validateSessionAttachmentAddResponse: CompiledSchemaCheck<SessionAttachmentAddResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentAddResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAttachmentAddResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.attachments === undefined) && (missing0 = "attachments"))) || ((data.refused === undefined) && (missing0 = "refused"))){validateSessionAttachmentAddResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "attachments")) || (key0 === "refused"))){validateSessionAttachmentAddResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.attachments !== undefined){let data1: any = data.attachments;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateSessionAttachmentSummary.call(this, data1[i0], {instancePath:instancePath+"/attachments/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionAttachmentSummary.errors : vErrors.concat(validateSessionAttachmentSummary.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateSessionAttachmentAddResponse.errors = [{instancePath:instancePath+"/attachments",schemaPath:"#/properties/attachments/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.refused !== undefined){let data3: any = data.refused;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data3)){var valid2: any = true;const len1: any = data3.length;for(let i1=0; i1<len1; i1++){const _errs8: any = errors;if(!(validateSessionAttachmentRefusal.call(this, data3[i1], {instancePath:instancePath+"/refused/" + i1,parentData:data3,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionAttachmentRefusal.errors : vErrors.concat(validateSessionAttachmentRefusal.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;if(!valid2){break;}}}else {validateSessionAttachmentAddResponse.errors = [{instancePath:instancePath+"/refused",schemaPath:"#/properties/refused/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionAttachmentAddResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAttachmentAddResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAttachmentAddResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionAttachmentRemoveRequest}. */
// prettier-ignore
export const validateSessionAttachmentRemoveRequest: CompiledSchemaCheck<SessionAttachmentRemoveRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentRemoveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAttachmentRemoveRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.artifactId === undefined) && (missing0 = "artifactId"))){validateSessionAttachmentRemoveRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "artifactId"))){validateSessionAttachmentRemoveRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.artifactId !== undefined){const _errs3: any = errors;if(!(validateArtifactId.call(this, data.artifactId, {instancePath:instancePath+"/artifactId",parentData:data,parentDataProperty:"artifactId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionAttachmentRemoveRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAttachmentRemoveRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAttachmentRemoveRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionAttachmentRemoveResponse}. */
// prettier-ignore
export const validateSessionAttachmentRemoveResponse: CompiledSchemaCheck<SessionAttachmentRemoveResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentRemoveResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAttachmentRemoveResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.attachments === undefined) && (missing0 = "attachments"))){validateSessionAttachmentRemoveResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "attachments"))){validateSessionAttachmentRemoveResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.attachments !== undefined){let data1: any = data.attachments;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateSessionAttachmentSummary.call(this, data1[i0], {instancePath:instancePath+"/attachments/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionAttachmentSummary.errors : vErrors.concat(validateSessionAttachmentSummary.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateSessionAttachmentRemoveResponse.errors = [{instancePath:instancePath+"/attachments",schemaPath:"#/properties/attachments/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionAttachmentRemoveResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAttachmentRemoveResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAttachmentRemoveResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionAttachmentCoverBox}. */
// prettier-ignore
export const validateSessionAttachmentCoverBox: CompiledSchemaCheck<SessionAttachmentCoverBox> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentCoverBox {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAttachmentCoverBox.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.x === undefined) && (missing0 = "x")) || ((data.y === undefined) && (missing0 = "y"))) || ((data.width === undefined) && (missing0 = "width"))) || ((data.height === undefined) && (missing0 = "height"))){validateSessionAttachmentCoverBox.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "x") || (key0 === "y")) || (key0 === "width")) || (key0 === "height"))){validateSessionAttachmentCoverBox.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.x !== undefined){let data0: any = data.x;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateSessionAttachmentCoverBox.errors = [{instancePath:instancePath+"/x",schemaPath:"#/properties/x/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateSessionAttachmentCoverBox.errors = [{instancePath:instancePath+"/x",schemaPath:"#/properties/x/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validateSessionAttachmentCoverBox.errors = [{instancePath:instancePath+"/x",schemaPath:"#/properties/x/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.y !== undefined){let data1: any = data.y;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateSessionAttachmentCoverBox.errors = [{instancePath:instancePath+"/y",schemaPath:"#/properties/y/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateSessionAttachmentCoverBox.errors = [{instancePath:instancePath+"/y",schemaPath:"#/properties/y/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateSessionAttachmentCoverBox.errors = [{instancePath:instancePath+"/y",schemaPath:"#/properties/y/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.width !== undefined){let data2: any = data.width;const _errs6: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateSessionAttachmentCoverBox.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateSessionAttachmentCoverBox.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateSessionAttachmentCoverBox.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.height !== undefined){let data3: any = data.height;const _errs8: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateSessionAttachmentCoverBox.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateSessionAttachmentCoverBox.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validateSessionAttachmentCoverBox.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}else {validateSessionAttachmentCoverBox.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAttachmentCoverBox.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAttachmentCoverBox.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionAttachmentCoverRequest}. */
// prettier-ignore
export const validateSessionAttachmentCoverRequest: CompiledSchemaCheck<SessionAttachmentCoverRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentCoverRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAttachmentCoverRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.attachmentId === undefined) && (missing0 = "attachmentId")) || ((data.boxes === undefined) && (missing0 = "boxes"))){validateSessionAttachmentCoverRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "attachmentId") || (key0 === "boxes"))){validateSessionAttachmentCoverRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.attachmentId !== undefined){const _errs2: any = errors;if(!(validateArtifactId.call(this, data.attachmentId, {instancePath:instancePath+"/attachmentId",parentData:data,parentDataProperty:"attachmentId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.boxes !== undefined){let data1: any = data.boxes;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){if(data1.length < 1){validateSessionAttachmentCoverRequest.errors = [{instancePath:instancePath+"/boxes",schemaPath:"#/properties/boxes/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateSessionAttachmentCoverBox.call(this, data1[i0], {instancePath:instancePath+"/boxes/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionAttachmentCoverBox.errors : vErrors.concat(validateSessionAttachmentCoverBox.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}}else {validateSessionAttachmentCoverRequest.errors = [{instancePath:instancePath+"/boxes",schemaPath:"#/properties/boxes/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionAttachmentCoverRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAttachmentCoverRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAttachmentCoverRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionAttachmentCoverResponse}. */
// prettier-ignore
export const validateSessionAttachmentCoverResponse: CompiledSchemaCheck<SessionAttachmentCoverResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAttachmentCoverResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAttachmentCoverResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.attachment === undefined) && (missing0 = "attachment")){validateSessionAttachmentCoverResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "attachment")){validateSessionAttachmentCoverResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.attachment !== undefined){if(!(validateSessionAttachmentSummary.call(this, data.attachment, {instancePath:instancePath+"/attachment",parentData:data,parentDataProperty:"attachment",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionAttachmentSummary.errors : vErrors.concat(validateSessionAttachmentSummary.errors);errors = vErrors.length;}}}}}else {validateSessionAttachmentCoverResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAttachmentCoverResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAttachmentCoverResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

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
