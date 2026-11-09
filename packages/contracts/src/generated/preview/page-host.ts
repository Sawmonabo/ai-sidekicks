// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The Preview page host's link between the daemon and the desktop's main process: debug targets, debugger traffic, menus, input at the machine, downloads, staged files, menu acts, cookies and site data.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import {
  type PreviewInputMessageId,
  type PreviewMenuEdit,
  type PreviewMenuEditResponse,
  type PreviewPageId,
  type PreviewPoint,
  type PreviewSaveId,
  validatePreviewMenuEditResponse,
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
function validate1351(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewClearedResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1351.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cleared === undefined) && (missing0 = "cleared")){validate1351.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cleared")){validate1351.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cleared !== undefined){let data0: any = data.cleared;if(typeof data0 !== "boolean"){validate1351.errors = [{instancePath:instancePath+"/cleared",schemaPath:"#/properties/cleared/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validate1351.errors = [{instancePath:instancePath+"/cleared",schemaPath:"#/properties/cleared/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validate1351.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1351.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1351.errors = null as any[] | null;
// prettier-ignore
validate1351.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1352(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageCookieClearRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1352.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.domain === undefined) && (missing0 = "domain")){validate1352.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "domain")){validate1352.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.domain !== undefined){let data0: any = data.domain;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 253){validate1352.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/maxLength",keyword:"maxLength",params:{limit: 253}}];return false;}else {if(func1(data0) < 1){validate1352.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1352.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1352.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1352.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1352.errors = null as any[] | null;
// prettier-ignore
validate1352.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1353(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageCookieListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1353.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!(key0 === "domain")){validate1353.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.domain !== undefined){let data0: any = data.domain;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 253){validate1353.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/maxLength",keyword:"maxLength",params:{limit: 253}}];return false;}else {if(func1(data0) < 1){validate1353.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1353.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/type",keyword:"type",params:{type: "string"}}];return false;}}}}}else {validate1353.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1353.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1353.errors = null as any[] | null;
// prettier-ignore
validate1353.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2543: any = {"description":"Where a cookie is sent from another site's page.","type":"string","enum":["Strict","Lax","None"]};
// prettier-ignore
function validate1355(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1355.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.name === undefined) && (missing0 = "name")) || ((data.value === undefined) && (missing0 = "value"))) || ((data.domain === undefined) && (missing0 = "domain"))) || ((data.path === undefined) && (missing0 = "path"))) || ((data.expires === undefined) && (missing0 = "expires"))) || ((data.httpOnly === undefined) && (missing0 = "httpOnly"))) || ((data.secure === undefined) && (missing0 = "secure"))) || ((data.sameSite === undefined) && (missing0 = "sameSite"))){validate1355.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "name") || (key0 === "value")) || (key0 === "domain")) || (key0 === "path")) || (key0 === "expires")) || (key0 === "httpOnly")) || (key0 === "secure")) || (key0 === "sameSite"))){validate1355.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.name !== undefined){const _errs2: any = errors;if(typeof data.name !== "string"){validate1355.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.value !== undefined){const _errs4: any = errors;if(typeof data.value !== "string"){validate1355.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.domain !== undefined){let data2: any = data.domain;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) < 1){validate1355.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1355.errors = [{instancePath:instancePath+"/domain",schemaPath:"#/properties/domain/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data3: any = data.path;const _errs8: any = errors;if(errors === _errs8){if(typeof data3 === "string"){if(func1(data3) > 4096){validate1355.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validate1355.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1355.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.expires !== undefined){let data4: any = data.expires;const _errs10: any = errors;if(!((typeof data4 == "number") && (isFinite(data4)))){validate1355.errors = [{instancePath:instancePath+"/expires",schemaPath:"#/properties/expires/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.httpOnly !== undefined){const _errs12: any = errors;if(typeof data.httpOnly !== "boolean"){validate1355.errors = [{instancePath:instancePath+"/httpOnly",schemaPath:"#/properties/httpOnly/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.secure !== undefined){const _errs14: any = errors;if(typeof data.secure !== "boolean"){validate1355.errors = [{instancePath:instancePath+"/secure",schemaPath:"#/properties/secure/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.sameSite !== undefined){let data7: any = data.sameSite;const _errs16: any = errors;if(typeof data7 !== "string"){validate1355.errors = [{instancePath:instancePath+"/sameSite",schemaPath:"#/$defs/PreviewCookieSameSite/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data7 === "Strict") || (data7 === "Lax")) || (data7 === "None"))){validate1355.errors = [{instancePath:instancePath+"/sameSite",schemaPath:"#/$defs/PreviewCookieSameSite/enum",keyword:"enum",params:{allowedValues: schema2543.enum}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validate1355.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1355.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1355.errors = null as any[] | null;
// prettier-ignore
validate1355.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1354(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageCookieListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1354.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cookies === undefined) && (missing0 = "cookies")){validate1354.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cookies")){validate1354.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cookies !== undefined){let data0: any = data.cookies;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate1355.call(this, data0[i0], {instancePath:instancePath+"/cookies/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1355.errors : vErrors.concat(validate1355.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1354.errors = [{instancePath:instancePath+"/cookies",schemaPath:"#/properties/cookies/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate1354.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1354.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1354.errors = null as any[] | null;
// prettier-ignore
validate1354.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1357(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageCookieUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1357.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cookies === undefined) && (missing0 = "cookies")){validate1357.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cookies")){validate1357.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cookies !== undefined){let data0: any = data.cookies;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate1355.call(this, data0[i0], {instancePath:instancePath+"/cookies/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1355.errors : vErrors.concat(validate1355.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1357.errors = [{instancePath:instancePath+"/cookies",schemaPath:"#/properties/cookies/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate1357.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1357.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1357.errors = null as any[] | null;
// prettier-ignore
validate1357.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1359(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageCookieUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1359.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.written === undefined) && (missing0 = "written")){validate1359.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "written")){validate1359.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.written !== undefined){let data0: any = data.written;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate1359.errors = [{instancePath:instancePath+"/written",schemaPath:"#/properties/written/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate1359.errors = [{instancePath:instancePath+"/written",schemaPath:"#/properties/written/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validate1359.errors = [{instancePath:instancePath+"/written",schemaPath:"#/properties/written/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate1359.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1359.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1359.errors = null as any[] | null;
// prettier-ignore
validate1359.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1361(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1361.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.id === undefined) && (missing0 = "id")) || ((data.method === undefined) && (missing0 = "method"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((((key0 === "id") || (key0 === "method")) || (key0 === "params")) || (key0 === "sessionId"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs4: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){const err2: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(errors === _errs4){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){const err3: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(data0 < -9007199254740991 || isNaN(data0)){const err4: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.method !== undefined){let data1: any = data.method;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){const err5: any = {instancePath:instancePath+"/method",schemaPath:"#/anyOf/0/properties/method/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}else {const err6: any = {instancePath:instancePath+"/method",schemaPath:"#/anyOf/0/properties/method/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}var valid1: any = _errs6 === errors;}else {var valid1: any = true;}if(valid1){if(data.params !== undefined){let data2: any = data.params;const _errs8: any = errors;if(errors === _errs8){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){for(const key1 in data2){const _errs10: any = errors;const _errs11: any = errors;if(typeof key1 !== "string"){const err7: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/0/properties/params/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}var valid3: any = _errs11 === errors;if(valid3){const _errs13: any = errors;const _errs14: any = errors;const _errs15: any = errors;if("__proto__" !== key1){const err8: any = {};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}var valid4: any = _errs15 === errors;if(valid4){const err9: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/0/properties/params/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}else {errors = _errs14;if(vErrors !== null){if(_errs14){vErrors.length = _errs14;}else {vErrors = null;}}}var valid3: any = _errs13 === errors;}var valid2: any = _errs10 === errors;if(!valid2){const err10: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/0/properties/params/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;break;}}if(valid2){for(const key2 in data2){const _errs17: any = errors;var valid5: any = _errs17 === errors;if(!valid5){break;}}}}else {const err11: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/0/properties/params/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}if(valid1){if(data.sessionId !== undefined){let data4: any = data.sessionId;const _errs19: any = errors;const _errs20: any = errors;if(errors === _errs20){if(typeof data4 === "string"){if(func1(data4) < 1){const err12: any = {instancePath:instancePath+"/sessionId",schemaPath:"#/$defs/PreviewDebuggerSessionId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}else {const err13: any = {instancePath:instancePath+"/sessionId",schemaPath:"#/$defs/PreviewDebuggerSessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}var valid1: any = _errs19 === errors;}else {var valid1: any = true;}}}}}}}else {const err14: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs23: any = errors;if(errors === _errs23){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.id === undefined) && (missing1 = "id")) || ((data.result === undefined) && (missing1 = "result"))){const err15: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}else {const _errs25: any = errors;for(const key3 in data){if(!(((key3 === "id") || (key3 === "result")) || (key3 === "sessionId"))){const err16: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;break;}}if(_errs25 === errors){if(data.id !== undefined){let data5: any = data.id;const _errs26: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){const err17: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}if(errors === _errs26){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){const err18: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}else {if(data5 < -9007199254740991 || isNaN(data5)){const err19: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}}}}var valid7: any = _errs26 === errors;}else {var valid7: any = true;}if(valid7){if(data.result !== undefined){let data6: any = data.result;const _errs28: any = errors;if(errors === _errs28){if(data6 && typeof data6 == "object" && !Array.isArray(data6)){for(const key4 in data6){const _errs30: any = errors;const _errs31: any = errors;if(typeof key4 !== "string"){const err20: any = {instancePath:instancePath+"/result",schemaPath:"#/anyOf/1/properties/result/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key4};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}var valid9: any = _errs31 === errors;if(valid9){const _errs33: any = errors;const _errs34: any = errors;const _errs35: any = errors;if("__proto__" !== key4){const err21: any = {};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}var valid10: any = _errs35 === errors;if(valid10){const err22: any = {instancePath:instancePath+"/result",schemaPath:"#/anyOf/1/properties/result/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key4};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}else {errors = _errs34;if(vErrors !== null){if(_errs34){vErrors.length = _errs34;}else {vErrors = null;}}}var valid9: any = _errs33 === errors;}var valid8: any = _errs30 === errors;if(!valid8){const err23: any = {instancePath:instancePath+"/result",schemaPath:"#/anyOf/1/properties/result/propertyNames",keyword:"propertyNames",params:{propertyName: key4}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;break;}}if(valid8){for(const key5 in data6){const _errs37: any = errors;var valid11: any = _errs37 === errors;if(!valid11){break;}}}}else {const err24: any = {instancePath:instancePath+"/result",schemaPath:"#/anyOf/1/properties/result/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}}var valid7: any = _errs28 === errors;}else {var valid7: any = true;}if(valid7){if(data.sessionId !== undefined){let data8: any = data.sessionId;const _errs39: any = errors;const _errs40: any = errors;if(errors === _errs40){if(typeof data8 === "string"){if(func1(data8) < 1){const err25: any = {instancePath:instancePath+"/sessionId",schemaPath:"#/$defs/PreviewDebuggerSessionId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}}else {const err26: any = {instancePath:instancePath+"/sessionId",schemaPath:"#/$defs/PreviewDebuggerSessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}}var valid7: any = _errs39 === errors;}else {var valid7: any = true;}}}}}}else {const err27: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}}var _valid0: any = _errs23 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs43: any = errors;if(errors === _errs43){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.id === undefined) && (missing2 = "id")) || ((data.error === undefined) && (missing2 = "error"))){const err28: any = {instancePath,schemaPath:"#/anyOf/2/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}else {const _errs45: any = errors;for(const key6 in data){if(!(((key6 === "id") || (key6 === "error")) || (key6 === "sessionId"))){const err29: any = {instancePath,schemaPath:"#/anyOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;break;}}if(_errs45 === errors){if(data.id !== undefined){let data9: any = data.id;const _errs46: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){const err30: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;}if(errors === _errs46){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){const err31: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;}else {if(data9 < -9007199254740991 || isNaN(data9)){const err32: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;}}}}var valid13: any = _errs46 === errors;}else {var valid13: any = true;}if(valid13){if(data.error !== undefined){let data10: any = data.error;const _errs48: any = errors;const _errs49: any = errors;if(errors === _errs49){if(data10 && typeof data10 == "object" && !Array.isArray(data10)){let missing3: any;if(((data10.code === undefined) && (missing3 = "code")) || ((data10.message === undefined) && (missing3 = "message"))){const err33: any = {instancePath:instancePath+"/error",schemaPath:"#/$defs/PreviewDebuggerError/required",keyword:"required",params:{missingProperty: missing3}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;}else {const _errs51: any = errors;for(const key7 in data10){if(!((key7 === "code") || (key7 === "message"))){const err34: any = {instancePath:instancePath+"/error",schemaPath:"#/$defs/PreviewDebuggerError/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7}};if(vErrors === null){vErrors = [err34];}else {vErrors.push(err34);}errors++;break;}}if(_errs51 === errors){if(data10.code !== undefined){let data11: any = data10.code;const _errs52: any = errors;if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){const err35: any = {instancePath:instancePath+"/error/code",schemaPath:"#/$defs/PreviewDebuggerError/properties/code/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err35];}else {vErrors.push(err35);}errors++;}if(errors === _errs52){if((typeof data11 == "number") && (isFinite(data11))){if(data11 > 9007199254740991 || isNaN(data11)){const err36: any = {instancePath:instancePath+"/error/code",schemaPath:"#/$defs/PreviewDebuggerError/properties/code/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err36];}else {vErrors.push(err36);}errors++;}else {if(data11 < -9007199254740991 || isNaN(data11)){const err37: any = {instancePath:instancePath+"/error/code",schemaPath:"#/$defs/PreviewDebuggerError/properties/code/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}};if(vErrors === null){vErrors = [err37];}else {vErrors.push(err37);}errors++;}}}}var valid15: any = _errs52 === errors;}else {var valid15: any = true;}if(valid15){if(data10.message !== undefined){const _errs54: any = errors;if(typeof data10.message !== "string"){const err38: any = {instancePath:instancePath+"/error/message",schemaPath:"#/$defs/PreviewDebuggerError/properties/message/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err38];}else {vErrors.push(err38);}errors++;}var valid15: any = _errs54 === errors;}else {var valid15: any = true;}}}}}else {const err39: any = {instancePath:instancePath+"/error",schemaPath:"#/$defs/PreviewDebuggerError/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err39];}else {vErrors.push(err39);}errors++;}}var valid13: any = _errs48 === errors;}else {var valid13: any = true;}if(valid13){if(data.sessionId !== undefined){let data13: any = data.sessionId;const _errs56: any = errors;const _errs57: any = errors;if(errors === _errs57){if(typeof data13 === "string"){if(func1(data13) < 1){const err40: any = {instancePath:instancePath+"/sessionId",schemaPath:"#/$defs/PreviewDebuggerSessionId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err40];}else {vErrors.push(err40);}errors++;}}else {const err41: any = {instancePath:instancePath+"/sessionId",schemaPath:"#/$defs/PreviewDebuggerSessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err41];}else {vErrors.push(err41);}errors++;}}var valid13: any = _errs56 === errors;}else {var valid13: any = true;}}}}}}else {const err42: any = {instancePath,schemaPath:"#/anyOf/2/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err42];}else {vErrors.push(err42);}errors++;}}var _valid0: any = _errs43 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs60: any = errors;if(errors === _errs60){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((data.method === undefined) && (missing4 = "method")){const err43: any = {instancePath,schemaPath:"#/anyOf/3/required",keyword:"required",params:{missingProperty: missing4}};if(vErrors === null){vErrors = [err43];}else {vErrors.push(err43);}errors++;}else {const _errs62: any = errors;for(const key8 in data){if(!(((key8 === "method") || (key8 === "params")) || (key8 === "sessionId"))){const err44: any = {instancePath,schemaPath:"#/anyOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key8}};if(vErrors === null){vErrors = [err44];}else {vErrors.push(err44);}errors++;break;}}if(_errs62 === errors){if(data.method !== undefined){let data14: any = data.method;const _errs63: any = errors;if(errors === _errs63){if(typeof data14 === "string"){if(func1(data14) < 1){const err45: any = {instancePath:instancePath+"/method",schemaPath:"#/anyOf/3/properties/method/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err45];}else {vErrors.push(err45);}errors++;}}else {const err46: any = {instancePath:instancePath+"/method",schemaPath:"#/anyOf/3/properties/method/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err46];}else {vErrors.push(err46);}errors++;}}var valid17: any = _errs63 === errors;}else {var valid17: any = true;}if(valid17){if(data.params !== undefined){let data15: any = data.params;const _errs65: any = errors;if(errors === _errs65){if(data15 && typeof data15 == "object" && !Array.isArray(data15)){for(const key9 in data15){const _errs67: any = errors;const _errs68: any = errors;if(typeof key9 !== "string"){const err47: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/3/properties/params/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key9};if(vErrors === null){vErrors = [err47];}else {vErrors.push(err47);}errors++;}var valid19: any = _errs68 === errors;if(valid19){const _errs70: any = errors;const _errs71: any = errors;const _errs72: any = errors;if("__proto__" !== key9){const err48: any = {};if(vErrors === null){vErrors = [err48];}else {vErrors.push(err48);}errors++;}var valid20: any = _errs72 === errors;if(valid20){const err49: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/3/properties/params/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key9};if(vErrors === null){vErrors = [err49];}else {vErrors.push(err49);}errors++;}else {errors = _errs71;if(vErrors !== null){if(_errs71){vErrors.length = _errs71;}else {vErrors = null;}}}var valid19: any = _errs70 === errors;}var valid18: any = _errs67 === errors;if(!valid18){const err50: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/3/properties/params/propertyNames",keyword:"propertyNames",params:{propertyName: key9}};if(vErrors === null){vErrors = [err50];}else {vErrors.push(err50);}errors++;break;}}if(valid18){for(const key10 in data15){const _errs74: any = errors;var valid21: any = _errs74 === errors;if(!valid21){break;}}}}else {const err51: any = {instancePath:instancePath+"/params",schemaPath:"#/anyOf/3/properties/params/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err51];}else {vErrors.push(err51);}errors++;}}var valid17: any = _errs65 === errors;}else {var valid17: any = true;}if(valid17){if(data.sessionId !== undefined){let data17: any = data.sessionId;const _errs76: any = errors;const _errs77: any = errors;if(errors === _errs77){if(typeof data17 === "string"){if(func1(data17) < 1){const err52: any = {instancePath:instancePath+"/sessionId",schemaPath:"#/$defs/PreviewDebuggerSessionId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err52];}else {vErrors.push(err52);}errors++;}}else {const err53: any = {instancePath:instancePath+"/sessionId",schemaPath:"#/$defs/PreviewDebuggerSessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err53];}else {vErrors.push(err53);}errors++;}}var valid17: any = _errs76 === errors;}else {var valid17: any = true;}}}}}}else {const err54: any = {instancePath,schemaPath:"#/anyOf/3/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err54];}else {vErrors.push(err54);}errors++;}}var _valid0: any = _errs60 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err55: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err55];}else {vErrors.push(err55);}errors++;validate1361.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1361.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1361.errors = null as any[] | null;
// prettier-ignore
validate1361.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
function validate1360(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageDebuggerMessageRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1360.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.pageId === undefined) && (missing0 = "pageId")) || ((data.message === undefined) && (missing0 = "message"))){validate1360.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "pageId") || (key0 === "message"))){validate1360.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){let data0: any = data.pageId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1360.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1360.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1360.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.message !== undefined){const _errs6: any = errors;if(!(validate1361.call(this, data.message, {instancePath:instancePath+"/message",parentData:data,parentDataProperty:"message",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1361.errors : vErrors.concat(validate1361.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1360.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1360.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1360.errors = null as any[] | null;
// prettier-ignore
validate1360.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2558: any = {"description":"The state a relayed download ended in, as Electron's download item reports it when done.","type":"string","enum":["completed","cancelled","interrupted"]};
// prettier-ignore
function validate1363(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageDownloadReportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1363.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.pageId === undefined) && (missing0 = "pageId")) || ((data.messageId === undefined) && (missing0 = "messageId"))) || ((data.fileId === undefined) && (missing0 = "fileId"))) || ((data.fileName === undefined) && (missing0 = "fileName"))) || ((data.state === undefined) && (missing0 = "state"))){validate1363.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "pageId") || (key0 === "messageId")) || (key0 === "fileId")) || (key0 === "fileName")) || (key0 === "state"))){validate1363.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){let data0: any = data.pageId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1363.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1363.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1363.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.messageId !== undefined){let data1: any = data.messageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1363.errors = [{instancePath:instancePath+"/messageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewInputMessageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1363.errors = [{instancePath:instancePath+"/messageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewInputMessageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1363.errors = [{instancePath:instancePath+"/messageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewInputMessageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.fileId !== undefined){let data2: any = data.fileId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) > 256){validate1363.errors = [{instancePath:instancePath+"/fileId",schemaPath:"#/$defs/PreviewStagedFileId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate1363.errors = [{instancePath:instancePath+"/fileId",schemaPath:"#/$defs/PreviewStagedFileId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1363.errors = [{instancePath:instancePath+"/fileId",schemaPath:"#/$defs/PreviewStagedFileId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.fileName !== undefined){let data3: any = data.fileName;const _errs14: any = errors;if(errors === _errs14){if(typeof data3 === "string"){if(func1(data3) > 4096){validate1363.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validate1363.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1363.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data4: any = data.state;const _errs16: any = errors;if(typeof data4 !== "string"){validate1363.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/PreviewDownloadState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data4 === "completed") || (data4 === "cancelled")) || (data4 === "interrupted"))){validate1363.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/PreviewDownloadState/enum",keyword:"enum",params:{allowedValues: schema2558.enum}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1363.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1363.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1363.errors = null as any[] | null;
// prettier-ignore
validate1363.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2560: any = {"description":"What the daemon did with a reported download.","type":"string","enum":["accepted","refused"]};
// prettier-ignore
function validate1364(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageDownloadReportResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1364.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.verdict === undefined) && (missing0 = "verdict")){validate1364.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "verdict")){validate1364.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.verdict !== undefined){let data0: any = data.verdict;if(typeof data0 !== "string"){validate1364.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/$defs/PreviewDownloadVerdict/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data0 === "accepted") || (data0 === "refused"))){validate1364.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/$defs/PreviewDownloadVerdict/enum",keyword:"enum",params:{allowedValues: schema2560.enum}}];return false;}}}}}else {validate1364.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1364.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1364.errors = null as any[] | null;
// prettier-ignore
validate1364.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1365(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageEditRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1365.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.pageId === undefined) && (missing0 = "pageId")) || ((data.messageId === undefined) && (missing0 = "messageId"))) || ((data.edit === undefined) && (missing0 = "edit"))){validate1365.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "pageId") || (key0 === "messageId")) || (key0 === "edit"))){validate1365.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){let data0: any = data.pageId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1365.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1365.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1365.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.messageId !== undefined){let data1: any = data.messageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1365.errors = [{instancePath:instancePath+"/messageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewInputMessageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1365.errors = [{instancePath:instancePath+"/messageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewInputMessageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1365.errors = [{instancePath:instancePath+"/messageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewInputMessageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.edit !== undefined){let data2: any = data.edit;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let valid4: any = false;const tag0: any = data2.kind;if(typeof tag0 == "string"){if(tag0 === "paste"){const _errs14: any = errors;if(errors === _errs14){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if(((data2.kind === undefined) && (missing1 = "kind")) || ((data2.text === undefined) && (missing1 = "text"))){validate1365.errors = [{instancePath:instancePath+"/edit",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs16: any = errors;for(const key1 in data2){if(!((key1 === "kind") || (key1 === "text"))){validate1365.errors = [{instancePath:instancePath+"/edit",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs16 === errors){if(data2.kind !== undefined){let data3: any = data2.kind;const _errs17: any = errors;if(typeof data3 !== "string"){validate1365.errors = [{instancePath:instancePath+"/edit/kind",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("paste" !== data3){validate1365.errors = [{instancePath:instancePath+"/edit/kind",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "paste"}}];return false;}var valid6: any = _errs17 === errors;}else {var valid6: any = true;}if(valid6){if(data2.text !== undefined){const _errs19: any = errors;if(typeof data2.text !== "string"){validate1365.errors = [{instancePath:instancePath+"/edit/text",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/0/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}var valid6: any = _errs19 === errors;}else {var valid6: any = true;}}}}}else {validate1365.errors = [{instancePath:instancePath+"/edit",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs14 === errors;var props0: any = true;valid4 = valid5;}else if(tag0 === "selectAll"){const _errs21: any = errors;if(errors === _errs21){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing2: any;if((data2.kind === undefined) && (missing2 = "kind")){validate1365.errors = [{instancePath:instancePath+"/edit",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs23: any = errors;for(const key2 in data2){if(!(key2 === "kind")){validate1365.errors = [{instancePath:instancePath+"/edit",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs23 === errors){if(data2.kind !== undefined){let data5: any = data2.kind;if(typeof data5 !== "string"){validate1365.errors = [{instancePath:instancePath+"/edit/kind",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("selectAll" !== data5){validate1365.errors = [{instancePath:instancePath+"/edit/kind",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "selectAll"}}];return false;}}}}}else {validate1365.errors = [{instancePath:instancePath+"/edit",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs21 === errors;if(props0 !== true){props0 = true;}valid4 = valid7;}else if(tag0 === "cut"){const _errs26: any = errors;if(errors === _errs26){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing3: any;if((data2.kind === undefined) && (missing3 = "kind")){validate1365.errors = [{instancePath:instancePath+"/edit",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/2/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs28: any = errors;for(const key3 in data2){if(!(key3 === "kind")){validate1365.errors = [{instancePath:instancePath+"/edit",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs28 === errors){if(data2.kind !== undefined){let data6: any = data2.kind;if(typeof data6 !== "string"){validate1365.errors = [{instancePath:instancePath+"/edit/kind",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("cut" !== data6){validate1365.errors = [{instancePath:instancePath+"/edit/kind",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "cut"}}];return false;}}}}}else {validate1365.errors = [{instancePath:instancePath+"/edit",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs26 === errors;if(props0 !== true){props0 = true;}valid4 = valid9;}else {validate1365.errors = [{instancePath:instancePath+"/edit",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1365.errors = [{instancePath:instancePath+"/edit",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid4){if(props0 !== true){for(const key4 in data2){if(!props0 || !props0[key4]){validate1365.errors = [{instancePath:instancePath+"/edit",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key4}}];return false;break;}}}}}else {validate1365.errors = [{instancePath:instancePath+"/edit",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewMenuEdit/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1365.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1365.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1365.errors = null as any[] | null;
// prettier-ignore
validate1365.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1366(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageLocalInputReportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1366.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.pageId === undefined) && (missing0 = "pageId")){validate1366.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "pageId")){validate1366.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){let data0: any = data.pageId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1366.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1366.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1366.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1366.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1366.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1366.errors = null as any[] | null;
// prettier-ignore
validate1366.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1368(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1368.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.point === undefined) && (missing0 = "point")) || ((data.frameAddress === undefined) && (missing0 = "frameAddress"))) || ((data.isEditable === undefined) && (missing0 = "isEditable"))) || ((data.canCut === undefined) && (missing0 = "canCut"))) || ((data.canCopy === undefined) && (missing0 = "canCopy"))) || ((data.canSelectAll === undefined) && (missing0 = "canSelectAll"))){validate1368.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "point") || (key0 === "frameAddress")) || (key0 === "linkUrl")) || (key0 === "isEditable")) || (key0 === "canCut")) || (key0 === "canCopy")) || (key0 === "canSelectAll")) || (key0 === "selectionText"))){validate1368.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.point !== undefined){let data0: any = data.point;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(data0 && typeof data0 == "object" && !Array.isArray(data0)){let missing1: any;if(((data0.x === undefined) && (missing1 = "x")) || ((data0.y === undefined) && (missing1 = "y"))){validate1368.errors = [{instancePath:instancePath+"/point",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPoint/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs5: any = errors;for(const key1 in data0){if(!((key1 === "x") || (key1 === "y"))){validate1368.errors = [{instancePath:instancePath+"/point",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPoint/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data0.x !== undefined){let data1: any = data0.x;const _errs6: any = errors;if(!((typeof data1 == "number") && (isFinite(data1)))){validate1368.errors = [{instancePath:instancePath+"/point/x",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPoint/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data0.y !== undefined){let data2: any = data0.y;const _errs8: any = errors;if(!((typeof data2 == "number") && (isFinite(data2)))){validate1368.errors = [{instancePath:instancePath+"/point/y",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPoint/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate1368.errors = [{instancePath:instancePath+"/point",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPoint/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.frameAddress !== undefined){let data3: any = data.frameAddress;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) > 2097152){validate1368.errors = [{instancePath:instancePath+"/frameAddress",schemaPath:"#/properties/frameAddress/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data3) < 1){validate1368.errors = [{instancePath:instancePath+"/frameAddress",schemaPath:"#/properties/frameAddress/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1368.errors = [{instancePath:instancePath+"/frameAddress",schemaPath:"#/properties/frameAddress/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.linkUrl !== undefined){let data4: any = data.linkUrl;const _errs12: any = errors;if(errors === _errs12){if(typeof data4 === "string"){if(func1(data4) > 2097152){validate1368.errors = [{instancePath:instancePath+"/linkUrl",schemaPath:"#/properties/linkUrl/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data4) < 1){validate1368.errors = [{instancePath:instancePath+"/linkUrl",schemaPath:"#/properties/linkUrl/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1368.errors = [{instancePath:instancePath+"/linkUrl",schemaPath:"#/properties/linkUrl/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.isEditable !== undefined){const _errs14: any = errors;if(typeof data.isEditable !== "boolean"){validate1368.errors = [{instancePath:instancePath+"/isEditable",schemaPath:"#/properties/isEditable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.canCut !== undefined){const _errs16: any = errors;if(typeof data.canCut !== "boolean"){validate1368.errors = [{instancePath:instancePath+"/canCut",schemaPath:"#/properties/canCut/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.canCopy !== undefined){const _errs18: any = errors;if(typeof data.canCopy !== "boolean"){validate1368.errors = [{instancePath:instancePath+"/canCopy",schemaPath:"#/properties/canCopy/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.canSelectAll !== undefined){const _errs20: any = errors;if(typeof data.canSelectAll !== "boolean"){validate1368.errors = [{instancePath:instancePath+"/canSelectAll",schemaPath:"#/properties/canSelectAll/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.selectionText !== undefined){const _errs22: any = errors;if(typeof data.selectionText !== "string"){validate1368.errors = [{instancePath:instancePath+"/selectionText",schemaPath:"#/properties/selectionText/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validate1368.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1368.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1368.errors = null as any[] | null;
// prettier-ignore
validate1368.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1367(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageMenuReportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1367.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.pageId === undefined) && (missing0 = "pageId")) || ((data.messageId === undefined) && (missing0 = "messageId"))) || ((data.menu === undefined) && (missing0 = "menu"))){validate1367.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "pageId") || (key0 === "messageId")) || (key0 === "menu"))){validate1367.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){let data0: any = data.pageId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1367.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1367.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1367.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.messageId !== undefined){let data1: any = data.messageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1367.errors = [{instancePath:instancePath+"/messageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewInputMessageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1367.errors = [{instancePath:instancePath+"/messageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewInputMessageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1367.errors = [{instancePath:instancePath+"/messageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewInputMessageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.menu !== undefined){const _errs10: any = errors;if(!(validate1368.call(this, data.menu, {instancePath:instancePath+"/menu",parentData:data,parentDataProperty:"menu",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1368.errors : vErrors.concat(validate1368.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1367.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1367.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1367.errors = null as any[] | null;
// prettier-ignore
validate1367.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1370(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageSiteDataClearRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1370.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!(key0 === "origins")){validate1370.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.origins !== undefined){let data0: any = data.origins;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validate1370.errors = [{instancePath:instancePath+"/origins",schemaPath:"#/properties/origins/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 2097152){validate1370.errors = [{instancePath:instancePath+"/origins/" + i0,schemaPath:"#/properties/origins/items/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data1) < 1){validate1370.errors = [{instancePath:instancePath+"/origins/" + i0,schemaPath:"#/properties/origins/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1370.errors = [{instancePath:instancePath+"/origins/" + i0,schemaPath:"#/properties/origins/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validate1370.errors = [{instancePath:instancePath+"/origins",schemaPath:"#/properties/origins/type",keyword:"type",params:{type: "array"}}];return false;}}}}}else {validate1370.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1370.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1370.errors = null as any[] | null;
// prettier-ignore
validate1370.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate1371(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageStagingFolderReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1371.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.folder === undefined) && (missing0 = "folder")){validate1371.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "folder")){validate1371.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.folder !== undefined){let data0: any = data.folder;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate1371.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validate1371.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data0)){validate1371.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1371.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1371.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1371.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1371.errors = null as any[] | null;
// prettier-ignore
validate1371.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1372(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageTargetReportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1372.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.pageId === undefined) && (missing0 = "pageId")) || ((data.targetId === undefined) && (missing0 = "targetId"))){validate1372.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "pageId") || (key0 === "targetId"))){validate1372.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){let data0: any = data.pageId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1372.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1372.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1372.errors = [{instancePath:instancePath+"/pageId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.targetId !== undefined){let data1: any = data.targetId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) < 1){validate1372.errors = [{instancePath:instancePath+"/targetId",schemaPath:"#/$defs/PreviewDebuggerTargetId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1372.errors = [{instancePath:instancePath+"/targetId",schemaPath:"#/$defs/PreviewDebuggerTargetId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1372.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1372.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1372.errors = null as any[] | null;
// prettier-ignore
validate1372.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1373(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewReceivedResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1373.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.received === undefined) && (missing0 = "received")){validate1373.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "received")){validate1373.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.received !== undefined){let data0: any = data.received;if(typeof data0 !== "boolean"){validate1373.errors = [{instancePath:instancePath+"/received",schemaPath:"#/properties/received/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validate1373.errors = [{instancePath:instancePath+"/received",schemaPath:"#/properties/received/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validate1373.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1373.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1373.errors = null as any[] | null;
// prettier-ignore
validate1373.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1374(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewSaveReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1374.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.saveId === undefined) && (missing0 = "saveId")) || ((data.offset === undefined) && (missing0 = "offset"))){validate1374.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "saveId") || (key0 === "offset"))){validate1374.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.saveId !== undefined){let data0: any = data.saveId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1374.errors = [{instancePath:instancePath+"/saveId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewSaveId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1374.errors = [{instancePath:instancePath+"/saveId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewSaveId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1374.errors = [{instancePath:instancePath+"/saveId",schemaPath:"sidekicks-contracts:preview/methods#/$defs/PreviewSaveId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.offset !== undefined){let data1: any = data.offset;const _errs6: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1374.errors = [{instancePath:instancePath+"/offset",schemaPath:"#/properties/offset/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1374.errors = [{instancePath:instancePath+"/offset",schemaPath:"#/properties/offset/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate1374.errors = [{instancePath:instancePath+"/offset",schemaPath:"#/properties/offset/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1374.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1374.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1374.errors = null as any[] | null;
// prettier-ignore
validate1374.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1375(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewSaveReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1375.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.part === undefined) && (missing0 = "part")) || ((data.isLastPart === undefined) && (missing0 = "isLastPart"))){validate1375.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "part") || (key0 === "isLastPart"))){validate1375.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.part !== undefined){let data0: any = data.part;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(data0 && typeof data0 == "object" && !Array.isArray(data0)){let missing1: any;if((data0.$bytes === undefined) && (missing1 = "$bytes")){validate1375.errors = [{instancePath:instancePath+"/part",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs6: any = errors;for(const key1 in data0){if(!(key1 === "$bytes")){validate1375.errors = [{instancePath:instancePath+"/part",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs6 === errors){if(data0.$bytes !== undefined){let data1: any = data0.$bytes;const _errs7: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1375.errors = [{instancePath:instancePath+"/part/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 4294967295 || isNaN(data1)){validate1375.errors = [{instancePath:instancePath+"/part/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate1375.errors = [{instancePath:instancePath+"/part/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate1375.errors = [{instancePath:instancePath+"/part",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs3 === errors;if(valid1){if(!(data0 && typeof data0 == "object" && Number.isInteger(data0.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data0.$bytes] instanceof Uint8Array && this.attachments[data0.$bytes].byteLength <= 262144)){validate1375.errors = [{instancePath:instancePath+"/part",schemaPath:"#/properties/part/maxBytes",keyword:"maxBytes",params:{}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.isLastPart !== undefined){const _errs10: any = errors;if(typeof data.isLastPart !== "boolean"){validate1375.errors = [{instancePath:instancePath+"/isLastPart",schemaPath:"#/properties/isLastPart/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}else {validate1375.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1375.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1375.errors = null as any[] | null;
// prettier-ignore
validate1375.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1376(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewStagedFileId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1376.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validate1376.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validate1376.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1376.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1376.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1376.errors = null as any[] | null;
// prettier-ignore
validate1376.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewClearedResponse}. */
export const validatePreviewClearedResponse: SchemaCheck<PreviewClearedResponse> = validate1351;
/** Checks that a value is a {@link PreviewPageCookieClearRequest}. */
export const validatePreviewPageCookieClearRequest: SchemaCheck<PreviewPageCookieClearRequest> =
  validate1352;
/** Checks that a value is a {@link PreviewPageCookieListRequest}. */
export const validatePreviewPageCookieListRequest: SchemaCheck<PreviewPageCookieListRequest> =
  validate1353;
/** Checks that a value is a {@link PreviewPageCookieListResponse}. */
export const validatePreviewPageCookieListResponse: SchemaCheck<PreviewPageCookieListResponse> =
  validate1354;
/** Checks that a value is a {@link PreviewPageCookieUpdateRequest}. */
export const validatePreviewPageCookieUpdateRequest: SchemaCheck<PreviewPageCookieUpdateRequest> =
  validate1357;
/** Checks that a value is a {@link PreviewPageCookieUpdateResponse}. */
export const validatePreviewPageCookieUpdateResponse: SchemaCheck<PreviewPageCookieUpdateResponse> =
  validate1359;
/** Checks that a value is a {@link PreviewPageDebuggerMessageRequest}. */
export const validatePreviewPageDebuggerMessageRequest: SchemaCheck<PreviewPageDebuggerMessageRequest> =
  validate1360;
/** Checks that a value is a {@link PreviewPageDownloadReportRequest}. */
export const validatePreviewPageDownloadReportRequest: SchemaCheck<PreviewPageDownloadReportRequest> =
  validate1363;
/** Checks that a value is a {@link PreviewPageDownloadReportResponse}. */
export const validatePreviewPageDownloadReportResponse: SchemaCheck<PreviewPageDownloadReportResponse> =
  validate1364;
/** Checks that a value is a {@link PreviewPageEditRequest}. */
export const validatePreviewPageEditRequest: SchemaCheck<PreviewPageEditRequest> = validate1365;
/** Checks that a value is a {@link PreviewPageLocalInputReportRequest}. */
export const validatePreviewPageLocalInputReportRequest: SchemaCheck<PreviewPageLocalInputReportRequest> =
  validate1366;
/** Checks that a value is a {@link PreviewPageMenuReportRequest}. */
export const validatePreviewPageMenuReportRequest: SchemaCheck<PreviewPageMenuReportRequest> =
  validate1367;
/** Checks that a value is a {@link PreviewPageSiteDataClearRequest}. */
export const validatePreviewPageSiteDataClearRequest: SchemaCheck<PreviewPageSiteDataClearRequest> =
  validate1370;
/** Checks that a value is a {@link PreviewPageStagingFolderReadResponse}. */
export const validatePreviewPageStagingFolderReadResponse: SchemaCheck<PreviewPageStagingFolderReadResponse> =
  validate1371;
/** Checks that a value is a {@link PreviewPageTargetReportRequest}. */
export const validatePreviewPageTargetReportRequest: SchemaCheck<PreviewPageTargetReportRequest> =
  validate1372;
/** Checks that a value is a {@link PreviewReceivedResponse}. */
export const validatePreviewReceivedResponse: SchemaCheck<PreviewReceivedResponse> = validate1373;
/** Checks that a value is a {@link PreviewSaveReadRequest}. */
export const validatePreviewSaveReadRequest: SchemaCheck<PreviewSaveReadRequest> = validate1374;
/** Checks that a value is a {@link PreviewSaveReadResponse}. */
export const validatePreviewSaveReadResponse: SchemaCheck<PreviewSaveReadResponse> = validate1375;
/** Checks that a value is a {@link PreviewStagedFileId}. */
export const validatePreviewStagedFileId: SchemaCheck<PreviewStagedFileId> = validate1376;

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
