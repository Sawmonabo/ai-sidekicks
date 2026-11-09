// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A held review note: a note the person leaves on a line of Review's diff, held by the daemon and scoped to the session.

import { type SchemaCheck, ucs2length } from "../schema-check.js";
import type { WireInstant } from "./internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import type { GitObjectId } from "./repo/git-reads.js";
import type { SessionId } from "./session/id.js";

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
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate1691(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ReviewNoteId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1691.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate1691.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1691.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1691.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1691.errors = null as any[] | null;
// prettier-ignore
validate1691.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3151: any = {"type":"object","additionalProperties":false,"properties":{"comparison":{"$ref":"#/$defs/ReviewNoteComparison","description":"The comparison it was left in."},"path":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file."},"oldPath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file's earlier path, when it was renamed."},"side":{"$ref":"#/$defs/ReviewNoteSide","description":"The line's side."},"line":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The line, or the last of several."},"startLine":{"type":"integer","minimum":1,"maximum":{"$data":"1/line"},"description":"The first of several lines, at or before `line`."},"noteId":{"$ref":"#/$defs/ReviewNoteId","description":"The note."},"quote":{"type":"string","description":"A one-line quote of its line."},"body":{"type":"string","minLength":1,"description":"The person's words."},"stranded":{"type":"boolean","description":"Whether its line is gone from the diff."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was made."},"updatedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was last edited."}},"required":["comparison","path","side","line","noteId","quote","body","stranded","createdAt","updatedAt"],"description":"One held note as the daemon holds it: where it sits, a one-line quote of its line, the\nperson's words, whether its line still exists in the diff, and when it was made and last\nedited."};
// prettier-ignore
const schema3157: any = {"description":"Which side of the diff the note's line is on.","type":"string","enum":["added","removed"]};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const schema3153: any = {"description":"The scopes a note can be left in: the uncommitted changes, the branch, or a pull request.","type":"string","enum":["changes","branch","changeRequest"]};
// prettier-ignore
const pattern730 = new RegExp("^(?:[0-9a-f]{40}|[0-9a-f]{64})$", "u");
// prettier-ignore
function validate1694(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1694.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.scope === undefined) && (missing0 = "scope")) || ((data.base === undefined) && (missing0 = "base"))) || ((data.headCommitId === undefined) && (missing0 = "headCommitId"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((((key0 === "scope") || (key0 === "base")) || (key0 === "headCommitId")) || (key0 === "requestNumber"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.scope !== undefined){let data0: any = data.scope;const _errs4: any = errors;if(typeof data0 !== "string"){const err2: any = {instancePath:instancePath+"/scope",schemaPath:"#/$defs/ReviewNoteScope/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(!(((data0 === "changes") || (data0 === "branch")) || (data0 === "changeRequest"))){const err3: any = {instancePath:instancePath+"/scope",schemaPath:"#/$defs/ReviewNoteScope/enum",keyword:"enum",params:{allowedValues: schema3153.enum}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.base !== undefined){let data1: any = data.base;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) < 1){const err4: any = {instancePath:instancePath+"/base",schemaPath:"#/anyOf/0/properties/base/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}else {const err5: any = {instancePath:instancePath+"/base",schemaPath:"#/anyOf/0/properties/base/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid1: any = _errs7 === errors;}else {var valid1: any = true;}if(valid1){if(data.headCommitId !== undefined){let data2: any = data.headCommitId;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(!pattern730.test(data2)){const err6: any = {instancePath:instancePath+"/headCommitId",schemaPath:"sidekicks-contracts:repo/git-reads#/$defs/GitObjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}else {const err7: any = {instancePath:instancePath+"/headCommitId",schemaPath:"sidekicks-contracts:repo/git-reads#/$defs/GitObjectId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}var valid1: any = _errs9 === errors;}else {var valid1: any = true;}if(valid1){if(data.requestNumber !== undefined){let data3: any = data.requestNumber;const _errs13: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){const err8: any = {instancePath:instancePath+"/requestNumber",schemaPath:"#/anyOf/0/properties/requestNumber/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}if(errors === _errs13){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){const err9: any = {instancePath:instancePath+"/requestNumber",schemaPath:"#/anyOf/0/properties/requestNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}else {if(data3 < 1 || isNaN(data3)){const err10: any = {instancePath:instancePath+"/requestNumber",schemaPath:"#/anyOf/0/properties/requestNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}}}var valid1: any = _errs13 === errors;}else {var valid1: any = true;}}}}}}}else {const err11: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs15: any = errors;if(errors === _errs15){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.scope === undefined) && (missing1 = "scope")) || ((data.base === undefined) && (missing1 = "base"))) || ((data.workingTreeBlobId === undefined) && (missing1 = "workingTreeBlobId"))){const err12: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}else {const _errs17: any = errors;for(const key1 in data){if(!((((key1 === "scope") || (key1 === "base")) || (key1 === "workingTreeBlobId")) || (key1 === "requestNumber"))){const err13: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;break;}}if(_errs17 === errors){if(data.scope !== undefined){let data4: any = data.scope;const _errs18: any = errors;if(typeof data4 !== "string"){const err14: any = {instancePath:instancePath+"/scope",schemaPath:"#/$defs/ReviewNoteScope/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}if(!(((data4 === "changes") || (data4 === "branch")) || (data4 === "changeRequest"))){const err15: any = {instancePath:instancePath+"/scope",schemaPath:"#/$defs/ReviewNoteScope/enum",keyword:"enum",params:{allowedValues: schema3153.enum}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data.base !== undefined){let data5: any = data.base;const _errs21: any = errors;if(errors === _errs21){if(typeof data5 === "string"){if(func1(data5) < 1){const err16: any = {instancePath:instancePath+"/base",schemaPath:"#/anyOf/1/properties/base/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}else {const err17: any = {instancePath:instancePath+"/base",schemaPath:"#/anyOf/1/properties/base/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}}var valid4: any = _errs21 === errors;}else {var valid4: any = true;}if(valid4){if(data.workingTreeBlobId !== undefined){let data6: any = data.workingTreeBlobId;const _errs23: any = errors;const _errs24: any = errors;if(errors === _errs24){if(typeof data6 === "string"){if(!pattern730.test(data6)){const err18: any = {instancePath:instancePath+"/workingTreeBlobId",schemaPath:"sidekicks-contracts:repo/git-reads#/$defs/GitObjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}}else {const err19: any = {instancePath:instancePath+"/workingTreeBlobId",schemaPath:"sidekicks-contracts:repo/git-reads#/$defs/GitObjectId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}}var valid4: any = _errs23 === errors;}else {var valid4: any = true;}if(valid4){if(data.requestNumber !== undefined){let data7: any = data.requestNumber;const _errs27: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){const err20: any = {instancePath:instancePath+"/requestNumber",schemaPath:"#/anyOf/1/properties/requestNumber/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}if(errors === _errs27){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){const err21: any = {instancePath:instancePath+"/requestNumber",schemaPath:"#/anyOf/1/properties/requestNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}else {if(data7 < 1 || isNaN(data7)){const err22: any = {instancePath:instancePath+"/requestNumber",schemaPath:"#/anyOf/1/properties/requestNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}}}}var valid4: any = _errs27 === errors;}else {var valid4: any = true;}}}}}}}else {const err23: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}}var _valid0: any = _errs15 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err24: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;validate1694.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1694.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1694.errors = null as any[] | null;
// prettier-ignore
validate1694.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate1693(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1693.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((((data.comparison === undefined) && (missing0 = "comparison")) || ((data.path === undefined) && (missing0 = "path"))) || ((data.side === undefined) && (missing0 = "side"))) || ((data.line === undefined) && (missing0 = "line"))) || ((data.noteId === undefined) && (missing0 = "noteId"))) || ((data.quote === undefined) && (missing0 = "quote"))) || ((data.body === undefined) && (missing0 = "body"))) || ((data.stranded === undefined) && (missing0 = "stranded"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))) || ((data.updatedAt === undefined) && (missing0 = "updatedAt"))){validate1693.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema3151.properties, key0))){validate1693.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.comparison !== undefined){const _errs2: any = errors;if(!(validate1694.call(this, data.comparison, {instancePath:instancePath+"/comparison",parentData:data,parentDataProperty:"comparison",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1694.errors : vErrors.concat(validate1694.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1693.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate1693.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data1)){validate1693.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1693.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.oldPath !== undefined){let data2: any = data.oldPath;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 4096){validate1693.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validate1693.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data2)){validate1693.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1693.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.side !== undefined){let data3: any = data.side;const _errs7: any = errors;if(typeof data3 !== "string"){validate1693.errors = [{instancePath:instancePath+"/side",schemaPath:"#/$defs/ReviewNoteSide/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data3 === "added") || (data3 === "removed"))){validate1693.errors = [{instancePath:instancePath+"/side",schemaPath:"#/$defs/ReviewNoteSide/enum",keyword:"enum",params:{allowedValues: schema3157.enum}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.line !== undefined){let data4: any = data.line;const _errs10: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate1693.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate1693.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 1 || isNaN(data4)){validate1693.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.startLine !== undefined){let data5: any = data.startLine;const _errs12: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate1693.errors = [{instancePath:instancePath+"/startLine",schemaPath:"#/properties/startLine/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data5 == "number") && (isFinite(data5))){const vSchema1: any = data && data.line;if(vSchema1 !== undefined && ((!((typeof vSchema1 == "number") && (isFinite(vSchema1)))) || (data5 > vSchema1 || isNaN(data5)))){validate1693.errors = [{instancePath:instancePath+"/startLine",schemaPath:"#/properties/startLine/maximum",keyword:"maximum",params:{comparison: "<=", limit: vSchema1}}];return false;}else {if(data5 < 1 || isNaN(data5)){validate1693.errors = [{instancePath:instancePath+"/startLine",schemaPath:"#/properties/startLine/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.noteId !== undefined){let data6: any = data.noteId;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data6 === "string"){if(!pattern4.test(data6)){validate1693.errors = [{instancePath:instancePath+"/noteId",schemaPath:"#/$defs/ReviewNoteId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1693.errors = [{instancePath:instancePath+"/noteId",schemaPath:"#/$defs/ReviewNoteId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.quote !== undefined){const _errs18: any = errors;if(typeof data.quote !== "string"){validate1693.errors = [{instancePath:instancePath+"/quote",schemaPath:"#/properties/quote/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.body !== undefined){let data8: any = data.body;const _errs20: any = errors;if(errors === _errs20){if(typeof data8 === "string"){if(func1(data8) < 1){validate1693.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1693.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.stranded !== undefined){const _errs22: any = errors;if(typeof data.stranded !== "boolean"){validate1693.errors = [{instancePath:instancePath+"/stranded",schemaPath:"#/properties/stranded/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}if(valid0){if(data.createdAt !== undefined){let data10: any = data.createdAt;const _errs24: any = errors;const _errs25: any = errors;if(errors === _errs25){if(typeof data10 === "string"){if(!pattern5.test(data10)){validate1693.errors = [{instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1693.errors = [{instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs24 === errors;}else {var valid0: any = true;}if(valid0){if(data.updatedAt !== undefined){let data11: any = data.updatedAt;const _errs27: any = errors;const _errs28: any = errors;if(errors === _errs28){if(typeof data11 === "string"){if(!pattern5.test(data11)){validate1693.errors = [{instancePath:instancePath+"/updatedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1693.errors = [{instancePath:instancePath+"/updatedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs27 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}else {validate1693.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1693.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1693.errors = null as any[] | null;
// prettier-ignore
validate1693.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1692(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ReviewNoteSet {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1692.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.notes === undefined) && (missing0 = "notes")){validate1692.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "notes")){validate1692.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.notes !== undefined){let data0: any = data.notes;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate1693.call(this, data0[i0], {instancePath:instancePath+"/notes/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1693.errors : vErrors.concat(validate1693.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1692.errors = [{instancePath:instancePath+"/notes",schemaPath:"#/properties/notes/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate1692.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1692.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1692.errors = null as any[] | null;
// prettier-ignore
validate1692.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3161: any = {"type":"object","additionalProperties":false,"properties":{"comparison":{"$ref":"#/$defs/ReviewNoteComparison","description":"The comparison it was left in."},"path":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file."},"oldPath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file's earlier path, when it was renamed."},"side":{"$ref":"#/$defs/ReviewNoteSide","description":"The line's side."},"line":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The line, or the last of several."},"startLine":{"type":"integer","minimum":1,"maximum":{"$data":"1/line"},"description":"The first of several lines, at or before `line`."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"noteId":{"$ref":"#/$defs/ReviewNoteId","description":"The note."},"body":{"type":"string","minLength":1,"description":"The person's words."}},"required":["comparison","path","side","line","sessionId","noteId","body"],"description":"`session.reviewNote.add`: holds a new note."};
// prettier-ignore
function validate1697(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewNoteAddRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1697.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.comparison === undefined) && (missing0 = "comparison")) || ((data.path === undefined) && (missing0 = "path"))) || ((data.side === undefined) && (missing0 = "side"))) || ((data.line === undefined) && (missing0 = "line"))) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.noteId === undefined) && (missing0 = "noteId"))) || ((data.body === undefined) && (missing0 = "body"))){validate1697.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema3161.properties, key0))){validate1697.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.comparison !== undefined){const _errs2: any = errors;if(!(validate1694.call(this, data.comparison, {instancePath:instancePath+"/comparison",parentData:data,parentDataProperty:"comparison",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1694.errors : vErrors.concat(validate1694.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1697.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate1697.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data1)){validate1697.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1697.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.oldPath !== undefined){let data2: any = data.oldPath;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 4096){validate1697.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validate1697.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data2)){validate1697.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1697.errors = [{instancePath:instancePath+"/oldPath",schemaPath:"#/properties/oldPath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.side !== undefined){let data3: any = data.side;const _errs7: any = errors;if(typeof data3 !== "string"){validate1697.errors = [{instancePath:instancePath+"/side",schemaPath:"#/$defs/ReviewNoteSide/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data3 === "added") || (data3 === "removed"))){validate1697.errors = [{instancePath:instancePath+"/side",schemaPath:"#/$defs/ReviewNoteSide/enum",keyword:"enum",params:{allowedValues: schema3157.enum}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.line !== undefined){let data4: any = data.line;const _errs10: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate1697.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate1697.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 1 || isNaN(data4)){validate1697.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.startLine !== undefined){let data5: any = data.startLine;const _errs12: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate1697.errors = [{instancePath:instancePath+"/startLine",schemaPath:"#/properties/startLine/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data5 == "number") && (isFinite(data5))){const vSchema1: any = data && data.line;if(vSchema1 !== undefined && ((!((typeof vSchema1 == "number") && (isFinite(vSchema1)))) || (data5 > vSchema1 || isNaN(data5)))){validate1697.errors = [{instancePath:instancePath+"/startLine",schemaPath:"#/properties/startLine/maximum",keyword:"maximum",params:{comparison: "<=", limit: vSchema1}}];return false;}else {if(data5 < 1 || isNaN(data5)){validate1697.errors = [{instancePath:instancePath+"/startLine",schemaPath:"#/properties/startLine/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){let data6: any = data.sessionId;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data6 === "string"){if(!pattern4.test(data6)){validate1697.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1697.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.noteId !== undefined){let data7: any = data.noteId;const _errs18: any = errors;const _errs19: any = errors;if(errors === _errs19){if(typeof data7 === "string"){if(!pattern4.test(data7)){validate1697.errors = [{instancePath:instancePath+"/noteId",schemaPath:"#/$defs/ReviewNoteId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1697.errors = [{instancePath:instancePath+"/noteId",schemaPath:"#/$defs/ReviewNoteId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.body !== undefined){let data8: any = data.body;const _errs22: any = errors;if(errors === _errs22){if(typeof data8 === "string"){if(func1(data8) < 1){validate1697.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1697.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}}}}}}}}}}}}else {validate1697.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1697.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1697.errors = null as any[] | null;
// prettier-ignore
validate1697.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1699(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewNoteDeleteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1699.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.noteIds === undefined) && (missing0 = "noteIds"))){validate1699.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "noteIds"))){validate1699.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1699.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1699.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.noteIds !== undefined){let data1: any = data.noteIds;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){if(data1.length < 1){validate1699.errors = [{instancePath:instancePath+"/noteIds",schemaPath:"#/properties/noteIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate1699.errors = [{instancePath:instancePath+"/noteIds/" + i0,schemaPath:"#/$defs/ReviewNoteId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1699.errors = [{instancePath:instancePath+"/noteIds/" + i0,schemaPath:"#/$defs/ReviewNoteId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;if(!valid2){break;}}}}else {validate1699.errors = [{instancePath:instancePath+"/noteIds",schemaPath:"#/properties/noteIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1699.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1699.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1699.errors = null as any[] | null;
// prettier-ignore
validate1699.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1700(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewNoteDeleteResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1700.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.removedNoteIds === undefined) && (missing0 = "removedNoteIds")){validate1700.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "removedNoteIds")){validate1700.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.removedNoteIds !== undefined){let data0: any = data.removedNoteIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1700.errors = [{instancePath:instancePath+"/removedNoteIds/" + i0,schemaPath:"#/$defs/ReviewNoteId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1700.errors = [{instancePath:instancePath+"/removedNoteIds/" + i0,schemaPath:"#/$defs/ReviewNoteId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1700.errors = [{instancePath:instancePath+"/removedNoteIds",schemaPath:"#/properties/removedNoteIds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate1700.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1700.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1700.errors = null as any[] | null;
// prettier-ignore
validate1700.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1701(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewNoteResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1701.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.note === undefined) && (missing0 = "note")){validate1701.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "note")){validate1701.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.note !== undefined){if(!(validate1693.call(this, data.note, {instancePath:instancePath+"/note",parentData:data,parentDataProperty:"note",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1693.errors : vErrors.concat(validate1693.errors);errors = vErrors.length;}}}}}else {validate1701.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1701.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1701.errors = null as any[] | null;
// prettier-ignore
validate1701.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1703(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewNoteSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1703.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1703.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate1703.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1703.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1703.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1703.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1703.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1703.errors = null as any[] | null;
// prettier-ignore
validate1703.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1704(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewNoteUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1704.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.noteId === undefined) && (missing0 = "noteId"))) || ((data.body === undefined) && (missing0 = "body"))){validate1704.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "noteId")) || (key0 === "body"))){validate1704.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1704.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1704.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.noteId !== undefined){let data1: any = data.noteId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1704.errors = [{instancePath:instancePath+"/noteId",schemaPath:"#/$defs/ReviewNoteId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1704.errors = [{instancePath:instancePath+"/noteId",schemaPath:"#/$defs/ReviewNoteId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.body !== undefined){let data2: any = data.body;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(func1(data2) < 1){validate1704.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1704.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1704.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1704.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1704.errors = null as any[] | null;
// prettier-ignore
validate1704.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ReviewNoteId}. */
export const validateReviewNoteId: SchemaCheck<ReviewNoteId> = validate1691;
/** Checks that a value is a {@link ReviewNoteSet}. */
export const validateReviewNoteSet: SchemaCheck<ReviewNoteSet> = validate1692;
/** Checks that a value is a {@link SessionReviewNoteAddRequest}. */
export const validateSessionReviewNoteAddRequest: SchemaCheck<SessionReviewNoteAddRequest> =
  validate1697;
/** Checks that a value is a {@link SessionReviewNoteDeleteRequest}. */
export const validateSessionReviewNoteDeleteRequest: SchemaCheck<SessionReviewNoteDeleteRequest> =
  validate1699;
/** Checks that a value is a {@link SessionReviewNoteDeleteResponse}. */
export const validateSessionReviewNoteDeleteResponse: SchemaCheck<SessionReviewNoteDeleteResponse> =
  validate1700;
/** Checks that a value is a {@link SessionReviewNoteResponse}. */
export const validateSessionReviewNoteResponse: SchemaCheck<SessionReviewNoteResponse> =
  validate1701;
/** Checks that a value is a {@link SessionReviewNoteSubscribeRequest}. */
export const validateSessionReviewNoteSubscribeRequest: SchemaCheck<SessionReviewNoteSubscribeRequest> =
  validate1703;
/** Checks that a value is a {@link SessionReviewNoteUpdateRequest}. */
export const validateSessionReviewNoteUpdateRequest: SchemaCheck<SessionReviewNoteUpdateRequest> =
  validate1704;

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
