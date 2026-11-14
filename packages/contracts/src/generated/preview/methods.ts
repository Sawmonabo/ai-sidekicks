// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The Preview pane's wire: the pages a session owns and the verbs that move them, the dev servers the daemon discovers, the marks sent to the provider, and the live picture for another device with the input, menu acts, chosen files and saves that answer it.

import type { ArtifactId } from "../artifacts/id.js";
import type { HexColor } from "../color.js";
import type { Port } from "../internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { SessionAttachmentSummary } from "../session/draft.js";
import type { SessionId } from "../session/id.js";
import type { WebAddressFault } from "../web-address.js";

/** The longest page id the daemon mints. */
export const PREVIEW_PAGE_ID_MAX_LEN = 256 as const;

/** The longest address Preview takes: Chromium's own limit on a URL's length. */
export const PREVIEW_ADDRESS_MAX_LEN = 2097152 as const;

/** The zoom factors a page steps through, Chromium's own presets from 50 % to 200 %. */
export const PREVIEW_ZOOM_FACTORS = [
  0.5, 0.6666666666666666, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
] as const;

/**
 * An address Preview will not open, refused with its cause and the page left where it was.
 * Nothing is ever searched on the web.
 */
export const PREVIEW_ADDRESS_REFUSED_CODE = "preview.addressRefused" as const;

/** Every reason an address is refused. */
export const PREVIEW_ADDRESS_REFUSED_REASONS = ["scheme", "notAnAddress"] as const;

/** The longest note a comment or a box carries. */
export const PREVIEW_MARK_NOTE_MAX_LEN = 4096 as const;

/** The longest input message id the daemon mints. */
export const PREVIEW_INPUT_MESSAGE_ID_MAX_LEN = 256 as const;

/** The longest save id the daemon mints. */
export const PREVIEW_SAVE_ID_MAX_LEN = 256 as const;

/** The most bytes one part of a staged file carries. */
export const PREVIEW_FILE_PART_MAX_BYTES = 262144 as const;

/** A menu act for a menu that is no longer the page's current one; nothing changes. */
export const PREVIEW_EDIT_REFUSED_CODE = "preview.editRefused" as const;

/**
 * A chosen file's path inside a folder that is empty, absolute, holds an empty, `.` or `..`
 * segment, or is missing, or a download report naming its file by anything but an id main
 * minted; nothing is set, dropped or staged.
 */
export const PREVIEW_FILE_PATH_REFUSED_CODE = "preview.filePathRefused" as const;

/**
 * The daemon's own handle for one page. Opaque to every client.
 */
export type PreviewPageId = string & { readonly __brand: "PreviewPageId" };
/**
 * A page's zoom: one of the preset factors and nothing between them.
 */
export type PreviewZoomFactor =
  | 0.5
  | 0.6666666666666666
  | 0.75
  | 0.8
  | 0.9
  | 1
  | 1.1
  | 1.25
  | 1.5
  | 1.75
  | 2;
/**
 * A refused address's text that is not an address at all.
 */
export type PreviewUnparsedAddress = "notAnAddress";
/**
 * Why an address was refused: its scheme is one the pane cannot open, or the text is not an
 * address at all.
 */
export type PreviewAddressRefusedReason = WebAddressFault | PreviewUnparsedAddress;
/**
 * Where a page's load stands, tagged on `kind`: loading, with the fraction the engine reports or
 * `null` when it reports none; loaded; or failed, which the pane reads as `<host> did not answer.`
 * with a try-again.
 */
export type PreviewPageLoadState =
  | {
      kind: "loading";
      /**
       * The share loaded; `null` draws an indeterminate mark.
       */
      progress: number | null;
    }
  | {
      kind: "loaded";
    }
  | {
      kind: "failed";
    };
/**
 * What a page opens on, tagged on `kind`: an address the person or an agent gave, or a dev server
 * the daemon discovered. A closed union, so a caller cannot ask for both and leave the daemon to
 * choose. A popup a page opens reaches the list the same way, as an address main hands over.
 */
export type PreviewPageTarget =
  | {
      kind: "address";
      /**
       * The address.
       */
      address: string;
    }
  | {
      kind: "devServer";
      /**
       * Its port.
       */
      port: Port;
    };
/**
 * Where a navigation takes a page, tagged on `kind`. Back, forward and reload ride the same verb
 * as an address, because all four move the same page within its own history.
 */
export type PreviewNavigationTarget =
  | {
      kind: "address";
      /**
       * The address.
       */
      address: string;
    }
  | {
      kind: "back";
    }
  | {
      kind: "forward";
    }
  | {
      kind: "reload";
    };
/**
 * One frame of the discovered servers: every server listening now. The stream sends the newest
 * list once the reader has room, never a queue of the lists between.
 */
export type PreviewDevServerListFrame = PreviewDevServer[];
/**
 * A page snapshot's reference to one element, valid only for the snapshot that minted it.
 */
export type PreviewElementRef = string & { readonly __brand: "PreviewElementRef" };
/**
 * One mark on the frozen picture, tagged on `kind`: a numbered comment pin, a numbered box,
 * or an unnumbered freehand stroke.
 */
export type PreviewMark =
  | {
      kind: "comment";
      /**
       * Its number.
       */
      number: number;
      /**
       * The person's note; `null` where they wrote none.
       */
      note: string | null;
      /**
       * Where it is pinned, in viewport CSS pixels.
       */
      point: PreviewPoint;
      /**
       * The element it landed on; `null` where it hit none.
       */
      element: PreviewMarkElement | null;
    }
  | {
      kind: "box";
      /**
       * Its number.
       */
      number: number;
      /**
       * The person's note; `null` where they wrote none.
       */
      note: string | null;
      /**
       * The box.
       */
      rect: PreviewRect;
      /**
       * The element it landed on; `null` where it hit none.
       */
      element: PreviewMarkElement | null;
    }
  | {
      kind: "stroke";
      /**
       * Its points in viewport CSS pixels, at least one.
       *
       * @minItems 1
       */
      points: [PreviewPoint, ...PreviewPoint[]];
      /**
       * Its sRGB color.
       */
      color: HexColor;
      /**
       * The element it landed on; `null` where it hit none.
       */
      element: PreviewMarkElement | null;
    };
/**
 * The token a watcher returns to acknowledge one frame.
 */
export type PreviewScreencastAcknowledgmentToken = string & {
  readonly __brand: "PreviewScreencastAcknowledgmentToken";
};
/**
 * The daemon's id for one input it relayed to a page, which a menu, a file chooser or a
 * download that input raised names.
 */
export type PreviewInputMessageId = string & { readonly __brand: "PreviewInputMessageId" };
/**
 * The daemon's handle for one file a page saved for a device, which the device acknowledges
 * once it has written the file.
 */
export type PreviewSaveId = string & { readonly __brand: "PreviewSaveId" };
/**
 * What a file chooser lets the device pick.
 */
export type PreviewFileChooserMode = "selectSingle" | "selectMultiple" | "selectFolder";
/**
 * One element of a page's live picture, tagged on `kind`. A menu, a file chooser and a
 * download name the `messageId` of the device's input that raised them, so the device knows
 * which of its presses each answers.
 */
export type PreviewScreencastElement =
  | {
      kind: "frame";
      /**
       * The page.
       */
      pageId: PreviewPageId;
      /**
       * The JPEG.
       */
      imageData: Uint8Array;
      /**
       * What maps its pixels back to the page.
       */
      metadata: PreviewScreencastFrameMetadata;
      /**
       * The token that acknowledges it.
       */
      ackToken: PreviewScreencastAcknowledgmentToken;
    }
  | {
      kind: "menu";
      /**
       * The page.
       */
      pageId: PreviewPageId;
      /**
       * The input that raised it.
       */
      messageId: PreviewInputMessageId;
      /**
       * Where it opened, in frame pixels.
       */
      point: PreviewPoint;
      /**
       * The link under the press.
       */
      linkUrl?: string;
      /**
       * Whether the press landed in a field that takes text, neither read-only nor
       * disabled.
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
       * The selected text; absent where the page allows no copy, as in a password field.
       */
      selectionText?: string;
    }
  | {
      kind: "fileChooser";
      /**
       * The page.
       */
      pageId: PreviewPageId;
      /**
       * The input that opened it.
       */
      messageId: PreviewInputMessageId;
      /**
       * What it lets the device pick.
       */
      mode: PreviewFileChooserMode;
      /**
       * The input's own `accept`, or a picker's types where it excludes every other file,
       * which the device's picker honors.
       */
      accept?: string;
    }
  | {
      kind: "save";
      /**
       * The page.
       */
      pageId: PreviewPageId;
      /**
       * The press or key that started a download; absent for a picker's write.
       */
      messageId?: PreviewInputMessageId;
      /**
       * The save.
       */
      saveId: PreviewSaveId;
      /**
       * The file's name, which the device cleans as the daemon cleans a staged name.
       */
      fileName: string;
      /**
       * The file's path inside a folder the device picked.
       */
      folderPath?: string;
      /**
       * Its size in bytes.
       */
      size: number;
      /**
       * Whether it was held while the device was away; the device asks before saving it.
       */
      isHeld: boolean;
    }
  | {
      kind: "savePart";
      /**
       * The page.
       */
      pageId: PreviewPageId;
      /**
       * The save.
       */
      saveId: PreviewSaveId;
      /**
       * This part's bytes.
       */
      part: Uint8Array;
      /**
       * Whether the file ends with this part.
       */
      isLastPart: boolean;
    }
  | {
      kind: "downloadRefused";
      /**
       * The page.
       */
      pageId: PreviewPageId;
    }
  | {
      kind: "saveCanceled";
      /**
       * The page.
       */
      pageId: PreviewPageId;
      /**
       * The file's name.
       */
      fileName: string;
    };
/**
 * What a mouse input does.
 */
export type PreviewMouseAction = "press" | "move" | "release";
/**
 * The mouse button an input names.
 */
export type PreviewMouseButton = "none" | "left" | "middle" | "right";
/**
 * What a touch input does.
 */
export type PreviewTouchAction = "start" | "move" | "end" | "cancel";
/**
 * What a key input does.
 */
export type PreviewKeyAction = "down" | "up";
/**
 * One input from another device, tagged on `kind`. Points are frame pixels, which the daemon maps
 * to page points from the frame's metadata and the page's zoom; touches reach the page as touch
 * events and keys as key input.
 */
export type PreviewDeviceInput =
  | {
      kind: "mouse";
      /**
       * What it does.
       */
      type: PreviewMouseAction;
      /**
       * From the left edge.
       */
      x: number;
      /**
       * From the top edge.
       */
      y: number;
      /**
       * The button.
       */
      button: PreviewMouseButton;
      /**
       * How many presses in a row this one is.
       */
      clickCount: number;
      /**
       * The modifier keys held.
       */
      modifiers: number;
    }
  | {
      kind: "wheel";
      /**
       * From the left edge.
       */
      x: number;
      /**
       * From the top edge.
       */
      y: number;
      /**
       * The horizontal scroll.
       */
      deltaX: number;
      /**
       * The vertical scroll.
       */
      deltaY: number;
      /**
       * The modifier keys held.
       */
      modifiers: number;
    }
  | {
      kind: "touch";
      /**
       * What it does.
       */
      type: PreviewTouchAction;
      /**
       * The touch points still down.
       */
      points: PreviewTouchPoint[];
    }
  | {
      kind: "key";
      /**
       * What it does.
       */
      type: PreviewKeyAction;
      /**
       * The key's value, as `KeyboardEvent.key` names it.
       */
      key: string;
      /**
       * The physical key, as `KeyboardEvent.code` names it; empty where the key has none.
       */
      code: string;
      /**
       * The text the key types.
       */
      text?: string;
      /**
       * The modifier keys held.
       */
      modifiers: number;
    };
/**
 * One act from a page's right-click menu, tagged on `kind`: `Paste` with its text, `Select all`,
 * or `Cut`'s removal.
 */
export type PreviewMenuEdit =
  | {
      kind: "paste";
      /**
       * The text.
       */
      text: string;
    }
  | {
      kind: "selectAll";
    }
  | {
      kind: "cut";
    };

/**
 * The details a `preview.addressRefused` refusal carries. It never echoes the address.
 */
export interface PreviewAddressRefusedDetails {
  /**
   * Why.
   */
  reason: PreviewAddressRefusedReason;
}
/**
 * A page's own icon, as the image's bytes rather than its address: the app draws only images it
 * holds, and another device cannot reach an icon a loopback page serves.
 */
export interface PreviewFavicon {
  /**
   * The image's media type.
   */
  mediaType: string;
  /**
   * The image.
   */
  data: Uint8Array;
}
/**
 * One open page in a session's Preview pane.
 */
export interface PreviewPage {
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * Its address.
   */
  address: string;
  /**
   * Its host, shown in place of an empty `title`, so it is carried rather than re-parsed.
   */
  host: string;
  /**
   * The page's own title; may be empty.
   */
  title: string;
  /**
   * Its icon; `null` where it has none.
   */
  favicon: PreviewFavicon | null;
  /**
   * Where its load stands.
   */
  loadState: PreviewPageLoadState;
  /**
   * How far its history reaches back; going back is possible above zero.
   */
  backDepth: number;
  /**
   * How far its history reaches forward; going forward is possible above zero.
   */
  forwardDepth: number;
  /**
   * Its own zoom, applied on the machine that runs it.
   */
  zoomFactor: 0.5 | 0.6666666666666666 | 0.75 | 0.8 | 0.9 | 1 | 1.1 | 1.25 | 1.5 | 1.75 | 2;
  /**
   * The page's view was destroyed to free memory or by a restart; its address, order and zoom
   * are kept, and it reloads when shown.
   */
  released: boolean;
}
/**
 * The session whose pages a `preview.page.subscribe` call streams.
 */
export interface PreviewPageSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One frame of a session's page list: every page in the session's order, and the index of the
 * one the pane shows, `-1` where the session has no page open. The first frame is the list as it
 * stands; after a change the stream sends the newest list once the reader has room, never a queue
 * of the lists between.
 */
export interface PreviewPageListFrame {
  /**
   * The pages.
   */
  pages: PreviewPage[];
  /**
   * The page the pane shows.
   */
  activeIndex: number;
}
/**
 * Opens one page in a session. A retried open makes a second page.
 */
export interface PreviewPageOpenRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * What the page opens on.
   */
  target: PreviewPageTarget;
}
/**
 * The page opened, and the address it loads.
 */
export interface PreviewPageOpenResponse {
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The address it loads.
   */
  address: string;
  /**
   * The dev server's own port where the page loads on another one because that port was
   * taken on the side the page runs; `null` where the port did not move.
   */
  movedFrom: Port | null;
  /**
   * The page released to make room for this one, where one was. Its address is kept and it
   * reloads when shown, so this is a fact the pane may report, never a refusal.
   */
  releasedPageId?: PreviewPageId;
}
/**
 * Names one page of one session: close it, or make it the one the pane shows.
 */
export interface PreviewPageRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The page.
   */
  pageId: PreviewPageId;
}
/**
 * A page closed. Closing a page that is already gone answers the same.
 */
export interface PreviewPageCloseResponse {
  /**
   * Always `true`.
   */
  closed: true;
}
/**
 * The page the pane now shows. Activating the active page answers the same.
 */
export interface PreviewPageActivateResponse {
  /**
   * The page.
   */
  activePageId: PreviewPageId;
}
/**
 * Moves one page within its session's order; `toIndex` is a position in the list without that
 * page in it.
 */
export interface PreviewPageReorderRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * Where it goes.
   */
  toIndex: number;
}
/**
 * The session's page order after the move. The order is the session's, so every device draws the
 * same strip; moving a page to where it already is answers the order unchanged.
 */
export interface PreviewPageReorderResponse {
  /**
   * The pages in order.
   */
  pageIds: PreviewPageId[];
}
/**
 * Navigates one page.
 */
export interface PreviewPageNavigateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * Where it goes.
   */
  to: PreviewNavigationTarget;
}
/**
 * Where the page stands after the navigation: the address it loads, with `movedFrom` as on
 * [`PreviewPageOpenResponse`], and its history depths.
 */
export interface PreviewPageNavigateResponse {
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The address it loads.
   */
  address: string;
  /**
   * The dev server's own port where the page loads on another; `null` where it did not move.
   */
  movedFrom: Port | null;
  /**
   * How far its history reaches back.
   */
  backDepth: number;
  /**
   * How far its history reaches forward.
   */
  forwardDepth: number;
}
/**
 * Sets one page's zoom on the machine that runs it, so the live picture carries the result. A new
 * page starts at 1; each open page keeps its own factor.
 */
export interface PreviewPageZoomUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The factor.
   */
  zoomFactor: 0.5 | 0.6666666666666666 | 0.75 | 0.8 | 0.9 | 1 | 1.1 | 1.25 | 1.5 | 1.75 | 2;
}
/**
 * The factor the page now has.
 */
export interface PreviewPageZoomUpdateResponse {
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The factor.
   */
  zoomFactor: 0.5 | 0.6666666666666666 | 0.75 | 0.8 | 0.9 | 1 | 1.1 | 1.25 | 1.5 | 1.75 | 2;
}
/**
 * The session whose project's dev servers a `preview.devServer.subscribe` call streams.
 */
export interface PreviewDevServerSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One dev server the daemon found listening in the session's project. `name` and `framework` are
 * `null` where the daemon could not tell; `startedHere` means this session started it.
 */
export interface PreviewDevServer {
  /**
   * Its port.
   */
  port: Port;
  /**
   * The name it gave.
   */
  name: string | null;
  /**
   * Its framework.
   */
  framework: string | null;
  /**
   * Whether this session started it, by its agent or in its own shell.
   */
  startedHere: boolean;
}
/**
 * A point; the member holding it names its unit.
 */
export interface PreviewPoint {
  /**
   * From the left edge.
   */
  x: number;
  /**
   * From the top edge.
   */
  y: number;
}
/**
 * A rectangle on the page, in viewport CSS pixels.
 */
export interface PreviewRect {
  /**
   * Its left edge.
   */
  x: number;
  /**
   * Its top edge.
   */
  y: number;
  /**
   * Its width.
   */
  width: number;
  /**
   * Its height.
   */
  height: number;
}
/**
 * The element a mark landed on, as the page snapshot taken when the mark was made names it: the
 * snapshot's element reference and that element's box. A reference holds only for the snapshot
 * that minted it, so its generation rides with it.
 */
export interface PreviewMarkElement {
  /**
   * The snapshot's reference to the element.
   */
  elementRef: PreviewElementRef;
  /**
   * The element's box.
   */
  box: PreviewRect;
  /**
   * The snapshot that minted the reference.
   */
  snapshotGeneration: number;
}
/**
 * Sends the marks on one page to the session's provider: the daemon stages one attachment in
 * the session's composer, the frozen picture with the marks drawn on it, the marks that exist
 * now, the page's address and its width in CSS pixels, and it goes with the ordinary Send. An
 * attachment whose last mark was removed is not sent, so `marks` is never empty.
 */
export interface PreviewMarkSendRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The frozen picture the marks were drawn on: the page capture on the machine, the
   * screencast frame on another device. It is never captured again at send, which would not
   * match the marks.
   */
  image: Uint8Array;
  /**
   * The page's address.
   */
  address: string;
  /**
   * The page's width in CSS pixels when it was frozen.
   */
  width: number;
  /**
   * The marks.
   *
   * @minItems 1
   */
  marks: [PreviewMark, ...PreviewMark[]];
}
/**
 * The attachment staged in the session's composer, which reads `<N> marks on <path>`.
 */
export interface PreviewMarkSendResponse {
  /**
   * The staged attachment.
   */
  staged: SessionAttachmentSummary;
}
/**
 * The page whose live picture another device watches while it has the pane open.
 */
export interface PreviewScreencastSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The page.
   */
  pageId: PreviewPageId;
}
/**
 * What maps a frame's pixels back to page coordinates, so a mark drawn on the picture lands on the
 * same element as one drawn on the page.
 */
export interface PreviewScreencastFrameMetadata {
  /**
   * The top offset in CSS pixels.
   */
  offsetTop: number;
  /**
   * The page's scale factor.
   */
  pageScaleFactor: number;
  /**
   * The device's width in CSS pixels.
   */
  deviceWidth: number;
  /**
   * The device's height in CSS pixels.
   */
  deviceHeight: number;
  /**
   * The horizontal scroll offset in CSS pixels.
   */
  scrollOffsetX: number;
  /**
   * The vertical scroll offset in CSS pixels.
   */
  scrollOffsetY: number;
}
/**
 * Acknowledges one frame by its token, which lets the stream send the newest image.
 */
export interface PreviewScreencastAcknowledgeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The frame's token.
   */
  ackToken: PreviewScreencastAcknowledgmentToken;
}
/**
 * One touch point, in frame pixels.
 */
export interface PreviewTouchPoint {
  /**
   * From the left edge.
   */
  x: number;
  /**
   * From the top edge.
   */
  y: number;
  /**
   * The touch's own id, the same while it lasts.
   */
  id: number;
}
/**
 * Sends one input from the device to a page.
 */
export interface PreviewScreencastInputSendRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The input.
   */
  input: PreviewDeviceInput;
}
/**
 * The id the daemon gave the input, which a menu, a file chooser or a download it raised names.
 */
export interface PreviewScreencastInputSendResponse {
  /**
   * The input's id.
   */
  messageId: PreviewInputMessageId;
}
/**
 * A device's act from the menu its input raised, naming that menu by its input's id. Refused with
 * `preview.editRefused`, changing nothing, where the page took other input after the menu opened.
 */
export interface PreviewScreencastEditRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The menu's input.
   */
  messageId: PreviewInputMessageId;
  /**
   * The act.
   */
  edit: PreviewMenuEdit;
}
/**
 * The menu's act reached the page.
 */
export interface PreviewMenuEditResponse {
  /**
   * Always `true`.
   */
  applied: true;
}
/**
 * One file the device picked, already staged on the machine through the attachment ingest.
 */
export interface PreviewChosenFile {
  /**
   * The staged artifact, from its ingest's completion.
   */
  artifactId: ArtifactId;
  /**
   * For a folder, the file's path inside it, as `sub/b.txt`.
   */
  path?: string;
}
/**
 * The device's answer to a file chooser or a picker its input opened: the files it picked, which
 * the daemon sets on the page's input or drops on the page for a picker, or none for a cancel.
 * More than one only for `selectMultiple` or `selectFolder`. A path that is empty, absolute, holds
 * an empty, `.` or `..` segment, or is missing from a folder's answer is refused with
 * `preview.filePathRefused`, setting and dropping nothing.
 */
export interface PreviewScreencastFileChooseRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The chooser's input.
   */
  messageId: PreviewInputMessageId;
  /**
   * The files; empty for a cancel.
   */
  files: PreviewChosenFile[];
  /**
   * The picked folder's own name, for `selectFolder`.
   */
  folderName?: string;
}
/**
 * How many files the page received: set on the input, or dropped for a picker.
 */
export interface PreviewScreencastFileChooseResponse {
  /**
   * The count.
   */
  set: number;
}
/**
 * The device has written a save's last part where its host keeps it, or thrown a held save away,
 * so the daemon deletes its copy and starts that device's next save.
 */
export interface PreviewScreencastSaveAcknowledgeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The page.
   */
  pageId: PreviewPageId;
  /**
   * The save.
   */
  saveId: PreviewSaveId;
}

/** The methods of {@link PREVIEW_METHOD_DESCRIPTORS}, each with its kind. */
export interface PreviewMethodDescriptors {
  readonly "preview.page.subscribe": {
    readonly method: "preview.page.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "preview.page.open": {
    readonly method: "preview.page.open";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.page.close": {
    readonly method: "preview.page.close";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.page.activate": {
    readonly method: "preview.page.activate";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.page.reorder": {
    readonly method: "preview.page.reorder";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.page.navigate": {
    readonly method: "preview.page.navigate";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.page.zoom.update": {
    readonly method: "preview.page.zoom.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.devServer.subscribe": {
    readonly method: "preview.devServer.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "preview.mark.send": {
    readonly method: "preview.mark.send";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.screencast.subscribe": {
    readonly method: "preview.screencast.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "preview.screencast.acknowledge": {
    readonly method: "preview.screencast.acknowledge";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.screencast.input.send": {
    readonly method: "preview.screencast.input.send";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.screencast.edit": {
    readonly method: "preview.screencast.edit";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.screencast.file.choose": {
    readonly method: "preview.screencast.file.choose";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "preview.screencast.save.acknowledge": {
    readonly method: "preview.screencast.save.acknowledge";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link PREVIEW_METHOD_DESCRIPTORS}. */
export interface PreviewMethodTypes {
  readonly "preview.page.subscribe": {
    readonly params: PreviewPageSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: PreviewPageListFrame;
  };
  readonly "preview.page.open": {
    readonly params: PreviewPageOpenRequest;
    readonly result: PreviewPageOpenResponse;
  };
  readonly "preview.page.close": {
    readonly params: PreviewPageRequest;
    readonly result: PreviewPageCloseResponse;
  };
  readonly "preview.page.activate": {
    readonly params: PreviewPageRequest;
    readonly result: PreviewPageActivateResponse;
  };
  readonly "preview.page.reorder": {
    readonly params: PreviewPageReorderRequest;
    readonly result: PreviewPageReorderResponse;
  };
  readonly "preview.page.navigate": {
    readonly params: PreviewPageNavigateRequest;
    readonly result: PreviewPageNavigateResponse;
  };
  readonly "preview.page.zoom.update": {
    readonly params: PreviewPageZoomUpdateRequest;
    readonly result: PreviewPageZoomUpdateResponse;
  };
  readonly "preview.devServer.subscribe": {
    readonly params: PreviewDevServerSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: PreviewDevServerListFrame;
  };
  readonly "preview.mark.send": {
    readonly params: PreviewMarkSendRequest;
    readonly result: PreviewMarkSendResponse;
  };
  readonly "preview.screencast.subscribe": {
    readonly params: PreviewScreencastSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: PreviewScreencastElement;
  };
  readonly "preview.screencast.acknowledge": {
    readonly params: PreviewScreencastAcknowledgeRequest;
    readonly result: EmptyPayload;
  };
  readonly "preview.screencast.input.send": {
    readonly params: PreviewScreencastInputSendRequest;
    readonly result: PreviewScreencastInputSendResponse;
  };
  readonly "preview.screencast.edit": {
    readonly params: PreviewScreencastEditRequest;
    readonly result: PreviewMenuEditResponse;
  };
  readonly "preview.screencast.file.choose": {
    readonly params: PreviewScreencastFileChooseRequest;
    readonly result: PreviewScreencastFileChooseResponse;
  };
  readonly "preview.screencast.save.acknowledge": {
    readonly params: PreviewScreencastSaveAcknowledgeRequest;
    readonly result: EmptyPayload;
  };
}
/** The `preview.*` page, dev-server, marks and live-picture methods the daemon answers. */
export const PREVIEW_METHOD_DESCRIPTORS: PreviewMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "preview.page.subscribe": /* @__PURE__ */ Object.freeze({
    method: "preview.page.subscribe",
    procedureType: "subscription",
    mutating: false,
  }),
  "preview.page.open": /* @__PURE__ */ Object.freeze({
    method: "preview.page.open",
    procedureType: "mutation",
    mutating: true,
  }),
  "preview.page.close": /* @__PURE__ */ Object.freeze({
    method: "preview.page.close",
    procedureType: "mutation",
    mutating: true,
  }),
  "preview.page.activate": /* @__PURE__ */ Object.freeze({
    method: "preview.page.activate",
    procedureType: "mutation",
    mutating: true,
  }),
  "preview.page.reorder": /* @__PURE__ */ Object.freeze({
    method: "preview.page.reorder",
    procedureType: "mutation",
    mutating: true,
  }),
  "preview.page.navigate": /* @__PURE__ */ Object.freeze({
    method: "preview.page.navigate",
    procedureType: "mutation",
    mutating: true,
  }),
  "preview.page.zoom.update": /* @__PURE__ */ Object.freeze({
    method: "preview.page.zoom.update",
    procedureType: "mutation",
    mutating: true,
  }),
  "preview.devServer.subscribe": /* @__PURE__ */ Object.freeze({
    method: "preview.devServer.subscribe",
    procedureType: "subscription",
    mutating: false,
  }),
  "preview.mark.send": /* @__PURE__ */ Object.freeze({
    method: "preview.mark.send",
    procedureType: "mutation",
    mutating: true,
  }),
  "preview.screencast.subscribe": /* @__PURE__ */ Object.freeze({
    method: "preview.screencast.subscribe",
    procedureType: "subscription",
    mutating: false,
  }),
  "preview.screencast.acknowledge": /* @__PURE__ */ Object.freeze({
    method: "preview.screencast.acknowledge",
    procedureType: "mutation",
    mutating: true,
  }),
  "preview.screencast.input.send": /* @__PURE__ */ Object.freeze({
    method: "preview.screencast.input.send",
    procedureType: "mutation",
    mutating: true,
  }),
  "preview.screencast.edit": /* @__PURE__ */ Object.freeze({
    method: "preview.screencast.edit",
    procedureType: "mutation",
    mutating: true,
  }),
  "preview.screencast.file.choose": /* @__PURE__ */ Object.freeze({
    method: "preview.screencast.file.choose",
    procedureType: "mutation",
    mutating: true,
  }),
  "preview.screencast.save.acknowledge": /* @__PURE__ */ Object.freeze({
    method: "preview.screencast.save.acknowledge",
    procedureType: "mutation",
    mutating: true,
  }),
});
