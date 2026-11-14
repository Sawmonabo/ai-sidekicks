// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The Preview page host's link between the daemon and the desktop's main process: debug targets, debugger traffic, menus, input at the machine, downloads, staged files, menu acts, cookies and site data.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../../schema-check.js";
import { validateBytes } from "../internal/wire-scalars.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import {
  type PreviewInputMessageId,
  type PreviewMenuEdit,
  type PreviewMenuEditResponse,
  type PreviewPageId,
  type PreviewPoint,
  type PreviewSaveId,
  validatePreviewInputMessageId,
  validatePreviewMenuEdit,
  validatePreviewMenuEditResponse,
  validatePreviewPageId,
  validatePreviewPoint,
  validatePreviewSaveId,
} from "./methods.js";

/** The longest staged-file id main or the daemon mints. */
export const PREVIEW_STAGED_FILE_ID_MAX_LEN = 256 as const;

/**
 * A debug-protocol session id: the child session a message rides on.
 */
export type PreviewDebuggerSessionId = string & { readonly __brand: "PreviewDebuggerSessionId" };
/**
 * A debug-protocol target id: the target behind one page's view.
 */
export type PreviewDebuggerTargetId = string & { readonly __brand: "PreviewDebuggerTargetId" };
/**
 * One debug-protocol message between the daemon's relay and a page's debugger in main: a command,
 * its result or error, or an event.
 */
export type PreviewDebuggerMessage =
  | {
      /**
       * The command's id, which its reply repeats.
       */
      id: number;
      /**
       * The protocol method.
       */
      method: string;
      /**
       * Its parameters.
       */
      params?: {
        [k: string]: unknown | undefined;
      };
      /**
       * The child session it rides on; absent for the page's own session.
       */
      sessionId?: PreviewDebuggerSessionId;
    }
  | {
      /**
       * The command's id.
       */
      id: number;
      /**
       * The result.
       */
      result: {
        [k: string]: unknown | undefined;
      };
      /**
       * The child session it rides on; absent for the page's own session.
       */
      sessionId?: PreviewDebuggerSessionId;
    }
  | {
      /**
       * The command's id.
       */
      id: number;
      /**
       * The error.
       */
      error: PreviewDebuggerError;
      /**
       * The child session it rides on; absent for the page's own session.
       */
      sessionId?: PreviewDebuggerSessionId;
    }
  | {
      /**
       * The protocol method.
       */
      method: string;
      /**
       * Its parameters.
       */
      params?: {
        [k: string]: unknown | undefined;
      };
      /**
       * The child session it rides on; absent for the page's own session.
       */
      sessionId?: PreviewDebuggerSessionId;
    };
/**
 * A random id naming one file staged in a folder: a download main wrote, or a file the
 * daemon sets or drops on a page. It is never a path.
 */
export type PreviewStagedFileId = string & { readonly __brand: "PreviewStagedFileId" };
/**
 * The state a relayed download ended in, as Electron's download item reports it when done.
 */
export type PreviewDownloadState = "completed" | "cancelled" | "interrupted";
/**
 * What the daemon did with a reported download.
 */
export type PreviewDownloadVerdict = "accepted" | "refused";
/**
 * Where a cookie is sent from another site's page.
 */
export type PreviewCookieSameSite = "Strict" | "Lax" | "None";

/**
 * A debug-protocol error.
 */
export interface PreviewDebuggerError {
  /**
   * The protocol's error code.
   */
  code: number;
  /**
   * What went wrong.
   */
  message: string;
}
/**
 * Main reports the debug target behind one page's view, once the view exists.
 */
export interface PreviewPageTargetReportRequest {
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * Its debug target.
   */
  targetId: PreviewDebuggerTargetId;
}
/**
 * One debugger message for one page, in either direction: the daemon sends a command to main, and
 * main returns the results and events to the daemon.
 */
export interface PreviewPageDebuggerMessageRequest {
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The message.
   */
  message: PreviewDebuggerMessage;
}
/**
 * The receiving end took the report or the message.
 */
export interface PreviewReceivedResponse {
  /**
   * Always `true`.
   */
  received: true;
}
/**
 * The right-click menu a press main relayed raised, for which main pops no menu, as the view's
 * `context-menu` event reports it.
 */
export interface PreviewPageMenu {
  /**
   * Where it opened, in view points.
   */
  point: PreviewPoint;
  /**
   * The address of the frame it opened in.
   */
  frameAddress: string;
  /**
   * The link under the press.
   */
  linkUrl?: string;
  /**
   * Whether the press landed in a field that takes text.
   */
  isEditable: boolean;
  /**
   * Whether the page allows a cut there.
   */
  canCut: boolean;
  /**
   * Whether the page allows a copy there.
   */
  canCopy: boolean;
  /**
   * Whether the page allows select all there.
   */
  canSelectAll: boolean;
  /**
   * The selected text; absent where the page allows no copy, as in a password field.
   */
  selectionText?: string;
}
/**
 * Main reports the menu a relayed press raised, named by that press's message id; it sends none
 * where another press at that moment could have raised the same menu. The daemon hands it to the
 * device whose press it was and drops it for an agent's.
 */
export interface PreviewPageMenuReportRequest {
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The relayed press.
   */
  messageId: PreviewInputMessageId;
  /**
   * The menu.
   */
  menu: PreviewPageMenu;
}
/**
 * The folder main writes a relayed download into, read once per connection: the daemon's own
 * staging folder, which it reads itself.
 */
export interface PreviewPageStagingFolderReadResponse {
  /**
   * The folder.
   */
  folder: string;
}
/**
 * Main reports that a press or key at the machine reached a page, once after each relayed input
 * to it, so the page's next download or picker call is the person's at the machine.
 */
export interface PreviewPageLocalInputReportRequest {
  /**
   * The page.
   */
  pageId: PreviewPageId;
}
/**
 * A download a relayed input owns, which main wrote to `<staging folder>/<fileId>` and reports
 * once it is done in any state. The daemon resolves `fileId` inside its folder itself and refuses
 * one main did not mint with `preview.filePathRefused`.
 */
export interface PreviewPageDownloadReportRequest {
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The last relayed input main carried to the page, which owns the download.
   */
  messageId: PreviewInputMessageId;
  /**
   * The id main minted for the download.
   */
  fileId: PreviewStagedFileId;
  /**
   * The item's own name, which Chromium has already cleaned.
   */
  fileName: string;
  /**
   * The state it ended in.
   */
  state: PreviewDownloadState;
}
/**
 * The daemon's answer to a download report.
 */
export interface PreviewPageDownloadReportResponse {
  /**
   * What it did.
   */
  verdict: PreviewDownloadVerdict;
}
/**
 * A desktop app reaching another machine reads one part of a save its own daemon kept for it, from
 * `offset`, once the system save dialog has a path, so no part crosses the renderer.
 */
export interface PreviewSaveReadRequest {
  /**
   * The save.
   */
  saveId: PreviewSaveId;
  /**
   * The byte the part starts at.
   */
  offset: number;
}
/**
 * One part of a staged file and whether it is the last.
 */
export interface PreviewSaveReadResponse {
  /**
   * The part's bytes.
   */
  part: Uint8Array;
  /**
   * Whether the file ends with this part.
   */
  isLastPart: boolean;
}
/**
 * A device's act from a menu main reported, naming the menu by its press's message id. Main
 * applies it in the frame holding focus while that menu is still the page's current one, and
 * otherwise refuses it with `preview.editRefused`, changing nothing.
 */
export interface PreviewPageEditRequest {
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The menu's press.
   */
  messageId: PreviewInputMessageId;
  /**
   * The act.
   */
  edit: PreviewMenuEdit;
}
/**
 * One cookie, in the record the daemon's browser library keeps. `expires` is in seconds since the
 * epoch, `-1` for a cookie that lasts the browsing session. Its value is a secret: it travels
 * only between the daemon and main, and its `Debug` form leaves it out.
 */
export interface PreviewCookie {
  /**
   * The cookie's name.
   */
  name: string;
  /**
   * The cookie's value.
   */
  value: string;
  /**
   * The domain it is sent to.
   */
  domain: string;
  /**
   * The path it is sent under.
   */
  path: string;
  /**
   * When it expires, in seconds since the epoch; `-1` for the browsing session.
   */
  expires: number;
  /**
   * Whether scripts cannot read it.
   */
  httpOnly: boolean;
  /**
   * Whether it is sent over `https:` only.
   */
  secure: boolean;
  /**
   * Where it is sent from another site's page.
   */
  sameSite: PreviewCookieSameSite;
}
/**
 * Reads the Preview cookies of one registrable domain, or of every site where `domain` is absent,
 * as a host takes over from the other.
 */
export interface PreviewPageCookieListRequest {
  /**
   * The site.
   */
  domain?: string;
}
/**
 * Every cookie the read covers.
 */
export interface PreviewPageCookieListResponse {
  /**
   * The cookies.
   */
  cookies: PreviewCookie[];
}
/**
 * Writes cookies into the Preview site data; a cookie with the same name, domain and path is
 * replaced.
 */
export interface PreviewPageCookieUpdateRequest {
  /**
   * The cookies.
   */
  cookies: PreviewCookie[];
}
/**
 * How many of the cookies were written.
 */
export interface PreviewPageCookieUpdateResponse {
  /**
   * The count written.
   */
  written: number;
}
/**
 * Clears one site's cookies across its registrable domain, parent-domain cookies included, and
 * nothing else: its storage, cache and service workers stay.
 */
export interface PreviewPageCookieClearRequest {
  /**
   * The site.
   */
  domain: string;
}
/**
 * Clears every kind of saved data for the named sites, or for every site where `origins` is
 * absent; a present list names at least one site.
 */
export interface PreviewPageSiteDataClearRequest {
  /**
   * The sites' origins.
   *
   * @minItems 1
   */
  origins?: [string, ...string[]];
}
/**
 * The clear finished.
 */
export interface PreviewClearedResponse {
  /**
   * Always `true`.
   */
  cleared: true;
}

// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link PreviewDebuggerSessionId}. */
// prettier-ignore
export const validatePreviewDebuggerSessionId: CompiledSchemaCheck<PreviewDebuggerSessionId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewDebuggerSessionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewDebuggerSessionId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validatePreviewDebuggerSessionId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validatePreviewDebuggerSessionId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validatePreviewDebuggerSessionId.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewDebuggerSessionId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewDebuggerTargetId}. */
// prettier-ignore
export const validatePreviewDebuggerTargetId: CompiledSchemaCheck<PreviewDebuggerTargetId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewDebuggerTargetId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewDebuggerTargetId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validatePreviewDebuggerTargetId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validatePreviewDebuggerTargetId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validatePreviewDebuggerTargetId.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewDebuggerTargetId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewDebuggerError}. */
// prettier-ignore
export const validatePreviewDebuggerError: CompiledSchemaCheck<PreviewDebuggerError> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewDebuggerError {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewDebuggerError.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.code === undefined) && (missing0 = "code")) || ((data.message === undefined) && (missing0 = "message"))){validatePreviewDebuggerError.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "code") || (key0 === "message"))){validatePreviewDebuggerError.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.code !== undefined){let data0: any = data.code;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validatePreviewDebuggerError.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validatePreviewDebuggerError.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < -9007199254740991 || isNaN(data0)){validatePreviewDebuggerError.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.message !== undefined){const _errs4: any = errors;if(typeof data.message !== "string"){validatePreviewDebuggerError.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewDebuggerError.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewDebuggerError.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewDebuggerError.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewDebuggerMessage}. */
// prettier-ignore
export const validatePreviewDebuggerMessage: CompiledSchemaCheck<PreviewDebuggerMessage> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewDebuggerMessage {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewDebuggerMessage.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.id === undefined) && (missing0 = "id")) || ((data.method === undefined) && (missing0 = "method"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((((key0 === "id") || (key0 === "method")) || (key0 === "params")) || (key0 === "sessionId"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs4: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){const err2: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(errors === _errs4){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){const err3: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(data0 < -9007199254740991 || isNaN(data0)){const err4: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.method !== undefined){let data1: any = data.method;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){const err5: any = {instancePath:instancePath+"/method",schemaPath:"#/anyOf/0/properties/method/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}else {const err6: any = {instancePath:instancePath+"/method",schemaPath:"#/anyOf/0/properties/method/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}var valid1: any = _errs6 === errors;}else {var valid1: any = true;}if(valid1){if(data.params !== undefined){let data2: any = data.params;const _errs8: any = errors;if(errors === _errs8){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){for(const key1 in data2){const _errs10: any = errors;const _errs11: any = errors;if(typeof key1 !== "string"){const err7: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/0/properties/params/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}var valid3: any = _errs11 === errors;if(valid3){const _errs13: any = errors;const _errs14: any = errors;const _errs15: any = errors;if("__proto__" !== key1){const err8: any = {};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}var valid4: any = _errs15 === errors;if(valid4){const err9: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/0/properties/params/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}else {errors = _errs14;if(vErrors !== null){if(_errs14){vErrors.length = _errs14;}else {vErrors = null;}}}var valid3: any = _errs13 === errors;}var valid2: any = _errs10 === errors;if(!valid2){const err10: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/0/properties/params/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;break;}}if(valid2){for(const key2 in data2){const _errs17: any = errors;var valid5: any = _errs17 === errors;if(!valid5){break;}}}}else {const err11: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/0/properties/params/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}if(valid1){if(data.sessionId !== undefined){const _errs19: any = errors;if(!(validatePreviewDebuggerSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewDebuggerSessionId.errors : vErrors.concat(validatePreviewDebuggerSessionId.errors);errors = vErrors.length;}var valid1: any = _errs19 === errors;}else {var valid1: any = true;}}}}}}}else {const err12: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs20: any = errors;if(errors === _errs20){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.id === undefined) && (missing1 = "id")) || ((data.result === undefined) && (missing1 = "result"))){const err13: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}else {const _errs22: any = errors;for(const key3 in data){if(!(((key3 === "id") || (key3 === "result")) || (key3 === "sessionId"))){const err14: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;break;}}if(_errs22 === errors){if(data.id !== undefined){let data5: any = data.id;const _errs23: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){const err15: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}if(errors === _errs23){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){const err16: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}else {if(data5 < -9007199254740991 || isNaN(data5)){const err17: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}}}}var valid6: any = _errs23 === errors;}else {var valid6: any = true;}if(valid6){if(data.result !== undefined){let data6: any = data.result;const _errs25: any = errors;if(errors === _errs25){if(data6 && typeof data6 == "object" && !Array.isArray(data6)){for(const key4 in data6){const _errs27: any = errors;const _errs28: any = errors;if(typeof key4 !== "string"){const err18: any = {instancePath:instancePath+"/result",schemaPath:"#/anyOf/1/properties/result/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key4};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}var valid8: any = _errs28 === errors;if(valid8){const _errs30: any = errors;const _errs31: any = errors;const _errs32: any = errors;if("__proto__" !== key4){const err19: any = {};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}var valid9: any = _errs32 === errors;if(valid9){const err20: any = {instancePath:instancePath+"/result",schemaPath:"#/anyOf/1/properties/result/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key4};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}else {errors = _errs31;if(vErrors !== null){if(_errs31){vErrors.length = _errs31;}else {vErrors = null;}}}var valid8: any = _errs30 === errors;}var valid7: any = _errs27 === errors;if(!valid7){const err21: any = {instancePath:instancePath+"/result",schemaPath:"#/anyOf/1/properties/result/propertyNames",keyword:"propertyNames",params:{propertyName: key4}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;break;}}if(valid7){for(const key5 in data6){const _errs34: any = errors;var valid10: any = _errs34 === errors;if(!valid10){break;}}}}else {const err22: any = {instancePath:instancePath+"/result",schemaPath:"#/anyOf/1/properties/result/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}}var valid6: any = _errs25 === errors;}else {var valid6: any = true;}if(valid6){if(data.sessionId !== undefined){const _errs36: any = errors;if(!(validatePreviewDebuggerSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewDebuggerSessionId.errors : vErrors.concat(validatePreviewDebuggerSessionId.errors);errors = vErrors.length;}var valid6: any = _errs36 === errors;}else {var valid6: any = true;}}}}}}else {const err23: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}}var _valid0: any = _errs20 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs37: any = errors;if(errors === _errs37){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.id === undefined) && (missing2 = "id")) || ((data.error === undefined) && (missing2 = "error"))){const err24: any = {instancePath,schemaPath:"#/anyOf/2/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}else {const _errs39: any = errors;for(const key6 in data){if(!(((key6 === "id") || (key6 === "error")) || (key6 === "sessionId"))){const err25: any = {instancePath,schemaPath:"#/anyOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;break;}}if(_errs39 === errors){if(data.id !== undefined){let data9: any = data.id;const _errs40: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){const err26: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}if(errors === _errs40){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){const err27: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}else {if(data9 < -9007199254740991 || isNaN(data9)){const err28: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}}}}var valid11: any = _errs40 === errors;}else {var valid11: any = true;}if(valid11){if(data.error !== undefined){const _errs42: any = errors;if(!(validatePreviewDebuggerError.call(this, data.error, {instancePath:instancePath+"/error",parentData:data,parentDataProperty:"error",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewDebuggerError.errors : vErrors.concat(validatePreviewDebuggerError.errors);errors = vErrors.length;}var valid11: any = _errs42 === errors;}else {var valid11: any = true;}if(valid11){if(data.sessionId !== undefined){const _errs43: any = errors;if(!(validatePreviewDebuggerSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewDebuggerSessionId.errors : vErrors.concat(validatePreviewDebuggerSessionId.errors);errors = vErrors.length;}var valid11: any = _errs43 === errors;}else {var valid11: any = true;}}}}}}else {const err29: any = {instancePath,schemaPath:"#/anyOf/2/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}}var _valid0: any = _errs37 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs44: any = errors;if(errors === _errs44){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((data.method === undefined) && (missing3 = "method")){const err30: any = {instancePath,schemaPath:"#/anyOf/3/required",keyword:"required",params:{missingProperty: missing3}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;}else {const _errs46: any = errors;for(const key7 in data){if(!(((key7 === "method") || (key7 === "params")) || (key7 === "sessionId"))){const err31: any = {instancePath,schemaPath:"#/anyOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;break;}}if(_errs46 === errors){if(data.method !== undefined){let data12: any = data.method;const _errs47: any = errors;if(errors === _errs47){if(typeof data12 === "string"){if(func1(data12) < 1){const err32: any = {instancePath:instancePath+"/method",schemaPath:"#/anyOf/3/properties/method/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;}}else {const err33: any = {instancePath:instancePath+"/method",schemaPath:"#/anyOf/3/properties/method/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;}}var valid12: any = _errs47 === errors;}else {var valid12: any = true;}if(valid12){if(data.params !== undefined){let data13: any = data.params;const _errs49: any = errors;if(errors === _errs49){if(data13 && typeof data13 == "object" && !Array.isArray(data13)){for(const key8 in data13){const _errs51: any = errors;const _errs52: any = errors;if(typeof key8 !== "string"){const err34: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/3/properties/params/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key8};if(vErrors === null){vErrors = [err34];}else {vErrors.push(err34);}errors++;}var valid14: any = _errs52 === errors;if(valid14){const _errs54: any = errors;const _errs55: any = errors;const _errs56: any = errors;if("__proto__" !== key8){const err35: any = {};if(vErrors === null){vErrors = [err35];}else {vErrors.push(err35);}errors++;}var valid15: any = _errs56 === errors;if(valid15){const err36: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/3/properties/params/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key8};if(vErrors === null){vErrors = [err36];}else {vErrors.push(err36);}errors++;}else {errors = _errs55;if(vErrors !== null){if(_errs55){vErrors.length = _errs55;}else {vErrors = null;}}}var valid14: any = _errs54 === errors;}var valid13: any = _errs51 === errors;if(!valid13){const err37: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/3/properties/params/propertyNames",keyword:"propertyNames",params:{propertyName: key8}};if(vErrors === null){vErrors = [err37];}else {vErrors.push(err37);}errors++;break;}}if(valid13){for(const key9 in data13){const _errs58: any = errors;var valid16: any = _errs58 === errors;if(!valid16){break;}}}}else {const err38: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/3/properties/params/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err38];}else {vErrors.push(err38);}errors++;}}var valid12: any = _errs49 === errors;}else {var valid12: any = true;}if(valid12){if(data.sessionId !== undefined){const _errs60: any = errors;if(!(validatePreviewDebuggerSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewDebuggerSessionId.errors : vErrors.concat(validatePreviewDebuggerSessionId.errors);errors = vErrors.length;}var valid12: any = _errs60 === errors;}else {var valid12: any = true;}}}}}}else {const err39: any = {instancePath,schemaPath:"#/anyOf/3/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err39];}else {vErrors.push(err39);}errors++;}}var _valid0: any = _errs44 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err40: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err40];}else {vErrors.push(err40);}errors++;validatePreviewDebuggerMessage.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validatePreviewDebuggerMessage.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validatePreviewDebuggerMessage.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageTargetReportRequest}. */
// prettier-ignore
export const validatePreviewPageTargetReportRequest: CompiledSchemaCheck<PreviewPageTargetReportRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageTargetReportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageTargetReportRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.pageId === undefined) && (missing0 = "pageId")) || ((data.targetId === undefined) && (missing0 = "targetId"))){validatePreviewPageTargetReportRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "pageId") || (key0 === "targetId"))){validatePreviewPageTargetReportRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){const _errs2: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.targetId !== undefined){const _errs3: any = errors;if(!(validatePreviewDebuggerTargetId.call(this, data.targetId, {instancePath:instancePath+"/targetId",parentData:data,parentDataProperty:"targetId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewDebuggerTargetId.errors : vErrors.concat(validatePreviewDebuggerTargetId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewPageTargetReportRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageTargetReportRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageTargetReportRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageDebuggerMessageRequest}. */
// prettier-ignore
export const validatePreviewPageDebuggerMessageRequest: CompiledSchemaCheck<PreviewPageDebuggerMessageRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageDebuggerMessageRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageDebuggerMessageRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.pageId === undefined) && (missing0 = "pageId")) || ((data.message === undefined) && (missing0 = "message"))){validatePreviewPageDebuggerMessageRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "pageId") || (key0 === "message"))){validatePreviewPageDebuggerMessageRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){const _errs2: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.message !== undefined){const _errs3: any = errors;if(!(validatePreviewDebuggerMessage.call(this, data.message, {instancePath:instancePath+"/message",parentData:data,parentDataProperty:"message",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewDebuggerMessage.errors : vErrors.concat(validatePreviewDebuggerMessage.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewPageDebuggerMessageRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageDebuggerMessageRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageDebuggerMessageRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewReceivedResponse}. */
// prettier-ignore
export const validatePreviewReceivedResponse: CompiledSchemaCheck<PreviewReceivedResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewReceivedResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewReceivedResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.received === undefined) && (missing0 = "received")){validatePreviewReceivedResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "received")){validatePreviewReceivedResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.received !== undefined){let data0: any = data.received;if(typeof data0 !== "boolean"){validatePreviewReceivedResponse.errors = [{instancePath:instancePath+"/received",schemaPath:"#/properties/received/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validatePreviewReceivedResponse.errors = [{instancePath:instancePath+"/received",schemaPath:"#/properties/received/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validatePreviewReceivedResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewReceivedResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewReceivedResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageMenu}. */
// prettier-ignore
export const validatePreviewPageMenu: CompiledSchemaCheck<PreviewPageMenu> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageMenu {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageMenu.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.point === undefined) && (missing0 = "point")) || ((data.frameAddress === undefined) && (missing0 = "frameAddress"))) || ((data.isEditable === undefined) && (missing0 = "isEditable"))) || ((data.canCut === undefined) && (missing0 = "canCut"))) || ((data.canCopy === undefined) && (missing0 = "canCopy"))) || ((data.canSelectAll === undefined) && (missing0 = "canSelectAll"))){validatePreviewPageMenu.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "point") || (key0 === "frameAddress")) || (key0 === "linkUrl")) || (key0 === "isEditable")) || (key0 === "canCut")) || (key0 === "canCopy")) || (key0 === "canSelectAll")) || (key0 === "selectionText"))){validatePreviewPageMenu.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.point !== undefined){const _errs2: any = errors;if(!(validatePreviewPoint.call(this, data.point, {instancePath:instancePath+"/point",parentData:data,parentDataProperty:"point",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPoint.errors : vErrors.concat(validatePreviewPoint.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.frameAddress !== undefined){let data1: any = data.frameAddress;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 2097152){validatePreviewPageMenu.errors = [{instancePath:instancePath+"/frameAddress",schemaPath:"#/properties/frameAddress/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data1) < 1){validatePreviewPageMenu.errors = [{instancePath:instancePath+"/frameAddress",schemaPath:"#/properties/frameAddress/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewPageMenu.errors = [{instancePath:instancePath+"/frameAddress",schemaPath:"#/properties/frameAddress/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.linkUrl !== undefined){let data2: any = data.linkUrl;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 2097152){validatePreviewPageMenu.errors = [{instancePath:instancePath+"/linkUrl",schemaPath:"#/properties/linkUrl/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data2) < 1){validatePreviewPageMenu.errors = [{instancePath:instancePath+"/linkUrl",schemaPath:"#/properties/linkUrl/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewPageMenu.errors = [{instancePath:instancePath+"/linkUrl",schemaPath:"#/properties/linkUrl/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.isEditable !== undefined){const _errs7: any = errors;if(typeof data.isEditable !== "boolean"){validatePreviewPageMenu.errors = [{instancePath:instancePath+"/isEditable",schemaPath:"#/properties/isEditable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.canCut !== undefined){const _errs9: any = errors;if(typeof data.canCut !== "boolean"){validatePreviewPageMenu.errors = [{instancePath:instancePath+"/canCut",schemaPath:"#/properties/canCut/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.canCopy !== undefined){const _errs11: any = errors;if(typeof data.canCopy !== "boolean"){validatePreviewPageMenu.errors = [{instancePath:instancePath+"/canCopy",schemaPath:"#/properties/canCopy/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.canSelectAll !== undefined){const _errs13: any = errors;if(typeof data.canSelectAll !== "boolean"){validatePreviewPageMenu.errors = [{instancePath:instancePath+"/canSelectAll",schemaPath:"#/properties/canSelectAll/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.selectionText !== undefined){const _errs15: any = errors;if(typeof data.selectionText !== "string"){validatePreviewPageMenu.errors = [{instancePath:instancePath+"/selectionText",schemaPath:"#/properties/selectionText/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validatePreviewPageMenu.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageMenu.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageMenu.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageMenuReportRequest}. */
// prettier-ignore
export const validatePreviewPageMenuReportRequest: CompiledSchemaCheck<PreviewPageMenuReportRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageMenuReportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageMenuReportRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.pageId === undefined) && (missing0 = "pageId")) || ((data.messageId === undefined) && (missing0 = "messageId"))) || ((data.menu === undefined) && (missing0 = "menu"))){validatePreviewPageMenuReportRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "pageId") || (key0 === "messageId")) || (key0 === "menu"))){validatePreviewPageMenuReportRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){const _errs2: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.messageId !== undefined){const _errs3: any = errors;if(!(validatePreviewInputMessageId.call(this, data.messageId, {instancePath:instancePath+"/messageId",parentData:data,parentDataProperty:"messageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewInputMessageId.errors : vErrors.concat(validatePreviewInputMessageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.menu !== undefined){const _errs4: any = errors;if(!(validatePreviewPageMenu.call(this, data.menu, {instancePath:instancePath+"/menu",parentData:data,parentDataProperty:"menu",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageMenu.errors : vErrors.concat(validatePreviewPageMenu.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validatePreviewPageMenuReportRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageMenuReportRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageMenuReportRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link PreviewPageStagingFolderReadResponse}. */
// prettier-ignore
export const validatePreviewPageStagingFolderReadResponse: CompiledSchemaCheck<PreviewPageStagingFolderReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageStagingFolderReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageStagingFolderReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.folder === undefined) && (missing0 = "folder")){validatePreviewPageStagingFolderReadResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "folder")){validatePreviewPageStagingFolderReadResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.folder !== undefined){let data0: any = data.folder;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validatePreviewPageStagingFolderReadResponse.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validatePreviewPageStagingFolderReadResponse.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data0)){validatePreviewPageStagingFolderReadResponse.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validatePreviewPageStagingFolderReadResponse.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validatePreviewPageStagingFolderReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageStagingFolderReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageStagingFolderReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageLocalInputReportRequest}. */
// prettier-ignore
export const validatePreviewPageLocalInputReportRequest: CompiledSchemaCheck<PreviewPageLocalInputReportRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageLocalInputReportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageLocalInputReportRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.pageId === undefined) && (missing0 = "pageId")){validatePreviewPageLocalInputReportRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "pageId")){validatePreviewPageLocalInputReportRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}}}}}else {validatePreviewPageLocalInputReportRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageLocalInputReportRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageLocalInputReportRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewStagedFileId}. */
// prettier-ignore
export const validatePreviewStagedFileId: CompiledSchemaCheck<PreviewStagedFileId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewStagedFileId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewStagedFileId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validatePreviewStagedFileId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validatePreviewStagedFileId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewStagedFileId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validatePreviewStagedFileId.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewStagedFileId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema882: any = {"description":"The state a relayed download ended in, as Electron's download item reports it when done.","type":"string","enum":["completed","cancelled","interrupted"]};
/** Checks that a value is a {@link PreviewDownloadState}. */
// prettier-ignore
export const validatePreviewDownloadState: CompiledSchemaCheck<PreviewDownloadState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewDownloadState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewDownloadState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePreviewDownloadState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "completed") || (data === "cancelled")) || (data === "interrupted"))){validatePreviewDownloadState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema882.enum}}];return false;}validatePreviewDownloadState.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewDownloadState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageDownloadReportRequest}. */
// prettier-ignore
export const validatePreviewPageDownloadReportRequest: CompiledSchemaCheck<PreviewPageDownloadReportRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageDownloadReportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageDownloadReportRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.pageId === undefined) && (missing0 = "pageId")) || ((data.messageId === undefined) && (missing0 = "messageId"))) || ((data.fileId === undefined) && (missing0 = "fileId"))) || ((data.fileName === undefined) && (missing0 = "fileName"))) || ((data.state === undefined) && (missing0 = "state"))){validatePreviewPageDownloadReportRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "pageId") || (key0 === "messageId")) || (key0 === "fileId")) || (key0 === "fileName")) || (key0 === "state"))){validatePreviewPageDownloadReportRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){const _errs2: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.messageId !== undefined){const _errs3: any = errors;if(!(validatePreviewInputMessageId.call(this, data.messageId, {instancePath:instancePath+"/messageId",parentData:data,parentDataProperty:"messageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewInputMessageId.errors : vErrors.concat(validatePreviewInputMessageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.fileId !== undefined){const _errs4: any = errors;if(!(validatePreviewStagedFileId.call(this, data.fileId, {instancePath:instancePath+"/fileId",parentData:data,parentDataProperty:"fileId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewStagedFileId.errors : vErrors.concat(validatePreviewStagedFileId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.fileName !== undefined){let data3: any = data.fileName;const _errs5: any = errors;if(errors === _errs5){if(typeof data3 === "string"){if(func1(data3) > 4096){validatePreviewPageDownloadReportRequest.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validatePreviewPageDownloadReportRequest.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewPageDownloadReportRequest.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs7: any = errors;if(!(validatePreviewDownloadState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewDownloadState.errors : vErrors.concat(validatePreviewDownloadState.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}}else {validatePreviewPageDownloadReportRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageDownloadReportRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageDownloadReportRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema884: any = {"description":"What the daemon did with a reported download.","type":"string","enum":["accepted","refused"]};
/** Checks that a value is a {@link PreviewDownloadVerdict}. */
// prettier-ignore
export const validatePreviewDownloadVerdict: CompiledSchemaCheck<PreviewDownloadVerdict> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewDownloadVerdict {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewDownloadVerdict.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePreviewDownloadVerdict.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "accepted") || (data === "refused"))){validatePreviewDownloadVerdict.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema884.enum}}];return false;}validatePreviewDownloadVerdict.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewDownloadVerdict.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageDownloadReportResponse}. */
// prettier-ignore
export const validatePreviewPageDownloadReportResponse: CompiledSchemaCheck<PreviewPageDownloadReportResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageDownloadReportResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageDownloadReportResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.verdict === undefined) && (missing0 = "verdict")){validatePreviewPageDownloadReportResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "verdict")){validatePreviewPageDownloadReportResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.verdict !== undefined){if(!(validatePreviewDownloadVerdict.call(this, data.verdict, {instancePath:instancePath+"/verdict",parentData:data,parentDataProperty:"verdict",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewDownloadVerdict.errors : vErrors.concat(validatePreviewDownloadVerdict.errors);errors = vErrors.length;}}}}}else {validatePreviewPageDownloadReportResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageDownloadReportResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageDownloadReportResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewSaveReadRequest}. */
// prettier-ignore
export const validatePreviewSaveReadRequest: CompiledSchemaCheck<PreviewSaveReadRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewSaveReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewSaveReadRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.saveId === undefined) && (missing0 = "saveId")) || ((data.offset === undefined) && (missing0 = "offset"))){validatePreviewSaveReadRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "saveId") || (key0 === "offset"))){validatePreviewSaveReadRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.saveId !== undefined){const _errs2: any = errors;if(!(validatePreviewSaveId.call(this, data.saveId, {instancePath:instancePath+"/saveId",parentData:data,parentDataProperty:"saveId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewSaveId.errors : vErrors.concat(validatePreviewSaveId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.offset !== undefined){let data1: any = data.offset;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validatePreviewSaveReadRequest.errors = [{instancePath:instancePath+"/offset",schemaPath:"#/properties/offset/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validatePreviewSaveReadRequest.errors = [{instancePath:instancePath+"/offset",schemaPath:"#/properties/offset/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validatePreviewSaveReadRequest.errors = [{instancePath:instancePath+"/offset",schemaPath:"#/properties/offset/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewSaveReadRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewSaveReadRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewSaveReadRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewSaveReadResponse}. */
// prettier-ignore
export const validatePreviewSaveReadResponse: CompiledSchemaCheck<PreviewSaveReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewSaveReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewSaveReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.part === undefined) && (missing0 = "part")) || ((data.isLastPart === undefined) && (missing0 = "isLastPart"))){validatePreviewSaveReadResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "part") || (key0 === "isLastPart"))){validatePreviewSaveReadResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.part !== undefined){let data0: any = data.part;const _errs2: any = errors;if(!(validateBytes.call(this, data0, {instancePath:instancePath+"/part",parentData:data,parentDataProperty:"part",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBytes.errors : vErrors.concat(validateBytes.errors);errors = vErrors.length;}else {if(!(data0 && typeof data0 == "object" && Number.isInteger(data0.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data0.$bytes] instanceof Uint8Array && this.attachments[data0.$bytes].byteLength <= 262144)){validatePreviewSaveReadResponse.errors = [{instancePath:instancePath+"/part",schemaPath:"#/properties/part/maxBytes",keyword:"maxBytes",params:{}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.isLastPart !== undefined){const _errs4: any = errors;if(typeof data.isLastPart !== "boolean"){validatePreviewSaveReadResponse.errors = [{instancePath:instancePath+"/isLastPart",schemaPath:"#/properties/isLastPart/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewSaveReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewSaveReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewSaveReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageEditRequest}. */
// prettier-ignore
export const validatePreviewPageEditRequest: CompiledSchemaCheck<PreviewPageEditRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageEditRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageEditRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.pageId === undefined) && (missing0 = "pageId")) || ((data.messageId === undefined) && (missing0 = "messageId"))) || ((data.edit === undefined) && (missing0 = "edit"))){validatePreviewPageEditRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "pageId") || (key0 === "messageId")) || (key0 === "edit"))){validatePreviewPageEditRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){const _errs2: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.messageId !== undefined){const _errs3: any = errors;if(!(validatePreviewInputMessageId.call(this, data.messageId, {instancePath:instancePath+"/messageId",parentData:data,parentDataProperty:"messageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewInputMessageId.errors : vErrors.concat(validatePreviewInputMessageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.edit !== undefined){const _errs4: any = errors;if(!(validatePreviewMenuEdit.call(this, data.edit, {instancePath:instancePath+"/edit",parentData:data,parentDataProperty:"edit",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewMenuEdit.errors : vErrors.concat(validatePreviewMenuEdit.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validatePreviewPageEditRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageEditRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageEditRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema873: any = {"description":"Where a cookie is sent from another site's page.","type":"string","enum":["Strict","Lax","None"]};
/** Checks that a value is a {@link PreviewCookieSameSite}. */
// prettier-ignore
export const validatePreviewCookieSameSite: CompiledSchemaCheck<PreviewCookieSameSite> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewCookieSameSite {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewCookieSameSite.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePreviewCookieSameSite.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "Strict") || (data === "Lax")) || (data === "None"))){validatePreviewCookieSameSite.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema873.enum}}];return false;}validatePreviewCookieSameSite.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewCookieSameSite.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewCookie}. */
// prettier-ignore
export const validatePreviewCookie: CompiledSchemaCheck<PreviewCookie> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewCookie {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewCookie.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.name === undefined) && (missing0 = "name")) || ((data.value === undefined) && (missing0 = "value"))) || ((data.domain === undefined) && (missing0 = "domain"))) || ((data.path === undefined) && (missing0 = "path"))) || ((data.expires === undefined) && (missing0 = "expires"))) || ((data.httpOnly === undefined) && (missing0 = "httpOnly"))) || ((data.secure === undefined) && (missing0 = "secure"))) || ((data.sameSite === undefined) && (missing0 = "sameSite"))){validatePreviewCookie.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "name") || (key0 === "value")) || (key0 === "domain")) || (key0 === "path")) || (key0 === "expires")) || (key0 === "httpOnly")) || (key0 === "secure")) || (key0 === "sameSite"))){validatePreviewCookie.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.name !== undefined){const _errs2: any = errors;if(typeof data.name !== "string"){validatePreviewCookie.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.value !== undefined){const _errs4: any = errors;if(typeof data.value !== "string"){validatePreviewCookie.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.domain !== undefined){let data2: any = data.domain;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) < 1){validatePreviewCookie.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validatePreviewCookie.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data3: any = data.path;const _errs8: any = errors;if(errors === _errs8){if(typeof data3 === "string"){if(func1(data3) > 4096){validatePreviewCookie.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validatePreviewCookie.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewCookie.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.expires !== undefined){let data4: any = data.expires;const _errs10: any = errors;if(!((typeof data4 == "number") && (isFinite(data4)))){validatePreviewCookie.errors = [{instancePath:instancePath+"/expires",schemaPath:"#/properties/expires/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.httpOnly !== undefined){const _errs12: any = errors;if(typeof data.httpOnly !== "boolean"){validatePreviewCookie.errors = [{instancePath:instancePath+"/httpOnly",schemaPath:"#/properties/httpOnly/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.secure !== undefined){const _errs14: any = errors;if(typeof data.secure !== "boolean"){validatePreviewCookie.errors = [{instancePath:instancePath+"/secure",schemaPath:"#/properties/secure/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.sameSite !== undefined){const _errs16: any = errors;if(!(validatePreviewCookieSameSite.call(this, data.sameSite, {instancePath:instancePath+"/sameSite",parentData:data,parentDataProperty:"sameSite",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewCookieSameSite.errors : vErrors.concat(validatePreviewCookieSameSite.errors);errors = vErrors.length;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validatePreviewCookie.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewCookie.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewCookie.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageCookieListRequest}. */
// prettier-ignore
export const validatePreviewPageCookieListRequest: CompiledSchemaCheck<PreviewPageCookieListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageCookieListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageCookieListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!(key0 === "domain")){validatePreviewPageCookieListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.domain !== undefined){let data0: any = data.domain;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 253){validatePreviewPageCookieListRequest.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/maxLength",keyword:"maxLength",params:{limit: 253}}];return false;}else {if(func1(data0) < 1){validatePreviewPageCookieListRequest.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewPageCookieListRequest.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/type",keyword:"type",params:{type: "string"}}];return false;}}}}}else {validatePreviewPageCookieListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageCookieListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageCookieListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageCookieListResponse}. */
// prettier-ignore
export const validatePreviewPageCookieListResponse: CompiledSchemaCheck<PreviewPageCookieListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageCookieListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageCookieListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cookies === undefined) && (missing0 = "cookies")){validatePreviewPageCookieListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cookies")){validatePreviewPageCookieListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cookies !== undefined){let data0: any = data.cookies;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validatePreviewCookie.call(this, data0[i0], {instancePath:instancePath+"/cookies/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewCookie.errors : vErrors.concat(validatePreviewCookie.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validatePreviewPageCookieListResponse.errors = [{instancePath:instancePath+"/cookies",schemaPath:"#/properties/cookies/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validatePreviewPageCookieListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageCookieListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageCookieListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageCookieUpdateRequest}. */
// prettier-ignore
export const validatePreviewPageCookieUpdateRequest: CompiledSchemaCheck<PreviewPageCookieUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageCookieUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageCookieUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cookies === undefined) && (missing0 = "cookies")){validatePreviewPageCookieUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cookies")){validatePreviewPageCookieUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cookies !== undefined){let data0: any = data.cookies;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validatePreviewCookie.call(this, data0[i0], {instancePath:instancePath+"/cookies/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewCookie.errors : vErrors.concat(validatePreviewCookie.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validatePreviewPageCookieUpdateRequest.errors = [{instancePath:instancePath+"/cookies",schemaPath:"#/properties/cookies/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validatePreviewPageCookieUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageCookieUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageCookieUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageCookieUpdateResponse}. */
// prettier-ignore
export const validatePreviewPageCookieUpdateResponse: CompiledSchemaCheck<PreviewPageCookieUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageCookieUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageCookieUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.written === undefined) && (missing0 = "written")){validatePreviewPageCookieUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "written")){validatePreviewPageCookieUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.written !== undefined){let data0: any = data.written;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validatePreviewPageCookieUpdateResponse.errors = [{instancePath:instancePath+"/written",schemaPath:"#/properties/written/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validatePreviewPageCookieUpdateResponse.errors = [{instancePath:instancePath+"/written",schemaPath:"#/properties/written/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validatePreviewPageCookieUpdateResponse.errors = [{instancePath:instancePath+"/written",schemaPath:"#/properties/written/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validatePreviewPageCookieUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageCookieUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageCookieUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageCookieClearRequest}. */
// prettier-ignore
export const validatePreviewPageCookieClearRequest: CompiledSchemaCheck<PreviewPageCookieClearRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageCookieClearRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageCookieClearRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.domain === undefined) && (missing0 = "domain")){validatePreviewPageCookieClearRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "domain")){validatePreviewPageCookieClearRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.domain !== undefined){let data0: any = data.domain;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 253){validatePreviewPageCookieClearRequest.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/maxLength",keyword:"maxLength",params:{limit: 253}}];return false;}else {if(func1(data0) < 1){validatePreviewPageCookieClearRequest.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewPageCookieClearRequest.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validatePreviewPageCookieClearRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageCookieClearRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageCookieClearRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageSiteDataClearRequest}. */
// prettier-ignore
export const validatePreviewPageSiteDataClearRequest: CompiledSchemaCheck<PreviewPageSiteDataClearRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageSiteDataClearRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageSiteDataClearRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!(key0 === "origins")){validatePreviewPageSiteDataClearRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.origins !== undefined){let data0: any = data.origins;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validatePreviewPageSiteDataClearRequest.errors = [{instancePath:instancePath+"/origins",schemaPath:"#/properties/origins/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 2097152){validatePreviewPageSiteDataClearRequest.errors = [{instancePath:instancePath+"/origins/" + i0,schemaPath:"#/properties/origins/items/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data1) < 1){validatePreviewPageSiteDataClearRequest.errors = [{instancePath:instancePath+"/origins/" + i0,schemaPath:"#/properties/origins/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewPageSiteDataClearRequest.errors = [{instancePath:instancePath+"/origins/" + i0,schemaPath:"#/properties/origins/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validatePreviewPageSiteDataClearRequest.errors = [{instancePath:instancePath+"/origins",schemaPath:"#/properties/origins/type",keyword:"type",params:{type: "array"}}];return false;}}}}}else {validatePreviewPageSiteDataClearRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageSiteDataClearRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageSiteDataClearRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewClearedResponse}. */
// prettier-ignore
export const validatePreviewClearedResponse: CompiledSchemaCheck<PreviewClearedResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewClearedResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewClearedResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cleared === undefined) && (missing0 = "cleared")){validatePreviewClearedResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cleared")){validatePreviewClearedResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cleared !== undefined){let data0: any = data.cleared;if(typeof data0 !== "boolean"){validatePreviewClearedResponse.errors = [{instancePath:instancePath+"/cleared",schemaPath:"#/properties/cleared/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validatePreviewClearedResponse.errors = [{instancePath:instancePath+"/cleared",schemaPath:"#/properties/cleared/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validatePreviewClearedResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewClearedResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewClearedResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link PREVIEW_PAGE_LINK_METHOD_DESCRIPTORS}, each with its checks. */
export interface PreviewPageLinkMethodDescriptors {
  readonly "preview.page.target.report": {
    readonly method: "preview.page.target.report";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageTargetReportRequest>;
    readonly responseCheck: SchemaCheck<PreviewReceivedResponse>;
  };
  readonly "preview.page.debugger.report": {
    readonly method: "preview.page.debugger.report";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageDebuggerMessageRequest>;
    readonly responseCheck: SchemaCheck<PreviewReceivedResponse>;
  };
  readonly "preview.page.menu.report": {
    readonly method: "preview.page.menu.report";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageMenuReportRequest>;
    readonly responseCheck: SchemaCheck<PreviewReceivedResponse>;
  };
  readonly "preview.page.stagingFolder.read": {
    readonly method: "preview.page.stagingFolder.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<PreviewPageStagingFolderReadResponse>;
  };
  readonly "preview.page.localInput.report": {
    readonly method: "preview.page.localInput.report";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageLocalInputReportRequest>;
    readonly responseCheck: SchemaCheck<PreviewReceivedResponse>;
  };
  readonly "preview.page.download.report": {
    readonly method: "preview.page.download.report";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageDownloadReportRequest>;
    readonly responseCheck: SchemaCheck<PreviewPageDownloadReportResponse>;
  };
  readonly "preview.save.read": {
    readonly method: "preview.save.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<PreviewSaveReadRequest>;
    readonly responseCheck: SchemaCheck<PreviewSaveReadResponse>;
  };
}
/** The `preview.*` link methods the daemon answers; main is their only caller. */
export const PREVIEW_PAGE_LINK_METHOD_DESCRIPTORS: PreviewPageLinkMethodDescriptors = Object.freeze(
  {
    "preview.page.target.report": Object.freeze({
      method: "preview.page.target.report",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validatePreviewPageTargetReportRequest,
      responseCheck: validatePreviewReceivedResponse,
    }),
    "preview.page.debugger.report": Object.freeze({
      method: "preview.page.debugger.report",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validatePreviewPageDebuggerMessageRequest,
      responseCheck: validatePreviewReceivedResponse,
    }),
    "preview.page.menu.report": Object.freeze({
      method: "preview.page.menu.report",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validatePreviewPageMenuReportRequest,
      responseCheck: validatePreviewReceivedResponse,
    }),
    "preview.page.stagingFolder.read": Object.freeze({
      method: "preview.page.stagingFolder.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validatePreviewPageStagingFolderReadResponse,
    }),
    "preview.page.localInput.report": Object.freeze({
      method: "preview.page.localInput.report",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validatePreviewPageLocalInputReportRequest,
      responseCheck: validatePreviewReceivedResponse,
    }),
    "preview.page.download.report": Object.freeze({
      method: "preview.page.download.report",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validatePreviewPageDownloadReportRequest,
      responseCheck: validatePreviewPageDownloadReportResponse,
    }),
    "preview.save.read": Object.freeze({
      method: "preview.save.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validatePreviewSaveReadRequest,
      responseCheck: validatePreviewSaveReadResponse,
    }),
  },
);

/** The methods of {@link PREVIEW_PAGE_HOST_METHOD_DESCRIPTORS}, each with its checks. */
export interface PreviewPageHostMethodDescriptors {
  readonly "preview.page.debugger.send": {
    readonly method: "preview.page.debugger.send";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageDebuggerMessageRequest>;
    readonly responseCheck: SchemaCheck<PreviewReceivedResponse>;
  };
  readonly "preview.page.edit": {
    readonly method: "preview.page.edit";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageEditRequest>;
    readonly responseCheck: SchemaCheck<PreviewMenuEditResponse>;
  };
  readonly "preview.page.cookie.list": {
    readonly method: "preview.page.cookie.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<PreviewPageCookieListRequest>;
    readonly responseCheck: SchemaCheck<PreviewPageCookieListResponse>;
  };
  readonly "preview.page.cookie.update": {
    readonly method: "preview.page.cookie.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageCookieUpdateRequest>;
    readonly responseCheck: SchemaCheck<PreviewPageCookieUpdateResponse>;
  };
  readonly "preview.page.cookie.clear": {
    readonly method: "preview.page.cookie.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageCookieClearRequest>;
    readonly responseCheck: SchemaCheck<PreviewClearedResponse>;
  };
  readonly "preview.page.siteData.clear": {
    readonly method: "preview.page.siteData.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageSiteDataClearRequest>;
    readonly responseCheck: SchemaCheck<PreviewClearedResponse>;
  };
}
/**
 * The `preview.*` methods main's page host answers. The daemon is their only caller, over the
 * connection the app dials, so they never join the daemon's own method map.
 */
export const PREVIEW_PAGE_HOST_METHOD_DESCRIPTORS: PreviewPageHostMethodDescriptors = Object.freeze(
  {
    "preview.page.debugger.send": Object.freeze({
      method: "preview.page.debugger.send",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validatePreviewPageDebuggerMessageRequest,
      responseCheck: validatePreviewReceivedResponse,
    }),
    "preview.page.edit": Object.freeze({
      method: "preview.page.edit",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validatePreviewPageEditRequest,
      responseCheck: validatePreviewMenuEditResponse,
    }),
    "preview.page.cookie.list": Object.freeze({
      method: "preview.page.cookie.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validatePreviewPageCookieListRequest,
      responseCheck: validatePreviewPageCookieListResponse,
    }),
    "preview.page.cookie.update": Object.freeze({
      method: "preview.page.cookie.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validatePreviewPageCookieUpdateRequest,
      responseCheck: validatePreviewPageCookieUpdateResponse,
    }),
    "preview.page.cookie.clear": Object.freeze({
      method: "preview.page.cookie.clear",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validatePreviewPageCookieClearRequest,
      responseCheck: validatePreviewClearedResponse,
    }),
    "preview.page.siteData.clear": Object.freeze({
      method: "preview.page.siteData.clear",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validatePreviewPageSiteDataClearRequest,
      responseCheck: validatePreviewClearedResponse,
    }),
  },
);
