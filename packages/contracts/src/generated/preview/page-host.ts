// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The Preview page host's link between the daemon and the desktop's main process: debug targets, debugger traffic, menus, input at the machine, downloads, staged files, menu acts, cookies and site data.

import type { EmptyPayload } from "../method-descriptor.js";
import type {
  PreviewInputMessageId,
  PreviewMenuEdit,
  PreviewMenuEditResponse,
  PreviewPageId,
  PreviewPoint,
  PreviewSaveId,
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

/** The methods of {@link PREVIEW_PAGE_LINK_METHOD_DESCRIPTORS}, each with its kind. */
export interface PreviewPageLinkMethodDescriptors {
  readonly "preview.page.target.report": {
    readonly method: "preview.page.target.report";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.page.debugger.report": {
    readonly method: "preview.page.debugger.report";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.page.menu.report": {
    readonly method: "preview.page.menu.report";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.page.stagingFolder.read": {
    readonly method: "preview.page.stagingFolder.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "preview.page.localInput.report": {
    readonly method: "preview.page.localInput.report";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.page.download.report": {
    readonly method: "preview.page.download.report";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.save.read": {
    readonly method: "preview.save.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link PREVIEW_PAGE_LINK_METHOD_DESCRIPTORS}. */
export interface PreviewPageLinkMethodTypes {
  readonly "preview.page.target.report": {
    readonly params: PreviewPageTargetReportRequest;
    readonly result: PreviewReceivedResponse;
  };
  readonly "preview.page.debugger.report": {
    readonly params: PreviewPageDebuggerMessageRequest;
    readonly result: PreviewReceivedResponse;
  };
  readonly "preview.page.menu.report": {
    readonly params: PreviewPageMenuReportRequest;
    readonly result: PreviewReceivedResponse;
  };
  readonly "preview.page.stagingFolder.read": {
    readonly params: EmptyPayload;
    readonly result: PreviewPageStagingFolderReadResponse;
  };
  readonly "preview.page.localInput.report": {
    readonly params: PreviewPageLocalInputReportRequest;
    readonly result: PreviewReceivedResponse;
  };
  readonly "preview.page.download.report": {
    readonly params: PreviewPageDownloadReportRequest;
    readonly result: PreviewPageDownloadReportResponse;
  };
  readonly "preview.save.read": {
    readonly params: PreviewSaveReadRequest;
    readonly result: PreviewSaveReadResponse;
  };
}
/** The `preview.*` link methods the daemon answers; main is their only caller. */
export const PREVIEW_PAGE_LINK_METHOD_DESCRIPTORS: PreviewPageLinkMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "preview.page.target.report": /* @__PURE__ */ Object.freeze({
      method: "preview.page.target.report",
      procedureType: "mutation",
      mutating: true,
    }),
    "preview.page.debugger.report": /* @__PURE__ */ Object.freeze({
      method: "preview.page.debugger.report",
      procedureType: "mutation",
      mutating: true,
    }),
    "preview.page.menu.report": /* @__PURE__ */ Object.freeze({
      method: "preview.page.menu.report",
      procedureType: "mutation",
      mutating: true,
    }),
    "preview.page.stagingFolder.read": /* @__PURE__ */ Object.freeze({
      method: "preview.page.stagingFolder.read",
      procedureType: "query",
      mutating: false,
    }),
    "preview.page.localInput.report": /* @__PURE__ */ Object.freeze({
      method: "preview.page.localInput.report",
      procedureType: "mutation",
      mutating: true,
    }),
    "preview.page.download.report": /* @__PURE__ */ Object.freeze({
      method: "preview.page.download.report",
      procedureType: "mutation",
      mutating: true,
    }),
    "preview.save.read": /* @__PURE__ */ Object.freeze({
      method: "preview.save.read",
      procedureType: "query",
      mutating: false,
    }),
  });

/** The methods of {@link PREVIEW_PAGE_HOST_METHOD_DESCRIPTORS}, each with its kind. */
export interface PreviewPageHostMethodDescriptors {
  readonly "preview.page.debugger.send": {
    readonly method: "preview.page.debugger.send";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.page.edit": {
    readonly method: "preview.page.edit";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.page.cookie.list": {
    readonly method: "preview.page.cookie.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "preview.page.cookie.update": {
    readonly method: "preview.page.cookie.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.page.cookie.clear": {
    readonly method: "preview.page.cookie.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.page.siteData.clear": {
    readonly method: "preview.page.siteData.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link PREVIEW_PAGE_HOST_METHOD_DESCRIPTORS}. */
export interface PreviewPageHostMethodTypes {
  readonly "preview.page.debugger.send": {
    readonly params: PreviewPageDebuggerMessageRequest;
    readonly result: PreviewReceivedResponse;
  };
  readonly "preview.page.edit": {
    readonly params: PreviewPageEditRequest;
    readonly result: PreviewMenuEditResponse;
  };
  readonly "preview.page.cookie.list": {
    readonly params: PreviewPageCookieListRequest;
    readonly result: PreviewPageCookieListResponse;
  };
  readonly "preview.page.cookie.update": {
    readonly params: PreviewPageCookieUpdateRequest;
    readonly result: PreviewPageCookieUpdateResponse;
  };
  readonly "preview.page.cookie.clear": {
    readonly params: PreviewPageCookieClearRequest;
    readonly result: PreviewClearedResponse;
  };
  readonly "preview.page.siteData.clear": {
    readonly params: PreviewPageSiteDataClearRequest;
    readonly result: PreviewClearedResponse;
  };
}
/**
 * The `preview.*` methods main's page host answers. The daemon is their only caller, over the
 * connection the app dials, so they never join the daemon's own method map.
 */
export const PREVIEW_PAGE_HOST_METHOD_DESCRIPTORS: PreviewPageHostMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "preview.page.debugger.send": /* @__PURE__ */ Object.freeze({
      method: "preview.page.debugger.send",
      procedureType: "mutation",
      mutating: true,
    }),
    "preview.page.edit": /* @__PURE__ */ Object.freeze({
      method: "preview.page.edit",
      procedureType: "mutation",
      mutating: true,
    }),
    "preview.page.cookie.list": /* @__PURE__ */ Object.freeze({
      method: "preview.page.cookie.list",
      procedureType: "query",
      mutating: false,
    }),
    "preview.page.cookie.update": /* @__PURE__ */ Object.freeze({
      method: "preview.page.cookie.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "preview.page.cookie.clear": /* @__PURE__ */ Object.freeze({
      method: "preview.page.cookie.clear",
      procedureType: "mutation",
      mutating: true,
    }),
    "preview.page.siteData.clear": /* @__PURE__ */ Object.freeze({
      method: "preview.page.siteData.clear",
      procedureType: "mutation",
      mutating: true,
    }),
  });
