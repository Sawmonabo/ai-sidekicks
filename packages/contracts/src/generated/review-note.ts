// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A held review note: a note the person leaves on a line of Review's diff, held by the daemon and scoped to the session.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../schema-check.js";
import { type WireInstant, validateWireInstant } from "./internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import { type GitObjectId, validateGitObjectId } from "./repo/git-reads.js";
import { type SessionId, validateSessionId } from "./session/id.js";

/**
 * The id of one held note, minted by the client, so adding the same note twice makes one note.
 */
export type ReviewNoteId = string & { readonly __brand: "ReviewNoteId" };
/**
 * The scopes a note can be left in: the uncommitted changes, the branch, or a pull request.
 */
export type ReviewNoteScope = "changes" | "branch" | "changeRequest";
/**
 * Which side of the diff the note's line is on.
 */
export type ReviewNoteSide = "added" | "removed";
/**
 * The comparison a note was left in, so pressing the note takes the reader back to it.
 */
export type ReviewNoteComparison =
  | {
      /**
       * The scope.
       */
      scope: ReviewNoteScope;
      /**
       * The comparison's base.
       */
      base: string;
      /**
       * The head commit.
       */
      headCommitId: GitObjectId;
      /**
       * The pull request, in that scope.
       */
      requestNumber?: number;
    }
  | {
      /**
       * The scope.
       */
      scope: ReviewNoteScope;
      /**
       * The comparison's base.
       */
      base: string;
      /**
       * The working tree's blob.
       */
      workingTreeBlobId: GitObjectId;
      /**
       * The pull request, in that scope.
       */
      requestNumber?: number;
    };

/**
 * One held note as the daemon holds it: where it sits, a one-line quote of its line, the
 * person's words, whether its line still exists in the diff, and when it was made and last
 * edited.
 */
export interface ReviewNote {
  /**
   * The comparison it was left in.
   */
  comparison: ReviewNoteComparison;
  /**
   * The file.
   */
  path: string;
  /**
   * The file's earlier path, when it was renamed.
   */
  oldPath?: string;
  /**
   * The line's side.
   */
  side: ReviewNoteSide;
  /**
   * The line, or the last of several.
   */
  line: number;
  /**
   * The first of several lines, at or before `line`.
   */
  startLine?: number;
  /**
   * The note.
   */
  noteId: ReviewNoteId;
  /**
   * A one-line quote of its line.
   */
  quote: string;
  /**
   * The person's words.
   */
  body: string;
  /**
   * Whether its line is gone from the diff.
   */
  stranded: boolean;
  /**
   * When it was made.
   */
  createdAt: WireInstant;
  /**
   * When it was last edited.
   */
  updatedAt: WireInstant;
}
/**
 * `session.reviewNote.add`: holds a new note.
 */
export interface SessionReviewNoteAddRequest {
  /**
   * The comparison it was left in.
   */
  comparison: ReviewNoteComparison;
  /**
   * The file.
   */
  path: string;
  /**
   * The file's earlier path, when it was renamed.
   */
  oldPath?: string;
  /**
   * The line's side.
   */
  side: ReviewNoteSide;
  /**
   * The line, or the last of several.
   */
  line: number;
  /**
   * The first of several lines, at or before `line`.
   */
  startLine?: number;
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The note.
   */
  noteId: ReviewNoteId;
  /**
   * The person's words.
   */
  body: string;
}
/**
 * The note as the daemon holds it.
 */
export interface SessionReviewNoteResponse {
  /**
   * The note.
   */
  note: ReviewNote;
}
/**
 * `session.reviewNote.update`: replaces a held note's words.
 */
export interface SessionReviewNoteUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The note.
   */
  noteId: ReviewNoteId;
  /**
   * The new words.
   */
  body: string;
}
/**
 * `session.reviewNote.delete`: discards held notes in one act; the notes chip's `×` discards
 * every note behind one question, and a steer clears every note it carried.
 */
export interface SessionReviewNoteDeleteRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The notes.
   *
   * @minItems 1
   */
  noteIds: [ReviewNoteId, ...ReviewNoteId[]];
}
/**
 * The notes a remove discarded; an id the session did not hold is left out.
 */
export interface SessionReviewNoteDeleteResponse {
  /**
   * The notes discarded.
   */
  removedNoteIds: ReviewNoteId[];
}
/**
 * The session's held notes.
 */
export interface ReviewNoteSet {
  /**
   * The notes.
   */
  notes: ReviewNote[];
}
/**
 * `session.reviewNote.subscribe`: follows a session's held notes, the whole set now and on each
 * change.
 */
export interface SessionReviewNoteSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}

// prettier-ignore
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link ReviewNoteId}. */
// prettier-ignore
export const validateReviewNoteId: CompiledSchemaCheck<ReviewNoteId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ReviewNoteId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateReviewNoteId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateReviewNoteId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateReviewNoteId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateReviewNoteId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateReviewNoteId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1086: any = {"description":"The scopes a note can be left in: the uncommitted changes, the branch, or a pull request.","type":"string","enum":["changes","branch","changeRequest"]};
/** Checks that a value is a {@link ReviewNoteScope}. */
// prettier-ignore
export const validateReviewNoteScope: CompiledSchemaCheck<ReviewNoteScope> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ReviewNoteScope {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateReviewNoteScope.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateReviewNoteScope.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "changes") || (data === "branch")) || (data === "changeRequest"))){validateReviewNoteScope.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1086.enum}}];return false;}validateReviewNoteScope.errors = vErrors;return errors === 0;};
// prettier-ignore
validateReviewNoteScope.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1087: any = {"description":"Which side of the diff the note's line is on.","type":"string","enum":["added","removed"]};
/** Checks that a value is a {@link ReviewNoteSide}. */
// prettier-ignore
export const validateReviewNoteSide: CompiledSchemaCheck<ReviewNoteSide> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ReviewNoteSide {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateReviewNoteSide.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateReviewNoteSide.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "added") || (data === "removed"))){validateReviewNoteSide.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1087.enum}}];return false;}validateReviewNoteSide.errors = vErrors;return errors === 0;};
// prettier-ignore
validateReviewNoteSide.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link ReviewNoteComparison}. */
// prettier-ignore
export const validateReviewNoteComparison: CompiledSchemaCheck<ReviewNoteComparison> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ReviewNoteComparison {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateReviewNoteComparison.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.scope === undefined) && (missing0 = "scope")) || ((data.base === undefined) && (missing0 = "base"))) || ((data.headCommitId === undefined) && (missing0 = "headCommitId"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((((key0 === "scope") || (key0 === "base")) || (key0 === "headCommitId")) || (key0 === "requestNumber"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.scope !== undefined){const _errs4: any = errors;if(!(validateReviewNoteScope.call(this, data.scope, {instancePath:instancePath+"/scope",parentData:data,parentDataProperty:"scope",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewNoteScope.errors : vErrors.concat(validateReviewNoteScope.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.base !== undefined){let data1: any = data.base;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) < 1){const err2: any = {instancePath:instancePath+"/base",schemaPath:"#/anyOf/0/properties/base/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}else {const err3: any = {instancePath:instancePath+"/base",schemaPath:"#/anyOf/0/properties/base/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}var valid1: any = _errs5 === errors;}else {var valid1: any = true;}if(valid1){if(data.headCommitId !== undefined){const _errs7: any = errors;if(!(validateGitObjectId.call(this, data.headCommitId, {instancePath:instancePath+"/headCommitId",parentData:data,parentDataProperty:"headCommitId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateGitObjectId.errors : vErrors.concat(validateGitObjectId.errors);errors = vErrors.length;}var valid1: any = _errs7 === errors;}else {var valid1: any = true;}if(valid1){if(data.requestNumber !== undefined){let data3: any = data.requestNumber;const _errs8: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){const err4: any = {instancePath:instancePath+"/requestNumber",schemaPath:"#/anyOf/0/properties/requestNumber/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}if(errors === _errs8){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){const err5: any = {instancePath:instancePath+"/requestNumber",schemaPath:"#/anyOf/0/properties/requestNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}else {if(data3 < 1 || isNaN(data3)){const err6: any = {instancePath:instancePath+"/requestNumber",schemaPath:"#/anyOf/0/properties/requestNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}}}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}}}}}}}else {const err7: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs10: any = errors;if(errors === _errs10){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.scope === undefined) && (missing1 = "scope")) || ((data.base === undefined) && (missing1 = "base"))) || ((data.workingTreeBlobId === undefined) && (missing1 = "workingTreeBlobId"))){const err8: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}else {const _errs12: any = errors;for(const key1 in data){if(!((((key1 === "scope") || (key1 === "base")) || (key1 === "workingTreeBlobId")) || (key1 === "requestNumber"))){const err9: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;break;}}if(_errs12 === errors){if(data.scope !== undefined){const _errs13: any = errors;if(!(validateReviewNoteScope.call(this, data.scope, {instancePath:instancePath+"/scope",parentData:data,parentDataProperty:"scope",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewNoteScope.errors : vErrors.concat(validateReviewNoteScope.errors);errors = vErrors.length;}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.base !== undefined){let data5: any = data.base;const _errs14: any = errors;if(errors === _errs14){if(typeof data5 === "string"){if(func1(data5) < 1){const err10: any = {instancePath:instancePath+"/base",schemaPath:"#/anyOf/1/properties/base/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}else {const err11: any = {instancePath:instancePath+"/base",schemaPath:"#/anyOf/1/properties/base/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data.workingTreeBlobId !== undefined){const _errs16: any = errors;if(!(validateGitObjectId.call(this, data.workingTreeBlobId, {instancePath:instancePath+"/workingTreeBlobId",parentData:data,parentDataProperty:"workingTreeBlobId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateGitObjectId.errors : vErrors.concat(validateGitObjectId.errors);errors = vErrors.length;}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.requestNumber !== undefined){let data7: any = data.requestNumber;const _errs17: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){const err12: any = {instancePath:instancePath+"/requestNumber",schemaPath:"#/anyOf/1/properties/requestNumber/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}if(errors === _errs17){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){const err13: any = {instancePath:instancePath+"/requestNumber",schemaPath:"#/anyOf/1/properties/requestNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}else {if(data7 < 1 || isNaN(data7)){const err14: any = {instancePath:instancePath+"/requestNumber",schemaPath:"#/anyOf/1/properties/requestNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}}}}var valid2: any = _errs17 === errors;}else {var valid2: any = true;}}}}}}}else {const err15: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}}var _valid0: any = _errs10 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err16: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;validateReviewNoteComparison.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateReviewNoteComparison.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateReviewNoteComparison.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const schema1084: any = {"type":"object","additionalProperties":false,"properties":{"comparison":{"$ref":"#/$defs/ReviewNoteComparison","description":"The comparison it was left in."},"path":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file."},"oldPath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file's earlier path, when it was renamed."},"side":{"$ref":"#/$defs/ReviewNoteSide","description":"The line's side."},"line":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The line, or the last of several."},"startLine":{"type":"integer","minimum":1,"maximum":{"$data":"1/line"},"description":"The first of several lines, at or before `line`."},"noteId":{"$ref":"#/$defs/ReviewNoteId","description":"The note."},"quote":{"type":"string","description":"A one-line quote of its line."},"body":{"type":"string","minLength":1,"description":"The person's words."},"stranded":{"type":"boolean","description":"Whether its line is gone from the diff."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was made."},"updatedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was last edited."}},"required":["comparison","path","side","line","noteId","quote","body","stranded","createdAt","updatedAt"],"description":"One held note as the daemon holds it: where it sits, a one-line quote of its line, the\nperson's words, whether its line still exists in the diff, and when it was made and last\nedited."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link ReviewNote}. */
// prettier-ignore
export const validateReviewNote: CompiledSchemaCheck<ReviewNote> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ReviewNote {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateReviewNote.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((((data.comparison === undefined) && (missing0 = "comparison")) || ((data.path === undefined) && (missing0 = "path"))) || ((data.side === undefined) && (missing0 = "side"))) || ((data.line === undefined) && (missing0 = "line"))) || ((data.noteId === undefined) && (missing0 = "noteId"))) || ((data.quote === undefined) && (missing0 = "quote"))) || ((data.body === undefined) && (missing0 = "body"))) || ((data.stranded === undefined) && (missing0 = "stranded"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))) || ((data.updatedAt === undefined) && (missing0 = "updatedAt"))){validateReviewNote.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1084.properties, key0))){validateReviewNote.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.comparison !== undefined){const _errs2: any = errors;if(!(validateReviewNoteComparison.call(this, data.comparison, {instancePath:instancePath+"/comparison",parentData:data,parentDataProperty:"comparison",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewNoteComparison.errors : vErrors.concat(validateReviewNoteComparison.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 4096){validateReviewNote.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validateReviewNote.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data1)){validateReviewNote.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateReviewNote.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.oldPath !== undefined){let data2: any = data.oldPath;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 4096){validateReviewNote.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validateReviewNote.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data2)){validateReviewNote.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateReviewNote.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.side !== undefined){const _errs7: any = errors;if(!(validateReviewNoteSide.call(this, data.side, {instancePath:instancePath+"/side",parentData:data,parentDataProperty:"side",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewNoteSide.errors : vErrors.concat(validateReviewNoteSide.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.line !== undefined){let data4: any = data.line;const _errs8: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateReviewNote.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateReviewNote.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 1 || isNaN(data4)){validateReviewNote.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.startLine !== undefined){let data5: any = data.startLine;const _errs10: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validateReviewNote.errors = [{instancePath:instancePath+"/startLine",schemaPath:"#/properties/startLine/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data5 == "number") && (isFinite(data5))){const vSchema0: any = data && data.line;if(vSchema0 !== undefined && ((!((typeof vSchema0 == "number") && (isFinite(vSchema0)))) || (data5 > vSchema0 || isNaN(data5)))){validateReviewNote.errors = [{instancePath:instancePath+"/startLine",schemaPath:"#/properties/startLine/maximum",keyword:"maximum",params:{comparison: "<=", limit: vSchema0}}];return false;}else {if(data5 < 1 || isNaN(data5)){validateReviewNote.errors = [{instancePath:instancePath+"/startLine",schemaPath:"#/properties/startLine/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.noteId !== undefined){const _errs12: any = errors;if(!(validateReviewNoteId.call(this, data.noteId, {instancePath:instancePath+"/noteId",parentData:data,parentDataProperty:"noteId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewNoteId.errors : vErrors.concat(validateReviewNoteId.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.quote !== undefined){const _errs13: any = errors;if(typeof data.quote !== "string"){validateReviewNote.errors = [{instancePath:instancePath+"/quote",schemaPath:"#/properties/quote/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.body !== undefined){let data8: any = data.body;const _errs15: any = errors;if(errors === _errs15){if(typeof data8 === "string"){if(func1(data8) < 1){validateReviewNote.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateReviewNote.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.stranded !== undefined){const _errs17: any = errors;if(typeof data.stranded !== "boolean"){validateReviewNote.errors = [{instancePath:instancePath+"/stranded",schemaPath:"#/properties/stranded/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}if(valid0){if(data.createdAt !== undefined){const _errs19: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}if(valid0){if(data.updatedAt !== undefined){const _errs20: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}else {validateReviewNote.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateReviewNote.errors = vErrors;return errors === 0;};
// prettier-ignore
validateReviewNote.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1088: any = {"type":"object","additionalProperties":false,"properties":{"comparison":{"$ref":"#/$defs/ReviewNoteComparison","description":"The comparison it was left in."},"path":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file."},"oldPath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file's earlier path, when it was renamed."},"side":{"$ref":"#/$defs/ReviewNoteSide","description":"The line's side."},"line":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The line, or the last of several."},"startLine":{"type":"integer","minimum":1,"maximum":{"$data":"1/line"},"description":"The first of several lines, at or before `line`."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"noteId":{"$ref":"#/$defs/ReviewNoteId","description":"The note."},"body":{"type":"string","minLength":1,"description":"The person's words."}},"required":["comparison","path","side","line","sessionId","noteId","body"],"description":"`session.reviewNote.add`: holds a new note."};
/** Checks that a value is a {@link SessionReviewNoteAddRequest}. */
// prettier-ignore
export const validateSessionReviewNoteAddRequest: CompiledSchemaCheck<SessionReviewNoteAddRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewNoteAddRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionReviewNoteAddRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.comparison === undefined) && (missing0 = "comparison")) || ((data.path === undefined) && (missing0 = "path"))) || ((data.side === undefined) && (missing0 = "side"))) || ((data.line === undefined) && (missing0 = "line"))) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.noteId === undefined) && (missing0 = "noteId"))) || ((data.body === undefined) && (missing0 = "body"))){validateSessionReviewNoteAddRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1088.properties, key0))){validateSessionReviewNoteAddRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.comparison !== undefined){const _errs2: any = errors;if(!(validateReviewNoteComparison.call(this, data.comparison, {instancePath:instancePath+"/comparison",parentData:data,parentDataProperty:"comparison",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewNoteComparison.errors : vErrors.concat(validateReviewNoteComparison.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 4096){validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data1)){validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.oldPath !== undefined){let data2: any = data.oldPath;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 4096){validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data2)){validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.side !== undefined){const _errs7: any = errors;if(!(validateReviewNoteSide.call(this, data.side, {instancePath:instancePath+"/side",parentData:data,parentDataProperty:"side",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewNoteSide.errors : vErrors.concat(validateReviewNoteSide.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.line !== undefined){let data4: any = data.line;const _errs8: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 1 || isNaN(data4)){validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.startLine !== undefined){let data5: any = data.startLine;const _errs10: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/startLine",schemaPath:"#/properties/startLine/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data5 == "number") && (isFinite(data5))){const vSchema0: any = data && data.line;if(vSchema0 !== undefined && ((!((typeof vSchema0 == "number") && (isFinite(vSchema0)))) || (data5 > vSchema0 || isNaN(data5)))){validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/startLine",schemaPath:"#/properties/startLine/maximum",keyword:"maximum",params:{comparison: "<=", limit: vSchema0}}];return false;}else {if(data5 < 1 || isNaN(data5)){validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/startLine",schemaPath:"#/properties/startLine/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){const _errs12: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.noteId !== undefined){const _errs13: any = errors;if(!(validateReviewNoteId.call(this, data.noteId, {instancePath:instancePath+"/noteId",parentData:data,parentDataProperty:"noteId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewNoteId.errors : vErrors.concat(validateReviewNoteId.errors);errors = vErrors.length;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.body !== undefined){let data8: any = data.body;const _errs14: any = errors;if(errors === _errs14){if(typeof data8 === "string"){if(func1(data8) < 1){validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionReviewNoteAddRequest.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}}}}}}else {validateSessionReviewNoteAddRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionReviewNoteAddRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionReviewNoteAddRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionReviewNoteResponse}. */
// prettier-ignore
export const validateSessionReviewNoteResponse: CompiledSchemaCheck<SessionReviewNoteResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewNoteResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionReviewNoteResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.note === undefined) && (missing0 = "note")){validateSessionReviewNoteResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "note")){validateSessionReviewNoteResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.note !== undefined){if(!(validateReviewNote.call(this, data.note, {instancePath:instancePath+"/note",parentData:data,parentDataProperty:"note",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewNote.errors : vErrors.concat(validateReviewNote.errors);errors = vErrors.length;}}}}}else {validateSessionReviewNoteResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionReviewNoteResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionReviewNoteResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionReviewNoteUpdateRequest}. */
// prettier-ignore
export const validateSessionReviewNoteUpdateRequest: CompiledSchemaCheck<SessionReviewNoteUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewNoteUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionReviewNoteUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.noteId === undefined) && (missing0 = "noteId"))) || ((data.body === undefined) && (missing0 = "body"))){validateSessionReviewNoteUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "noteId")) || (key0 === "body"))){validateSessionReviewNoteUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.noteId !== undefined){const _errs3: any = errors;if(!(validateReviewNoteId.call(this, data.noteId, {instancePath:instancePath+"/noteId",parentData:data,parentDataProperty:"noteId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewNoteId.errors : vErrors.concat(validateReviewNoteId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.body !== undefined){let data2: any = data.body;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) < 1){validateSessionReviewNoteUpdateRequest.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionReviewNoteUpdateRequest.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionReviewNoteUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionReviewNoteUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionReviewNoteUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionReviewNoteDeleteRequest}. */
// prettier-ignore
export const validateSessionReviewNoteDeleteRequest: CompiledSchemaCheck<SessionReviewNoteDeleteRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewNoteDeleteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionReviewNoteDeleteRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.noteIds === undefined) && (missing0 = "noteIds"))){validateSessionReviewNoteDeleteRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "noteIds"))){validateSessionReviewNoteDeleteRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.noteIds !== undefined){let data1: any = data.noteIds;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){if(data1.length < 1){validateSessionReviewNoteDeleteRequest.errors = [{instancePath:instancePath+"/noteIds",schemaPath:"#/properties/noteIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateReviewNoteId.call(this, data1[i0], {instancePath:instancePath+"/noteIds/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewNoteId.errors : vErrors.concat(validateReviewNoteId.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}}else {validateSessionReviewNoteDeleteRequest.errors = [{instancePath:instancePath+"/noteIds",schemaPath:"#/properties/noteIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionReviewNoteDeleteRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionReviewNoteDeleteRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionReviewNoteDeleteRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionReviewNoteDeleteResponse}. */
// prettier-ignore
export const validateSessionReviewNoteDeleteResponse: CompiledSchemaCheck<SessionReviewNoteDeleteResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewNoteDeleteResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionReviewNoteDeleteResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.removedNoteIds === undefined) && (missing0 = "removedNoteIds")){validateSessionReviewNoteDeleteResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "removedNoteIds")){validateSessionReviewNoteDeleteResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.removedNoteIds !== undefined){let data0: any = data.removedNoteIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateReviewNoteId.call(this, data0[i0], {instancePath:instancePath+"/removedNoteIds/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewNoteId.errors : vErrors.concat(validateReviewNoteId.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateSessionReviewNoteDeleteResponse.errors = [{instancePath:instancePath+"/removedNoteIds",schemaPath:"#/properties/removedNoteIds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateSessionReviewNoteDeleteResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionReviewNoteDeleteResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionReviewNoteDeleteResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ReviewNoteSet}. */
// prettier-ignore
export const validateReviewNoteSet: CompiledSchemaCheck<ReviewNoteSet> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ReviewNoteSet {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateReviewNoteSet.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.notes === undefined) && (missing0 = "notes")){validateReviewNoteSet.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "notes")){validateReviewNoteSet.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.notes !== undefined){let data0: any = data.notes;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateReviewNote.call(this, data0[i0], {instancePath:instancePath+"/notes/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewNote.errors : vErrors.concat(validateReviewNote.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateReviewNoteSet.errors = [{instancePath:instancePath+"/notes",schemaPath:"#/properties/notes/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateReviewNoteSet.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateReviewNoteSet.errors = vErrors;return errors === 0;};
// prettier-ignore
validateReviewNoteSet.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionReviewNoteSubscribeRequest}. */
// prettier-ignore
export const validateSessionReviewNoteSubscribeRequest: CompiledSchemaCheck<SessionReviewNoteSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewNoteSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionReviewNoteSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateSessionReviewNoteSubscribeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateSessionReviewNoteSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateSessionReviewNoteSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionReviewNoteSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionReviewNoteSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link REVIEW_NOTE_METHOD_DESCRIPTORS}, each with its checks. */
export interface ReviewNoteMethodDescriptors {
  readonly "session.reviewNote.add": {
    readonly method: "session.reviewNote.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionReviewNoteAddRequest>;
    readonly responseCheck: SchemaCheck<SessionReviewNoteResponse>;
  };
  readonly "session.reviewNote.update": {
    readonly method: "session.reviewNote.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionReviewNoteUpdateRequest>;
    readonly responseCheck: SchemaCheck<SessionReviewNoteResponse>;
  };
  readonly "session.reviewNote.delete": {
    readonly method: "session.reviewNote.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionReviewNoteDeleteRequest>;
    readonly responseCheck: SchemaCheck<SessionReviewNoteDeleteResponse>;
  };
  readonly "session.reviewNote.subscribe": {
    readonly method: "session.reviewNote.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionReviewNoteSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<ReviewNoteSet>;
  };
}
/** The held-note methods. */
export const REVIEW_NOTE_METHOD_DESCRIPTORS: ReviewNoteMethodDescriptors = Object.freeze({
  "session.reviewNote.add": Object.freeze({
    method: "session.reviewNote.add",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionReviewNoteAddRequest,
    responseCheck: validateSessionReviewNoteResponse,
  }),
  "session.reviewNote.update": Object.freeze({
    method: "session.reviewNote.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionReviewNoteUpdateRequest,
    responseCheck: validateSessionReviewNoteResponse,
  }),
  "session.reviewNote.delete": Object.freeze({
    method: "session.reviewNote.delete",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionReviewNoteDeleteRequest,
    responseCheck: validateSessionReviewNoteDeleteResponse,
  }),
  "session.reviewNote.subscribe": Object.freeze({
    method: "session.reviewNote.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateSessionReviewNoteSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateReviewNoteSet,
  }),
});
